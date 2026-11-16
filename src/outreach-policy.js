import { canonicalPhone } from './zernio-policy.js';

export const CONTACT_DAYS=30;
export const contactCutoff=(now=Date.now())=>now-CONTACT_DAYS*86400000;
export const visibleContact=(row,now=Date.now())=>Date.parse(row.source_at||row.first_seen_at)>=contactCutoff(now);

// A provider thread can include both a phone participantId and a separate BSUID.
// Never mistake the opaque BSUID itself for a phone number.
export function historyPhone(row,links=[]) {
 const linked=links.find(l=>l.account_id===row.accountId && l.conversation_id===row.id);
 if(linked) return canonicalPhone(linked.jid);
 if(row.businessScopedUserId && String(row.participantId)===String(row.businessScopedUserId)) return null;
 return /^[+\d ()-]+$/.test(String(row.participantId||'')) && /^[1-9]\d{7,14}$/.test(canonicalPhone(row.participantId))?canonicalPhone(row.participantId):null;
}

export function deliveryReviewReason(error) {
 const code=String(error?.providerCode || error?.code || '');
 const detail=String(error?.message || error || '');
 if(code==='131049' || /131049|healthy ecosystem|per.user.*limit/i.test(detail))
  return 'WhatsApp limitó el mensaje de marketing a este contacto. Revisa la conversación; no se reintentará automáticamente.';
 if(/131026|131021/.test(code+' '+detail)) return 'WhatsApp no pudo entregar el mensaje a este número. Revisa el contacto antes de volver a escribir.';
 if(/payment|billing|lack of payment/i.test(detail)) return 'El proveedor rechazó el envío por un problema de pago de la cuenta. Revisa la conexión antes de volver a enviar.';
 return 'No se pudo confirmar la entrega. Revisa la conversación antes de volver a enviar.';
}

export function existingCollaborationSignal(input) {
 const text=String(input||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[’‘]/g,"'").toLowerCase();
 // Do not confuse an unrelated creator, a hypothetical question or a negation with an existing deal.
 const clauses=text.split(/[.!?\n]+/).map(s=>s.trim()).filter(Boolean);
 for(const s of clauses) {
  if(/\b(not|never|don't|dont|do not|haven't|havent|haven t|no|nunca|todavia no|aun no)\b/.test(s) || /\b(other|another) (?:creator|influencer|person|agency)\b/.test(s)) continue;
  if(/\b(?:if|what if|can we|could we|do we|are we|have we)\b/.test(s)) continue;
  if(/\b(?:we(?:'re| are|'ve| have)?|i(?:'m| am|'ve| have)?)\s+(?:already\s+(?:have|had|got|started|agreed on|closed|working on|working together on|doing|done|completed|finished)|(?:have|are|'re)\s+already\s+(?:started|working on|working together on|done|completed|finished))\s+(?:(?:a|the|our|an|this|paid|ongoing|active)\s+)*(?:collab(?:oration)?|partnership|deal|campaign|project)\b/.test(s) ||
     /\bwe(?:'re| are)? already (?:work(?:ing)?|collaborat(?:e|ing)) (?:together|with you)\b/.test(s) ||
     /\b(?:we|i) (?:have )?already collaborated (?:with you|together)\b/.test(s) ||
     /\b(?:our|the|this) (?:collab(?:oration)?|deal|campaign) (?:is|was|has been) already (?:confirmed|agreed|closed|started|in progress)\b/.test(s) ||
     /\b(?:ya (?:tenemos|teniamos|cerramos|acordamos|iniciamos|estamos trabajando en|estamos haciendo)|ya (?:tenemos|hay)) (?:una |la |nuestra )?(?:colaboracion|campana|trato|acuerdo)\b/.test(s) ||
     /\bya (?:estamos trabajando|trabajamos|colaboramos) (?:juntos|contigo|con ustedes)\b/.test(s)) return 'confirmed';
 }
 if(/\b(?:what do you mean|what you mean|wdym|que quieres decir|de que hablas)\b/.test(text)) return 'review';
 return null;
}

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
