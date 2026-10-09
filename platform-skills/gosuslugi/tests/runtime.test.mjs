import './chat-title.test.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LEASE_MS, identityFromEnv, encryptRecord, decryptRecord, normalizeCredentials, normalizeTotp, totpCode,
  challengeKind, qrPasswordChoice, authOrigin, officialUrl, providerRequestAllowed, childEnvironment, guardianConfig, RUNTIME_VERSION, storageDirectory } from '../scripts/core.mjs';
import { createPrompt, promptHtml, SAVE_WARNING, TOTP_HELP } from '../scripts/prompt.mjs';
import { atomicWrite, createPrivateFile, nativeHelper, nativeKeyHelper, nativeRequestTitleInput,
  runPrivate, ensurePrivateDirectory, verifyPrivate, keychainStatus } from '../scripts/native.mjs';
import { launchOwnedBrowser, validatedStorage, Portal, loginRole, roleChallenge, choosePersonalRole, authenticatedPortalHeader, reusableRoleStorage } from '../scripts/browser.mjs';
import { parseArguments, requestControl, run } from '../scripts/trelio-gosuslugi.mjs';
import { browserSessionDirectory } from '../scripts/transport.mjs';
import { authEvidence } from '../development/live-login-observations.mjs';
import { readCodexThreadTitle, resolveRequestTitle } from '../scripts/chat-title.mjs';

const identity = identityFromEnv({ TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: '11111111-1111-4111-8111-111111111111', TRELIO_SKILL_MEMBER_ID: '22222222-2222-4222-8222-222222222222' });
const synthetic = { login: '+70000000000', password: 'synthetic-not-a-real-password', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
const codexThreadId = '33333333-3333-4333-8333-333333333333';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const browserSessionModuleUrl = new URL('./browser-session-fixture.mjs', import.meta.url).href;
const browserSessionPolicy = JSON.stringify({
  apiVersion: 1,
  sessionClass: 'protected-snapshot',
  leaseMs: LEASE_MS,
  manualAssist: false,
});
const browserSessionEnvironment = () => {
  const startedAt = Date.now();
  return {
    TRELIO_BROWSER_SESSION_MODULE_URL: browserSessionModuleUrl,
    TRELIO_BROWSER_SESSION_POLICY_JSON: browserSessionPolicy,
    TRELIO_BROWSER_SESSION_STARTED_AT: String(startedAt),
    TRELIO_BROWSER_SESSION_DEADLINE_AT: String(startedAt + LEASE_MS),
  };
};
const previousBrowserSessionEnvironment = Object.fromEntries(
  Object.keys(browserSessionEnvironment()).map(key => [key, process.env[key]]),
);
Object.assign(process.env, browserSessionEnvironment());
test.after(() => {
  for (const [key, value] of Object.entries(previousBrowserSessionEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('Codex title comes from the exact thread and overrides caller wording', async () => {
  const title = 'Тестовая беседа';
  const mockAppServer = `let pending = ''; process.stdin.on('data', chunk => {
    pending += chunk.toString(); let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
      if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2,
        result: { thread: { id: message.params.threadId, name: ${JSON.stringify(title)} } } }) + '\\n');
    }
  });`;
  assert.equal(await readCodexThreadTitle(codexThreadId, {
    executable: process.execPath, arguments: ['-e', mockAppServer], timeoutMs: 2000,
  }), title);
  assert.equal(await readCodexThreadTitle(codexThreadId, {
    executable: process.execPath,
    arguments: ['-e', mockAppServer.replace('id: message.params.threadId', "id: 'other-thread'")],
    timeoutMs: 2000,
  }), null, 'another thread cannot supply the prompt title');
  assert.equal(await resolveRequestTitle('Другая тема', {
    environment: { CODEX_THREAD_ID: codexThreadId }, readThreadTitle: async () => title,
  }), title);
  assert.equal(await resolveRequestTitle(title, {
    environment: { CODEX_THREAD_ID: codexThreadId }, readThreadTitle: async () => null,
  }), title, 'an explicit caller title is fallback only');
  assert.equal(await resolveRequestTitle(null, {
    environment: { CODEX_THREAD_ID: codexThreadId }, readThreadTitle: async () => null,
  }), null, 'a failed Codex read without a verified caller title stays neutral');
  assert.equal(await resolveRequestTitle(title, { environment: {} }), title);
  assert.equal(await resolveRequestTitle('  invented title  ', { environment: {} }), null);
});

test('vault AEAD hides credentials and browser state, roundtrips and binds identity', () => {
  const key = crypto.randomBytes(32), value = { credentials: synthetic, storage: { cookies: [{ value: 'synthetic-cookie' }] } };
  const ciphertext = encryptRecord(key, identity, value);
  for (const secret of [...Object.values(synthetic), 'synthetic-cookie']) assert.ok(!ciphertext.includes(secret));
  assert.deepEqual(decryptRecord(key, identity, ciphertext), value);
  assert.notEqual(ciphertext, encryptRecord(key, identity, value));
  assert.throws(() => decryptRecord(key, { ...identity, member: 'other' }, ciphertext), /vault_corrupt/);
  assert.throws(() => decryptRecord(crypto.randomBytes(32), identity, ciphertext), /vault_corrupt/);
  for (const field of ['data', 'tag', 'iv']) {
    const envelope = JSON.parse(ciphertext), bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    envelope[field] = bytes.toString('base64');
    assert.throws(() => decryptRecord(key, identity, JSON.stringify(envelope)), /vault_corrupt/);
  }
});
test('optional TOTP, bounded formats and RFC 6238 SHA1 vector', () => {
  assert.equal(normalizeCredentials({ ...synthetic, totp: '' }).totp, null);
  assert.equal(normalizeTotp('  '), null);
  assert.equal(totpCode(synthetic.totp, 59000), '287082');
  assert.equal(normalizeTotp(`otpauth://totp/Synthetic?secret=${synthetic.totp}`), synthetic.totp);
  for (const value of ['123456', 'INVALID!', `otpauth://hotp/Test?secret=${synthetic.totp}`, `otpauth://totp/Test?secret=${synthetic.totp}&algorithm=SHA256`])
    assert.throws(() => normalizeTotp(value));
  assert.equal(normalizeCredentials({ ...synthetic, password: '  preserve whitespace  ' }).password, '  preserve whitespace  ');
  assert.throws(() => normalizeCredentials({ ...synthetic, code: '123456' }));
  assert.throws(() => normalizeCredentials({ ...synthetic, login: '1         ' }), /phone_invalid/);
});
test('actual challenge decides SMS vs TOTP; a code is never preemptively requested', () => {
  assert.equal(challengeKind('Введите пароль', false), 'none');
  assert.equal(challengeKind('Введите одноразовый код из приложения', true), 'totp');
  assert.equal(challengeKind('Введите код из SMS', true), 'user_code');
  assert.equal(challengeKind('Введите код из SMS, в настройках доступен TOTP', true), 'user_code');
  assert.equal(challengeKind('Подтвердите вход. Код подтверждения', true), 'user_code');
  assert.equal(challengeKind('CAPTCHA, введите код', true), 'manual');
  assert.equal(challengeKind('Войти как частное лицо', false), 'manual');
  assert.equal(challengeKind('Выберите организацию', false), 'manual');
  const qr = 'Вход по QR-коду\nНаведите камеру и подтвердите вход\nв приложении «Госуслуги»\nЛогин и пароль';
  assert.equal(challengeKind(qr, false), 'none', 'ordinary QR choice is not a mandatory mobile challenge');
  assert.equal(challengeKind(`${qr}\nQR-код устарел. Обновить`, false), 'none');
  assert.equal(challengeKind(`${qr}\nCAPTCHA`, false), 'manual', 'a separate challenge still blocks credentials');
  assert.equal(challengeKind('Подтвердите вход в приложении Госуслуги', false), 'manual');
});
test('QR password choice is structural and never overrides a separate blocker', () => {
  const qr = 'Вход по QR-коду\nНаведите камеру и подтвердите вход\nв приложении «Госуслуги»\nЛогин и пароль\nБиометрия';
  const emptyForm = { choiceCount: 1, loginCount: 0, passwordCount: 0, codeCount: 0, checkboxCount: 0 };
  assert.equal(challengeKind(qr, false), 'manual', 'the page-wide classifier sees the alternative biometric label');
  assert.equal(qrPasswordChoice(qr, emptyForm), true, 'the unique password control remains actionable');
  assert.equal(qrPasswordChoice(`${qr}\nQR-код устарел. Обновить`, emptyForm), true);
  for (const blocker of ['CAPTCHA', 'Введите код из SMS', 'Выберите организацию',
    'Восстановление пароля', 'Согласие на обработку персональных данных'])
    assert.equal(qrPasswordChoice(`${qr}\n${blocker}`, emptyForm), false, blocker);
  for (const changed of [{ choiceCount: 0 }, { choiceCount: 2 }, { loginCount: 1 },
    { passwordCount: 1 }, { codeCount: 1 }, { checkboxCount: 1 }])
    assert.equal(qrPasswordChoice(qr, { ...emptyForm, ...changed }), false);
});
test('ordinary portal chooses the QR password control before a page-wide manual label', async () => {
  let clicks = 0, observations = 0;
  const portal = new Portal(null, async () => {}, { onPhase: () => {}, persist: async () => {} });
  portal.page = { url: () => 'https://esia.gosuslugi.ru/login/', waitForTimeout: async () => {} };
  portal.inspectAuth = async () => {
    if (observations++) throw new Error('after_qr_choice');
    return { text: 'Вход по QR-коду\nБиометрия', qrChoice: true, challenge: 'manual' };
  };
  portal.authSubmit = async () => { clicks++; };
  await assert.rejects(portal.authenticate({ login: '+70000000000', password: 'synthetic-password' }),
    /after_qr_choice/);
  assert.equal(clicks, 1);
  assert.equal(portal.qrSent, true);
});
test('personal is the default; alternative identity choice is explicit and cannot authorise security or legal actions', () => {
  assert.equal(loginRole(), 'personal'); assert.equal(loginRole('manual'), 'manual');
  for (const value of ['first', 'organisation', '', null]) assert.throws(() => loginRole(value), /login_role_invalid/);
  assert.equal(roleChallenge('Войти как частное лицо', false), true);
  assert.equal(roleChallenge('Выберите организацию', false), true);
  assert.equal(roleChallenge('Войти как частное лицо', true), false);
  for (const warning of ['CAPTCHA', 'Код SMS', 'Восстановление пароля', 'Биометрия', 'Оплатить', 'Подписать документ'])
    assert.equal(roleChallenge(`Войти как частное лицо. ${warning}`, false), false);
  assert.deepEqual(parseArguments(['start', '--confirm', '--role', 'manual']).options, { '--confirm': true, '--role': 'manual' });
  assert.throws(() => parseArguments(['start', '--role']), /option_value_required/);
  assert.throws(() => parseArguments(['start', '--role', 'first']), /login_role_invalid/);
  assert.throws(() => parseArguments(['choose-role', '--ref', 'role:1:1']), /explicit_role_choice_required/);
  assert.equal(parseArguments(['choose-role', '--ref', 'role:1:1', '--confirm']).command, 'choose-role');
  assert.throws(() => parseArguments(['choose-role', '--ref', '1:1', '--confirm']), /explicit_role_choice_required/);
});
test('role-bound reuse preserves credentials but never inherits unknown or organisation cookies', () => {
  const storage = { cookies: [{ value: 'synthetic-role-cookie' }], origins: [] };
  const key = crypto.randomBytes(32), record = { schema: 1, credentials: synthetic, storage, storageRole: 'personal' };
  const encrypted = encryptRecord(key, identity, record);
  assert.ok(!encrypted.includes('personal'));
  const restored = decryptRecord(key, identity, encrypted);
  assert.deepEqual(reusableRoleStorage(restored), storage);
  assert.equal(reusableRoleStorage(restored, 'manual'), null);
  for (const changed of [{ storageRole: undefined }, { storageRole: 'other' }, { storage: null }])
    assert.equal(reusableRoleStorage({ ...restored, ...changed }), null);
  assert.deepEqual(restored.credentials, synthetic);
});

function personalRoleFixture({ count = 1, href = null, url = 'https://esia.gosuslugi.ru/roles',
  tag = 'button', length = 80, enabled = true, clickError = null, changeOnPermit = false } = {}) {
  let clicks = 0, permits = 0;
  const field = { count: async () => 0 };
  const current = { text: 'Войти как частное лицо', login: field, password: field, code: field, challenge: 'manual' };
  const target = { filter() { return this; }, count: async () => count, isEnabled: async () => enabled,
    evaluate: async () => ({ tag, length }), getAttribute: async () => href,
    click: async () => { clicks++; if (clickError) throw clickError; } };
  const portal = { roleChoiceClicked: false, selectedRoleKind: null, page: { url: () => url, getByText: () => target },
    permit: async () => { permits++; if (changeOnPermit) url = 'https://esia.gosuslugi.ru/changed'; },
    inspectAuth: async () => current };
  return { portal, current, result: () => ({ clicks, permits }) };
}
test('default identity click requires one bounded personal card, fresh origin and a one-shot guard', async () => {
  const good = personalRoleFixture();
  assert.equal(await choosePersonalRole(good.portal, good.current), true);
  assert.equal(good.portal.selectedRoleKind, 'personal');
  assert.equal(await choosePersonalRole(good.portal, good.current), false);
  assert.equal(good.result().clicks, 1);
  for (const options of [{ count: 0 }, { count: 2 }, { enabled: false }, { tag: 'body' }, { tag: 'h1' },
    { length: 241 }, { href: 'https://evil.example/' }, { url: 'https://esia.gosuslugi.ru.evil.example/' }, { changeOnPermit: true }]) {
    const fixture = personalRoleFixture(options);
    assert.equal(await choosePersonalRole(fixture.portal, fixture.current), false);
    assert.equal(fixture.result().clicks, 0);
  }
  const uncertain = personalRoleFixture({ clickError: Error('synthetic_navigation_timeout') });
  await assert.rejects(choosePersonalRole(uncertain.portal, uncertain.current), /synthetic_navigation_timeout/);
  assert.equal(await choosePersonalRole(uncertain.portal, uncertain.current), false);
  assert.equal(uncertain.result().clicks, 1);
});
test('official origins are parsed, not substring-matched; foreign state rejected', () => {
  for (const url of ['https://esia.gosuslugi.ru.evil.example/login', 'http://esia.gosuslugi.ru/', 'https://user@esia.gosuslugi.ru/', 'https://esia.gosuslugi.ru:8443/']) {
    assert.equal(officialUrl(url), false);
  }
  assert.equal(authOrigin('https://esia.gosuslugi.ru.evil.example'), false);
  assert.equal(authOrigin('https://esia.gosuslugi.ru/login/'), true);
  assert.throws(() => validatedStorage({ cookies: [{ domain: 'evil.example' }], origins: [] }));
  assert.throws(() => validatedStorage({ cookies: [], origins: [{ origin: 'http://gosuslugi.ru' }] }));
});
test('host identity required; headless, secret arguments and extend options do not exist', () => {
  assert.throws(() => identityFromEnv({}));
  for (const option of ['--headless', '--password', '--totp', '--phone', '--ttl', '--extend', '--terminal-prompts'])
    assert.throws(() => parseArguments(['start', option, 'anything']));
  assert.equal(LEASE_MS, 1800000);
  assert.throws(() => parseArguments(['configure']));
  assert.equal(parseArguments(['configure', '--confirm']).command, 'configure');
  assert.equal(parseArguments(['start', '--confirm', '--request-title', 'Проверить ГАС']).options['--request-title'], 'Проверить ГАС');
  assert.deepEqual(JSON.parse(nativeRequestTitleInput('Проверить ГАС')), { schema: 1, requestTitle: 'Проверить ГАС' });
  for (const title of ['', ' пробел', 'строка\nниже', 'x'.repeat(161)]) {
    assert.throws(() => nativeRequestTitleInput(title), /request_title_invalid/);
  }
  assert.deepEqual(childEnvironment({ PATH: '/safe', DEBUG: '*', NODE_OPTIONS: '--inspect', PASSWORD: 'fake' }), { PATH: '/safe' });
});
test('current runtime preserves the trusted legacy macOS helper and freezes the title-aware key helper', async () => {
  // macOS binds a Keychain item's trusted-application ACL to the compiled
  // helper. Even an explanatory UI-only source change creates another binary
  // and can force a login-keychain password dialog. Keep this JS-only release
  // on the already trusted native implementation and make any future native
  // change an explicit, reviewed compatibility decision.
  const expected = new Map([
    ['native-macos.swift', 'ceb28ce7591daae3b32e0b09e8b70347f08f12a72482834db83c87464c58ea74'],
    // Updated only when an explicit Keychain migration with live acceptance is
    // designed. Ordinary runtime changes must never alter this identity.
    ['native-key-macos.swift', 'bfcca533656a827095b05b53c16649f73aa785caf075a5af9b1b37c5ae5f5285'],
  ]);
  for (const [name, digest] of expected) {
    // Git may materialize text files with CRLF in the persistent Windows
    // runner. The compatibility identity belongs to the canonical repository
    // source, so hash normalized UTF-8 bytes rather than a checkout policy.
    const source = (await fs.readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8'))
      .replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), digest, name);
  }
});
test('portal CDN permits static resources without admitting navigation, credentials, APIs or sibling hosts', () => {
  const asset = { url: 'https://gu-st.ru/htdocs/js/angular.min.js', navigation: false, method: 'GET', resourceType: 'script' };
  for (const method of ['GET', 'HEAD']) {
    for (const resourceType of ['script', 'stylesheet', 'image', 'font'])
      assert.equal(providerRequestAllowed({ ...asset, method, resourceType }), true);
  }
  for (const changed of [
    { navigation: true }, { navigation: undefined }, { method: 'POST' }, { method: 'PUT' },
    { resourceType: 'document' }, { resourceType: 'xhr' }, { resourceType: 'fetch' },
    { resourceType: 'ping' }, { resourceType: 'other' }, { resourceType: 'websocket' },
    { url: 'http://gu-st.ru/htdocs/js/angular.min.js' },
    { url: 'https://gu-st.ru.evil.example/htdocs/js/angular.min.js' },
    { url: 'https://cdn.gu-st.ru/htdocs/js/angular.min.js' },
    { url: 'https://user@gu-st.ru/htdocs/js/angular.min.js' },
    { url: 'https://gu-st.ru:8443/htdocs/js/angular.min.js' }, { url: 'not a URL' },
    { url: 'https://stat.sputnik.ru/cnt.js' }, { url: 'https://mc.yandex.ru/metrika/tag.js' },
  ]) assert.equal(providerRequestAllowed({ ...asset, ...changed }), false, JSON.stringify(changed));
  assert.equal(officialUrl(asset.url), false);
  assert.equal(authOrigin(asset.url), false);
  assert.throws(() => validatedStorage({ cookies: [{ domain: '.gu-st.ru' }], origins: [] }), /storage_state_origin_rejected/);
  assert.throws(() => validatedStorage({ cookies: [], origins: [{ origin: 'https://gu-st.ru' }] }), /storage_state_origin_rejected/);
  assert.equal(providerRequestAllowed({ url: 'https://esia.gosuslugi.ru/login', navigation: true, method: 'POST', resourceType: 'document' }), true);
});
test('CDN XHR exceptions cover application translations but never general API or navigation access', () => {
  const asset = { url: 'https://gu-st.ru/htdocs/tpl/directives/catalog-on-main-315a6ed8d9.html', navigation: false, method: 'GET', resourceType: 'xhr' };
  for (const url of [asset.url, 'https://gu-st.ru/htdocs/tpl/index/index-71c7d90d28.html',
    'https://gu-st.ru/htdocs/tpl/error-6622e02a3e.html', 'https://gu-st.ru/widget-minimax/config.json',
    'https://gu-st.ru/portal-st/assets/i18n/ru.3.510.2-0-standalone.json',
    'https://gu-st.ru/portal-st/lib-assets/i18n/ru.3.510.2-0-standalone.json',
    'https://gu-st.ru/fssp-st/assets/i18n/ru.3.508.2.json',
    'https://gu-st.ru/fssp-st/assets/i18n/fssp/ru.3.508.2.json',
    'https://gu-st.ru/fssp-st/lib-assets/i18n/ru.3.508.2.json',
    'https://gu-st.ru/sf-portal-st/assets/i18n/ru.3.510.10-0-fs.json',
    'https://gu-st.ru/sf-portal-st/lib-assets/i18n/ru.3.508.2-3-standalone.json',
    'https://gu-st.ru/another-form-st/assets/i18n/ru.1.json']) {
    for (const resourceType of ['xhr', 'fetch']) assert.equal(providerRequestAllowed({ ...asset, url, resourceType }), true);
    for (const changed of [{ navigation: true }, { method: 'POST' }, { resourceType: 'document' }])
      assert.equal(providerRequestAllowed({ ...asset, url, ...changed }), false);
  }
  for (const url of ['https://gu-st.ru/api/profile', 'https://gu-st.ru/api/profile.json',
    'https://gu-st.ru/htdocs/tpl/../../../api/profile.html', 'https://gu-st.ru/htdocs/tpl/%2e%2e/api.html',
    'https://gu-st.ru/htdocs/tpl/directives/main.html?private=value',
    'https://gu-st.ru/htdocs/tpl/directives/main.html#fragment',
    'https://gu-st.ru/widget-minimax/other.json', 'https://gu-st.ru/widget-minimax/config.json?private=value',
    'https://gu-st.ru/portal-st/assets/api/profile.json', 'https://gu-st.ru/portal-st/assets/i18n/ru.1.json?private=value',
    'https://gu-st.ru/fssp-st/assets/api/profile.json', 'https://gu-st.ru/fssp-st/assets/i18n/ru.3.508.2.json?private=value',
    'https://gu-st.ru/fssp-st/assets/i18n/ru.3.508.2.json#fragment',
    'https://gu-st.ru/fssp-st/assets/i18n/other/deep/ru.3.508.2.json',
    'https://gu-st.ru/fssp-st/lib-assets/i18n/fssp/ru.3.508.2.json',
    'https://gu-st.ru/fssp-st/assets/i18n/fssp/ru.3.508.2.json?private=value',
    'https://gu-st.ru/sf-portal-st/assets/api/account.json',
    'https://gu-st.ru/sf-portal-st/assets/i18n/ru.3.510.10-0-fs.json?case=123'])
    assert.equal(providerRequestAllowed({ ...asset, url }), false, url);
  assert.equal(providerRequestAllowed({ ...asset, url: 'https://gu-st.ru/htdocs/img/favicon-3da0450d5e.ico', resourceType: 'other' }), true);
  assert.equal(providerRequestAllowed({ ...asset, url: 'https://gu-st.ru/portal-st/favicon.svg', resourceType: 'other' }), true);
  assert.equal(providerRequestAllowed({ ...asset, url: 'https://gu-st.ru/arbitrary.ico', resourceType: 'other' }), false);
});
test('headed launch registers exact browser ownership before connection and never exposes endpoint', async () => {
  const calls = []; const server = { process: () => ({ pid: 12345 }), wsEndpoint: () => 'private-endpoint', kill: async () => { calls.push('kill'); } };
  const browser = { newBrowserCDPSession: async () => ({}), newContext: async () => ({}) };
  const playwright = { chromium: {
    launchServer: async options => { calls.push('launch'); assert.equal(options.headless, false); return server; },
    connect: async endpoint => { calls.push('connect'); assert.equal(endpoint, 'private-endpoint'); return browser; },
  } };
  const owned = await launchOwnedBrowser({ playwright, permit: async (op, extra) => { calls.push('own'); assert.equal(op, 'own'); assert.equal(extra.pid, 12345); } });
  assert.equal(owned.browser, browser); assert.deepEqual(calls, ['launch', 'own', 'connect']);
  calls.length = 0;
  await assert.rejects(launchOwnedBrowser({ playwright, permit: async () => { throw Error('denied'); } }));
  assert.deepEqual(calls, ['launch', 'kill']);
});

function publicEntryFixture({ url = 'https://www.gosuslugi.ru/404', count = 1, href = null, clickError = null } = {}) {
  let clicks = 0, permits = 0, persisted = 0;
  const control = { or() { return this; }, filter() { return this; }, count: async () => count,
    getAttribute: async () => href, click: async () => { clicks++; if (clickError) throw clickError; } };
  const portal = new Portal(null, async () => { permits++; }, { onPhase: () => {}, persist: async () => { persisted++; } });
  portal.page = { url: () => url, getByRole: () => control, waitForTimeout: async () => { throw Error('synthetic_loop_stopped'); } };
  return { portal, result: () => ({ clicks, permits, persisted }) };
}
test('public sign-in requires one exact control, a portal shell and an official target', async () => {
  for (const url of ['https://www.gosuslugi.ru/', 'https://gosuslugi.ru/404', 'https://www.gosuslugi.ru/404/']) {
    const { portal, result } = publicEntryFixture({ url });
    assert.equal(await portal.enterLogin(), true);
    assert.equal(await portal.enterLogin(), false);
    assert.deepEqual(result(), { clicks: 1, permits: 2, persisted: 0 });
  }
  for (const options of [{ url: 'https://gu-st.ru/' }, { url: 'https://www.gosuslugi.ru.evil.example/' },
    { url: 'http://www.gosuslugi.ru/' }, { url: 'https://www.gosuslugi.ru:8443/' },
    { url: 'https://esia.gosuslugi.ru/' }, { url: 'https://www.gosuslugi.ru/payment' },
    { count: 2 }, { href: 'https://evil.example/login' }, { href: 'javascript:void(0)' }]) {
    const { portal, result } = publicEntryFixture(options);
    await assert.rejects(portal.enterLogin(), /login_entry_/); assert.equal(result().clicks, 0);
  }
  const absent = publicEntryFixture({ count: 0 });
  assert.equal(await absent.portal.enterLogin(), false); assert.equal(absent.result().clicks, 0);
});
test('ambiguous public sign-in dispatch is never clicked again on resume', async () => {
  const { portal, result } = publicEntryFixture({ clickError: Error('synthetic_navigation_timeout') });
  await assert.rejects(portal.enterLogin(), /synthetic_navigation_timeout/);
  assert.equal(await portal.enterLogin(), false); assert.equal(result().clicks, 1);
});
test('an unclassified timeout requests model review instead of inventing a human step', async () => {
  const phases = [];
  const portal = new Portal(null, async () => {}, { onPhase: phase => phases.push(phase), persist: async () => {} });
  const originalNow = Date.now;
  let clock = 0;
  // Advance beyond the bounded recognition window before its first iteration;
  // the production path then takes no browser action and keeps focus intact.
  Date.now = () => (clock += 100_000);
  try {
    assert.equal(await portal.authenticate(synthetic), false);
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(phases, ['authenticating', 'review_required']);
  assert.equal(portal.roleChoiceRequired, false);
});
test('a stable unknown public page is handed to the model without the auth timeout', async () => {
  const phases = [];
  const empty = { or() { return this; }, filter() { return this; }, count: async () => 0 };
  const portal = new Portal(null, async () => {}, { onPhase: phase => phases.push(phase), persist: async () => {} });
  let clock = 0, waits = 0;
  portal.page = {
    url: () => 'https://elections.gosuslugi.ru/seasonal-page',
    getByRole: () => empty,
    locator: () => empty,
    waitForTimeout: async milliseconds => { waits++; clock += milliseconds; },
  };
  portal.inspectAuth = async () => ({ text: 'Новая промежуточная страница', login: empty,
    password: empty, code: empty, challenge: null });
  const originalNow = Date.now;
  Date.now = () => clock;
  try {
    assert.equal(await portal.authenticate(synthetic), false);
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(phases, ['authenticating', 'review_required']);
  assert.ok(waits <= 3, `model review waited ${waits} polling intervals`);
  assert.deepEqual(portal.reviewContext(), { pageKind: 'official_public', origin: 'https://elections.gosuslugi.ru' });
});
test('model review context exposes only a safe origin classification', () => {
  const portal = new Portal(null, async () => {}, { onPhase: () => {}, persist: async () => {} });
  for (const [url, expected] of [
    ['https://www.gosuslugi.ru/private/path?code=secret#fragment', { pageKind: 'official_public', origin: 'https://www.gosuslugi.ru' }],
    ['https://esia.gosuslugi.ru/aas/oauth2/ac?state=secret', { pageKind: 'official_auth', origin: 'https://esia.gosuslugi.ru' }],
    ['https://example.org/callback?code=secret', { pageKind: 'external_https', origin: 'https://example.org' }],
    ['chrome-error://chromewebdata/', { pageKind: 'browser_internal', origin: null }],
  ]) {
    portal.page = { url: () => url };
    assert.deepEqual(portal.reviewContext(), expected);
    assert.doesNotMatch(JSON.stringify(portal.reviewContext()), /secret|private|callback|oauth2/);
  }
});
test('rendered 404 with account words in its footer cannot persist an authenticated session', async () => {
  for (const url of ['https://www.gosuslugi.ru/404', 'https://www.gosuslugi.ru/']) {
    const { portal, result } = publicEntryFixture({ url, count: 0 });
    const empty = { count: async () => 0 };
    portal.inspectAuth = async () => ({ text: 'Похоже, ничего не нашлось. Мои документы',
      login: empty, password: empty, code: empty });
    portal.storage = async () => ({ cookies: [], origins: [] });
    await assert.rejects(portal.authenticate(synthetic), /synthetic_loop_stopped/);
    assert.equal(result().persisted, 0); assert.equal(result().clicks, 0);
  }
});
test('the actual authorised header or one explicit logout proves login; footer wording does not', async () => {
  for (const [menuCount, logoutCount, enabled, expected] of [[1, 0, true, true], [0, 1, true, true],
    [0, 0, true, false], [2, 0, true, false], [0, 2, true, false], [1, 0, false, false]]) {
    const locator = count => ({ filter() { return this; }, or() { return this; }, count: async () => count, isEnabled: async () => enabled });
    const page = { locator: selector => {
      assert.equal(selector, 'lib-header-auth button.authorized-user[aria-label="Меню пользователя"]'); return locator(menuCount);
    }, getByRole: (_role, options) => { assert.equal(options.name, 'Выйти'); assert.equal(options.exact, true); return locator(logoutCount); } };
    assert.equal(await authenticatedPortalHeader(page), expected);
  }
});
test('live diagnostic evidence is a fixed boolean vocabulary, never copied auth text', () => {
  const evidence = authEvidence('Вход по QR-коду. Биометрия. synthetic-private-value-123. Похоже, ничего не нашлось');
  assert.deepEqual(evidence, { qrSignIn: true, captcha: false, recovery: false, roleChoice: false,
    biometricOrPush: true, loginRejected: false, notFound: true });
  assert.ok(Object.values(evidence).every(value => typeof value === 'boolean'));
  assert.ok(!JSON.stringify(evidence).includes('synthetic-private-value-123'));
});

function codePortal(fields, { autoSubmit = false } = {}) {
  let typed = [], submissions = 0, requestListener, waits = 0;
  const portal = new Portal({}, async () => {}, { onPhase: () => {}, persist: () => assert.fail('fixture must stop before ready'),
    askCode: async () => '654321' });
  const button = { filter() { return this; }, count: async () => 1, isEnabled: async () => true };
  const code = { count: async () => fields.length, evaluateAll: async () => fields, nth: index => ({ index }) };
  portal.page = { url: () => 'https://esia.gosuslugi.ru/login/', getByRole: () => button,
    waitForTimeout: async () => { if (++waits > 1) throw Error('synthetic_loop_stopped'); } };
  portal.context = { on: (_event, listener) => { requestListener = listener; }, off: () => { requestListener = null; } };
  portal.inspectAuth = async () => ({ text: 'Введите код из SMS', challenge: 'user_code', code });
  portal.typeSecret = async (target, digit) => {
    typed.push({ index: target.index, digit });
    if (autoSubmit && typed.length === fields.length) requestListener({ url: () => 'https://esia.gosuslugi.ru/login/',
      isNavigationRequest: () => false, method: () => 'POST' });
  };
  portal.authSubmit = async () => { submissions++; };
  return { portal, result: () => ({ typed, submissions }) };
}
const controlledCodeFields = () => Array.from({ length: 6 }, () => ({ maxLength: null, type: 'tel', inputMode: '',
  autocomplete: 'one-time-code', disabled: false, readOnly: false }));
test('both reviewed six-digit layouts type one digit per input and never duplicate auto-submit', async () => {
  for (const autoSubmit of [false, true]) for (const native of [false, true]) {
    const fields = controlledCodeFields().map(input => ({ ...input, maxLength: native ? '1' : null }));
    const { portal, result } = codePortal(fields, { autoSubmit });
    await assert.rejects(portal.authenticate(synthetic), /synthetic_loop_stopped/);
    assert.deepEqual(result().typed, [...'654321'].map((digit, index) => ({ index, digit })));
    assert.equal(result().submissions, autoSubmit ? 0 : 1); assert.equal(portal.codeSent, true);
    await assert.rejects(portal.authenticate(synthetic), /synthetic_loop_stopped/);
    assert.equal(result().typed.length, 6, 'resume cannot send another code');
  }
});
test('unknown segmented code layouts fail before any digit or submission guard is consumed', async () => {
  for (const change of [{ maxLength: '6' }, { type: 'text' }, { inputMode: 'numeric' },
    { autocomplete: '' }, { disabled: true }, { readOnly: true }]) {
    const fields = controlledCodeFields(); Object.assign(fields[2], change);
    const { portal, result } = codePortal(fields);
    await assert.rejects(portal.authenticate(synthetic), /auth_segmented_code_ambiguous/);
    assert.equal(result().typed.length, 0); assert.equal(portal.codeSent, false);
  }
});

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url), data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(parsed, { method, headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    }); req.on('error', reject); req.end(data);
  });
}
const navigation = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const sameOrigin = { 'Sec-Fetch-Site': 'same-origin' };
test('one loaded local page handles credentials then OTP; state and response are value-free', async t => {
  let url, openings = 0;
  const prompt = await createPrompt({ open: async value => { url = value; openings++; const page = await request(url, { headers: navigation }); assert.equal(page.status, 200); } });
  t.after(() => prompt.close());
  const submit = async (revision, values) => request(`${url}/submit`, { method: 'POST', headers: { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: { revision, action: 'submit', values } });
  const a = prompt.ask('credentials'); let state = await request(`${url}/state`, { headers: sameOrigin });
  assert.equal(JSON.parse(state.text).stage, 'credentials');
  let response = await submit(JSON.parse(state.text).revision, synthetic); assert.equal(response.status, 200);
  assert.deepEqual(await a, synthetic);
  assert.equal((await submit(JSON.parse(state.text).revision, synthetic)).status, 403);
  const b = prompt.ask('code'); state = await request(`${url}/state`, { headers: sameOrigin });
  response = await submit(JSON.parse(state.text).revision, { code: '654321' }); assert.equal(response.status, 200); assert.equal(await b, '654321');
  assert.equal(openings, 1);
  assert.deepEqual(Object.keys(JSON.parse(state.text)).sort(), ['revision', 'stage']);
  for (const secret of [...Object.values(synthetic), '654321']) { assert.ok(!state.text.includes(secret)); assert.ok(!response.text.includes(secret)); }
  prompt.close(); await assert.rejects(request(url));
});
test('local page rejects missing load, foreign Host/Origin, wrong nonce, replay and oversized body', async t => {
  let url;
  const prompt = await createPrompt({ open: async value => { url = value; } }); t.after(() => prompt.close());
  const answer = prompt.ask('credentials'); answer.catch(() => {});
  const headers = { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' };
  const body = { revision: 2, action: 'submit', values: synthetic };
  assert.equal((await request(`${url}/submit`, { method: 'POST', headers, body })).status, 403);
  assert.equal((await request(url, { headers: { ...navigation, Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(url, { headers: navigation })).status, 200);
  for (const origin of ['null', 'http://attacker.example', undefined]) {
    const changed = { ...headers }; if (origin === undefined) delete changed.Origin; else changed.Origin = origin;
    assert.equal((await request(`${url}/submit`, { method: 'POST', headers: changed, body })).status, 403);
  }
  assert.equal((await request(`${url}wrong/submit`, { method: 'POST', headers, body })).status, 403);
  assert.equal((await request(`${url}/submit`, { method: 'POST', headers, body: 'x'.repeat(9000) })).status, 403);
  assert.equal((await request(url, { headers: navigation })).status, 403);
});
test('local form supports optional TOTP and explains independent enablement and browser save prompt', () => {
  const html = promptHtml('synthetic-nonce');
  assert.ok(html.includes(TOTP_HELP)); assert.equal(html.split(SAVE_WARNING).length - 1, 2);
  assert.match(html, /role="alert"/); assert.match(html, /<label for="totp">/);
  assert.doesNotMatch(html, /<input id="totp"[^>]*required/); assert.doesNotMatch(html, /https?:\/\//);
});
test('cancel, timeout and opener failure close listener and reject pending secret request', async t => {
  let url; let cancelCount = 0;
  const prompt = await createPrompt({ open: async value => { url = value; await request(url, { headers: navigation }); }, onCancel: () => cancelCount++ });
  t.after(() => prompt.close());
  const answer = prompt.ask('credentials'); const rejected = assert.rejects(answer, /user_cancelled/);
  await request(`${url}/submit`, { method: 'POST', headers: { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: { revision: 2, action: 'cancel', values: {} } });
  await rejected; await delay(10); assert.equal(cancelCount, 1); await assert.rejects(request(url));
  const timed = await createPrompt({ open: async () => {}, timeoutMs: 20 }); await assert.rejects(timed.ask('code'), /input_timeout/);
  let failedUrl; await assert.rejects(createPrompt({ open: async value => { failedUrl = value; throw Error('opener'); } }), /local_page_open_failed/);
  await assert.rejects(request(failedUrl));
});
test('command-plane client targets loopback only and rejects bad control metadata', async () => {
  assert.throws(() => requestControl({ port: 443, token: 'bad' }, {}));
});
test('private config accepts a Windows UTF-8 preamble but preserves JSON values', () => {
  for (const prefix of ['', '\uFEFF']) assert.deepEqual(guardianConfig(`${prefix}{"file":"проверка.json","value":"  unchanged  "}`),
    { file: 'проверка.json', value: '  unchanged  ' });
  assert.throws(() => guardianConfig('\uFEFF\uFEFF{}'), /guardian_config_invalid/);
});

const supported = ['darwin', 'win32'].includes(process.platform);
let nativeRoot, helper, keyHelper;
test.before(async () => {
  if (!supported) return;
  nativeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gosuslugi-native-test-'));
  helper = await nativeHelper(nativeRoot);
  keyHelper = await nativeKeyHelper(nativeRoot, helper);
});
test.after(async () => { if (nativeRoot) await fs.rm(nativeRoot, { recursive: true, force: true }); });
test('native helper compiles and reports exact implemented OS mechanism without opening login UI', { skip: !supported }, async () => {
  const result = (await runPrivate(helper, ['probe'])).toString();
  assert.match(result, process.platform === 'darwin' ? /macos-keychain-la-continuous-guard/ : /windows-dpapi-credui-job-continuous/);
  if (process.platform === 'darwin') assert.equal(path.basename(helper), 'Trelio');
  if (process.platform === 'darwin') {
    assert.notEqual(keyHelper, helper);
    assert.match((await runPrivate(keyHelper, ['probe'])).toString(), /macos-keychain-la-title-key-v2/);
    const account = crypto.createHash('sha256').update('synthetic-missing-key').digest('hex');
    assert.equal((await runPrivate(keyHelper, ['key-status', account])).toString().trim(), 'missing');
  } else assert.equal(keyHelper, helper);
});
test('native error transport preserves known categories and suppresses arbitrary diagnostics', async () => {
  // These are synthetic process outputs, never data from a live Keychain.
  // Even a known prefix must not allow an appended OS message or credential.
  for (const code of ['native_keychain_auth_failed', 'native_keychain_key_exists',
    'native_unlock_cancelled', 'native_unlock_timeout']) {
    await assert.rejects(runPrivate(process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(code + '\n')}); process.exit(2)`]),
      error => error.code === code && error.message === code);
  }
  for (const raw of ['synthetic private diagnostic', 'native_keychain_auth_failed\nsecret=synth',
    'native_unlock_cancelled: synthetic detail']) {
    await assert.rejects(runPrivate(process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(raw)}); process.exit(2)`]),
      error => error.code === 'native_operation_failed' && !error.message.includes(raw));
  }
});
test('Keychain preflight returns only readiness and a bounded safe code without owner UI', { skip: !supported }, async () => {
  const state = await keychainStatus(helper);
  if (process.platform === 'win32') { assert.deepEqual(state, { status: 'not_applicable' }); return; }
  assert.ok(['ready', 'action_required'].includes(state.status));
  if (state.status === 'ready') assert.deepEqual(state, { status: 'ready' });
  else {
    assert.deepEqual(Object.keys(state).sort(), ['error', 'status']);
    assert.match(state.error, /^native_(?:keychain_(?:auth_failed|interaction_required|unavailable|probe_failed|entitlement_missing)|operation_failed)$/);
  }
});
test('real CLI entrypoint returns value-free doctor state on the current OS', { skip: !supported }, async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/trelio-gosuslugi.mjs', import.meta.url)), 'doctor'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnvironment(),
        TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi',
        TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member,
        ...browserSessionEnvironment() } });
    let result = '', error = ''; child.stdout.on('data', data => { result += data; }); child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(result) : reject(Error(error || 'doctor failed')));
  });
  const result = JSON.parse(output); assert.equal(result.platform, process.platform); assert.equal(result.maxSessionMinutes, 30);
  assert.equal(result.storedVault, false); assert.equal(result.runtimeReady, false);
  assert.deepEqual(result.keychain, await keychainStatus(helper));
  if (result.keychain.status === 'action_required') assert.match(result.requiredAction, /login.*macOS/);
});
test('a real Keychain refusal blocks start before creating a lease or prompting again', { skip: process.platform !== 'darwin' }, async t => {
  const state = await keychainStatus(helper);
  if (state.status !== 'action_required') { t.skip('the local login Keychain is available'); return; }
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi',
    TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await assert.rejects(run(['start', '--confirm']), error => error.code === state.error);
  const directory = storageDirectory(nativeRoot, identity);
  for (const name of ['lease.json', 'control.json', 'vault.json'])
    await assert.rejects(fs.lstat(path.join(directory, name)), { code: 'ENOENT' });
});
test('Windows DPAPI roundtrip and tamper check execute on Windows, not a mocked platform', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await runPrivate(helper, ['self-test'])).toString(), /dpapi-current-user-roundtrip-tamper-request-title-ok/);
});
test('native private-directory/file checks enforce ACL/mode and reject symlinks', { skip: !supported }, async () => {
  const directory = path.join(nativeRoot, 'private'); await ensurePrivateDirectory(directory, helper);
  const file = path.join(directory, 'test.json'); await atomicWrite(file, '{"synthetic":true}', helper); await verifyPrivate(file, helper);
  await assert.rejects(createPrivateFile(file, 'must not overwrite', helper));
  assert.equal(await fs.readFile(file, 'utf8'), '{"synthetic":true}');
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o644); await assert.rejects(verifyPrivate(file, helper), /unsafe_permissions/); await fs.chmod(file, 0o600);
    const link = path.join(nativeRoot, 'link'); await fs.symlink(directory, link); await assert.rejects(ensurePrivateDirectory(link, helper));
  } else {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // The synthetic ACL fixture must also run on a fresh Restricted Windows
    // install. Scope policy to its child process; never change the OS policy.
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('acl-fixture.ps1', import.meta.url)), file];
    const before = await runPrivate(powershell, [...args, 'broaden']);
    try { await assert.rejects(verifyPrivate(file, helper), /native_acl_not_private/); }
    finally { await runPrivate(powershell, [...args, 'restore'], { input: before }); }
    await verifyPrivate(file, helper);
  }
});
test('start reuses the running exact lease; new calls cannot renew or use a previous runtime', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, guardPid: process.pid, startedAt: now, expiresAt: now + LEASE_MS };
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end(JSON.stringify({ sessionId: lease.leaseId, phase: 'ready', expiresAt: lease.expiresAt })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const leaseFile = path.join(directory, 'lease.json'); await atomicWrite(leaseFile, JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: lease.leaseId, port: server.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
  const a = await run(['start', '--confirm']), b = await run(['start', '--confirm']); assert.deepEqual(a, b); assert.equal(requests, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(leaseFile, 'utf8')), lease);
  await atomicWrite(leaseFile, JSON.stringify({ ...lease, expiresAt: now - 1 }), helper); await assert.rejects(run(['start', '--confirm']), /expired_guard_still_running/);
  await atomicWrite(leaseFile, JSON.stringify({ ...lease, runtimeVersion: '0.0.0' }), helper); await assert.rejects(run(['start', '--confirm']), /stop_previous_runtime/);
});
test('a ready normal session accepts one exact delegated authorization without replacing its lease', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
    guardPid: process.pid, startedAt: now, expiresAt: now + LEASE_MS, authorizationRequest: null };
  const browserSession = crypto.randomUUID(), requestId = crypto.randomUUID(), origin = 'https://ordinary.example.org';
  const authorization = { schema: 1, sessionId: browserSession, requestId, origin,
    company: identity.company, member: identity.member, startedAt: now, expiresAt: now + LEASE_MS,
    brokerPid: process.pid, port: 12345, token: crypto.randomBytes(32).toString('hex') };
  const handoff = browserSessionDirectory(nativeRoot, identity, browserSession);
  await ensurePrivateDirectory(handoff, helper);
  await atomicWrite(path.join(handoff, 'authorization.json'), JSON.stringify(authorization), helper);
  const packets = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    packets.push(JSON.parse(text));
    res.end(JSON.stringify({ sessionId: lease.leaseId, phase: 'authenticating', expiresAt: lease.expiresAt,
      authorization: { origin, browserSessionId: browserSession } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const leaseFile = path.join(directory, 'lease.json');
  await atomicWrite(leaseFile, JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: lease.leaseId,
    port: server.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
  const result = await run(['authorize', '--browser-session', browserSession, '--request', requestId,
    '--origin', origin, '--confirm']);
  assert.equal(result.phase, 'authenticating');
  assert.deepEqual(packets, [{ command: 'authorize', sessionId: lease.leaseId, authorization, loginRole: 'personal' }]);
  assert.deepEqual(JSON.parse(await fs.readFile(leaseFile, 'utf8')), lease, 'normal lease remains the owner');
  await atomicWrite(leaseFile, JSON.stringify({ ...lease, authorizationRequest: crypto.randomUUID() }), helper);
  await assert.rejects(run(['authorize', '--browser-session', browserSession, '--request', requestId,
    '--origin', origin, '--confirm']), /stop_existing_authorization_first/);
  assert.equal(packets.length, 1, 'another delegated lease is never replaced');
});
test('MCP-compatible page arguments deliver one private packet without stdin or changing lease', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, guardPid: process.pid, startedAt: now, expiresAt: now + LEASE_MS };
  const packets = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    packets.push(JSON.parse(text)); res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  await atomicWrite(path.join(directory, 'lease.json'), JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: lease.leaseId, port: server.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
  // The request belongs in a directory created with the native owner-only
  // contract. A generic Windows temp root may belong to Administrators; the
  // production writer correctly rejects that parent before creating the file.
  const file = path.join(directory, 'page-request.json'), packet = { action: 'fill', ref: '1:2', text: 'Синтетический текст' };
  await atomicWrite(file, JSON.stringify(packet), helper);
  assert.deepEqual(await run(['page', '--session', lease.leaseId, '--input-file', file]), { ok: true });
  assert.deepEqual(packets[0], { ...packet, command: 'page', sessionId: lease.leaseId });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).text, packet.text, 'caller owns cleanup');
  const target = 'https://pos.gosuslugi.ru/form/?opaId=223643&fz59=false';
  await run(['page', '--session', lease.leaseId, '--navigate', target]);
  await run(['page', '--session', lease.leaseId, '--click', '1:3']);
  assert.equal(packets[1].url, target); assert.equal(packets[2].ref, '1:3');
  await assert.rejects(run(['start', '--service', 'gas-pravosudie']), /unsupported_option/);
  assert.equal(packets.length, 3, 'different service must fail before existing control or OS unlock');
  await atomicWrite(file, '{"credentials":{"password":"synthetic"}}', helper);
  await assert.rejects(run(['page', '--session', lease.leaseId, '--input-file', file]), /page_input_invalid/);
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o644);
    await assert.rejects(run(['page', '--session', lease.leaseId, '--input-file', file]), /unsafe_permissions/);
  }
  assert.equal(packets.length, 3, 'invalid/private input is rejected before dispatch');
});
test('status and stop report a dead supervisor as closed without calling its stale control port', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity);
  await ensurePrivateDirectory(directory, helper);
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise(resolve => exited.once('exit', resolve));
  const now = Date.now(), lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, guardPid: exited.pid, startedAt: now, expiresAt: now + LEASE_MS };
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  await atomicWrite(path.join(directory, 'lease.json'), JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: lease.leaseId, port: server.address().port,
    token: crypto.randomBytes(32).toString('hex') }), helper);
  await atomicWrite(path.join(directory, 'status.json'), JSON.stringify({ sessionId: lease.leaseId,
    phase: 'user_required', expiresAt: lease.expiresAt }), helper);
  for (const command of ['status', 'stop']) {
    assert.deepEqual(await run([command, '--session', lease.leaseId]), {
      sessionId: lease.leaseId, phase: 'closed', expiresAt: lease.expiresAt, requiredAction: null,
    });
    await assert.rejects(run([command, '--session', crypto.randomUUID()]), /exact_session_required/);
  }
  // A dead guardian must not hide the next human step or trust a recovery link
  // from disk. The closed receipt retains the gate but never contacts that port.
  await atomicWrite(path.join(directory, 'status.json'), JSON.stringify({ sessionId: lease.leaseId,
    phase: 'authorization_failed', credentialGate: { reason: 'account_temporarily_blocked', retryAt: null },
    accountRecovery: { url: 'https://untrusted.example.org/?code=synthetic-private-code' } }), helper);
  const blocked = await run(['status', '--session', lease.leaseId]);
  assert.equal(blocked.phase, 'closed');
  assert.equal(blocked.accountRecovery.url, 'https://www.gosuslugi.ru/679557/1/form');
  assert.equal(blocked.accountRecovery.requiresUserAction, true);
  assert.doesNotMatch(JSON.stringify(blocked), /untrusted|synthetic-private-code/);
  assert.equal(requests, 0, 'the old port may already belong to another process');
});
test('orphaned receipts use current closed projection after normal cleanup and runtime upgrade', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), sessionId = crypto.randomUUID();
  const lease = { leaseId: sessionId, runtimeVersion: '3.3.15', guardPid: process.pid, startedAt: now, expiresAt: now + LEASE_MS };
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const receipt = { sessionId, phase: 'user_required', expiresAt: lease.expiresAt, portalReady: true,
    credentialGate: { reason: 'account_temporarily_blocked', retryAt: null },
    accountRecovery: { url: 'https://untrusted.example.org/?code=synthetic-private-code' },
    raw: 'synthetic-private-content', requiredAction: 'synthetic-private-action' };
  // Test every partial-cleanup state. An orphaned controller is never called,
  // and a former live phase cannot advertise a surviving authorization lease.
  for (const missing of ['both', 'lease', 'control']) {
    await fs.rm(path.join(directory, 'lease.json'), { force: true });
    await fs.rm(path.join(directory, 'control.json'), { force: true });
    if (missing === 'control') await atomicWrite(path.join(directory, 'lease.json'), JSON.stringify(lease), helper);
    if (missing === 'lease') await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: sessionId,
      port: server.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
    await atomicWrite(path.join(directory, 'status.json'), JSON.stringify(receipt), helper);
    const result = await run(['status', '--session', sessionId]);
    assert.equal(result.phase, 'closed'); assert.equal(result.sessionId, sessionId);
    assert.equal(result.expiresAt, lease.expiresAt); assert.equal(result.requiredAction, null);
    assert.deepEqual(result.credentialGate, receipt.credentialGate);
    assert.equal(result.accountRecovery.url, 'https://www.gosuslugi.ru/679557/1/form');
    assert.doesNotMatch(JSON.stringify(result), /untrusted|synthetic-private|portalReady/);
    await assert.rejects(run(['status', '--session', crypto.randomUUID()]), /no_active_session/);
  }
  assert.equal(requests, 0);
});
test('a submitted local form returns configured through wait after cleanup, without chat acknowledgement', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 'gosuslugi',
    TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), sessionId = crypto.randomUUID();
  const lease = { leaseId: sessionId, runtimeVersion: RUNTIME_VERSION, guardPid: process.pid,
    startedAt: now, expiresAt: now + LEASE_MS };
  let phase = 'credentials_required', packets = [];
  const control = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => {
      packets.push(JSON.parse(text)); res.end(JSON.stringify({ sessionId, phase, expiresAt: lease.expiresAt }));
    });
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  t.after(() => { control.closeAllConnections(); control.close(); });
  await atomicWrite(path.join(directory, 'lease.json'), JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: sessionId,
    port: control.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
  let url;
  const prompt = await createPrompt({ open: async value => { url = value; await request(url, { headers: navigation }); } });
  t.after(() => prompt.close());
  const persisted = prompt.ask('credentials').then(async values => {
    assert.deepEqual(values, synthetic);
    // Exercise the worker's durable ordering with synthetic encrypted storage:
    // saving succeeds, the receipt is written, then disposable controls disappear. No chat signal participates.
    const key = crypto.randomBytes(32);
    const vault = path.join(directory, 'vault.json');
    await atomicWrite(vault, encryptRecord(key, identity, { credentials: values }), helper);
    assert.deepEqual(decryptRecord(key, identity, await fs.readFile(vault, 'utf8')), { credentials: synthetic });
    phase = 'configured';
    await atomicWrite(path.join(directory, 'status.json'), JSON.stringify({ sessionId, phase,
      expiresAt: lease.expiresAt, raw: 'synthetic-private-content' }), helper);
    await fs.rm(path.join(directory, 'lease.json')); await fs.rm(path.join(directory, 'control.json'));
    prompt.close();
  });
  const waiting = run(['wait', '--session', sessionId, '--after-phase', 'credentials_required', '--timeout-seconds', '5']);
  const state = JSON.parse((await request(`${url}/state`, { headers: sameOrigin })).text);
  await request(`${url}/submit`, { method: 'POST', headers: { ...sameOrigin, Origin: new URL(url).origin,
    'Content-Type': 'application/json' }, body: { revision: state.revision, action: 'submit', values: synthetic } });
  await persisted;
  const result = await waiting;
  assert.equal(result.phase, 'configured'); assert.equal(result.sessionId, sessionId);
  assert.equal(result.expiresAt, lease.expiresAt); assert.equal(result.continuation, undefined);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|password|totp/);
  assert.ok(packets.every(packet => packet.command === 'status'), 'wait never submits, resumes or restarts login');
});
test('runtime version is tied to the immutable package manifest', async () => {
  const release = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));
  assert.equal(release.runtime.version, RUNTIME_VERSION); assert.equal(release.runtime.minimumHostVersion, '3.7.1');
  assert.equal(release.release.version, '4.5.3');
  assert.deepEqual(release.runtime.browserSession, {
    apiVersion: 1,
    sessionClass: 'protected-snapshot',
    leaseMs: 1_800_000,
    manualAssist: false,
  });
});
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'darwin') return !execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
    return true;
  } catch { return false; }
}
async function waitUntil(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw Error('synthetic process did not reach expected state');
}
// The lease deliberately includes process startup, as it does in production.
// The 1-vCPU Windows runner can need more than ten seconds for cold .NET + Node
// startup, so keep a test-only margin without weakening the immutable 30-minute
// production cap or the assertion that startup cannot renew the original lease.
const guardianTestLeaseMs = 15000;
const guardianCandidateLeaseMs = 30000;
const guardianStartupWaitMs = 20000;
for (const mode of ['hang', 'crash', 'guard-crash', 'elapsed-lease']) test(`native guardian reaps only its own process tree: ${mode}`, { skip: !supported, timeout: 45000 }, async t => {
  // Non-ASCII config exercises the actual Windows redirected UTF-8 protocol.
  const file = path.join(nativeRoot, `проверка-${mode}.json`);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => sentinel.kill());
  const began = performance.now();
  const child = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('guardian-worker.mjs', import.meta.url)),
    String(mode === 'elapsed-lease' ? guardianCandidateLeaseMs : guardianTestLeaseMs)], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(0, 512); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const expiresAt = Date.now() + guardianTestLeaseMs;
  child.stdin.end(`${JSON.stringify({ file, mode: mode === 'elapsed-lease' ? 'hang' : mode,
    slowStart: mode === 'hang',
    ...(mode === 'elapsed-lease' ? { expiresAt, startedAt: expiresAt - LEASE_MS } : {}) })}\n`);
  try { await waitUntil(async () => { try { await fs.access(file); return true; } catch { return false; } }, guardianStartupWaitMs); }
  catch { throw Error(`synthetic worker did not initialize; native code: ${/^[a-z_0-9\s]*$/.test(diagnostic) ? diagnostic.trim() : 'withheld'}`); }
  const pids = JSON.parse(await fs.readFile(file, 'utf8'));
  // A failing test must not itself leave its synthetic CPU-hung process alive.
  t.after(() => { for (const pid of [pids.worker, pids.child]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  if (mode === 'guard-crash') child.kill('SIGKILL');
  await exited;
  if (['hang', 'elapsed-lease'].includes(mode)) assert.ok(performance.now() - began < guardianTestLeaseMs * 2,
    'independent cleanup must respect the original lease, not renew it on startup');
  await waitUntil(() => !alive(pids.worker) && !alive(pids.child));
  assert.equal(alive(sentinel.pid), true, 'unrelated process was not terminated');
});
test('native guardian refuses a lease exceeding 30 minutes before spawning a worker', { skip: !supported }, async () => {
  await assert.rejects(runPrivate(helper, ['guard', process.execPath, fileURLToPath(new URL('guardian-worker.mjs', import.meta.url)), String(LEASE_MS + 1)], { input: '{}\n' }));
});
