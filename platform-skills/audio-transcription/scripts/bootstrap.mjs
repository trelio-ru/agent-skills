import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {gunzipSync, inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {atomicJson, privateDirectory, readJson, stateDirectory} from './storage.mjs';

export const providerRoot = fileURLToPath(new URL('../', import.meta.url));
export const artifacts = JSON.parse(fs.readFileSync(new URL('artifacts.json', import.meta.url)));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const platformKey = `${process.platform}-${process.arch}`;
export const pythonPath = root => path.join(root, 'engine', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function installationPlan(root = stateDirectory()) {
  const uv = artifacts.uv[platformKey];
  // PyTorch discontinued current Intel macOS wheels. Do not silently substitute
  // an older model/runtime or claim untested binary compatibility on that CPU.
  if (!uv || platformKey === 'darwin-x64') throw Error('AUDIO_PLATFORM_UNSUPPORTED');
  const lock = fs.readFileSync(path.join(providerRoot, 'engine', 'uv.lock'));
  const project = fs.readFileSync(path.join(providerRoot, 'engine', 'pyproject.toml'));
  const material = {schemaVersion: 1, platform: platformKey, directory: path.resolve(root),
    model: artifacts.model, pythonVersion: artifacts.pythonVersion, uvVersion: artifacts.uvVersion,
    lockSha256: digest(lock), projectSha256: digest(project), uv,
    models: artifacts.models, maximumDependencyDownloadBytes: 1536 * 1024 * 1024,
    requiredFreeBytes: 4 * 1024 ** 3,
    sources: ['github.com/astral-sh/uv', 'github.com/astral-sh/python-build-standalone', 'pypi.org', 'files.pythonhosted.org', 'download.pytorch.org', 'cdn.chatwm.opensmodel.sberdevices.ru'],
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
  Object.assign(clean, {UV_NO_CONFIG: '1', UV_CACHE_DIR: path.join(root, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_PYTHON_BIN_DIR: path.join(root, 'python-bin'),
    UV_LINK_MODE: 'copy', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1', TOKENIZERS_PARALLELISM: 'false'});
  return clean;
}

export function ready(root) {
  const plan = installationPlan(root);
  const receipt = readJson(path.join(root, 'installed.json'));
  return receipt?.planHash === plan.planHash && fs.existsSync(pythonPath(root)) && artifacts.models.every(model => {
    const stat = fs.lstatSync(path.join(root, 'models', model.name), {throwIfNoEntry: false});
    return stat?.isFile() && !stat.isSymbolicLink() && stat.size === model.bytes;
  });
}

export async function downloadArtifact(artifact, target, {fetcher = fetch, retryDelays = [2000, 5000]} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await downloadOnce(artifact, target, fetcher); }
    catch (error) {
      // A transient transport failure can safely resume a bounded partial file.
      // Integrity, origin, range and local permission refusals are terminal.
      const transient = ['TypeError', 'TimeoutError', 'AbortError', 'AudioTransportError'].includes(error.name);
      if (!transient || attempt >= retryDelays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

async function downloadOnce(artifact, target, fetcher) {
  const existing = fs.lstatSync(target, {throwIfNoEntry: false});
  if (existing?.isSymbolicLink()) throw Error('AUDIO_DOWNLOAD_PATH_INVALID');
  if (existing?.isFile() && existing.size === artifact.bytes && await fileDigest(target) === artifact.sha256) return;
  const part = `${target}.part`;
  const partial = fs.lstatSync(part, {throwIfNoEntry: false});
  if (partial && (!partial.isFile() || partial.isSymbolicLink() || partial.size > artifact.bytes)) throw Error('AUDIO_DOWNLOAD_PATH_INVALID');
  let offset = partial?.size || 0;
  let url = new URL(artifact.url);
  let response;
  for (let redirects = 0; redirects < 6; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['github.com', 'release-assets.githubusercontent.com', 'cdn.chatwm.opensmodel.sberdevices.ru'].includes(url.hostname)) throw Error('AUDIO_DOWNLOAD_ORIGIN_DENIED');
    response = await fetcher(url, {redirect: 'manual', headers: offset ? {Range: `bytes=${offset}-`} : {},
      signal: AbortSignal.timeout(artifact.bytes > 50 * 1024 * 1024 ? 15 * 60 * 1000 : 120000)});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), url);
  }
  if (!response || ![200, 206].includes(response.status)) {
    await response?.body?.cancel();
    const error = Error('AUDIO_DOWNLOAD_FAILED');
    if (response?.status === 429 || response?.status >= 500) error.name = 'AudioTransportError';
    throw error;
  }
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') || '');
    if (!range || Number(range[1]) !== offset || Number(range[3]) !== artifact.bytes) throw Error('AUDIO_DOWNLOAD_RANGE_INVALID');
  } else offset = 0;
  let received = offset;
  const limiter = new Transform({transform(chunk, encoding, callback) {
    received += chunk.length;
    callback(received > artifact.bytes ? Error('AUDIO_DOWNLOAD_TOO_LARGE') : null, chunk);
  }});
  await pipeline(Readable.fromWeb(response.body), limiter,
    fs.createWriteStream(part, {flags: offset ? 'a' : 'w', mode: 0o600}));
  if (received !== artifact.bytes || await fileDigest(part) !== artifact.sha256) {
    fs.rmSync(part, {force: true});
    throw Error('AUDIO_DOWNLOAD_DIGEST_MISMATCH');
  }
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

export function startSetup(approvedHash, root = stateDirectory()) {
  const plan = installationPlan(root);
  if (approvedHash !== plan.planHash) throw Error('AUDIO_DOWNLOAD_CONSENT_REQUIRED');
  privateDirectory(root);
  if (ready(root)) return {ok: true, state: 'ready', model: artifacts.model};
  const current = readJson(path.join(root, 'setup.json'));
  if (current?.state === 'installing' && isProcessAlive(current.pid)) return {ok: true, state: 'installing'};
  // This literal approval is supplied only after the agent has presented this
  // exact plan and received the user's explicit download/install consent.
  atomicJson(path.join(root, 'download-consent.json'), {planHash: plan.planHash, approvedAt: new Date().toISOString(), deviceDirectory: root});
  const worker = spawn(process.execPath, [fileURLToPath(new URL('audio-transcription.mjs', import.meta.url)), '__setup', plan.planHash],
    {detached: true, stdio: 'ignore', shell: false, windowsHide: true, env: {...childEnvironment(root), TRELIO_AUDIO_SETUP_ROOT: root}});
  worker.unref();
  return {ok: true, state: 'installing', nextCommand: ['doctor']};
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {process.kill(pid, 0); return true;} catch {return false;}
}

export async function performSetup(approvedHash, root, {installerFailure = null} = {}) {
  const plan = installationPlan(root);
  const consent = readJson(path.join(root, 'download-consent.json'));
  if (consent?.planHash !== approvedHash || approvedHash !== plan.planHash) throw Error('AUDIO_DOWNLOAD_CONSENT_REQUIRED');
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
    for (const name of ['pyproject.toml', 'uv.lock']) fs.copyFileSync(path.join(providerRoot, 'engine', name), path.join(root, 'engine', name));
    state('runtime-install');
    const installed = spawnSync(executable, ['sync', '--frozen', '--no-dev', '--no-install-project', '--managed-python', '--python', artifacts.pythonVersion,
      '--project', path.join(root, 'engine')],
      {shell: false, windowsHide: true, env: childEnvironment(root), stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024, timeout: 15 * 60 * 1000});
    if (installed.error || installed.status !== 0 || !fs.existsSync(pythonPath(root))) {
      // Only a provider-owned synthetic CI harness can inject this callback.
      // Production never emits installer stderr, private paths or environment.
      installerFailure?.(installed);
      throw Error('AUDIO_ENGINE_INSTALL_FAILED');
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
