export interface Issue {code:string;path:string;message:string;remedy:string;rule:string;}
export interface GraphNode {id:string;source:'base'|'project';stage:string;dependsOn:string[];checks:string[];}
export interface Field {id:string;path:string;stage:string;type:string;policy:'CONFIGURABLE'|'CONSTRAINED'|'ADDITIVE'|'LOCKED';required:boolean;providers:string[];question:string;rules:Record<string,unknown>;}
export interface Base {pin:{id:string;version:string;digest:string;schemaVersion:string};fields:Field[];stages:{id:string;requires:string[];checks:string[]}[];slots:Record<string,{predecessor:string;successor:string;types:string[]}>;actions:{id:string;version:string;type:string;digest:string;parameterSchema:Record<string,string>}[];}
export interface BaseTransitionPreview {from:Base['pin'];to:Base['pin'];sourceRevisionId:string;addedRequiredFields:string[];removedSlots:string[];tightenedConstraints:{path:string;before:unknown;after:unknown}[];schemaChanged:boolean;retainedExtensionIds:string[];issues:Issue[];previewDigest:string;sourceRewritten:false;}
export interface Validation {ready:boolean;validationDigest:string|null;issues:Issue[];compilation:{valid:boolean;effective:{nodes:GraphNode[];semanticDigest:string;fieldSources:Record<string,string>}|null;issues:Issue[]};baseTransition?:BaseTransitionPreview|null;}
export interface Summary {id:string;sourceDigest:string;semanticDigest:string|null;structurallyValid:boolean;issues:Issue[];}
export interface DefinitionView {projectId:string;revision:number;draft:Summary|null;active:Summary|null;}
export interface Session {projectId:string;principalId:string;permissions:string[];csrf:string;expiresAt:string;serviceId:string;workspaceId:string;}
export interface Receipt {projectId:string;requestId:string;operation:string;principalId:string;revision:number;result:{status:string;revisionId:string;activeRevisionId:string|null;issues:Issue[]};}
export interface Stage {status:'PENDING'|'RUNNING'|'UNKNOWN'|'FAILED'|'PASSED';attempts:number;requestId:string|null;requestedAt:string|null;receiptRef:string|null;outcomeDigest:string|null;expiresAt:string|null;}
export interface MonitoredInstance {id:string;createdAt:string;definitionRevisionId:string;base:Base['pin'];goalRef:string;targetRef:string;loopRef:string;candidateDigest:string|null;graph:GraphNode[];stages:Record<string,Stage>;}
export interface MonitorPage {projectId:string;revision:number;instances:MonitoredInstance[];nextAfter:string|null;observedAt:string;readOnly:true;}
export type CompletedAuthorityResponse={status:401;code:'UNAUTHENTICATED'|'BROWSER_SESSION_REVOKED'}|{status:403;code:'FORBIDDEN'};
export interface Pending {projectId:string;principalId:string;serviceId:string;requestId:string;operation:string;completedAuthorityResponse?:CompletedAuthorityResponse;}
