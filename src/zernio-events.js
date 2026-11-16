import { supabase } from './supabase.js';
import { db, saveConnection } from './zernio-control.js';
import { canonicalPhone, isHumanMessage, validPhone } from './zernio-policy.js';
import { handleInboundMessage } from './queue.js';
import { sendMessage } from './sessions.js';
import { addLead, appendMessage } from './state.js';

export async function acceptEvent(event) {
  if(event.test || event.event==='webhook.test') return;
  if(typeof event.id!=='string' || event.id.length>200 || !event.event) throw new Error('Evento inválido.');
  await db(supabase.from('zernio_events').upsert({id:event.id,payload:event},{onConflict:'id',ignoreDuplicates:true}));
}
export async function processEvent(e) {
  const accountId=e.account?.accountId;
  if(!accountId) return;
  const c=await db(supabase.from('zernio_connections').select('*').eq('account_id',accountId).maybeSingle());
  if(!c) return; // A different tenant, old connection, or another Zernio product.
  if(e.event==='account.disconnected') {
    await saveConnection(c.user_id,{connected:false,bot_enabled:false,last_error:'WhatsApp se desconectó. Vuelve a conectarlo.'}); return;
  }
  const msg=e.message;
  if(!msg || msg.platform!=='whatsapp') return;
  let link=await db(supabase.from('zernio_conversations').select('*').eq('account_id',accountId).eq('conversation_id',msg.conversationId).maybeSingle());
  const rawNumber=msg.direction==='incoming' ? (msg.sender?.phoneNumber || (!msg.sender?.businessScopedUserId ? msg.sender?.id : '')) : e.conversation?.participantId;
  const number=validPhone(rawNumber)?canonicalPhone(rawNumber):'';
  let lead=link ? await db(supabase.from('leads').select('*').eq('user_id',c.user_id).eq('jid',link.jid).maybeSingle()) : null;
  if(!lead && validPhone(number)) lead=await db(supabase.from('leads').select('*').eq('user_id',c.user_id).eq('jid',number).maybeSingle());
  if(!lead && e.event==='message.received' && validPhone(number)) lead=(await addLead(c.user_id,number)).lead;
  if(!lead) return;
  if(!link) await db(supabase.from('zernio_conversations').upsert({user_id:c.user_id,account_id:accountId,conversation_id:msg.conversationId,jid:lead.jid},{onConflict:'user_id,account_id,jid'}));
  if(isHumanMessage(e)) {
    await appendMessage(c.user_id,lead.jid,'assistant',msg.text || '[Mensaje desde WhatsApp]',{eventId:e.id,at:msg.sentAt});
    await db(supabase.from('leads').update({paused:true,last_error:'Tomaste la conversación desde WhatsApp. Reanuda el bot cuando quieras.'}).eq('id',lead.id)); return;
  }
  if(e.event==='message.failed') {
    await db(supabase.from('leads').update({last_error:'WhatsApp rechazó un envío. Revisa la entrega antes de reanudar.',paused:true}).eq('id',lead.id)); return;
  }
  if(e.event!=='message.received' || msg.direction!=='incoming') return;
  const text=msg.text || '[Archivo recibido; requiere revisión de una persona]';
  await appendMessage(c.user_id,lead.jid,'user',text,{eventId:e.id,at:msg.sentAt});
  const stop=/^\s*(stop|unsubscribe|baja|cancelar|no me escribas|no more messages)\s*[.!]?\s*$/i.test(text);
  if(stop || e.metadata?.standby || !msg.text || msg.attachments?.length) {
    await db(supabase.from('leads').update({paused:true,last_error:stop?'El contacto pidió dejar de recibir mensajes.':'Una persona debe revisar esta conversación.',
      ...(stop?{negotiation:{...(lead.negotiation||{}),optedOut:true}}:{})}).eq('id',lead.id)); return;
  }
  if(lead.status==='nuevo') await db(supabase.from('leads').update({status:'negociando'}).eq('id',lead.id));
  await handleInboundMessage({sendMessage:(jid,body)=>sendMessage(c.user_id,jid,body.text)},c.user_id,lead.jid,text,{recorded:true});
}
let running=false;
export async function drainEvents() {
  if(running) return;
  running=true;
  try {
    const events=await db(supabase.rpc('closer_claim_events'));
    for(const event of (events || []).sort((a,b)=>a.received_at.localeCompare(b.received_at))) {
      try { await processEvent(event.payload); await db(supabase.from('zernio_events').update({processed_at:new Date().toISOString(),last_error:null}).eq('id',event.id)); }
      catch(error) { await db(supabase.from('zernio_events').update({last_error:error.message}).eq('id',event.id)); }
    }
  } finally {running=false;}
}
export function startEventWorker() {
  const timer=setInterval(()=>drainEvents().catch(e=>console.error('Webhook worker:',e.message)),5000);
  timer.unref(); return timer;
}
