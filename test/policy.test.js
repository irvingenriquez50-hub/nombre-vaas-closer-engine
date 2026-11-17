import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifySignature,healthyAccount,activeMembership,serviceWindowOpen,actionKey,profileReady,validPhone,isHumanMessage} from '../src/zernio-policy.js';
import {createZernioClient} from '../src/zernio-api.js';

test('webhook signature binds exact bytes and rejects missing/invalid credentials',()=>{
  const raw=Buffer.from('{"event":"message.received"}');
  const signature=createHmac('sha256','test-secret').update(raw).digest('hex');
  assert.equal(verifySignature(raw,signature,'test-secret'),true);
  for(const [body,sig,key] of [[Buffer.from('{}'),signature,'test-secret'],[raw,'xyz','test-secret'],[raw,signature,''],[raw,'','test-secret']]) assert.equal(verifySignature(body,sig,key),false);
});
test('connection health requires live Meta link, token and inbound subscription',()=>{
  const healthy={platform:'whatsapp',status:'healthy',tokenStatus:{valid:true},platformConnection:{status:'connected',phoneStatus:'CONNECTED',inboundWebhookSubscribed:true}};
  assert.equal(healthyAccount(healthy),true);
  for(const patch of [{tokenStatus:{valid:false}},{platformConnection:{status:'unknown'}},{platformConnection:{status:'connected',inboundWebhookSubscribed:false}},{status:'error'}]) assert.equal(healthyAccount({...healthy,...patch}),false);
});
test('expired access and closed 24h windows prevent sends',()=>{
  assert.equal(activeMembership({status:'active',expires_at:'2020-01-01'}),false);
  assert.equal(activeMembership({status:'pending'}),false);
  assert.equal(activeMembership({status:'active'}),true);
  assert.equal(serviceWindowOpen({last_inbound_at:new Date(Date.now()-23*3600000).toISOString()}),true);
  assert.equal(serviceWindowOpen({last_inbound_at:new Date(Date.now()-24*3600000).toISOString()}),false);
  assert.equal(serviceWindowOpen({}),false);
});
test('prices, recipient identity, human takeover and action identity',()=>{
  const tiers=[{videos:1,anchor:300,floor:200},{videos:5,anchor:1200,floor:800},{videos:10,anchor:2000,floor:1500}];
  assert.equal(profileReady({short_name:'Ana',tiktok_handle:'ana',gmv_total:'100',gmv_30d:'50',market:'US'},tiers),true);
  assert.equal(profileReady({},tiers),false);
  assert.equal(validPhone('bsuid:a12345678910'),false);
  assert.equal(validPhone('+86 138 0013 8000'),true);
  assert.notEqual(actionKey('account1',{id:'lead1'},'opening'),actionKey('account2',{id:'lead1'},'opening'));
  assert.equal(actionKey('a',{id:'lead',outreach_cycle:'cycle',last_inbound_at:'old'},'opening'),actionKey('a',{id:'lead',outreach_cycle:'cycle',last_inbound_at:'new',last_outbound_at:'changed'},'opening'));
  assert.notEqual(actionKey('a',{id:'lead',outreach_cycle:'one'},'opening'),actionKey('a',{id:'lead',outreach_cycle:'two'},'opening'));
  assert.notEqual(actionKey('a',{id:'lead'},'text','reply'),actionKey('a',{id:'lead'},'text','auto_close'));
  assert.equal(isHumanMessage({event:'message.sent',message:{source:'whatsapp_business_app'}}),true);
  assert.equal(isHumanMessage({event:'message.sent',message:{source:'cloud_api',sentVia:'api'}}),false);
});
test('provider adapter uses official URL, bearer token and idempotency; it never blindly retries',async()=>{
  const calls=[];
  const client=createZernioClient({key:'test-only',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({success:true,data:{conversationId:'conv'}}),{status:200});}});
  const response=await client('/inbox/conversations',{method:'POST',body:{accountId:'account',participantId:'8613800138000',templateName:'vaas_opening_message'},idempotencyKey:'stable-key'});
  assert.equal(response.data.conversationId,'conv');
  assert.equal(calls[0].url,'https://zernio.com/api/v1/inbox/conversations');
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-only');
  assert.equal(calls[0].options.headers['Idempotency-Key'],'stable-key');
  let attempts=0;
  const failed=createZernioClient({key:'test',fetchImpl:async()=>{attempts++;throw new Error('timeout');}});
  await assert.rejects(()=>failed('/inbox/conversations',{method:'POST',body:{}}),e=>e.code==='outcome_unknown');
  assert.equal(attempts,1);
});
