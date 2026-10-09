import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const LEASE_MS = 30 * 60 * 1000;
export const SKILL = 't-bank';
export const RUNTIME_VERSION = '1.3.5';
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
  requireThat(!env.TRELIO_SKILL_CONNECTION_ID, 'unexpected_company_connection');
  return { skill: SKILL, company: env.TRELIO_SKILL_COMPANY_ID.toLowerCase(),
    member: env.TRELIO_SKILL_MEMBER_ID.toLowerCase(), connection: 'browser' };
}
export function identityKey(identity) { return digest(JSON.stringify(identity)); }
export function configRoot(env = process.env, platform = process.platform) {
  requireThat(platform === 'darwin' || platform === 'win32', 'unsupported_platform');
  const root = env.TRELIO_CONFIG_HOME || (platform === 'win32'
    ? path.join(env.LOCALAPPDATA || '', 'Trelio')
    : path.join(os.homedir(), '.config', 'trelio'));
  requireThat(path.isAbsolute(root), 'config_home_invalid');
  return root;
}
export function storageDirectory(root, identity) {
  return path.join(root, 'integrations', SKILL, identity.company, identity.member, identity.connection);
}

// Authentication data has exactly one on-disk representation: AEAD ciphertext.
// Binding the envelope to the identity prevents copying another member's vault
// into this namespace even when both accounts happen to use the same OS key.
export function encryptRecord(key, identity, value) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 'key_invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`trelio/t-bank/v1/${identityKey(identity)}`));
  const plain = Buffer.from(JSON.stringify(value));
  try {
    requireThat(plain.length <= 4 * 1024 * 1024, 'vault_too_large');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ schema: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { plain.fill(0); }
}
export function decryptRecord(key, identity, text) {
  let plain;
  try {
    requireThat(text.length < 6 * 1024 * 1024);
    const record = JSON.parse(text);
    requireThat(record.schema === 1 && Object.keys(record).sort().join() === 'data,iv,schema,tag');
    const iv = Buffer.from(record.iv, 'base64'), tag = Buffer.from(record.tag, 'base64');
    requireThat(iv.length === 12 && tag.length === 16);
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`trelio/t-bank/v1/${identityKey(identity)}`));
    cipher.setAuthTag(tag);
    plain = Buffer.concat([cipher.update(Buffer.from(record.data, 'base64')), cipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { throw new RuntimeError('vault_corrupt_or_wrong_identity'); }
  finally { plain?.fill(0); }
}

export function normalizeTotp(value) {
  requireThat(typeof value === 'string' && value.length <= 2048, 'totp_invalid');
  if (!value.trim()) return null;
  let secret = value.trim();
  if (secret.startsWith('otpauth:')) {
    const url = new URL(secret);
    requireThat(url.protocol === 'otpauth:' && url.hostname === 'totp' &&
      (url.searchParams.get('algorithm') || 'SHA1').toUpperCase() === 'SHA1' &&
      (url.searchParams.get('digits') || '6') === '6' &&
      (url.searchParams.get('period') || '30') === '30', 'totp_invalid');
    secret = url.searchParams.get('secret') || '';
  }
  secret = secret.replace(/\s/g, '').toUpperCase();
  requireThat(/^[A-Z2-7]{16,128}$/.test(secret) && [0, 2, 4, 5, 7].includes(secret.length % 8), 'totp_invalid');
  const bytes = decodeBase32(secret);
  requireThat(bytes.length >= 10, 'totp_invalid');
  bytes.fill(0);
  return secret;
}
function decodeBase32(secret) {
  let bits = 0, count = 0; const result = [];
  for (const char of secret) {
    bits = (bits << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); count += 5;
    if (count >= 8) { count -= 8; result.push((bits >>> count) & 255); }
  }
  requireThat((bits & ((1 << count) - 1)) === 0, 'totp_invalid');
  return Buffer.from(result);
}
export function totpCode(secret, now = Date.now()) {
  const key = decodeBase32(normalizeTotp(secret));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  try {
    const hmac = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = hmac[19] & 15;
    return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  } finally { key.fill(0); }
}

// Both the direct browser runtime and the delegated T-ID authorizer must make
// the same fail-closed decision about segmented OTP controls. Raw RPC metadata
// reports an omitted HTML type as an empty string, while Playwright's DOM
// property reports the same default as "text"; normalize that representation
// here so the security contract cannot drift between the two login paths.
export function segmentedTotpFields(fields) {
  if (!Array.isArray(fields) || fields.length !== 6) return false;
  const safeType = field => ['', 'text', 'tel'].includes(field.type);
  const native = fields.every(field =>
    field.maxLength === '1' && safeType(field) && !field.readOnly);
  if (native) return true;
  // The current T-ID component leaves the five initially disabled cells as
  // plain inputs: the OTP autocomplete/inputmode hint exists only on the first
  // cell. Keep one positive OTP witness for the group, but do not require the
  // provider to duplicate it onto controls that cannot receive input yet.
  const hasOtpHint = fields.some(field =>
    field.autocomplete === 'one-time-code' ||
    field.inputMode === 'numeric' ||
    field.type === 'tel');
  return hasOtpHint &&
    fields.every((field, index) =>
      field.maxLength === null &&
      safeType(field) &&
      ['', 'numeric'].includes(field.inputMode) &&
      ['', 'one-time-code'].includes(field.autocomplete) &&
      field.disabled === (index !== 0) &&
      !field.readOnly);
}

export function tIdNationalPhone(value) {
  // T-ID owns the visible Russian country prefix. Both authentication paths
  // must enter the same ten national digits or masks can duplicate the 7 and
  // silently truncate the real last digit.
  requireThat(
    typeof value === 'string' && (/^\d{10}$/.test(value) || /^(?:\+7|7|8)\d{10}$/.test(value)),
    'auth_phone_input_invalid',
  );
  return value.slice(-10);
}
export function normalizeCredentials(value) {
  requireThat(value && ['login,password,totp', 'login,password,totp,username'].includes(Object.keys(value).sort().join()), 'credentials_invalid');
  requireThat(typeof value.login === 'string' && /^\+?\d[\d ()-]{9,23}$/.test(value.login), 'phone_invalid');
  const login = value.login.replace(/[ ()-]/g, '');
  requireThat(/^\+?\d{10,15}$/.test(login), 'phone_invalid');
  requireThat(typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 256 &&
    !/[\r\n\0]/.test(value.password), 'password_invalid');
  // A separate named username still exists on some accounts. Never infer it
  // from a telephone or import it from another personal integration.
  requireThat(value.username == null || (typeof value.username === 'string' && value.username.length <= 256 &&
    !/[\r\n\0]/.test(value.username)), 'username_invalid');
  return { login, password: value.password, totp: normalizeTotp(value.totp), username: value.username || null };
}

export function officialUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['www.tbank.ru', 'id.tbank.ru'].includes(u.hostname);
  } catch { return false; }
}
export function authOrigin(value) {
  try { return officialUrl(value) && /^\/auth(?:\/|$)/.test(new URL(value).pathname); }
  catch { return false; }
}

// Delegated T‑ID is intentionally narrower than the bank's own login flow.
// Saved credentials may authenticate the personal cabinet on both supported
// bank origins, while a relying-party OAuth transaction must begin on the
// documented T‑ID authorization host and may never bind to www.tbank.ru.
export function tIdAuthUrl(value) {
  try { return authOrigin(value) && new URL(value).origin === 'https://id.tbank.ru'; }
  catch { return false; }
}

export function bankPageUrl(value) {
  try { const url = new URL(value); return officialUrl(value) && url.hostname === 'www.tbank.ru' && /^\/mybank(?:\/|$)/.test(url.pathname); }
  catch { return false; }
}

// Resource hosts cannot become navigation/credential origins. Only bank CDN
// hosts are admitted here; this does not trust arbitrary sibling services.
export function resourceUrl(value) {
  if (officialUrl(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['cdn.tbank.ru', 'acdn.tbank.ru', 'static.tbank.ru', 'imgproxy.cdn-tinkoff.ru',
      // The public id.tbank.ru login page loads its form bundle and styles
      // here. This exact host is a static dependency, never an auth/API origin.
      'sso-forms-prod.t-static.ru'].includes(url.hostname); }
  catch { return false; }
}

export function providerRequestAllowed({ url, navigation, method, resourceType }) {
  if (officialUrl(url)) return true;
  // A static CDN exception is not an extra form/API endpoint. In particular,
  // POST/beacon/fetch cannot deliver authentication data to a resource host.
  return !navigation && resourceUrl(url) && ['GET', 'HEAD'].includes(method) &&
    ['script', 'stylesheet', 'image', 'font', 'media'].includes(resourceType);
}

// Presence of a seed does not turn an SMS challenge into TOTP. Ambiguous
// challenge text always asks the human instead of guessing a second factor.
export function challengeKind(text, hasCodeInput) {
  // Provider headings can wrap between words. The bank's Russian name for an
  // authenticator is explicit TOTP evidence only beside a real code input;
  // SMS and sensitive-operation guards still take precedence over that hint.
  text = text.replace(/\s+/g, ' ');
  if (/captcha|капч|робот|восстановлен|смен[аи] пароля|заблокирован|нов(?:ое|ого|ому|ом)\s+устройств|подтвердите.*устройств|придумайте.*код|быстрого входа|предупреждение.*безопасност|подтвердите.*(плат[её]ж|перевод)|код[\s\S]*(оплат|списани|плат[её]ж|перевод)/i.test(text)) return 'manual';
  if (hasCodeInput && /код|подтвердите вход/i.test(text)) {
    if (/смс|sms|сообщени[ея].*(номер|телефон)/i.test(text)) return 'user_code';
    // The live six-field form calls the authenticator an «приложение для
    // аутентификации». Do not shorten this to generic «приложение»: codes from
    // the bank's own application still require the user's manual input.
    if (/TOTP|аутентификатор|приложени[ея]\s+для\s+аутентификации|генератор(?:а|е|ом)?\s+одноразовых\s+паролей/i.test(text)) return 'totp';
    return 'user_code';
  }
  if (/push|пуш|подтвердите.*(телефон|приложени)|биометри/i.test(text)) return 'manual';
  return 'none';
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
