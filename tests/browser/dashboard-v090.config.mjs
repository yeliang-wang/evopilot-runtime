import {defineConfig} from '@playwright/test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export default defineConfig({testDir:'.',testMatch:'dashboard-v090.test.mjs',fullyParallel:false,workers:1,retries:0,forbidOnly:true,timeout:45000,expect:{timeout:10000},outputDir:process.env.EVOPILOT_BROWSER_OUTPUT??join(tmpdir(),'evopilot-dashboard-browser-results'),reporter:[['list']],use:{browserName:'chromium',headless:true,viewport:{width:1440,height:1000},reducedMotion:'reduce',trace:'retain-on-failure',screenshot:'only-on-failure'}});
