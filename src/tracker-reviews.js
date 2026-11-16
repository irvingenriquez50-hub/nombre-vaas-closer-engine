import {supabase} from './supabase.js';
import {db} from './zernio-control.js';
import {withLease} from './autopilot.js';
import {getUserEmail} from './state.js';

export async function drainTrackerReviews() {
 return withLease('tracker-reviews',async()=>{
  const rows=await db(supabase.from('closer_tracker_reviews').select('*').is('sent_at',null).lte('next_attempt_at',new Date().toISOString()).order('created_at').limit(20));
  for(const row of rows) {
   try {
    const url=process.env.CLOSED_DEAL_WEBHOOK_URL,secret=process.env.CLOSED_DEAL_WEBHOOK_SECRET;
    if(!url||!secret) throw new Error('Falta configurar Retainer Tracker.');
    const email=await getUserEmail(row.user_id);
    if(!email) throw new Error('No se encontró el correo de este miembro.');
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-webhook-secret':secret},
     body:JSON.stringify({type:'existing_collaboration',eventKey:'closer-existing:'+row.id,email,phone:row.phone,evidence:row.evidence}),signal:AbortSignal.timeout(10000)});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result?.ok) throw new Error(`Retainer Tracker necesita revisión (${response.status}).`);
    await db(supabase.from('closer_tracker_reviews').update({sent_at:new Date().toISOString(),last_error:null,attempts:row.attempts+1}).eq('id',row.id));
   }catch(error){
    const attempts=row.attempts+1;
    await db(supabase.from('closer_tracker_reviews').update({attempts,last_error:error.message,
     next_attempt_at:new Date(Date.now()+Math.min(3600,60*2**Math.min(attempts,6))*1000).toISOString()}).eq('id',row.id));
   }
  }
 });
}
export function startTrackerReviewWorker(){
 const timer=setInterval(()=>drainTrackerReviews().catch(e=>console.error('Tracker review:',e.message)),30000);
 timer.unref();return timer;
}
