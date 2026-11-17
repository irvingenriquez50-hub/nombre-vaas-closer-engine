import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const canonicalPhone = value => String(value || '').replace(/@.*/, '').replace(/\D/g, '');
export const validPhone = value => /^[+\d ()-]+$/.test(String(value || '')) && /^[1-9]\d{7,14}$/.test(canonicalPhone(value));
export function verifySignature(raw, signature, secret) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature, 'hex'));
}
export function activeMembership(user, now = Date.now()) {
  return user?.status === 'active' && (!user.expires_at || Date.parse(user.expires_at) > now);
}
export function healthyAccount(health) {
  return health?.platform === 'whatsapp' && health.tokenStatus?.valid === true &&
    health.platformConnection?.status === 'connected' &&
    health.platformConnection?.inboundWebhookSubscribed !== false &&
    (!health.platformConnection.phoneStatus || health.platformConnection.phoneStatus === 'CONNECTED') &&
    health.status !== 'error';
}
export function profileReady(script, tiers) {
  return ['short_name', 'tiktok_handle', 'gmv_total', 'gmv_30d', 'market'].every(k => String(script?.[k] || '').trim()) &&
    [1, 5, 10].every(n => tiers.some(t => t.videos === n && Number(t.floor) > 0 &&
      Number(t.anchor) >= Number(t.floor) && (t.medio == null || (Number(t.medio) >= Number(t.floor) && Number(t.medio) <= Number(t.anchor)))));
}
export function serviceWindowOpen(lead, now = Date.now()) {
  const age = now - Date.parse(lead?.last_inbound_at);
  return Number.isFinite(age) && age >= 0 && age < 23.9 * 3600000;
}
export function actionKey(accountId, lead, kind, intent='reply') {
  const inbound=[...(lead.conversation||[])].reverse().find(m=>m.role==='user');
  const inboundId=inbound?.eventId || inbound?.event_id || lead.last_inbound_at || null;
  const phase=kind==='opening'?(lead.status==='dormant'?'retry30d':'initial'):
    kind==='followup'?[inboundId,lead.status==='checkback'?'checkback':lead.negotiation?.waiting?'waiting':'opening_followup',
      lead.followup_count||0,lead.negotiation?.checkbackCount||0,lead.negotiation?.waitingNudges||0]:[intent,inboundId];
  return digest(JSON.stringify([accountId,lead.id,lead.outreach_cycle,kind,phase]));
}
export const isHumanMessage = event => event.event === 'message.sent' &&
  (['whatsapp_business_app', 'meta_business_agent'].includes(event.message?.source) || event.message?.sentVia === 'human');
