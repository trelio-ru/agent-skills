import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {installationPlan, ready, whisper} from '../scripts/bootstrap.mjs';
import {run} from '../scripts/audio-transcription.mjs';
import {processSourceOriginal, sourceFileFingerprint} from '../scripts/source-original.mjs';
import {atomicJson, privateDirectory} from '../scripts/storage.mjs';

if (process.argv[2] === 'package') {
  // Runtime source is already frozen in Git. No native binary, model, local
  // recording or test cache is ever added to a public signed code package.
  process.stdout.write('Audio transcription package uses committed source only.\n');
} else {
  // Match the signed host boundary, not the runner's full login environment.
  // A direct CI launch used to retain these fields and hide a first-install
  // failure on real devices. The provider must reconstruct its supported x64
  // Python marker for uv and inference without widening the host allowlist.
  for (const key of Object.keys(process.env)) {
    if (/^PROCESSOR_ARCHITE(?:CTURE|W6432)$/iu.test(key)) delete process.env[key];
  }
  const provider = fileURLToPath(new URL('../', import.meta.url));
  // On elevated Windows runners mkdir's default owner can be Administrators.
  // Let the production helper create a fresh child and establish its own SID
  // before any fixture material, instead of adopting an existing foreign owner.
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'trelio-audio-ci-'));
  const root = privateDirectory(path.join(parent, 'private'));
  const plan = installationPlan(root);
  // Exercise the actual first-use dispatch on every supported OS, rather than
  // hand-authoring a consent fixture and calling the internal installer. The
  // SAME environment/model must become ready without any human receipt, and
  // repeated preparation must retain one native worker/dispatch identity.
  assert.equal((await run(['doctor'], {root})).ready, false);
  const sourceRoot = privateDirectory(path.join(parent, 'source'));
  const original = path.join(sourceRoot, 'voice.ogg');
  const fixture = JSON.parse(fs.readFileSync(path.join(provider, 'development', 'fixture.json')));
  const sample = fs.readFileSync(path.join(provider, 'development', fixture.localFile));
  fs.writeFileSync(original, sample, {flag: 'wx', mode: 0o600});
  const fingerprint = sourceFileFingerprint(original, 20 * 1024 * 1024);
  assert.equal(fingerprint.sha256, fixture.sha256);assert.equal(fingerprint.sizeBytes, fixture.bytes);
  const input = {schemaVersion: 1, requestId: '11111111-2222-4333-8444-555555555555',
    original: {filePath: original, ...fingerprint}, outputDirectory: path.join(sourceRoot, 'job')};
  const first = await processSourceOriginal(input, {root, run});
  assert.equal(first.state, 'queued');assert.equal(first.consentRequired, undefined);
  const dispatch = fs.readFileSync(path.join(root, 'setup-dispatch.json'));
  assert.equal(JSON.parse(dispatch).planHash, plan.planHash);
  const repeated = await run(['ensure'], {root});
  assert.ok(['installing', 'ready'].includes(repeated.state));
  assert.deepEqual(fs.readFileSync(path.join(root, 'setup-dispatch.json')), dispatch);
  assert.equal(fs.existsSync(path.join(sourceRoot, '.source-attempt.json')), false);
  const deadline = Date.now() + 31 * 60 * 1000;
  while (!ready(root) && Date.now() < deadline) {
    const status = await run(['doctor'], {root});
    if (status.setup?.state === 'failed') break;
    await delay(1000);
  }
  assert.equal(fs.existsSync(path.join(root, 'download-consent.json')), false);
  if (!ready(root)) {
    process.stderr.write(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'setup.json')))) + '\n');
    throw Error('audio_ci_setup_failed');
  }
  // Also exercise the ordinary Whisper start on a cold device. Its installer
  // has a distinct claim and must leave the ready GigaAM receipt untouched.
  const english = JSON.parse(fs.readFileSync(path.join(provider, 'development', 'english-fixture.json')));
  const englishPath = path.join(provider, 'development', english.localFile);
  const englishOutput = path.join(sourceRoot, 'whisper-setup');
  const whisperDoctor = ['doctor', '--model', whisper.model];
  assert.equal((await run(whisperDoctor, {root})).ready, false);
  const initial = await run(['start', '--input', englishPath, '--output-dir', englishOutput, '--language', 'en'], {root});
  assert.equal(initial.state, 'installing');
  assert.deepEqual(fs.readdirSync(englishOutput), []);
  const whisperDeadline = Date.now() + 31 * 60 * 1000;
  for (;;) {
    const status = await run(whisperDoctor, {root});
    if (status.ready) break;
    if (status.setup?.state === 'failed' || Date.now() >= whisperDeadline) {
      throw Error('audio_ci_whisper_setup_failed: ' + JSON.stringify(status.setup));
    }
    await delay(1000);
  }
  assert.equal(ready(root), true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'setup-dispatch.json')), dispatch);
  atomicJson(path.join(provider, '.ci-state.json'), {root});
  process.stdout.write('Audio transcription real CPU environments and both pinned models ready.\n');
}
