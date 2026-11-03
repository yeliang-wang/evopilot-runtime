/** Operator-only public location APIs from the exact published owner packages. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyOwnerDistribution} from '../../adapters/published-owners.js';
import {reject} from '../../server/errors.js';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot,type WorkspaceIdentity,type RelocationOptions,type SnapshotOptions} from '../../workspace-migration.js';
import type {ManagedLegacyBinding} from '../../compat/managed-store.js';

export interface OwnerLocationSnapshot {
  product:string;identity:WorkspaceIdentity;snapshotDigest:string;requiredKeyIds:string[];
  unresolved:{kind:string;id:string;status:string;nextAction:string}[];
}
export interface OwnerLocationResult {
  product:string;sourceSnapshotDigest:string;relocationDigest:string;
  snapshot:OwnerLocationSnapshot;managedBinding?:ManagedLegacyBinding;
}
export interface OwnerLocationAPI {
  inspectWorkspaceSnapshot:(request:SnapshotOptions)=>OwnerLocationSnapshot;
  relocateWorkspaceSnapshot:(request:RelocationOptions)=>OwnerLocationResult;
}
export type LocationOwners=Record<'runtime'|'ontology'|'harness',OwnerLocationAPI>;
export async function publishedLocationOwners(packages:{ontology:string;harness:string}):Promise<LocationOwners> {
  const load=async(owner:'ontology'|'harness'):Promise<OwnerLocationAPI>=>{
    const packageRoot=packages[owner];verifyOwnerDistribution(owner,packageRoot);
    const module=await import(pathToFileURL(path.join(packageRoot,'dist/workspace-migration.js')).href) as Partial<OwnerLocationAPI>;
    if(typeof module.inspectWorkspaceSnapshot!=='function'||typeof module.relocateWorkspaceSnapshot!=='function')reject('OWNER_CAPABILITY','Published owner location API is missing');
    return{
      inspectWorkspaceSnapshot(request){verifyOwnerDistribution(owner,packageRoot);return module.inspectWorkspaceSnapshot!(request);},
      relocateWorkspaceSnapshot(request){verifyOwnerDistribution(owner,packageRoot);return module.relocateWorkspaceSnapshot!(request);},
    };
  };
  return{runtime:{inspectWorkspaceSnapshot,relocateWorkspaceSnapshot},ontology:await load('ontology'),harness:await load('harness')};
}
