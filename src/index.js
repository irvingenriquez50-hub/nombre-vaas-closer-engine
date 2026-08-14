import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  startSession,
  resetSession,
  getSessionInfo,
  sendMessage,
  handleWebhookPayload,
  restoreExistingSessions,
  startGlobalSweep,
} from "./sessions.js";
import { startProcessForNumber } from "./queue.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Called when a member clicks "Conectar WhatsApp" — con la API oficial, esto solo
// confirma que su API key de 360dialog ya está guardada en Supabase.
app.post("/connect/:userId", async (req, res) => {
  try {
    const info = await startSession(req.params.userId);
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error("Error en /connect:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Polled by the web app — ya no hay QR, solo indica si el canal está listo.
app.get("/status/:userId", (req, res) => {
  const info = getSessionInfo(req.params.userId);
  res.json({ ok: true, ...info });
});

// Self-service: refresca la API key de un usuario desde Supabase (por si la actualizaron).
app.post("/reset/:userId", async (req, res) => {
  try {
    const info = await resetSession(req.params.userId);
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error("Error en /reset:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/add-lead/:userId", async (req, res) => {
  const { userId } = req.params;
  const { phone, skipMessage1 } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: "Falta el campo 'phone'." });

  const info = getSessionInfo(userId);
  if (!info.connected) {
    return res.status(409).json({ ok: false, error: "Este miembro no tiene WhatsApp conectado todavía." });
  }

  const fakeSock = {
    sendMessage: async (toJid, content) => sendMessage(userId, toJid, content.text),
  };

  try {
    const result = await startProcessForNumber(fakeSock, userId, phone, { skipMessage1: !!skipMessage1 });
    if (result.duplicate) {
      return res.status(409).json({ ok: false, error: `Este número ya está en proceso (${result.lead.status}).`, lead: result.lead });
    }
    res.json({ ok: true, lead: result.lead });
  } catch (err) {
    console.error("Error agregando lead:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 360dialog llama aquí cuando llega un mensaje nuevo al número de este usuario.
app.post("/webhook/:userId", async (req, res) => {
  res.sendStatus(200); // confirmar recepción rápido, procesar después
  try {
    await handleWebhookPayload(req.params.userId, req.body);
  } catch (err) {
    console.error(`Error procesando webhook de ${req.params.userId}:`, err);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Motor VAAS Closer escuchando en puerto ${port}`));

restoreExistingSessions();
startGlobalSweep();
