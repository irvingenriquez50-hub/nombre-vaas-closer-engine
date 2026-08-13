import "dotenv/config";
import express from "express";
import cors from "cors";
import { startSession, resetSession, getSessionInfo, getSocketForUser, restoreExistingSessions, startGlobalSweep } from "./sessions.js";
import { startProcessForNumber } from "./queue.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// Called when a member clicks "Conectar WhatsApp" — starts (or resumes) their session.
app.post("/connect/:userId", async (req, res) => {
  try {
    const info = await startSession(req.params.userId);
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error("Error en /connect:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Polled by the web app while waiting for the QR to be scanned.
app.get("/status/:userId", (req, res) => {
  const info = getSessionInfo(req.params.userId);
  res.json({ ok: true, ...info });
});

// Self-service: borra la sesión rota de un usuario y arranca una completamente nueva
// (nuevo QR). Nadie necesita tocar la consola de Railway para reconectar a alguien.
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

  const sock = getSocketForUser(userId);
  if (!sock) return res.status(409).json({ ok: false, error: "Este miembro no tiene WhatsApp conectado todavía." });

  try {
    const result = await startProcessForNumber(sock, userId, phone, { skipMessage1: !!skipMessage1 });
    if (result.duplicate) {
      return res.status(409).json({ ok: false, error: `Este número ya está en proceso (${result.lead.status}).`, lead: result.lead });
    }
    res.json({ ok: true, lead: result.lead });
  } catch (err) {
    console.error("Error agregando lead:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Motor VAAS Closer escuchando en puerto ${port}`));

restoreExistingSessions();
startGlobalSweep();
