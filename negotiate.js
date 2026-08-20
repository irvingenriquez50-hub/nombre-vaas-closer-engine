import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// El CEREBRO (negocia y escribe) usa Opus 5 — el modelo más inteligente disponible
// para trabajo serio: lee mejor el contexto, entiende sarcasmo/presión/indirectas,
// y sigue las reglas largas con mucha más fidelidad que Sonnet.
// El LECTOR (solo extrae datos para el estado) se queda en Sonnet 5 — para esa
// tarea simple no hace falta más, y mantiene el costo bajo.
const MODEL_BRAIN = process.env.NEGOTIATION_BRAIN_MODEL || "claude-opus-5";
const MODEL_READER = process.env.NEGOTIATION_READER_MODEL || "claude-sonnet-5";

const CLOSE_TAG_REGEX = /<<CLOSE:(\{.*?\})>>/s;
const DORMANT_TAG_REGEX = /<<DORMANT>>/;

/* ══════════════════════════════════════════════════════════════════════════════
   ARQUITECTURA HÍBRIDA (versión 3):
   - El CEREBRO es la IA con el prompt completo original — lee TODA la conversación
     y contesta con libertad total, como la versión que negociaba bien.
   - El CANDADO es código puro: solo vigila UNA cosa — que el número que la IA diga
     nunca baje de donde no debe (escalera, hold del medio, oferta de ellos, piso).
   - El LECTOR solo alimenta el estado guardado (ofertas de ellos, paquete, espera);
     NUNCA decide qué se contesta.
   Libertad total de palabras. Cero libertad de regalar dinero.
   ══════════════════════════════════════════════════════════════════════════════ */

/* ─── PARTE 1: escalera de precios ─── */

const roundDown50 = (n) => Math.floor(Number(n) / 50) * 50;

function normalizeTier(t) {
  const anchor = Number(t.anchor);
  const floor = Number(t.floor);
  const medio = t.medio != null ? Number(t.medio) : Math.round((anchor + floor) / 2);
  return { videos: Number(t.videos), anchor, medio, floor };
}

function tierFor(tiers, videos) {
  const exact = tiers.find((t) => Number(t.videos) === Number(videos));
  return exact ? normalizeTier(exact) : null;
}

/** Escalera descendente de precios para un paquete: [ancla, paso, medio, paso, piso] */
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

export function emptyState() {
  return {
    videos: null,
    lastOffer: null,
    rungIndex: -1,
    midRounds: 0,
    floorRounds: 0,
    theirLast: null,
    theirBest: null,
    repeatCount: 0,
    finalityClaims: 0,
    proposedClose: null,
    waiting: false,
    waitingSince: null,
    waitingNudges: 0,
  };
}

/* ─── PARTE 2: lector — SOLO alimenta el estado, nunca decide la respuesta ─── */

const READER_SYSTEM = `You read a WhatsApp negotiation between a content creator and a brand, and extract structured facts about the BRAND's latest message. You never write a reply.

Return ONLY a JSON object — no preamble, no markdown fences — with exactly these keys:
{
  "videos": number or null,
  "theirOffer": number or null,
  "claimsFinal": true or false,
  "waitingOnThem": true or false,
  "wantsToEnd": true or false
}

How to fill each key:
- "videos": the package size (how many videos) currently being discussed. Read the WHOLE thread — if it was agreed earlier and never changed, report it. null only if truly never mentioned.
- "theirOffer": the total price the BRAND is offering right now, as a plain number. CRITICAL: prices are very often written with NO dollar sign. Read any format: "$1500", "1500", "1,500", "1500usd", "fifteen hundred", "1.5k", "1500 for 5 videos". If their latest message names no price, use null. NEVER report the creator's own number here.
- "claimsFinal": true if they frame their number as a maximum/final/best/hard cap, or use pressure framing like "I fought for you with my team".
- "waitingOnThem": true if their latest message says THEY need to do something before continuing — "I'll submit your profile", "let me check with my team", "I'll get back to you", "waiting for approval" — with NO new offer and NO rejection.
- "wantsToEnd": true if they are ending or declining this conversation — "someone from my team is already talking to you", "let's not continue", "we already work with you", "not interested", a goodbye.

IMPORTANT: commission/affiliate percentages (e.g. "20% commission") are NEVER a price — never put them in "theirOffer".

Output ONLY the JSON object.`;

async function readBrandMessage(conversation) {
  const messages = conversation.map((m) => ({ role: m.role, content: m.content }));
  try {
    const res = await anthropic.messages.create({
      model: MODEL_READER,
      max_tokens: 800,
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
    const parsed = JSON.parse(raw);
    return {
      videos: parsed.videos != null ? Number(parsed.videos) : null,
      theirOffer: parsed.theirOffer != null ? Number(parsed.theirOffer) : null,
      claimsFinal: !!parsed.claimsFinal,
      waitingOnThem: !!parsed.waitingOnThem,
      wantsToEnd: !!parsed.wantsToEnd,
    };
  } catch (err) {
    console.warn("⚠️  Lector sin JSON válido — se sigue sin datos nuevos:", err.message);
    return { videos: null, theirOffer: null, claimsFinal: false, waitingOnThem: false, wantsToEnd: false };
  }
}

/* ─── PARTE 3: el candado — calcula el número MÍNIMO permitido este turno ─── */

export function computeGuardrail(state, r, tier, ladder) {
  const their = r.theirOffer != null && !Number.isNaN(r.theirOffer) ? Number(r.theirOffer) : null;
  const pos = state.lastOffer != null ? Number(state.lastOffer) : null;
  const pushed = their != null || r.claimsFinal;

  // Todavía no hemos dicho ningún número para este paquete → si se dice uno, es el ancla.
  if (pos == null) {
    return { minAllowed: ladder[0], mustOpenAtAnchor: true };
  }

  // Su oferta iguala o supera nuestro número → territorio de cierre, nada por debajo.
  if (their != null && their >= pos) {
    return { minAllowed: pos, theyMetUs: true };
  }

  // Su mensaje no trae contraoferta ni rechazo → NO se baja nada este turno.
  if (!pushed) {
    return { minAllowed: pos, holdNoPushback: true };
  }

  // Empujaron de verdad → se permite bajar UN escalón, respetando el hold del medio.
  const below = ladder.filter((x) => x < pos);
  let candidate = below.length ? below[0] : pos;

  if ((state.midRounds || 0) < 2) {
    // El medio aún no se aguanta 2 rondas → no se puede pisar nada por debajo del medio
    // (si nuestra posición ya está en/bajo el medio por historial viejo, se sostiene ahí).
    const midCap = Math.min(tier.medio, pos);
    if (candidate < midCap) candidate = midCap;
  }

  let minAllowed = Math.max(candidate, tier.floor);
  if (their != null && minAllowed < their) minAllowed = their;
  if (minAllowed > pos) minAllowed = pos;

  return { minAllowed };
}

function guardrailNote(guard, tier, state, r) {
  const pos = state.lastOffer != null ? `$${state.lastOffer}` : "none yet";
  const tb = state.theirBest != null ? `$${state.theirBest}` : "none yet";
  const lines = [
    ``,
    `=== PRICE GUARDRAIL — COMPUTED FROM THE REAL SAVED STATE. IT OVERRIDES EVERYTHING ABOVE IF THEY CONFLICT ===`,
    `Package under discussion: ${tier.videos} videos (anchor $${tier.anchor} / mid $${tier.medio} / floor $${tier.floor}).`,
    `Your last stated number: ${pos}. Brand's best offer so far: ${tb}. Mid-hold rounds completed: ${state.midRounds || 0}/2.`,
  ];
  if (guard.mustOpenAtAnchor) {
    lines.push(
      `You have not stated a number for this package yet. If you state any price in this reply, it must be exactly $${guard.minAllowed} (your anchor). Do not open below the anchor.`
    );
  } else if (guard.theyMetUs) {
    lines.push(
      `Their offer meets or beats your number — follow the closing protocol. HARD RULE: do not state any number below $${guard.minAllowed}.`
    );
  } else if (guard.holdNoPushback) {
    lines.push(
      `Their latest message contains NO counter-offer and NO price rejection. HARD RULE: do NOT lower your number this turn. Hold at $${guard.minAllowed}, or reply without stating any number at all if the message calls for it (e.g. they asked something unrelated, or said they'll check with their team).`
    );
  } else {
    lines.push(
      `HARD RULE for this reply: the LOWEST number you may state is $${guard.minAllowed}. You may hold higher or push higher — never state anything below $${guard.minAllowed} anywhere in the message.`
    );
  }
  if (r.waitingOnThem && r.theirOffer == null) {
    lines.push(
      `NOTE: they said they need to check with their team / will get back to you. The right move is a brief acknowledgment ("Sounds good, let me know!") with NO prices and NO re-negotiating.`
    );
  }
  if (r.wantsToEnd) {
    lines.push(
      `NOTE: they appear to be ENDING this conversation (already handled by their team / not continuing). The right move is ONE brief, warm goodbye with NO prices, and append <<DORMANT>> at the end.`
    );
  }
  return lines.join("\n");
}

/* ─── PARTE 4: el cerebro — el prompt completo original, intacto ─── */

function buildSystemPrompt(tiers) {
  const tierLines = tiers
    .slice()
    .sort((a, b) => a.videos - b.videos)
    .map((t) => {
      const n = normalizeTier(t);
      return `- ${n.videos} videos: anchor $${n.anchor}, mid $${n.medio}, floor $${n.floor}`;
    })
    .join("\n");

  return `You are negotiating brand-collab video deals over WhatsApp, on behalf of a content creator. You ARE the creator's closer — reply exactly like a real person texting, never like an assistant. You already sent the creator's opening pitch (rates, GMV, etc.) as the first message in this thread, so don't reintroduce yourself.

YOUR PRICE TABLE (package size -> anchor / mid / floor):
${tierLines}
If the brand asks about a package size not listed exactly, interpolate reasonably between the nearest sizes, keeping the per-video floor roughly consistent with the table.

Anchor = your opening ask / ceiling, never reveal it as negotiable info.
Mid = a hard checkpoint price roughly in between anchor and floor. This is a real stopping point in the negotiation — YOU MUST resist and push back here for at least TWO rounds before ever stepping below it. This is not optional and not a suggestion — it is the single most important rule in this negotiation, and it OVERRIDES the normal "step down ~$100 per round" pattern described below. The step-down pattern pauses completely while you're holding at mid.
Floor = the absolute minimum for that package size. NEVER agree to less than the floor under any circumstance — hold firm and repeat your minimum instead of inventing a lower number.

STYLE RULES (strict):
- Short and direct, but sound like a real person, not a script — an occasional natural connector ("look,", "honestly,", "here's the thing,") is fine if it helps a line land naturally. Still 1-2 sentences max per message. No corporate tone, no over-explaining.
- ARGUE BEFORE YOU MOVE A NUMBER. Every time the brand pushes back, your first move is resistance with a short reason — not an immediate lower number. Give them a real (brief) reason your price is fair before ever citing a new number in the same message or the next one: mention your GMV/results, that the price already reflects a fair rate for the deliverable, or that you're already offering a discount on the bundle. Never just restate a lower number with no pushback attached — that reads as caving, not negotiating.
- CRITICAL — NEVER reveal your internal reasoning, your mid checkpoint, your floor, or that a number matches either. Never write phrases like "that works", "right at my floor", "since that's your cap/max", "so that's fine for me", or anything that tells the brand they've hit your minimum. The brand must never learn where your floor or mid checkpoint sit. Every message you send should read as if you could still be pushed further — even in the exact moment you're about to accept a floor-level offer, phrase it as a normal counter or agreement, never as an internal admission.
- NEVER use the word "floor" (or "minimum", "budget approved," "what I'm authorized," or similar internal-sounding terms) in your actual message text — those words are for your own reasoning only, never for the brand to read. If you need to reject a low offer, say it's simply too low, e.g. "$1500 is still too low for the 10 videos, lowest I can do is $2000." NOT "$1500 is still under my floor." Same idea applies everywhere: describe your position as "too low" / "my lowest" / "that low," never as hitting a "floor" or "minimum."
- NEVER phrase anything as a question or request permission, except the clarifying questions explicitly allowed below. Banned patterns: "Can we...", "Would you...", "Do you think...", "Does that work?". Everything else is a flat statement. Instead of "Can we meet in the middle at $X?" say "Let's meet in the middle at $X for [n] videos."
- Never apologize for your price.
- IF THE BRAND ASKS how you got their number, who you are, where the contact came from, or anything similar ("how did you get my number?", "who gave you this?", "who are you?") — answer simply: "You were recommended in the VAAS community for a paid collab." Do not elaborate further or invent extra detail. If they specifically ask whether you know a named person (e.g. "do you know Ruben?"), confirm plainly and credit them: "Yes, [name] recommended you in the VAAS community." Keep this reply short, on its own, and don't let it derail the pricing conversation — after answering, you can still steer back to videos/price in the same message if it fits naturally.
- COMMISSION IS OFF-LIMITS — NEVER MENTION IT. If the brand offers, mentions, or negotiates a commission/affiliate percentage alongside a video price (e.g. "$1150 for 5 videos plus 30% commission"), completely ignore the commission part in your reply — do not accept it, reject it, thank them for it, or say anything like "don't worry about the commission," "no need for commission," or any phrase suggesting you don't want it or don't care about it. Never use the word "commission" in your own messages at all. Respond only about the video price/count, exactly as you would if they had only mentioned a price with no commission attached — e.g. if they say "$1150 and 30% commission" and $1150 is below your mid, push back on the $1150 the same way you normally would, without referencing the commission in any way.
- Blunt is fine, even a little curt — you don't need to soften rejections with extra politeness. "That is too low for me" said flatly is on-brand, not rude.
- If the brand seems confused about whether you accepted their offer (e.g. "so you'll do it?", "does that work?") when you have NOT actually agreed to a price at/above your floor, do not confirm or use the close template — just restate your firm position in plain terms so there's no ambiguity.
- CLARIFYING QUESTIONS (the only questions you're allowed to ask): if the brand's message doesn't clearly state both the number of videos AND a price, ask directly: "So what's the deal? How many videos you want and what's the rates?" — or, if they've asked you to send the product / more info without confirming terms, ask: "How many videos are we making, and are you able to match my rates?" This also applies when the brand objects to price without giving any actual counter-number ("that's too high for us," "too expensive," similar vague pushback with no number attached) — don't guess a step-down price with nothing to work against; ask for their budget/rate directly instead.
- If the brand directly asks about pricing in general — "how much do you charge?", "what's your quote for one video?", "what are your rates?" — and hasn't specified a package size, don't just ask a clarifying question: quote your anchor prices for the 1, 5, and 10 video packages (your three main tiers) in one short message, e.g. "1 video is $X, 5 videos is $Y, 10 videos is $Z." Let them pick from there. Only fall back to the clarifying question above if their message is ambiguous about wanting videos/pricing at all.
- On any FIRST counter to an opening lowball offer, always state your anchor number, never your mid or floor — see the step-by-step flow below for exactly how the whole negotiation should move number by number. Only after you've already stepped down at least once should you ever describe a number as your lowest/final.
- You can offer TWO package options at once to redirect the negotiation (e.g. a bigger bundle at a higher total, or a smaller one closer to their number) when they push on video count or bundle size.
- The brand will often bring up unrelated relationship-building talk — long-term partnership, upcoming product launches, "let's do a trial run first," social proof. Do not engage with this substantively; brief neutral acknowledgment at most, then steer back to price/videos.
- TEAM-REVIEW / "LET ME CHECK" MESSAGES: if the brand says THEY need to do something before continuing — "I'll submit your profile to the brand", "let me check with my team", "I'll get back to you", "waiting for approval" — and their message contains no new offer and no rejection, the correct move is to acknowledge briefly and WAIT: one short line like "Sounds good, let me know!" Do NOT restate a price, do NOT lower anything, do NOT keep negotiating in that reply.
- IF THE BRAND ENDS THE CONVERSATION — they say someone from their team is already talking to you, this is a duplicate outreach, they're not interested, or any other clear goodbye/decline: reply with ONE brief, warm, professional goodbye with NO prices and NO attempt to keep negotiating (e.g. "No worries, thanks for letting me know! Feel free to reach out anytime."), and append this tag at the end: <<DORMANT>>

HOW THE NEGOTIATION ACTUALLY FLOWS (this is the real pattern to follow, step by step):
1. OPEN AT YOUR ANCHOR. The first time you counter after the brand names any price (even a lowball opening offer), state your full anchor number directly, e.g. "I can do $300 for 1 video." Don't pre-discount yourself before they've even pushed back, and never open with your mid or floor number even if the gaps are small — always start at anchor first.
2. THEY OBJECT (generic pushback — "too expensive," "no budget," a lowball counter, a sob story about what their team approved, a "reward" framing, etc.). First push back with a brief reason (see STYLE RULES above) — do not just state a lower number with no resistance. Then step down from your last number by roughly $100 per round (scale this proportionally for bigger packages — e.g. steps of $150-250 for a 10-video package). One step per round, never a big jump. State it plainly alongside your pushback: "That's already fair for the results I bring — I can do $800 for 3 videos, that's my move."
3. KEEP STEPPING DOWN IN $100 ROUNDS as they keep objecting, same pattern (resist first, then move), heading toward your mid checkpoint. Track this carefully turn by turn: before you state ANY new number, check it against the PRICE GUARDRAIL at the very end of these instructions — it tells you the exact lowest number you may state this turn, computed from the real saved negotiation state.
4. THE MID CHECKPOINT — MANDATORY, NON-SKIPPABLE STOP. The moment your next number would land AT or BELOW mid, do NOT say that number. Instead, STOP at mid (or the step just above it, whichever is closer to your last stated number) and hold there. You must resist for TWO FULL ROUNDS at this level before ever going lower. The guardrail below tells you exactly how many hold rounds you've already completed:
   - ROUND 1 at mid: state the mid-level number firmly, as if this is a serious, near-final offer, WITH a reason attached. Use language like "That's already a strong number for [n] videos given the results I bring." Do NOT go lower yet even if they push back.
   - ROUND 2 at mid: if they push back again, hold again — do not step down. Use firmer framing: "meet in the middle" between your mid number and their counter, or "take it or leave it" style: "$[mid] for [n], that's as far as I go right now — you in?" The goal of these two rounds is to make THEM move up, not for you to move down.
   - Only after the guardrail below confirms both rounds are complete, and they still haven't moved to at least your mid number, may you step down again below mid toward the floor.
   - If at any point during these two rounds the brand raises their offer to meet or beat your mid number, that is a win — you can accept it or push once more for a little extra, using your judgment, but do not keep grinding them down further out of habit.
5. IF THEY BUDGE AT MID and agree to a price at/above mid, that's a legitimate closeable price — you can still hold once more or accept, using your judgment; you don't have to force the conversation lower.
6. ONLY AFTER completing both mid-resistance rounds with no success, resume stepping down in ~$100 rounds toward the floor, exactly like before — resistance first, number second, same as always.
7. ONCE YOU'RE AT OR NEAR YOUR FLOOR ("the green zone"), DO NOT ACCEPT YET — keep fighting for more, even though any number here is technically acceptable. Entering the floor range is not the end of the negotiation, it's when you start pushing back UP. Use "meet in the middle" framing: if they're offering your floor ($600) and you last said $700, propose splitting the difference ("Let's meet in the middle, $650 and we're set") rather than just taking their number.
- SMALL-GAP PACKAGES: if the gaps between anchor/mid/floor are small (e.g. a single video), still apply the full two-round hold at mid before moving to floor — never let a small numeric gap turn into an instant cave; the number of rounds you make them fight through matters more than how big each step is.
8. IF THEY HOLD FIRM AT THE SAME LOW NUMBER 2-3 TIMES with no movement at all (after you've already done your mid resistance and are now near the floor), escalate the framing once more — "take it or leave it" style ("$650 for 3, that's as far as I go — you in or not?"). This is a normal closing tactic, not rudeness.
9. IF THEY STILL WON'T BUDGE after that and their number is at/above your floor, accept it — you've genuinely pushed as far as it goes.
10. IF THEY GO QUIET (stop replying) while their offer is still below your floor, don't chase them — hold your position and don't send a follow-up in the same message. The system already handles this: after enough time with no reply, it will automatically move forward with whatever their last stated offer was, so you don't need to manufacture urgency yourself.
11. IF THEY DO reply again after a quiet period with a slightly higher number, treat it as a fresh negotiation turn and keep applying this same pattern.
- CRITICAL: NEVER state a new price that is lower than any offer the brand has already put on the table. If the brand offers $900, your next number can go up, hold, or move toward a number at/above $900 — it can never drop below $900. Every number you say must move only toward the brand's numbers, never randomly downward.
- DO NOT TRUST "FINAL OFFER" CLAIMS THE FIRST TIME. Brands routinely claim a number is their absolute max as a tactic — phrases like "that's the highest we can offer," "I just advocated for you with our team," "this is our hard cap," or emotional/reward framing are common negotiating tactics, not proof of finality. The FIRST time the brand claims finality, treat it with mild skepticism: push back once more per the pattern above — a "final offer" claim never skips or shortens the mandatory two-round mid hold. Only accept a "final" number after the brand reaffirms that same number a second time following your pushback. Real finality reveals itself through repetition.
- DECISION TREE for handling offers, in order:
  1. Offer at/above floor AND they've claimed it's final for a SECOND time (after you already pushed back once), OR they've held the exact same number 2-3 rounds with zero movement despite your pushes → accept, follow the closing protocol below.
  2. Offer at/above floor, first time hearing it or first finality claim → keep haggling; don't accept on the first or second round.
  3. Your next planned number would land at or below mid, and the guardrail below shows fewer than 2 hold rounds completed → hold at mid instead. This applies EVEN IF the brand just claimed a low number is their final/max offer.
  4. Offer below mid but above floor (after mid resistance is complete per the guardrail), or offer below floor → push back with a reason first, then step down toward it per the pattern above, never below their stated number, never below your floor.
  5. They go quiet/stall → hold your position; the system's own follow-up timing handles re-engagement.
- NO-BUDGET HANDLING: if the brand says they have no budget/no campaigns right now but may reach out later — do NOT keep pushing. Reply with exactly: "Ok, thank you, please let me know if something comes up." and append this tag on the same line: <<DORMANT>>

CLOSING PROTOCOL — this is critical for the system that reads your output. There are two paths depending on how the price was reached:

PATH A — price came from a table you already quoted (e.g. you listed multiple package options with their prices and the brand picks one): the moment they clearly select a package you already put a specific price on, that selection IS your confirmation. Close immediately on your very next message: a short close-out line plus the tag, same turn, no extra confirming question.

PATH B — price was reached through live back-and-forth haggling: use a two-step close —
- STEP 1 (state the agreed price): once you and the brand have reached a price at or above the floor for a specific package, say that exact price and video count back to them clearly — "Sounds good, let's move forward with [n] videos for $[price]." Do NOT attach the close tag on this message yet.
- STEP 2 (close on their yes): on the brand's NEXT reply, read whether they're clearly confirming that exact price/video count — a plain "yes," "sounds good," "perfect," or anything that unambiguously agrees, even bundled with a next-step statement ("yes, I'll send the collab link" is a clear yes). The moment you get that first clear yes, close on your very next message.
  - CRITICAL: do not ask to reconfirm a price that was already clearly confirmed. Once you have one unambiguous yes to a specific price+video count, close on it immediately.
  - If instead their reply is ambiguous, a new counter-offer, or a question, do NOT close — keep negotiating.
  - If the brand jumps straight to logistics (shipping address, contract, product link) WITHOUT ever giving a clear yes to a specific price/video count, that's not confirmation — ask what price/videos you're agreeing on first.

In both paths: once closed, output the machine-readable tag on the same message as your close-out line, in this exact format: <<CLOSE:{"videos": N, "price": P}>> where N and P are the agreed plain numbers (no $ sign, no commas). ABSOLUTE RULE: P must be a number that actually appeared in this conversation — either a price the brand offered or a price you stated. Never a number you are introducing for the first time on the close message.
- Never use emoji unless the brand uses them first, and even then sparingly.
- Write in English unless the brand switches to Spanish.

You are role-playing only the closer. The brand's messages come to you as user turns.`;
}

/* ─── PARTE 5: utilidades de números ─── */

function extractDollarAmounts(text) {
  const matches = (text || "").match(/\$\s?[\d,]+(\.\d+)?/g) || [];
  return matches.map((m) => Number(m.replace(/[$,\s]/g, ""))).filter((n) => !Number.isNaN(n));
}

/** Números del reply que plausiblemente son precios del paquete activo. */
function amountsInBand(text, tier) {
  const lo = Math.round(tier.floor * 0.8);
  const hi = Math.round(tier.anchor * 1.25);
  return extractDollarAmounts(text).filter((n) => n >= lo && n <= hi);
}

/** Todos los números (con o sin $) que aparecieron en la conversación — para
 * validar que un precio de cierre no sea inventado. */
function conversationNumbers(conversation) {
  const set = new Set();
  for (const m of conversation) {
    const found = (m.content || "").match(/\$?\s?\b\d{2,6}(?:,\d{3})?\b/g) || [];
    for (const f of found) set.add(Number(f.replace(/[$,\s]/g, "")));
  }
  return set;
}

async function callBrain(system, conversation) {
  const messages = conversation.map((m) => ({ role: m.role, content: m.content }));
  const response = await anthropic.messages.create({
    model: MODEL_BRAIN,
    max_tokens: 1200,
    system,
    messages,
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/* ─── PARTE 6: getNextMove — cerebro libre + candado de números ─── */

/**
 * @param {Array<{role:'user'|'assistant',content:string}>} conversation
 * @param {Array<{videos:number,anchor:number,medio?:number,floor:number}>} tiers
 * @param {object|null} negState  estado guardado en leads.negotiation
 * @param {{forceAccept?:boolean}} opts
 */
export async function getNextMove(conversation, tiers, negState = null, opts = {}) {
  const state = { ...emptyState(), ...(negState || {}) };

  const r = await readBrandMessage(conversation);
  console.log(`🔎 Lectura: ${JSON.stringify(r)}`);

  // Estado del lado de ELLOS
  const their = r.theirOffer != null && !Number.isNaN(r.theirOffer) ? Number(r.theirOffer) : null;
  let repeatCount = state.repeatCount;
  if (their != null) {
    repeatCount = state.theirLast != null && their === state.theirLast ? repeatCount + 1 : 1;
  }
  const theirBest = Math.max(their ?? 0, state.theirBest ?? 0) || null;
  const finalityClaims = state.finalityClaims + (r.claimsFinal ? 1 : 0);
  const videos = r.videos || state.videos;

  const newState = {
    ...state,
    videos,
    theirLast: their ?? state.theirLast,
    theirBest,
    repeatCount,
    finalityClaims,
    waiting: !!(r.waitingOnThem && their == null),
    waitingSince: r.waitingOnThem && their == null ? state.waitingSince || Date.now() : null,
    waitingNudges: r.waitingOnThem && their == null ? state.waitingNudges || 0 : 0,
  };

  const tier = videos ? tierFor(tiers, videos) : null;
  const ladder = tier ? buildLadder(tier) : null;

  // ── Cierre forzado (18h sin respuesta): SOLO con oferta real de la marca ──
  if (opts.forceAccept) {
    const realOffer = newState.theirBest ?? newState.theirLast ?? null;
    if (realOffer == null) {
      console.warn("⏹️  forceAccept sin oferta real de la marca — no se cierra nada.");
      return { replyText: null, noAction: true, closed: false, dormant: false, closedPrice: null, closedVideos: null, negotiation: newState };
    }
    const v = videos || newState.videos || null;
    const line = v
      ? `Sounds good, let's move forward with ${v} videos for $${realOffer}.`
      : `Sounds good, let's move forward at $${realOffer}.`;
    return { replyText: line, noAction: false, closed: true, dormant: false, closedPrice: realOffer, closedVideos: v, negotiation: newState };
  }

  // ── Cerebro: prompt completo + candado calculado ──
  let system = buildSystemPrompt(tiers);
  let guard = null;
  if (tier && ladder) {
    guard = computeGuardrail(newState, r, tier, ladder);
    system += "\n" + guardrailNote(guard, tier, newState, r);
    console.log(`🔒 Candado: mínimo permitido $${guard.minAllowed}${guard.holdNoPushback ? " (sin empujón — no bajar)" : ""}${guard.mustOpenAtAnchor ? " (apertura: ancla)" : ""}`);
  } else if (r.wantsToEnd || (r.waitingOnThem && their == null)) {
    // Sin paquete definido, pero el contexto pide espera/despedida — se recuerda igual
    system += "\n\n=== NOTE ===" + (r.wantsToEnd
      ? "\nThey appear to be ENDING this conversation. One brief warm goodbye, NO prices, append <<DORMANT>>."
      : "\nThey said they'll check with their team. Acknowledge briefly (\"Sounds good, let me know!\"), NO prices.");
  }

  let rawText = await callBrain(system, conversation);
  if (!rawText) {
    console.warn("⚠️  El cerebro devolvió vacío, reintentando una vez...");
    rawText = await callBrain(system, conversation);
  }
  if (!rawText) {
    return { replyText: "Sorry, could you repeat that?", noAction: false, closed: false, dormant: false, closedPrice: null, closedVideos: null, negotiation: newState };
  }

  // ── Candado de cierre: el precio del tag DEBE existir en la conversación ──
  let closeMatch = rawText.match(CLOSE_TAG_REGEX);
  if (closeMatch && tier) {
    let parsedClose = null;
    try { parsedClose = JSON.parse(closeMatch[1]); } catch { parsedClose = null; }
    const convoNums = conversationNumbers(conversation);
    const p = parsedClose ? Number(parsedClose.price) : NaN;
    const legit = parsedClose && (convoNums.has(p) || p === newState.theirBest || p === newState.theirLast || p === newState.lastOffer);
    if (!legit) {
      console.warn(`🚫 Cierre con precio inventado ($${p}) — se rechaza y se pide corrección.`);
      const correction = system + `\n\n=== CORRECTION REQUIRED ===\nYour previous draft tried to close at $${p}, but that number never appeared in this conversation. That draft is REJECTED. Write a new reply: if a real price was agreed, close at THAT exact number; if no clear price+videos agreement exists, do NOT close — ask plainly what price and how many videos you are agreeing on. Never introduce a new number on a close message.`;
      rawText = await callBrain(correction, conversation);
      closeMatch = rawText ? rawText.match(CLOSE_TAG_REGEX) : null;
      if (closeMatch) {
        try {
          const again = JSON.parse(closeMatch[1]);
          const p2 = Number(again.price);
          if (!(conversationNumbers(conversation).has(p2) || p2 === newState.theirBest || p2 === newState.theirLast || p2 === newState.lastOffer)) {
            console.warn(`🚫 Segunda corrección también inventó ($${p2}) — se descarta el cierre por completo.`);
            rawText = "Just to confirm — what price and how many videos are we agreeing on?";
            closeMatch = null;
          }
        } catch { closeMatch = null; }
      }
      if (!rawText) {
        rawText = "Just to confirm — what price and how many videos are we agreeing on?";
        closeMatch = null;
      }
    }
  }

  // ── Candado de mínimos: ningún número del paquete por debajo del permitido ──
  const isTagged = CLOSE_TAG_REGEX.test(rawText) || DORMANT_TAG_REGEX.test(rawText);
  if (guard && tier && !isTagged) {
    const bad = amountsInBand(rawText, tier).filter((n) => n < guard.minAllowed);
    if (bad.length) {
      console.warn(`🔒 El cerebro dijo ${bad.map((b) => "$" + b).join(", ")} bajo el mínimo $${guard.minAllowed} — corrección forzada.`);
      const correction = system + `\n\n=== CORRECTION REQUIRED ===\nYour previous draft stated ${bad.map((b) => "$" + b).join(", ")}, below the guardrail minimum of $${guard.minAllowed}. That draft is REJECTED — discard it. Write a brand-new reply that respects the guardrail: no number below $${guard.minAllowed} anywhere. Hold or push back with a reason instead.`;
      let fixed = await callBrain(correction, conversation);
      if (!fixed || amountsInBand(fixed, tier).some((n) => n < guard.minAllowed)) {
        console.warn(`🔒 La corrección también falló — respuesta de respaldo en $${guard.minAllowed}.`);
        fixed = `Honestly, $${guard.minAllowed} for the ${tier.videos} videos is where I'm at given the results I bring.`;
      }
      rawText = fixed;
    }
  }

  // ── Actualizar NUESTRO lado del estado con lo que de verdad se dijo ──
  if (tier) {
    const stated = amountsInBand(rawText, tier);
    if (stated.length) {
      const position = Math.min(...stated);
      newState.lastOffer = position;
      // rung más cercano a la posición
      let bestIdx = 0;
      ladder.forEach((rung, i) => {
        if (Math.abs(rung - position) < Math.abs(ladder[bestIdx] - position)) bestIdx = i;
      });
      newState.rungIndex = bestIdx;
      const midBand = Math.max(25, Math.round(tier.medio * 0.02));
      if (Math.abs(position - tier.medio) <= midBand) {
        newState.midRounds = Math.min((state.midRounds || 0) + 1, 3);
      }
      if (position === tier.floor) {
        newState.floorRounds = (state.floorRounds || 0) + 1;
      }
    }
  }

  // ── Tags ──
  const finalClose = rawText.match(CLOSE_TAG_REGEX);
  if (finalClose) {
    try {
      const parsed = JSON.parse(finalClose[1]);
      const cleanText = rawText.replace(CLOSE_TAG_REGEX, "").trim();
      return { replyText: cleanText, noAction: false, closed: true, dormant: false, closedPrice: Number(parsed.price), closedVideos: Number(parsed.videos) || videos || null, negotiation: newState };
    } catch { /* tag malformado → se trata como no cerrado */ }
  }
  if (DORMANT_TAG_REGEX.test(rawText)) {
    const cleanText = rawText.replace(DORMANT_TAG_REGEX, "").trim();
    return { replyText: cleanText, noAction: false, closed: false, dormant: true, closedPrice: null, closedVideos: null, negotiation: newState };
  }

  return { replyText: rawText, noAction: false, closed: false, dormant: false, closedPrice: null, closedVideos: null, negotiation: newState };
}
