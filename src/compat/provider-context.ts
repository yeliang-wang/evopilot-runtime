import type {Providers,NativeScope} from '../service.js';
import type {Principal} from '../server/security.js';
import type {LegacyPermission} from './catalog.js';

export type LegacyReadFamily='native'|'feedback'|'readiness'|'response'|'online'|'reconstruction';
export interface LegacyProviderContext {
  current():{actor:Principal;projectId:string;permission:LegacyPermission};
  read(family:LegacyReadFamily,request:{operation:string;scope:NativeScope;input:Record<string,unknown>}):Promise<unknown>;
}
/** Trusted process composition only; never accepted from an HTTP envelope. */
export type LegacyProviderFactory=(context:LegacyProviderContext)=>Providers;
