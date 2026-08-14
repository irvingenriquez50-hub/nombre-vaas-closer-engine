import { setBotSession, findLeadByAnyDigits } from "./state.js";
import { handleInboundMessage, sweepTimers } from "./queue.js";
import { supabase } from "./supabase.js";

const D360_BASE_URL = "https://waba-v2.360dialog.io";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;

// Cache en memoria de las API keys de 360dialog por usuario, para no consultar Supabase en cada mensaje.
const apiKeyCache = new Map();

async function getApiKeyForUser(userId) {
  if (apiKeyCache.has(userId)) return apiKeyCache.get(userId);
  const { data } = await supabase
    .from("whatsapp_channels")
    .select("d360_api_key")
    .eq("user_id", userId)
    .maybeSingle();
  const key = data?.d360_api_key || null;
  if (key) apiKeyCache.set(userId, key);
  return key;
}

export function invalidateApiKeyCache(userId) {
  apiKeyCache.delete(userId);
}

export function getSessionInfo(userId) {
  const key = apiKeyCache.get(userId);
  return { connected: !!key, qrDataUrl: null };
}

export async function startSession(userId) {
  const key = await getApiKeyForUser(userId);
  const connected = !!key;
  await setBotSession(userId, { connected, qr_pending: false });
  return { connected, qrDataUrl: null };
}

export async function resetSession(userId) {
  invalidateApiKeyCache(userId);
  return startSession(userId);
}

export async function sendMessage(userId, jid, text) {
  const apiKey = await getApiKeyForUser(userId);
  if (!apiKey) throw new Error(`No hay API key de 360dialog guardada para el usuario ${userId}`);

  const to = jid.replace(/@.*/, "");

  const res = await fetch(`${D360_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "D360-API-KEY": apiKey,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Error enviando mensaje via 360dialog: ${res.status} ${errText}`);
  }
  return res.json();
}

export async function handleWebhookPayload(userId, payload) {
  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  const messages = changes?.messages;
  if (!messages || !messages.length) return;

  for (const msg of messages) {
    if (msg.type !== "text") {
      console.log(`⏭️  Ignorado (tipo no soportado: ${msg.type}) — from: ${msg.from}`);
      continue;
    }

    const jid = msg.from;
    const text = msg.text?.body || "";
    if (!text.trim()) continue;

    console.log(`✉️  Procesando mensaje de ${jid} (user ${userId}): "${text.trim()}"`);
    try {
      const fakeSock = {
        sendMessage: async (toJid, content) => sendMessage(userId, toJid, content.text),
      };
      await handleInboundMessage(fakeSock, userId, jid, text.trim());
      console.log(`✅ handleInboundMessage terminó sin error para ${jid}`);
    } catch (err) {
      console.error(`❌ Error procesando mensaje de ${jid} (user ${userId}):`, err);
    }
  }
}

export async function restoreExistingSessions() {
  console.log("Usando API oficial de WhatsApp — no hay sesiones locales que restaurar.");
}

export function startGlobalSweep() {
  setInterval(async () => {
    const { data: channels } = await supabase.from("whatsapp_channels").select("user_id");
    for (const { user_id } of channels || []) {
      const fakeSock = {
        sendMessage: async (toJid, content) => sendMessage(user_id, toJid, content.text),
      };
      sweepTimers(fakeSock, user_id).catch((err) => console.error(`Error en sweepTimers de ${user_id}:`, err));
    }
  }, CHECK_INTERVAL_MS);
}
