import {
  addLead,
  appendMessage,
  getLead,
  findLeadByAnyDigits,
  upsertLeadPatch,
  listActiveLeads,
  logClosedDeal,
  getScript,
  getPricingTiers,
  getUserEmail,
} from "./state.js";
import { getNextMove } from "./negotiate.js";
import { sendOpeningTemplate } from "./sessions.js";

const HOURS_MSG2 = Number(process.env.HOURS_BEFORE_MESSAGE_2 || 24);
const HOURS_ACCEPT = Number(process.env.HOURS_BEFORE_ACCEPT_LAST_OFFER || 24);
const SEND_WINDOW_START_HOUR_CT = Number(process.env.SEND_WINDOW_START_HOUR_CT ?? 22);
const SEND_WINDOW_END_HOUR_CT = Number(process.env.SEND_WINDOW_END_HOUR_CT ?? 7);
const DEBOUNCE_MS = Number(process.env.REPLY_DEBOUNCE_SECONDS || 30) * 1000;

const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity);

const pendingReplies = new Map();

function withinSendWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    weekday: "short",
    timeZone: "America/Chicago",
  }).formatToParts(new Date());
  const ctHour = Number(parts.find((p) => p.type === "hour").value) % 24;
  const ctWeekday = parts.find((p) => p.type === "weekday").value;

  // if (ctWeekday === "Fri" || ctWeekday === "Sat") return false; // DESACTIVADO TEMPORAL PARA PRUEBAS — reactivar cuando terminen
  if (SEND_WINDOW_START_HOUR_CT === SEND_WINDOW_END_HOUR_CT) return true;
  if (SEND_WINDOW_START_HOUR_CT < SEND_WINDOW_END_HOUR_CT) {
    return ctHour >= SEND_WINDOW_START_HOUR_CT && ctHour < SEND_WINDOW_END_HOUR_CT;
  }
  return ctHour >= SEND_WINDOW_START_HOUR_CT || ctHour < SEND_WINDOW_END_HOUR_CT;
}

/** Arma las 8 variables del template de apertura, en el mismo orden que {{1}} a {{8}}
 * en el template aprobado por Meta, jalando los precios de 1/5/10 videos de la
 * tabla de precios del usuario. */
async function buildOpeningTemplateParams(userId) {
  const script = await getScript(userId);
  const tiers = await getPricingTiers(userId);
  const tier1 = tiers.find((t) => t.videos === 1);
  const tier5 = tiers.find((t) => t.videos === 5);
  const tier10 = tiers.find((t) => t.videos === 10);

  return [
    script.gmvTotal || "0",
    script.market || "Spanish-speaking",
    script.shortName || "",
    String(tier1?.anchor ?? ""),
    String(tier5?.anchor ?? ""),
    String(tier10?.anchor ?? ""),
    script.gmv30d || "0",
    script.tiktokHandle || "",
  ];
}

export async function startProcessForNumber(sock, userId, phoneRaw, { skipMessage1 = false } = {}) {
  console.log(`🆕 startProcessForNumber: agregando ${phoneRaw} (user ${userId}, skipMessage1: ${!!skipMessage1})`);
  const { lead, duplicate } = await addLead(userId, phoneRaw);
  if (duplicate) {
    console.log(`⚠️  ${phoneRaw} ya existía como lead (status: ${lead.status}) — no se manda nada nuevo.`);
    return { duplicate: true, lead };
  }

  if (skipMessage1) {
    console.log(`✍️  skipMessage1 activado para ${phoneRaw} — se deja en "esperando", sin mandar template.`);
    const updated = await upsertLeadPatch(userId, lead.jid, { status: "esperando" });
    return { duplicate: false, lead: updated, waitingForWindow: false, manual: true };
  }

  if (!withinSendWindow()) {
    console.log(`🌙 Fuera de la ventana de envío ahorita mismo — ${phoneRaw} queda en "nuevo", se manda en el próximo sweep.`);
    return { duplicate: false, lead, waitingForWindow: true };
  }

  const params = await buildOpeningTemplateParams(userId);
  console.log(`📋 Params del template para ${phoneRaw}: ${JSON.stringify(params)}`);
  await sendOpeningTemplate(userId, lead.jid, params);
  console.log(`✅ Template mandado sin error para ${phoneRaw} (jid: ${lead.jid})`);
  await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
  const updated = await upsertLeadPatch(userId, lead.jid, {
    status: "escrito_enviado",
    last_outbound_at: new Date().toISOString(),
  });
  return { duplicate: false, lead: updated, waitingForWindow: false };
}

async function resolveAndSend(sock, userId, jid) {
  const lead = await getLead(userId, jid);
  if (!lead || lead.status === "cerrado" || lead.paused) {
    console.log(`⚠️  resolveAndSend: no se contesta a ${jid} (status: ${lead?.status}, paused: ${lead?.paused})`);
    return;
  }

  console.log(`🤖 Llamando a la IA para generar la respuesta a ${jid}...`);
  const tiers = await getPricingTiers(userId);
  const { replyText, closed, dormant, closedPrice, closedVideos } = await getNextMove(lead.conversation, tiers);
  console.log(`🤖 IA respondió: "${replyText}" (closed: ${closed}, dormant: ${dormant})`);

  await sock.sendMessage(jid, { text: replyText });
  console.log(`📤 Mensaje enviado a ${jid}`);
  await appendMessage(userId, jid, "assistant", replyText);

  if (closed) {
    await upsertLeadPatch(userId, jid, { status: "cerrado", last_outbound_at: new Date().toISOString() });
    await logClosedDeal(userId, { jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
    await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
  } else if (dormant) {
    await upsertLeadPatch(userId, jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
  } else {
    await upsertLeadPatch(userId, jid, { status: "negociando", last_outbound_at: new Date().toISOString() });
  }
}

/** Called on every inbound WhatsApp message. If the exact jid doesn't match any lead
 * (common with Mexico numbers, where WhatsApp sometimes adds/drops the extra "1" after
 * the 52 country code), falls back to matching by the last 8 digits of the phone. */
export async function handleInboundMessage(sock, userId, jid, text) {
  console.log(`🔍 handleInboundMessage: buscando lead para ${jid} (user ${userId})`);
  let lead = await getLead(userId, jid);
  let resolvedJid = jid;

  if (!lead) {
    const matched = await findLeadByAnyDigits(userId, [jid]);
    if (matched) {
      console.log(`🔀 Sin match exacto para ${jid} — encontrado por número (últimos dígitos) → usando jid guardado: ${matched.jid}`);
      lead = matched;
      resolvedJid = matched.jid;
    }
  }

  if (!lead || lead.status === "cerrado") {
    console.log(`⚠️  No hay lead activo para ${jid} (encontrado: ${!!lead}, status: ${lead?.status}) — ignorando`);
    return;
  }

  await appendMessage(userId, resolvedJid, "user", text);
  await upsertLeadPatch(userId, resolvedJid, { last_inbound_at: new Date().toISOString() });

  if (lead.paused) {
    console.log(`⏸️  Lead ${resolvedJid} está pausado — no se contesta`);
    return;
  }

  const key = `${userId}:${resolvedJid}`;
  if (pendingReplies.has(key)) {
    console.log(`🔁 Ya había un timer para ${resolvedJid}, se reinicia`);
    clearTimeout(pendingReplies.get(key));
  }
  console.log(`⏳ Timer de ${DEBOUNCE_MS / 1000}s iniciado para ${resolvedJid}`);
  const timer = setTimeout(() => {
    pendingReplies.delete(key);
    console.log(`⏰ Timer cumplido para ${resolvedJid} — generando respuesta ahora`);
    resolveAndSend(sock, userId, resolvedJid).catch((err) => console.error(`❌ Error respondiendo a ${resolvedJid} (user ${userId}):`, err));
  }, DEBOUNCE_MS);
  pendingReplies.set(key, timer);
}

async function reportClosedDealToTracker(userId, deal) {
  const url = process.env.CLOSED_DEAL_WEBHOOK_URL;
  const secret = process.env.CLOSED_DEAL_WEBHOOK_SECRET;
  if (!url) return;
  try {
    const email = await getUserEmail(userId);
    if (!email) {
      console.error(`No se encontró el email del usuario ${userId} — no se pudo reportar el deal cerrado.`);
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret || "" },
      body: JSON.stringify({ ...deal, email }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`El Retainer Tracker respondió ${res.status} al reportar el deal: ${text}`);
    } else {
      console.log(`✅ Deal cerrado reportado al Retainer Tracker para ${email}`);
    }
  } catch (err) {
    console.error("No se pudo mandar el deal cerrado al Retainer Tracker:", err.message);
  }
}

export async function sweepTimers(sock, userId) {
  if (!withinSendWindow()) return;

  const active = await listActiveLeads(userId);
  const script = await getScript(userId);

  for (const lead of active) {
    if (lead.status === "nuevo") {
      const params = await buildOpeningTemplateParams(userId);
      await sendOpeningTemplate(userId, lead.jid, params);
      await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
      await upsertLeadPatch(userId, lead.jid, { status: "escrito_enviado", last_outbound_at: new Date().toISOString() });
      continue;
    }

    if (lead.last_inbound_at && new Date(lead.last_inbound_at) > new Date(lead.last_outbound_at)) continue;

    if (lead.status === "escrito_enviado" && hoursSince(lead.last_outbound_at) >= HOURS_MSG2) {
      await sock.sendMessage(lead.jid, { text: script.message2 });
      await appendMessage(userId, lead.jid, "assistant", script.message2);
      await upsertLeadPatch(userId, lead.jid, { status: "esperando", last_outbound_at: new Date().toISOString() });
      continue;
    }

    if ((lead.status === "esperando" || lead.status === "followup") && hoursSince(lead.last_outbound_at) >= 24) {
      const followupText = "Hey, any updates?";
      await sock.sendMessage(lead.jid, { text: followupText });
      await appendMessage(userId, lead.jid, "assistant", followupText);
      await upsertLeadPatch(userId, lead.jid, { status: "followup", last_outbound_at: new Date().toISOString() });
      continue;
    }

    if (lead.status === "negociando" && hoursSince(lead.last_outbound_at) >= HOURS_ACCEPT) {
      const tiers = await getPricingTiers(userId);
      const nudged = [
        ...lead.conversation,
        {
          role: "user",
          content:
            "[SYSTEM NOTE: 24 hours have passed with no reply. This is a special case — skip the normal two-step confirm process. Accept the brand's last stated offer now, even if it's below your floor, and close the deal immediately: send a short close-out line AND include the <<CLOSE:{...}>> tag in this same message, since no further reply is expected.]",
        },
      ];
      const { replyText, closed, dormant, closedPrice, closedVideos } = await getNextMove(nudged, tiers);
      await sock.sendMessage(lead.jid, { text: replyText });
      await appendMessage(userId, lead.jid, "assistant", replyText);
      if (closed) {
        await upsertLeadPatch(userId, lead.jid, { status: "cerrado", last_outbound_at: new Date().toISOString() });
        await logClosedDeal(userId, { jid: lead.jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
        await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
      } else if (dormant) {
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
      } else {
        await upsertLeadPatch(userId, lead.jid, { last_outbound_at: new Date().toISOString() });
      }
    }
  }
}
