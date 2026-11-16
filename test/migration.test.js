import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('database migration: paused default, tenant uniqueness, one-use onboarding, atomic inbox and restricted access',async()=>{
  const pg=new PGlite();
  try{
    await pg.exec(`create role anon;create role authenticated;create role service_role;
      create table public.users(id uuid primary key);
      create table public.whatsapp_channels(user_id uuid primary key,d360_api_key text);
      create table public.leads(id uuid primary key default gen_random_uuid(),user_id uuid references public.users(id),jid text,
        conversation jsonb not null default '[]',last_inbound_at timestamptz,updated_at timestamptz,unique(user_id,jid));
      insert into public.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
      insert into public.whatsapp_channels values('11111111-1111-4111-8111-111111111111','legacy-preserved');`);
    await pg.exec(await readFile(new URL('../supabase/migrations/20261116033514_zernio_onboarding.sql',import.meta.url),'utf8'));
    await pg.exec(await readFile(new URL('../supabase/migrations/20261116095707_template_approval_status.sql',import.meta.url),'utf8'));
    assert.equal((await pg.query('select sends_enabled from closer_settings')).rows[0].sends_enabled,false);
    assert.equal((await pg.query('select d360_api_key from whatsapp_channels')).rows[0].d360_api_key,'legacy-preserved');
    const u='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222';
    await pg.query('insert into zernio_connections(user_id,profile_id) values($1,$2),($3,$4)',[u,'profile1',v,'profile2']);
    assert.deepEqual((await pg.query('select template_review from zernio_connections where user_id=$1',[u])).rows[0].template_review,{});
    await pg.query("insert into zernio_onboarding(state_hash,user_id,actor_id,profile_id,expires_at) values('nonce',$1,$1,'profile1',now()+interval '1 hour')",[u]);
    await assert.rejects(()=>pg.query("select closer_finish_onboarding('nonce',$1,'account1','8613800138000')",[v]));
    await pg.query("select closer_finish_onboarding('nonce',$1,'account1','8613800138000')",[u]);
    await assert.rejects(()=>pg.query("select closer_finish_onboarding('nonce',$1,'account1','8613800138000')",[u]));
    await assert.rejects(()=>pg.query("update zernio_connections set account_id='account1' where user_id=$1",[v]));
    await pg.query("insert into leads(user_id,jid) values($1,'8613800138000')",[u]);
    for(const [id,at] of [['event1','2026-11-15T00:00:02Z'],['event1','2026-11-15T00:00:02Z'],['event2','2026-11-15T00:00:01Z']])
      await pg.query("select closer_append_message($1,'8613800138000','user','hello',$2,$3)",[u,id,at]);
    const lead=(await pg.query('select * from leads')).rows[0];
    assert.equal(lead.conversation.length,2);
    assert.equal(new Date(lead.last_inbound_at).toISOString(),'2026-11-15T00:00:02.000Z');
    await pg.query("insert into zernio_events(id,payload) values('event','{}')");
    assert.equal((await pg.query('select * from closer_claim_events()')).rows.length,1);
    assert.equal((await pg.query('select * from closer_claim_events()')).rows.length,0);
    await pg.exec('set role authenticated');
    await assert.rejects(()=>pg.query('select * from zernio_connections'));
    await assert.rejects(()=>pg.query("update closer_settings set sends_enabled=true"));
    await assert.rejects(()=>pg.query("select closer_finish_onboarding('nonce',$1,'account1','number')",[u]));
    await assert.rejects(()=>pg.query('select * from whatsapp_channels'));
  }finally{await pg.close();}
});
