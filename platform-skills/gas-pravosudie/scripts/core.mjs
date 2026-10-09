import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const LEASE_MS = 30 * 60 * 1000;
export const SKILL = 'gas-pravosudie';
export const RUNTIME_VERSION = '1.0.7';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// HTTP failure evidence is deliberately smaller than a browser response: a
// status and a canonical HTTPS origin cannot contain OAuth paths, queries,
// headers, response bodies or provider messages. Revalidate at every transport
// boundary; arbitrary exception properties must never become model output.
export function serviceHttpFailure(value) {
  if ((value?.code ?? value?.error) !== 'service_http_error' ||
      !Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599 ||
      typeof value.httpOrigin !== 'string' || value.httpOrigin.length > 253) return {};
  try {
    const origin = new URL(value.httpOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== value.httpOrigin ||
        origin.username || origin.password || origin.port) return {};
    return { httpStatus: value.httpStatus, httpOrigin: origin.origin };
  } catch { return {}; }
}

export class RuntimeError extends Error {
  constructor(code, details = {}) {
    super(code); this.code = code;
    Object.assign(this, serviceHttpFailure({ ...details, code }));
  }
}

export function requireThat(value, code = 'invalid_input') {
  if (!value) throw new RuntimeError(code);
}

let browserSessionRuntimePromise;
export async function browserSessionRuntime(env = process.env) {
  const moduleUrl = String(env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
  requireThat(moduleUrl.startsWith('file:'), 'browser_session_host_required');
  browserSessionRuntimePromise ||= import(moduleUrl);
  const runtime = await browserSessionRuntimePromise;
  const binding = runtime.readBrowserSessionBinding({
    environment: env,
    expectedSessionClass: 'protected-snapshot',
  });
  // The host lease is an outer admission boundary. The provider keeps its own
  // native continuous-clock guardian so sleep or a stalled JS loop cannot
  // extend the unlocked browser session past the same fixed 30 minutes.
  requireThat(binding.leaseMs === LEASE_MS && !binding.manualAssist, 'browser_session_policy_invalid');
  return { runtime, binding };
}

export function guardianConfig(line) {
  requireThat(typeof line === 'string' && Buffer.byteLength(line) < 16384, 'guardian_config_invalid');
  // .NET Framework can emit one UTF-8 BOM before the worker replaces its
  // default writer. Only the transport preamble is tolerated; packet values
  // and all later lines stay byte-exact.
  try { return JSON.parse(line.replace(/^\uFEFF/, '')); }
  catch { throw new RuntimeError('guardian_config_invalid'); }
}

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Stable host-owned IDs partition the reusable court session. A task, Run,
// version or mutable slug must never create an accidental second identity.
export function identityFromEnv(env = process.env) {
  requireThat(env.TRELIO_SKILL_ID === SKILL && UUID.test(env.TRELIO_SKILL_COMPANY_ID || '') &&
    UUID.test(env.TRELIO_SKILL_MEMBER_ID || ''), 'host_identity_required');
  requireThat(!env.TRELIO_SKILL_CONNECTION_ID, 'unexpected_company_connection');
  return {
    skill: SKILL,
    company: env.TRELIO_SKILL_COMPANY_ID.toLowerCase(),
    member: env.TRELIO_SKILL_MEMBER_ID.toLowerCase(),
    connection: 'browser',
  };
}

export function identityKey(identity) { return digest(JSON.stringify(identity)); }

export function configRoot(env = process.env, platform = process.platform) {
  requireThat(platform === 'darwin' || platform === 'win32', 'unsupported_platform');
  const paths = platform === 'win32' ? path.win32 : path;
  const root = env.TRELIO_CONFIG_HOME || (platform === 'win32'
    ? paths.join(env.LOCALAPPDATA || '', 'Trelio')
    : path.join(os.homedir(), '.config', 'trelio'));
  requireThat(paths.isAbsolute(root), 'config_home_invalid');
  return root;
}

export function storageDirectory(root, identity) {
  return path.join(root, 'integrations', SKILL, identity.company, identity.member, identity.connection);
}

// Cookies and origin storage have exactly one durable representation: an AEAD
// envelope bound to this skill/company/member identity. The browser itself is
// always an ephemeral context, so no plaintext Chromium profile is retained.
export function encryptRecord(key, identity, value) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 'key_invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`trelio/gas-pravosudie/v1/${identityKey(identity)}`));
  const plain = Buffer.from(JSON.stringify(value));
  try {
    requireThat(plain.length <= 4 * 1024 * 1024, 'vault_too_large');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({
      schema: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
  } finally {
    plain.fill(0);
  }
}

export function decryptRecord(key, identity, text) {
  let plain;
  try {
    requireThat(text.length < 6 * 1024 * 1024, 'vault_too_large');
    const record = JSON.parse(text);
    requireThat(record.schema === 1 && Object.keys(record).sort().join() === 'data,iv,schema,tag');
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    requireThat(iv.length === 12 && tag.length === 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`trelio/gas-pravosudie/v1/${identityKey(identity)}`));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new RuntimeError('vault_corrupt_or_wrong_identity');
  } finally {
    plain?.fill(0);
  }
}

export function officialCourtUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'sudrf.ru' || url.hostname.endsWith('.sudrf.ru'));
  } catch {
    return false;
  }
}

export function officialCourtOrigin(value) {
  try {
    const url = new URL(value);
    return officialCourtUrl(url.href) && url.origin === value;
  } catch {
    return false;
  }
}

export function officialEsiaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'gosuslugi.ru' || url.hostname.endsWith('.gosuslugi.ru'));
  } catch {
    return false;
  }
}

export function staticEsiaResourceAllowed({ url, navigation, method, resourceType }) {
  if (navigation !== false || !['GET', 'HEAD'].includes(method)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'gu-st.ru' ||
      parsed.username || parsed.password || parsed.port) return false;
    if (['script', 'stylesheet', 'image', 'font'].includes(resourceType)) return true;
    if (['xhr', 'fetch'].includes(resourceType)) {
      if (parsed.search || parsed.hash) return false;
      return /^\/htdocs\/tpl\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.html$/.test(parsed.pathname) ||
        /^\/portal-st\/(?:lib-assets|assets)\/i18n\/[a-z]{2}(?:-[A-Za-z]{2})?\.[a-zA-Z0-9_.-]+\.json$/.test(parsed.pathname) ||
        parsed.pathname === '/widget-minimax/config.json';
    }
    return resourceType === 'other' && (/^\/htdocs\/img\/favicon-[a-f0-9]+\.ico$/.test(parsed.pathname) ||
      /^\/portal-st\/favicon\.(?:ico|svg)$/.test(parsed.pathname));
  } catch {
    return false;
  }
}

export async function privateStat(file, directory = false) {
  const stat = await fs.lstat(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'unsafe_storage');
  if (process.platform !== 'win32') {
    requireThat(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe_permissions');
  }
  return stat;
}

// Provider/browser children receive only the process essentials. Host identity,
// debug flags and unrelated credentials must not leak into Chromium or native
// compiler processes through ambient environment variables.
export function childEnvironment(env = process.env) {
  const keys = [
    'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY',
  ];
  return Object.fromEntries(keys.filter(key => env[key]).map(key => [key, env[key]]));
}
