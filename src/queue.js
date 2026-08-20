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
import { sendOpeningTemplate, sendFollowupTemplate } from "./sessions.js";

// El cierre automático se dispara a las 18h (no 24h) a propósito: la marca SÍ nos
// escribió durante la negociación, así que la ventana de 24h de WhatsApp está
// abierta — pero solo hasta las 24h exactas. A las 18h todavía estamos dentro y el
// mensaje sale como texto normal, sin necesidad de template. Si se dejara en 24h,
// caería justo en el límite (o fuera) y fallaría con el error [131047].
const HOURS_ACCEPT = Number(process.env.HOURS_BEFORE_ACCEPT_LAST_OFFER || 18);
const SEND_WINDOW_START_HOUR_CT = Number(process.env.SEND_WINDOW_START_HOUR_CT ?? 22);
const SEND_WINDOW_END_HOUR_CT = Number(process.env.SEND_WINDOW_END_HOUR_CT ?? 7);
const DEBOUNCE_MS = Number(process.env.REPLY_DEBOUNCE_SECONDS || 300) * 1000;

// ═══ MODO PRUEBAS — SOLO para la cuenta admin de Irving ═══
// Se identifica por user_id EXACTO (único e irrepetible en Supabase), nunca por
// correo ni por nada que se pueda confundir — así es imposible que otra cuenta
// herede estas reglas por accidente. Para esta cuenta y SOLO esta:
//   - contesta a los 45 segundos (en vez de 5 minutos)
//   - manda a cualquier hora y cualquier día (sin ventana 10pm-7am ni bloqueo Vie/Sáb)
// Todas las demás cuentas siguen el reglamento normal de producción.
const TEST_MODE_USER_IDS = (process.env.TEST_MODE_USER_IDS || "d5c3e03b-5ac0-45d9-9852-b3cc9abe95b3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_DEBOUNCE_MS = Number(process.env.TEST_REPLY_DEBOUNCE_SECONDS || 45) * 1000;

const isTestUser = (userId) => TEST_MODE_USER_IDS.includes(userId);
const debounceMsFor = (userId) => (isTestUser(userId) ? TEST_DEBOUNCE_MS : DEBOUNCE_MS);

const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity);

const pendingReplies = new Map();

function withinSendWindow(userId) {
  // La cuenta de pruebas de Irving no tiene horario ni días bloqueados.
  if (userId && isTestUser(userId)) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    weekday: "short",
    timeZone: "America/Chicago",
  }).formatToParts(new Date());
  const ctHour = Number(parts.find((p) => p.type === "hour").value) % 24;
  const ctWeekday = parts.find((p) => p.type === "weekday").value;

  // Solo se MANDAN mensajes de domingo a jueves (hora de Texas). Viernes y sábado
  // no se inicia nada. Ojo: esto NO bloquea las respuestas — si una marca contesta
  // un viernes o sábado, el bot le sigue contestando normal (resolveAndSend no pasa
  // por aquí). Esto solo frena los envíos que arranca el bot por su cuenta.
  if (ctWeekday === "Fri" || ctWeekday === "Sat") return false;
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
    // Se guarda la fecha de AHORA como si fuera el envío, porque Irving acaba de
    // mandar el mensaje a mano. Sin esto, el sistema creería que pasó una eternidad
    // desde el último mensaje y dispararía los 4 follow-ups uno tras otro.
    const updated = await upsertLeadPatch(userId, lead.jid, {
      status: "esperando",
      last_outbound_at: new Date().toISOString(),
    });
    return { duplicate: false, lead: updated, waitingForWindow: false, manual: true };
  }

  if (!withinSendWindow(userId)) {
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
  const { replyText, noAction, closed, dormant, closedPrice, closedVideos, negotiation } = await getNextMove(
    lead.conversation,
    tiers,
    lead.negotiation || null
  );
  console.log(`🤖 Respuesta final: "${replyText}" (closed: ${closed}, dormant: ${dormant})`);

  if (noAction || !replyText) {
    console.warn(`⏹️  ${jid}: no hay nada que contestar — no se manda ni se cierra nada.`);
    await upsertLeadPatch(userId, jid, { negotiation });
    return;
  }

  // Se manda PRIMERO. Si falla, no se marca nada como cerrado — así nunca queda
  // un trato "cerrado" en el sistema que la marca nunca recibió.
  await sock.sendMessage(jid, { text: replyText });
  console.log(`📤 Mensaje enviado a ${jid}`);
  await appendMessage(userId, jid, "assistant", replyText);

  if (closed) {
    await upsertLeadPatch(userId, jid, { status: "cerrado", negotiation, last_outbound_at: new Date().toISOString() });
    await logClosedDeal(userId, { jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
    await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
  } else if (dormant) {
    await upsertLeadPatch(userId, jid, { status: "dormant", negotiation, last_outbound_at: new Date().toISOString() });
  } else {
    await upsertLeadPatch(userId, jid, { status: "negociando", negotiation, last_outbound_at: new Date().toISOString() });
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
  const debounceMs = debounceMsFor(userId);
  console.log(`⏳ Timer de ${debounceMs / 1000}s iniciado para ${resolvedJid}${isTestUser(userId) ? " (cuenta de pruebas)" : ""}`);
  const timer = setTimeout(() => {
    pendingReplies.delete(key);
    console.log(`⏰ Timer cumplido para ${resolvedJid} — generando respuesta ahora`);
    resolveAndSend(sock, userId, resolvedJid).catch((err) => console.error(`❌ Error respondiendo a ${resolvedJid} (user ${userId}):`, err));
  }, debounceMs);
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
  if (!withinSendWindow(userId)) return;

  const active = await listActiveLeads(userId);

  for (const lead of active) {
    if (lead.status === "nuevo") {
      const params = await buildOpeningTemplateParams(userId);
      await sendOpeningTemplate(userId, lead.jid, params);
      await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
      await upsertLeadPatch(userId, lead.jid, { status: "escrito_enviado", last_outbound_at: new Date().toISOString() });
      continue;
    }

    if (lead.last_inbound_at && new Date(lead.last_inbound_at) > new Date(lead.last_outbound_at)) continue;

    // Ya no se manda el "message2" — después del mensaje 1, a las 24h arrancan
    // directo los follow-ups de "Hey, any updates?" (máximo 4).
    if (
      (lead.status === "escrito_enviado" || lead.status === "esperando" || lead.status === "followup") &&
      hoursSince(lead.last_outbound_at) >= 24
    ) {
      // Contactos viejos que quedaron sin fecha guardada: se les pone la de ahora y
      // se dejan para el próximo día. Sin esto, "sin fecha" cuenta como infinito y
      // les dispararía los 4 follow-ups seguidos en un par de horas.
      if (!lead.last_outbound_at) {
        console.log(`🕒 ${lead.jid} no tenía fecha de último envío — se le pone la de ahora y su follow-up arranca mañana.`);
        await upsertLeadPatch(userId, lead.jid, { last_outbound_at: new Date().toISOString() });
        continue;
      }

      const sent = Number(lead.followup_count || 0);

      // Tope de 4 follow-ups (4 días). Después se deja en paz: pasa a "dormant",
      // desaparece de la cola de contactos (listActiveLeads ya los excluye) y
      // entra a la regla de reintento a los 30 días.
      if (sent >= 4) {
        console.log(`😴 ${lead.jid} ya recibió 4 follow-ups sin contestar — se marca dormant y sale de la cola.`);
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
        continue;
      }

      const followupText = "Hey, any updates?";
      await sendFollowupTemplate(userId, lead.jid);
      await appendMessage(userId, lead.jid, "assistant", followupText);
      await upsertLeadPatch(userId, lead.jid, {
        status: "followup",
        followup_count: sent + 1,
        last_outbound_at: new Date().toISOString(),
      });
      console.log(`🔔 Follow-up ${sent + 1}/4 mandado a ${lead.jid}`);
      continue;
    }

    // Pasaron 24h sin respuesta en una negociación activa: se acepta su última
    // oferta y se cierra. forceAccept lo maneja directo el decisor de negotiate.js.
    // "Esperando al equipo": ellos dijeron "déjame checar / te aviso". Cada 2 horas
    // se les pregunta "Hey, any updates?" (texto libre, dentro de su ventana de 24h),
    // máximo 4 veces. Si su ventana ya está por cerrar, se deja de intentar.
    if (lead.status === "negociando" && lead.negotiation?.waiting === true) {
      const nudges = Number(lead.negotiation.waitingNudges || 0);
      const hoursSinceTheirs = hoursSince(lead.last_inbound_at);
      if (
        nudges < 4 &&
        hoursSince(lead.last_outbound_at) >= 2 &&
        hoursSinceTheirs < 23
      ) {
        const nudgeText = "Hey, any updates?";
        try {
          await sock.sendMessage(lead.jid, { text: nudgeText });
          await appendMessage(userId, lead.jid, "assistant", nudgeText);
          await upsertLeadPatch(userId, lead.jid, {
            negotiation: { ...lead.negotiation, waitingNudges: nudges + 1 },
            last_outbound_at: new Date().toISOString(),
          });
          console.log(`⏲️  Nudge ${nudges + 1}/4 ("any updates?") a ${lead.jid} — esperando a su equipo.`);
        } catch (err) {
          console.error(`❌ No se pudo mandar el nudge a ${lead.jid}: ${err.message}`);
        }
      }
      continue; // mientras esperan a su equipo, NO aplica el cierre automático de 18h
    }

    if (lead.status === "negociando" && hoursSince(lead.last_outbound_at) >= HOURS_ACCEPT) {
      // La ventana de 24h de WhatsApp se cuenta desde el ÚLTIMO mensaje que ELLOS
      // mandaron. Si ya se pasó, el texto libre va a fallar sí o sí ([131047]), así
      // que ni se intenta — se deja el lead para revisarlo a mano.
      const hoursSinceTheirReply = hoursSince(lead.last_inbound_at);
      if (hoursSinceTheirReply >= 23.5) {
        console.warn(
          `⏰ ${lead.jid}: la ventana de 24h ya cerró (${Math.round(hoursSinceTheirReply)}h desde su último mensaje) — no se intenta el cierre automático.`
        );
        continue;
      }

      const tiers = await getPricingTiers(userId);
      const { replyText, noAction, closed, closedPrice, closedVideos, negotiation } = await getNextMove(
        lead.conversation,
        tiers,
        lead.negotiation || null,
        { forceAccept: true }
      );

      // No había ninguna oferta real de la marca guardada — no se inventa nada.
      // Se deja el lead tal cual para revisarlo a mano.
      if (noAction || !replyText) {
        console.warn(`⏹️  ${lead.jid}: no se cerró nada automáticamente (no hay oferta real de la marca). Revísalo a mano.`);
        await upsertLeadPatch(userId, lead.jid, { negotiation });
        continue;
      }

      // El mensaje se manda PRIMERO. Solo si de verdad salió se marca como cerrado —
      // así nunca queda un trato "cerrado" en el sistema que la marca nunca recibió.
      try {
        await sock.sendMessage(lead.jid, { text: replyText });
      } catch (err) {
        console.error(`❌ ${lead.jid}: no se pudo mandar el cierre automático (${err.message}). NO se marca como cerrado.`);
        await upsertLeadPatch(userId, lead.jid, { negotiation, last_error: err.message });
        continue;
      }

      await appendMessage(userId, lead.jid, "assistant", replyText);
      if (closed) {
        await upsertLeadPatch(userId, lead.jid, { status: "cerrado", negotiation, last_outbound_at: new Date().toISOString() });
        await logClosedDeal(userId, { jid: lead.jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
        await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
        console.log(`🤝 Cierre automático a las 24h: ${lead.jid} — $${closedPrice} por ${closedVideos} videos`);
      } else {
        await upsertLeadPatch(userId, lead.jid, { negotiation, last_outbound_at: new Date().toISOString() });
      }
    }
  }
}
