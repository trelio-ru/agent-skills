import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const SKILL = 'vk-ads';
export const VERSION = '1.4.2';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class Fault extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
export function check(value, code = 'invalid_input') { if (!value) throw new Fault(code); }
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function identity(env = process.env) {
  check(env.TRELIO_SKILL_ID === SKILL && UUID.test(env.TRELIO_SKILL_COMPANY_ID || '') &&
    UUID.test(env.TRELIO_SKILL_MEMBER_ID || '') && !env.TRELIO_SKILL_CONNECTION_ID, 'host_identity_required');
  let account;
  try { account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON); } catch { throw new Fault('local_account_required'); }
  // New accounts use the host UUID. There is no legacy credential importer or
  // user-controlled alternate locator, and account labels never become paths.
  check(UUID.test(account?.id || '') && account.providerRef === null && /^[a-f0-9]{64}$/.test(account.companyBinding), 'account_binding_invalid');
  return { account: account.id.toLowerCase(), binding: account.companyBinding,
    company: env.TRELIO_SKILL_COMPANY_ID.toLowerCase(), member: env.TRELIO_SKILL_MEMBER_ID.toLowerCase() };
}
export function configRoot(env = process.env) {
  const root = env.TRELIO_CONFIG_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || '', 'Trelio') : path.join(os.homedir(), '.config', 'trelio'));
  check(path.isAbsolute(root), 'config_home_invalid'); return root;
}
export function storagePath(root, owner) { return path.join(root, 'integrations', SKILL, 'accounts', owner.account); }
export function scope(owner) { return hash(stable(owner)); }
export function id(value) {
  // JSON arrays such as [123] also stringify to "123". They are not scalar
  // references and must not silently select an advertising object or source.
  check(['number', 'string'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647, 'object_id_invalid');
  return Number(value);
}
export function date(value) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(value), 'date_invalid');
  const parsed = new Date(`${value}T00:00:00Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'date_invalid'); return value;
}
export function credentials(value) {
  check(value && ['client', 'agency'].includes(value.mode) && ['ad_groups', 'campaigns'].includes(value.groups), 'credentials_invalid');
  check(typeof value.client_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.client_id), 'credentials_invalid');
  check(typeof value.client_secret === 'string' && value.client_secret.length >= 1 && value.client_secret.length <= 4096 && !/[\r\n\0]/.test(value.client_secret), 'credentials_invalid');
  check(typeof value.agency_client === 'string' && value.agency_client.length <= 256 && !/[\r\n\0]/.test(value.agency_client), 'credentials_invalid');
  check(value.mode !== 'agency' || value.agency_client.trim(), 'agency_client_required');
  return { mode: value.mode, groups: value.groups, client_id: value.client_id,
    client_secret: value.client_secret, agency_client: value.agency_client.trim() };
}
// Recursive checking also applies to targeting and textblocks. Those provider
// objects are data, but cannot introduce auth headers, tokens or prototype keys.
export function data(value, depth = 0) {
  check(depth < 12, 'payload_too_deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'payload_invalid'); return; }
  if (typeof value === 'string') { check(value.length <= 16000 && !value.includes('\0'), 'payload_invalid'); return; }
  check(value && typeof value === 'object', 'payload_invalid');
  if (Array.isArray(value)) { check(value.length <= 200, 'payload_invalid'); value.forEach(v => data(v, depth + 1)); return; }
  check(Object.keys(value).length <= 100, 'payload_invalid');
  for (const [key, v] of Object.entries(value)) {
    check(/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(key) && !/secret|password|token|authorization|cookie|__proto__|constructor|prototype/i.test(key), 'payload_field_forbidden');
    data(v, depth + 1);
  }
}
export function clean(value, secrets = []) {
  if (typeof value === 'string') return secrets.filter(s => s && s.length >= 4).reduce((s, secret) => s.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(v => clean(v, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/secret|password|token|authorization|cookie/i.test(k)).map(([k, v]) => [k, clean(v, secrets)]));
}
export function childEnvironment(env = process.env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
  return Object.fromEntries(keys.filter(k => env[k]).map(k => [k, env[k]]));
}
