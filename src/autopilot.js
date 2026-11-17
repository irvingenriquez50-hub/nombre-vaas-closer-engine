import {randomUUID} from 'node:crypto';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
import {supabase} from './supabase.js';
import {db,connection,member} from './zernio-control.js';
import {activeMembership,canonicalPhone,validPhone} from './zernio-policy.js';
import {zernio} from './zernio-api.js';
import {compactContacts,ownHistory,hold,CONTACT_DAYS,contactCutoff,visibleContact,historyPhone,deliveryReviewReason} from './outreach-policy.js';
import {reviewContact} from './contact-review.js';

export async function withLease(scope,fn,{seconds=600,busy=null}={}) {
 const owner=randomUUID();
 if(!await db(supabase.rpc('closer_claim_lease',{p_scope:scope,p_owner:owner,p_seconds:seconds}))) return busy;
 try{return await fn();}finally{await db(supabase.from('closer_leases').delete().eq('scope',scope).eq('owner',owner));}
}
export async function allRows(table,userId,columns='*') {
 const rows=[];
 for(let offset=0;;offset+=500) {
  const page=await db(supabase.from(table).select(columns).eq('user_id',userId).order(table==='closer_contacts'?'phone':table==='zernio_conversations'?'jid':'id').range(offset,offset+499));
  rows.push(...page); if(page.length<500) return rows;
  if(offset>=49500) throw new Error('Demasiados contactos para sincronizar de una vez. Requiere revisión.');
 }
}
export async function automation(userId) {
 await db(supabase.from('closer_automation').upsert({user_id:userId},{onConflict:'user_id',ignoreDuplicates:true}));
 return db(supabase.from('closer_automation').select('*').eq('user_id',userId).single());
}
export async function saveAutomation(userId,actorId,body) {
 if(body.lookbackDays!==CONTACT_DAYS || typeof body.consent!=='boolean') throw new Error('La lista usa los últimos 30 días. Confirma el permiso de contacto.');
 const old=await automation(userId);
 await db(supabase.from('closer_automation').update({lookback_days:body.lookbackDays,
  consent_at:body.consent?(old.consent_at||new Date().toISOString()):null,consent_actor:body.consent?actorId:null,
  ...(old.lookback_days!==body.lookbackDays?{last_sync_at:null}:{}),updated_at:new Date().toISOString()}).eq('user_id',userId));
 return automationStatus(userId);
}
export function restrictedMarketing(phone) {return parsePhoneNumberFromString('+'+phone)?.country==='US';}

async function providerHistory(c,links) {
 const phones=new Set(); let cursor;
 for(let page=0;page<30;page++) {
  const qs=new URLSearchParams({platform:'whatsapp',accountId:c.account_id,profileId:c.profile_id,limit:'100'});
  if(cursor) qs.set('cursor',cursor);
  const result=await zernio('/inbox/conversations?'+qs);
  if(!Array.isArray(result.data) || result.meta?.accountsFailed>0 || result.meta?.accountsQueried===0 || result.meta?.accountsSkipped?.some(a=>a.accountId===c.account_id)) throw new Error('No se pudo comprobar tu historial de WhatsApp.');
  for(const row of result.data) {
   const account=typeof row.accountId==='object'?row.accountId?._id:row.accountId;
   if(account!==c.account_id || row.platform!=='whatsapp') throw new Error('El historial no corresponde a tu conexión.');
   const phone=historyPhone({...row,accountId:account},links);
   if(phone) phones.add(phone);
  }
  if(!result.pagination?.hasMore) return phones;
  if(!result.pagination.nextCursor || result.pagination.nextCursor===cursor) break;
  cursor=result.pagination.nextCursor;
 }
 throw new Error('Tu historial necesita una revisión adicional antes de los envíos automáticos.');
}

export async function syncContacts(userId,{force=false}={}) {
 if(!activeMembership(await member(userId))) throw new Error('Tu acceso necesita renovación.');
 return withLease('sync:'+userId,async()=>{
  const a=await automation(userId);
  const c=await connection(userId);
  const needsHistory=c?.connected && (!a.history_checked_at || a.history_account_id!==c.account_id);
  if(!force && !needsHistory && a.last_sync_at && Date.now()-Date.parse(a.last_sync_at)<15*60000) return {synced:false};
  try {
   const now=Date.now(),since=contactCutoff(now);
   if(!process.env.CLOSER_SYNC_SECRET || !process.env.APP_URL) throw new Error('Falta configurar la importación automática.');
   const url=new URL('/api/internal/closer-contacts',process.env.APP_URL);
   url.searchParams.set('days',String(CONTACT_DAYS));
   if(a.last_sync_at) url.searchParams.set('since',new Date(Math.max(since,Date.parse(a.last_sync_at)-86400000)).toISOString());
   const response=await fetch(url,{headers:{'x-closer-sync':process.env.CLOSER_SYNC_SECRET},signal:AbortSignal.timeout(40000)});
   if(!response.ok) throw new Error('No se pudo importar la lista. Se volverá a intentar automáticamente.');
   const source=await response.json();
   if(!source.ok || !Array.isArray(source.contacts)) throw new Error('La lista de contactos no está disponible.');
   const [leads,deals,outbound,existing,links]=await Promise.all([
    allRows('leads',userId,'id,phone,jid,status,paused,negotiation,last_inbound_at,last_outbound_at,last_error'),allRows('closed_deals',userId,'id,phone'),allRows('zernio_outbound',userId,'id,lead_id,state'),allRows('closer_contacts',userId),
    allRows('zernio_conversations',userId,'account_id,conversation_id,jid')]);
   const own=new Map(leads.map(l=>[canonicalPhone(l.phone),l]));
   const closed=new Set(deals.map(d=>canonicalPhone(d.phone)));
   const attempts=new Set(outbound.map(o=>o.lead_id));
   const prior=new Map(existing.map(x=>[x.phone,x]));
   // Preview may import without a connection; sending requires a successful account-scoped scan.
   const history=c?.connected?await providerHistory(c,links):new Set();
   let count=0;const additions=[];
   const incoming=compactContacts(source.contacts,since,now);
   // Reconcile every eligible queued contact, even when the source import is incremental.
   // A later history sync must catch older queue entries, not just today's new rows.
   const candidates=new Map(existing.filter(r=>visibleContact(r,now)).map(r=>[r.phone,r]));
   for(const row of incoming) {
    const old=prior.get(row.phone);
    if(old && (!old.source_at || row.source_at>old.source_at)) {
     await db(supabase.from('closer_contacts').update(row).eq('user_id',userId).eq('phone',row.phone));
     Object.assign(old,row);
    }
    candidates.set(row.phone,row);
   }
   for(const row of candidates.values()) {
    const previous=prior.get(row.phone),lead=own.get(row.phone);
    let state=ownHistory(lead,closed.has(row.phone),attempts.has(lead?.id),history.has(row.phone));
    let reason=state==='review'?(lead?.last_error?deliveryReviewReason(lead.last_error):'Tienes historial con este contacto. Revisa antes de escribir.'):null;
    if(history.has(row.phone)) reason='Ya hay una conversación en tu WhatsApp. Revisa antes de escribir.';
    if(restrictedMarketing(row.phone) && state==='queued') {state='review';reason='WhatsApp limita las plantillas de marketing a números de EE. UU. Abre WhatsApp para revisar.';}
    if(previous) {
     if(previous.state==='active' && lead?.status==='nuevo' && history.has(row.phone) && !previous.reviewed_at) {
      await reviewContact(userId,row.phone,'Apareció una conversación antes del primer mensaje. Revisa WhatsApp.','whatsapp');
      continue;
     }
     // Never resurrect a member decision or overwrite an active conversation during imports.
     if(previous.state!=='queued') continue;
     if(state==='queued') continue;
     await db(supabase.from('closer_contacts').update({state,reason,history_source:history.has(row.phone)?'whatsapp':'closer'}).eq('user_id',userId).eq('phone',row.phone).eq('state','queued'));
    } else {
     additions.push({...row,user_id:userId,state,reason,
      history_source:history.has(row.phone)?'whatsapp':lead||closed.has(row.phone)?'closer':null});
     count++;
    }
   }
   for(let offset=0;offset<additions.length;offset+=200) await db(supabase.from('closer_contacts').upsert(additions.slice(offset,offset+200),{onConflict:'user_id,phone',ignoreDuplicates:true}));
   await db(supabase.from('closer_automation').update({last_sync_at:new Date().toISOString(),last_error:null,
    history_checked_at:c?.connected?new Date().toISOString():null,history_account_id:c?.connected?c.account_id:null}).eq('user_id',userId));
   return {synced:true,imported:count};
  } catch(error) {
   await db(supabase.from('closer_automation').update({last_error:error.message,history_checked_at:null}).eq('user_id',userId)); throw error;
  }
 },{busy:{synced:false,busy:true}});
}

export async function prepareNextContact(userId) {
 const [a,c]=await Promise.all([automation(userId),connection(userId)]);
 if(!a.consent_at || !a.history_checked_at || a.history_account_id!==c?.account_id || a.last_error || Date.now()-Date.parse(a.history_checked_at)>30*60000) return;
 const rows=await db(supabase.from('closer_contacts').select('*').eq('user_id',userId).eq('state','queued')
  .gte('source_at',new Date(contactCutoff()).toISOString()).order('source_at').limit(1));
 for(const row of rows) await withLease('lead:'+userId+':'+row.phone,async()=>{
  const existing=await db(supabase.from('leads').select('*').eq('user_id',userId).eq('jid',row.phone).maybeSingle());
  if(existing) {
   await db(supabase.from('closer_contacts').update({state:'review',reason:'Ya tienes historial. Revisa la conversación.'}).eq('user_id',userId).eq('phone',row.phone).eq('state','queued')); return;
  }
  const result=await supabase.from('leads').insert({user_id:userId,phone:row.phone,jid:row.phone,status:'nuevo',negotiation:{contactSource:'VAAS community contact list'}});
  if(result.error && result.error.code!=='23505') throw new Error('No se pudo preparar el contacto.');
  await db(supabase.from('closer_contacts').update({state:result.error?'review':'active'}).eq('user_id',userId).eq('phone',row.phone).eq('state','queued'));
 });
}
export async function assertOutreach(userId,lead,kind) {
 const a=await automation(userId);
 if(!a.consent_at) throw hold('Confirma el permiso para contactar antes de activar.');
 if(restrictedMarketing(canonicalPhone(lead.phone))) throw hold('Las plantillas de marketing a números de EE. UU. necesitan revisión.');
 const item=await db(supabase.from('closer_contacts').select('*').eq('user_id',userId).eq('phone',canonicalPhone(lead.phone)).maybeSingle());
 if(item && ['blocked','skipped','collaborated','review'].includes(item.state)) throw hold('Revisa este contacto antes de enviar.');
 if(kind==='opening' && (!item || item.state!=='active')) throw hold('Confirma este primer mensaje en Contactos.');
 if(kind==='opening' && item?.source_id && !item.reviewed_at) {
  if(!visibleContact(item)) throw hold('Este contacto ya está fuera de los últimos 30 días.');
  const c=await connection(userId);
  if(a.last_error || !a.history_checked_at || a.history_account_id!==c?.account_id || Date.now()-Date.parse(a.history_checked_at)>30*60000) throw hold('Espera a que termine la revisión de tu historial.');
 }
}
export async function decideContact(userId,phone,action) {
 if(!activeMembership(await member(userId))) throw new Error('Tu acceso necesita renovación.');
 if(!validPhone(phone)) throw new Error('Número inválido.');
 if(action==='send' && restrictedMarketing(canonicalPhone(phone))) throw new Error('Meta restringe las plantillas de marketing a números de EE. UU. Revisa la conversación desde WhatsApp.');
 await db(supabase.rpc('closer_contact_decide',{p_user:userId,p_phone:canonicalPhone(phone),p_action:action}));
 return automationStatus(userId);
}
export async function manageLead(userId,leadId,action) {
 const lead=await db(supabase.from('leads').select('*').eq('user_id',userId).eq('id',leadId).single());
 const phone=canonicalPhone(lead.phone);
 if(!validPhone(phone)) throw new Error('Revisa el número completo.');
 await db(supabase.from('closer_contacts').upsert({user_id:userId,phone,state:ownHistory(lead,false,false,false),history_source:'closer'},
  {onConflict:'user_id,phone',ignoreDuplicates:true}));
 if(action==='pause' || action==='resume') {
  const contact=await db(supabase.from('closer_contacts').select('state').eq('user_id',userId).eq('phone',phone).single());
  if(action==='resume' && (lead.negotiation?.optedOut || lead.negotiation?.manualCollab || ['blocked','collaborated','skipped'].includes(contact.state))) throw new Error('Este contacto no puede reanudarse automáticamente.');
  await db(supabase.from('leads').update({paused:action==='pause',updated_at:new Date().toISOString()}).eq('id',leadId).eq('user_id',userId));
 } else await decideContact(userId,phone,action);
 return {ok:true};
}
export async function automationStatus(userId) {
 const a=await automation(userId);
 const contacts=(await allRows('closer_contacts',userId)).filter(r=>visibleContact(r));
 const leads=await allRows('leads',userId,'id,phone,status,paused,last_outbound_at,last_inbound_at,last_error');
 const byPhone=new Map(leads.map(l=>[canonicalPhone(l.phone),l]));
 const counts={queued:0,review:0,active:0,skipped:0,collaborated:0,blocked:0,sentToday:0};
 for(const row of contacts) counts[row.state]++;
 const today=new Date().toISOString().slice(0,10);
 for(const l of leads) if(l.last_outbound_at?.startsWith(today)) counts.sentToday++;
 return {settings:{lookbackDays:CONTACT_DAYS,consent:!!a.consent_at,lastSync:a.last_sync_at,error:a.last_error,historyChecked:!!a.history_checked_at},counts,
  contacts:contacts.sort((x,y)=>(y.source_at||'').localeCompare(x.source_at||'')).map(row=>({...row,lead:byPhone.get(row.phone)||null})),
  cadenceSeconds:60,replyMinutes:Math.round(Number(process.env.REPLY_DEBOUNCE_SECONDS||300)/60)};
}
