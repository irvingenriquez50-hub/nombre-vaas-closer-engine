import { setBotSession, findLeadByAnyDigits, markLeadFailed } from "./state.js";
import { handleInboundMessage, sweepTimers } from "./queue.js";
import { supabase } from "./supabase.js";

const D360_BASE_URL = "https://waba-v2.360dialog.io";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;
const OPENING_TEMPLATE_NAME = "vaas_opening_message";
const OPENING_TEMPLATE_LANGUAGE = "en";
const FOLLOWUP_TEMPLATE_NAME = "vaas_followup_message";
const FOLLOWUP_TEMPLATE_LANGUAGE = "en";

const apiKeyCache = new Map();

async function getChannelForUser(userId) {
  if (apiKeyCache.has(userId)) return apiKeyCache.get(userId);
  const { data } = await supabase
    .from("whatsapp_channels")
    .select("d360_api_key,phone_number")
    .eq("user_id", userId)
    .maybeSingle();
  const channel = data?.d360_api_key ? { apiKey: data.d360_api_key, phone: data.phone_number || "?" } : null;

  if (channel) {
    // GUARDIA ANTI-CRUCE: si esta misma API key está guardada también en OTRA
    // cuenta, los mensajes de una van a salir del número de la otra (fue el bug
    // del mensaje que salió del número de Armando). Se avisa fuerte en los logs
    // para corregir la key en Admin de inmediato.
    const { data: dupes } = await supabase
      .from("whatsapp_channels")
      .select("user_id,phone_number")
      .eq("d360_api_key", channel.apiKey)
      .neq("user_id", userId);
    if (dupes && dupes.length) {
      console.error(
        `🚨 ALERTA DE CRUCE: la API key del usuario ${userId} es IDÉNTICA a la de otra(s) cuenta(s): ${dupes
          .map((d) => `${d.user_id} (número ${d.phone_number || "?"})`)
          .join(", ")}. Los mensajes van a salir del número equivocado — corrige la API key en Admin.`
      );
    }
    apiKeyCache.set(userId, channel);
  }
  return channel;
}

async function getApiKeyForUser(userId) {
  const channel = await getChannelForUser(userId);
  return channel?.apiKey || null;
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

export async function sendMessage(userId, jid, text) {
  const channel = await getChannelForUser(userId);
  if (!channel) throw new Error(`No hay API key de 360dialog guardada para el usuario ${userId}`);
  const apiKey = channel.apiKey;

  const to = jid.replace(/@.*/, "");
  console.log(`📱 Enviando DESDE el número ${channel.phone} (user ${userId}) HACIA ${to}`);

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

/** Manda el mensaje 1 (mensaje de apertura en frío) usando el formato de template
 * de Meta — obligatorio para cualquier mensaje que abre una conversación nueva,
 * aunque el texto final sea idéntico al de un mensaje de texto normal. */
export async function sendOpeningTemplate(userId, jid, bodyParams) {
  const channel = await getChannelForUser(userId);
  if (!channel) throw new Error(`No hay API key de 360dialog guardada para el usuario ${userId}`);
  const apiKey = channel.apiKey;

  const to = jid.replace(/@.*/, "");
  console.log(`📨 Mandando template de apertura DESDE ${channel.phone} (user ${userId}) HACIA ${to} con params: ${JSON.stringify(bodyParams)}`);

  const res = await fetch(`${D360_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "D360-API-KEY": apiKey,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: OPENING_TEMPLATE_NAME,
        language: { code: OPENING_TEMPLATE_LANGUAGE },
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })),
          },
        ],
      },
    }),
  });

  const responseBody = await res.text();
  console.log(`📨 360dialog respondió (status ${res.status}) para template a ${to}: ${responseBody}`);

  if (!res.ok) {
    throw new Error(`Error enviando template de apertura via 360dialog: ${res.status} ${responseBody}`);
  }
  return JSON.parse(responseBody);
}

/** Manda el follow-up ("Hey, any updates?") usando el template aprobado por Meta.
 * Se necesita template porque el follow-up siempre cae fuera de la ventana de 24h
 * (justo se manda porque la marca NO ha contestado), y ahí el texto libre falla
 * con el error [131047]. El template no tiene variables. */
export async function sendFollowupTemplate(userId, jid) {
  const channel = await getChannelForUser(userId);
  if (!channel) throw new Error(`No hay API key de 360dialog guardada para el usuario ${userId}`);
  const apiKey = channel.apiKey;

  const to = jid.replace(/@.*/, "");
  console.log(`📨 Mandando template de follow-up DESDE ${channel.phone} (user ${userId}) HACIA ${to}`);

  const res = await fetch(`${D360_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "D360-API-KEY": apiKey,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: FOLLOWUP_TEMPLATE_NAME,
        language: { code: FOLLOWUP_TEMPLATE_LANGUAGE },
      },
    }),
  });

  const responseBody = await res.text();
  console.log(`📨 360dialog respondió (status ${res.status}) para follow-up a ${to}: ${responseBody}`);

  if (!res.ok) {
    throw new Error(`Error enviando template de follow-up via 360dialog: ${res.status} ${responseBody}`);
  }
  return JSON.parse(responseBody);
}

export async function handleWebhookPayload(userId, payload) {  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0]?.value;

  const statuses = changes?.statuses;
  if (statuses && statuses.length) {
    for (const s of statuses) {
      if (s.status === "failed") {
        const errors = (s.errors || []).map((e) => `[${e.code}] ${e.title}${e.error_data?.details ? " — " + e.error_data.details : ""}`).join("; ");
        const errorMsg = errors || "sin detalle de error";
        console.error(`❌ ENTREGA FALLIDA — mensaje ${s.id} a ${s.recipient_id} (user ${userId}): ${errorMsg}`);
        try {
          const marked = await markLeadFailed(userId, s.recipient_id, errorMsg);
          if (marked) console.log(`📌 Lead ${s.recipient_id} marcado como "fallido" — visible en la pestaña Fallidos.`);
        } catch (err) {
          console.error(`No se pudo marcar el lead ${s.recipient_id} como fallido:`, err.message);
        }
      } else {
        console.log(`📬 Estado de mensaje ${s.id} a ${s.recipient_id} (user ${userId}): ${s.status}`);
      }
    }
  }

  const messages = changes?.messages;
  if (!messages || !messages.length) return;

  for (const msg of messages) {
    if (msg.type !== "text") {
      console.log(`⏭️  Ignorado (tipo no soportado: ${msg.type}) — from: ${msg.from} — contenido completo: ${JSON.stringify(msg)}`);
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
