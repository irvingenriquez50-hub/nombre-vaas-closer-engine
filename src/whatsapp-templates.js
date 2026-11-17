// Keep this contract identical in the Closer web and engine repositories.
// User-approved copy. Do not rewrite it when changing negotiation style.
export const OPENING_NAME = 'vaas_opening_message';
export const FOLLOWUP_NAME = 'vaas_followup_message';
export const OPENING_BODY = "• FROM THE VAAS COMMUNITY •\n\nI would love to work with your brand!\n\nI've helped multiple brands generate millions of views and over ${{1}} GMV within the {{2}} U.S. audience.\n\nTo keep quality high and give each video the time needed to create the best possible content, I only work through retainers. All packages include ad usage rights unless otherwise discussed.\n\n{{3}} — RATES\n\n1x Video — ${{4}} per video\n\n5x Videos/Month — ${{5}}\n(10% discount applied)\n\n10x Videos/Month — ${{6}}\n(20% discount applied)\n\nIf this aligns with what you're looking for, I'd be happy to lock in a slot this week and start brainstorming content ideas tailored specifically to your brand.\n\nLooking forward to working together,\n\nLast 30 Days GMV: ${{7}} USD\n\nMy TikTok Account: @{{8}}\n\n— The VAAS Community";
export const FOLLOWUP_BODY = 'Hi! Any updates on the paid collab?';

// Both preview and transport use this exact positional order, {{1}} through {{8}}.
export function openingParams(fields, tiers) {
  const value = v => String(v ?? '').trim();
  const money = v => value(v).replace(/^\$\s*/, '');
  const price = n => money(tiers.find(t => Number(t.videos) === n)?.anchor);
  return [
    money(fields.gmvTotal), value(fields.market), value(fields.shortName),
    price(1), price(5), price(10), money(fields.gmv30d),
    value(fields.tiktokHandle).replace(/^@+/, ''),
  ];
}
export function renderOpening(params, missing = '___') {
  return OPENING_BODY.replace(/\{\{([1-8])\}\}/g, (_, n) => params[Number(n)-1] || missing);
}

