import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const u='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222';
test('durable pacing, tenant isolation, decisions and opt-outs survive retries',async()=>{
 const pg=new PGlite();
 try {
  await pg.exec(`create role anon;create role authenticated;create role service_role;
   create table users(id uuid primary key);
   create table leads(id uuid primary key default gen_random_uuid(),user_id uuid references users,phone text,jid text,status text default 'nuevo',
    paused boolean default false,negotiation jsonb,conversation jsonb default '[]',last_error text,followup_count integer default 0,
    dormant_followup_sent boolean default false,added_at timestamptz default now(),updated_at timestamptz default now(),unique(user_id,jid));
   create table zernio_outbound(id text primary key,lead_id uuid,state text);
   insert into users values('${u}'),('${v}');`);
  await pg.exec(await readFile(new URL('../supabase/migrations/20261116054218_closer_autopilot.sql',import.meta.url),'utf8'));
  const slots=await Promise.all(Array.from({length:12},()=>pg.query("select closer_claim_outreach('account-a') as allowed")));
  assert.equal(slots.filter(x=>x.rows[0].allowed).length,1);
  assert.equal((await pg.query("select closer_claim_outreach('account-b') as allowed")).rows[0].allowed,true);
  assert.equal((await pg.query("select closer_claim_outreach('account-a') as allowed")).rows[0].allowed,false);
  await pg.exec("update closer_outreach_clock set next_at=now()-interval '1 second' where account_id='account-a'");
  assert.equal((await pg.query("select closer_claim_outreach('account-a') as allowed")).rows[0].allowed,true);
  await pg.exec(`insert into closer_automation(user_id,consent_at) values('${u}',now());
   insert into closer_contacts(user_id,phone,state) values('${u}','8613800138000','review'),('${v}','8613800138000','blocked');
   insert into leads(user_id,phone,jid,negotiation,conversation) values('${u}','8613800138000','8613800138000','{}','[{"role":"assistant","content":"old"}]');`);
  const before=(await pg.query('select * from leads')).rows[0];
  await pg.query("select closer_contact_decide($1,'8613800138000','send')",[u]);
  let after=(await pg.query('select * from leads')).rows[0];
  assert.notEqual(after.outreach_cycle,before.outreach_cycle);assert.deepEqual(after.conversation,before.conversation);
  assert.equal((await pg.query('select state from closer_contacts where user_id=$1',[v])).rows[0].state,'blocked');
  await pg.query("select closer_contact_decide($1,'8613800138000','collaborated')",[u]);
  after=(await pg.query('select * from leads')).rows[0];assert.equal(after.paused,true);assert.equal(after.negotiation.manualCollab,true);
  await pg.exec(`update leads set negotiation='{"optedOut":true}'`);
  await assert.rejects(()=>pg.query("select closer_contact_decide($1,'8613800138000','send')",[u]));
  await pg.exec(`update leads set negotiation='{}';insert into zernio_outbound values('uncertain','${before.id}','unknown');`);
  await assert.rejects(()=>pg.query("insert into zernio_outbound values('another',$1,'sending')",[before.id]));
  await assert.rejects(()=>pg.query("select closer_contact_decide($1,'8613800138000','send')",[u]));
  assert.equal((await pg.query("select closer_claim_lease('sync:a',$1,600) as claimed",[u])).rows[0].claimed,true);
  assert.equal((await pg.query("select closer_claim_lease('sync:a',$1,600) as claimed",[v])).rows[0].claimed,false);
  await pg.exec('set role authenticated');
  await assert.rejects(()=>pg.query('select * from closer_contacts'));
  await assert.rejects(()=>pg.query("select closer_claim_outreach('account-c')"));
  await assert.rejects(()=>pg.query('delete from leads'));
 }finally{await pg.close();}
});
