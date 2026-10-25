#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {artifacts, childEnvironment, installationPlan, performSetup, providerRoot, pythonPath, ready, startSetup} from './bootstrap.mjs';
import {atomicJson, privateDirectory, readJson, stateDirectory} from './storage.mjs';

export const RUNTIME_VERSION = '1.1.0';
const busy = new Set(['queued', 'validating', 'loading', 'transcribing']);
const supported = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.mp4', '.mov', '.mkv', '.webm']);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

export function argumentsObject(argv) {
  const result = {command: argv[0] || 'doctor'};
  const allowed = {setup: ['approve'], start: ['input', 'output-dir'], status: ['job-dir'], resume: ['job-dir'], cancel: ['job-dir'], doctor: [], guides: []};
  if (!Object.hasOwn(allowed, result.command)) throw Error('AUDIO_COMMAND_INVALID');
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    if (!argv[i]?.startsWith('--') || !allowed[result.command].includes(key) || !argv[i + 1] || Object.hasOwn(result, key)) throw Error('AUDIO_ARGUMENTS_INVALID');
    result[key] = argv[i + 1];
  }
  return result;
}

function jobDirectory(options) {
  const value = options['job-dir'];
  if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) throw Error('AUDIO_JOB_REQUIRED');
  return privateDirectory(value);
}

function launchWorker(directory, stateRoot, {resume = false} = {}) {
  const state = readJson(path.join(directory, 'job.json'));
  if (!state || state.schemaVersion !== 1) throw Error('AUDIO_JOB_INVALID');
  // Keep model identity separate from the job schema: a valid pre-upgrade job
  // is still readable through status, but cannot receive a different decoder's
  // words. Refuse before writing launch/cancellation receipts or spawning.
  if (state.model !== artifacts.model) throw Error('AUDIO_JOB_MODEL_MISMATCH');
  if (state.state === 'completed') return projection(directory, state);
  const launched = readJson(path.join(directory, 'launch.json'));
  if (resume && (launchAlive(launched) || busy.has(state.state) && processAlive(state.pid))) return projection(directory, state);
  const runId = resume ? randomUUID() : state.runId;
  // Publish the run identity before spawning. A cancellation issued while the
  // interpreter starts must address the new run, including an explicit resume.
  // This receipt is separate from job.json, which belongs to the OS-locked
  // Python worker; Node must never overwrite a concurrently saved segment.
  const receipt = {runId, startedAt: Date.now(), pid: null};
  atomicJson(path.join(directory, 'launch.json'), receipt);
  // A Python OS file lock arbitrates concurrent resume calls; Node never kills
  // a PID read from a job file, so recycled PIDs cannot become a kill target.
  const worker = spawn(pythonPath(stateRoot), ['-I', path.join(providerRoot, 'engine', 'worker.py'),
    '--job-dir', directory, '--state-dir', stateRoot, '--run-id', runId, ...(resume ? ['--resume'] : [])],
    {shell: false, windowsHide: true, detached: true, stdio: 'ignore', env: childEnvironment(stateRoot)});
  worker.on('error', () => {
    const current = readJson(path.join(directory, 'launch.json'));
    if (current?.runId === runId) atomicJson(path.join(directory, 'launch.json'), {...current, failed: true});
  });
  atomicJson(path.join(directory, 'launch.json'), {...receipt, pid: worker.pid ?? null});
  worker.unref();
  return {ok: true, state: 'queued', jobDirectory: directory, nextCommand: ['status', '--job-dir', directory]};
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {process.kill(pid, 0); return true;} catch {return false;}
}

function launchAlive(receipt) {
  return receipt && !receipt.failed && (processAlive(receipt.pid) || receipt.pid === null && Date.now() - receipt.startedAt < 10000);
}

function projection(directory, state) {
  const answer = {ok: true, model: state.model, state: state.state, completedSegments: state.segments?.length || 0,
    processedSeconds: state.processedSamples / 16000 || 0, totalSeconds: state.totalSeconds ?? null,
    errorCode: state.errorCode || null, jobDirectory: directory};
  const launched = readJson(path.join(directory, 'launch.json'));
  if (state.state !== 'completed' && launched && launched.runId !== state.runId && launchAlive(launched)) answer.state = 'queued';
  else if (busy.has(state.state) && !processAlive(state.pid) && !launchAlive(launched)) {
    answer.state = 'interrupted'; answer.errorCode = launched?.failed ? 'AUDIO_WORKER_START_FAILED' : 'AUDIO_WORKER_INTERRUPTED';
  }
  if (state.state === 'completed') answer.files = ['transcript.txt', 'transcript.srt', 'transcript.json'].map(name => path.join(directory, name));
  return answer;
}

export async function run(argv, {root = stateDirectory()} = {}) {
  const options = argumentsObject(argv);
  if (options.command === 'guides') {
    const file = path.join(providerRoot, 'references', 'workflow.md');
    const {fileDigest} = await import('./bootstrap.mjs');
    return {ok: true, guides: [{path: file, bytes: fs.statSync(file).size, sha256: await fileDigest(file)}]};
  }
  const plan = installationPlan(root);
  if (options.command === 'doctor') return {ok: true, ready: ready(root), model: artifacts.model, runtimeVersion: RUNTIME_VERSION,
    setup: readJson(path.join(root, 'setup.json')), ...(!ready(root) ? {downloadPlan: plan, consentRequired: true} : {})};
  if (options.command === 'setup') {
    if (!options.approve) return {ok: true, consentRequired: true, downloadPlan: plan};
    return startSetup(options.approve, root);
  }
  if (options.command === 'status') {
    const directory = jobDirectory(options);
    const state = readJson(path.join(directory, 'job.json'));
    if (!state) throw Error('AUDIO_JOB_INVALID');
    return projection(directory, state);
  }
  if (options.command === 'cancel') {
    const directory = jobDirectory(options);
    const state = readJson(path.join(directory, 'job.json'));
    if (!state) throw Error('AUDIO_JOB_INVALID');
    const launched = readJson(path.join(directory, 'launch.json'));
    const active = state.state !== 'completed' && (busy.has(state.state) || launchAlive(launched));
    if (active) atomicJson(path.join(directory, 'cancel.json'), {runId: launchAlive(launched) ? launched.runId : state.runId});
    return {ok: true, state: active ? 'cancellation-requested' : state.state, jobDirectory: directory};
  }
  if (!ready(root)) return {ok: false, errorCode: 'AUDIO_SETUP_REQUIRED', consentRequired: true, downloadPlan: plan};
  if (options.command === 'resume') return launchWorker(jobDirectory(options), root, {resume: true});
  const input = options.input, output = options['output-dir'];
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output) || !supported.has(path.extname(input).toLowerCase())) throw Error('AUDIO_INPUT_OR_OUTPUT_INVALID');
  const stat = fs.lstatSync(input, {throwIfNoEntry: false});
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0) throw Error('AUDIO_INPUT_OR_OUTPUT_INVALID');
  const directory = privateDirectory(output);
  if (fs.readdirSync(directory).length) throw Error('AUDIO_OUTPUT_NOT_EMPTY');
  atomicJson(path.join(directory, 'job.json'), {schemaVersion: 1, id: randomUUID(), model: artifacts.model,
    state: 'queued', runId: randomUUID(), input: path.resolve(input), originalSize: stat.size, originalMtimeMs: stat.mtimeMs,
    segments: [], processedSamples: 0, createdAt: new Date().toISOString()});
  return launchWorker(directory, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '__setup' && process.env.TRELIO_AUDIO_SETUP_ROOT) {
      await performSetup(process.argv[3], process.env.TRELIO_AUDIO_SETUP_ROOT);
    } else emit(await run(process.argv.slice(2)));
  } catch (error) {
    emit({ok: false, errorCode: /^AUDIO_[A-Z_]+$/u.test(error.message) ? error.message : 'AUDIO_OPERATION_FAILED'});
    process.exitCode = 1;
  }
}
