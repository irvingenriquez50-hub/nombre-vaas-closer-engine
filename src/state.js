import { setBotSession, findLeadByAnyDigits, getUserInfo } from "./state.js";
import { handleInboundMessage, sweepTimers } from "./queue.js";
import { supabase } from "./supabase.js";

const D360_BASE_URL = "https://waba-v2.360dialog.io";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "d5c3e03b-5ac0-45d9-9852-b3cc9abe95b3";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "13463207120";
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // no repetir la misma alerta antes de 30 min
const lastAlertAt = new Map();

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

export async function getSessionInfo(userId) {
  const key = await getApiKeyForUser(userId);
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

// Manda una alerta en español sencillo a TU propio WhatsApp, con un límite de
// una vez cada 30 min por el mismo tipo de problema (para no saturarte).
async function notifyAdmin(alertKey, message) {
  const now = Date.now();
  const last = lastAlertAt.get(alertKey) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlertAt.set(alertKey, now);

  const adminKey = await getApiKeyForUser(ADMIN_USER_ID);
  if (!adminKey) {
    console.error("⚠️ No se pudo mandar alerta al admin: no hay API key guardada para el admin.");
    return;
  }
  try {
    await fetch(`${D360_BASE_URL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "D360-API-KEY": adminKey },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: ADMIN_PHONE,
        type: "text",
        text: { body: message },
      }),
    });
  } catch (err) {
    console.error("⚠️ Error mandando alerta al admin:", err.message);
  }
}

export async function sendMessage(userId, jid, text) {
  const apiKey = await getApiKeyForUser(userId);
  if (!apiKey) {
    if (userId !== ADMIN_USER_ID) {
      const info = await getUserInfo(userId);
      notifyAdmin(
        `${userId}:no_key`,
        `⚠️ Problema con el bot de ${info.name} (${info.email}): no tiene ninguna API key de 360dialog guardada, así que no puede mandar mensajes. Revisa su canal en /admin.`
      ).catch(() => {});
    }
    throw new Error(`No hay API key de 360dialog guardada para el usuario ${userId}`);
  }

  if (!text || !text.trim()) {
    console.error(`⚠️  Se intentó mandar un mensaje VACÍO a ${jid} (user ${userId}) — revisa "Tu escrito" en el dashboard de ese usuario. No se envió nada.`);
    return null;
  }

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
    if (userId !== ADMIN_USER_ID) {
      const info = await getUserInfo(userId);
      const isAuthError = res.status === 401;
      notifyAdmin(
        `${userId}:send_fail`,
        isAuthError
          ? `⚠️ El bot de ${info.name} (${info.email}) dejó de funcionar — su API key de 360dialog ya no es válida (probablemente expiró o se desconectó su WhatsApp). Necesitas regenerar su API key en 360dialog y pegarla otra vez en /admin.`
          : `⚠️ El bot de ${info.name} (${info.email}) tuvo un error mandando un mensaje (código ${res.status}). Revisa los logs de Railway para más detalle.`
      ).catch(() => {});
    }
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
