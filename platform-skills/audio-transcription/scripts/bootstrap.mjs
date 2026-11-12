import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {gunzipSync, inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJson, privateDirectory, readJson, stateDirectory} from './storage.mjs';

export const providerRoot = fileURLToPath(new URL('../', import.meta.url));
export const artifacts = JSON.parse(fs.readFileSync(new URL('artifacts.json', import.meta.url)));
export const whisper = JSON.parse(fs.readFileSync(new URL('whisper-artifacts.json', import.meta.url)));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const platformKey = `${process.platform}-${process.arch}`;
export const pythonPath = root => path.join(root, 'engine', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function modelDirectory(root, model) {
  if (model === artifacts.model) return root;
  if (model === whisper.model) return path.join(root, whisper.model);
  throw Error('AUDIO_MODEL_INVALID');
}

function engineSource(model) {
  return model === whisper.model ? path.join(providerRoot, 'engine', 'whisper') : path.join(providerRoot, 'engine');
}

export function installationPlan(root = stateDirectory(), model = artifacts.model) {
  modelDirectory(root, model); // Validate the identity before interpreting signed plan data.
  const useWhisper = model === whisper.model;
  const uv = artifacts.uv[platformKey];
  // PyTorch discontinued current Intel macOS wheels. Do not silently substitute
  // an older model/runtime or claim untested binary compatibility on that CPU.
  if (!uv || platformKey === 'darwin-x64') throw Error('AUDIO_PLATFORM_UNSUPPORTED');
  // Whisper's hash-locked PyAV wheel for Apple Silicon requires macOS 14.
  if (useWhisper && process.platform === 'darwin' && Number(os.release().split('.')[0]) < 23) {
    throw Error('AUDIO_WHISPER_PLATFORM_UNSUPPORTED');
  }
  const lock = fs.readFileSync(path.join(engineSource(model), 'uv.lock'));
  const project = fs.readFileSync(path.join(engineSource(model), 'pyproject.toml'));
  const material = {schemaVersion: 1, platform: platformKey, directory: path.resolve(root),
    model, pythonVersion: artifacts.pythonVersion, uvVersion: artifacts.uvVersion,
    lockSha256: digest(lock), projectSha256: digest(project), uv,
    models: useWhisper ? whisper.models : artifacts.models, maximumDependencyDownloadBytes: 1536 * 1024 * 1024,
    requiredFreeBytes: 4 * 1024 ** 3,
    sources: ['github.com/astral-sh/uv', 'github.com/astral-sh/python-build-standalone', 'pypi.org', 'files.pythonhosted.org',
      ...(useWhisper ? ['huggingface.co', 'us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co']
        : ['download.pytorch.org', 'cdn.chatwm.opensmodel.sberdevices.ru', 'trelio.ru'])],
    localAudioOnly: true};
  return {...material, planHash: digest(JSON.stringify(material))};
}

export function childEnvironment(root) {
  const clean = {};
  // Never forward provider/account/Agent Secret credentials or ambient Python,
  // uv, pip and FFmpeg overrides into installers or inference processes.
  for (const key of ['HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  // The signed host deliberately removes unlisted environment variables before
  // starting a provider, including both Windows PROCESSOR_* architecture fields.
  // CPython 3.11 platform.machine() otherwise returns an empty string and uv
  // rejects the interpreter before installing any dependencies. Author the
  // marker for our sole supported Windows target from the running Node binary,
  // rather than relying on ambient values that direct CI happens to preserve.
  // Do not copy PROCESSOR_ARCHITEW6432: Python prefers it over this marker, so a
  // stale/conflicting inherited value could select a different lock environment.
  if (platformKey === 'win32-x64') clean.PROCESSOR_ARCHITECTURE = 'AMD64';
  Object.assign(clean, {UV_NO_CONFIG: '1', UV_CACHE_DIR: path.join(root, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_PYTHON_BIN_DIR: path.join(root, 'python-bin'),
    UV_LINK_MODE: 'copy', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1', TOKENIZERS_PARALLELISM: 'false'});
  return clean;
}

export function ready(root, model = artifacts.model) {
  const plan = installationPlan(root, model);
  const receipt = readJson(path.join(root, 'installed.json'));
  // Adding a byte-identical transport must not invalidate an already completed
  // installation or force an assistant to reinstall a ready local decoder.
  // Reconstruct ONLY the exact previous plan with the new mirror removed:
  // model/dependency hashes, platform, directory and original sources remain
  // bound. This accepts no prior-model/foreign installation and writes no
  // historical consent. A NEW setup still requires the complete current plan.
  const {planHash, ...material} = plan;
  const previousHash = model === artifacts.model ? digest(JSON.stringify({...material,
    models: material.models.map(({fallbackUrls, ...model}) => model),
    sources: material.sources.filter(source => source !== 'trelio.ru')})) : null;
  return receipt?.model === plan.model && (receipt?.planHash === planHash || previousHash !== null && receipt?.planHash === previousHash)
    && fs.existsSync(pythonPath(root)) && plan.models.every(model => {
    const stat = fs.lstatSync(path.join(root, 'models', model.name), {throwIfNoEntry: false});
    return stat?.isFile() && !stat.isSymbolicLink() && stat.size === model.bytes;
  });
}

export async function downloadArtifact(artifact, target, {fetcher = fetch, retryDelays = [2000, 5000]} = {}) {
  const mirrors = artifact.fallbackUrls ?? [];
  const pinnedWhisper = whisper.models.find(item => item.url === artifact.url
    && item.bytes === artifact.bytes && item.sha256 === artifact.sha256);
  // This is a fixed public checkpoint mirror, never a model/env URL override
  // or general Trelio HTTP client. Validate the COMPLETE signed source list
  // before the first request; query strings/credentials/ports are not admitted.
  const mirrorUrl = `https://trelio.ru/media/model-artifacts/gigaam/${artifact.sha256}/v3_rnnt.ckpt`;
  if (!Array.isArray(mirrors) || mirrors.length > 1 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    || pinnedWhisper && mirrors.length || mirrors.some(url => url !== mirrorUrl)) throw Error('AUDIO_DOWNLOAD_ORIGIN_DENIED');
  // Every origin, redirect, retry, backoff and body uses ONE original deadline.
  // Failover is a bounded read of the SAME size/hash, not another installation
  // attempt, a TLS bypass or permission to try different model bytes.
  const signal = AbortSignal.timeout(artifact.bytes > 50 * 1024 * 1024 ? 15 * 60 * 1000 : 120000);
  for (const url of [artifact.url, ...mirrors]) {
    for (let attempt = 0; ; attempt++) {
      try { return await downloadOnce({...artifact, url}, target, fetcher, signal, mirrorUrl, pinnedWhisper); }
      catch (error) {
        const transient = ['TypeError', 'TimeoutError', 'AbortError', 'AudioTransportError'].includes(error.name);
        if (signal.aborted || !transient && error.name !== 'AudioUnavailableError') throw error;
        if (transient && attempt < retryDelays.length) {
          await delay(retryDelays[attempt], undefined, {signal});
          continue;
        }
        if (url === mirrors.at(-1) || mirrors.length === 0) throw error;
        break;
      }
    }
  }
}

function permittedArtifactOrigin(url, artifact, mirrorUrl, pinnedWhisper) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (pinnedWhisper) {
    const cachePath = `/api/resolve-cache/models/Systran/faster-whisper-small/${whisper.revision}/${pinnedWhisper.name}`;
    if (url.hostname === 'huggingface.co') return url.href === pinnedWhisper.url || url.pathname === cachePath;
    // The large file is delivered by Hugging Face's signed Xet redirects.
    // No redirect from the Whisper route can land on a GigaAM or uv origin.
    return pinnedWhisper.name === 'model.bin'
      && ['us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co'].includes(url.hostname);
  }
  return ['github.com', 'release-assets.githubusercontent.com', 'cdn.chatwm.opensmodel.sberdevices.ru'].includes(url.hostname)
    || artifact.fallbackUrls?.includes(mirrorUrl) && url.href === mirrorUrl;
}

async function downloadOnce(artifact, target, fetcher, signal, mirrorUrl, pinnedWhisper) {
  const existing = fs.lstatSync(target, {throwIfNoEntry: false});
  if (existing?.isSymbolicLink()) throw Error('AUDIO_DOWNLOAD_PATH_INVALID');
  if (existing?.isFile() && existing.size === artifact.bytes && await fileDigest(target) === artifact.sha256) {
    signal.throwIfAborted();
    return;
  }
  const part = `${target}.part`;
  const partial = fs.lstatSync(part, {throwIfNoEntry: false});
  if (partial && (!partial.isFile() || partial.isSymbolicLink() || partial.size > artifact.bytes)) throw Error('AUDIO_DOWNLOAD_PATH_INVALID');
  let offset = partial?.size || 0;
  let url = new URL(artifact.url);
  let response;
  for (let redirects = 0; redirects < 6; redirects++) {
    signal.throwIfAborted();
    if (!permittedArtifactOrigin(url, artifact, mirrorUrl, pinnedWhisper)) throw Error('AUDIO_DOWNLOAD_ORIGIN_DENIED');
    response = await fetcher(url, {redirect: 'manual', headers: offset ? {Range: `bytes=${offset}-`} : {},
      signal});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), url);
  }
  if (!response || ![200, 206].includes(response.status)) {
    await response?.body?.cancel();
    const error = Error('AUDIO_DOWNLOAD_FAILED');
    if (response?.status === 429 || response?.status >= 500) error.name = 'AudioTransportError';
    else if ([404, 410].includes(response?.status)) error.name = 'AudioUnavailableError';
    throw error;
  }
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[3]) !== artifact.bytes) {
      await response.body?.cancel();
      throw Error('AUDIO_DOWNLOAD_RANGE_INVALID');
    }
  } else offset = 0;
  let received = offset;
  const limiter = new Transform({transform(chunk, encoding, callback) {
    received += chunk.length;
    callback(received > artifact.bytes ? Error('AUDIO_DOWNLOAD_TOO_LARGE') : null, chunk);
  }});
  await pipeline(Readable.fromWeb(response.body), limiter,
    fs.createWriteStream(part, {flags: offset ? 'a' : 'w', mode: 0o600}), {signal});
  if (received !== artifact.bytes || await fileDigest(part) !== artifact.sha256) {
    fs.rmSync(part, {force: true});
    throw Error('AUDIO_DOWNLOAD_DIGEST_MISMATCH');
  }
  signal.throwIfAborted();
  fs.renameSync(part, target);
}

export function unpackUv(bytes, format) {
  // Only the exact executable is materialized. Never extract archive paths,
  // links, or metadata supplied by a network archive into the filesystem.
  const candidates = [];
  if (format === 'tgz') {
    const tar = gunzipSync(bytes, {maxOutputLength: 192 * 1024 * 1024});
    for (let at = 0; at + 512 <= tar.length;) {
      const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/su, '');
      if (!name) break;
      const size = parseInt(tar.subarray(at + 124, at + 136).toString().replace(/\0.*$/su, '').trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw Error('AUDIO_UV_ARCHIVE_INVALID');
      if (/^[a-zA-Z0-9_.-]+\/uv$/u.test(name) && [0, 48].includes(tar[at + 156])) candidates.push(tar.subarray(at + 512, at + 512 + size));
      at += 512 + Math.ceil(size / 512) * 512;
    }
  } else if (format === 'zip') {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw Error('AUDIO_UV_ARCHIVE_INVALID');
    let at = bytes.readUInt32LE(end + 16);
    const count = bytes.readUInt16LE(end + 10);
    if (count > 100) throw Error('AUDIO_UV_ARCHIVE_INVALID');
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(at) !== 0x02014b50) throw Error('AUDIO_UV_ARCHIVE_INVALID');
      const method = bytes.readUInt16LE(at + 10), size = bytes.readUInt32LE(at + 20), outputSize = bytes.readUInt32LE(at + 24);
      const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
      const name = bytes.subarray(at + 46, at + 46 + nameLength).toString();
      if (/^(?:[a-zA-Z0-9_.-]+\/)?uv\.exe$/u.test(name)) {
        const local = bytes.readUInt32LE(at + 42);
        if (bytes.readUInt32LE(local) !== 0x04034b50 || outputSize > 96 * 1024 * 1024) throw Error('AUDIO_UV_ARCHIVE_INVALID');
        const begin = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        const compressed = bytes.subarray(begin, begin + size);
        const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, {maxOutputLength: 96 * 1024 * 1024}) : null;
        if (!data || data.length !== outputSize) throw Error('AUDIO_UV_ARCHIVE_INVALID');
        candidates.push(data);
      }
      at += 46 + nameLength + extra + comment;
    }
  }
  if (candidates.length !== 1 || candidates[0].length < 1024) throw Error('AUDIO_UV_ARCHIVE_INVALID');
  return candidates[0];
}

/** Prepare only the fixed signed installation for an authorized skill use.
 * The plan is still checked byte-for-byte; automatic preparation is recorded
 * as a skill request, never as a human download-consent event. A durable
 * exclusive dispatch precedes spawn, so simultaneous intake reads cannot
 * launch several installers and a lost start cannot silently be replayed. */
export function ensureSetup(root = stateDirectory(), options = {}) {
  return startSetup(installationPlan(root, options.model).planHash, root, {...options, automatic: true});
}

export function startSetup(approvedHash, root = stateDirectory(), {automatic = false, launcher = spawn, model = artifacts.model} = {}) {
  const plan = installationPlan(root, model);
  if (approvedHash !== plan.planHash) throw Error('AUDIO_DOWNLOAD_CONSENT_REQUIRED');
  privateDirectory(root);
  if (ready(root, model)) return {ok: true, state: 'ready', model};
  // Serialize the parent-side claim/retry as well as the existing worker OS
  // lock. An orphan claim is unknown, never reclaimed merely by age/PID; this
  // prevents a second retry from renaming a newly created dispatch as stale.
  const lock = path.join(root, 'setup-dispatch.lock');
  let fd;
  try {fd = fs.openSync(lock, 'wx', 0o600);}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try {owner = readJson(lock);} catch { /* The other parent may still be writing its bounded claim. */ }
    const observed = fs.lstatSync(lock, {throwIfNoEntry: false});
    const creating = !observed || Date.now() - observed.mtimeMs < 10000;
    return {ok: true, state: isProcessAlive(owner?.pid) || creating ? 'installing' : 'unknown'};
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({pid: process.pid})); fs.fsyncSync(fd);
    return dispatchSetup(plan, root, {automatic, launcher});
  }
  finally {fs.closeSync(fd); fs.unlinkSync(lock);}
}

function dispatchSetup(plan, root, {automatic, launcher}) {
  const current = readJson(path.join(root, 'setup.json'));
  if (current?.state === 'installing' && isProcessAlive(current.pid)) return {ok: true, state: 'installing'};
  const dispatchFile = path.join(root, 'setup-dispatch.json');
  const previous = readJson(dispatchFile);
  if (previous) {
    if (previous.schemaVersion !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(previous.requestId)
      || !/^[0-9a-f]{64}$/u.test(previous.planHash) || !['skill-use', 'explicit-setup'].includes(previous.reason)
      || !Number.isFinite(Date.parse(previous.requestedAt))
      || previous.pid !== null && (!Number.isSafeInteger(previous.pid) || previous.pid < 1)) throw Error('AUDIO_STATE_INVALID');
    // Only an observed terminal failure allows an explicit, diagnosed retry.
    // Automatic context polling never retries a failed or unknown installer.
    // PID liveness can confirm ongoing work but absence cannot prove that an
    // unobserved spawn had no effect. Do not kill anything from these records.
    if (automatic || current?.state !== 'failed') {
      if (previous.planHash !== plan.planHash) return {ok: false, state: 'failed', errorCode: 'AUDIO_SETUP_PLAN_CHANGED'};
      if (current?.state === 'failed') return {ok: false, state: 'failed', errorCode: current.errorCode || 'AUDIO_SETUP_FAILED'};
      return {ok: true, state: current?.state === 'installing' && isProcessAlive(current.pid)
        || isProcessAlive(previous.pid) ? 'installing' : 'unknown'};
    }
    if (isProcessAlive(previous.pid)) return {ok: true, state: 'installing'};
    // Rename the known failed dispatch rather than erasing its evidence.
    // The parent-side lock prevents concurrent retries from moving a new claim.
    try {fs.renameSync(dispatchFile, `${dispatchFile}.${previous.requestId}.failed`);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  } else if (automatic && current?.state === 'failed') {
    return {ok: false, state: 'failed', errorCode: current.errorCode || 'AUDIO_SETUP_FAILED'};
  }
  const request = {schemaVersion: 1, requestId: randomUUID(), planHash: plan.planHash,
    reason: automatic ? 'skill-use' : 'explicit-setup', requestedAt: new Date().toISOString(), pid: null};
  try {
    const fd = fs.openSync(dispatchFile, 'wx', 0o600);
    try {fs.writeFileSync(fd, JSON.stringify(request)); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return {ok: true, state: 'installing'};
  }
  atomicJson(path.join(root, 'setup.json'), {state: 'installing', stage: 'starting', pid: null});
  let worker;
  try {
    worker = launcher(process.execPath, [fileURLToPath(new URL('audio-transcription.mjs', import.meta.url)), '__setup', plan.planHash, ...(plan.model === whisper.model ? [plan.model] : [])],
      {detached: true, stdio: 'ignore', shell: false, windowsHide: true, env: {...childEnvironment(root), TRELIO_AUDIO_SETUP_ROOT: root}});
  } catch {
    atomicJson(path.join(root, 'setup.json'), {state: 'failed', stage: 'starting', errorCode: 'AUDIO_SETUP_START_FAILED'});
    return {ok: false, state: 'failed', errorCode: 'AUDIO_SETUP_START_FAILED'};
  }
  atomicJson(dispatchFile, {...request, pid: worker.pid ?? null});
  worker.on('error', () => atomicJson(path.join(root, 'setup.json'),
    {state: 'failed', stage: 'starting', errorCode: 'AUDIO_SETUP_START_FAILED'}));
  worker.unref();
  return {ok: true, state: 'installing', nextCommand: ['doctor', ...(plan.model === whisper.model ? ['--model', plan.model] : [])]};
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {process.kill(pid, 0); return true;} catch {return false;}
}

export async function performSetup(approvedHash, root, {installerFailure = null, model = artifacts.model} = {}) {
  const plan = installationPlan(root, model);
  const consent = readJson(path.join(root, 'download-consent.json'));
  const request = readJson(path.join(root, 'setup-dispatch.json'));
  // Legacy explicit receipts remain valid. New automatic preparation instead
  // requires the provider-created request for these exact signed bytes; a
  // bare internal worker invocation cannot download or author a fake consent.
  if (approvedHash !== plan.planHash || consent?.planHash !== approvedHash
    && !(request?.schemaVersion === 1 && request.planHash === approvedHash
      && ['skill-use', 'explicit-setup'].includes(request.reason)))
    throw Error('AUDIO_DOWNLOAD_CONSENT_REQUIRED');
  const lock = path.join(root, 'setup.lock');
  try {
    const old = readJson(lock);
    if (old && isProcessAlive(old.pid)) return;
    if (old) fs.unlinkSync(lock);
    fs.writeFileSync(lock, JSON.stringify({pid: process.pid, nonce: randomUUID()}), {flag: 'wx', mode: 0o600});
  } catch {throw Error('AUDIO_SETUP_BUSY');}
  let currentStage = 'starting';
  const state = stage => {
    currentStage = stage;
    atomicJson(path.join(root, 'setup.json'), {state: 'installing', stage, pid: process.pid, updatedAt: new Date().toISOString()});
  };
  try {
    state('disk');
    const space = fs.statfsSync(root);
    if (Number(space.bavail) * Number(space.bsize) < plan.requiredFreeBytes) throw Error('AUDIO_DISK_SPACE_REQUIRED');
    for (const child of ['downloads', 'bin', 'models', 'engine']) privateDirectory(path.join(root, child));
    state('runtime-download');
    const archive = path.join(root, 'downloads', `uv-${artifacts.uvVersion}.${plan.uv.format}`);
    await downloadArtifact(plan.uv, archive);
    const executable = path.join(root, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
    const temporary = executable + '.tmp';
    fs.writeFileSync(temporary, unpackUv(fs.readFileSync(archive), plan.uv.format), {mode: 0o700});
    fs.renameSync(temporary, executable);
    for (const name of ['pyproject.toml', 'uv.lock']) fs.copyFileSync(path.join(engineSource(model), name), path.join(root, 'engine', name));
    state('runtime-install');
    const installed = spawnSync(executable, ['sync', '--frozen', '--no-dev', '--no-install-project', '--managed-python', '--python', artifacts.pythonVersion,
      ...(model === whisper.model ? ['--no-build'] : []), '--project', path.join(root, 'engine')],
      {shell: false, windowsHide: true, env: childEnvironment(root), stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024, timeout: 15 * 60 * 1000});
    if (installed.error || installed.status !== 0 || !fs.existsSync(pythonPath(root))) {
      // Only a provider-owned synthetic CI harness can inject this callback.
      // Production never emits installer stderr, private paths or environment.
      installerFailure?.(installed);
      throw Error('AUDIO_ENGINE_INSTALL_FAILED');
    }
    if (model === whisper.model) {
      // A wheel can install successfully while its native imports fail on the
      // current OS. Check the real worker environment before promising ready.
      const probe = spawnSync(pythonPath(root), ['-I', '-c', 'from faster_whisper import WhisperModel'],
        {shell: false, windowsHide: true, env: childEnvironment(root), stdio: 'ignore', timeout: 60000});
      if (probe.error || probe.status !== 0) throw Error('AUDIO_WHISPER_RUNTIME_IMPORT_FAILED');
    }
    state('model-download');
    for (const model of plan.models) await downloadArtifact(model, path.join(root, 'models', model.name));
    atomicJson(path.join(root, 'installed.json'), {planHash: plan.planHash, model: plan.model, installedAt: new Date().toISOString()});
    atomicJson(path.join(root, 'setup.json'), {state: 'ready', stage: 'complete'});
  } catch (error) {
    atomicJson(path.join(root, 'setup.json'), {state: 'failed', stage: currentStage,
      errorCode: /^AUDIO_[A-Z_]+$/u.test(error.message) ? error.message : 'AUDIO_SETUP_FAILED'});
  } finally {fs.rmSync(lock, {force: true});}
}
