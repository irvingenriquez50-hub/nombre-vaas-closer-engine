import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactContacts,ownHistory,cleanReply} from '../src/outreach-policy.js';
test('imports deduplicate full numbers, respect lookback and do not infer history from other members',()=>{
 const now=Date.parse('2026-11-16T00:00:00Z');
 const row={phone:'+86 138 0013 8000',created_at:'2026-11-15T00:00:00Z',product:'A'};
 const contacts=compactContacts([row,{...row,product:'B',created_at:'2026-11-15T10:00:00Z'},{...row,phone:'123'},{...row,phone:'+8613900138000',created_at:'2025-01-01'}],now-60*86400000,now);
 assert.equal(contacts.length,1);assert.equal(contacts[0].product,'B');assert.equal(contacts[0].phone,'8613800138000');
 assert.equal(ownHistory(null,false,false,false),'queued');
 assert.equal(ownHistory({status:'dormant'},false,false,false),'review');
 assert.equal(ownHistory(null,false,true,false),'review');
 assert.equal(ownHistory(null,false,false,true),'review');
 assert.equal(ownHistory({negotiation:{optedOut:true}},true,true,true),'blocked');
 assert.equal(ownHistory({negotiation:{manualCollab:true}},false,false,false),'collaborated');
});
test('natural reply formatting preserves prices and ordinary hyphens',()=>{
 const result=cleanReply('**I can do $1,400** — the five-video package.\n- Filming takes time.');
 assert.equal(/[—–*]/.test(result),false);assert.match(result,/\$1,400/);assert.match(result,/five-video/);
});
