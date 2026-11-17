import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {templateVerdict,publicApproval} from '../src/template-approval.js';
import {OPENING_BODY,openingParams,renderOpening} from '../src/whatsapp-templates.js';
test('opening template is exactly the original copy supplied by the owner',()=>{
  const original=readFileSync(new URL('./fixtures/opening-template.txt',import.meta.url),'utf8').replace(/\r\n/g,'\n').trimEnd();
  assert.equal(OPENING_BODY,original);
});
test('only the exact Meta template language and current account can appear approved',()=>{
  const result={templates:[{name:'opening',language:'en_US',status:'APPROVED'}]};
  assert.equal(templateVerdict(result,'opening','en').status,'NOT_SUBMITTED');
  assert.equal(templateVerdict(result,'opening','en_US').status,'APPROVED');
  assert.throws(()=>templateVerdict({},'opening','en'));
  assert.equal(publicApproval({account_id:'new',templates_ready:true,template_review:{accountId:'old',opening:{status:'APPROVED'}}}).opening.status,'UNKNOWN');
  assert.equal(publicApproval(null).opening.status,'NOT_SUBMITTED');
});

test('approval never accepts another body under the same template name',()=>{
  const row={name:'vaas_opening_message',language:'en',status:'APPROVED',components:[{type:'BODY',text:'Hi! An unauthorized rewrite.'}]};
  assert.equal(templateVerdict({templates:[row]},row.name,'en',OPENING_BODY).status,'CONTENT_MISMATCH');
  row.components[0].text=OPENING_BODY;
  assert.equal(templateVerdict({templates:[row]},row.name,'en',OPENING_BODY).status,'APPROVED');
});

test('eight opening fields preserve creator values and use anchors, never negotiation mid or floor',()=>{
  const fields={gmvTotal:'$12M',market:'Spanish-speaking',shortName:'ruben',gmv30d:'256K',tiktokHandle:'@alwaysshoppin'};
  const tiers=[{videos:10,anchor:'4000',medio:3750,floor:3500},{videos:1,anchor:500,medio:450,floor:400},{videos:5,anchor:2250,medio:2100,floor:1900}];
  const before=JSON.stringify(tiers);
  const params=openingParams(fields,tiers);
  assert.deepEqual(params,['12M','Spanish-speaking','ruben','500','2250','4000','256K','alwaysshoppin']);
  const rendered=renderOpening(params);
  assert.match(rendered,/\$12M GMV within the Spanish-speaking U.S. audience/);
  assert.match(rendered,/ruben — RATES/);
  assert.match(rendered,/5x Videos\/Month — \$2250\n\(10% discount applied\)/);
  assert.match(rendered,/10x Videos\/Month — \$4000\n\(20% discount applied\)/);
  assert.equal(JSON.stringify(tiers),before);
  assert.doesNotMatch(rendered,/\{\{|@@|\$\$/);
});
