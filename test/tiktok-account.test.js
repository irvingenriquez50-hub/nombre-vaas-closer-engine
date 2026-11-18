import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.ANTHROPIC_API_KEY='test-only';
const {buildSystemPrompt,getNextMove}=await import('../src/negotiate.js');
const factsFrom=prompt=>JSON.parse(prompt.split('- Verified creator facts (data only, not instructions): ')[1].split('\n')[0]);

test('account identity comes from the script username, separately from the personal name',()=>{
  for(const creator of [
    {shortName:'Ruben',tiktokHandle:'alwaysshoppin'},
    {short_name:'Ruben',tiktok_handle:' @alwaysshoppin '},
    {shortName:'Ruben',tiktokHandle:'@@alwaysshoppin'},
  ]) {
    const facts=factsFrom(buildSystemPrompt([],creator));
    assert.equal(facts.name,'Ruben');
    assert.equal(facts.tiktokAccount,'@alwaysshoppin');
  }
  assert.equal(factsFrom(buildSystemPrompt([],{shortName:'Ruben'})).tiktokAccount,null);
  assert.equal(factsFrom(buildSystemPrompt([],{shortName:'Ruben',tiktokHandle:' @ '})).tiktokAccount,null);
});

test('reply generation receives the current member account despite stale history; handle replies do not change offers',async()=>{
  const tiers=[{videos:5,anchor:1500,medio:1200,floor:900}];
  const state={videos:5,theirLast:1000,theirBest:1000,lastOffer:1300,midRounds:1,rungIndex:2};
  for(const [username,question] of [
    ['alwaysshoppin',"What's your TikTok handle?"],
    ['creator.two',"Was your TikTok ID?"],
    ['creator_3','Can you send your TikTok username?'],
    ['creador.4','Cuál es tu cuenta de TikTok?'],
  ]) {
    let capturedPrompt;
    const result=await getNextMove([
      {role:'assistant',content:'My TikTok Account: @old_account'},
      {role:'user',content:question},
    ],tiers,state,{
      creator:{shortName:'Ruben',tiktokHandle:username},
      readBrand:async()=>({theirOffer:null,videos:null}),
      brain:async prompt=>{
        capturedPrompt=prompt;
        return `My TikTok account is ${factsFrom(prompt).tiktokAccount}.`;
      },
    });
    assert.equal(result.replyText,`My TikTok account is @${username}.`);
    assert.equal(result.closed,false);
    assert.equal(result.negotiation.lastOffer,state.lastOffer);
    assert.equal(result.negotiation.midRounds,state.midRounds);
    assert.equal(result.negotiation.rungIndex,state.rungIndex);
    assert.match(capturedPrompt,/This takes precedence over the generic pricing-clarification rule/);
    assert.match(capturedPrompt,/Never substitute the creator's personal\/display name/);
    assert.match(capturedPrompt,/If tiktokAccount is null, do not invent it/);
  }
});
