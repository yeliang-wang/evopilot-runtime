import { createRuntimeService } from './historical-runtime-v020.mjs';
const digest='sha256:'+'a'.repeat(64);
const resolver=({reference,workspace})=>({reference,workspace,scope:{visibility:'public',projectId:'shared'},published:true,materialDigest:digest,descriptor:{kind:reference.product+'-composition/v1',digest}});
process.on('message',async ({options,request})=>{
  const service=createRuntimeService(options,{resolveOntology:resolver,resolveHarness:resolver,execute:()=>process.exit(0)});
  try {service.initialize();await service.dispatch(request);process.exit(2);}catch{process.exit(3);}
});
