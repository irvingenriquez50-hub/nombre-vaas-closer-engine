import { supabase } from './supabase.js';
import { zernio } from './zernio-api.js';
import { db, assertCanSend } from './zernio-control.js';
import { actionKey, canonicalPhone, serviceWindowOpen } from './zernio-policy.js';

export async function sendZernio(userId, jid, kind, textOrParams) {
  const c = await assertCanSend(userId);
  const lead = await db(supabase.from('leads').select('*').eq('user_id',userId).eq('jid',jid).single());
  if (lead.paused || lead.status==='cerrado' || lead.negotiation?.manualCollab || lead.negotiation?.optedOut) throw new Error('Este contacto está pausado.');
  if (kind==='text' && !serviceWindowOpen(lead)) throw new Error('La ventana de respuesta terminó. Espera un mensaje del contacto.');
  if (kind!=='text' && !c.templates_ready) throw new Error('Los mensajes todavía no están aprobados.');
  const conversation = await db(supabase.from('zernio_conversations').select('*').eq('user_id',userId).eq('account_id',c.account_id).eq('jid',jid).maybeSingle());
  let path,body;
  if(kind==='text') {
    if(!conversation) throw new Error('Falta recibir un mensaje en esta conexión antes de responder.');
    path=`/inbox/conversations/${encodeURIComponent(conversation.conversation_id)}/messages`;
    body={accountId:c.account_id,message:textOrParams};
  } else {
    path='/inbox/conversations';
    body={accountId:c.account_id,participantId:canonicalPhone(jid),templateName:kind==='opening'?c.opening_template:c.followup_template,
      templateLanguage:c.template_language,templateParams:kind==='opening'?textOrParams:[]};
  }
  const id=actionKey(c.account_id,lead,kind);
  const {data:inserted,error} = await supabase.from('zernio_outbound').insert({id,user_id:userId,lead_id:lead.id,account_id:c.account_id,path,body}).select().maybeSingle();
  if(error && error.code!=='23505') throw new Error('No se pudo registrar el envío.');
  if(!inserted) {
    const prior=await db(supabase.from('zernio_outbound').select('*').eq('id',id).single());
    if(prior.state==='sent' && JSON.stringify(prior.body)===JSON.stringify(body)) return prior.response;
    throw new Error('Este envío necesita revisión; se evitó repetirlo.');
  }
  try {
    // Recheck immediately before the external action, including pauses made during AI generation.
    await assertCanSend(userId);
    const current=await db(supabase.from('leads').select('paused,status,last_inbound_at').eq('id',lead.id).single());
    if(current.paused || current.status==='cerrado' || current.last_inbound_at!==lead.last_inbound_at) throw new Error('La conversación cambió; el mensaje se detuvo.');
    const result=await zernio(path,{method:'POST',body,idempotencyKey:id});
    await db(supabase.from('zernio_outbound').update({state:'sent',response:result}).eq('id',id));
    const conversationId=result.data?.conversationId;
    if(conversationId) await db(supabase.from('zernio_conversations').upsert({user_id:userId,account_id:c.account_id,conversation_id:conversationId,jid},{onConflict:'user_id,account_id,jid'}));
    return result;
  } catch(error) {
    // A timeout/5xx can mean Meta accepted it. Never blindly retry an ambiguous send.
    await db(supabase.from('zernio_outbound').update({state:error.status>=400 && error.status<500?'rejected':'unknown',last_error:error.message}).eq('id',id));
    await db(supabase.from('leads').update({paused:true,last_error:error.message}).eq('id',lead.id));
    throw error;
  }
}
