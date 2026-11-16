import {automation} from './autopilot.js';
import { randomBytes } from 'node:crypto';
import { supabase } from './supabase.js';
import { zernio } from './zernio-api.js';
import { digest, healthyAccount, activeMembership, profileReady, canonicalPhone, validPhone } from './zernio-policy.js';
import {templateVerdict,publicApproval} from './template-approval.js';

export async function db(query) {
  const { data, error } = await query;
  if (error) throw new Error(`No se pudo guardar o leer el estado (${error.code || 'database'}).`);
  return data;
}
export const connection = userId => db(supabase.from('zernio_connections').select('*').eq('user_id', userId).maybeSingle());
export const settings = () => db(supabase.from('closer_settings').select('*').eq('id', true).single());
export const member = userId => db(supabase.from('users').select('id,status,expires_at').eq('id', userId).single());
export const saveConnection = (userId, patch) => db(supabase.from('zernio_connections').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId));
export function configMissing() {
  return ['ZERNIO_API_KEY','ZERNIO_WEBHOOK_SECRET','APP_URL','PUBLIC_ENGINE_URL','ADMIN_EMAIL','ANTHROPIC_API_KEY','CLOSER_SYNC_SECRET'].filter(k => !process.env[k]);
}
function publicUrl(name) {
  const url = new URL(process.env[name]);
  if (url.protocol !== 'https:') throw new Error('La conexión necesita una dirección HTTPS del sistema.');
  return url.origin;
}
export async function refreshConnection(userId, force = false) {
  let c = await connection(userId);
  if (!c?.account_id) return c;
  if (!force && c.health_checked_at && Date.now() - Date.parse(c.health_checked_at) < 60000) return c;
  let patch;
  try {
    const [health, opening, followup] = await Promise.all([
      zernio(`/accounts/${encodeURIComponent(c.account_id)}/health`),
      zernio(`/whatsapp/templates?${new URLSearchParams({accountId:c.account_id,name:c.opening_template,language:c.template_language})}`),
      zernio(`/whatsapp/templates?${new URLSearchParams({accountId:c.account_id,name:c.followup_template,language:c.template_language})}`),
    ]);
    const template_review={accountId:c.account_id,checkedAt:new Date().toISOString(),
      opening:templateVerdict(opening,c.opening_template,c.template_language),
      followup:templateVerdict(followup,c.followup_template,c.template_language)};
    const connected = healthyAccount(health);
    patch = { connected, template_review, templates_ready: template_review.opening.status==='APPROVED' && template_review.followup.status==='APPROVED',
      health_checked_at:new Date().toISOString(), last_error: connected ? null : 'Revisa o vuelve a conectar tu número.',
      ...(!connected ? {bot_enabled:false} : {}) };
  } catch {
    patch = {connected:false,templates_ready:false,template_review:{accountId:c.account_id,opening:{status:'UNKNOWN'},followup:{status:'UNKNOWN'},checkedAt:null}, health_checked_at:new Date().toISOString(), last_error:'No pudimos comprobar la conexión. Vuelve a revisar en un minuto.'};
  }
  const saved=await db(supabase.from('zernio_connections').update({...patch,updated_at:new Date().toISOString()})
    .eq('user_id',userId).eq('account_id',c.account_id).select('*').maybeSingle());
  return saved || connection(userId);
}
export async function status(userId, force = false) {
  const missing = configMissing();
  const [c, user, global, script, tiers] = await Promise.all([
    missing.length ? connection(userId) : refreshConnection(userId,force), member(userId),settings(),
    db(supabase.from('scripts').select('*').eq('user_id',userId).maybeSingle()),
    db(supabase.from('pricing_tiers').select('videos,anchor,medio,floor').eq('user_id',userId)),
  ]);
  const a=await automation(userId);
  const ready = profileReady(script,tiers || []);
  const checks = [
    {key:'setup',label:'Sistema configurado',ok:missing.length===0},
    {key:'membership',label:'Acceso vigente',ok:activeMembership(user)},
    {key:'connection',label:'WhatsApp conectado',ok:!!c?.connected},
    {key:'profile',label:'Perfil y precios guardados',ok:!!ready},
    {key:'templates',label:'Mensajes aprobados por WhatsApp',ok:!!c?.templates_ready},
    {key:'consent',label:'Permiso de contacto confirmado',ok:!!a.consent_at},
    {key:'global',label:'Envíos habilitados por el administrador',ok:!!global.sends_enabled},
  ];
  return {connected:!!c?.connected,botEnabled:!!c?.bot_enabled,phone:c?.phone_number || null,
    canActivate:checks.every(x=>x.ok), checks, approval:publicApproval(c), error:c?.last_error || null, provider:'zernio'};
}
export async function assertCanSend(userId) {
  const [c,user,global] = await Promise.all([refreshConnection(userId),member(userId),settings()]);
  if (!(await automation(userId)).consent_at || configMissing().length || !global.sends_enabled || !activeMembership(user) || !c?.bot_enabled || !c?.connected) {
    const error = new Error('El bot está pausado o la conexión necesita atención.'); error.code='BOT_PAUSED'; throw error;
  }
  return c;
}
export async function setBot(userId, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Estado de bot inválido.');
  if (enabled && !(await status(userId,true)).canActivate) throw new Error('Completa los pasos pendientes antes de activar el bot.');
  await saveConnection(userId,{bot_enabled:enabled});
  return status(userId);
}
async function ensureWebhook(profileId) {
  const url = `${publicUrl('PUBLIC_ENGINE_URL')}/webhooks/zernio`;
  const name = `Closer ${profileId}`;
  const {webhooks=[]} = await zernio('/webhooks/settings');
  const old = webhooks.find(w=>w.name===name && w.url===url);
  const body = {name,url,secret:process.env.ZERNIO_WEBHOOK_SECRET,
    events:['message.received','message.sent','message.failed','message.delivered','message.read','account.disconnected'],profileIds:[profileId],isActive:true};
  await zernio('/webhooks/settings',{method:old?'PUT':'POST',body:{...body,...(old?{webhookId:old._id}:{})}});
}
export async function beginConnection(userId, actorId, onboarding = 'business_app') {
  if (configMissing().length) throw new Error('El administrador debe terminar la configuración de Zernio.');
  if (!activeMembership(await member(userId))) throw new Error('Tu acceso necesita renovación.');
  if (!['business_app','api'].includes(onboarding)) throw new Error('Tipo de conexión inválido.');
  let c = await connection(userId);
  if (!c) {
    const externalId = `closer:${publicUrl('APP_URL')}:${userId}`;
    const result = await zernio(`/profiles?${new URLSearchParams({externalId})}`);
    let profile = result.profiles?.find(p=>p.externalId===externalId);
    if (!profile) {
      try { profile = (await zernio('/profiles',{method:'POST',body:{name:`Closer ${userId}`,externalId},idempotencyKey:digest(externalId)})).profile; }
      catch (err) {
        if(err.status!==409) throw err;
        profile = (await zernio(`/profiles?${new URLSearchParams({externalId})}`)).profiles?.find(p=>p.externalId===externalId);
      }
    }
    if (!profile?._id) throw new Error('No se pudo preparar el perfil de WhatsApp.');
    await db(supabase.from('zernio_connections').upsert({user_id:userId,profile_id:profile._id},{onConflict:'user_id',ignoreDuplicates:true}));
    c = await connection(userId);
  }
  await saveConnection(userId,{bot_enabled:false});
  await ensureWebhook(c.profile_id);
  const state = randomBytes(32).toString('hex');
  await db(supabase.from('zernio_onboarding').insert({state_hash:digest(state),user_id:userId,actor_id:actorId,profile_id:c.profile_id,expires_at:new Date(Date.now()+3600000).toISOString()}));
  const redirect = new URL('/auth/zernio/callback',publicUrl('APP_URL'));
  redirect.searchParams.set('state',state);
  const result = await zernio(`/connect/whatsapp?${new URLSearchParams({profileId:c.profile_id,redirect_url:redirect.toString(),signup:'hosted',onboarding,brandName:'VAAS Closer',language:'es'})}`);
  const auth = new URL(result.authUrl);
  if (auth.protocol!=='https:' || !(auth.hostname==='zernio.com' || auth.hostname.endsWith('.zernio.com') || auth.hostname.endsWith('.facebook.com'))) throw new Error('Enlace de conexión inesperado.');
  return {authUrl:auth.toString()};
}
export async function finishConnection(actorId, {state, accountId, profileId}) {
  if (!/^[a-f0-9]{64}$/.test(state || '') || !/^[a-f0-9]{24}$/i.test(accountId || '')) throw new Error('Conexión inválida. Vuelve a empezar.');
  const pending = await db(supabase.from('zernio_onboarding').select('*').eq('state_hash',digest(state)).eq('actor_id',actorId).is('consumed_at',null).gt('expires_at',new Date().toISOString()).maybeSingle());
  if (!pending || pending.profile_id!==profileId) throw new Error('La conexión expiró o pertenece a otra cuenta.');
  const result = await zernio(`/accounts?${new URLSearchParams({profileId:pending.profile_id,platform:'whatsapp',search:accountId})}`);
  const account = result.accounts?.find(a=>a._id===accountId && a.platform==='whatsapp');
  if (!account) throw new Error('Ese número no pertenece al perfil que se está conectando.');
  const phone = canonicalPhone(account.username);
  if (!validPhone(account.username)) throw new Error('Zernio todavía no confirmó el número.');
  const userId = await db(supabase.rpc('closer_finish_onboarding',{p_hash:digest(state),p_actor:actorId,p_account:accountId,p_phone:phone}));
  await refreshConnection(userId,true);
  try { await syncSavedTemplates(userId); }
  catch { await saveConnection(userId,{last_error:'Número conectado. Falta preparar o revisar la aprobación de los mensajes.'}); }
  return {userId};
}
export async function prepareTemplates(userId) {
  if(!activeMembership(await member(userId))) throw new Error('Tu acceso necesita renovación.');
  const c=await connection(userId);
  if(!c?.account_id) throw new Error('Conecta tu WhatsApp primero.');
  const [script,tiers]=await Promise.all([
    db(supabase.from('scripts').select('*').eq('user_id',userId).maybeSingle()),
    db(supabase.from('pricing_tiers').select('videos,anchor,medio,floor').eq('user_id',userId))]);
  if(!profileReady(script,tiers || [])) throw new Error('Completa y guarda Tu escrito y tus precios antes de solicitar aprobación.');
  const templates=[
    {name:c.opening_template,text:'Hi! I have generated ${{1}} in GMV for the {{2}} audience. I am {{3}} from the VAAS community. My packages are: 1 video for ${{4}}, 5 for ${{5}}, or 10 for ${{6}}. Last 30 days GMV: ${{7}}. TikTok: @{{8}}. Would you like to discuss a paid collaboration? Reply STOP to opt out.',example:['200000','Spanish-speaking','Alex','300','1200','2000','20000','alexcreator']},
    {name:c.followup_template,text:'Hi! Would you like to continue discussing our paid collaboration? Reply STOP if you prefer not to receive more messages.',example:[]},
  ];
  for(const t of templates){
    const list=await zernio(`/whatsapp/templates?${new URLSearchParams({accountId:c.account_id,name:t.name,language:c.template_language})}`);
    if(list.templates?.some(x=>x.name===t.name && x.language===c.template_language)) continue;
    await zernio('/whatsapp/templates',{method:'POST',body:{accountId:c.account_id,name:t.name,category:'MARKETING',language:c.template_language,
      components:[{type:'BODY',text:t.text,...(t.example.length?{example:{body_text:[t.example]}}:{})}]}});
  }
  return status(userId,true);
}

export async function syncSavedTemplates(userId) {
  const current=await status(userId,true);
  if(!current.connected || !current.checks.find(c=>c.key==='profile')?.ok) return current;
  // Existing approved/pending/rejected variants are never recreated by saving variable values.
  return prepareTemplates(userId);
}
