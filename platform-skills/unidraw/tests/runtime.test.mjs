import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  boardText, canonicalBoardUrl, compileBoard, plainText, projectScene, readScene,
} from '../scripts/model.mjs';
import { findUniqueShape, verifyImport } from '../scripts/browser.mjs';
import { parseCommand, prepareSpec, runUniDraw } from '../scripts/trelio-unidraw.mjs';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

const fixture = async name => JSON.parse(await readFile(new URL('../development/examples/'+name+'.json',import.meta.url),'utf8'));
const url='https://unidraw.io/app/board/fixture-0001';

test('complex fixtures produce native, individually addressable elements and connectors',async()=>{
  for(const [name,shapes,lines] of [['flowchart',21,21],['mindmap',23,24]]) {
    const first=compileBoard(await fixture(name));
    const second=compileBoard(await fixture(name));
    assert.equal(first.scene.elements.length,shapes+lines);
    assert.equal(new Set(first.scene.elements.map(e=>e.id)).size,shapes+lines);
    assert.notEqual(first.scene.elements[0].id,second.scene.elements[0].id);
    assert.deepEqual(verifyImport(first.scene,second.scene),{elements:shapes+lines,shapes,links:lines,types:['line','shape']});
    assert.ok(Object.keys(first.groups).length>1);
    assert.ok(first.scene.elements.some(e=>e.type==='line'&&e.captions?.length));
  }
});

test('mindmap branches stay on both sides of the root and fit their own lanes',async()=>{
  const input=await fixture('mindmap');
  const {scene,nodes}=compileBoard(input);
  const {byId}=readScene(scene);
  const root=byId.get(nodes.root);
  const children=input.edges.filter(e=>e.from===input.root).map(e=>byId.get(nodes[e.to]));
  assert.ok(children.some(e=>e.position.x<root.position.x));
  assert.ok(children.some(e=>e.position.x>root.position.x));
  const impossible=structuredClone(input);
  impossible.edges.push({from:'auth',to:'customer'});
  assert.throws(()=>compileBoard(impossible),{code:'INVALID_MINDMAP_TREE'});
});

test('typed native elements preserve geometry and report normalization or missing frame membership',async()=>{
  const plan=await fixture('mixed');
  const compiled=compileBoard(plan);
  const actual=structuredClone(compiled.scene);
  assert.ok(actual.elements.find(e=>e.type==='frame').children.length===6);
  actual.elements.find(e=>e.type==='frame').children=[];
  actual.elements.find(e=>e.type==='text').size={width:563,height:26.4};
  actual.elements.find(e=>e.type==='sticker').size.width=220.5;
  assert.deepEqual(verifyImport(compiled.scene,actual).frameMembership,{planned:6,persisted:0});
  assert.equal(projectScene(actual).find(e=>e.type==='freedraw').label,'');
  actual.elements.find(e=>e.type==='frame').children=['unknown-id'];
  assert.throws(()=>verifyImport(compiled.scene,actual),{code:'IMPORT_FRAME_CONTENT_NOT_VERIFIED'});
});

test('verification rejects a detached connector, wrong caption, missing node, duplicate target and unexpected colour',async()=>{
  const {scene}=compileBoard(await fixture('flowchart'));
  for(const change of [
    b=>b.elements.find(e=>e.type==='line').tipPoints.start.boundToId=null,
    b=>b.elements.find(e=>e.captions).captions[0].text='<p>wrong</p>',
  ]) {
    const copy=structuredClone(scene);
    change(copy);
    assert.throws(()=>verifyImport(scene,copy),{code:'IMPORT_LINKS_NOT_VERIFIED'});
  }
  const copy=structuredClone(scene);
  copy.elements.find(e=>e.type==='shape').style.fc='#020304';
  assert.throws(()=>verifyImport(scene,copy),{code:'IMPORT_CONTENT_NOT_VERIFIED'});
  copy.elements.pop();
  assert.throws(()=>verifyImport(scene,copy),{code:'IMPORT_CONTENT_NOT_VERIFIED'});
  const node=scene.elements.find(e=>e.type==='shape');
  copy.elements.push({...node,id:'duplicate-test'});
  assert.throws(()=>findUniqueShape(copy,plainText(node.text)),{code:'FIGURE_NOT_UNIQUE_OR_MISSING'});
});

test('plan labels are escaped and untrusted board URLs cannot open another service',()=>{
  const input='<img src=x>& "слова"';
  assert.equal(plainText(boardText(input)),input);
  assert.doesNotMatch(boardText(input),/<img/);
  assert.equal(canonicalBoardUrl(url+'?allow_guest=true#fragment'),url);
  for(const invalid of ['https://unidraw.io.evil.test/app/board/abcdefghi',
    'http://unidraw.io/app/board/abcdefghi','https://unidraw.io/app/board/../login',
    'https://name@unidraw.io/app/board/abcdefghi']) {
    assert.throws(()=>canonicalBoardUrl(invalid),{code:'INVALID_BOARD_URL'});
  }
});

test('runtime accepts bounded local specifications and the metadata-only host importer',async()=>{
  assert.deepEqual(await runUniDraw(['__trelio_accounts_import'],{}),{schemaVersion:1,accounts:[]});
  assert.equal((await runUniDraw(['doctor'],{})).browser,'not_checked');
  assert.equal((await runUniDraw(['setup'],{})).code,'HOST_BINDING_REQUIRED');
  assert.throws(()=>parseCommand(['create-board','--spec-file','relative.json']),{code:'INVALID_COMMAND'});
  const requestId='request-test-00000001';
  assert.throws(()=>prepareSpec('inspect-board',{board:url,limit:31}),{code:'INVALID_INSPECT_RANGE'});
  assert.throws(()=>prepareSpec('apply-board-changes',{board:url,requestId,operations:[{type:'move-group',anchorLabel:'x',dx:9999,dy:0}]}),
    {code:'INVALID_BOARD_CHANGE'});
  const prepared=prepareSpec('create-board',{requestId,plan:await fixture('mixed')});
  assert.equal(prepared.compiled.scene.elements.length,10);
  assert.equal(prepared.digest.length,64);
});

test('managed account setup packages only the existing manual login',()=>{
  const {packageBytes}=buildRuntimePackage(fileURLToPath(new URL('../',import.meta.url)));
  const files=JSON.parse(packageBytes).files;
  const setup=files.find(entry=>entry.path==='trelio-secret-setup.json');
  assert.ok(setup);
  assert.deepEqual(JSON.parse(Buffer.from(setup.contentBase64,'base64')),{
    schemaVersion:2,commands:[],humanInputCommands:[{
      id:'login',purpose:'authenticate_existing',arguments:['setup'],maximumDurationMs:600_000,
    }],
  });
  assert.deepEqual(parseCommand(['setup']),{operation:'setup'});
  assert.throws(()=>parseCommand(['setup','--local-account','fixture']),{code:'INVALID_COMMAND'});
});

test('unknown and completed receipts never dispatch the same provider write again',async()=>{
  // macOS commonly spells its temporary root through the /var symlink. The
  // host supplies a canonical storage root and the provider validates it.
  const scratch=await mkdtemp(join(await realpath(tmpdir()),'unidraw-claim-'));
  try {
    const company='00000000-0000-4000-8000-000000000001';
    const member='00000000-0000-4000-8000-000000000002';
    const account='00000000-0000-4000-8000-000000000003';
    const file=join(scratch,'fixture-host.mjs');
    const directory=join(scratch,'unidraw',company,member,account,'operations');
    const spec=join(scratch,'spec.json');
    const requestId='same-request-12345';
    const hash=value=>createHash('sha256').update(value).digest('hex');
    // This adapter fails hard if the runtime starts a browser. A returned
    // receipt proves that no re-dispatch path reached the provider.
    await writeFile(file,`
      export const BROWSER_EXECUTION_SESSIONS_API='trelio.browser-execution-sessions/v1';
      export const browserConfigHome=()=>${JSON.stringify(scratch)};
      export const readBrowserSessionBinding=()=>({});
      export const withPersistentBrowserSession=()=>{throw Error('unexpected browser');};
      export const inspectBrowserRuntime=()=>{throw Error('unexpected browser probe');};
    `);
    const env={TRELIO_SKILL_ID:'unidraw',TRELIO_SKILL_COMPANY_ID:company,TRELIO_SKILL_MEMBER_ID:member,
      TRELIO_BROWSER_SESSION_MODULE_URL:pathToFileURL(file).href,
      TRELIO_SKILL_ACCOUNT_JSON:JSON.stringify({id:account,providerRef:null,companyBinding:'a'.repeat(64)})};
    await mkdir(directory,{recursive:true});
    const request={requestId,plan:await fixture('mixed')};
    await writeFile(spec,JSON.stringify(request));
    const claim=join(directory,hash(requestId)+'.json');
    for(const outcome of ['unknown','confirmed_succeeded']) {
      await writeFile(claim,JSON.stringify({schemaVersion:1,operation:'create-board',digest:hash(JSON.stringify(request)),outcome}));
      const got=await runUniDraw(['create-board','--spec-file',spec],env);
      assert.equal(got.reused,true,got.code);
      assert.equal(got.receipt.outcome,outcome);
    }
    request.plan.title='Другая доска';
    await writeFile(spec,JSON.stringify(request));
    const conflict=await runUniDraw(['create-board','--spec-file',spec],env);
    assert.equal(conflict.code,'REQUEST_ID_REUSED');
    assert.equal(conflict.outcome,'not_dispatched');
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
});
