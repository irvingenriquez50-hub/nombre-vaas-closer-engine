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

// El límite por defecto de Express son 100kb, y con eso 360dialog PERDÍA mensajes:
// cualquier webhook más pesado (imágenes, audios, documentos, mensajes largos) se
// rechazaba con "PayloadTooLargeError" ANTES de que el bot pudiera verlo — o sea
// que ese mensaje nunca existía para el sistema. 25mb es el tope real de Meta.
app.use(express.json({ limit: "25mb" }));

// Si aun así llega algo que Express no puede leer, se registra con claridad en vez
// de soltar un error feo sin contexto, y se contesta 200 para que 360dialog no se
// quede reintentando el mismo mensaje una y otra vez.
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    console.error(`🚨 Llegó un mensaje MÁS GRANDE que el límite en ${req.originalUrl} — se perdió. Sube el límite en index.js.`);
    return res.sendStatus(200);
  }
  if (err && err.type === "entity.parse.failed") {
    console.error(`🚨 Llegó un mensaje con formato ilegible en ${req.originalUrl} — se ignora.`);
    return res.sendStatus(200);
  }
  return next(err);
});

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
