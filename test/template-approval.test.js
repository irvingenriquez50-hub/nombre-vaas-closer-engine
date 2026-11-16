import {test} from 'node:test';
import assert from 'node:assert/strict';
import {templateVerdict,publicApproval} from '../src/template-approval.js';
test('only the exact Meta template language and current account can appear approved',()=>{
  const result={templates:[{name:'opening',language:'en_US',status:'APPROVED'}]};
  assert.equal(templateVerdict(result,'opening','en').status,'NOT_SUBMITTED');
  assert.equal(templateVerdict(result,'opening','en_US').status,'APPROVED');
  assert.throws(()=>templateVerdict({},'opening','en'));
  assert.equal(publicApproval({account_id:'new',templates_ready:true,template_review:{accountId:'old',opening:{status:'APPROVED'}}}).opening.status,'UNKNOWN');
  assert.equal(publicApproval(null).opening.status,'NOT_SUBMITTED');
});
