import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";

/* ══════════════════════════════════════════════════════════════
   PARTE 1 — LA ESCALERA DE PRECIOS (matemática pura, SIN IA)
   El precio NUNCA lo decide la IA. Se calcula aquí, de la tabla
   del miembro. Así no importa cómo escriban los números las marcas.
   ══════════════════════════════════════════════════════════════ */

const roundDown50 = (n) => Math.floor(Number(n) / 50) * 50;

function normalizeTier(t) {
  const anchor = Number(t.anchor);
  const floor = Number(t.floor);
  const medio = t.medio != null ? Number(t.medio) : Math.round((anchor + floor) / 2);
  return { videos: Number(t.videos), anchor, medio, floor };
}

/** Busca el tier exacto del paquete. Si piden un tamaño que no está en la tabla
 * (ej. 12 videos), lo interpola proporcionalmente del tier más cercano. */
function tierFor(tiers, videos) {
  if (!videos || !tiers?.length) return null;
  const exact = tiers.find((t) => Number(t.videos) === Number(videos));
  if (exact) return normalizeTier(exact);

  let closest = tiers[0];
  for (const t of tiers) {
    if (Math.abs(Number(t.videos) - videos) < Math.abs(Number(closest.videos) - videos)) closest = t;
  }
  const n = normalizeTier(closest);
  const factor = Number(videos) / n.videos;
  return {
    videos: Number(videos),
    anchor: roundDown50(n.anchor * factor),
    medio: roundDown50(n.medio * factor),
    floor: roundDown50(n.floor * factor),
  };
}

/** Construye los escalones de la negociación para un paquete.
 * Ejemplo con alto 1600 / medio 1450 / piso 1250:
 *   [1600, 1500, 1450, 1350, 1250]
 * El bot baja un escalón por ronda, y se PLANTA en el medio 2 rondas. */
function buildLadder(tier) {
  const { anchor, medio, floor } = tier;
  const rungs = [anchor];

  const upper = roundDown50((anchor + medio) / 2);
  if (upper < anchor && upper > medio) rungs.push(upper);

  if (medio < anchor) rungs.push(medio);

  const lower = roundDown50((medio + floor) / 2);
  if (lower < medio && lower > floor) rungs.push(lower);

  if (floor < medio) rungs.push(floor);

  return rungs;
}

function emptyState() {
  return {
    videos: null,
    rungIndex: -1,
    lastOffer: null,
    midRounds: 0,
    floorRounds: 0,
    theirLast: null,
    theirBest: null,
    repeatCount: 0,
    finalityClaims: 0,
    proposedClose: null,
  };
}

/* ══════════════════════════════════════════════════════════════
   PARTE 2 — LECTOR: la IA SOLO interpreta lo que dijo la marca.
   No propone precios, no escribe respuestas. Solo reporta hechos.
   ══════════════════════════════════════════════════════════════ */

const READER_SYSTEM = `You read a WhatsApp negotiation between a content creator and a brand, and extract structured facts about the BRAND's latest message. You never write a reply.

Return ONLY a JSON object — no preamble, no markdown fences, no explanation — with exactly these keys:
{
  "videos": number or null,
  "theirOffer": number or null,
  "theyMetOurPrice": true or false,
  "claimsFinal": true or false,
  "noBudget": true or false,
  "askedOrigin": true or false,
  "askedAboutPerson": string or null,
  "askedRatesGenerally": true or false,
  "confirmedDeal": true or false
}

How to fill each key:
- "videos": the package size (how many videos) currently being discussed. Read the WHOLE thread, not only the last message — if it was agreed earlier and never changed, report it. null only if a package size was truly never mentioned.
- "theirOffer": the total price the BRAND is offering right now, as a plain number (no symbols, no commas). CRITICAL: prices are very often written with NO dollar sign. Read them in any format: "$1500", "1500", "1,500", "1500usd", "fifteen hundred", "1.5k", "1500 for 5 videos". If their latest message names no price at all, use null. NEVER report the creator's own number here — only what the brand offers.
- "theyMetOurPrice": true only if their latest message agrees to the exact price the creator last stated.
- "claimsFinal": true if they frame their number as a maximum/final/best/hard cap, OR use pressure framing like "I fought for you with my team", "my boss approved only this", "this is all we have left in budget".
- "noBudget": true only if they say they have no budget or no campaign at all right now, but may reach out later.
- "askedOrigin": true if they ask how you got their number, who you are, or where the contact came from.
- "askedAboutPerson": if they ask whether you know a specific named person, put that person's name. Otherwise null.
- "askedRatesGenerally": true if they ask about rates/pricing WITHOUT naming a package size.
- "confirmedDeal": true only if they clearly say yes to a specific price AND video count that the creator just stated.

IMPORTANT: if they mention a commission or affiliate percentage (e.g. "20% commission", "plus 30% commission"), IGNORE it completely. A percentage is NEVER a price — never put it in "theirOffer".

Output ONLY the JSON object.`;

async function readBrandMessage(conversation) {
  const messages = conversation.map((m) => ({ role: m.role, content: m.content }));
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: READER_SYSTEM,
    messages: [
      ...messages,
      { role: "user", content: "[Extract the JSON facts about the brand's latest message now. Output only JSON.]" },
    ],
  });

  const raw = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      videos: parsed.videos != null ? Number(parsed.videos) : null,
      theirOffer: parsed.theirOffer != null ? Number(parsed.theirOffer) : null,
      theyMetOurPrice: !!parsed.theyMetOurPrice,
      claimsFinal: !!parsed.claimsFinal,
      noBudget: !!parsed.noBudget,
      askedOrigin: !!parsed.askedOrigin,
      askedAboutPerson: parsed.askedAboutPerson || null,
      askedRatesGenerally: !!parsed.askedRatesGenerally,
      confirmedDeal: !!parsed.confirmedDeal,
    };
  } catch {
    console.warn("⚠️  El lector no devolvió JSON válido, se usa lectura vacía:", raw.slice(0, 200));
    return {
      videos: null, theirOffer: null, theyMetOurPrice: false, claimsFinal: false,
      noBudget: false, askedOrigin: false, askedAboutPerson: null,
      askedRatesGenerally: false, confirmedDeal: false,
    };
  }
}

/* ══════════════════════════════════════════════════════════════
   PARTE 3 — DECISOR: código puro. Aquí se decide el número exacto.
   ══════════════════════════════════════════════════════════════ */

function pickHeadlineTiers(tiers) {
  const pick = (n) => {
    const t = tiers.find((x) => Number(x.videos) === n);
    return t ? normalizeTier(t).anchor : null;
  };
  return { one: pick(1), five: pick(5), ten: pick(10) };
}

function decide(prevState, r, tiers, { forceAccept = false } = {}) {
  const state = { ...emptyState(), ...(prevState || {}) };

  // Cuánto han ofrecido ellos, y si están repitiendo el mismo número
  const their = r.theirOffer != null && !Number.isNaN(r.theirOffer) ? Number(r.theirOffer) : null;
  let repeatCount = state.repeatCount;
  if (their != null) {
    repeatCount = state.theirLast != null && their === state.theirLast ? repeatCount + 1 : 1;
  }
  const theirBest = Math.max(their ?? 0, state.theirBest ?? 0) || null;
  const finalityClaims = state.finalityClaims + (r.claimsFinal ? 1 : 0);

  const base = { theirLast: their ?? state.theirLast, theirBest, repeatCount, finalityClaims };

  // Sin presupuesto → dormant, no se negocia más
  if (r.noBudget) return { action: "dormant", state: { ...state, ...base } };

  // ¿Qué paquete estamos negociando?
  const videos = r.videos || state.videos;
  if (!videos) {
    if (r.askedRatesGenerally) {
      return { action: "quote_rates", state: { ...state, ...base }, extras: pickHeadlineTiers(tiers) };
    }
    return { action: "ask_terms", state: { ...state, ...base } };
  }

  const tier = tierFor(tiers, videos);
  if (!tier) return { action: "ask_terms", state: { ...state, ...base } };

  const ladder = buildLadder(tier);
  const next = { ...state, ...base, videos };

  // Si el paquete cambió, la escalera se reinicia para ese paquete nuevo
  if (state.videos != null && Number(state.videos) !== Number(videos)) {
    next.rungIndex = -1;
    next.lastOffer = null;
    next.midRounds = 0;
    next.floorRounds = 0;
  }

  // Cierre forzado (pasaron 24h sin respuesta — lo pide sweepTimers)
  if (forceAccept) {
    const price = their ?? next.theirBest ?? next.lastOffer ?? tier.floor;
    return { action: "close", price, videos, state: next };
  }

  // Ya dijeron que sí a un precio que nosotros propusimos → cerrar
  if (r.confirmedDeal && next.proposedClose != null) {
    return { action: "close", price: next.proposedClose, videos, state: next };
  }

  // Primera jugada: SIEMPRE el precio más alto de la tabla
  if (next.rungIndex < 0 || next.lastOffer == null) {
    return {
      action: "counter", price: ladder[0], videos, phase: "anchor",
      state: { ...next, rungIndex: 0, lastOffer: ladder[0] },
    };
  }

  // Aceptaron nuestro número (o lo superaron) → proponer cierre
  if (r.theyMetOurPrice || (their != null && their >= next.lastOffer)) {
    const price = their != null && their > next.lastOffer ? their : next.lastOffer;
    return { action: "propose_close", price, videos, state: { ...next, proposedClose: price } };
  }

  const currentRung = ladder[Math.min(Math.max(next.rungIndex, 0), ladder.length - 1)];

  // PLANTARSE EN EL MEDIO — obligatorio 2 rondas ANTES de siquiera considerar aceptar.
  // Esto va primero a propósito: aunque su oferta ya esté dentro de la tabla y aunque
  // digan que es su máximo, primero se aguanta el medio completo. Así no se cierra
  // barato dejando dinero en la mesa.
  if (currentRung === tier.medio && next.midRounds < 2) {
    return {
      action: "counter", price: tier.medio, videos,
      phase: next.midRounds === 0 ? "mid_first" : "mid_hold",
      state: { ...next, lastOffer: tier.medio, midRounds: next.midRounds + 1 },
    };
  }

  // ¿Ya se atoraron de verdad? Solo se acepta después de haber aguantado el medio,
  // y solo si su número está dentro de la tabla. Repetir el mismo número 2 veces tras
  // nuestro empujón, o 2do "es final", = de verdad ya no se mueven.
  // No basta con aguantar el medio: hay que haber bajado AL MENOS un escalón por
  // debajo del medio (un último empujón) antes de aceptar. Así siempre se les saca
  // el último jalón en vez de cerrar apenas se plantan.
  const yaAguantamosElMedio = next.rungIndex > ladder.indexOf(tier.medio);
  if (their != null && their >= tier.floor && yaAguantamosElMedio && (repeatCount >= 2 || finalityClaims >= 2)) {
    return { action: "propose_close", price: their, videos, state: { ...next, proposedClose: their } };
  }

  // EN EL PISO — nunca se acepta de golpe: se empuja hacia arriba
  if (currentRung === tier.floor) {
    if (their != null && their >= tier.floor) {
      const middle = roundDown50((their + next.lastOffer) / 2);
      if (middle > their) {
        return {
          action: "counter", price: middle, videos, phase: "meet_middle",
          state: { ...next, lastOffer: middle, floorRounds: next.floorRounds + 1 },
        };
      }
      return { action: "propose_close", price: their, videos, state: { ...next, proposedClose: their } };
    }
    return {
      action: "counter", price: tier.floor, videos,
      phase: next.floorRounds >= 1 ? "floor_final" : "floor_hold",
      state: { ...next, lastOffer: tier.floor, floorRounds: next.floorRounds + 1 },
    };
  }

  // Bajar un escalón
  const nextIdx = Math.min(next.rungIndex + 1, ladder.length - 1);
  let price = ladder[nextIdx];

  // REGLA DURA: nunca decir un número por debajo de lo que ellos ya ofrecieron
  if (their != null && price <= their) {
    const middle = roundDown50((their + next.lastOffer) / 2);
    if (middle > their) {
      return {
        action: "counter", price: middle, videos, phase: "meet_middle",
        state: { ...next, lastOffer: middle },
      };
    }
    return { action: "propose_close", price: their, videos, state: { ...next, proposedClose: their } };
  }

  const landsOnMid = price === tier.medio;
  return {
    action: "counter", price, videos,
    phase: landsOnMid ? "mid_first" : "step",
    state: {
      ...next, rungIndex: nextIdx, lastOffer: price,
      midRounds: landsOnMid ? 1 : next.midRounds,
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   PARTE 4 — ESCRITOR: la IA solo redacta el mensaje.
   El número ya viene decidido; la IA no lo puede cambiar.
   ══════════════════════════════════════════════════════════════ */

const STYLE = `You are the closer for a content creator, texting a brand on WhatsApp. Write exactly like a real person texting — never like an assistant or a script.

HARD STYLE RULES:
- 1-2 short sentences maximum. Direct, no corporate tone, no over-explaining.
- Natural connectors are fine ("look,", "honestly,", "here's the thing,") but keep it tight.
- Never apologize for your price. Blunt is fine, even a little curt.
- NEVER phrase things as a question or ask permission — no "Can we...", "Would you...", "Does that work?". State things flatly: "Let's do $X for N videos."
- NEVER reveal internal reasoning. Never use the words "floor", "minimum", "mid", "checkpoint", "my limit", "budget approved", "authorized". Never hint that a number is the lowest you can go unless the instruction explicitly says to. Every message must read as if you could still be pushed further.
- COMMISSION IS OFF-LIMITS: if the brand mentions a commission or affiliate percentage, ignore it completely. Never use the word "commission". Never accept it, reject it, thank them for it, or say anything like "don't worry about the commission". Reply only about the video price/count, exactly as if no commission had been mentioned.
- Never use emoji unless the brand used them first.
- Write in English unless the brand switched to Spanish.
- Do not engage with relationship-building filler (long-term partnership talk, upcoming launches, "trial run first"). Brief neutral acknowledgment at most, then straight back to price/videos.
- Never write any tag, bracket, or code in your message. Just the plain text you'd send.`;

function writerInstruction(decision, r) {
  const p = decision.price;
  const v = decision.videos;
  const extras = [];

  if (r.askedOrigin) {
    extras.push(`They asked how you got their number or who you are. Answer plainly in the same message: you were recommended in the VAAS community for a paid collab. Do not elaborate or invent detail.`);
  }
  if (r.askedAboutPerson) {
    extras.push(`They asked if you know "${r.askedAboutPerson}". Confirm plainly: yes, ${r.askedAboutPerson} recommended them in the VAAS community.`);
  }

  const withExtras = (main) => [main, ...extras].join("\n\n");

  switch (decision.action) {
    case "ask_terms":
      return withExtras(`Their message does not clearly state BOTH a number of videos AND a price. Ask directly and briefly for both — e.g. "So what's the deal? How many videos you want and what's the rate?" Do not guess or name any price yourself.`);

    case "quote_rates": {
      const e = decision.extras || {};
      return withExtras(`They asked about your rates without naming a package size. State these three prices in one short line, nothing more: 1 video $${e.one}, 5 videos $${e.five}, 10 videos $${e.ten}. Let them pick.`);
    }

    case "dormant":
      return withExtras(`They have no budget right now but may reach out later. Reply with exactly this and nothing else: "Ok, thank you, please let me know if something comes up."`);

    case "propose_close":
      return withExtras(`You are agreeing on $${p} for ${v} videos. State that exact price and video count back to them clearly as a done deal — e.g. "Sounds good, let's move forward with ${v} videos for $${p}." Do NOT ask them to confirm again, do not add conditions.`);

    case "close":
      return withExtras(`The deal is closed at $${p} for ${v} videos. Write a short, friendly close-out line confirming it and saying you'll get started. Do not restate any other number.`);

    case "counter":
    default: {
      const byPhase = {
        anchor: `This is your opening number. State $${p} for ${v} videos flatly and confidently, as your rate. Do not discount yourself, do not hedge, do not hint there is room below.`,
        step: `Push back FIRST with a brief reason your price is fair (your results/GMV, the quality of the work, the discount already baked into the bundle), THEN state $${p} for ${v} videos in the same short message. Never state the number bare with no pushback — that reads as caving.`,
        mid_first: `Push back with a reason, then state $${p} for ${v} videos as a serious, near-final-sounding number. Make it land hard — e.g. "that's already a strong number for ${v} videos given the results I bring". Do NOT hint that you can go lower.`,
        mid_hold: `HOLD. You already said $${p} and they pushed back. Do NOT move off $${p}. Restate $${p} for ${v} videos more firmly this time, with a short reason and mild take-it-or-leave-it energy — e.g. "$${p} for the ${v}, that's where I'm at". The goal is to make THEM move up, not for you to move down.`,
        meet_middle: `They are close. Propose meeting in the middle at $${p} for ${v} videos as a flat statement — e.g. "Let's meet in the middle, $${p} and we're set." Confident, final-feeling, not a question.`,
        floor_hold: `State $${p} for ${v} videos firmly. Make them feel this is as far as it goes, without ever saying it's your minimum.`,
        floor_final: `They keep holding the same low number. Escalate once with direct take-it-or-leave-it framing at $${p} for ${v} videos — e.g. "$${p} for the ${v}, that's as far as I go — you in or not?" Firm, not rude.`,
      };
      const line = byPhase[decision.phase] || byPhase.step;
      const guard = `\n\nCRITICAL: the only price allowed in your message is $${p}. Do not mention any other number, do not average, do not round it, do not offer alternatives.`;
      return withExtras(line + guard);
    }
  }
}

async function writeReply(conversation, decision, r) {
  const messages = conversation.map((m) => ({ role: m.role, content: m.content }));
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: STYLE,
    messages: [
      ...messages,
      { role: "user", content: `[INSTRUCTION FOR YOUR NEXT MESSAGE — follow it exactly, output only the message text]\n\n${writerInstruction(decision, r)}` },
    ],
  });

  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/<<[^>]*>>/g, "")
    .trim();
}

/** Última red de seguridad: si la IA escribió un número distinto al que el código
 * decidió, se corrige el texto en vez de dejar salir un precio equivocado. */
function priceGuard(text, decision) {
  if (decision.action !== "counter" && decision.action !== "propose_close") return text;
  const p = decision.price;
  const found = (text.match(/\$\s?[\d,]+/g) || []).map((m) => Number(m.replace(/[$,\s]/g, "")));
  const wrong = found.filter((n) => n !== p);
  if (!wrong.length) return text;

  console.warn(`⚠️  El escritor metió números equivocados (${wrong.join(", ")}) — se reemplaza por el mensaje de respaldo con $${p}.`);
  return decision.action === "propose_close"
    ? `Sounds good, let's move forward with ${decision.videos} videos for $${p}.`
    : `$${p} for the ${decision.videos} videos — that's where I'm at given the results I bring.`;
}

/* ══════════════════════════════════════════════════════════════
   PARTE 5 — PUNTO DE ENTRADA
   ══════════════════════════════════════════════════════════════ */

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} conversation
 * @param {Array<{videos:number, anchor:number, medio?:number, floor:number}>} tiers
 * @param {object|null} negState  estado guardado de la negociación (columna leads.negotiation)
 * @param {{forceAccept?:boolean}} opts
 */
export async function getNextMove(conversation, tiers, negState = null, opts = {}) {
  const reading = await readBrandMessage(conversation);
  console.log(`🔎 Lectura: ${JSON.stringify(reading)}`);

  const decision = decide(negState, reading, tiers, opts);
  console.log(`🎯 Decisión: ${decision.action}${decision.price ? ` $${decision.price}` : ""}${decision.videos ? ` x${decision.videos} videos` : ""}${decision.phase ? ` (${decision.phase})` : ""}`);

  let text = await writeReply(conversation, decision, reading);
  if (!text) {
    console.warn("⚠️  El escritor devolvió vacío, reintentando una vez...");
    text = await writeReply(conversation, decision, reading);
  }
  if (!text) {
    text =
      decision.action === "counter" || decision.action === "propose_close"
        ? `$${decision.price} for the ${decision.videos} videos.`
        : "Sorry, could you repeat that?";
  }

  text = priceGuard(text, decision);

  return {
    replyText: text,
    closed: decision.action === "close",
    dormant: decision.action === "dormant",
    closedPrice: decision.action === "close" ? decision.price : null,
    closedVideos: decision.action === "close" ? decision.videos : null,
    negotiation: decision.state || negState || emptyState(),
  };
}
