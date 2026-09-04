import {
  addLead,
  appendMessage,
  getLead,
  findLeadByAnyDigits,
  upsertLeadPatch,
  listActiveLeads,
  listDormantForRetry,
  logClosedDeal,
  getScript,
  getPricingTiers,
  getUserEmail,
} from "./state.js";
import { getNextMove } from "./negotiate.js";
import { sendOpeningTemplate, sendFollowupTemplate } from "./sessions.js";

// El cierre automático se dispara a las 18h (no 24h) a propósito: la marca SÍ nos
// escribió durante la negociación, así que la ventana de 24h de WhatsApp está
// abierta — pero solo hasta las 24h exactas. A las 18h todavía estamos dentro y el
// mensaje sale como texto normal, sin necesidad de template. Si se dejara en 24h,
// caería justo en el límite (o fuera) y fallaría con el error [131047].
const HOURS_ACCEPT = Number(process.env.HOURS_BEFORE_ACCEPT_LAST_OFFER || 18);
const SEND_WINDOW_START_HOUR_CT = Number(process.env.SEND_WINDOW_START_HOUR_CT ?? 20);
const SEND_WINDOW_END_HOUR_CT = Number(process.env.SEND_WINDOW_END_HOUR_CT ?? 8);
const DEBOUNCE_MS = Number(process.env.REPLY_DEBOUNCE_SECONDS || 300) * 1000;

// ═══ RED DE SEGURIDAD PARA RESPUESTAS PERDIDAS ═══
// El temporizador que contesta a la marca vive en la MEMORIA del servidor. Si
// Railway se reinicia (deploy, caída, actualización automática) durante esos
// minutos de espera, el temporizador desaparece y ese mensaje se queda SIN
// CONTESTAR PARA SIEMPRE. Estas dos constantes controlan el rescate.
const RESCUE_AFTER_MINUTES = Number(process.env.RESCUE_REPLY_AFTER_MINUTES || 15);
const MAX_RESCUE_TRIES = Number(process.env.MAX_RESCUE_TRIES || 3);

// ═══ "DÉJAME CONFIRMAR CON LA MARCA" ═══
// Muchos de estos contactos son intermediarios: ya que acuerdan un precio, todavía
// tienen que aprobarlo con la marca, y eso tarda de UNO A DOS DÍAS. Antes se les
// preguntaba cada 2 horas, lo cual es encimoso y quema el contacto. Ahora se les
// pregunta una vez al día, máximo 3 días.
const WAITING_NUDGE_HOURS = Number(process.env.WAITING_NUDGE_HOURS || 24);
const MAX_WAITING_NUDGES = Number(process.env.MAX_WAITING_NUDGES || 3);

// ═══ "AHORITA NO HAY NADA, PERO TE AVISO" ═══
// La puerta quedó abierta, así que el contacto NO se muere: se le pregunta cada
// 7 días, máximo 4 veces (un mes). Si en ese mes no sale nada, ahí sí se duerme.
const CHECKBACK_DAYS = Number(process.env.CHECKBACK_DAYS || 7);
const MAX_CHECKBACKS = Number(process.env.MAX_CHECKBACKS || 4);

// ═══ REINTENTO A LOS 30 DÍAS ═══
// A los contactos que nunca contestaron nada se les da UNA segunda vuelta un mes
// después: se les manda el escrito otra vez y arranca el ciclo normal de 4
// follow-ups. Solo una vez por contacto — queda registrado en la columna
// dormant_followup_sent para que nunca se convierta en un ciclo sin fin.
// El tope por barrido evita que, si un día se juntan cientos de dormidos, salgan
// todos de golpe y Meta marque el número como spam.
const DORMANT_RETRY_DAYS = Number(process.env.DORMANT_RETRY_DAYS || 30);
const MAX_DORMANT_RETRIES_PER_SWEEP = Number(process.env.MAX_DORMANT_RETRIES_PER_SWEEP || 3);

// ═══ MODO PRUEBAS — SOLO para la cuenta admin de Irving ═══
// Se identifica por user_id EXACTO (único e irrepetible en Supabase), nunca por
// correo ni por nada que se pueda confundir — así es imposible que otra cuenta
// herede estas reglas por accidente. Para esta cuenta y SOLO esta:
//   - contesta a los 45 segundos (en vez de 5 minutos)
//   - manda a cualquier hora y cualquier día (sin ventana 10pm-7am ni bloqueo Vie/Sáb)
// Todas las demás cuentas siguen el reglamento normal de producción.
const TEST_MODE_USER_IDS = (process.env.TEST_MODE_USER_IDS || "d5c3e03b-5ac0-45d9-9852-b3cc9abe95b3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_DEBOUNCE_MS = Number(process.env.TEST_REPLY_DEBOUNCE_SECONDS || 45) * 1000;

// Si la variable trae "ALL" (o "*"), TODAS las cuentas quedan en modo pruebas:
// sin horario, sin días bloqueados y con timer corto. Para pruebas masivas.
const TEST_MODE_ALL = TEST_MODE_USER_IDS.some((s) => s.toUpperCase() === "ALL" || s === "*");
const isTestUser = (userId) => TEST_MODE_ALL || TEST_MODE_USER_IDS.includes(userId);
const debounceMsFor = (userId) => (isTestUser(userId) ? TEST_DEBOUNCE_MS : DEBOUNCE_MS);

const hoursSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity);
const minutesSince = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 60000 : Infinity);

const pendingReplies = new Map();

function withinSendWindow(userId) {
  // La cuenta de pruebas de Irving no tiene horario ni días bloqueados.
  if (userId && isTestUser(userId)) return true;
  const now = new Date();
  const fmt = (d) =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      weekday: "short",
      timeZone: "America/Chicago",
    }).formatToParts(d);
  const parts = fmt(now);
  const ctHour = Number(parts.find((p) => p.type === "hour").value) % 24;

  // El día NO se evalúa por el calendario sino por la NOCHE a la que pertenece
  // este momento. La madrugada (antes de la hora de cierre) pertenece a la noche
  // que empezó AYER a las 8pm. Ejemplo: viernes 4am de Texas = noche del jueves
  // = viernes de día en China (día laboral) → SÍ se manda.
  const isMadrugada = ctHour < SEND_WINDOW_END_HOUR_CT;
  const dayParts = isMadrugada ? fmt(new Date(now.getTime() - 24 * 3600000)) : parts;
  const nightDay = dayParts.find((p) => p.type === "weekday").value;

  // Noches bloqueadas: la del viernes y la del sábado (hora de Texas), porque
  // caen en sábado y domingo de China. Quedan activas las noches de domingo a
  // jueves = lunes a viernes laborales en China. Ojo: esto NO bloquea las
  // respuestas — si una marca contesta, el bot le sigue contestando normal a
  // cualquier hora (resolveAndSend no pasa por aquí). Esto solo frena los
  // envíos que arranca el bot por su cuenta.
  if (nightDay === "Fri" || nightDay === "Sat") return false;
  if (SEND_WINDOW_START_HOUR_CT === SEND_WINDOW_END_HOUR_CT) return true;
  if (SEND_WINDOW_START_HOUR_CT < SEND_WINDOW_END_HOUR_CT) {
    return ctHour >= SEND_WINDOW_START_HOUR_CT && ctHour < SEND_WINDOW_END_HOUR_CT;
  }
  return ctHour >= SEND_WINDOW_START_HOUR_CT || ctHour < SEND_WINDOW_END_HOUR_CT;
}

/** Arma las 8 variables del template de apertura, en el mismo orden que {{1}} a {{8}}
 * en el template aprobado por Meta, jalando los precios de 1/5/10 videos de la
 * tabla de precios del usuario. */
async function buildOpeningTemplateParams(userId) {
  const script = await getScript(userId);
  const tiers = await getPricingTiers(userId);
  const tier1 = tiers.find((t) => t.videos === 1);
  const tier5 = tiers.find((t) => t.videos === 5);
  const tier10 = tiers.find((t) => t.videos === 10);

  return [
    script.gmvTotal || "0",
    script.market || "Spanish-speaking",
    script.shortName || "",
    String(tier1?.anchor ?? ""),
    String(tier5?.anchor ?? ""),
    String(tier10?.anchor ?? ""),
    script.gmv30d || "0",
    script.tiktokHandle || "",
  ];
}

export async function startProcessForNumber(sock, userId, phoneRaw, { skipMessage1 = false } = {}) {
  console.log(`🆕 startProcessForNumber: agregando ${phoneRaw} (user ${userId}, skipMessage1: ${!!skipMessage1})`);
  const { lead, duplicate } = await addLead(userId, phoneRaw);
  if (duplicate) {
    console.log(`⚠️  ${phoneRaw} ya existía como lead (status: ${lead.status}) — no se manda nada nuevo.`);
    return { duplicate: true, lead };
  }

  if (skipMessage1) {
    console.log(`✍️  skipMessage1 activado para ${phoneRaw} — se deja en "esperando", sin mandar template.`);
    // Se guarda la fecha de AHORA como si fuera el envío, porque Irving acaba de
    // mandar el mensaje a mano. Sin esto, el sistema creería que pasó una eternidad
    // desde el último mensaje y dispararía los 4 follow-ups uno tras otro.
    const updated = await upsertLeadPatch(userId, lead.jid, {
      status: "esperando",
      last_outbound_at: new Date().toISOString(),
    });
    return { duplicate: false, lead: updated, waitingForWindow: false, manual: true };
  }

  if (!withinSendWindow(userId)) {
    console.log(`🌙 Fuera de la ventana de envío ahorita mismo — ${phoneRaw} queda en "nuevo", se manda en el próximo sweep.`);
    return { duplicate: false, lead, waitingForWindow: true };
  }

  const params = await buildOpeningTemplateParams(userId);
  console.log(`📋 Params del template para ${phoneRaw}: ${JSON.stringify(params)}`);
  await sendOpeningTemplate(userId, lead.jid, params);
  console.log(`✅ Template mandado sin error para ${phoneRaw} (jid: ${lead.jid})`);
  await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
  const updated = await upsertLeadPatch(userId, lead.jid, {
    status: "escrito_enviado",
    last_outbound_at: new Date().toISOString(),
  });
  return { duplicate: false, lead: updated, waitingForWindow: false };
}

async function resolveAndSend(sock, userId, jid) {
  const lead = await getLead(userId, jid);
  if (!lead || lead.status === "cerrado" || lead.paused) {
    console.log(`⚠️  resolveAndSend: no se contesta a ${jid} (status: ${lead?.status}, paused: ${lead?.paused})`);
    return;
  }

  console.log(`🤖 Llamando a la IA para generar la respuesta a ${jid}...`);
  const tiers = await getPricingTiers(userId);
  const { replyText, noAction, closed, dormant, checkBack, closedPrice, closedVideos, negotiation } = await getNextMove(
    lead.conversation,
    tiers,
    lead.negotiation || null
  );
  console.log(`🤖 Respuesta final: "${replyText}" (closed: ${closed}, dormant: ${dormant}, checkBack: ${!!checkBack})`);

  if (noAction || !replyText) {
    console.warn(`⏹️  ${jid}: no hay nada que contestar — no se manda ni se cierra nada.`);
    await upsertLeadPatch(userId, jid, { negotiation });
    return;
  }

  // Se manda PRIMERO. Si falla, no se marca nada como cerrado — así nunca queda
  // un trato "cerrado" en el sistema que la marca nunca recibió.
  await sock.sendMessage(jid, { text: replyText });
  console.log(`📤 Mensaje enviado a ${jid}`);
  await appendMessage(userId, jid, "assistant", replyText);

  // El mensaje SÍ salió, así que el contador de rescates se pone en cero: este
  // lead ya está sano otra vez.
  const negOk = { ...(negotiation || {}), rescueTries: 0, rescueGaveUp: false, autoCloseGaveUp: false };

  if (closed) {
    await upsertLeadPatch(userId, jid, { status: "cerrado", negotiation: negOk, last_outbound_at: new Date().toISOString() });
    await logClosedDeal(userId, { jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
    await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
  } else if (dormant) {
    await upsertLeadPatch(userId, jid, { status: "dormant", negotiation: negOk, last_outbound_at: new Date().toISOString() });
  } else if (checkBack) {
    // Puerta abierta: no se muere. Sale de la negociación activa y entra a la
    // rutina de preguntar cada 7 días.
    await upsertLeadPatch(userId, jid, {
      status: "checkback",
      negotiation: { ...negOk, checkbackCount: 0, waiting: false, waitingNudges: 0 },
      last_outbound_at: new Date().toISOString(),
    });
    console.log(`🔁 ${jid} pasa a seguimiento semanal (checkback).`);
  } else {
    await upsertLeadPatch(userId, jid, { status: "negociando", negotiation: negOk, last_outbound_at: new Date().toISOString() });
  }
}

/** Called on every inbound WhatsApp message. If the exact jid doesn't match any lead
 * (common with Mexico numbers, where WhatsApp sometimes adds/drops the extra "1" after
 * the 52 country code), falls back to matching by the last 8 digits of the phone. */
export async function handleInboundMessage(sock, userId, jid, text) {
  console.log(`🔍 handleInboundMessage: buscando lead para ${jid} (user ${userId})`);
  let lead = await getLead(userId, jid);
  let resolvedJid = jid;

  if (!lead) {
    const matched = await findLeadByAnyDigits(userId, [jid]);
    if (matched) {
      console.log(`🔀 Sin match exacto para ${jid} — encontrado por número (últimos dígitos) → usando jid guardado: ${matched.jid}`);
      lead = matched;
      resolvedJid = matched.jid;
    }
  }

  if (!lead || lead.status === "cerrado") {
    console.log(`⚠️  No hay lead activo para ${jid} (encontrado: ${!!lead}, status: ${lead?.status}) — ignorando`);
    return;
  }

  await appendMessage(userId, resolvedJid, "user", text);
  await upsertLeadPatch(userId, resolvedJid, { last_inbound_at: new Date().toISOString() });

  if (lead.paused) {
    console.log(`⏸️  Lead ${resolvedJid} está pausado — no se contesta`);
    return;
  }

  const key = `${userId}:${resolvedJid}`;
  if (pendingReplies.has(key)) {
    console.log(`🔁 Ya había un timer para ${resolvedJid}, se reinicia`);
    clearTimeout(pendingReplies.get(key));
  }
  const debounceMs = debounceMsFor(userId);
  console.log(`⏳ Timer de ${debounceMs / 1000}s iniciado para ${resolvedJid}${isTestUser(userId) ? " (cuenta de pruebas)" : ""}`);
  const timer = setTimeout(() => {
    pendingReplies.delete(key);
    console.log(`⏰ Timer cumplido para ${resolvedJid} — generando respuesta ahora`);
    resolveAndSend(sock, userId, resolvedJid).catch((err) => console.error(`❌ Error respondiendo a ${resolvedJid} (user ${userId}):`, err));
  }, debounceMs);
  pendingReplies.set(key, timer);
}

async function reportClosedDealToTracker(userId, deal) {
  const url = process.env.CLOSED_DEAL_WEBHOOK_URL;
  const secret = process.env.CLOSED_DEAL_WEBHOOK_SECRET;
  if (!url) return;
  try {
    const email = await getUserEmail(userId);
    if (!email) {
      console.error(`No se encontró el email del usuario ${userId} — no se pudo reportar el deal cerrado.`);
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret || "" },
      body: JSON.stringify({ ...deal, email }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`El Retainer Tracker respondió ${res.status} al reportar el deal: ${text}`);
    } else {
      console.log(`✅ Deal cerrado reportado al Retainer Tracker para ${email}`);
    }
  } catch (err) {
    console.error("No se pudo mandar el deal cerrado al Retainer Tracker:", err.message);
  }
}

/**
 * Reintento de los 30 días.
 *
 * SEGURIDAD — solo despierta a quien NUNCA contestó nada. A "dormant" también
 * llegan los que dijeron "no me interesa" o "ya me atiende otra persona", y a
 * esos NO se les vuelve a escribir jamás: se les marca dormant_followup_sent
 * para que no se vuelvan a evaluar y ahí se quedan.
 */
async function retryDormantLeads(userId, coldSendsAllowed) {
  if (!coldSendsAllowed) return;

  let dormidos = [];
  try {
    dormidos = await listDormantForRetry(userId);
  } catch (err) {
    console.error(`❌ No se pudo leer la lista de dormidos: ${err.message}`);
    return;
  }
  if (!dormidos.length) return;

  let enviados = 0;
  for (const lead of dormidos) {
    if (enviados >= MAX_DORMANT_RETRIES_PER_SWEEP) {
      console.log(`⏸️  Tope de ${MAX_DORMANT_RETRIES_PER_SWEEP} reintentos por barrido alcanzado — los demás dormidos siguen en la fila.`);
      break;
    }
    try {
      if (hoursSince(lead.last_outbound_at) < DORMANT_RETRY_DAYS * 24) continue; // todavía no cumple el mes

      const contestaron = Array.isArray(lead.conversation) && lead.conversation.some((m) => m.role === "user");
      if (contestaron) {
        await upsertLeadPatch(userId, lead.jid, { dormant_followup_sent: true });
        console.log(`🚫 ${lead.jid} sí llegó a contestar en su momento — NO se reintenta. Se queda dormido para siempre.`);
        continue;
      }

      const params = await buildOpeningTemplateParams(userId);
      await sendOpeningTemplate(userId, lead.jid, params);
      await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
      await upsertLeadPatch(userId, lead.jid, {
        status: "escrito_enviado",
        followup_count: 0,
        dormant_followup_sent: true,
        negotiation: null,
        last_error: null,
        last_outbound_at: new Date().toISOString(),
      });
      enviados += 1;
      console.log(`🌅 REINTENTO 30 DÍAS: ${lead.jid} despertó — se le mandó el escrito otra vez y arranca su ciclo de follow-ups. Es su única segunda vuelta.`);
    } catch (err) {
      // Se marca igual para que un número muerto no se reintente en cada barrido.
      console.error(`❌ No se pudo despertar a ${lead.jid}: ${err.message} — se marca para no reintentarlo.`);
      try {
        await upsertLeadPatch(userId, lead.jid, { dormant_followup_sent: true, last_error: err.message });
      } catch { /* ya quedó en los logs */ }
    }
  }
}

export async function sweepTimers(sock, userId) {
  // El horario de envío (8pm–8am CT, dom–jue) aplica SOLO a lo que el bot inicia
  // en frío: mensaje 1 y follow-ups. Las piezas urgentes de conversaciones VIVAS
  // (el cierre a 18h y los nudges de "any updates?" mientras su equipo revisa) NO
  // esperan al horario: si la marca escribió a la 1pm hora de Texas, es porque
  // opera en horario de EE.UU. — su ventana de 24h corre, y esperar hasta las 8pm
  // puede matar el cierre. Cada bloque abajo decide si respeta la ventana o no.
  const coldSendsAllowed = withinSendWindow(userId);

  const active = await listActiveLeads(userId);

  // Este renglón es el que faltaba para dejar de adivinar: dice cuántos contactos
  // hay, en qué etapa están, y si el horario permite enviar en frío ahorita.
  const porEtapa = {};
  for (const l of active) porEtapa[l.status] = (porEtapa[l.status] || 0) + 1;
  const resumen = Object.entries(porEtapa).map(([k, v]) => `${k}:${v}`).join(" ") || "ninguno";
  console.log(
    `🧹 Cuenta ${userId}: ${active.length} contacto(s) activo(s) [${resumen}] — envíos en frío ${coldSendsAllowed ? "PERMITIDOS" : "BLOQUEADOS (fuera del horario 8pm-8am, o noche de viernes/sábado)"}.`
  );

  for (const lead of active) {
   // CADA CONTACTO VA AISLADO. Antes, si a UNO le tronaba el envío (número
   // inválido, Meta lo rechaza, se cae la red), el error reventaba el ciclo
   // completo y TODOS los contactos que venían después se saltaban sin aviso.
   // Si el número malo estaba al principio, los demás no se procesaban NUNCA.
   try {
    if (lead.status === "nuevo") {
      if (!coldSendsAllowed) continue;
      try {
        const params = await buildOpeningTemplateParams(userId);
        await sendOpeningTemplate(userId, lead.jid, params);
        await appendMessage(userId, lead.jid, "assistant", "[Opening template message sent]");
        await upsertLeadPatch(userId, lead.jid, { status: "escrito_enviado", last_outbound_at: new Date().toISOString() });
      } catch (err) {
        // No se pudo entregar el mensaje 1. Se marca como fallido con el motivo
        // en vez de dejarlo en "nuevo" reintentando en cada barrido para siempre.
        // Sale en rojo en la Cola, con su botón de Reiniciar.
        console.error(`❌ No se pudo mandar el mensaje 1 a ${lead.jid}: ${err.message} — se marca como fallido.`);
        await upsertLeadPatch(userId, lead.jid, { status: "fallido", last_error: err.message });
      }
      continue;
    }

    // ══════════ RED DE SEGURIDAD — RESPUESTAS QUE SE QUEDARON MUDAS ══════════
    // Antes, esta parte era una sola línea: "si la marca escribió al último, sáltalo".
    // El problema es que el ÚNICO que contesta a la marca es un temporizador que
    // vive en la memoria del servidor. Si Railway se reinicia durante esos minutos
    // de espera, el temporizador se pierde... y como este barrido se saltaba el
    // lead, nadie volvía a mirarlo NUNCA. El lead quedaba muerto en silencio, sin
    // aviso de ningún tipo. Eso es lo que se arregla aquí.
    const theyWroteLast =
      lead.last_inbound_at && (!lead.last_outbound_at || new Date(lead.last_inbound_at) > new Date(lead.last_outbound_at));

    if (theyWroteLast) {
      const waitingMin = minutesSince(lead.last_inbound_at);
      const timerAlive = pendingReplies.has(`${userId}:${lead.jid}`);

      // Caso normal: el temporizador sigue vivo, o todavía no pasa el tiempo de
      // espera. No hay nada que rescatar — se deja trabajar en paz.
      if (timerAlive || waitingMin < RESCUE_AFTER_MINUTES) continue;

      const neg = lead.negotiation || {};
      const tries = Number(neg.rescueTries || 0);
      const horas = hoursSince(lead.last_inbound_at);

      // Se acaba el rescate por cualquiera de dos razones:
      //   - se cerró la ventana de 24h de WhatsApp (ya no se puede mandar texto libre)
      //   - o se gastaron los intentos permitidos
      // En AMBOS casos hay que dejar constancia. Antes solo se marcaba el primer
      // caso: si los intentos se acababan primero, el contacto se quedaba mudo en
      // "negociando" para siempre, sin aviso, sin motivo guardado y sin log.
      const ventanaCerrada = horas >= 23.5;
      const sinIntentos = tries >= MAX_RESCUE_TRIES;

      if (ventanaCerrada || sinIntentos) {
        if (!neg.rescueGaveUp) {
          console.error(
            `🔇 ${lead.jid}: la marca escribió hace ${Math.round(horas)}h y el bot no logró contestarle (${ventanaCerrada ? "la ventana de 24h ya cerró" : `falló ${tries} intentos`}) — REVÍSALO A MANO.`
          );
          await upsertLeadPatch(userId, lead.jid, {
            negotiation: { ...neg, rescueGaveUp: true },
            last_error: ventanaCerrada
              ? "El bot no alcanzó a contestar este mensaje y la ventana de 24h ya cerró. Contéstalo a mano."
              : "El bot intentó contestar este mensaje varias veces y no pudo. Contéstalo a mano.",
          });
        }
        continue;
      }

      console.warn(
        `🛟 RESCATE: ${lead.jid} lleva ${Math.round(waitingMin)} min esperando respuesta y su temporizador ya no existe — se contesta ahora (intento ${tries + 1}/${MAX_RESCUE_TRIES}).`
      );
      // El contador se sube ANTES de intentar, para que si algo truena a media
      // operación el sistema no se quede reintentando lo mismo para siempre.
      await upsertLeadPatch(userId, lead.jid, { negotiation: { ...neg, rescueTries: tries + 1 } });
      try {
        await resolveAndSend(sock, userId, lead.jid);
      } catch (err) {
        console.error(`❌ El rescate de ${lead.jid} falló: ${err.message}`);
      }
      continue;
    }

    // ══ SEGUIMIENTO SEMANAL — "ahorita no hay nada, pero te aviso" ══
    // Estos contactos NO están muertos: dejaron la puerta abierta. Se les pregunta
    // una vez por semana, máximo 4 veces (un mes). A los 7 días la ventana de 24h
    // de WhatsApp ya cerró, así que va por template aprobado, que es lo único que
    // Meta permite fuera de la ventana.
    if (lead.status === "checkback") {
      if (!coldSendsAllowed) continue; // respeta horario y días como cualquier envío en frío

      const neg = lead.negotiation || {};
      const done = Number(neg.checkbackCount || 0);

      if (done >= MAX_CHECKBACKS) {
        console.log(`😴 ${lead.jid} ya recibió ${MAX_CHECKBACKS} seguimientos semanales sin que saliera nada — se duerme.`);
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
        continue;
      }

      if (hoursSince(lead.last_outbound_at) < CHECKBACK_DAYS * 24) continue; // todavía no toca

      try {
        await sendFollowupTemplate(userId, lead.jid);
        await appendMessage(userId, lead.jid, "assistant", "Hey, any updates?");
        await upsertLeadPatch(userId, lead.jid, {
          negotiation: { ...neg, checkbackCount: done + 1 },
          last_outbound_at: new Date().toISOString(),
        });
        console.log(`🔁 Seguimiento semanal ${done + 1}/${MAX_CHECKBACKS} mandado a ${lead.jid}.`);
      } catch (err) {
        // El intento se cuenta aunque haya fallado, para no reintentar sin parar.
        console.error(`❌ No se pudo mandar el seguimiento semanal a ${lead.jid}: ${err.message} — el intento se cuenta igual.`);
        await upsertLeadPatch(userId, lead.jid, {
          negotiation: { ...neg, checkbackCount: done + 1 },
          last_outbound_at: new Date().toISOString(),
          last_error: err.message,
        });
      }
      continue;
    }

    // Ya no se manda el "message2" — después del mensaje 1, a las 24h arrancan
    // directo los follow-ups de "Hey, any updates?" (máximo 4).
    // El follow-up espera 25 horas (no 24) A PROPÓSITO: así cada mensaje cae una
    // hora MÁS TARDE que el anterior. Si el mensaje 1 salió a las 8pm, el follow-up
    // 1 cae a las 9pm del día siguiente, el 2 a las 10pm, el 3 a las 11pm, el 4 a
    // las 12am — se va recorriendo el horario para atinarle a la hora en que la
    // marca sí está viendo el teléfono, en vez de llegar siempre a la misma hora.
    if (
      coldSendsAllowed &&
      (lead.status === "escrito_enviado" || lead.status === "esperando" || lead.status === "followup") &&
      hoursSince(lead.last_outbound_at) >= 25
    ) {
      // Contactos viejos que quedaron sin fecha guardada: se les pone la de ahora y
      // se dejan para el próximo día. Sin esto, "sin fecha" cuenta como infinito y
      // les dispararía los 4 follow-ups seguidos en un par de horas.
      if (!lead.last_outbound_at) {
        console.log(`🕒 ${lead.jid} no tenía fecha de último envío — se le pone la de ahora y su follow-up arranca mañana.`);
        await upsertLeadPatch(userId, lead.jid, { last_outbound_at: new Date().toISOString() });
        continue;
      }

      const sent = Number(lead.followup_count || 0);

      // Tope de 4 follow-ups (4 días). Después se deja en paz: pasa a "dormant",
      // desaparece de la cola de contactos (listActiveLeads ya los excluye) y
      // entra a la regla de reintento a los 30 días.
      if (sent >= 4) {
        console.log(`😴 ${lead.jid} ya recibió 4 follow-ups sin contestar — se marca dormant y sale de la cola.`);
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
        continue;
      }

      const followupText = "Hey, any updates?";
      try {
        await sendFollowupTemplate(userId, lead.jid);
        await appendMessage(userId, lead.jid, "assistant", followupText);
        await upsertLeadPatch(userId, lead.jid, {
          status: "followup",
          followup_count: sent + 1,
          last_outbound_at: new Date().toISOString(),
        });
        console.log(`🔔 Follow-up ${sent + 1}/4 mandado a ${lead.jid}`);
      } catch (err) {
        // El intento se cuenta AUNQUE haya fallado. Sin esto, un número muerto se
        // reintentaría en cada barrido para siempre, quemando llamadas a Meta.
        console.error(`❌ No se pudo mandar el follow-up ${sent + 1}/4 a ${lead.jid}: ${err.message} — el intento se cuenta igual.`);
        await upsertLeadPatch(userId, lead.jid, {
          status: "followup",
          followup_count: sent + 1,
          last_outbound_at: new Date().toISOString(),
          last_error: err.message,
        });
      }
      continue;
    }

    // Pasaron 24h sin respuesta en una negociación activa: se acepta su última
    // oferta y se cierra. forceAccept lo maneja directo el decisor de negotiate.js.
    // "Esperando al equipo": ellos dijeron "déjame checar / te aviso". Cada 2 horas
    // se les pregunta "Hey, any updates?" (texto libre, dentro de su ventana de 24h),
    // máximo 4 veces. Si su ventana ya está por cerrar, se deja de intentar.
    if (lead.status === "negociando" && lead.negotiation?.waiting === true) {
      const nudges = Number(lead.negotiation.waitingNudges || 0);

      // Se agotaron los días de espera y nunca contestaron: se deja descansar en
      // vez de quedarse atorado para siempre en "negociando".
      if (nudges >= MAX_WAITING_NUDGES) {
        console.log(`😴 ${lead.jid} nunca volvió después de ${MAX_WAITING_NUDGES} días esperando su confirmación — se duerme.`);
        await upsertLeadPatch(userId, lead.jid, { status: "dormant", last_outbound_at: new Date().toISOString() });
        continue;
      }

      if (hoursSince(lead.last_outbound_at) >= WAITING_NUDGE_HOURS) {
        const nudgeText = "Hey, any updates?";
        // Dentro de su ventana de 24h se puede mandar texto libre; fuera de ella
        // Meta solo deja templates aprobados, y ahí sí aplica el horario de envío.
        const insideWindow = hoursSince(lead.last_inbound_at) < 23;
        if (!insideWindow && !coldSendsAllowed) continue;
        try {
          if (insideWindow) {
            await sock.sendMessage(lead.jid, { text: nudgeText });
          } else {
            await sendFollowupTemplate(userId, lead.jid);
          }
          await appendMessage(userId, lead.jid, "assistant", nudgeText);
          await upsertLeadPatch(userId, lead.jid, {
            negotiation: { ...lead.negotiation, waitingNudges: nudges + 1 },
            last_outbound_at: new Date().toISOString(),
          });
          console.log(`⏲️  Día ${nudges + 1}/${MAX_WAITING_NUDGES} preguntando "any updates?" a ${lead.jid} — está confirmando con la marca${insideWindow ? "" : " (por template)"}.`);
        } catch (err) {
          // El intento se cuenta aunque haya fallado, para no reintentar sin parar.
          console.error(`❌ No se pudo mandar el recordatorio a ${lead.jid}: ${err.message} — el intento se cuenta igual.`);
          await upsertLeadPatch(userId, lead.jid, {
            negotiation: { ...lead.negotiation, waitingNudges: nudges + 1 },
            last_outbound_at: new Date().toISOString(),
            last_error: err.message,
          });
        }
      }
      continue; // mientras confirman con la marca, NO aplica el cierre automático de 18h
    }

    if (lead.status === "negociando" && hoursSince(lead.last_outbound_at) >= HOURS_ACCEPT) {
      // Si ya se intentó el cierre automático y resultó que no había ninguna oferta
      // real que aceptar, NO se le vuelve a preguntar a la IA en cada barrido: la
      // conversación no cambió, la respuesta sería la misma, y cada intento cuesta
      // dinero (una llamada a Opus + una a Sonnet). La marca se limpia sola en
      // cuanto la marca vuelva a escribir y el bot le conteste.
      if (lead.negotiation?.autoCloseGaveUp) continue;

      // La ventana de 24h de WhatsApp se cuenta desde el ÚLTIMO mensaje que ELLOS
      // mandaron. Si ya se pasó, el texto libre va a fallar sí o sí ([131047]), así
      // que ni se intenta — se deja el lead para revisarlo a mano.
      const hoursSinceTheirReply = hoursSince(lead.last_inbound_at);
      if (hoursSinceTheirReply >= 23.5) {
        // Aquí ya no hay nada que el bot pueda hacer: la marca no volvió y Meta ya
        // no deja mandar texto libre. Antes esto se quedaba así PARA SIEMPRE,
        // repitiendo este mismo aviso en cada barrido y apareciendo en el panel
        // como si la negociación siguiera viva. Ahora se manda a dormir de una vez.
        console.warn(
          `⏰ ${lead.jid}: la marca no volvió y la ventana de 24h cerró (${Math.round(hoursSinceTheirReply)}h) — se manda a dormir.`
        );
        await upsertLeadPatch(userId, lead.jid, {
          status: "dormant",
          last_error: "La marca dejó de contestar y la ventana de 24h de WhatsApp cerró.",
        });
        continue;
      }

      const tiers = await getPricingTiers(userId);
      const { replyText, noAction, closed, closedPrice, closedVideos, negotiation } = await getNextMove(
        lead.conversation,
        tiers,
        lead.negotiation || null,
        { forceAccept: true }
      );

      // No había ninguna oferta real de la marca guardada — no se inventa nada.
      // Se deja el lead tal cual para revisarlo a mano.
      if (noAction || !replyText) {
        console.warn(`⏹️  ${lead.jid}: no se cerró nada automáticamente (no hay oferta real de la marca). Revísalo a mano — no se vuelve a intentar solo.`);
        await upsertLeadPatch(userId, lead.jid, {
          negotiation: { ...(negotiation || {}), autoCloseGaveUp: true },
          last_error: "No hay una oferta real de la marca que se pueda aceptar. Revísalo a mano.",
        });
        continue;
      }

      // El mensaje se manda PRIMERO. Solo si de verdad salió se marca como cerrado —
      // así nunca queda un trato "cerrado" en el sistema que la marca nunca recibió.
      try {
        await sock.sendMessage(lead.jid, { text: replyText });
      } catch (err) {
        console.error(`❌ ${lead.jid}: no se pudo mandar el cierre automático (${err.message}). NO se marca como cerrado.`);
        await upsertLeadPatch(userId, lead.jid, { negotiation, last_error: err.message });
        continue;
      }

      await appendMessage(userId, lead.jid, "assistant", replyText);
      if (closed) {
        await upsertLeadPatch(userId, lead.jid, { status: "cerrado", negotiation, last_outbound_at: new Date().toISOString() });
        await logClosedDeal(userId, { jid: lead.jid, phone: lead.phone, price: closedPrice, videos: closedVideos });
        await reportClosedDealToTracker(userId, { phone: lead.phone, price: closedPrice, videos: closedVideos, timezone: lead.timezone });
        console.log(`🤝 Cierre automático a las 24h: ${lead.jid} — $${closedPrice} por ${closedVideos} videos`);
      } else {
        await upsertLeadPatch(userId, lead.jid, { negotiation, last_outbound_at: new Date().toISOString() });
      }
    }
   } catch (err) {
      console.error(`❌ Falló el barrido de ${lead.jid}: ${err.message} — se sigue con los demás contactos.`);
      try {
        await upsertLeadPatch(userId, lead.jid, { last_error: `Error del sistema: ${err.message}` });
      } catch { /* si ni eso se puede guardar, al menos ya quedó en los logs */ }
   }
  }

  // Los dormidos van aparte porque listActiveLeads no los incluye a propósito.
  await retryDormantLeads(userId, coldSendsAllowed);
}
