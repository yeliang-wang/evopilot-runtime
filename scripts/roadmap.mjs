import { fileURLToPath } from 'node:url';
import { governanceMain } from '../dist/governance.js';
governanceMain(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2));
