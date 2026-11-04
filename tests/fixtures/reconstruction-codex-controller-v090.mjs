import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mock} from 'node:test';
import {createRuntimeService} from '@evopilot-next/runtime/service';
import {createCodexReconstructionAdapter} from '../../dist/compat/reconstruction/codex-reconstruction.js';
import {usabilityDigest} from '../../vendor/usability/v1/contract.mjs';
const {options,root,input,request}=JSON.parse(process.argv[2]);
const fixtureHome=path.join(path.dirname(root),'host-fixture');
assert.equal(input.codex.configuration.path,path.join(fixtureHome,'.codex/config.toml'));
mock.method(os,'homedir',()=>fixtureHome);
const adapter=createCodexReconstructionAdapter({root,resolve:async()=>input,verify:async p=>({planDigest:usabilityDigest(p),current:true})});
const service=createRuntimeService(options,adapter);service.initialize();try{await service.reconstruction(request);}finally{service.close();}
