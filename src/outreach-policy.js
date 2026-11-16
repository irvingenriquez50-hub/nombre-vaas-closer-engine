import { canonicalPhone } from './zernio-policy.js';

export function ownHistory(lead, closed, outbound, conversation) {
  if (lead?.negotiation?.optedOut) return 'blocked';
  if (lead?.negotiation?.manualCollab || closed) return 'collaborated';
  if (lead || outbound || conversation) return 'review';
  return 'queued';
}

export function compactContacts(rows, since, now=Date.now()) {
  const unique=new Map();
  for(const row of rows || []) {
    const phone=canonicalPhone(row.phone), at=Date.parse(row.created_at);
    if(!/^[1-9]\d{7,14}$/.test(phone) || !Number.isFinite(at) || at<since || at>now+60000) continue;
    const prior=unique.get(phone);
    if(!prior || at>Date.parse(prior.source_at)) unique.set(phone,{
      phone,product:String(row.product || '').slice(0,500),
      videos_text:String(row.videos_text || '').slice(0,200),price_text:String(row.price_text || '').slice(0,200),
      source_id:String(row.discord_message_key || '').slice(0,200),source_at:new Date(at).toISOString(),
    });
  }
  return [...unique.values()];
}

export const cleanReply = text => String(text || '').replace(/\s*[\u2013\u2014]\s*/g, ', ')
  .replace(/^\s*(?:[-*•]\s+|#{1,6}\s+)/gm,'').replace(/\*\*|__/g,'')
  .replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();

export function deferred(error) {return ['OUTREACH_THROTTLED','BOT_PAUSED','CONTACT_REVIEW','LEAD_BUSY'].includes(error?.code);}
export function hold(message,code='CONTACT_REVIEW') {const e=new Error(message);e.code=code;return e;}
