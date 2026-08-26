"use client";
import { useState, useTransition, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { saveScript, savePricing, addLead, updateLeadStatus, toggleLeadPause, removeLead, restartLead, resolveLeadManually, markAsCollab } from "./actions";
import { connectWhatsapp, whatsappStatus, resetWhatsapp } from "./whatsapp-actions";
import { getDiscordCalendar, importDay, listLeadRequests, activateLeadRequest, rejectLeadRequest, markOngoingRequest, resetDayRequests, getDayStatuses } from "./discord-actions";

const TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30];
const STAGES = [
  { key: "nuevo", label: "Nuevo" },
  { key: "escrito_enviado", label: "Escrito enviado" },
  { key: "esperando", label: "Esperando respuesta" },
  { key: "followup", label: "Follow-up" },
  { key: "negociando", label: "Negociando" },
  { key: "cerrado", label: "Cerrado" },
];
const stageIndex = (key) => Math.max(0, STAGES.findIndex((s) => s.key === key));

// Burbujas de filtro de la cola, en el orden del embudo real: de lo que no se ha
// mandado hasta lo cerrado, y al final los que necesitan que Irving haga algo.
// Solo se pintan las que tienen al menos 1 contacto, para que no se llene de
// burbujas vacías.
const MUTED_KEY = "mudos";
const COLLAB_KEY = "colab";

const LEAD_FILTERS = [
  { key: "todos", label: "Todos", color: "#22D3C0" },
  { key: MUTED_KEY, label: "🔇 Sin contestar", color: "#FF5C5C" },
  { key: "nuevo", label: "Nuevos", color: "#8AB4F8" },
  { key: "escrito_enviado", label: "Enviados", color: "#22D3C0" },
  { key: "esperando", label: "Esperando", color: "#8B96A5" },
  { key: "followup", label: "Follow-up", color: "#F2B84B" },
  { key: "negociando", label: "Negociando", color: "#C084FC" },
  { key: "cerrado", label: "Cerrados", color: "#34D399" },
  { key: "checkback", label: "🔁 Seguimiento", color: "#8AB4F8" },
  { key: "dormant", label: "Dormidos", color: "#6B7684" },
  { key: "cruzado", label: "Cruzados", color: "#F2B84B" },
  { key: "fallido", label: "Fallidos", color: "#F19999" },
  { key: COLLAB_KEY, label: "🤝 Ya tengo colab", color: "#34D399" },
];

/** Contactos que marcaste a mano como "ya tengo colaboración con esta persona".
 * Quedan cerrados y pausados: el bot no les escribe nunca. No es un trato del
 * bot, por eso lleva su propia marca y su propio filtro. */
const isCollabLead = (lead) => !!lead?.negotiation?.manualCollab;

/** Detecta contactos MUDOS: la marca escribió y el bot todavía no ha contestado.
 * Esto pasaba antes en silencio — el mensaje llegaba, el temporizador de respuesta
 * se perdía por un reinicio del servidor, y el contacto se quedaba muerto sin que
 * nadie se enterara. Ahora se ve aquí en rojo.
 * Devuelve null si todo está normal. Se ignoran los pausados (esos ya los tomaste
 * tú) y los cerrados, dormidos o fallidos. */
function mutedInfo(lead) {
  if (!lead || lead.paused) return null;
  if (["cerrado", "dormant", "fallido"].includes(lead.status)) return null;
  if (!lead.last_inbound_at) return null;

  const inbound = new Date(lead.last_inbound_at).getTime();
  const outbound = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
  if (isNaN(inbound) || inbound <= outbound) return null; // ya se le contestó

  const hours = (Date.now() - inbound) / 3600000;
  // Menos de 1 hora es operación normal: el bot espera unos minutos a propósito
  // para juntar mensajes seguidos, y el rescate automático entra a los 15 min.
  if (hours < 1) return null;

  return { hours: Math.round(hours), windowClosed: hours >= 24 };
}

/** Fecha corta (08/21) del último movimiento del contacto, con la fecha completa
 * en el tooltip. Se prefiere la fecha en que SALIÓ el último mensaje; si el lead
 * es tan viejo que no la tiene guardada, se cae a cuándo se creó. */
function leadDate(lead) {
  const raw = lead.last_outbound_at || lead.created_at || lead.updated_at;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return {
    short: d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }),
    full: d.toLocaleString("es-MX", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }),
  };
}

const PRICE_TABLES = {
  500: { 1:[500,450,400],2:[1000,900,800],3:[1500,1350,1200],4:[2050,1800,1600],5:[2250,2100,1900],6:[2700,2550,2400],7:[3150,2950,2800],8:[3600,3400,3200],9:[4050,3850,3600],10:[4000,3750,3500],15:[5250,4850,4500],20:[7000,6500,6000],30:[9000,8250,7500] },
  450: { 1:[450,400,350],2:[900,800,700],3:[1350,1200,1050],4:[1800,1600,1400],5:[2050,1800,1600],6:[2450,2200,1900],7:[2850,2550,2250],8:[3300,2950,2550],9:[3700,3300,2900],10:[3600,3350,3000],15:[5000,4500,4000],20:[6300,5650,5000],30:[7650,7200,6700] },
  400: { 1:[400,350,300],2:[800,700,600],3:[1200,1050,900],4:[1600,1400,1200],5:[1800,1600,1400],6:[2150,1950,1700],7:[2500,2250,1950],8:[2900,2600,2250],9:[3250,2900,2550],10:[3200,2850,2500],15:[4500,4150,3800],20:[5600,5000,4400],30:[7000,6500,6000] },
  350: { 1:[350,300,250],2:[700,600,500],3:[1050,900,750],4:[1400,1200,1000],5:[1600,1450,1250],6:[1900,1700,1500],7:[2250,2000,1750],8:[2550,2300,2000],9:[2900,2600,2250],10:[2800,2550,2300],15:[3950,3500,3000],20:[4900,4450,4000],30:[6600,6200,5800] },
  300: { 1:[300,250,200],2:[600,500,400],3:[900,750,600],4:[1200,1000,800],5:[1350,1200,1000],6:[1600,1400,1200],7:[1900,1650,1400],8:[2150,1900,1600],9:[2450,2150,1800],10:[2500,2250,2000],15:[3400,3100,2800],20:[4200,3900,3600],30:[6300,5850,5400] },
};

function defaultTiers() {
  return TIERS.map((n) => ({ videos: n, anchor: n === 1 ? 300 : 300 * n, medio: n === 1 ? 250 : 250 * n, floor: n === 1 ? 200 : 200 * n }));
}

function normalizePhoneForCountry(raw, country) {
  const digits = (raw || "").replace(/[^0-9]/g, "");
  if (country === "other") return digits;
  if (country === "us") {
    if (digits.length === 10) return "1" + digits;
    return digits;
  }
  if (digits.length === 11 && !digits.startsWith("86")) return "86" + digits;
  return digits;
}

function waLink(phone) {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  return `https://wa.me/${digits}`;
}

function groupByDate(requests) {
  const groups = {};
  for (const req of requests) {
    const d = req.message_created_at ? new Date(req.message_created_at) : new Date(req.created_at);
    const label = d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
    if (!groups[label]) groups[label] = [];
    groups[label].push(req);
  }
  return Object.entries(groups);
}

function RequestCard({ req, onActivate, onReject, onOngoing, F_MONO }) {
  const [notSentYet, setNotSentYet] = useState(false);

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: "#141B24", border: req.cross_member ? "1px solid #F2B84B" : "1px solid #232D3A" }}
    >
      <div className="flex items-center justify-between mb-2">
        <div style={{ fontFamily: F_MONO, fontSize: 14, fontWeight: 600 }}>{req.phone}</div>
        <a
          href={waLink(req.phone)}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-2 rounded-lg text-xs font-semibold"
          style={{ background: "#25D36622", color: "#25D366" }}
        >
          WhatsApp ↗
        </a>
      </div>
      <div style={{ fontSize: 11, color: "#8B96A5", lineHeight: 1.6 }}>
        {req.product && <div>Producto: {req.product}</div>}
        {req.videos_text && <div>{req.videos_text}</div>}
        {req.price_text && <div>{req.price_text}</div>}
      </div>
      {req.cross_member && (
        <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#F2B84B15", color: "#F2B84B" }}>
          ⚠️ Ya tienes historial con este número en otro miembro.
        </div>
      )}
      <label className="flex items-center gap-2 mt-3 px-1" style={{ fontSize: 11.5, color: "#8B96A5" }}>
        <input type="checkbox" checked={notSentYet} onChange={(e) => setNotSentYet(e.target.checked)} />
        No le he mandado el mensaje — que lo mande el bot automáticamente
      </label>
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => onActivate(!notSentYet)}
          className="flex-1 py-2 rounded-lg text-xs font-semibold"
          style={{ background: "#34D399", color: "#06110F" }}
        >
          Empezar
        </button>
        <button
          onClick={() => {
            if (!window.confirm(`¿Seguro que ya tienes colaboración con ${req.phone}?\n\nSi le picas que sí, este contacto no vuelve a aparecer nunca, aunque reimportes ese día.`)) return;
            onOngoing();
          }}
          className="px-3 py-2 rounded-lg text-xs font-semibold"
          style={{ background: "#8AB4F822", color: "#8AB4F8" }}
          title="Ya tengo colaboración con esta persona — no lo vuelvas a mostrar"
        >
          Ya tengo colab
        </button>
        <button
          onClick={() => {
            if (!window.confirm(`¿Seguro que quieres rechazar ${req.phone}?\n\nSe quita de la lista. Si algún día reseteas ese día, puede volver a aparecer.`)) return;
            onReject();
          }}
          className="px-3 py-2 rounded-lg text-xs font-semibold"
          style={{ background: "#2A1620", color: "#F19999" }}
        >
          Rechazar
        </button>
      </div>
    </div>
  );
}

const MARKET_OPTIONS = ["Spanish-speaking", "English-speaking", "Spanish/English-speaking"];
const emptyScriptFields = { gmvTotal: "", market: "Spanish-speaking", shortName: "", gmv30d: "", tiktokHandle: "" };

function buildPreviewText(fields, tiers) {
  const tier1 = tiers.find((t) => t.videos === 1);
  const tier5 = tiers.find((t) => t.videos === 5);
  const tier10 = tiers.find((t) => t.videos === 10);

  return `• FROM THE VAAS COMMUNITY •

I would love to work with your brand!

I've helped multiple brands generate millions of views and over $${fields.gmvTotal || "___"} GMV within the ${fields.market || "___"} U.S. audience.

To keep quality high and give each video the time needed to create the best possible content, I only work through retainers. All packages include ad usage rights unless otherwise discussed.

${fields.shortName || "___"} — RATES

1x Video — $${tier1?.anchor ?? "___"} per video

5x Videos/Month — $${tier5?.anchor ?? "___"}
(10% discount applied)

10x Videos/Month — $${tier10?.anchor ?? "___"}
(20% discount applied)

If this aligns with what you're looking for, I'd be happy to lock in a slot this week and start brainstorming content ideas tailored specifically to your brand.

Looking forward to working together,

Last 30 Days GMV: $${fields.gmv30d || "___"} USD

My TikTok Account: @${fields.tiktokHandle || "___"}

— The VAAS Community`;
}

export default function DashboardClient({ targetUserId, isAdminView, profile, initialTiers, initialScript, initialLeads }) {
  const [tab, setTab] = useState("escrito");
  const [scriptFields, setScriptFields] = useState({ ...emptyScriptFields, ...(initialScript || {}) });
  const [scriptSaved, setScriptSaved] = useState(true);

  const mergedTiers = defaultTiers().map((d) => {
    const found = (initialTiers || []).find((t) => t.videos === d.videos);
    return found
      ? { videos: d.videos, anchor: Number(found.anchor), medio: found.medio != null ? Number(found.medio) : d.medio, floor: Number(found.floor) }
      : d;
  });
  const [tiers, setTiers] = useState(mergedTiers);
  const [tiersSaved, setTiersSaved] = useState(true);
  const [pricePerVideo, setPricePerVideo] = useState("");
  const [tableUpdated, setTableUpdated] = useState(false);

  const [leads, setLeads] = useState(initialLeads || []);
  const [phoneInput, setPhoneInput] = useState("");
  const [addCountry, setAddCountry] = useState("other");
  const [leadError, setLeadError] = useState("");
  const [pending, startTransition] = useTransition();
  const [leadFilter, setLeadFilter] = useState("todos");

  const [waConnected, setWaConnected] = useState(false);
  const [waLoading, setWaLoading] = useState(false);
  const [waError, setWaError] = useState("");

  const [leadRequests, setLeadRequests] = useState([]);
  const [calendar, setCalendar] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [importingDay, setImportingDay] = useState(null);
  const [resettingDay, setResettingDay] = useState(null);
  const [resetResult, setResetResult] = useState(null);
  const [dayStatuses, setDayStatuses] = useState({});

  // Conteo en vivo por estado, para las burbujas de filtro.
  const leadCounts = useMemo(() => {
    const counts = { todos: leads.length, [MUTED_KEY]: 0, [COLLAB_KEY]: 0 };
    for (const lead of leads) {
      const key = lead.status || "nuevo";
      counts[key] = (counts[key] || 0) + 1;
      if (mutedInfo(lead)) counts[MUTED_KEY] += 1;
      if (isCollabLead(lead)) counts[COLLAB_KEY] = (counts[COLLAB_KEY] || 0) + 1;
    }
    return counts;
  }, [leads]);

  const visibleFilters = useMemo(
    () => LEAD_FILTERS.filter((f) => f.key === "todos" || (leadCounts[f.key] || 0) > 0),
    [leadCounts]
  );

  const filteredLeads = useMemo(() => {
    if (leadFilter === "todos") return leads;
    // "Sin contestar" no es un status guardado: se calcula comparando fechas.
    if (leadFilter === MUTED_KEY) return leads.filter((l) => mutedInfo(l));
    if (leadFilter === COLLAB_KEY) return leads.filter(isCollabLead);
    return leads.filter((l) => (l.status || "nuevo") === leadFilter);
  }, [leads, leadFilter]);

  // Si el filtro activo se queda sin contactos (por ejemplo borraste el último
  // fallido), se regresa solo a "Todos" para que nunca quede una lista vacía.
  useEffect(() => {
    if (leadFilter !== "todos" && (leadCounts[leadFilter] || 0) === 0) setLeadFilter("todos");
  }, [leadCounts, leadFilter]);

  const checkWaStatus = useCallback(async () => {
    try {
      const res = await whatsappStatus(targetUserId);
      setWaConnected(!!res.connected);
      setWaError("");
    } catch (err) {
      console.error("Error consultando estado de WhatsApp:", err);
      setWaError(err?.message || "No se pudo consultar el motor de WhatsApp.");
    }
  }, [targetUserId]);

  useEffect(() => {
    checkWaStatus();
    const interval = setInterval(checkWaStatus, 4000);
    return () => clearInterval(interval);
  }, [checkWaStatus]);

  const loadLeadRequests = useCallback(async () => {
    const data = await listLeadRequests(targetUserId);
    setLeadRequests(data);
  }, [targetUserId]);

  const loadCalendar = useCallback(async () => {
    const data = await getDiscordCalendar(targetUserId);
    setCalendar(data);
  }, [targetUserId]);

  const loadDayStatuses = useCallback(async () => {
    const data = await getDayStatuses(targetUserId);
    setDayStatuses(data || {});
  }, [targetUserId]);

  useEffect(() => {
    if (tab !== "revision") return;
    setCalendarLoading(true);
    Promise.all([loadLeadRequests(), loadCalendar(), loadDayStatuses()]).then(() => setCalendarLoading(false));
  }, [tab, loadLeadRequests, loadCalendar, loadDayStatuses]);

  const doImportDay = (dateStr) => {
    setImportingDay(dateStr);
    startTransition(async () => {
      await importDay(targetUserId, dateStr);
      setImportingDay(null);
      loadLeadRequests();
      loadDayStatuses();
    });
  };

  const doResetDay = (dateStr, label) => {
    const confirmed = window.confirm(
      `¿Seguro que quieres resetear el día ${label}?\n\nLos contactos que nunca contestaron nada volverán a aparecer para mandarles el mensaje otra vez. Las conversaciones reales o tratos ya cerrados NO se tocan.`
    );
    if (!confirmed) return;
    setResettingDay(dateStr);
    setResetResult(null);
    startTransition(async () => {
      const res = await resetDayRequests(targetUserId, dateStr);
      setResettingDay(null);
      setResetResult({ dateStr, ...res });
      loadLeadRequests();
      loadCalendar();
      loadDayStatuses();
    });
  };

  const doConnectWhatsapp = async () => {
    setWaLoading(true);
    await connectWhatsapp(targetUserId);
    await checkWaStatus();
    setWaLoading(false);
  };

  const doResetWhatsapp = async () => {
    if (!confirm("Esto refresca la conexión con tu número de WhatsApp Business. ¿Seguro?")) return;
    setWaLoading(true);
    await resetWhatsapp(targetUserId);
    await checkWaStatus();
    setWaLoading(false);
  };

  const doSaveScript = () => {
    startTransition(async () => {
      await saveScript(targetUserId, scriptFields);
      setScriptSaved(true);
    });
  };

  const doSavePricing = () => {
    startTransition(async () => {
      await savePricing(targetUserId, tiers);
      setTiersSaved(true);
    });
  };

  const applyPriceTable = () => {
    const price = Number(pricePerVideo);
    if (!price) return;
    const availableTiers = Object.keys(PRICE_TABLES).map(Number);
    const closest = availableTiers.reduce((prev, curr) =>
      Math.abs(curr - price) < Math.abs(prev - price) ? curr : prev
    );
    const table = PRICE_TABLES[closest];
    const updated = tiers.map((t) => {
      const row = table[t.videos];
      if (!row) return t;
      const [anchor, medio, floor] = row;
      return { ...t, anchor, medio, floor };
    });
    setTiers(updated);
    setTiersSaved(false);
    setTableUpdated(true);
    setTimeout(() => setTableUpdated(false), 2500);
  };

  const [needsAutoSend, setNeedsAutoSend] = useState(false);
  const [expandedConvo, setExpandedConvo] = useState(null);

  const doAddLead = () => {
    if (!phoneInput.trim()) return;
    const normalized = normalizePhoneForCountry(phoneInput, addCountry);
    const skipMessage1 = !needsAutoSend;
    startTransition(async () => {
      const res = await addLead(targetUserId, normalized, skipMessage1);
      if (res?.error) {
        setLeadError(res.error);
      } else {
        setLeadError("");
        setPhoneInput("");
        setLeads((l) => [{ id: crypto.randomUUID(), phone: normalized, status: skipMessage1 ? "esperando" : "nuevo", timezone: addCountry, paused: false, updated_at: new Date().toISOString(), created_at: new Date().toISOString() }, ...l]);
      }
    });
  };

  const doRestartLead = (leadId) => {
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: "nuevo", paused: false } : l)));
    startTransition(() => restartLead(targetUserId, leadId));
  };

  // Para leads con status "fallido" (Meta/WhatsApp rechazó la entrega): se borra
  // por completo y su número se precarga en la cajita de arriba, como si fuera
  // nuevo — con el checkbox y todas las opciones libres para agregarlo de nuevo.
  const doReiniciarFallido = (lead) => {
    setLeads((prev) => prev.filter((l) => l.id !== lead.id));
    setPhoneInput(lead.phone);
    setNeedsAutoSend(false);
    setLeadError("");
    startTransition(() => removeLead(targetUserId, lead.id));
  };

  // "Ya tengo colaboración con este número": lo deja cerrado y pausado, y el bot
  // ya nunca le escribe. Sirve tanto para un contacto que ya está en la cola como
  // para un número que nunca ha estado — así lo registras antes de mandarle nada.
  const doMarkCollab = (phoneRaw, leadId = null) => {
    startTransition(async () => {
      const res = await markAsCollab(targetUserId, phoneRaw);
      if (res?.error) {
        window.alert(`No se pudo guardar:\n\n${res.error}`);
        return;
      }
      setLeadError("");
      if (leadId) {
        setLeads((prev) =>
          prev.map((l) =>
            l.id === leadId
              ? { ...l, status: "cerrado", paused: true, negotiation: { ...(l.negotiation || {}), manualCollab: true } }
              : l
          )
        );
      } else {
        setPhoneInput("");
        setLeads((prev) => {
          const digits = (phoneRaw || "").replace(/[^0-9]/g, "");
          const yaEsta = prev.some((l) => (l.phone || "").replace(/[^0-9]/g, "").slice(-8) === digits.slice(-8));
          if (yaEsta) {
            return prev.map((l) =>
              (l.phone || "").replace(/[^0-9]/g, "").slice(-8) === digits.slice(-8)
                ? { ...l, status: "cerrado", paused: true, negotiation: { ...(l.negotiation || {}), manualCollab: true } }
                : l
            );
          }
          return [
            {
              id: crypto.randomUUID(),
              phone: phoneRaw,
              status: "cerrado",
              paused: true,
              negotiation: { manualCollab: true },
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            ...prev,
          ];
        });
      }
    });
  };

  const doResolveLead = (leadId) => {
    if (!confirm("Esto archiva el contacto sin reportarlo a tu Retainer Tracker. ¿Seguro?")) return;
    setLeads((prev) => prev.filter((l) => l.id !== leadId));
    startTransition(() => resolveLeadManually(targetUserId, leadId));
  };

  // skipMessage1 ahora viene del checkbox real de cada tarjeta (RequestCard),
  // en vez de estar fijo en "true" — así el bot manda el template automáticamente
  // cuando Irving NO marcó que ya lo mandó a mano.
  //
  // PROTECCIÓN: si ya hay historial con ese número (chat del bot o trato cerrado),
  // el servidor NO activa nada y regresa el detalle. Aquí se le enseña a Irving y
  // él decide: OK = reiniciar y darle otra vuelta; Cancelar = no hacer nada (y si
  // ya tiene colaboración, usa el botón "Ya tengo colab" de la misma tarjeta).
  // Y si algo falla, el motivo SIEMPRE se muestra — nada de fallar en silencio.
  const doActivateRequest = (req, skipMessage1) => {
    startTransition(async () => {
      const applySuccess = () => {
        setLeadRequests((prev) => prev.filter((r) => r.id !== req.id));
        setLeads((prev) => [
          {
            id: crypto.randomUUID(),
            phone: req.phone,
            status: skipMessage1 ? "esperando" : "nuevo",
            paused: false,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
          ...prev,
        ]);
        loadDayStatuses();
      };

      const res = await activateLeadRequest(targetUserId, req.id, req.phone, skipMessage1);

      if (res?.needsDecision) {
        const seguir = window.confirm(
          `⚠️ YA HAY HISTORIAL con ${req.phone}:\n\n${res.history.summary}\n\n` +
            `¿Quieres REINICIAR y darle otra vuelta a este contacto?\n` +
            `(El chat guardado no se borra.)\n\n` +
            `Si ya tienes colaboración con esta persona, dale Cancelar y pícale "Ya tengo colab".`
        );
        if (!seguir) return;
        const res2 = await activateLeadRequest(targetUserId, req.id, req.phone, skipMessage1, true);
        if (res2?.error) {
          window.alert(`No se pudo activar ${req.phone}:\n\n${res2.error}`);
          return;
        }
        applySuccess();
        return;
      }

      if (res?.error) {
        window.alert(`No se pudo activar ${req.phone}:\n\n${res.error}`);
        return;
      }

      applySuccess();
    });
  };

  const doRejectRequest = (reqId) => {
    setLeadRequests((prev) => prev.filter((r) => r.id !== reqId));
    startTransition(async () => {
      await rejectLeadRequest(targetUserId, reqId);
      loadDayStatuses();
    });
  };

  const doOngoingRequest = (reqId) => {
    setLeadRequests((prev) => prev.filter((r) => r.id !== reqId));
    startTransition(async () => {
      await markOngoingRequest(targetUserId, reqId);
      loadDayStatuses();
    });
  };

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  const F_DISPLAY = "'Space Grotesk', sans-serif";
  const F_MONO = "'IBM Plex Mono', monospace";

  const groupedRequests = groupByDate(leadRequests);

  return (
    <div className="min-h-screen w-full pb-16" style={{ background: "#0B0E14", color: "#EDEFF2" }}>
      {isAdminView && (
        <div className="px-5 py-2 text-center text-xs" style={{ background: "#F2B84B22", color: "#F2B84B" }}>
          Viendo como {profile?.name || profile?.email} (modo admin)
        </div>
      )}

      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ borderBottom: "1px solid #1B2430" }}>
        <div>
          <h1 style={{ fontFamily: F_DISPLAY, fontWeight: 700, fontSize: 22 }}>VAAS Closer Bot</h1>
          <div style={{ fontSize: 12, color: "#8B96A5" }}>{profile?.name || profile?.email}</div>
        </div>
        {!isAdminView && (
          <button onClick={signOut} className="px-3 py-1.5 rounded-lg text-xs" style={{ background: "#141B24", border: "1px solid #232D3A", color: "#8B96A5" }}>
            Salir
          </button>
        )}
      </div>

      <div className="px-5 pt-4 flex gap-2 flex-wrap">
        {[
          ["whatsapp", "WhatsApp"],
          ["escrito", "Tu escrito"],
          ["precios", "Precios"],
          ["cola", "Cola de contactos"],
          ["revision", "Revisión"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={tab === key ? { background: "#22D3C0", color: "#06110F" } : { background: "#141B24", color: "#8B96A5", border: "1px solid #232D3A" }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "whatsapp" && (
        <div className="px-5 pt-4 flex flex-col items-center text-center">
          {waError && (
            <div className="w-full mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: "#2A1620", color: "#F19999", border: "1px solid #4A2530" }}>
              {waError}
            </div>
          )}
          {waConnected ? (
            <div className="w-full rounded-xl p-6" style={{ background: "#141B24", border: "1px solid #34D399" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#34D399" }}>WhatsApp conectado ✓</div>
              <div style={{ fontSize: 12, color: "#8B96A5", marginTop: 6 }}>
                Tu bot ya puede mandar y recibir mensajes en tu número. Sigues usando WhatsApp normal en tu teléfono sin problema.
              </div>
            </div>
          ) : (
            <div className="w-full rounded-xl p-6" style={{ background: "#141B24", border: "1px solid #232D3A" }}>
              <div style={{ fontSize: 13, color: "#8B96A5", marginBottom: 14 }}>
                Tu número de WhatsApp Business todavía no está activo en el sistema.
              </div>
              <button
                onClick={doConnectWhatsapp}
                disabled={waLoading}
                className="px-4 py-2.5 rounded-xl font-semibold text-sm"
                style={{ background: "#22D3C0", color: "#06110F" }}
              >
                {waLoading ? "Activando..." : "Activar WhatsApp"}
              </button>
            </div>
          )}

          {!waLoading && (
            <button
              onClick={doResetWhatsapp}
              className="mt-4 text-xs"
              style={{ color: "#8B96A5", textDecoration: "underline" }}
            >
              ¿Problemas? Refrescar conexión
            </button>
          )}
        </div>
      )}

      {tab === "escrito" && (
        <div className="px-5 pt-4">
          <div style={{ fontSize: 12, color: "#8B96A5", marginBottom: 12 }}>
            Estos datos rellenan el mensaje 1 (el que el bot manda a cada número nuevo) — el texto en sí ya está aprobado por WhatsApp, tú solo llenas tus datos.
          </div>

          <div className="flex flex-col gap-3">
            <Field label="GMV total (ej. 2M)">
              <input value={scriptFields.gmvTotal} onChange={(e) => { setScriptFields({ ...scriptFields, gmvTotal: e.target.value }); setScriptSaved(false); }} style={inputStyle} placeholder="2M" />
            </Field>
            <Field label="Mercado / audiencia">
              <select
                value={scriptFields.market}
                onChange={(e) => { setScriptFields({ ...scriptFields, market: e.target.value }); setScriptSaved(false); }}
                style={inputStyle}
              >
                {MARKET_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </Field>
            <Field label="Tu nombre (para el mensaje)">
              <input value={scriptFields.shortName} onChange={(e) => { setScriptFields({ ...scriptFields, shortName: e.target.value }); setScriptSaved(false); }} style={inputStyle} placeholder="Irving" />
            </Field>
            <Field label="GMV últimos 30 días">
              <input value={scriptFields.gmv30d} onChange={(e) => { setScriptFields({ ...scriptFields, gmv30d: e.target.value }); setScriptSaved(false); }} style={inputStyle} placeholder="100k" />
            </Field>
            <Field label="Tu usuario de TikTok (sin @)">
              <input value={scriptFields.tiktokHandle} onChange={(e) => { setScriptFields({ ...scriptFields, tiktokHandle: e.target.value }); setScriptSaved(false); }} style={inputStyle} placeholder="tuusuario" />
            </Field>
          </div>

          <button
            onClick={doSaveScript}
            disabled={pending}
            className="w-full mt-4 py-2.5 rounded-xl font-semibold text-sm"
            style={{ background: scriptSaved ? "#141B24" : "#22D3C0", color: scriptSaved ? "#8B96A5" : "#06110F", border: scriptSaved ? "1px solid #232D3A" : "none" }}
          >
            {scriptSaved ? "Guardado ✓" : "Guardar escrito"}
          </button>

          <div style={{ fontSize: 11, color: "#8B96A5", marginTop: 20, marginBottom: 8 }}>Vista previa (usa tus precios ya guardados):</div>
          <div
            className="w-full rounded-xl p-3 text-xs whitespace-pre-wrap"
            style={{ background: "#141B24", border: "1px solid #232D3A", color: "#8B96A5", fontFamily: F_MONO, lineHeight: 1.6 }}
          >
            {buildPreviewText(scriptFields, tiers)}
          </div>
        </div>
      )}

      {tab === "precios" && (
        <div className="px-5 pt-4">
          <div className="rounded-xl p-4 mb-4" style={{ background: "#141B24", border: "1px solid #22D3C0" }}>
            <div style={{ fontSize: 12, color: "#8B96A5", marginBottom: 8 }}>
              Precio por video — al actualizar, se rellena toda la tabla de abajo automáticamente (todavía no se guarda, tienes que darle "Guardar precios" después).
            </div>
            <div className="flex gap-2">
              <div className="flex-1 flex items-center rounded-lg px-2.5" style={{ background: "#0B0E14", border: "1px solid #232D3A" }}>
                <span style={{ fontSize: 13, color: "#8B96A5" }}>$</span>
                <input
                  type="number"
                  value={pricePerVideo}
                  onChange={(e) => setPricePerVideo(e.target.value)}
                  placeholder="ej. 450"
                  className="bg-transparent outline-none flex-1 px-1.5 py-2 text-sm"
                  style={{ color: "#EDEFF2", fontFamily: F_MONO }}
                />
                <span style={{ fontSize: 11, color: "#8B96A5" }}>por video</span>
              </div>
              <button
                onClick={applyPriceTable}
                className="px-4 rounded-lg text-sm font-semibold whitespace-nowrap"
                style={{ background: tableUpdated ? "#34D399" : "#22D3C0", color: "#06110F" }}
              >
                {tableUpdated ? "Actualizado ✓" : "Actualizar tabla"}
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: "#8B96A5", marginBottom: 10 }}>Tu ancla, medio y piso, paquete por paquete:</div>
          <div className="flex flex-col gap-2 mb-3">
            {tiers.map((t, i) => (
              <div key={t.videos} className="flex items-center gap-2 flex-wrap">
                <div className="px-2.5 py-1.5 rounded-lg text-xs font-medium" style={{ width: 62, background: "#141B24", border: "1px solid #232D3A", color: "#8B96A5" }}>
                  {t.videos} vid{t.videos === 1 ? "" : "s"}
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontSize: 11, color: "#8B96A5" }}>alto $</span>
                  <input
                    type="number"
                    value={t.anchor}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setTiers((prev) => prev.map((p, idx) => (idx === i ? { ...p, anchor: v } : p)));
                      setTiersSaved(false);
                    }}
                    style={{ width: 68, background: "#0B0E14", border: "1px solid #232D3A", borderRadius: 8, padding: "5px 6px", fontFamily: F_MONO, fontSize: 12, color: "#F2B84B" }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontSize: 11, color: "#8B96A5" }}>medio $</span>
                  <input
                    type="number"
                    value={t.medio ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setTiers((prev) => prev.map((p, idx) => (idx === i ? { ...p, medio: v } : p)));
                      setTiersSaved(false);
                    }}
                    style={{ width: 68, background: "#0B0E14", border: "1px solid #232D3A", borderRadius: 8, padding: "5px 6px", fontFamily: F_MONO, fontSize: 12, color: "#8AB4F8" }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ fontSize: 11, color: "#8B96A5" }}>piso $</span>
                  <input
                    type="number"
                    value={t.floor}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setTiers((prev) => prev.map((p, idx) => (idx === i ? { ...p, floor: v } : p)));
                      setTiersSaved(false);
                    }}
                    style={{ width: 68, background: "#0B0E14", border: "1px solid #232D3A", borderRadius: 8, padding: "5px 6px", fontFamily: F_MONO, fontSize: 12, color: "#34D399" }}
                  />
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={doSavePricing}
            disabled={pending}
            className="w-full py-2.5 rounded-xl font-semibold text-sm"
            style={{ background: tiersSaved ? "#141B24" : "#22D3C0", color: tiersSaved ? "#8B96A5" : "#06110F", border: tiersSaved ? "1px solid #232D3A" : "none" }}
          >
            {tiersSaved ? "Guardado ✓" : "Guardar precios"}
          </button>
        </div>
      )}

      {tab === "cola" && (
        <div className="px-5 pt-4">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center rounded-xl px-3 py-2.5" style={{ background: "#141B24", border: "1px solid #232D3A" }}>
              <input
                value={phoneInput}
                onChange={(e) => { setPhoneInput(e.target.value); if (leadError) setLeadError(""); }}
                onKeyDown={(e) => e.key === "Enter" && doAddLead()}
                placeholder="8613576038204 o +1 555 123 4567 — cualquier formato sirve"
                className="bg-transparent outline-none flex-1 text-sm"
                style={{ color: "#EDEFF2", fontFamily: F_MONO }}
              />
              {phoneInput.replace(/[^0-9]/g, "").length >= 7 && (
                <a
                  href={waLink(normalizePhoneForCountry(phoneInput, addCountry))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 px-2 py-1 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                  style={{ background: "#25D36622", color: "#25D366" }}
                  title="Abrir este número en WhatsApp para mandarle el escrito a mano — luego regresas y le picas Agregar"
                >
                  WhatsApp ↗
                </a>
              )}
            </div>
            <button
              onClick={() => setAddCountry((c) => (c === "other" ? "china" : c === "china" ? "us" : "other"))}
              className="px-3 rounded-xl text-xs font-semibold"
              style={
                addCountry === "us"
                  ? { background: "#22D3C022", color: "#22D3C0", border: "1px solid #22D3C0" }
                  : addCountry === "other"
                  ? { background: "#8B96A522", color: "#8B96A5", border: "1px solid #8B96A5" }
                  : { background: "#F2B84B22", color: "#F2B84B", border: "1px solid #F2B84B" }
              }
              title="Toca para cambiar el país — se agrega el código automático"
            >
              {addCountry === "us" ? "US" : addCountry === "other" ? "Otro" : "CN"}
            </button>
            <button onClick={doAddLead} className="px-4 rounded-xl text-sm font-semibold" style={{ background: "#22D3C0", color: "#06110F" }}>
              Agregar
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 mt-2 px-1">
            <label className="flex items-center gap-2" style={{ fontSize: 11.5, color: "#8B96A5" }}>
              <input
                type="checkbox"
                checked={needsAutoSend}
                onChange={(e) => setNeedsAutoSend(e.target.checked)}
              />
              No le he mandado el escrito — que lo mande el bot automáticamente
            </label>
            {phoneInput.replace(/[^0-9]/g, "").length >= 7 && (
              <button
                onClick={() => {
                  const normalized = normalizePhoneForCountry(phoneInput, addCountry);
                  if (!window.confirm(`¿Ya tienes colaboración con ${normalized}?\n\nSe guarda y el bot NUNCA le va a escribir. No se manda ningún mensaje.`)) return;
                  doMarkCollab(normalized);
                }}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap flex-shrink-0"
                style={{ background: "#34D39922", color: "#34D399", border: "1px solid #34D39955" }}
                title="Guarda este número como colaboración que ya tienes — el bot no le escribe nunca"
              >
                🤝 Ya tengo colab
              </button>
            )}
          </div>
          {leadError && (
            <div className="mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: "#2A1620", color: "#F19999", border: "1px solid #4A2530" }}>
              {leadError}
            </div>
          )}

          {leads.length > 0 && (
            <div className="mt-4 flex gap-1.5 flex-wrap">
              {visibleFilters.map((f) => {
                const count = leadCounts[f.key] || 0;
                const active = leadFilter === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => setLeadFilter(f.key)}
                    className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-full text-[11px] font-semibold"
                    style={
                      active
                        ? { background: f.color, color: "#06110F", border: `1px solid ${f.color}` }
                        : { background: "#141B24", color: f.color, border: `1px solid ${f.color}38` }
                    }
                  >
                    {f.label}
                    <span
                      className="px-1.5 rounded-full text-[10px] font-bold"
                      style={active ? { background: "#06110F22", color: "#06110F" } : { background: `${f.color}1F`, color: f.color }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3">
            {leads.length === 0 && (
              <div className="text-sm text-center py-10" style={{ color: "#8B96A5" }}>
                Sin números en cola todavía.
              </div>
            )}
            {leads.length > 0 && filteredLeads.length === 0 && (
              <div className="text-sm text-center py-10" style={{ color: "#8B96A5" }}>
                No hay contactos en este filtro.
              </div>
            )}
            {filteredLeads.map((lead) => {
              const idx = stageIndex(lead.status);
              const isCross = lead.status === "cruzado";
              const isFailed = lead.status === "fallido";
              const isDormant = lead.status === "dormant";
              const isCheckback = lead.status === "checkback";
              const muted = mutedInfo(lead);
              const isCollab = isCollabLead(lead);
              const fecha = leadDate(lead);
              return (
                <div
                  key={lead.id}
                  className="rounded-xl p-4"
                  style={{
                    background: "#141B24",
                    border: muted
                      ? "1px solid #FF5C5C"
                      : isCollab
                      ? "1px solid #34D39966"
                      : isCheckback
                      ? "1px solid #8AB4F855"
                      : isFailed
                      ? "1px solid #F19999"
                      : isCross
                      ? "1px solid #F2B84B"
                      : lead.paused
                      ? "1px solid #F2B84B"
                      : "1px solid #232D3A",
                    boxShadow: muted ? "0 0 0 1px #FF5C5C33, 0 0 14px #FF5C5C22" : "none",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div style={{ fontFamily: F_MONO, fontSize: 14, fontWeight: 600 }}>{lead.phone}</div>
                      {fecha && (
                        <span
                          className="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                          style={{ background: "#0B0E14", color: "#6B7684", fontFamily: F_MONO, border: "1px solid #1B2430" }}
                          title={`Último movimiento: ${fecha.full}`}
                        >
                          {fecha.short}
                        </span>
                      )}
                      <a
                        href={waLink(lead.phone)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                        style={{ background: "#25D36622", color: "#25D366" }}
                        title="Abrir conversación en WhatsApp"
                      >
                        WhatsApp ↗
                      </a>
                      {lead.conversation?.length > 0 && (
                        <button
                          onClick={() => setExpandedConvo((prev) => (prev === lead.id ? null : lead.id))}
                          className="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                          style={{ background: "#8AB4F822", color: "#8AB4F8" }}
                          title="Ver el chat aquí, sin abrir WhatsApp — así el bot no se pausa"
                        >
                          {expandedConvo === lead.id ? "Ocultar chat" : "Ver chat"}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1.5 flex-wrap justify-end">
                      {isFailed ? (
                        <button
                          onClick={() => doReiniciarFallido(lead)}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium"
                          style={{ background: "#F1999922", color: "#F19999" }}
                          title="Borra este intento fallido y precarga el número arriba para agregarlo de nuevo"
                        >
                          Reiniciar
                        </button>
                      ) : isCross ? (
                        <>
                          <button
                            onClick={() => doRestartLead(lead.id)}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium"
                            style={{ background: "#22D3C022", color: "#22D3C0" }}
                            title="Nunca se cerró nada — reinicia y manda el escrito otra vez"
                          >
                            Reiniciar
                          </button>
                          <button
                            onClick={() => doResolveLead(lead.id)}
                            className="px-2 py-1 rounded-lg text-[10px] font-medium"
                            style={{ background: "#34D39922", color: "#34D399" }}
                            title="Ya hubo un deal — archiva sin reportar al tracker"
                          >
                            Marcar resuelto
                          </button>
                        </>
                      ) : isDormant || isCheckback ? (
                        <button
                          onClick={() => doRestartLead(lead.id)}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium"
                          style={{ background: "#22D3C022", color: "#22D3C0" }}
                          title="Volver a mandarle el escrito desde cero"
                        >
                          Reiniciar
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            const next = !lead.paused;
                            setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, paused: next } : l)));
                            startTransition(() => toggleLeadPause(targetUserId, lead.id, next));
                          }}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium"
                          style={{ background: lead.paused ? "#F2B84B22" : "#1B2430", color: lead.paused ? "#F2B84B" : "#8B96A5" }}
                        >
                          {lead.paused ? "Pausado" : "Pausar"}
                        </button>
                      )}
                      {!isFailed && !isCollab && (
                        <button
                          onClick={() => {
                            if (!window.confirm(`¿Ya tienes colaboración con ${lead.phone}?\n\nEl contacto se cierra y el bot NUNCA le vuelve a escribir. No se reporta nada a tu Retainer Tracker.`)) return;
                            doMarkCollab(lead.phone, lead.id);
                          }}
                          className="px-2 py-1 rounded-lg text-[10px] font-medium"
                          style={{ background: "#34D39922", color: "#34D399" }}
                          title="Ya tengo colaboración — cierra el contacto de un jalón"
                        >
                          🤝 Colab
                        </button>
                      )}
                      {!isFailed && (
                        <button
                          onClick={() => {
                            setLeads((prev) => prev.filter((l) => l.id !== lead.id));
                            startTransition(() => removeLead(targetUserId, lead.id));
                          }}
                          className="px-2 py-1 rounded-lg text-[10px]"
                          style={{ background: "#1B2430", color: "#8B96A5" }}
                        >
                          Borrar
                        </button>
                      )}
                    </div>
                  </div>
                  {isCollab && (
                    <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#34D39915", color: "#34D399", border: "1px solid #34D39944" }}>
                      🤝 Marcaste que ya tienes colaboración con este número — el bot no le escribe. Si te llega otro producto de este mismo contacto, escríbele tú a mano.
                    </div>
                  )}
                  {muted && (
                    <div
                      className="mt-2 px-2.5 py-2 rounded-lg text-[11px]"
                      style={{ background: "#FF5C5C1A", color: "#FF9E9E", border: "1px solid #FF5C5C55" }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        🔇 La marca escribió hace {muted.hours}h y el bot todavía no le contesta.
                      </div>
                      <div style={{ marginTop: 3, lineHeight: 1.5 }}>
                        {muted.windowClosed
                          ? "La ventana de 24h de WhatsApp ya cerró — el bot ya no puede escribirle. Contéstalo tú a mano."
                          : "El sistema lo va a reintentar solo. Si no se destraba, contéstalo a mano antes de que se cumplan 24h."}
                      </div>
                      <div className="flex gap-2 mt-2">
                        <a
                          href={waLink(lead.phone)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-1 rounded-lg text-[10px] font-semibold"
                          style={{ background: "#25D36622", color: "#25D366" }}
                        >
                          Contestar en WhatsApp ↗
                        </a>
                        <button
                          onClick={() => {
                            if (!window.confirm(`¿Tú te encargas de ${lead.phone}?\n\nEl bot se PAUSA para este contacto y deja de contestarle. Cuando quieras que vuelva a trabajarlo, pícale a "Pausado" para reactivarlo.`)) return;
                            setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, paused: true } : l)));
                            startTransition(() => toggleLeadPause(targetUserId, lead.id, true));
                          }}
                          className="px-2 py-1 rounded-lg text-[10px] font-semibold"
                          style={{ background: "#8AB4F822", color: "#8AB4F8" }}
                          title="Pausa el bot en este contacto y quita este aviso"
                        >
                          Yo me encargo
                        </button>
                      </div>
                    </div>
                  )}
                  {isFailed ? (
                    <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#2A1620", color: "#F19999" }}>
                      ❌ {lead.last_error || "La entrega del mensaje falló."}
                    </div>
                  ) : isCross ? (
                    <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#F2B84B15", color: "#F2B84B" }}>
                      ⚠️ Colaboración cruzada — este número ya tiene historial con otro miembro. Revisa el WhatsApp antes de decidir.
                    </div>
                  ) : isCheckback ? (
                    <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#8AB4F815", color: "#8AB4F8" }}>
                      🔁 Seguimiento semanal {Number(lead.negotiation?.checkbackCount || 0)}/4 — dijeron que ahorita no hay nada pero que te avisan. El bot les pregunta cada 7 días.
                    </div>
                  ) : isDormant ? (
                    (() => {
                      // A los 30 días el bot le da UNA segunda vuelta, pero solo a
                      // quien nunca contestó nada. Si la marca llegó a escribir
                      // (aunque haya sido un "no"), ya no se le vuelve a escribir.
                      const contestaron = (lead.conversation || []).some((m) => m.role === "user");
                      const yaTuvoSegunda = !!lead.dormant_followup_sent;
                      const base = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : null;
                      const faltan = base ? Math.max(0, 30 - Math.floor((Date.now() - base) / 86400000)) : null;
                      const revive = !contestaron && !yaTuvoSegunda;
                      return (
                        <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[11px]" style={{ background: "#1B2430", color: revive ? "#8AB4F8" : "#8B96A5" }}>
                          {revive
                            ? `😴 Nunca contestó — el bot le manda el escrito otra vez ${faltan === 0 ? "en el próximo envío" : `en ${faltan} día${faltan === 1 ? "" : "s"}`}. Es su única segunda vuelta.`
                            : contestaron
                            ? "😴 Aquí sí hubo respuesta en su momento — el bot ya no le vuelve a escribir solo."
                            : "😴 Ya tuvo su segunda vuelta a los 30 días — el bot ya no le escribe más."}
                        </div>
                      );
                    })()
                  ) : (
                    <>
                      <div className="mt-3 flex items-center">
                        {STAGES.map((s, i) => (
                          <div key={s.key} className="flex items-center flex-1">
                            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: i <= idx ? (s.key === "cerrado" ? "#34D399" : "#22D3C0") : "#232D3A" }} title={s.label} />
                            {i < STAGES.length - 1 && <div className="flex-1 h-[2px]" style={{ background: i < idx ? "#22D3C0" : "#232D3A" }} />}
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span style={{ fontSize: 11, color: "#8B96A5" }}>
                          {STAGES[idx].label}
                          {lead.status === "followup" && lead.followup_count > 0 ? ` ${lead.followup_count}/4` : ""}
                          {lead.status === "negociando" && lead.negotiation?.waiting
                            ? ` · ⏳ confirmando con la marca${Number(lead.negotiation.waitingNudges || 0) > 0 ? ` (día ${lead.negotiation.waitingNudges}/3)` : ""}`
                            : ""}
                        </span>
                        {idx < STAGES.length - 1 && (
                          <button
                            onClick={() => {
                              const nextKey = STAGES[idx + 1].key;
                              setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status: nextKey } : l)));
                              startTransition(() => updateLeadStatus(targetUserId, lead.id, nextKey));
                            }}
                            className="text-[11px] font-medium"
                            style={{ color: "#22D3C0" }}
                          >
                            Marcar {STAGES[idx + 1].label} →
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {expandedConvo === lead.id && (
                    <div
                      className="mt-3 pt-3 flex flex-col gap-2 max-h-72 overflow-y-auto"
                      style={{ borderTop: "1px solid #232D3A" }}
                    >
                      {(lead.conversation || []).map((m, i) => (
                        <div
                          key={i}
                          className="px-2.5 py-1.5 rounded-lg text-[11.5px] max-w-[85%]"
                          style={
                            m.role === "assistant"
                              ? { background: "#22D3C022", color: "#EDEFF2", alignSelf: "flex-end" }
                              : { background: "#0B0E14", color: "#EDEFF2", alignSelf: "flex-start", border: "1px solid #232D3A" }
                          }
                        >
                          {m.content}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "revision" && (
        <div className="px-5 pt-4">
          <div className="rounded-xl p-4 mb-4" style={{ background: "#141B24", border: "1px solid #22D3C0" }}>
            <div style={{ fontSize: 12, color: "#8B96A5", marginBottom: 10 }}>
              Calendario — toca un día para traer sus contactos. Recarga la página si mandaron contactos nuevos y no los ves.
            </div>
            {calendarLoading ? (
              <div style={{ fontSize: 12, color: "#8B96A5" }}>Cargando calendario...</div>
            ) : calendar.length === 0 ? (
              <div style={{ fontSize: 12, color: "#8B96A5" }}>No hay contactos en los últimos 5 meses.</div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {calendar.map((day) => {
                  const d = new Date(`${day.date}T12:00:00Z`);
                  const label = d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
                  const isImporting = importingDay === day.date;
                  const isResetting = resettingDay === day.date;

                  // Verde = ya se procesaron todos los contactos de ese día.
                  // Rojo  = todavía quedan pendientes por revisar.
                  // Gris  = ese día ni siquiera se ha importado todavía.
                  const st = dayStatuses[day.date];
                  const done = st && st.total > 0 && st.pending === 0;
                  const hasPending = st && st.pending > 0;
                  const accent = done ? "#34D399" : hasPending ? "#F19999" : "#232D3A";
                  const glow = done
                    ? "0 0 0 1px #34D39955, 0 0 10px #34D39933"
                    : hasPending
                    ? "0 0 0 1px #F1999955, 0 0 10px #F1999933"
                    : "none";

                  return (
                    <div
                      key={day.date}
                      className="flex items-stretch rounded-lg overflow-hidden"
                      style={{ border: `1px solid ${accent}`, boxShadow: glow }}
                      title={
                        done
                          ? "Ya trabajaste todos los contactos de este día"
                          : hasPending
                          ? `Faltan ${st.pending} contacto(s) por revisar de este día`
                          : "Este día todavía no se ha importado"
                      }
                    >
                      <button
                        onClick={() => doImportDay(day.date)}
                        disabled={isImporting}
                        className="px-3 py-2 text-xs font-medium flex items-center gap-1.5"
                        style={{ background: "#0B0E14", color: "#EDEFF2" }}
                      >
                        <span style={{ textTransform: "capitalize" }}>{isImporting ? "Cargando..." : label}</span>
                        <span
                          className="px-1.5 rounded-full text-[10px] font-bold"
                          style={
                            done
                              ? { background: "#34D39922", color: "#34D399" }
                              : hasPending
                              ? { background: "#F1999922", color: "#F19999" }
                              : { background: "#22D3C022", color: "#22D3C0" }
                          }
                        >
                          {day.count}
                        </span>
                      </button>
                      <button
                        onClick={() => doResetDay(day.date, label)}
                        disabled={isResetting}
                        title="Resetear los contactos de este día que nunca contestaron"
                        className="px-2.5 flex items-center justify-center text-xs"
                        style={{ background: "#1B2430", color: "#F2B84B", borderLeft: `1px solid ${accent}` }}
                      >
                        {isResetting ? "..." : "↺"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {resetResult && (
              <div className="mt-3 px-3 py-2 rounded-lg text-xs" style={{ background: "#22D3C022", color: "#22D3C0" }}>
                Listo — {resetResult.reset} contacto{resetResult.reset === 1 ? "" : "s"} reseteado{resetResult.reset === 1 ? "" : "s"}
                {resetResult.protected > 0 ? `, ${resetResult.protected} protegido${resetResult.protected === 1 ? "" : "s"} (ya tenían conversación real).` : "."}
              </div>
            )}
          </div>

          {leadRequests.length === 0 && (
            <div className="text-sm text-center py-10" style={{ color: "#8B96A5" }}>
              Nada por revisar todavía — toca un día del calendario de arriba.
            </div>
          )}

          {groupedRequests.map(([dateLabel, reqs]) => (
            <div key={dateLabel} className="mb-6">
              <div
                className="flex items-center gap-2 mb-3 pb-2"
                style={{ borderBottom: "1px solid #1B2430" }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "#8AB4F8", textTransform: "capitalize" }}>
                  {dateLabel}
                </div>
                <div
                  className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                  style={{ background: "#8AB4F822", color: "#8AB4F8" }}
                >
                  {reqs.length}
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {reqs.map((req) => (
                  <RequestCard
                    key={req.id}
                    req={req}
                    onActivate={(sent) => doActivateRequest(req, sent)}
                    onReject={() => doRejectRequest(req.id)}
                    onOngoing={() => doOngoingRequest(req.id)}
                    F_MONO={F_MONO}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle = { background: "#000", border: "1px solid #242119", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "#F5F3EC", width: "100%", outline: "none" };

function Field({ label, children }) {
  return (
    <div className="flex-1">
      <div className="text-[11.5px] mb-1.5" style={{ color: "#8C8574" }}>{label}</div>
      {children}
    </div>
  );
}
