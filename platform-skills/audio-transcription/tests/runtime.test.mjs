import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {artifacts, childEnvironment, digest, downloadArtifact, installationPlan, performSetup, providerRoot, pythonPath, ready, unpackUv} from '../scripts/bootstrap.mjs';
import {argumentsObject, run} from '../scripts/audio-transcription.mjs';
import {atomicJson, privateDirectory} from '../scripts/storage.mjs';
import {buildRuntimePackage} from '../../tools/build-runtime-package.mjs';

const fixtureFile = path.join(providerRoot, '.ci-state.json');
const fixture = fs.existsSync(fixtureFile) ? JSON.parse(fs.readFileSync(fixtureFile)) : null;
const temporary = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trelio-audio-test-'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const artifact = value => ({url: 'https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/synthetic.bin', bytes: value.length, sha256: digest(value)});

test('doctor/plan cannot download or create a cache; stale approval fails closed', async () => {
  const parent = temporary(), root = path.join(parent, 'new-cache');
  const doctor = await run(['doctor'], {root});
  assert.equal(doctor.ready, false);
  assert.equal(doctor.consentRequired, true);
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
  fs.rmSync(root, {recursive: true});
});

test('signed package binds upstream source, inference entrypoints and full guide, without model bytes', () => {
  const built = buildRuntimePackage(providerRoot);
  assert.equal(built.skillId, 'audio-transcription');
  assert.ok(built.packageSizeBytes < 1024 * 1024);
  const bytes = JSON.parse(built.packageBytes);
  for (const name of ['scripts/audio-transcription.mjs', 'engine/worker.py', 'engine/uv.lock', 'references/workflow.md', 'engine/vendor/GigaAM-LICENSE']) assert.ok(bytes.files.some(file => file.path === name), name);
  assert.ok(!bytes.files.some(file => /\.(?:ckpt|wav|m4a|exe|whl)$/u.test(file.path)));
  const upstream = JSON.parse(fs.readFileSync(path.join(providerRoot, 'engine/vendor/origin.json')));
  for (const [name, expected] of Object.entries(upstream.files)) assert.equal(digest(fs.readFileSync(path.join(providerRoot, 'engine/vendor/gigaam', name))), expected);
});

test('prepared host actually uses a managed Python and official checksum-pinned model', {skip: !fixture && !process.env.CI}, () => {
  assert.ok(fixture, 'CI must run its provider-owned first-install preparation');
  assert.equal(ready(fixture.root), true);
  const result = spawnSync(pythonPath(fixture.root), ['-I', '-c', 'import torch,torchaudio,imageio_ffmpeg;print(torch.__version__);print(torchaudio.__version__)'], {env: childEnvironment(fixture.root), encoding: 'utf8', shell: false, timeout: 60000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2\.8\.0/u);
  for (const item of artifacts.models) assert.equal(fs.statSync(path.join(fixture.root, 'models', item.name)).size, item.bytes);
});

test('worker subprocess covers sample preservation, cancellation/resume, corrupt source and OS lock', {skip: !fixture && !process.env.CI, timeout: 120000}, () => {
  assert.ok(fixture);
  const result = spawnSync(pythonPath(fixture.root), ['-I', path.join(providerRoot, 'tests/worker_test.py')], {shell: false, env: childEnvironment(fixture.root), encoding: 'utf8', timeout: 110000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /OK/u);
});

test('real official GigaAM processes >25 seconds through async production CLI and creates complete UTF-8 outputs', {skip: !fixture && !process.env.CI, timeout: 180000}, async () => {
  assert.ok(fixture);
  const root = privateDirectory(temporary());
  const sample = JSON.parse(fs.readFileSync(path.join(providerRoot, 'development/fixture.json')));
  const samplePath = path.join(root, 'example.wav');
  await downloadArtifact(sample, samplePath);
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
  assert.ok(output.segments.length >= 2);
  assert.match(fs.readFileSync(path.join(directory, 'transcript.txt'), 'utf8'), /[А-Яа-яЁё]{3}/u);
  assert.match(fs.readFileSync(path.join(directory, 'transcript.srt'), 'utf8'), / --> /u);
  fs.rmSync(root, {recursive: true});
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
