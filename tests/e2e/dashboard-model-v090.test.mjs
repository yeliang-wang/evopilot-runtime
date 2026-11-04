import test from 'node:test';
import assert from 'node:assert/strict';
import {changeField,moveNode,data,addExtension,changeExtension,connectExtension,removeExtension,diffLines,document,draftNodes,at,graphLayout} from '../../dashboard/src/model.ts';
import {render} from '../../dashboard/vendor/seecode/lib/render/graph/graph.mjs';
import {lifecycle,yaml,extension} from '../fixtures/lifecycle-v090.mjs';
import {loadPublisherBase,valueDigest} from '../../dist/lifecycle/base.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
const base=()=>{const {base,pin}=loadPublisherBase();return{...base,pin,actions:base.actions.map(a=>({...a,digest:valueDigest(a)}))};};
test('graph field edit preserves comments and unrelated YAML, and cannot unlock publisher fields',()=>{
 const original='# Reviewed project description\n'+yaml(lifecycle())+'\n# Keep this note\n',b=base(),field=b.fields.find(f=>f.policy==='CONFIGURABLE'&&f.type==='bindingRef');assert(field);
 const updated=changeField(original,field,'binding:test/changed');assert.match(updated,/Reviewed project description/);assert.match(updated,/Keep this note/);const before=data(original),after=data(updated);assert.deepEqual(after.extends,before.extends);assert.deepEqual(after.assets,before.assets);assert.equal(at(after,field.path),'binding:test/changed');assert.notEqual(at(before,field.path),at(after,field.path));
 const locked=b.fields.find(f=>f.policy==='LOCKED');assert.throws(()=>changeField(original,locked,'override'),/Base 锁定/);assert.throws(()=>changeField(original,{...field,path:'__proto__.polluted'},true),/字段路径/);assert.equal({}.polluted,undefined);
});
test('graph layout writes preserve semantic identity while changing only presentation',()=>{
 const original=yaml(lifecycle()),compiled=compileLifecycle(original,'alpha');const moved=moveNode(original,compiled.effective.nodes,'scope',0,90),next=compileLifecycle(moved,'alpha');assert.equal(next.valid,true);assert.equal(next.effective.semanticDigest,compiled.effective.semanticDigest);assert.notEqual(next.presentationDigest,compiled.presentationDigest);assert.deepEqual(data(moved).presentation.layout.scope,{x:0,y:90});
 assert.throws(()=>moveNode(original,compiled.effective.nodes,'missing',0,0));assert.throws(()=>moveNode(original,compiled.effective.nodes,'scope',Infinity,0));
});
test('extension editing keeps AND joins, exact action pins and original YAML; base edges and cycles cannot be drawn',()=>{
 const b=base(),original='# All stages stay required\n'+yaml(lifecycle());let source=addExtension(original,b,'project.first','after-plan',b.actions.find(a=>a.type==='check').id);
 assert.equal(compileLifecycle(source,'alpha').valid,false,'blank required bindings are not invented');assert(draftNodes(b,data(source)).some(n=>n.id==='project.first'),'incomplete extension remains selectable');source=changeExtension(source,'project.first',extension('first'));source=addExtension(source,b,'project.second','after-plan',b.actions.find(a=>a.type==='check').id);source=changeExtension(source,'project.second',extension('second'));source=connectExtension(source,'project.first','project.second',true);
 const compiled=compileLifecycle(source,'alpha');assert.equal(compiled.valid,true);assert(compiled.effective.nodes.find(n=>n.id==='project.second').dependsOn.includes('project.first'));assert.match(source,/All stages stay required/);
 assert.throws(()=>connectExtension(source,'project.second','project.first',true),/循环/);assert.throws(()=>connectExtension(source,'plan','project.first',true),/Base/);assert.throws(()=>removeExtension(source,'scope'),/Base/);assert.throws(()=>removeExtension(source,'project.first'),/依赖/);
 source=connectExtension(source,'project.first','project.second',false);source=removeExtension(source,'project.first');assert.equal(compileLifecycle(source,'alpha').valid,true);assert.equal(data(source).extensions.length,1);
});
test('malformed dynamic YAML is never normalized or silently discarded; accurate text differences remain inspectable',()=>{
 for(const source of ['a: [','a: &x 1\nb: *x','a: 1\na: 2','a: !custom value'])assert.throws(()=>document(source));
 const text=diffLines('a\nold\nz','a\nnew\nz');assert.match(text,/- old/);assert.match(text,/\+ new/);assert.equal(diffLines('same','same'),'没有变更');
});

test('real SeeCode keeps all extension nodes after a saved position collides with their default cell',()=>{
 const project=lifecycle();project.extensions=[extension('first'),extension('second'),extension('third')];project.presentation={layout:{scope:{x:400,y:180}}};
 const source='# Retain reviewed YAML and display preferences\n'+yaml(project),compiled=compileLifecycle(source,'alpha');assert.equal(compiled.valid,true);
 const original=structuredClone(compiled.effective.nodes),saved=structuredClone(project.presentation.layout),positions=graphLayout(compiled.effective.nodes,project.presentation.layout);
 assert.deepEqual({x:positions.scope.x,y:positions.scope.y},saved.scope);assert.equal(new Set(Object.values(positions).map(p=>p.row+','+p.col)).size,original.length);
 const drawn=render({type:'flowchart',dir:'LR',budget:'off',legend:false,nodes:original.map(n=>({id:n.id,label:n.id,row:positions[n.id].row,col:positions[n.id].col,shape:'box'})),edges:original.flatMap(n=>n.dependsOn.map(p=>[p,n.id]))});
 assert.deepEqual(drawn.problems.filter(p=>p.code.startsWith('E_')),[]);for(const n of original)assert(drawn.body.includes('data-sc-node="'+n.id+'"'),'Actual SeeCode omitted '+n.id);
 assert.deepEqual(compiled.effective.nodes,original);assert.deepEqual(project.presentation.layout,saved);assert.equal(compileLifecycle(source,'alpha').effective.semanticDigest,compiled.effective.semanticDigest);
});

test('colliding explicit and rounded positions resolve deterministically without rewriting input or permitting invalid DAGs',()=>{
 const project=lifecycle();project.extensions=[extension('first'),extension('second')];const nodes=compileLifecycle(yaml(project),'alpha').effective.nodes;
 const layout={scope:{x:400,y:180},'project.first':{x:400,y:180},'project.second':{x:401,y:181}},original=structuredClone(layout);
 const first=graphLayout(nodes,layout),reordered=graphLayout([...nodes].reverse(),layout);assert.deepEqual(first,reordered);assert.deepEqual(layout,original);
 assert.equal(new Set(Object.values(first).map(p=>p.row+','+p.col)).size,nodes.length);
 assert.throws(()=>graphLayout([{...nodes[0],dependsOn:['scope']}],{}),/循环/);assert.throws(()=>graphLayout([{...nodes[0],dependsOn:['missing']}],{}),/缺少依赖节点/);
});

test('all 72 supported nodes remain movable when explicit positions collide at either coordinate boundary',()=>{
 const project=lifecycle();project.extensions=Array.from({length:64},(_,i)=>extension('edge-'+i));
 const source=yaml(project),compiled=compileLifecycle(source,'alpha');assert.equal(compiled.valid,true);const nodes=compiled.effective.nodes;assert.equal(nodes.length,72);
 for(const y of [-100000,100000]){
  const layout=Object.fromEntries(nodes.map(n=>[n.id,{x:400,y}])),original=structuredClone(layout),positions=graphLayout(nodes,layout);
  assert.equal(Object.keys(positions).length,72);assert.equal(new Set(Object.values(positions).map(p=>p.row+','+p.col)).size,72);
  assert(Object.values(positions).every(p=>Math.abs(p.x)<=100000&&Math.abs(p.y)<=100000),'Collision projection must remain accepted by moveNode and the server schema');
  assert.deepEqual(positions.scope,{x:400,y,row:Math.round(y/90),col:2},'First explicit boundary preference must remain exact');
  assert.deepEqual(layout,original);assert.deepEqual(graphLayout([...nodes].reverse(),layout),positions);
  const displaced=nodes.find(n=>positions[n.id].y!==y);assert(displaced);
  const p=positions[displaced.id],moved=moveNode(source,nodes,displaced.id,p.x+200,p.y);
  assert.deepEqual(data(moved).presentation.layout[displaced.id],{x:600,y:p.y});
  const after=compileLifecycle(moved,'alpha');assert.equal(after.valid,true);assert.equal(after.effective.semanticDigest,compiled.effective.semanticDigest);
 }
});
