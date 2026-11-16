import {supabase} from './supabase.js';
import {db} from './zernio-control.js';
import {canonicalPhone} from './zernio-policy.js';

export async function reviewContact(userId,phone,reason,history=null) {
 await db(supabase.rpc('closer_review_contact',{p_user:userId,p_phone:canonicalPhone(phone),p_reason:reason,p_history:history}));
}
export async function markExistingCollaboration(userId,jid,evidence,eventId=null) {
 await db(supabase.rpc('closer_existing_collaboration',{p_user:userId,p_jid:jid,p_evidence:String(evidence||'').slice(0,2000),p_event:eventId}));
}
