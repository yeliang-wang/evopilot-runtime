/** Fixed published owner APIs for explicit local Workspace setup only. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRuntimeService} from '../../service.js';
import {verifyOwnerDistribution} from '../../adapters/published-owners.js';
import {reject} from '../../server/errors.js';
import {publishedLocationOwners,type OwnerLocationSnapshot} from './owners.js';

export type SetupOwner='runtime'|'ontology'|'harness';
export interface SetupLocation {workspaceRoot:string;workspaceId:string;}
export interface WorkspaceBootstrapOwners {
  initialize:(owner:SetupOwner,location:SetupLocation)=>Promise<void>;
  inspect:(owner:SetupOwner,location:SetupLocation)=>OwnerLocationSnapshot;
}
interface Initializable {initialize():unknown;close():void;}
type Factory=(location:SetupLocation)=>Initializable;
/** Imports only the verified public service.js entries, never sibling source. */
export async function publishedBootstrapOwners(packages:{ontology:string;harness:string}):Promise<WorkspaceBootstrapOwners>{
  const locations=await publishedLocationOwners(packages),factories:Record<SetupOwner,Factory>={runtime:createRuntimeService,ontology:undefined as unknown as Factory,harness:undefined as unknown as Factory};
  for(const owner of ['ontology','harness'] as const){
    const packageRoot=packages[owner];verifyOwnerDistribution(owner,packageRoot);
    const module=await import(pathToFileURL(path.join(packageRoot,'dist/service.js')).href) as Record<string,unknown>;
    const factory=module[owner==='ontology'?'createOntologyService':'createHarnessService'];
    if(typeof factory!=='function')reject('OWNER_CAPABILITY','Published owner initialization API is missing');factories[owner]=factory as Factory;
  }
  return{
    async initialize(owner,location){
      if(owner!=='runtime')verifyOwnerDistribution(owner,packages[owner]);
      const service=factories[owner](location);try{service.initialize();}finally{service.close();}
    },
    inspect:(owner,location)=>locations[owner].inspectWorkspaceSnapshot(location),
  };
}
