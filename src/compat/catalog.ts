/** Explicit legacy public contracts, not suffix-based read/write inference.
 * Legacy asset preparation/validation records are not v0.9 software lifecycle
 * instances. None of these operations can complete a new stage or release. */
export const LEGACY_CATALOG={
  request:{
    read:['workspace.inspect','receipt.inspect','project.inspect','project.list','goal.inspect','goal.list','run.inspect','run.list'],
    write:{'project.create':'draft.write','goal.create':'draft.write','run.prepare':'draft.write','run.decide':'decision.record','run.cancel':'decision.record','run.dispatch':'execution.request','run.reconcile':'execution.request'},
  },
  native:{
    read:['workspace.inspect','receipt.inspect','project.inspect','project.list','collection.inspect','collection.list','run.inspect','run.list'],
    write:{'project.prepare':'draft.write','project.validate':'execution.request','project.complete':'decision.record','collection.prepare':'draft.write','collection.decide':'decision.record','collection.execute':'execution.request','collection.reconcile':'execution.request','run.prepare':'draft.write','run.decide':'decision.record','run.dispatch':'execution.request','run.reconcile':'execution.request'},
  },
  planning:{read:['planning.inspect','planning.list','planning.read','planning.review','planning.binding.inspect','planning.export','planning.export.verify','planning.receipt.inspect'],write:{'planning.revise':'draft.write','planning.decide':'decision.record','planning.bind':'decision.record'}},
  readiness:{read:['readiness.standard.inspect','readiness.inspect','readiness.intent.review','readiness.intent.read','readiness.intent.list','readiness.project.inspect','readiness.receipt.inspect'],write:{'readiness.intent.record':'decision.record','readiness.project.complete':'decision.record'}},
  readable:{read:['readable.list','readable.snapshot','readable.query','readable.export','readable.compare'],write:{}},
  feedback:{read:['feedback.inspect','feedback.list','feedback.read','feedback.event'],write:{'feedback.configure':'draft.write','feedback.capture':'draft.write','feedback.deliver':'execution.request','feedback.refresh':'execution.request'}},
  online:{read:['online.inspect','online.repair.inspect','online.receipt.inspect'],write:{'online.repair.ingest':'draft.write'}},
  response:{read:['response.inspect','response.list','response.read','response.execution.inspect','response.receipt.inspect','response.cancel.review'],write:{'response.prepare':'draft.write','response.decide':'decision.record','response.execute':'execution.request','response.reconcile':'execution.request','response.cancel':'decision.record','response.verify':'execution.request','response.close':'decision.record'}},
  reconstruction:{read:['reconstruction.inspect','reconstruction.review','reconstruction.plan','reconstruction.attempt','reconstruction.list','reconstruction.evidence'],write:{'reconstruction.freeze':'decision.record','reconstruction.dispatch':'execution.request','reconstruction.reconcile':'execution.request','reconstruction.cancel':'execution.request'}},
} as const;
export type LegacyFamily=keyof typeof LEGACY_CATALOG;
export type LegacyPermission='read'|'draft.write'|'decision.record'|'execution.request';
export const LEGACY_READ='runtime.legacy.read';
export const LEGACY_WRITE='runtime.legacy.write';
export function legacyOperation(family:string,operation:string):{family:LegacyFamily;permission:LegacyPermission;write:boolean}|null {
  if(!Object.hasOwn(LEGACY_CATALOG,family))return null;
  const found=LEGACY_CATALOG[family as LegacyFamily];
  if((found.read as readonly string[]).includes(operation))return{family:family as LegacyFamily,permission:'read',write:false};
  if(Object.hasOwn(found.write,operation))return{family:family as LegacyFamily,permission:(found.write as Record<string,LegacyPermission>)[operation],write:true};
  return null;
}
/** The old `native` tool selected these families explicitly. Owner-only
 * usability.* operations are intentionally absent from the Runtime endpoint. */
export function legacyNativeFamily(operation:string):LegacyFamily {
  for(const family of ['planning','readiness','readable','feedback','online','response','reconstruction'] as const)if(operation.startsWith(family+'.'))return family;
  return'native';
}
