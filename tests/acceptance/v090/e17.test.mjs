// Candidate-bound native maintenance qualification. Each fixed case keeps its
// full obligation; EX10 does not substitute for legacy migration or all entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {openScenario} from './support.mjs';
import {collectInstalledBaseUpgrade} from './maintenance.mjs';
import {openBrowser} from './browser.mjs';

test('E17 native installed Base upgrade and retained rollback evidence',async()=>{
 const run=await openScenario('E17');try{
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E17.EX10')return collectInstalledBaseUpgrade(run,c,{chromium,expect,openBrowser});
   if(c.caseInstanceId==='E17.journey')assert.fail('UNIMPLEMENTED_FIXED_CASE: E17.journey additionally requires its selected historical-format migration, unknown-schema/incompatibility/failure injections and preservation of private owner assets/decisions; EX10 alone is insufficient.');
   if(c.caseInstanceId==='E17.CV01')assert.fail('UNIMPLEMENTED_FIXED_CASE: E17.CV01 needs every declared initialization entry through controlled activation and exactly pinned new instances, including all missing/invalid input refusals.');
   assert.fail('Unknown frozen E17 case '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
