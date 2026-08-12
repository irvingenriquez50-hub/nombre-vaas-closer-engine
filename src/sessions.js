import baileysPkg from "@whiskeysockets/baileys";
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileysPkg;
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { handleInboundMessage, sweepTimers } from "./queue.js";
import { setBotSession } from "./state.js";

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;

// userId -> { sock, qrDataUrl, connected }
const sessions = new Map();

function authDir(userId) {
  return path.resolve("data", "auth", userId);
}

export function getSessionInfo(userId) {
  const s = sessions.get(userId);
  return { connected: !!s?.connected, qrDataUrl: s?.qrDataUrl || null };
}

export async function startSession(userId) {
  if (sessions.has(userId) && sessions.get(userId).connected) return getSessionInfo(userId);

  fs.mkdirSync(authDir(userId), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir(userId));

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "warn" }),
    printQRInTerminal: false,
  });

  const entry = { sock, qrDataUrl: null, connected: false };
  sessions.set(userId, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qrDataUrl = await QRCode.toDataURL(qr);
      entry.connected = false;
      await setBotSession(userId, { qr_pending: true, connected: false });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      entry.connected = false;
      await setBotSession(userId, { connected: false, qr_pending: false });
      sessions.delete(userId);
      if (!loggedOut) {
        console.log(`Sesión de ${userId} se cayó, reconectando...`);
        startSession(userId).catch((err) => console.error(`Error reconectando ${userId}:`, err));
      } else {
        console.log(`Sesión de ${userId} cerró sesión (logged out). Borra su carpeta de auth para reconectar de cero.`);
      }
    } else if (connection === "open") {
      entry.connected = true;
      entry.qrDataUrl = null;
      await setBotSession(userId, { connected: true, qr_pending: false, last_seen_at: new Date().toISOString() });
      console.log(`✅ WhatsApp conectado para usuario ${userId}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.endsWith("@g.us")) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";
      if (!text.trim()) continue;

      try {
        await handleInboundMessage(sock, userId, jid, text.trim());
      } catch (err) {
        console.error(`Error procesando mensaje de ${jid} (user ${userId}):`, err);
      }
    }
  });

  return getSessionInfo(userId);
}

export function getSocketForUser(userId) {
  return sessions.get(userId)?.sock || null;
}

/** Restart any sessions that already have saved credentials on disk (e.g. after a Railway restart). */
export async function restoreExistingSessions() {
  const base = path.resolve("data", "auth");
  if (!fs.existsSync(base)) return;
  const userIds = fs.readdirSync(base).filter((f) => fs.statSync(path.join(base, f)).isDirectory());
  for (const userId of userIds) {
    console.log(`Restaurando sesión guardada para ${userId}...`);
    startSession(userId).catch((err) => console.error(`No se pudo restaurar sesión de ${userId}:`, err));
  }
}

/** Runs sweepTimers for every currently connected session, on an interval. */
export function startGlobalSweep() {
  setInterval(() => {
    for (const [userId, entry] of sessions.entries()) {
      if (!entry.connected) continue;
      sweepTimers(entry.sock, userId).catch((err) => console.error(`Error en sweepTimers de ${userId}:`, err));
    }
  }, CHECK_INTERVAL_MS);
}
