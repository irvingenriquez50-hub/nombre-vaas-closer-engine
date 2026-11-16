import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactContacts,ownHistory,cleanReply,existingCollaborationSignal,visibleContact,contactCutoff,historyPhone,deliveryReviewReason} from '../src/outreach-policy.js';
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

test('existing collaborations stop silently, but proposals, negations and other creators do not close a deal',()=>{
 for(const text of ['We already have a collaboration','We already working on collaboration','We are already working on a collaboration','We are already working together','We already work with you',"We've already completed the collaboration",'Ya tenemos una colaboración','Ya estamos trabajando contigo'])
  assert.equal(existingCollaborationSignal(text),'confirmed',text);
 for(const text of ["We don't have a collaboration",'Can we already have a collaboration?',"We already have a collaboration with another creator",'We can do five videos for 800','We would like to collaborate','We have never collaborated with you'])
  assert.equal(existingCollaborationSignal(text),null,text);
 assert.equal(existingCollaborationSignal('What do you mean?'),'review');
});

test('30-day display cutoff keeps historical records out of the queue without treating BSUIDs as phones',()=>{
 const now=Date.parse('2026-11-16T12:00:00Z');
 assert.equal(visibleContact({source_at:new Date(contactCutoff(now)).toISOString()},now),true);
 assert.equal(visibleContact({source_at:new Date(contactCutoff(now)-1).toISOString()},now),false);
 const c={id:'old-chat',accountId:'mine',participantId:'8613800138000',businessScopedUserId:'opaque123',status:'archived'};
 assert.equal(historyPhone(c),'8613800138000');
 assert.equal(historyPhone({...c,participantId:'opaque123'}),null);
 assert.equal(historyPhone({...c,participantId:'opaque123'},[{account_id:'mine',conversation_id:'old-chat',jid:'8613800138000'}]),'8613800138000');
 assert.match(deliveryReviewReason({providerCode:131049}),/no se reintentará/);
});
test('natural reply formatting preserves prices and ordinary hyphens',()=>{
 const result=cleanReply('**I can do $1,400** — the five-video package.\n- Filming takes time.');
 assert.equal(/[—–*]/.test(result),false);assert.match(result,/\$1,400/);assert.match(result,/five-video/);
});
