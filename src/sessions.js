import { supabase } from './supabase.js';
import { sweepTimers } from './queue.js';
import { db, status, assertCanSend } from './zernio-control.js';
import { sendZernio } from './zernio-messages.js';

export const getSessionInfo = status;
export const sendMessage = (userId,jid,text) => sendZernio(userId,jid,'text',text);
export const sendOpeningTemplate = (userId,jid,params) => sendZernio(userId,jid,'opening',params);
export const sendFollowupTemplate = (userId,jid) => sendZernio(userId,jid,'followup',[]);
let running=false;
export async function runSweep() {
  if(running) return;
  running=true;
  try {
    const channels=await db(supabase.from('zernio_connections').select('user_id').eq('bot_enabled',true));
    for(const {user_id} of channels || []) {
      try {
        await assertCanSend(user_id);
        await sweepTimers({sendMessage:(jid,body)=>sendMessage(user_id,jid,body.text)},user_id);
      } catch(e) { if(e.code!=='BOT_PAUSED') console.error('Sweep:',user_id,e.message); }
    }
  } finally {running=false;}
}
export function startGlobalSweep() {
  const timer=setInterval(()=>runSweep().catch(e=>console.error('Sweep:',e.message)),60000);
  timer.unref(); return timer;
}
