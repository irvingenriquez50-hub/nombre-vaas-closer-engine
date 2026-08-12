import {
  addLead,
  appendMessage,
  getLead,
  upsertLeadPatch,
  listActiveLeads,
  logClosedDeal,
  getScript,
  getPricingTiers,
} from "./state.js";
import { getNextMove } from "./negotiate.js";

const HOURS_MSG2 = Number(process.env.HOURS_BEFORE_MESSAGE_2 || 24);
const HOURS_ACCEPT = Number(process.env.HOURS_BEFORE_ACCEPT_LAST_OFFER || 24);
const SEND_WINDOW_START_HOUR_CT = Number(process.env.SEND_WINDOW_START_HOUR_CT ?? 22);
const SEND_WINDOW_END_HOUR_CT = Number(process.env.SEND_WINDOW_END_HOUR_CT ?? 7);
const DEBOUNCE_MS = Number(process.env.REPLY_DEBOUNCE_MINUTES || 12) * 60 * 1000;

const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity);

// In-memory per-lead debounce timers, keyed by `${userId}:${jid}` — holds inbound
// messages that arrive close together so the bot answers once with full context
// instead of replying to each message separately mid-thought.
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

  if (ctWeekday === "Fri" || ctWeekday === "Sat") return false;
  if (SEND_WINDOW_START_HOUR_CT === SEND_WINDOW_END_HOUR_CT) return true;
  if (SEND_WINDOW_START_HOUR_CT < SEND_WINDOW_END_HOUR_CT) {
    return ctHour >= SEND_WINDOW_START_HOUR_CT && ctHour < SEND_WINDOW_END_HOUR_CT;
  }
  return ctHour >= SEND_WINDOW_START_HOUR_CT || ctHour < SEND_WINDOW_END_HOUR_CT;
}

export async function startProcessForNumber(sock, userId, phoneRaw) {
  const { lead, duplicate } = await addLead(userId, phoneRaw);
  if (duplicate) return { duplicate: true, lead };

  if (!withinSendWindow()) return { duplicate: false, lead, waitingForWindow: true };

  const script = await getScript(userId);
  await sock.sendMessage(lead.jid, { text: script.message1 });
  await appendMessage(userId, lead.jid, "assistant", script.message1);
  const updated = await upsertLeadPatch(userId, lead.jid, {
    status: "escrito_enviado",
    last_outbound_at: new Date().toISOString(),
  });
  return { duplicate: false, lead: updated, waitingForWindow: false };
}

async function resolveAndSend(sock, userId, jid) {
  const lead = await getLead(userId, jid);
  if (!lead || lead.status === "cerrado" || lead.paused) return;

  const tiers = await getPricingTiers(userId);
  const { replyText, closed, dormant, closedPrice, closedVideos } = await getNextMove(lead.conversation, tiers);

  await sock.sendMessage(jid, { text: replyText });
  await appendMessage(userId, jid, "assistant", replyText);

  if (closed) {
    await upsertLeadPatch(userId, jid, { status: "cerrado", last_outbound_at: new Date().toISOString() });
    await logClosedDeal(userId, { jid, phone: jid.split("@")[0], price: closedPrice, videos: closedVideos });
    await reportClosedDealToTracker(userId, { jid, phone: jid.split("@")[0], price: closedPrice, videos: closedVideos });
  } else if (dormant) {
    await upsertLeadPatch(userId, jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
  } else {
    await upsertLeadPatch(userId, jid, { status: "negociando", last_outbound_at: new Date().toISOString() });
  }
}

/** Called on every inbound WhatsApp message. Logs it immediately, then (re)starts a
 * debounce timer — the bot only actually replies once N minutes pass with no new
 * message, so a burst of texts gets answered together instead of one at a time. */
export async function handleInboundMessage(sock, userId, jid, text) {
  const lead = await getLead(userId, jid);
  if (!lead || lead.status === "cerrado") return;

  await appendMessage(userId, jid, "user", text);
  await upsertLeadPatch(userId, jid, { last_inbound_at: new Date().toISOString() });

  if (lead.paused) return; // a human took over this conversation by hand

  const key = `${userId}:${jid}`;
  if (pendingReplies.has(key)) clearTimeout(pendingReplies.get(key));
  const timer = setTimeout(() => {
    pendingReplies.delete(key);
    resolveAndSend(sock, userId, jid).catch((err) => console.error(`Error respondiendo a ${jid} (user ${userId}):`, err));
  }, DEBOUNCE_MS);
  pendingReplies.set(key, timer);
}

async function reportClosedDealToTracker(userId, deal) {
  const url = process.env.CLOSED_DEAL_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...deal, userId }),
    });
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
      await sock.sendMessage(lead.jid, { text: script.message1 });
      await appendMessage(userId, lead.jid, "assistant", script.message1);
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
        await logClosedDeal(userId, { jid: lead.jid, phone: lead.jid.split("@")[0], price: closedPrice, videos: closedVideos });
        await reportClosedDealToTracker(userId, { jid: lead.jid, phone: lead.jid.split("@")[0], price: closedPrice, videos: closedVideos });
      } else if (dormant) {
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
      } else {
        await upsertLeadPatch(userId, lead.jid, { last_outbound_at: new Date().toISOString() });
      }
    }
  }
}
