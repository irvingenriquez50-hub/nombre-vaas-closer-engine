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

app.post("/connect/:userId", async (req, res) => {
  try {
    const info = await startSession(req.params.userId);
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error("Error en /connect:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status/:userId", async (req, res) => {
  const info = await getSessionInfo(req.params.userId);
  res.json({ ok: true, ...info });
});

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
  console.log(`📥 POST /add-lead recibido — user: ${userId}, phone: ${phone}, skipMessage1: ${!!skipMessage1}`);

  if (!phone) {
    console.log(`⚠️  /add-lead rechazado: falta el campo 'phone'`);
    return res.status(400).json({ ok: false, error: "Falta el campo 'phone'." });
  }

  const info = await getSessionInfo(userId);
  console.log(`🔌 Estado de conexión para ${userId}: connected=${info.connected}`);
  if (!info.connected) {
    console.log(`⚠️  /add-lead rechazado: usuario ${userId} no tiene WhatsApp conectado (sin API key en whatsapp_channels)`);
    return res.status(409).json({ ok: false, error: "Este miembro no tiene WhatsApp conectado todavía." });
  }

  const fakeSock = {
    sendMessage: async (toJid, content) => sendMessage(userId, toJid, content.text),
  };

  try {
    const result = await startProcessForNumber(fakeSock, userId, phone, { skipMessage1: !!skipMessage1 });
    if (result.duplicate) {
      console.log(`⚠️  /add-lead: ${phone} ya estaba en proceso (status: ${result.lead.status})`);
      return res.status(409).json({ ok: false, error: `Este número ya está en proceso (${result.lead.status}).`, lead: result.lead });
    }
    console.log(`✅ /add-lead completado sin error para ${phone} (status final: ${result.lead.status})`);
    res.json({ ok: true, lead: result.lead });
  } catch (err) {
    console.error(`❌ Error agregando lead ${phone} (user ${userId}):`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/webhook/:userId", async (req, res) => {
  res.sendStatus(200);
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
