import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const LEASE_MS = 30 * 60 * 1000;
export const SKILL = 'whatsapp-web';
// Active workers must implement the current command and native ownership contract.
export const RUNTIME_VERSION = '2.1.1';
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
export function guardianConfig(line) {
  requireThat(typeof line === 'string' && Buffer.byteLength(line) < 16384, 'guardian_config_invalid');
  // .NET Framework's Process may flush the default UTF-8 writer's BOM before
  // its caller replaces that writer. Accept one transport preamble on the first
  // line only; values inside JSON and later permit packets are never rewritten.
  try { return JSON.parse(line.replace(/^\uFEFF/, '')); }
  catch { throw new RuntimeError('guardian_config_invalid'); }
}
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Identity comes from the verified host, never from user-editable CLI flags.
// Version and task/Run IDs deliberately do not partition personal credentials.
export function identityFromEnv(env = process.env) {
  requireThat(env.TRELIO_SKILL_ID === SKILL && UUID.test(env.TRELIO_SKILL_COMPANY_ID || '') &&
    UUID.test(env.TRELIO_SKILL_MEMBER_ID || ''), 'host_identity_required');
  requireThat(UUID.test(env.TRELIO_SKILL_CONNECTION_ID || ''), 'host_connection_required');
  return { skill: SKILL, company: env.TRELIO_SKILL_COMPANY_ID.toLowerCase(),
    member: env.TRELIO_SKILL_MEMBER_ID.toLowerCase(), connection: env.TRELIO_SKILL_CONNECTION_ID.toLowerCase() };
}
export function identityKey(identity) { return digest(JSON.stringify(identity)); }
export function configRoot(env = process.env, platform = process.platform) {
  // Browser profiles use the same ordinary local directory on both desktop
  // systems. The protocol transport retains its separate admission gate; OS
  // support here must not silently authorize a switch between the two devices.
  requireThat(['darwin', 'win32'].includes(platform), 'unsupported_platform');
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

// Protocol authentication data has one on-disk representation: AEAD ciphertext.
// Binding the envelope to the identity prevents copying another member's vault
// into this namespace even when both accounts happen to use the same OS key.
export function encryptRecord(key, identity, value) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 'key_invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`trelio/whatsapp-web/v1/${identityKey(identity)}`));
  const plain = Buffer.from(JSON.stringify(value));
  try {
    requireThat(plain.length <= 32 * 1024 * 1024, 'vault_too_large');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ schema: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { plain.fill(0); }
}
export function decryptRecord(key, identity, text) {
  let plain;
  try {
    requireThat(text.length < 48 * 1024 * 1024);
    const record = JSON.parse(text);
    requireThat(record.schema === 1 && Object.keys(record).sort().join() === 'data,iv,schema,tag');
    const iv = Buffer.from(record.iv, 'base64'), tag = Buffer.from(record.tag, 'base64');
    requireThat(iv.length === 12 && tag.length === 16);
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`trelio/whatsapp-web/v1/${identityKey(identity)}`));
    cipher.setAuthTag(tag);
    plain = Buffer.concat([cipher.update(Buffer.from(record.data, 'base64')), cipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { throw new RuntimeError('vault_corrupt_or_wrong_identity'); }
  finally { plain?.fill(0); }
}

export async function privateStat(file, directory = false) {
  const stat = await fs.lstat(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'unsafe_storage');
  if (process.platform !== 'win32') requireThat(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe_permissions');
  return stat;
}
// This environment is for browser/native subprocesses, not the host identity
// transport. In particular, DEBUG, NODE_OPTIONS and arbitrary provider secrets
// must not reach Playwright logging or browser extensions/processes.
export function childEnvironment(env = process.env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY'];
  return Object.fromEntries(keys.filter(key => env[key]).map(key => [key, env[key]]));
}
