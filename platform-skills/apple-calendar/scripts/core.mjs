import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const SKILL = 'apple-calendar';
export const VERSION = '1.0.4';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class Fault extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
export function check(condition, code = 'invalid_input') {
  if (!condition) throw new Fault(code);
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const scope = owner => hash(stable(owner));
export function identity(env = process.env) {
  check(env.TRELIO_SKILL_ID === SKILL && UUID.test(env.TRELIO_SKILL_COMPANY_ID || '') &&
    UUID.test(env.TRELIO_SKILL_MEMBER_ID || ''), 'host_identity_required');
  let account;
  try { account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON); }
  catch { throw new Fault('local_account_required'); }
  // The signed host selects the account before provider execution. Display
  // names and a caller-supplied path can never select another credential vault.
  check(UUID.test(account?.id || '') && account.providerRef === null &&
    /^[a-f0-9]{64}$/.test(account.companyBinding), 'account_binding_invalid');
  return { account: account.id.toLowerCase(), binding: account.companyBinding,
    company: env.TRELIO_SKILL_COMPANY_ID.toLowerCase(), member: env.TRELIO_SKILL_MEMBER_ID.toLowerCase() };
}
export function configRoot(env = process.env) {
  const root = env.TRELIO_CONFIG_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || '', 'Trelio') : path.join(os.homedir(), '.config', 'trelio'));
  check(path.isAbsolute(root), 'config_home_invalid');
  return root;
}
export const storagePath = (root, owner) => path.join(root, 'integrations', SKILL, 'accounts', owner.account);
export function childEnvironment(env = process.env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];
  return Object.fromEntries(keys.filter(key => env[key]).map(key => [key, env[key]]));
}
export function credentials(value) {
  check(value && Object.keys(value).sort().join(',') === 'password,username', 'credentials_invalid');
  check(typeof value.username === 'string' && /^[^\s@:\0]+@[^\s@\0]+\.[^\s@\0]+$/.test(value.username) && value.username.length <= 254,
    'credentials_invalid');
  check(typeof value.password === 'string' && /^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(value.password), 'app_specific_password_required');
  return { username: value.username, password: value.password };
}
export function object(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'object_required');
  check(Object.keys(value).every(key => keys.includes(key)), 'unknown_field');
  return value;
}
export function text(value, maximum = 16000) {
  check(typeof value === 'string' && value.length <= maximum && !/[\0\r]/.test(value), 'text_invalid');
  return value;
}
export function timezone(value) {
  text(value, 128);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new Fault('timezone_invalid'); }
  return value;
}
export function interval(from, to) {
  // An explicit offset avoids interpreting a date using the OS timezone. Reads
  // are bounded even for a malicious RRULE that could expand indefinitely.
  const absolute = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  check(absolute(from) && absolute(to), 'offset_required');
  const start = Date.parse(from), end = Date.parse(to);
  check(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 366 * 86400000, 'interval_invalid');
  return { start, end };
}
