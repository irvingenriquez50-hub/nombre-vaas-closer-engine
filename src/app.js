import express from 'express';
import { supabase } from './supabase.js';
import { verifySignature, activeMembership, validPhone } from './zernio-policy.js';
import { db, member, status, beginConnection, finishConnection, setBot, settings, configMissing, prepareTemplates } from './zernio-control.js';
import { acceptEvent } from './zernio-events.js';
import { startProcessForNumber } from './queue.js';
import { sendMessage } from './sessions.js';

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
export function createApp() {
  const app=express();
  app.disable('x-powered-by');
  app.get('/health',(_req,res)=>res.json({ok:true,provider:'zernio'}));
  app.post('/webhooks/zernio',express.raw({type:'application/json',limit:'2mb'}),asyncRoute(async(req,res)=>{
    if(!Buffer.isBuffer(req.body) || !verifySignature(req.body,req.get('X-Zernio-Signature'),process.env.ZERNIO_WEBHOOK_SECRET)) return res.sendStatus(401);
    let event; try {event=JSON.parse(req.body.toString('utf8'));} catch {return res.sendStatus(400);}
    await acceptEvent(event);
    res.json({ok:true});
  }));
  app.use(express.json({limit:'32kb'}));
  app.use(asyncRoute(async(req,res,next)=>{
    const token=req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if(!token) return res.status(401).json({ok:false,error:'Inicia sesión para continuar.'});
    const {data,error}=await supabase.auth.getUser(token);
    if(error || !data?.user) return res.status(401).json({ok:false,error:'Tu sesión expiró.'});
    req.actor=data.user;
    req.isAdmin=!!process.env.ADMIN_EMAIL && data.user.email===process.env.ADMIN_EMAIL;
    next();
  }));
  app.param('userId',(req,res,next,id)=>{
    if(!/^[a-f0-9-]{36}$/i.test(id)) return res.status(400).json({ok:false,error:'Usuario inválido.'});
    if(id!==req.actor.id && !req.isAdmin) return res.status(403).json({ok:false,error:'No autorizado.'});
    next();
  });
  app.get('/status/:userId',asyncRoute(async(req,res)=>res.json({ok:true,...await status(req.params.userId)})));
  app.post('/connect/:userId',asyncRoute(async(req,res)=>res.json({ok:true,...await beginConnection(req.params.userId,req.actor.id,req.body?.onboarding)})));
  app.post('/connection/complete',asyncRoute(async(req,res)=>res.json({ok:true,...await finishConnection(req.actor.id,req.body || {})})));
  app.post('/reset/:userId',asyncRoute(async(req,res)=>res.json({ok:true,...await status(req.params.userId,true)})));
  app.post('/bot/:userId',asyncRoute(async(req,res)=>res.json({ok:true,...await setBot(req.params.userId,req.body.enabled)})));
  app.post('/templates/:userId',asyncRoute(async(req,res)=>res.json({ok:true,...await prepareTemplates(req.params.userId)})));
  app.post('/add-lead/:userId',asyncRoute(async(req,res)=>{
    const {userId}=req.params;
    if(!activeMembership(await member(userId))) return res.status(403).json({ok:false,error:'Tu acceso necesita renovación.'});
    if(!validPhone(req.body.phone)) return res.status(400).json({ok:false,error:'Incluye un número válido con código de país.'});
    const result=await startProcessForNumber({sendMessage:(jid,body)=>sendMessage(userId,jid,body.text)},userId,req.body.phone,{skipMessage1:!!req.body.skipMessage1});
    res.status(result.duplicate?409:200).json({ok:!result.duplicate,...result,...(result.duplicate?{error:'Este contacto ya está en tu lista.'}:{})});
  }));
  app.get('/admin/overview',asyncRoute(async(req,res)=>{
    if(!req.isAdmin) return res.sendStatus(403);
    const [global,channels,failedEvents,uncertainSends]=await Promise.all([settings(),
      db(supabase.from('zernio_connections').select('user_id,phone_number,connected,bot_enabled,templates_ready,health_checked_at,last_error')),
      supabase.from('zernio_events').select('id',{count:'exact',head:true}).is('processed_at',null).gte('attempts',12),
      supabase.from('zernio_outbound').select('id',{count:'exact',head:true}).in('state',['unknown','sending'])]);
    if(failedEvents.error || uncertainSends.error) throw new Error('No se pudo revisar el estado de los envíos.');
    res.json({ok:true,globalEnabled:global.sends_enabled,missing:configMissing(),channels,failedEvents:failedEvents.count,uncertainSends:uncertainSends.count});
  }));
  app.post('/admin/sends',asyncRoute(async(req,res)=>{
    if(!req.isAdmin) return res.sendStatus(403);
    if(typeof req.body.enabled!=='boolean') return res.sendStatus(400);
    if(req.body.enabled && configMissing().length) throw new Error('Completa la configuración antes de habilitar los envíos.');
    await db(supabase.from('closer_settings').update({sends_enabled:req.body.enabled}).eq('id',true));
    res.json({ok:true});
  }));
  app.use((error,_req,res,_next)=>{
    console.error('Request failed:',error.code || error.name);
    res.status(error.type==='entity.too.large'?413:error instanceof SyntaxError?400:503).json({ok:false,error:error.message || 'No se pudo completar la operación.'});
  });
  return app;
}
