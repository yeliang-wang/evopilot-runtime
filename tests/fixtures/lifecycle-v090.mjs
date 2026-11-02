// Synthetic configuration and adapter evidence for compiler/service regression.
// These values are not private project assets or real owner/provider acceptance.
import { stringify } from 'yaml';
import { loadPublisherBase, valueDigest } from '../../dist/lifecycle/base.js';

// Deliberately synthetic empty Git tree; source-reader tests independently use
// real Git objects. This only supplies typed provenance to lifecycle fixtures.
export function syntheticSourceTree(binding,commit){
  const entries=[],rootTreeId='4b825dc642cb6eb9a060e54bf8d69288fbee4904',inventoryDigest=valueDigest(entries),treeDigest=valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId,inventoryDigest});
  const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),commit,rootTreeId,entries,inventoryDigest,treeDigest};
  return{schema:'runtime-source-tree/v1',...facts,factsDigest:valueDigest(facts),observedAt:new Date().toISOString(),contentRead:false,linksFollowed:false,sourceApproved:false};
}

export function setPath(object,path,value){const parts=path.split('.');let at=object;for(const p of parts.slice(0,-1))at=at[p]??={};if(value===undefined)delete at[parts.at(-1)];else at[parts.at(-1)]=value;return object;}
export function lifecycle(provider='github',projectId='alpha'){
  const {base,pin}=loadPublisherBase(),data={};
  for(const f of base.fields){
    if(!f.providers.includes(provider))continue;
    const r=f.rules;
    let v=r.fixed;
    if(v===undefined)switch(f.type){
      case 'string':case 'slug':v='synthetic-fixture';break;
      case 'version':v='1.0.0';break;
      case 'digest':v=valueDigest({synthetic:f.path});break;
      case 'bindingRef':v='binding:synthetic/'+f.id.toLowerCase();break;
      case 'credentialRef':v='credential:synthetic/'+f.id.toLowerCase();break;
      case 'repositoryPath':v=provider==='github'?'.github/workflows/test.yml':'.gitlab-ci.yml';break;
      case 'httpsOrigin':v=provider==='github'?'https://github.com':'https://gitlab.example.test';break;
      case 'enum':v=r.values[0];break;
      case 'integer':v=r.minimum;break;
      case 'stringList':v=[...(r.contains??r.values.slice(0,1))];break;
      case 'bindingList':v=['binding:synthetic/'+f.id.toLowerCase()];break;
      case 'pathList':v=['README.md'];break;
      default:throw Error('Unhandled fixture field '+f.path);
    }
    setPath(data,f.path,v);
  }
  data.extends={...pin};data.projectId=projectId;
  data.config.implementation.provider=provider;
  data.config.publication.channel=provider+'-release';
  for(const owner of ['ontology','harness'])data.assets[owner].projectId=projectId;
  return data;
}
export const yaml=value=>stringify(value,{lineWidth:0});
export function extension(id,slot='after-plan',dependsOn=[],type='check'){
  const action=loadPublisherBase().base.actions.find(a=>a.type===type);
  return{id:'project.'+id,slot,type,actionRef:action.id,actionVersion:action.version,actionDigest:valueDigest(action),parameters:Object.fromEntries(Object.keys(action.parameterSchema).map(k=>[k,'binding:synthetic/'+k.toLowerCase()])),requirementRefs:['binding:synthetic/requirement-'+id],evidenceMappingRef:'binding:synthetic/mapping-'+id,scopeRef:'scope:alpha',budget:{timeoutSeconds:1,maxAttempts:1,maxConcurrency:1,maxLoops:1},dependsOn};
}
export function syntheticBindings(){
  const state={calls:0,revision:'synthetic-1',mode:'valid',during:null};
  const provider=async(_definition,_actor,requirements,signal)=>{
    state.calls++;if(state.during)await state.during(signal);
    return requirements.map(r=>({path:r.path,inputDigest:r.inputDigest,status:state.mode==='valid'?'VALID':'UNKNOWN',revision:state.revision,factsDigest:valueDigest({synthetic:true,path:r.path,revision:state.revision}),evidenceRef:'synthetic:unit-test/'+r.path,expiresAt:new Date(Date.now()+60000).toISOString()}));
  };
  return{state,provider};
}
