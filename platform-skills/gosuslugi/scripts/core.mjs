import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const LEASE_MS = 30 * 60 * 1000;
export const SKILL = 'gosuslugi';
export const RUNTIME_VERSION = '3.3.14';
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
export async function browserSessionBinding(env = process.env) {
  const moduleUrl = String(env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
  requireThat(moduleUrl.startsWith('file:'), 'browser_session_host_required');
  browserSessionRuntimePromise ||= import(moduleUrl);
  const runtime = await browserSessionRuntimePromise;
  const binding = runtime.readBrowserSessionBinding({
    environment: env,
    expectedSessionClass: 'protected-snapshot',
  });
  // Госуслуги keep their stricter native supervisor and encrypted snapshot.
  // The shared host lease is an outer bound, never a reason to weaken the
  // existing 30-minute in-process and native deadlines.
  requireThat(binding.leaseMs === LEASE_MS && !binding.manualAssist, 'browser_session_policy_invalid');
  return binding;
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
  cipher.setAAD(Buffer.from(`trelio/gosuslugi/v1/${identityKey(identity)}`));
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
    cipher.setAAD(Buffer.from(`trelio/gosuslugi/v1/${identityKey(identity)}`));
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
export function normalizeCredentials(value) {
  requireThat(value && Object.keys(value).sort().join() === 'login,password,totp', 'credentials_invalid');
  requireThat(typeof value.login === 'string' && /^\+?\d[\d ()-]{9,23}$/.test(value.login), 'phone_invalid');
  const login = value.login.replace(/[ ()-]/g, '');
  requireThat(/^\+?\d{10,15}$/.test(login), 'phone_invalid');
  requireThat(typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 256 &&
    !/[\r\n\0]/.test(value.password), 'password_invalid');
  return { login, password: value.password, totp: normalizeTotp(value.totp) };
}

export function officialUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (u.hostname === 'gosuslugi.ru' || u.hostname.endsWith('.gosuslugi.ru'));
  } catch { return false; }
}
export function authOrigin(value) {
  try { return officialUrl(value) && ['https://esia.gosuslugi.ru', 'https://roles.gosuslugi.ru'].includes(new URL(value).origin); }
  catch { return false; }
}

export function providerRequestAllowed({ url, navigation, method, resourceType }) {
  if (officialUrl(url)) return true;
  // The portal serves its CSS, Angular bootstrap and fonts from gu-st.ru.
  // This exact resource host is not a second navigation, credential or API
  // origin: a GET alone is insufficient, because fetch/XHR and form navigation
  // can carry private data too. Only the observed static Angular templates,
  // translation bundles for portal applications and their optional feature
  // dictionaries, and fixed widget configuration need XHR; arbitrary
  // endpoints remain closed, including queries/fragments on these exceptions.
  if (navigation !== false || !['GET', 'HEAD'].includes(method)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'gu-st.ru' ||
        parsed.username || parsed.password || parsed.port) return false;
    if (['script', 'stylesheet', 'image', 'font'].includes(resourceType)) return true;
    if (['xhr', 'fetch'].includes(resourceType)) {
      if (parsed.search || parsed.hash) return false;
      return /^\/htdocs\/tpl\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.html$/.test(parsed.pathname) ||
        /^\/[a-z][a-z0-9-]*-st\/(?:lib-assets|assets)\/i18n\/[a-z]{2}(?:-[A-Za-z]{2})?\.[a-zA-Z0-9_.-]+\.json$/.test(parsed.pathname) ||
        /^\/[a-z][a-z0-9-]*-st\/assets\/i18n\/[a-z][a-z0-9_-]*\/[a-z]{2}(?:-[A-Za-z]{2})?\.[a-zA-Z0-9_.-]+\.json$/.test(parsed.pathname) ||
        parsed.pathname === '/widget-minimax/config.json';
    }
    // Chromium classifies the document's favicon as "other", not "image".
    return resourceType === 'other' && (/^\/htdocs\/img\/favicon-[a-f0-9]+\.ico$/.test(parsed.pathname) ||
      /^\/portal-st\/favicon\.(?:ico|svg)$/.test(parsed.pathname));
  } catch { return false; }
}

// Presence of a seed does not turn an SMS challenge into TOTP. Ambiguous
// challenge text always asks the human instead of guessing a second factor.
export function challengeKind(text, hasCodeInput) {
  // The QR landing page asks the human to confirm in the mobile app, but it
  // also offers the exact "Логин и пароль" path. Remove only that known QR
  // instruction before classifying challenges. Any separate CAPTCHA, push,
  // consent or recovery message must still stop automatic credential entry.
  const challengeText = /Вход по\s*QR-коду/i.test(text)
    ? text.replace(/Наведите камеру\s+и\s+подтвердите вход\s+в приложении\s+[«"]?Госуслуги[»"]?/gi, '')
    : text;
  if (/captcha|капч|робот|восстановлен|смен[аи] пароля|выбор.*роли|войти как|выберите организацию|выбор организации|заблокирован/i.test(challengeText)) return 'manual';
  if (hasCodeInput && /код|подтвердите вход/i.test(challengeText)) {
    if (/смс|sms|сообщени[ея].*(номер|телефон)|код.*MAX/i.test(challengeText)) return 'user_code';
    if (/TOTP|код.*приложени[яе].*(аутентиф|одноразов)|код.*аутентификатор|одноразов.*код.*приложени/i.test(challengeText)) return 'totp';
    return 'user_code';
  }
  if (/push|подтвердите.*(телефон|приложени)|биометри/i.test(challengeText)) return 'manual';
  return 'none';
}

// The ESIA QR landing page lists other sign-in methods below the fold. Its
// body text can therefore contain words such as "биометрия" which describe a
// choice, not an active challenge. Prefer the exact visible password button
// over that page-wide wording, but only before any credential/code form or
// separately actionable human blocker appears. Clicking this choice does not
// submit credentials or accept a consent.
export function qrPasswordChoice(text, { choiceCount, loginCount, passwordCount, codeCount, checkboxCount }) {
  if (!/Вход по\s*QR-коду/i.test(text) || choiceCount !== 1 ||
    loginCount !== 0 || passwordCount !== 0 || codeCount !== 0 || checkboxCount !== 0) return false;
  return !/captcha|капч|робот|восстановлен|смен[аи] пароля|заблокирован|войти как|выберите организацию|выбор организации|\bpush\b|введите\s+(?:код|пароль)|код\s+(?:из\s+)?(?:смс|sms)|соглас.{0,80}(?:передач|обработ)|предостав.{0,120}(?:доступ|сведен|данн)|разреш.{0,80}(?:доступ|сведен|данн)/i.test(text);
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
