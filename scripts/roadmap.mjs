import { fileURLToPath } from 'node:url';
import { mainV010 } from './roadmap-v010.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const raw = process.argv.slice(2);
const args = raw[0] === '--release' && raw[1] === '0.10.0'
  ? ['--release','--version','0.10.0',...raw.slice(2)]
  : raw;
const intent = args[args.indexOf('--intent') + 1];
const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;
if (version === '0.10.0' || intent?.startsWith('runtime-v0.10/')) mainV010(root, args);
else if (version !== null) {
  process.stdout.write(JSON.stringify({status:'UNKNOWN', reasons:['Unsupported governance version'], productAcceptance:'NOT_EVALUATED', releaseAuthorized:false}) + '\n');
  process.exitCode = 1;
} else {
  const {governanceMain} = await import('../dist/governance.js');
  governanceMain(root, args);
}
