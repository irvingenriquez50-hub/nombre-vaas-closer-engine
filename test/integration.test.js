import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {request} from 'node:http';
process.env.SUPABASE_URL='https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
process.env.ANTHROPIC_API_KEY='test-only';
process.env.ZERNIO_API_KEY='test-only';
process.env.ZERNIO_WEBHOOK_SECRET='test-only-secret';
process.env.ADMIN_EMAIL='admin@example.test';
process.env.APP_URL='https://closer.example.test';
process.env.PUBLIC_ENGINE_URL='https://engine.example.test';
process.env.CLOSER_SYNC_SECRET='test-only';
const {supabase}=await import('../src/supabase.js');
const {createApp}=await import('../src/app.js');
const {sendZernio}=await import('../src/zernio-messages.js');
const {finishConnection,setBot}=await import('../src/zernio-control.js');
const {processEvent}=await import('../src/zernio-events.js');
const {digest}=await import('../src/zernio-policy.js');
const {getNextMove}=await import('../src/negotiate.js');
const {syncContacts,prepareNextContact,restrictedMarketing}=await import('../src/autopilot.js');
const u='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222';

// In-memory PostgREST boundary; actual SQL and permissions are tested separately in migration.test.js.
function fakeDb(tables){
  return table=>{
    const rows=tables[table] ||= [];let filters=[],operation='select',body,options={},single=false,start=0,end=Infinity;
    const q={
      select(){return q;},eq(k,val){filters.push(r=>r[k]===val);return q;},is(k,val){filters.push(r=>r[k]==val);return q;},
      gt(k,val){filters.push(r=>r[k]>val);return q;},gte(k,val){filters.push(r=>r[k]>=val);return q;},
      in(k,vals){filters.push(r=>vals.includes(r[k]));return q;},neq(k,val){filters.push(r=>r[k]!==val);return q;},
      maybeSingle(){single=true;return q;},single(){single=true;return q;},
      insert(value){operation='insert';body=value;return q;},upsert(value,opts={}){operation='upsert';body=value;options=opts;return q;},
      update(value){operation='update';body=value;return q;},
      order(){return q;},range(a,b){start=a;end=b+1;return q;},limit(n){end=n;return q;},delete(){operation='delete';return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        let data=rows.filter(r=>filters.every(f=>f(r)));
        if(operation==='insert'||operation==='upsert'){
          const keys=(options.onConflict || 'id').split(',');
          const existing=rows.find(r=>keys.every(k=>body[k]!=null&&r[k]===body[k]));
          if(existing && operation==='insert') return {data:null,error:{code:'23505'}};
          if(existing){if(!options.ignoreDuplicates)Object.assign(existing,body);data=[existing];}
          else {const row={...body};rows.push(row);data=[row];}
        }else if(operation==='update'){data.forEach(r=>Object.assign(r,body));}
        else if(operation==='delete'){for(const row of data) rows.splice(rows.indexOf(row),1);}
        data=data.slice(start,end);
        return {data:single?(data[0]||null):data,error:null};
      }).then(resolve,reject);}
    };return q;
  };
}
function fixture(){return {
  users:[{id:u,status:'active',expires_at:null},{id:v,status:'active',expires_at:null}],
  closer_settings:[{id:true,sends_enabled:true}],
  closer_automation:[{user_id:u,consent_at:new Date().toISOString(),lookback_days:60}],
  closer_contacts:[{user_id:u,phone:'8613800138000',state:'active'}],
  zernio_connections:[{user_id:u,profile_id:'profile1',account_id:'aaaaaaaaaaaaaaaaaaaaaaaa',connected:true,bot_enabled:true,templates_ready:true,health_checked_at:new Date().toISOString(),opening_template:'vaas_opening_message',followup_template:'vaas_followup_message',template_language:'en'}],
  leads:[{id:'lead1',user_id:u,jid:'8613800138000',phone:'8613800138000',status:'negociando',paused:false,last_inbound_at:new Date(Date.now()-10000).toISOString(),last_outbound_at:null,conversation:[]}],
  zernio_conversations:[{user_id:u,account_id:'aaaaaaaaaaaaaaaaaaaaaaaa',conversation_id:'conv1',jid:'8613800138000'}],
};}
function localCall(server,path,{token,body,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{}),...headers}},res=>{
      let text='';res.on('data',c=>text+=c);res.on('end',()=>{let body=text;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,body});});
    });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
}
test('API rejects anonymous and cross-account requests; signed events are durable and deduplicated',async()=>{
  const tables=fixture();mock.method(supabase,'from',fakeDb(tables));
  mock.method(supabase.auth,'getUser',async token=>({data:{user:{id:token==='two'?v:u,email:'member@example.test'}}}));
  const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    assert.equal((await localCall(server,`/status/${u}`)).status,401);
    assert.equal((await localCall(server,`/status/${u}`,{token:'two'})).status,403);
    assert.equal((await localCall(server,'/admin/sends',{token:'one',body:{enabled:true}})).status,403);
    const event={id:'event1',event:'message.received',account:{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa'}};
    assert.equal((await localCall(server,'/webhooks/zernio',{body:event})).status,401);
    const signature=createHmac('sha256',process.env.ZERNIO_WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex');
    for(let i=0;i<2;i++) assert.equal((await localCall(server,'/webhooks/zernio',{body:event,headers:{'X-Zernio-Signature':signature}})).status,200);
    assert.equal(tables.zernio_events.length,1);
  }finally{server.close();mock.restoreAll();}
});
test('paused, expired and human-controlled accounts never call the provider',async()=>{
  for(const setup of [t=>t.closer_settings[0].sends_enabled=false,t=>t.zernio_connections[0].bot_enabled=false,t=>t.users[0].expires_at='2020-01-01',t=>t.leads[0].paused=true]){
    const tables=fixture();setup(tables);let calls=0;
    mock.method(supabase,'from',fakeDb(tables));mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected external request');});
    await assert.rejects(()=>sendZernio(u,'8613800138000','text','hello'));
    assert.equal(calls,0);mock.restoreAll();
  }
});
test('ambiguous provider failure pauses the contact and cannot be blindly retried',async()=>{
  const tables=fixture();let calls=0;mock.method(supabase,'from',fakeDb(tables));
  mock.method(globalThis,'fetch',async()=>{calls++;throw Error('timeout');});
  try{
    await assert.rejects(()=>sendZernio(u,'8613800138000','text','hello'));
    assert.equal(tables.zernio_outbound[0].state,'unknown');assert.equal(tables.leads[0].paused,true);
    tables.leads[0].paused=false;
    await assert.rejects(()=>sendZernio(u,'8613800138000','text','hello'));
    assert.equal(calls,1);
  }finally{mock.restoreAll();}
});
test('successful send uses the owning account and replays without sending twice',async()=>{
  const tables=fixture();let calls=[];mock.method(supabase,'from',fakeDb(tables));
  mock.method(globalThis,'fetch',async(url,opts)=>{calls.push(JSON.parse(opts.body));return new Response(JSON.stringify({success:true,data:{messageId:'sent1'}}),{status:200});});
  try{
    await sendZernio(u,'8613800138000','text','hello');await sendZernio(u,'8613800138000','text','hello');
    assert.equal(calls.length,1);assert.equal(calls[0].accountId,'aaaaaaaaaaaaaaaaaaaaaaaa');
  }finally{mock.restoreAll();}
});
test('callback cannot bind an account from another profile or reuse another user state',async()=>{
  const tables=fixture(),state='a'.repeat(64);tables.zernio_onboarding=[{state_hash:digest(state),user_id:u,actor_id:u,profile_id:'profile1',expires_at:new Date(Date.now()+60000).toISOString(),consumed_at:null}];
  mock.method(supabase,'from',fakeDb(tables));let calls=0;
  mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({accounts:[]}),{status:200});});
  try{
    await assert.rejects(()=>finishConnection(v,{state,profileId:'profile1',accountId:'bbbbbbbbbbbbbbbbbbbbbbbb'}));assert.equal(calls,0);
    await assert.rejects(()=>finishConnection(u,{state,profileId:'profile1',accountId:'bbbbbbbbbbbbbbbbbbbbbbbb'}));assert.equal(calls,1);
    assert.equal(tables.zernio_connections[0].account_id,'aaaaaaaaaaaaaaaaaaaaaaaa');
  }finally{mock.restoreAll();}
});
test('human messages pause only their own conversation; unknown accounts are ignored',async()=>{
  const tables=fixture();mock.method(supabase,'from',fakeDb(tables));mock.method(supabase,'rpc',async()=>({data:{},error:null}));
  const event={id:'human1',event:'message.sent',account:{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa'},conversation:{participantId:'8613800138000'},message:{id:'m1',conversationId:'conv1',platform:'whatsapp',direction:'outgoing',source:'whatsapp_business_app',text:'I will handle this',sentAt:new Date().toISOString()}};
  try{
    await processEvent({...event,account:{accountId:'not-ours'}});assert.equal(tables.leads[0].paused,false);
    await processEvent(event);assert.equal(tables.leads[0].paused,true);
  }finally{mock.restoreAll();}
});
test('a recorded inbound event is not appended twice or given a new service-window timestamp',async()=>{
  const tables=fixture();tables.leads[0].paused=true;let records=[];
  mock.method(supabase,'from',fakeDb(tables));mock.method(supabase,'rpc',async(name,args)=>{records.push(args);return {data:{},error:null};});
  const at='2026-11-14T10:00:00Z',before=tables.leads[0].last_inbound_at;
  try{
    await processEvent({id:'incoming1',event:'message.received',account:{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa'},message:{id:'m1',conversationId:'conv1',platform:'whatsapp',direction:'incoming',sender:{phoneNumber:'+8613800138000'},text:'Hello',sentAt:at,attachments:[]}});
    assert.equal(records.length,1);assert.equal(records[0].p_event,'incoming1');assert.equal(records[0].p_at,new Date(at).toISOString());
    assert.equal(tables.leads[0].last_inbound_at,before);
  }finally{mock.restoreAll();}
});
test('timed close cannot reuse another package offer or accept a price below the floor',async()=>{
  let read={videos:5,theirOffer:500,claimsFinal:true};
  const readBrand=async()=>read;
  try{
    const tiers=[{videos:5,anchor:1200,medio:1000,floor:800},{videos:10,anchor:2000,medio:1700,floor:1500}];
    const prior={videos:10,theirLast:1800,theirBest:2000,repeatCount:3};
    const low=await getNextMove([{role:'user',content:'500 for 5 videos',ts:1}],tiers,prior,{forceAccept:true,readBrand});
    assert.equal(low.closed,false);assert.equal(low.noAction,true);assert.equal(low.negotiation.theirBest,500);
    read={videos:5,theirOffer:900,claimsFinal:true};
    const valid=await getNextMove([{role:'user',content:'900 for 5 videos',ts:1}],tiers,prior,{forceAccept:true,readBrand});
    assert.equal(valid.closed,true);assert.equal(valid.closedPrice,900);assert.equal(valid.closedVideos,5);
  }finally{mock.restoreAll();}
});

test('one-minute throttle defers a different opening without failing or advancing it',async()=>{
 const tables=fixture();let slots=0,calls=0;
 tables.leads.push({...tables.leads[0],id:'lead2',jid:'8613900138000',phone:'8613900138000'});
 tables.closer_contacts.push({user_id:u,phone:'8613900138000',state:'active'});
 mock.method(supabase,'from',fakeDb(tables));
 mock.method(supabase,'rpc',async name=>({data:name==='closer_claim_outreach'?++slots===1:null,error:null}));
 mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({success:true,data:{messageId:'one'}}),{status:200});});
 try {
  await sendZernio(u,'8613800138000','opening',['one']);
  await assert.rejects(()=>sendZernio(u,'8613900138000','opening',['two']),e=>e.code==='OUTREACH_THROTTLED');
  assert.equal(calls,1);assert.equal(tables.zernio_outbound.length,1);assert.equal(tables.leads[1].paused,false);assert.equal(tables.leads[1].last_outbound_at,null);
  await sendZernio(u,'8613800138000','opening',['one']);assert.equal(calls,1);assert.equal(slots,2);
 }finally{mock.restoreAll();}
});

test('daily sync uses only own history, deduplicates and preserves member decisions',async()=>{
 const tables=fixture();tables.closer_contacts=[];
 tables.leads.push({id:'other-lead',user_id:v,jid:'8613900138000',phone:'8613900138000',status:'cerrado'});
 const source=[{phone:'8613800138000'},{phone:'8613900138000'},{phone:'8613900138000'},{phone:'8613700138000'},{phone:'12025550123'}].map(c=>({...c,created_at:new Date().toISOString(),product:'Demo'}));
 mock.method(supabase,'from',fakeDb(tables));mock.method(supabase,'rpc',async()=>({data:true,error:null}));
 mock.method(globalThis,'fetch',async(url)=>new Response(JSON.stringify(String(url).includes('/api/internal/')?{ok:true,contacts:source}:{data:[{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa',platform:'whatsapp',participantId:'8613700138000'}],pagination:{hasMore:false},meta:{accountsQueried:1,accountsFailed:0}}),{status:200}));
 try {
  // A recent preview import must not delay the first history scan after connecting.
  tables.closer_automation[0].last_sync_at=new Date().toISOString();
  await syncContacts(u);
  assert.equal(tables.closer_contacts.length,4);
  assert.equal(tables.closer_contacts.find(c=>c.phone==='8613800138000').state,'review');
  assert.equal(tables.closer_contacts.find(c=>c.phone==='8613700138000').state,'review');
  assert.equal(tables.closer_contacts.find(c=>c.phone==='8613900138000').state,'queued');
  assert.equal(tables.closer_contacts.find(c=>c.phone==='12025550123').state,'review');
  await prepareNextContact(u);
  assert.equal(tables.leads.filter(l=>l.user_id===u&&l.phone==='8613900138000').length,1);
  tables.closer_contacts.find(c=>c.phone==='8613900138000').state='collaborated';
  await syncContacts(u,{force:true});assert.equal(tables.closer_contacts.find(c=>c.phone==='8613900138000').state,'collaborated');
  assert.equal(restrictedMarketing('14165550123'),false,'Canadian +1 is not US');
 }finally{mock.restoreAll();}
});

test('failed history scan cannot promote contacts and contact opt-out persists separately',async()=>{
 const tables=fixture();tables.closer_contacts[0].state='queued';let posts=0;
 mock.method(supabase,'from',fakeDb(tables));mock.method(supabase,'rpc',async()=>({data:true,error:null}));
 mock.method(globalThis,'fetch',async(url,opts)=>{if(opts.method==='POST')posts++;return new Response(JSON.stringify(String(url).includes('/api/internal/')?{ok:true,contacts:[]}:{data:[],meta:{accountsFailed:1}}),{status:200});});
 try{
  await assert.rejects(()=>syncContacts(u,{force:true}));await prepareNextContact(u);
  assert.equal(tables.closer_automation[0].history_checked_at,null);assert.equal(posts,0);
  await processEvent({id:'stop1',event:'message.received',account:{accountId:'aaaaaaaaaaaaaaaaaaaaaaaa'},message:{id:'stop',platform:'whatsapp',conversationId:'conv1',direction:'incoming',sender:{phoneNumber:'8613800138000'},text:'Please stop messaging me',sentAt:new Date().toISOString()}});
  assert.equal(tables.closer_contacts[0].state,'blocked');assert.equal(tables.leads[0].negotiation.optedOut,true);
 }finally{mock.restoreAll();}
});

test('warmer negotiating reply retains the guardrail and strips AI-style typography',async()=>{
 const tiers=[{videos:5,anchor:1500,medio:1100,floor:900}];let prompt='';
 const result=await getNextMove([{role:'user',content:'We provide the script, can you do 800 for five videos?',ts:1}],tiers,
  {videos:5,lastOffer:1500,midRounds:0},{creator:{short_name:'Demo'},readBrand:async()=>({videos:5,theirOffer:800}),brain:async p=>{prompt=p;return 'Having the script helps — I can come down to $1400 for five videos. I still need to prepare the delivery and film the takes so the videos feel natural.';}});
 assert.equal(result.closed,false);assert.equal(result.negotiation.lastOffer,1400);assert.doesNotMatch(result.replyText,/[—–]/);
 assert.match(prompt,/do not charge for writing a script they supply/);assert.match(prompt,/Never claim a paid editor/);assert.match(prompt,/LOWEST number you may state is \$1300/);
});
