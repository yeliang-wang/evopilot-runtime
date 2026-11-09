// Candidate-bound native maintenance qualification. Each fixed case keeps its
// full obligation; EX10 does not substitute for legacy migration or all entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {collectCaseCampaign,caseCampaignTestOptions,openScenario} from './support.mjs';
import {collectInstalledBaseUpgrade,collectInitializationEntries,collectLegacyMigrationJourney} from './maintenance.mjs';
import {openBrowser} from './browser.mjs';

test('E17 native installed Base upgrade and retained rollback evidence',caseCampaignTestOptions('E17'),async()=>{
 const run=await openScenario('E17');try{
  if(run.selection.caseCampaign){await collectCaseCampaign(run,'E17');return;}
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E17.EX10')return collectInstalledBaseUpgrade(run,c,{chromium,expect,openBrowser});
   if(c.caseInstanceId==='E17.journey')return collectLegacyMigrationJourney(run,c);
   if(c.caseInstanceId==='E17.CV01')return collectInitializationEntries(run,c,{chromium,expect,openBrowser});
   assert.fail('Unknown frozen E17 case '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
