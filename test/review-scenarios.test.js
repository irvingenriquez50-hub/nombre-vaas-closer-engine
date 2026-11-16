import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';process.env.ANTHROPIC_API_KEY='test-only';
const {getNextMove}=await import('../src/negotiate.js');
test('semantic recognition stops both normal negotiation and timed closing before writing a reply',async()=>{
 for(const forceAccept of [false,true]) {
  let brainCalls=0;
  const move=await getNextMove([{role:'user',content:'Our team has your current campaign underway.'}],[{videos:5,anchor:1500,medio:1200,floor:900}],{videos:5,theirLast:1000},{forceAccept,readBrand:async()=>({existingCollaboration:true}),brain:async()=>{brainCalls++;return 'wrong';}});
  assert.equal(move.existingCollaboration,true);assert.equal(move.replyText,null);assert.equal(move.closed,false);assert.equal(brainCalls,0);
 }
});
