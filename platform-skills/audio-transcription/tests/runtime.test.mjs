import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {artifacts, childEnvironment, digest, downloadArtifact, ensureSetup, installationPlan, modelDirectory, performSetup, providerRoot, pythonPath, ready, startSetup, unpackUv, whisper} from '../scripts/bootstrap.mjs';
import {argumentsObject, run, RUNTIME_VERSION} from '../scripts/audio-transcription.mjs';
import {atomicJson, privateDirectory} from '../scripts/storage.mjs';
import {buildRuntimePackage} from '../../tools/build-runtime-package.mjs';
import {processSourceOriginal,readSourceOriginalInput,readSourceProgressJson,sourceFileFingerprint} from '../scripts/source-original.mjs';

const fixtureFile = path.join(providerRoot, '.ci-state.json');
const fixture = fs.existsSync(fixtureFile) ? JSON.parse(fs.readFileSync(fixtureFile)) : null;
const temporary = () => privateDirectory(path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trelio-audio-test-')), 'private'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const artifact = value => ({url: 'https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/synthetic.bin', bytes: value.length, sha256: digest(value)});

function prepareSpokenFixture(target) {
  // Keep the SAME public upstream speech and checksum used by the original
  // native gate. Bundling these small development-only bytes removes an
  // unrelated CDN/TLS dependency without substituting synthetic inference,
  // shortening the sample, relaxing assertions or shipping audio in a skill.
  const sample=JSON.parse(fs.readFileSync(path.join(providerRoot,'development/fixture.json')));
  assert.equal(sample.localFile,'public-example.wav');
  const source=path.join(providerRoot,'development',sample.localFile),stat=fs.lstatSync(source);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,sample.bytes);
  const bytes=fs.readFileSync(source);assert.equal(digest(bytes),sample.sha256);
  fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  return sample;
}

test('development speech is the complete already-pinned upstream fixture and stays outside the package',t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  const sample=prepareSpokenFixture(path.join(root,'original.wav'));
  assert.equal(sample.bytes,361324);
  assert.equal(sample.sha256,'d8aaaa18a5098d7c6de0595ae7ac1e64cacd0d4022af3595213bdaf23be77e69');
  const release=JSON.parse(fs.readFileSync(path.join(providerRoot,'release.json')));
  assert.ok(release.runtime.files.every(file=>!file.source.startsWith('development/')));
});

function sourceOriginalFixture(t){
  const directory=temporary();t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'voice.ogg'),bytes=Buffer.from('OggS SYNTHETIC ORIGINAL');
  fs.writeFileSync(filePath,bytes,{flag:'wx',mode:0o600});
  return {directory,bytes,input:{schemaVersion:1,requestId:'11111111-2222-4333-8444-555555555555',
    original:{filePath,sizeBytes:bytes.length,sha256:digest(bytes)},outputDirectory:path.join(directory,'job')}};
}

test('cold source use prepares the fixed engine without a consent question or an inference claim',async t=>{
  const {directory,input}=sourceOriginalFixture(t),calls=[];
  const result=await processSourceOriginal(input,{root:path.join(directory,'cache'),run:async args=>{
    calls.push(args);
    if(args[0]==='doctor')return {ready:false,downloadPlan:{planHash:'PRIVATE_PLAN'}};
    assert.deepEqual(args,['ensure']);return {ok:true,state:'installing'};
  }});
  assert.equal(result.state,'queued');assert.equal(result.consentRequired,undefined);
  assert.deepEqual(calls,[['doctor'],['ensure']]);assert.equal(fs.existsSync(input.outputDirectory),false);
  assert.equal(fs.existsSync(path.join(directory,'.source-attempt.json')),false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PLAN|voice\.ogg/);
  // Ordinary context reads wait through setup, then use the same one-start
  // source protocol. No setup state may masquerade as a decoded transcript.
  for(const preparation of [{ok:true,state:'unknown'},{ok:false,state:'failed'}]){
    const observed=await processSourceOriginal(input,{root:directory,run:async args=>
      args[0]==='doctor'?{ready:false}:preparation});
    assert.equal(observed.state,preparation.state==='unknown'?'unknown':'unavailable');
    assert.equal(observed.contentRead,false);assert.equal(observed.consentRequired,undefined);
    assert.equal(fs.existsSync(path.join(directory,'.source-attempt.json')),false);
  }
});

test('source ASR starts once, returns byte-free progress and verifies complete original-bound output',async t=>{
  const {directory,input}=sourceOriginalFixture(t),calls=[];
  const execute=async args=>{
    calls.push(args[0]);
    if(args[0]==='doctor')return {ready:true,model:'v3_rnnt'};
    if(args[0]==='start'){
      assert.equal(args[2],path.join(directory,'source.ogg'));
      assert.deepEqual(fs.readFileSync(args[2]),fs.readFileSync(input.original.filePath));
      atomicJson(path.join(input.outputDirectory,'job.json'),{schemaVersion:1,input:args[2],
        originalSize:input.original.sizeBytes,model:'v3_rnnt',state:'queued'});
      return {ok:true,state:'queued'};
    }
    assert.equal(args[0],'status');return {ok:true,state:'completed'};
  };
  const pending=await processSourceOriginal(input,{root:directory,run:execute});
  assert.equal(pending.state,'queued');assert.equal(pending.contentRead,false);
  atomicJson(path.join(input.outputDirectory,'job.json'),{schemaVersion:1,input:path.join(directory,'source.ogg'),
    originalSize:input.original.sizeBytes,model:'v3_rnnt',state:'completed',sourceSha256:input.original.sha256});
  atomicJson(path.join(input.outputDirectory,'transcript.json'),{model:'v3_rnnt',complete:true});
  const words=Buffer.from('проверенное тестовое голосовое');
  fs.writeFileSync(path.join(input.outputDirectory,'transcript.txt'),words,{mode:0o600});
  const completed=await processSourceOriginal(input,{root:directory,run:execute});
  assert.equal(completed.state,'completed');assert.equal(completed.contentRead,false,'host must independently read and verify transcript bytes');
  assert.deepEqual(completed.text,{sizeBytes:words.length,sha256:digest(words)});
  assert.deepEqual(calls,['doctor','start','doctor','status']);
  assert.doesNotMatch(JSON.stringify(completed),/проверенное|voice\.ogg|job/);
  atomicJson(path.join(input.outputDirectory,'transcript.json'),{model:'v3_rnnt',complete:false});
  await assert.rejects(processSourceOriginal(input,{root:directory,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
});

test('an uncertain source start remains status-only and cannot launch another worker',async t=>{
  const {directory,input}=sourceOriginalFixture(t);let starts=0;
  const execute=async args=>{
    if(args[0]==='doctor')return {ready:true,model:'v3_rnnt'};
    starts++;throw Error('AUDIO_SYNTHETIC_LOST_START');
  };
  await assert.rejects(processSourceOriginal(input,{root:directory,run:execute}),/AUDIO_SYNTHETIC_LOST_START/);
  const observed=await processSourceOriginal(input,{root:directory,run:execute});
  assert.equal(observed.state,'unknown');assert.equal(starts,1);
});

function completedSourceFixture(t){
  const scratch=temporary();t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const original=path.join(scratch,'voice.ogg'),bytes=Buffer.from('OggS COMPLETE SOURCE FIXTURE');
  fs.writeFileSync(original,bytes,{mode:0o600,flag:'wx'});
  const input={schemaVersion:1,requestId:'11111111-2222-4333-8444-555555555555',
    original:{filePath:original,sizeBytes:bytes.length,sha256:digest(bytes)},
    outputDirectory:path.join(privateDirectory(path.join(scratch,'download-new001')),'job')};
  const complete=(name,text='готовая расшифровка')=>{
    const parent=privateDirectory(path.join(scratch,name)),directory=privateDirectory(path.join(parent,'job'));
    fs.writeFileSync(path.join(parent,'source.ogg'),bytes,{mode:0o600});
    atomicJson(path.join(parent,'.source-attempt.json'),{schemaVersion:1,requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',original:input.original});
    atomicJson(path.join(directory,'job.json'),{schemaVersion:1,state:'completed',model:'v3_rnnt',
      input:path.join(parent,'source.ogg'),originalSize:bytes.length,sourceSha256:input.original.sha256});
    atomicJson(path.join(directory,'transcript.json'),{complete:true,model:'v3_rnnt'});
    fs.writeFileSync(path.join(directory,'transcript.txt'),text,{mode:0o600});return directory;
  };
  const execute=async args=>{assert.deepEqual(args,['doctor'],'completed reuse cannot invoke start/status/setup');return {ready:true,model:'v3_rnnt'};};
  return {scratch,input,complete,execute};
}

test('a fresh exact source reuses complete output without adopting an old job or starting a decoder',async t=>{
  const {scratch,input,complete,execute}=completedSourceFixture(t);
  const old=complete('download-old001'),oldJob=fs.readFileSync(path.join(old,'job.json'));
  complete('download-old002'); // Equivalent duplicates never mean newest wins.
  const result=await processSourceOriginal(input,{root:scratch,run:execute});
  assert.equal(result.state,'completed');assert.equal(result.contentRead,false);
  assert.deepEqual(result.text,sourceFileFingerprint(path.join(old,'transcript.txt'),24*1024*1024));
  assert.deepEqual(fs.readFileSync(path.join(input.outputDirectory,'transcript.txt')),fs.readFileSync(path.join(old,'transcript.txt')));
  assert.deepEqual(fs.readFileSync(path.join(old,'job.json')),oldJob,'historical inference remains immutable');
  assert.equal(fs.existsSync(path.join(input.outputDirectory,'job.json')),false,'a derived read is not a new inference job');
  assert.equal(fs.existsSync(path.join(input.outputDirectory,'launch.json')),false);
  assert.deepEqual(await processSourceOriginal(input,{root:scratch,run:execute}),result);
  fs.appendFileSync(path.join(input.outputDirectory,'transcript.txt'),'tampered');
  await assert.rejects(processSourceOriginal(input,{root:scratch,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
});

test('partial, conflicting or changed-model source history cannot create another decoder',async t=>{
  const {scratch,input,complete,execute}=completedSourceFixture(t);
  const old=complete('download-old001');
  const file=path.join(old,'job.json'),saved=JSON.parse(fs.readFileSync(file));
  for(const state of ['transcribing','failed']){
    atomicJson(file,{...saved,state});
    const observed=await processSourceOriginal(input,{root:scratch,run:execute});
    assert.equal(observed.state,'unknown');assert.equal(fs.existsSync(input.outputDirectory),false);
  }
  atomicJson(file,{...saved,model:'other_model'});
  assert.equal((await processSourceOriginal(input,{root:scratch,run:execute})).state,'unknown');
  atomicJson(file,saved);complete('download-old002','другая расшифровка');
  await assert.rejects(processSourceOriginal(input,{root:scratch,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
  assert.equal(fs.existsSync(path.join(path.dirname(input.outputDirectory),'.source-attempt.json')),false);
});

test('a current unknown source start is never hidden by another completed result',async t=>{
  const {scratch,input,complete,execute}=completedSourceFixture(t);complete('download-old001');
  atomicJson(path.join(path.dirname(input.outputDirectory),'.source-attempt.json'),
    {schemaVersion:1,requestId:input.requestId,original:input.original});
  const result=await processSourceOriginal(input,{root:scratch,run:execute});
  assert.equal(result.state,'unknown');assert.equal(fs.existsSync(input.outputDirectory),false);
});

test('source reuse rejects altered frozen audio, incomplete final JSON and oversized discovery',async t=>{
  const {scratch,input,complete,execute}=completedSourceFixture(t),old=complete('download-old001');
  atomicJson(path.join(old,'transcript.json'),{complete:false,model:'v3_rnnt'});
  await assert.rejects(processSourceOriginal(input,{root:scratch,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
  atomicJson(path.join(old,'transcript.json'),{complete:true,model:'v3_rnnt'});
  fs.appendFileSync(path.join(path.dirname(old),'source.ogg'),'changed');
  await assert.rejects(processSourceOriginal(input,{root:scratch,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
  for(let i=0;i<256;i++)fs.mkdirSync(path.join(scratch,`bounded-${i}`));
  await assert.rejects(processSourceOriginal(input,{root:scratch,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
});

test('atomic progress replacement is pending without bytes; original and terminal identity stay strict',t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'job.json');atomicJson(file,{state:'queued'});
  // Real atomic rename between stat/ACL and open, not a mocked stat return.
  // This reproduces the native Windows race even on fast Linux/macOS hosts.
  const replace=()=>atomicJson(file,{state:'transcribing',processedSamples:16000});
  assert.throws(()=>readSourceProgressJson(file,{afterStat:replace}),
    error=>error.code==='AUDIO_SOURCE_SNAPSHOT_CHANGED');
  assert.deepEqual(readSourceProgressJson(file),{state:'transcribing',processedSamples:16000});
  assert.throws(()=>sourceFileFingerprint(file,1024,{afterStat:()=>atomicJson(file,{state:'completed'})}),
    error=>error.code==='AUDIO_SOURCE_INPUT_INVALID');
  const link=path.join(root,'linked.json');fs.linkSync(file,link);
  assert.throws(()=>readSourceProgressJson(file),/AUDIO_SOURCE_INPUT_INVALID/);
});

test('source private input and file guards reject poison, links, false hashes and excessive bytes',async t=>{
  const {directory,input}=sourceOriginalFixture(t);
  const execute=async()=>{throw Error('MUST_NOT_REACH_DOCTOR');};
  for(const value of [null,{...input,command:'setup'},{...input,requestId:'invented'},
    {...input,original:{...input.original,sha256:'0'.repeat(64)}},
    {...input,original:{...input.original,sizeBytes:1}},
    {...input,outputDirectory:'relative/job'}]){
    await assert.rejects(processSourceOriginal(value,{root:directory,run:execute}),/AUDIO_SOURCE_INPUT_INVALID/);
  }
  const chunks=async function*(value){yield Buffer.from(value);};
  assert.deepEqual(await readSourceOriginalInput(chunks(JSON.stringify(input))),input);
  for(const value of ['x'.repeat(8193),'{} PRIVATE',Buffer.from([0xff])]){
    await assert.rejects(readSourceOriginalInput(chunks(value)),/AUDIO_SOURCE_INPUT_INVALID/);
  }
  const empty=path.join(directory,'empty.txt');fs.writeFileSync(empty,'',{mode:0o600});
  assert.deepEqual(sourceFileFingerprint(empty,1,{allowEmpty:true}),{sizeBytes:0,sha256:digest(Buffer.alloc(0))});
  assert.throws(()=>sourceFileFingerprint(empty,1),/AUDIO_SOURCE_INPUT_INVALID/);
  const alias=path.join(directory,'hardlink.ogg');
  fs.linkSync(input.original.filePath,alias);
  assert.throws(()=>sourceFileFingerprint(alias,20*1024*1024),/AUDIO_SOURCE_INPUT_INVALID/);
  fs.unlinkSync(alias);
  const target=privateDirectory(path.join(directory,'target')),redirect=path.join(directory,'redirect');
  fs.symlinkSync(target,redirect,process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(target,'voice.ogg'),'private',{mode:0o600});
  assert.throws(()=>sourceFileFingerprint(path.join(redirect,'voice.ogg'),100),/AUDIO_SOURCE_INPUT_INVALID/);
  fs.unlinkSync(redirect);
});

test('Windows source ownership follows this token only inside a private user parent; foreign ACL still refuses',
  {skip:process.platform!=='win32'},t=>{
  const {input}=sourceOriginalFixture(t);
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const helper=path.join(providerRoot,'tests/source-path-fixture.ps1');
  const invoke=operation=>{
    const result=spawnSync(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
      '-LiteralPath',input.original.filePath,'-Operation',operation],{shell:false,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:4096});
    assert.equal(result.status,0,'owned native source fixture must complete');
    return JSON.parse(result.stdout);
  };
  const observed=invoke('inspect');
  assert.ok(observed.ownerMatchesUser||observed.ownerMatchesDefault);
  assert.equal(observed.parentOwnedByUser,true);assert.equal(observed.parentProtected,true);
  assert.deepEqual(sourceFileFingerprint(input.original.filePath,20*1024*1024),
    {sizeBytes:input.original.sizeBytes,sha256:input.original.sha256});
  assert.deepEqual(invoke('add-foreign-allow'),{fixtureChanged:true});
  assert.throws(()=>sourceFileFingerprint(input.original.filePath,20*1024*1024),
    error=>error.code==='AUDIO_SOURCE_INPUT_INVALID_AUDIENCE');
});

test('doctor/plan cannot download or create a cache; stale approval fails closed', async () => {
  const parent = temporary(), root = path.join(parent, 'new-cache');
  const doctor = await run(['doctor'], {root});
  assert.equal(doctor.ready, false);
  assert.equal(doctor.consentRequired, false);
  assert.equal(doctor.automaticSetupAvailable, true);
  assert.equal(fs.existsSync(root), false);
  assert.equal((await run(['setup'], {root})).downloadPlan.planHash, doctor.downloadPlan.planHash);
  await assert.rejects(run(['setup', '--approve', 'wrong'], {root}), /AUDIO_DOWNLOAD_CONSENT_REQUIRED/u);
  assert.equal(fs.existsSync(root), false);
  assert.notEqual(installationPlan(root).planHash, installationPlan(path.join(parent, 'different')).planHash);
  fs.rmSync(parent, {recursive: true});
});

test('unconsented internal installation cannot perform network IO', async () => {
  const root = temporary();
  await assert.rejects(performSetup(installationPlan(root).planHash, root), /AUDIO_DOWNLOAD_CONSENT_REQUIRED/u);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, {recursive: true});
});

test('automatic setup records a single exact request, never human consent, and preserves unknown/failure',t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let starts=0;
  const launcher=(executable,args,options)=>{
    starts++;assert.equal(executable,process.execPath);
    assert.equal(args[1],'__setup');assert.equal(args[2],installationPlan(root).planHash);
    assert.equal(options.shell,false);assert.equal(options.env.PRIVATE_TOKEN,undefined);
    const child=new EventEmitter();child.pid=process.pid;child.unref=()=>{};return child;
  };
  assert.equal(ensureSetup(root,{launcher}).state,'installing');
  const file=path.join(root,'setup-dispatch.json'),bytes=fs.readFileSync(file);
  const request=JSON.parse(bytes);
  assert.equal(request.reason,'skill-use');assert.equal(request.planHash,installationPlan(root).planHash);
  assert.equal(fs.existsSync(path.join(root,'download-consent.json')),false);
  assert.equal(ensureSetup(root,{launcher}).state,'installing');assert.equal(starts,1);
  assert.deepEqual(fs.readFileSync(file),bytes);
  atomicJson(file,{...request,pid:null});
  assert.equal(ensureSetup(root,{launcher}).state,'unknown');assert.equal(starts,1);
  atomicJson(path.join(root,'setup.json'),{state:'failed',errorCode:'AUDIO_DOWNLOAD_DIGEST_MISMATCH'});
  assert.equal(ensureSetup(root,{launcher}).errorCode,'AUDIO_DOWNLOAD_DIGEST_MISMATCH');
  assert.equal(starts,1,'context polling must not silently retry a failed installation');
  assert.equal(startSetup(installationPlan(root).planHash,root,{launcher}).state,'installing');
  assert.equal(starts,2,'only the explicit diagnosed retry can replace a known failed attempt');
  assert.ok(fs.readdirSync(root).some(name=>name.endsWith('.failed')));
});

test('automatic setup cannot consume a foreign plan or recover an orphan dispatch lock',t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const launcher=()=>{throw Error('MUST_NOT_SPAWN');};
  atomicJson(path.join(root,'setup-dispatch.json'),{schemaVersion:1,requestId:'11111111-2222-4333-8444-555555555555',
    planHash:'0'.repeat(64),reason:'skill-use',requestedAt:new Date().toISOString(),pid:null});
  assert.equal(ensureSetup(root,{launcher}).errorCode,'AUDIO_SETUP_PLAN_CHANGED');
  fs.unlinkSync(path.join(root,'setup-dispatch.json'));
  fs.writeFileSync(path.join(root,'setup-dispatch.lock'),'');
  const past=new Date(Date.now()-11000);fs.utimesSync(path.join(root,'setup-dispatch.lock'),past,past);
  assert.equal(ensureSetup(root,{launcher}).state,'unknown');
  assert.equal(fs.existsSync(path.join(root,'setup-dispatch.lock')),true);
});

test('concurrent native parents dispatch exactly one automatic installer',async t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=path.join(providerRoot,'tests/setup-dispatch-fixture.mjs');
  const invoke=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fixture,root],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:childEnvironment(root)});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(Error(stderr)));
  });
  const results=await Promise.all([invoke(),invoke(),invoke()]);
  assert.ok(results.every(result=>['installing','unknown'].includes(result.state)));
  assert.equal(fs.readFileSync(path.join(root,'fixture-dispatches'),'utf8').trim().split('\n').length,1);
  assert.equal(fs.existsSync(path.join(root,'download-consent.json')),false);
});

test('invalid ordinary input and old-model resume never trigger first-use preparation',async t=>{
  const root=temporary(),cache=path.join(root,'cache');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await assert.rejects(run(['start','--input','relative.ogg','--output-dir',path.join(root,'out')],{root:cache}),/AUDIO_INPUT_OR_OUTPUT_INVALID/);
  const job=privateDirectory(path.join(root,'old-job'));
  atomicJson(path.join(job,'job.json'),{schemaVersion:1,model:'old-model',state:'cancelled'});
  await assert.rejects(run(['resume','--job-dir',job],{root:cache}),/AUDIO_JOB_MODEL_MISMATCH/);
  assert.equal(fs.existsSync(cache),false);
});

test('an earlier E2E installation receipt cannot approve the RNNT model download', async () => {
  const root = temporary();
  const current = installationPlan(root);
  const {planHash, ...material} = current;
  // Reconstruct a prior-model plan for this SAME device directory. Its valid
  // digest is not consent to the different bytes in the current signed plan.
  const previousHash = digest(JSON.stringify({...material, model: 'v3_e2e_rnnt', models: [
    {name: 'v3_e2e_rnnt.ckpt',
      url: 'https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/v3_e2e_rnnt.ckpt',
      sha256: 'f60c62fe45902d967000770a12f260de7c5ac4d4b8e5e852f1df8c548e3958b5', bytes: 448929252},
    {name: 'v3_e2e_rnnt_tokenizer.model',
      url: 'https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/v3_e2e_rnnt_tokenizer.model',
      sha256: '828c12c991019eef952a960661f25a92d6ad279591e2ea466b4aeddf1d20a18a', bytes: 255336},
  ]}));
  atomicJson(path.join(root, 'installed.json'), {planHash: previousHash, model: 'v3_e2e_rnnt'});
  atomicJson(path.join(root, 'download-consent.json'), {planHash: previousHash});
  const doctor = await run(['doctor'], {root});
  assert.equal(doctor.ready, false);
  assert.equal(doctor.model, 'v3_rnnt');
  assert.equal(doctor.consentRequired, false);
  assert.equal(doctor.downloadPlan.models.length, 1);
  assert.equal(doctor.downloadPlan.models[0].name, 'v3_rnnt.ckpt');
  assert.equal(doctor.downloadPlan.planHash, planHash);
  assert.notEqual(previousHash, planHash);
  await assert.rejects(performSetup(previousHash, root), /AUDIO_DOWNLOAD_CONSENT_REQUIRED/u);
  assert.equal(fs.existsSync(path.join(root, 'setup.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'downloads')), false);
  fs.rmSync(root, {recursive: true});
});

test('completed E2E results stay readable through status without the new model installed', async () => {
  const root = temporary();
  const job = {schemaVersion: 1, model: 'v3_e2e_rnnt', state: 'completed',
    segments: [{text: 'Старые слова.'}], processedSamples: 16000, totalSeconds: 1};
  atomicJson(path.join(root, 'job.json'), job);
  const before = fs.readFileSync(path.join(root, 'job.json'));
  const status = await run(['status', '--job-dir', root]);
  assert.equal(status.model, 'v3_e2e_rnnt');
  assert.equal(status.state, 'completed');
  assert.equal(status.files.length, 3);
  assert.deepEqual(fs.readFileSync(path.join(root, 'job.json')), before);
  assert.equal(fs.existsSync(path.join(root, 'launch.json')), false);
  fs.rmSync(root, {recursive: true});
});

test('download resumes exact bytes, then verifies the entire artifact', async () => {
  const root = temporary(), target = path.join(root, 'artifact');
  const value = Buffer.from('abcdef');
  fs.writeFileSync(target + '.part', 'abc');
  let calls = 0;
  await downloadArtifact(artifact(value), target, {fetcher: async (url, options) => {
    calls++;
    assert.equal(options.headers.Range, 'bytes=3-');
    return new Response('def', {status: 206, headers: {'content-range': 'bytes 3-5/6'}});
  }});
  assert.equal(fs.readFileSync(target).toString(), 'abcdef');
  await downloadArtifact(artifact(value), target, {fetcher: () => {throw Error('cached artifact must not use network');}});
  assert.equal(calls, 1);
  fs.rmSync(root, {recursive: true});
});

test('transient transport/server errors receive three safe attempts, without integrity retry', async () => {
  const root = temporary(), target = path.join(root, 'artifact');
  let calls = 0;
  await downloadArtifact(artifact(Buffer.from('abc')), target, {retryDelays: [0, 0], fetcher: async () => {
    calls++;
    if (calls === 1) throw new TypeError('synthetic transport failure');
    return calls === 2 ? new Response(null, {status: 503}) : new Response('abc');
  }});
  assert.equal(calls, 3);
  fs.rmSync(root, {recursive: true});
});

const withMirror = value => ({...artifact(value), fallbackUrls: [
  `https://trelio.ru/media/model-artifacts/gigaam/${digest(value)}/v3_rnnt.ckpt`,
]});

test('unavailable official TLS falls back to the byte-identical Trelio model; a valid cache needs no network', async t => {
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  const bytes=Buffer.from('synthetic pinned checkpoint'),selected=withMirror(bytes),target=path.join(root,'model'),calls=[];
  await downloadArtifact(selected,target,{retryDelays:[],fetcher:async url=>{
    calls.push(String(url));
    if(calls.length===1)throw new TypeError('synthetic expired certificate',{cause:{code:'CERT_HAS_EXPIRED'}});
    return new Response(bytes);
  }});
  assert.deepEqual(calls,[selected.url,selected.fallbackUrls[0]]);
  assert.deepEqual(fs.readFileSync(target),bytes);
  await downloadArtifact(selected,target,{fetcher:()=>{throw Error('a verified cache must not contact either server');}});
});

test('mirror resume shares the original deadline across bounded retries and still verifies the full file',async t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  const bytes=Buffer.from('abcdef'),selected=withMirror(bytes),target=path.join(root,'model'),signals=[];let calls=0;
  fs.writeFileSync(target+'.part','abc');
  await downloadArtifact(selected,target,{retryDelays:[0,0],fetcher:async(url,options)=>{
    calls++;signals.push(options.signal);assert.equal(options.headers.Range,'bytes=3-');
    if(String(url)===selected.url)return new Response(null,{status:503});
    return new Response('def',{status:206,headers:{'content-range':'bytes 3-5/6'}});
  }});
  assert.equal(calls,4);assert.ok(signals.every(signal=>signal===signals[0]));
  assert.deepEqual(fs.readFileSync(target),bytes);
});

test('integrity, range, size, origin and authorization failures never switch to a mirror',async t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  for(const [kind,response,code] of [
    ['digest',()=>new Response('xxxxxx'),/DIGEST_MISMATCH/u],
    ['size',()=>new Response('abcdefg'),/TOO_LARGE/u],
    ['range',()=>new Response('def',{status:206,headers:{'content-range':'bytes 0-2/6'}}),/RANGE_INVALID/u],
    ['origin',()=>new Response(null,{status:302,headers:{location:'https://untrusted.invalid/model'}}),/ORIGIN_DENIED/u],
    ['authorization',()=>new Response(null,{status:403}),/DOWNLOAD_FAILED/u],
  ]){
    const target=path.join(root,kind);let calls=0;
    if(kind==='range')fs.writeFileSync(target+'.part','abc');
    await assert.rejects(downloadArtifact(withMirror(Buffer.from('abcdef')),target,{retryDelays:[],fetcher:async()=>{calls++;return response();}}),code);
    assert.equal(calls,1,kind);assert.equal(fs.existsSync(target),false);
  }
});

test('only the signed digest-addressed HTTPS model mirror is admitted before any request',async t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  const selected=withMirror(Buffer.from('abc'));
  for(const url of [selected.fallbackUrls[0].replace('https:','http:'),selected.fallbackUrls[0]+'?override=1',
    selected.fallbackUrls[0].replace(selected.sha256,'0'.repeat(64)),
    'https://trelio.ru/api/private','https://other.invalid/model']){
    let calls=0;
    await assert.rejects(downloadArtifact({...selected,fallbackUrls:[url]},path.join(root,'model'),{
      fetcher:()=>{calls++;throw Error('invalid mirror must fail before network');}}),/AUDIO_DOWNLOAD_ORIGIN_DENIED/u);
    assert.equal(calls,0);
  }
});

test('adding only a model mirror preserves a completed exact installation, not permission for a new setup',async t=>{
  const root=temporary();t.after(()=>fs.rmSync(root,{recursive:true}));
  const {planHash,...material}=installationPlan(root);
  assert.ok(material.models[0].fallbackUrls?.length);
  const oldMaterial={...material,models:material.models.map(({fallbackUrls,...model})=>model),
    sources:material.sources.filter(source=>source!=='trelio.ru')};
  const oldHash=digest(JSON.stringify(oldMaterial));assert.notEqual(oldHash,planHash);
  // Readiness checks installed identity/file presence, not inference. This
  // sparse synthetic file is never loaded; native CI separately verifies the
  // entire genuine checkpoint before actual inference on every supported OS.
  fs.mkdirSync(path.dirname(pythonPath(root)),{recursive:true});fs.writeFileSync(pythonPath(root),'');
  fs.mkdirSync(path.join(root,'models'));
  for(const model of material.models){const file=path.join(root,'models',model.name);fs.writeFileSync(file,'');fs.truncateSync(file,model.bytes);}
  atomicJson(path.join(root,'installed.json'),{planHash:oldHash,model:material.model});
  const before=fs.readFileSync(path.join(root,'installed.json'));assert.equal(ready(root),true);
  assert.deepEqual(fs.readFileSync(path.join(root,'installed.json')),before,'compatibility never rewrites historical consent');
  atomicJson(path.join(root,'download-consent.json'),{planHash:oldHash});
  await assert.rejects(performSetup(oldHash,root),/AUDIO_DOWNLOAD_CONSENT_REQUIRED/u);
  assert.equal(fs.existsSync(path.join(root,'setup.lock')),false);
});

test('a worker that dies before its first checkpoint is reported as interrupted', async () => {
  const root = privateDirectory(temporary());
  atomicJson(path.join(root, 'job.json'), {schemaVersion: 1, model: artifacts.model, state: 'queued', runId: 'fixture', segments: []});
  atomicJson(path.join(root, 'launch.json'), {runId: 'fixture', pid: null, startedAt: Date.now() - 60000});
  assert.equal((await run(['status', '--job-dir', root])).state, 'interrupted');
  fs.rmSync(root, {recursive: true});
});

test('wrong range, wrong checksum, oversize and untrusted redirect never become usable artifacts', async () => {
  const root = temporary();
  for (const [name, response, expected] of [
    ['range', () => new Response('def', {status: 206, headers: {'content-range': 'bytes 0-2/6'}}), /AUDIO_DOWNLOAD_RANGE_INVALID/u],
    ['digest', () => new Response('xxxxxx'), /AUDIO_DOWNLOAD_DIGEST_MISMATCH/u],
    ['oversize', () => new Response('abcdefg'), /AUDIO_DOWNLOAD_TOO_LARGE/u],
    ['origin', () => new Response(null, {status: 302, headers: {location: 'http://127.0.0.1/private'}}), /AUDIO_DOWNLOAD_ORIGIN_DENIED/u],
  ]) {
    const target = path.join(root, name);
    if (name === 'range') fs.writeFileSync(target + '.part', 'abc');
    await assert.rejects(downloadArtifact(artifact(Buffer.from('abcdef')), target, {fetcher: async () => response()}), expected);
    assert.equal(fs.existsSync(target), false);
  }
  fs.rmSync(root, {recursive: true});
});

test('private paths reject symlinks and CLI never accepts network inputs or hidden operations', async t => {
  const root = temporary();
  if (process.platform !== 'win32') {
    fs.symlinkSync(root, path.join(root, 'redirect'));
    assert.throws(() => privateDirectory(path.join(root, 'redirect', 'nested')), /AUDIO_PRIVATE_STORAGE_DENIED/u);
  }
  assert.throws(() => argumentsObject(['__setup']), /AUDIO_COMMAND_INVALID/u);
  assert.throws(() => argumentsObject(['start', '--unknown', 'value']), /AUDIO_ARGUMENTS_INVALID/u);
  assert.throws(() => argumentsObject(['doctor', '--approve', 'yes']), /AUDIO_ARGUMENTS_INVALID/u);
  const env = childEnvironment(root);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.IMAGEIO_FFMPEG_EXE, undefined);
  assert.equal(env.UV_INDEX_URL, undefined);
  assert.equal(env.PROCESSOR_ARCHITECTURE, process.platform === 'win32' && process.arch === 'x64' ? 'AMD64' : undefined);
  assert.equal(env.PROCESSOR_ARCHITEW6432, undefined);
  fs.rmSync(root, {recursive: true});
});

test('a host-filtered provider reconstructs Windows architecture without inheriting overrides or secrets', () => {
  const root = temporary();
  // Exercise another real Node process: changing the parent's environment or
  // mocking platform.machine() would miss the host -> provider -> child boundary.
  const program = `
    const {childEnvironment} = await import(process.argv[1]);
    const env = childEnvironment(process.argv[2]);
    process.stdout.write(JSON.stringify({architecture: env.PROCESSOR_ARCHITECTURE ?? null,
      wow64: env.PROCESSOR_ARCHITEW6432 ?? null, secret: Object.hasOwn(env, 'PRIVATE_TOKEN'),
      pythonOverride: Object.hasOwn(env, 'PYTHONPATH'), indexOverride: Object.hasOwn(env, 'UV_INDEX_URL')}));
  `;
  for (const fields of [{}, {PROCESSOR_ARCHITECTURE: 'ARM64', PROCESSOR_ARCHITEW6432: 'ARM64'}]) {
    const environment = {...childEnvironment(root), PRIVATE_TOKEN: 'synthetic-secret', PYTHONPATH: 'synthetic-override', UV_INDEX_URL: 'https://invalid.example'};
    delete environment.PROCESSOR_ARCHITECTURE;
    Object.assign(environment, fields);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program,
      new URL('../scripts/bootstrap.mjs', import.meta.url).href, root],
      {shell: false, env: environment, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      architecture: process.platform === 'win32' && process.arch === 'x64' ? 'AMD64' : null,
      wow64: null, secret: false, pythonOverride: false, indexOverride: false,
    });
  }
  fs.rmSync(root, {recursive: true});
});

test('Whisper setup and model choice stay separate from the default GigaAM plan', async t => {
  const root = temporary();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const defaultArgs = ['doctor'];
  const original = await run(defaultArgs, {root});
  const alternate = await run(['doctor', '--model', whisper.model], {root});
  assert.equal(original.model, 'v3_rnnt');
  assert.equal(alternate.model, whisper.model);
  assert.equal(alternate.downloadPlan.directory, modelDirectory(root, whisper.model));
  assert.notEqual(alternate.downloadPlan.planHash, original.downloadPlan.planHash);
  assert.deepEqual(await run(defaultArgs, {root}), original);
  await assert.rejects(run(['setup', '--model', whisper.model, '--approve', original.downloadPlan.planHash], {root}),
    /AUDIO_DOWNLOAD_CONSENT_REQUIRED/u);
  await assert.rejects(run(['start', '--model', 'v3_rnnt', '--language', 'en'], {root}), /AUDIO_LANGUAGE_MODEL_MISMATCH/u);
  await assert.rejects(run(['start', '--language', 'en-US'], {root}), /AUDIO_LANGUAGE_INVALID/u);
  const job = privateDirectory(path.join(root, 'job'));
  atomicJson(path.join(job, 'job.json'), {schemaVersion: 1, model: whisper.model,
    modelRevision: 'old-revision', language: 'auto', state: 'cancelled'});
  await assert.rejects(run(['resume', '--job-dir', job], {root}), /AUDIO_JOB_MODEL_MISMATCH/u);
  assert.equal(fs.existsSync(path.join(job, 'launch.json')), false);
  assert.equal((await run(['status', '--job-dir', job], {root})).model, whisper.model);
  assert.deepEqual(fs.readdirSync(root), ['job'], 'offline previews and invalid requests must not create setup state');
});

test('pinned Whisper fetch rejects redirects out of its distribution origins', async t => {
  const root = temporary();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const model = whisper.models.find(item => item.name === 'model.bin');
  const requested = [];
  await assert.rejects(downloadArtifact(model, path.join(root, model.name), {
    fetcher: async url => {
      requested.push(url.href);
      return new Response(null, {status: 302, headers: {location: 'https://github.com/unrelated/model.bin'}});
    },
  }), /AUDIO_DOWNLOAD_ORIGIN_DENIED/u);
  assert.deepEqual(requested, [model.url]);
});

test('signed package binds upstream source, inference entrypoints and full guide, without model bytes', () => {
  const built = buildRuntimePackage(providerRoot);
  assert.equal(built.skillId, 'audio-transcription');
  assert.ok(built.packageSizeBytes < 1024 * 1024);
  const bytes = JSON.parse(built.packageBytes);
  // Catalog patch history is independent of the executable protocol. The
  // actual signed identity must retain the source-original ABI that existing
  // host/backend readers admit from runtime 1.2.0, even for a 1.1.x catalog fix.
  const [major, minor] = bytes.skill.runtimeVersion.split('.').map(Number);
  assert.equal(major, 1);
  assert.ok(minor >= 2, 'the published executable must satisfy source-original admission');
  assert.equal(bytes.skill.runtimeVersion, RUNTIME_VERSION);
  for (const name of ['scripts/audio-transcription.mjs', 'engine/worker.py', 'engine/uv.lock', 'engine/whisper/uv.lock', 'engine/whisper/pyproject.toml', 'scripts/whisper-artifacts.json', 'references/workflow.md', 'engine/vendor/GigaAM-LICENSE']) assert.ok(bytes.files.some(file => file.path === name), name);
  assert.ok(!bytes.files.some(file => /\.(?:ckpt|wav|m4a|exe|whl)$/u.test(file.path)));
  const upstream = JSON.parse(fs.readFileSync(path.join(providerRoot, 'engine/vendor/origin.json')));
  for (const [name, expected] of Object.entries(upstream.files)) assert.equal(digest(fs.readFileSync(path.join(providerRoot, 'engine/vendor/gigaam', name))), expected);
});

test('assistant command policy is signed with the actual package and matches only ordinary parser leaves',()=>{
  const built=JSON.parse(buildRuntimePackage(providerRoot).packageBytes);
  const files=built.files.filter(file=>file.path==='trelio-assistant-execution.json');
  assert.equal(files.length,1,'a catalogue instruction alone cannot grant task execution');
  const bytes=Buffer.from(files[0].contentBase64,'base64');
  assert.equal(digest(bytes),files[0].sha256);
  const policy=JSON.parse(bytes);
  assert.deepEqual(Object.keys(policy).sort(),['schemaVersion','taskCommands']);
  assert.equal(policy.schemaVersion,1);
  assert.deepEqual(policy.taskCommands,[['guides'],['doctor'],['ensure'],['setup'],['start'],['status'],['resume'],['cancel']]);
  for(const [command] of policy.taskCommands)assert.equal(argumentsObject([command]).command,command);
  for(const command of ['source-original','__setup','login','configure','monitor','send']){
    assert.equal(policy.taskCommands.some(prefix=>prefix[0]===command),false,'private source/install entrypoints never become task commands');
    assert.throws(()=>argumentsObject([command]),/AUDIO_COMMAND_INVALID/);
  }
});

test('materialized package CLI returns its complete guide before model/cache IO', () => {
  const root = temporary(), directory = path.join(root, 'package');
  const built = JSON.parse(buildRuntimePackage(providerRoot).packageBytes);
  for (const file of built.files) {
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'));
  }
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/audio-transcription.mjs'), 'guides'],
    {shell: false, cwd: root, encoding: 'utf8', env: {SystemRoot: process.env.SystemRoot}, timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const guide = JSON.parse(result.stdout).guides[0];
  const expected = path.join(directory, 'references/workflow.md');
  assert.equal(fs.realpathSync(guide.path), fs.realpathSync(expected));
  assert.equal(guide.sha256, digest(fs.readFileSync(expected)));
  assert.equal(guide.bytes, fs.statSync(expected).size);
  assert.deepEqual(fs.readdirSync(root), ['package']);
  fs.rmSync(root, {recursive: true});
});

test('prepared host actually uses a managed Python and official checksum-pinned model', {skip: !fixture && !process.env.CI}, () => {
  assert.ok(fixture, 'CI must run its provider-owned first-install preparation');
  assert.equal(ready(fixture.root), true);
  const result = spawnSync(pythonPath(fixture.root), ['-I', '-c', 'import torch,torchaudio,imageio_ffmpeg;print(torch.__version__);print(torchaudio.__version__)'], {env: childEnvironment(fixture.root), encoding: 'utf8', shell: false, timeout: 60000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2\.8\.0/u);
  for (const item of artifacts.models) assert.equal(fs.statSync(path.join(fixture.root, 'models', item.name)).size, item.bytes);
  const installed=fs.readFileSync(path.join(fixture.root,'installed.json'));
  assert.equal(ensureSetup(fixture.root,{launcher:()=>{throw Error('READY_CACHE_MUST_NOT_LAUNCH');}}).state,'ready');
  assert.deepEqual(fs.readFileSync(path.join(fixture.root,'installed.json')),installed);
});

test('native Windows Python gets its machine marker after a real host-filtered Node launch', {skip: process.platform !== 'win32' || !fixture && !process.env.CI}, () => {
  assert.ok(fixture, 'CI must run its provider-owned first-install preparation');
  const environment = childEnvironment(fixture.root);
  delete environment.PROCESSOR_ARCHITECTURE;
  // This control demonstrates the actual CPython failure condition instead of
  // matching a source string. Each probe uses a fresh Python process so its
  // platform.uname() cache cannot conceal a missing environment marker.
  const baseline = spawnSync(pythonPath(fixture.root), ['-I', '-c', 'import platform;print(platform.machine())'],
    {shell: false, env: environment, encoding: 'utf8', timeout: 15000});
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stdout.trim(), '');
  const program = `
    const {spawnSync} = await import('node:child_process');
    const {childEnvironment, pythonPath} = await import(process.argv[1]);
    const root = process.argv[2];
    const result = spawnSync(pythonPath(root), ['-I', '-c', 'import platform;print(platform.machine())'],
      {shell: false, env: childEnvironment(root), encoding: 'utf8', timeout: 15000});
    process.stdout.write(JSON.stringify({status: result.status, machine: result.stdout.trim()}));
  `;
  const repaired = spawnSync(process.execPath, ['--input-type=module', '-e', program,
    new URL('../scripts/bootstrap.mjs', import.meta.url).href, fixture.root],
    {shell: false, env: environment, encoding: 'utf8', timeout: 20000});
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(JSON.parse(repaired.stdout), {status: 0, machine: 'AMD64'});
});

test('worker subprocess covers sample preservation, cancellation/resume, corrupt source and OS lock', {skip: !fixture && !process.env.CI, timeout: 120000}, () => {
  assert.ok(fixture);
  const result = spawnSync(pythonPath(fixture.root), ['-I', path.join(providerRoot, 'tests/worker_test.py')], {shell: false, env: childEnvironment(fixture.root), encoding: 'utf8', timeout: 110000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /OK/u);
});

test('native ready launcher refuses an old-model resume before creating a worker receipt', {skip: !fixture && !process.env.CI}, async () => {
  assert.ok(fixture, 'CI must use its genuinely installed RNNT environment');
  const directory = temporary();
  atomicJson(path.join(directory, 'job.json'), {schemaVersion: 1, model: 'v3_e2e_rnnt',
    state: 'cancelled', runId: 'old-run', processedSamples: 16000,
    segments: [{index: 0, startSample: 0, endSample: 16000, text: 'Сохранённые слова.'}]});
  const before = fs.readFileSync(path.join(directory, 'job.json'));
  await assert.rejects(run(['resume', '--job-dir', directory], {root: fixture.root}), /AUDIO_JOB_MODEL_MISMATCH/u);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'job.json')), before);
  assert.equal(fs.existsSync(path.join(directory, 'launch.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'cancel.json')), false);
  const status = await run(['status', '--job-dir', directory]);
  assert.equal(status.model, 'v3_e2e_rnnt');
  assert.equal(status.state, 'cancelled');
  fs.rmSync(directory, {recursive: true});
});

test('real official GigaAM processes >25 seconds through async production CLI and creates complete UTF-8 outputs', {skip: !fixture && !process.env.CI, timeout: 180000}, async () => {
  assert.ok(fixture);
  const root = privateDirectory(temporary());
  const samplePath = path.join(root, 'example.wav');
  prepareSpokenFixture(samplePath);
  const source = path.join(root, 'Длинная запись.wav');
  const program = 'import wave,sys; a=wave.open(sys.argv[1],"rb");p=a.getparams();b=a.readframes(a.getnframes());a.close();o=wave.open(sys.argv[2],"wb");o.setparams(p);o.writeframes(b*4);o.close()';
  const made = spawnSync(pythonPath(fixture.root), ['-I', '-c', program, samplePath, source], {shell: false, env: childEnvironment(fixture.root), encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  const directory = path.join(root, 'Результат');
  const started = await run(['start', '--input', source, '--output-dir', directory], {root: fixture.root});
  assert.equal(started.state, 'queued');
  let status;
  const deadline = Date.now() + 160000;
  do {
    await sleep(200);
    status = await run(['status', '--job-dir', directory], {root: fixture.root});
  } while (['queued', 'validating', 'loading', 'transcribing'].includes(status.state) && Date.now() < deadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  assert.ok(status.totalSeconds > 25);
  const output = JSON.parse(fs.readFileSync(path.join(directory, 'transcript.json'), 'utf8'));
  assert.equal(output.complete, true);
  assert.equal(output.model, 'v3_rnnt');
  assert.ok(output.segments.length >= 2);
  assert.match(fs.readFileSync(path.join(directory, 'transcript.txt'), 'utf8'), /[А-Яа-яЁё]{3}/u);
  assert.match(fs.readFileSync(path.join(directory, 'transcript.srt'), 'utf8'), / --> /u);
  fs.rmSync(root, {recursive: true});
});

test('native Whisper recognizes explicit English and auto-detects Russian and English without changing GigaAM', {
  skip: !fixture && !process.env.CI, timeout: 240000,
}, async t => {
  assert.ok(fixture);
  const root = temporary();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const original = path.join(root, 'example.wav');
  prepareSpokenFixture(original);
  const english = JSON.parse(fs.readFileSync(path.join(providerRoot, 'development/english-fixture.json'), 'utf8'));
  const englishPath = path.join(providerRoot, 'development', english.localFile);
  const bytes = fs.readFileSync(englishPath);
  assert.equal(bytes.length, english.bytes);
  assert.equal(digest(bytes), english.sha256);

  async function transcribe(input, name, args) {
    const job = path.join(root, name);
    assert.equal((await run(['start', '--input', input, '--output-dir', job, ...args], {root: fixture.root})).state, 'queued');
    let status;
    const deadline = Date.now() + 100000;
    do {
      await sleep(250);
      status = await run(['status', '--job-dir', job], {root: fixture.root});
    } while (['queued', 'validating', 'loading', 'transcribing'].includes(status.state) && Date.now() < deadline);
    assert.equal(status.state, 'completed', JSON.stringify(status));
    assert.equal(status.model, whisper.model);
    const output = JSON.parse(fs.readFileSync(path.join(job, 'transcript.json'), 'utf8'));
    assert.equal(output.complete, true);
    assert.equal(output.modelRevision, whisper.revision);
    return output;
  }

  const explicit = await transcribe(englishPath, 'english', ['--language', 'en']);
  assert.equal(explicit.language, 'en');
  assert.match(explicit.segments.map(x => x.text).join(' '), /what your country can do for you/iu);
  assert.ok(explicit.segments.every(x => !Object.hasOwn(x, 'detectedLanguage')));

  // Place an actual speech pause between languages, so the streaming boundary
  // can select a quiet cut and each spoken excerpt has its own evidence.
  const mixed = path.join(root, 'mixed.wav');
  const program = [
    'import wave,sys',
    'a=wave.open(sys.argv[1],"rb"); b=wave.open(sys.argv[2],"rb")',
    'o=wave.open(sys.argv[3],"wb"); o.setparams(a.getparams())',
    'o.writeframes(a.readframes(a.getnframes())+bytes(16000*2*12)+b.readframes(b.getnframes())); o.close()',
  ].join('\n');
  const built = spawnSync(pythonPath(fixture.root), ['-I', '-c', program, englishPath, original, mixed],
    {encoding: 'utf8', shell: false, env: childEnvironment(fixture.root)});
  assert.equal(built.status, 0, built.stderr);
  const detected = await transcribe(mixed, 'mixed', ['--language', 'auto']);
  assert.equal(detected.language, 'auto');
  assert.ok(detected.segments.some(x => x.detectedLanguage === 'en' && /your country/iu.test(x.text)));
  assert.ok(detected.segments.some(x => x.detectedLanguage === 'ru' && /[а-яё]{3}/iu.test(x.text)));
  assert.ok(detected.durationSeconds > 30);
  assert.equal((await run(['doctor'], {root: fixture.root})).model, 'v3_rnnt');
});

test('native source-original protocol decodes actual audio once with the prepared official model',
  {skip:!fixture&&!process.env.CI,timeout:180000},async t=>{
  assert.ok(fixture,'CI must prepare the real hash-pinned RNNT environment');
  const scratch=temporary(),parent=privateDirectory(path.join(scratch,'download-native'));
  t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  const original=path.join(parent,'voice.ogg');
  // Public hash-pinned spoken fixture; ffmpeg detects its real format from
  // bytes, just as it does with the private original-file receipt in the host.
  prepareSpokenFixture(original);
  if(process.platform!=='win32')fs.chmodSync(original,0o600);
  const input={schemaVersion:1,requestId:'11111111-2222-4333-8444-555555555555',
    original:{filePath:original,...sourceFileFingerprint(original,20*1024*1024)},outputDirectory:path.join(parent,'job')};
  let starts=0;
  const execute=async(args,options)=>{if(args[0]==='start')starts++;return run(args,options);};
  let result=await processSourceOriginal(input,{root:fixture.root,run:execute});
  const deadline=Date.now()+160000;
  while(['queued','validating','loading','transcribing'].includes(result.state)&&Date.now()<deadline){
    await sleep(200);result=await processSourceOriginal(input,{root:fixture.root,run:execute});
  }
  assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(starts,1);
  assert.equal(result.contentRead,false,'only the host independently verifies and exposes transcript bytes');
  assert.deepEqual(result.text,sourceFileFingerprint(path.join(input.outputDirectory,'transcript.txt'),24*1024*1024));
  assert.match(fs.readFileSync(path.join(input.outputDirectory,'transcript.txt'),'utf8'),/[А-Яа-яЁё]{3}/u);
  assert.doesNotMatch(JSON.stringify(result),/voice\.ogg|filePath|transcript\.txt/);
  const repeated=await processSourceOriginal(input,{root:fixture.root,run:execute});
  assert.deepEqual(repeated,result);assert.equal(starts,1,'repeated intake context only observes this SAME decoder');
  const next={...input,requestId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    outputDirectory:path.join(privateDirectory(path.join(scratch,'download-copied')),'job')};
  assert.deepEqual(await processSourceOriginal(next,{root:fixture.root,run:execute}),{...result,requestId:next.requestId});
  assert.equal(starts,1,'fresh authorized source reads reuse actual complete inference, not another worker');
  assert.equal(fs.existsSync(path.join(next.outputDirectory,'job.json')),false);
});

test('Windows cold private storage succeeds under a Restricted parent without inherited preference', {skip: process.platform !== 'win32'}, () => {
  const root = temporary(), directory = path.join(root, 'private');
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const before = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy -List | ConvertTo-Json -Compress'], {encoding: 'utf8', shell: false});
  const code = '$env:PSExecutionPolicyPreference=$null; & $env:TRELIO_TEST_NODE $env:TRELIO_TEST_SCRIPT $env:TRELIO_TEST_DIRECTORY; exit $LASTEXITCODE';
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', code], {shell: false, encoding: 'utf8', timeout: 60000,
    env: {...process.env, TRELIO_TEST_NODE: process.execPath, TRELIO_TEST_SCRIPT: path.join(providerRoot, 'tests/private-storage-fixture.mjs'), TRELIO_TEST_DIRECTORY: directory}});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PRIVATE_STORAGE_OK/u);
  const after = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy -List | ConvertTo-Json -Compress'], {encoding: 'utf8', shell: false});
  assert.equal(after.stdout, before.stdout);
  fs.rmSync(root, {recursive: true});
});
