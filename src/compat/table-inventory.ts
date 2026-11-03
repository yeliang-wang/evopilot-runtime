/** Bounded preservation evidence for every SQLite table. No domain approval is
 * inferred. Callers may exclude only their explicitly permitted metadata changes. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalEvidence,reject} from '../server/errors.js';

export interface TableInventory {schemaDigest:string;tables:{name:string;rows:number;sha256:string}[];}
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
export function inspectAllTables(db:DatabaseSync,excluded:readonly string[]=[]):TableInventory {
  if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')reject('MAINTENANCE_DATABASE','SQLite integrity check failed');
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  if(schema.length>256||schema.some(row=>!['table','index'].includes(String(row.type))||/\bVIRTUAL\s+TABLE\b/i.test(String(row.sql))))reject('MAINTENANCE_DATABASE','Unsupported SQLite schema');
  const retained=schema.filter(row=>!excluded.includes(String(row.tbl_name))),tables:TableInventory['tables']=[];let bytes=0;
  for(const row of retained.filter(v=>v.type==='table')){
    const name=String(row.name),columns=db.prepare('PRAGMA table_info('+quote(name)+')').all().map(v=>String(v.name));
    if(!columns.length||columns.length>64)reject('MAINTENANCE_DATABASE','Unsupported table shape');
    const query=db.prepare('SELECT * FROM '+quote(name)+' ORDER BY '+columns.map(quote).join(',')+' LIMIT 100001');query.setReadBigInts(true);
    let rows=0;const hash=createHash('sha256');
    for(const record of query.iterate()){
      if(++rows>100000)reject('MAINTENANCE_LIMIT','Table row limit');
      const encoded=JSON.stringify(columns.map(key=>{const v=record[key];return v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:typeof v==='bigint'?{integer:v.toString()}:v;}));
      if((bytes+=Buffer.byteLength(encoded))>768*1024*1024)reject('MAINTENANCE_LIMIT','Table byte limit');hash.update(encoded+'\n');
    }
    tables.push({name,rows,sha256:hash.digest('hex')});
  }
  return{schemaDigest:createHash('sha256').update(canonicalEvidence(retained)).digest('hex'),tables};
}
