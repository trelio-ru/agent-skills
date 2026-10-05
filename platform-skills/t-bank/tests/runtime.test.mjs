import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LEASE_MS, identityFromEnv, encryptRecord, decryptRecord, normalizeCredentials, normalizeTotp, totpCode,
  challengeKind, authOrigin, tIdAuthUrl, officialUrl, providerRequestAllowed, childEnvironment, guardianConfig, RUNTIME_VERSION, RuntimeError, storageDirectory } from '../scripts/core.mjs';
import { createPrompt, promptHtml, SAVE_WARNING, TOTP_HELP } from '../scripts/prompt.mjs';
import { atomicWrite, createPrivateFile, nativeHelper, nativeKeyHelper, nativeRequestTitleInput,
  runPrivate, ensurePrivateDirectory, verifyPrivate, keychainStatus } from '../scripts/native.mjs';
import { launchOwnedBrowser, validatedStorage, Portal } from '../scripts/browser.mjs';
import { parseArguments, readPagePacket, readPrivateJson, readPrivateScript, requestControl, run } from '../scripts/trelio-t-bank.mjs';
import { needsAuthorization, validatedPagePacket, workingPageUrl } from '../scripts/page-actions.mjs';
import { compileScenario, executeScenario, MAX_SCRIPT_BYTES } from '../scripts/scenario.mjs';
import { safeAuthLabels, authEvidence } from '../development/live-login-observations.mjs';
import { resolveRequestTitle } from '../scripts/chat-title.mjs';

const identity = identityFromEnv({ TRELIO_SKILL_ID: 't-bank', TRELIO_SKILL_COMPANY_ID: '11111111-1111-4111-8111-111111111111', TRELIO_SKILL_MEMBER_ID: '22222222-2222-4222-8222-222222222222' });
const synthetic = { login: '+70000000000', password: 'synthetic-not-a-real-password', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('bank unlock prompt prefers the exact Codex title over caller topic', async () => {
  const threadId = '33333333-3333-4333-8333-333333333333';
  const title = 'Тестовая беседа';
  const topic = 'Другая тема';
  assert.equal(await resolveRequestTitle(topic, {
    environment: { CODEX_THREAD_ID: threadId },
    readThreadTitle: async exactId => { assert.equal(exactId, threadId); return title; },
  }), title);
  assert.equal(await resolveRequestTitle(topic, {
    environment: { CODEX_THREAD_ID: threadId }, readThreadTitle: async () => null,
  }), topic);
  assert.equal(await resolveRequestTitle(null, {
    environment: { CODEX_THREAD_ID: threadId }, readThreadTitle: async () => null,
  }), null);
});

test('arbitrary JavaScript receives the original Playwright objects, without an action proxy', async () => {
  const context = { marker: 41 }, page = { context: () => context };
  const result = await executeScenario(compileScenario(`
    const { basename } = await import('node:path');
    context.marker++;
    console.log('synthetic-secret');
    return { same: page.context() === context, marker: context.marker,
      file: basename('/tmp/example.txt'), text: 'synthetic-secret' };
  `), { context, page }, value => value.replaceAll('synthetic-secret', '[redacted]'));
  assert.deepEqual(result, { ok: true, result: { same: true, marker: 42, file: 'example.txt', text: '[redacted]' },
    logs: ['[redacted]'], logsTruncated: false });
  assert.equal(context.marker, 42, 'the next invocation retains the same context');
  assert.equal((await executeScenario(compileScenario('return context.marker;'), { context, page })).result, 42);
});
test('scenario validation and result errors never expose script or browser error text', async () => {
  for (const source of ['', ' ', null, 'x'.repeat(MAX_SCRIPT_BYTES + 1), '\0'])
    assert.throws(() => compileScenario(source), /script_input_invalid/);
  assert.throws(() => compileScenario('return ('), /script_syntax_invalid/);
  const args = { context: {}, page: {} };
  await assert.rejects(executeScenario(compileScenario('throw Error("synthetic-private-url");'), args), error => {
    assert.equal(error.code, 'script_result_unknown'); assert.ok(!String(error).includes('synthetic-private-url')); return true;
  });
  await assert.rejects(executeScenario(compileScenario('const value = {}; value.self = value; return value;'), args), /script_result_not_json/);
  await assert.rejects(executeScenario(compileScenario('return "x".repeat(50000);'), args), /script_result_too_large/);
  const logged = await executeScenario(compileScenario('console.log("x".repeat(9000));'), args);
  assert.equal(logged.result, null); assert.equal(logged.logsTruncated, true); assert.deepEqual(logged.logs, []);
});
test('full-context script needs an exact local file, with authority kept in agent instructions', () => {
  const file = path.resolve(os.tmpdir(), 'scenario.js');
  assert.equal(parseArguments(['script', '--input-file', file]).command, 'script');
  for (const args of [['script'], ['script', '--input-file', 'relative.js'],
    ['script', '--input-file', file, '--confirm'], ['script', '--navigate', 'https://www.tbank.ru/']])
    assert.throws(() => parseArguments(args));
});

test('page authorization is explicit, typed and local to a single call', () => {
  const session = '11111111-1111-4111-8111-111111111111';
  assert.equal(parseArguments(['page', '--session', session, '--click', '1:2', '--confirm']).options['--confirm'], true);
  assert.equal(parseArguments(['page', '--session', session, '--click', '1:2']).options['--confirm'], undefined);
  for (const args of [['start', '--confirm'], ['snapshot', '--confirm'], ['page', '--input-file'],
    ['page', '--input-file', 'relative.json'], ['page', '--click', '1:2', '--navigate', 'https://www.tbank.ru/mybank/'],
    ['page', '--navigate', 'https://www.tbank.ru/mybank/?token=synthetic']]) assert.throws(() => parseArguments(args));
  for (const confirm of ['true', 1, {}, []]) assert.throws(() => validatedPagePacket({ action: 'click', ref: '1:2', confirm }), /page_input_invalid/);
  for (const packet of [{ action: 'click', ref: '1:2', script: 'bad' }, { action: 'fill', ref: '1:2', text: 4 },
    { action: 'check', ref: '1:2', checked: 'true' }, { action: 'press', ref: '1:2', key: 'Control+Enter' },
    { action: 'navigate', url: 'https://id.tbank.ru/auth/' }, { action: 'navigate', url: 'https://evil.example/' }])
    assert.throws(() => validatedPagePacket(packet));
  assert.equal(workingPageUrl('https://www.tbank.ru/cards/new/'), true);
  assert.equal(needsAuthorization({ action: 'navigate', url: 'https://www.tbank.ru/cards/new/' }), true);
  assert.equal(needsAuthorization({ action: 'navigate', url: 'https://www.tbank.ru/mybank/operations/' }), false);
  assert.equal(needsAuthorization({ action: 'navigate', url: 'https://www.tbank.ru/mybank/?action=send' }), true);
});

test('private page transport preserves Unicode and never waits indefinitely for unavailable MCP stdin', async () => {
  const stream = new PassThrough(), input = readPagePacket(stream);
  const expected = { action: 'fill', ref: '1:2', text: '  Уточните условия\nи комиссию  ', confirm: true };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end(); assert.deepEqual(await input, expected);
  const idle = new PassThrough(); await assert.rejects(readPagePacket(idle, 10), /page_input_required/);
  assert.equal(idle.destroyed, true);
  const large = new PassThrough(), failed = readPagePacket(large);
  large.end(JSON.stringify({ ...expected, text: 'я'.repeat(16384) }));
  await assert.rejects(failed, /input_too_large/);
  if (!['darwin', 'win32'].includes(process.platform)) return;
  const fixtureRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 't-bank-input-test-'));
  const file = path.join(fixtureRoot, 'private', 'input.json');
  try {
    const helper = await nativeHelper(fixtureRoot);
    // Elevated Windows runners initially give mkdtemp's directory to the
    // Administrators group. Use the same owner/SID primitive as runtime setup
    // to create a new child; never repair the existing directory's owner.
    await ensurePrivateDirectory(path.dirname(file), helper);
    await createPrivateFile(file, JSON.stringify(expected), helper);
    assert.deepEqual(validatedPagePacket(await readPrivateJson(file, helper)), expected);
    const scriptFile = path.join(path.dirname(file), 'scenario.js');
    await createPrivateFile(scriptFile, 'return await page.title();', helper);
    assert.equal(await readPrivateScript(scriptFile, helper), 'return await page.title();');
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o644);
      await assert.rejects(readPrivateJson(file, helper), /unsafe_permissions/);
    }
  } finally { await fs.rm(fixtureRoot, { recursive: true, force: true }); }
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
  assert.equal(normalizeCredentials({ ...synthetic, username: 'synthetic-login' }).username, 'synthetic-login');
  assert.equal(normalizeCredentials(synthetic).username, null);
  assert.throws(() => normalizeCredentials({ ...synthetic, username: 'x\n' }), /username_invalid/);
});
test('actual challenge decides SMS vs TOTP; a code is never preemptively requested', () => {
  assert.equal(challengeKind('Введите пароль', false), 'none');
  assert.equal(challengeKind('Введите одноразовый код из приложения-аутентификатора', true), 'totp');
  for (const text of ['Введите код из генератора одноразовых паролей',
    'Код из генератора\nодноразовых паролей', 'Откройте генератор одноразовых паролей и введите код',
    'Введите код из приложения для аутентификации', 'Введите код из приложения\nдля аутентификации']) {
    assert.equal(challengeKind(text, true), 'totp');
    assert.equal(challengeKind(text, false), 'none', 'a generator hint alone is not a code challenge');
  }
  assert.equal(challengeKind('Введите одноразовый код из приложения Т-Банка', true), 'user_code');
  assert.equal(challengeKind('Введите код из SMS', true), 'user_code');
  assert.equal(challengeKind('Введите код из SMS, в настройках доступен TOTP', true), 'user_code');
  assert.equal(challengeKind('Введите код из SMS. В настройках доступен генератор одноразовых паролей', true), 'user_code');
  assert.equal(challengeKind('Введите код из SMS. Также доступно приложение для аутентификации', true), 'user_code');
  assert.equal(challengeKind('Подтвердите вход. Код подтверждения', true), 'user_code');
  assert.equal(challengeKind('CAPTCHA, введите код', true), 'manual');
  assert.equal(challengeKind('Подтвердите платёж', false), 'manual');
  for (const text of ['Введите код для быстрого входа', 'Подтвердите новое устройство', 'Введите код для оплаты', 'Придумайте код',
    'Код из TOTP для подтверждения перевода', 'Введите код\nдля подтверждения платежа', 'Код аутентификатора для нового устройства',
    'Код из генератора одноразовых паролей для подтверждения перевода', 'Код из генератора одноразовых паролей для нового устройства',
    'Введите код из приложения для аутентификации для подтверждения платежа'])
    assert.equal(challengeKind(text, true), 'manual');
});
test('CDN exceptions permit only static resources, never navigation or credential submission', () => {
  const resource = { url: 'https://cdn.tbank.ru/app.js', navigation: false, method: 'GET', resourceType: 'script' };
  assert.equal(providerRequestAllowed(resource), true);
  for (const changed of [{ navigation: true }, { method: 'POST' }, { resourceType: 'fetch' },
    { resourceType: 'xhr' }, { url: 'https://cdn.tbank.ru.evil.example/app.js' }])
    assert.equal(providerRequestAllowed({ ...resource, ...changed }), false);
  assert.equal(providerRequestAllowed({ url: 'https://id.tbank.ru/auth/check', navigation: false, method: 'POST', resourceType: 'fetch' }), true);
});
test('the bank SSO form CDN can serve code and styles without becoming an authentication origin', () => {
  const resource = { url: 'https://sso-forms-prod.t-static.ru/login.js', navigation: false, method: 'GET', resourceType: 'script' };
  assert.equal(providerRequestAllowed(resource), true);
  assert.equal(providerRequestAllowed({ ...resource, url: 'https://sso-forms-prod.t-static.ru/login.css', resourceType: 'stylesheet' }), true);
  for (const changed of [{ navigation: true }, { method: 'POST' }, { resourceType: 'fetch' }, { resourceType: 'xhr' },
    { url: 'https://sso-forms-prod.t-static.ru.evil.example/login.js' }, { url: 'https://another.t-static.ru/login.js' }])
    assert.equal(providerRequestAllowed({ ...resource, ...changed }), false);
  assert.equal(authOrigin('https://sso-forms-prod.t-static.ru/auth/login/'), false);
  assert.throws(() => validatedStorage({ cookies: [], origins: [{ origin: 'https://sso-forms-prod.t-static.ru' }] }), /storage_state_origin_rejected/);
});
test('official origins are parsed, not substring-matched; foreign state rejected', () => {
  for (const url of ['https://id.tbank.ru.evil.example/login', 'http://id.tbank.ru/', 'https://user@id.tbank.ru/', 'https://id.tbank.ru:8443/']) {
    assert.equal(officialUrl(url), false);
  }
  assert.equal(authOrigin('https://id.tbank.ru.evil.example'), false);
  assert.equal(authOrigin('https://id.tbank.ru/auth/step'), true);
  assert.equal(authOrigin('https://www.tbank.ru/auth/login/'), true);
  assert.equal(tIdAuthUrl('https://id.tbank.ru/auth/authorize?client_id=synthetic'), true);
  assert.equal(tIdAuthUrl('https://www.tbank.ru/auth/login/'), false,
    'delegated T‑ID may not inherit the broader personal-bank auth origin');
  assert.equal(tIdAuthUrl('https://id.tbank.ru/foreign/'), false);
  assert.equal(authOrigin('https://id.tbank.ru/foreign/'), false);
  assert.equal(officialUrl('https://business.tbank.ru/'), false);
  assert.equal(officialUrl('https://cdn.tbank.ru/'), false);
  assert.throws(() => validatedStorage({ cookies: [{ domain: 'evil.example' }], origins: [] }));
  assert.throws(() => validatedStorage({ cookies: [], origins: [{ origin: 'http://www.tbank.ru' }] }));
});
test('host identity required; headless, secret arguments and extend options do not exist', () => {
  assert.throws(() => identityFromEnv({}));
  for (const option of ['--headless', '--password', '--totp', '--phone', '--ttl', '--extend', '--terminal-prompts'])
    assert.throws(() => parseArguments(['start', option, 'anything']));
  assert.equal(LEASE_MS, 1800000);
  assert.throws(() => parseArguments(['configure']));
  assert.equal(parseArguments(['configure', '--confirm', '--request-title', 'Проверить выписку']).command, 'configure');
  assert.deepEqual(childEnvironment({ PATH: '/safe', DEBUG: '*', NODE_OPTIONS: '--inspect', PASSWORD: 'fake' }), { PATH: '/safe' });
});
test('request title is bounded UI context and never a native process argument', () => {
  const title = 'Проверить выписку по счёту';
  assert.deepEqual(JSON.parse(nativeRequestTitleInput(title)), { schema: 1, requestTitle: title });
  assert.equal(nativeRequestTitleInput(null), undefined);
  for (const invalid of ['', '  ', ' leading', 'trailing ', 'line\nbreak', `bidi\u202econtrol`, 'я'.repeat(81)]) {
    assert.throws(() => nativeRequestTitleInput(invalid), /request_title_invalid/);
    assert.throws(() => parseArguments(['start', '--request-title', invalid]), /request_title_invalid/);
  }
  assert.equal(parseArguments(['start', '--request-title', title]).options['--request-title'], title);
  assert.throws(() => parseArguments(['status', '--session', crypto.randomUUID(), '--request-title', title]), /unsupported_option/);
});
test('headed launch registers exact browser ownership before connection and never exposes endpoint', async () => {
  const calls = []; const server = { process: () => ({ pid: 12345 }), wsEndpoint: () => 'private-endpoint', kill: async () => { calls.push('kill'); } };
  const browser = {};
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

// Only structural selectors and page text exist in this fixture. Reading an
// input value or attempting any automatic browser activation or input mutation fails;
// real headed tests separately exercise the provider's form events/navigation.
function manualCodePortal({ text = 'Введите код из SMS', afterWait }) {
  const state = { text, url: 'https://id.tbank.ru/auth/step', focused: 0, waits: 0, permits: 0, expired: false, saved: 0, phases: [] };
  const portal = new Portal({}, async () => {
    state.permits++;
    if (state.expired) throw new RuntimeError('session_expired');
  }, { onPhase: phase => state.phases.push(phase), persist: async () => { state.saved++; } });
  portal.page = {
    url: () => state.url,
    bringToFront: async () => { state.focused++; },
    waitForTimeout: async () => { state.waits++; afterWait(state); },
    locator: selector => selector === 'body' ? { innerText: async () => state.text } : {
      count: async () => selector.startsWith('input[autocomplete="one-time-code"]') && authOrigin(state.url) ? 1 : 0,
    },
  };
  portal.storage = async () => ({ cookies: [], origins: [] });
  return { portal, state };
}
for (const challenge of ['SMS with saved TOTP', 'TOTP without seed', 'generator without seed']) test(`manual ${challenge} waits in the bank and resumes without reading or submitting code`, async () => {
  const totp = !challenge.startsWith('SMS');
  const text = challenge.startsWith('generator') ? 'Код из генератора\nодноразовых паролей' : totp ? 'Введите код из приложения-аутентификатора TOTP' : 'Введите код из SMS';
  const { portal, state } = manualCodePortal({ text,
    afterWait: value => { if (value.waits === 3) { value.url = 'https://www.tbank.ru/mybank/'; value.text = 'Счета и операции. Выйти'; } } });
  assert.equal(await portal.authenticate({ ...synthetic, totp: totp ? null : synthetic.totp }), true);
  assert.equal(state.focused, 0); assert.equal(state.waits, 3); assert.equal(state.saved, 1);
  assert.deepEqual(state.phases, ['authenticating', 'code_required', 'authenticating', 'ready']);
  assert.ok(state.permits > state.waits, 'every passive inspection needs the unchanged native lease');
});
for (const text of ['Неверный код. Введите код из SMS', 'Подтвердите платёж. Введите код из SMS'])
  test(`manual login hands off a rejected or financial challenge without another submission: ${text}`, async () => {
    const { portal, state } = manualCodePortal({ afterWait: value => { value.text = text; } });
    assert.equal(await portal.authenticate(synthetic), false);
    assert.equal(state.focused, 0); assert.equal(state.saved, 0); assert.equal(state.phases.at(-1), 'user_required');
  });
test('manual code wait fails closed on native expiry or a changed provider origin', async () => {
  for (const failure of ['session_expired', 'unexpected_provider_origin']) {
    const { portal, state } = manualCodePortal({ afterWait: value => {
      if (failure === 'session_expired') value.expired = true;
      else value.url = 'https://attacker.example/auth/step';
    } });
    await assert.rejects(portal.authenticate(synthetic), error => error.code === failure);
    assert.equal(state.focused, 0); assert.equal(state.waits, 1); assert.equal(state.saved, 0);
    assert.ok(!state.phases.includes('ready'));
  }
});

test('live diagnostic observations contain bounded labels and fixed witnesses, never supplied values', () => {
  const labels = safeAuthLabels(['Введите код из приложения для аутентификации', 'Код 654321',
    `Пароль ${synthetic.password}`, `Логин ${synthetic.login}`, 'Баланс 999 рублей', 'Вход ' + 'x'.repeat(180)], Object.values(synthetic));
  const output = JSON.stringify(labels);
  assert.equal(labels[0], 'Введите код из приложения для аутентификации');
  for (const secret of [...Object.values(synthetic), '654321', 'Баланс']) assert.ok(!output.includes(secret));
  assert.equal(authEvidence(labels[0]).authenticationApp, true);
  assert.ok(safeAuthLabels(Array(100).fill('Введите код'), []).length <= 8);
});

test('unrecognized six-cell layouts neither type TOTP nor consume the submission guard', async () => {
  const good = Array.from({ length: 6 }, (_, index) => ({ maxLength: null, type: 'text', inputMode: index ? '' : 'numeric',
    autocomplete: index ? '' : 'one-time-code', readOnly: false, disabled: index !== 0 }));
  for (const change of [{ disabled: false }, { autocomplete: 'email' }, { type: 'password' }, { inputMode: 'decimal' }, { maxLength: '6' }]) {
    const fields = good.map(input => ({ ...input })); Object.assign(fields[2], change);
    const portal = new Portal({}, async () => {}, { onPhase: () => {}, persist: () => assert.fail('must not persist') });
    portal.page = { url: () => 'https://id.tbank.ru/auth/step', waitForTimeout: async () => {} };
    portal.context = { on: () => {}, off: () => {} };
    portal.inspectAuth = async () => ({ text: 'Введите код из приложения для аутентификации', challenge: 'totp',
      code: { count: async () => 6, evaluateAll: async () => fields } });
    portal.typeSecret = () => assert.fail('invalid structure must not receive a digit');
    await assert.rejects(portal.authenticate(synthetic), error => error.code === 'auth_segmented_code_ambiguous');
    assert.equal(portal.codesSent.has('totp'), false);
  }
});

test('optional quick PIN is declined once; mandatory or mixed security prompts remain manual', async () => {
  const offer = 'Придумайте код. Для быстрого входа в личный кабинет. Работает только в том браузере, где был установлен';
  for (const suffix of ['', '. Подтвердите новое устройство', '. CAPTCHA', '. Подтвердите платёж']) {
    let clicks = 0; const phases = [];
    const portal = new Portal({}, async () => {}, { onPhase: phase => phases.push(phase), persist: () => assert.fail('must not persist') });
    const decline = { or() { return this; }, filter() { return this; }, count: async () => 1, isEnabled: async () => true,
      click: async () => { clicks++; throw new RuntimeError('synthetic_ambiguous_click'); } };
    portal.page = { url: () => 'https://id.tbank.ru/auth/step', getByRole: () => decline };
    portal.inspectAuth = async () => ({ text: offer + suffix, challenge: 'manual',
      password: { count: async () => 0 }, username: { count: async () => 0 }, code: { count: async () => 4 } });
    if (!suffix) {
      await assert.rejects(portal.authenticate(synthetic), error => error.code === 'synthetic_ambiguous_click');
      assert.equal(await portal.authenticate(synthetic), false, 'resume must not click twice after an ambiguous result');
      assert.equal(clicks, 1);
    } else { assert.equal(await portal.authenticate(synthetic), false); assert.equal(clicks, 0); }
    assert.equal(phases.at(-1), 'user_required');
  }
});

test('account shell without logout requires both exact links into the official account area', async () => {
  for (const target of ['/mybank/loyalty/', 'https://attacker.example/mybank/loyalty/', '/auth/login/']) {
    let saved = 0;
    const portal = new Portal({}, async () => {}, { onPhase: () => {}, persist: async () => { saved++; } });
    const zero = { count: async () => 0 }, ordinaryCabinetInput = { count: async () => 1 };
    // The live cabinet currently exposes one ordinary visible input. It is a
    // broad OTP candidate only because T-ID may omit code attributes from all
    // but its first cell; on /mybank/ it is not an authentication challenge.
    portal.inspectAuth = async () => ({ text: 'Счета и операции', challenge: 'none', password: zero, username: zero,
      code: ordinaryCabinetInput });
    portal.page = { url: () => 'https://www.tbank.ru/mybank/',
      waitForTimeout: async () => { throw new RuntimeError('synthetic_ready_not_proven'); },
      getByRole: (_role, { name }) => ({ filter() { return this; }, count: async () => 1,
        getAttribute: async () => name === 'Операции' ? '/mybank/operations/' : target }) };
    portal.storage = async () => ({ cookies: [], origins: [] });
    if (target.startsWith('/mybank/')) { assert.equal(await portal.authenticate(synthetic), true); assert.equal(saved, 1); }
    else { await assert.rejects(portal.authenticate(synthetic), error => error.code === 'synthetic_ready_not_proven'); assert.equal(saved, 0); }
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
test('local setup accepts credentials, rejects OTP and keeps state and response value-free', async t => {
  let url, openings = 0;
  const prompt = await createPrompt({ open: async value => { url = value; openings++; const page = await request(url, { headers: navigation }); assert.equal(page.status, 200); } });
  t.after(() => prompt.close());
  const submit = async (revision, values) => request(`${url}/submit`, { method: 'POST', headers: { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: { revision, action: 'submit', values } });
  const a = prompt.ask('credentials'); let state = await request(`${url}/state`, { headers: sameOrigin });
  assert.equal(JSON.parse(state.text).stage, 'credentials');
  assert.equal((await submit(JSON.parse(state.text).revision, { code: '654321' })).status, 422);
  let response = await submit(JSON.parse(state.text).revision, synthetic); assert.equal(response.status, 200);
  assert.deepEqual(await a, { ...synthetic, username: null });
  assert.equal((await submit(JSON.parse(state.text).revision, synthetic)).status, 403);
  assert.throws(() => prompt.ask('code'), /input_busy/);
  state = await request(`${url}/state`, { headers: sameOrigin });
  assert.equal((await submit(JSON.parse(state.text).revision, { code: '654321' })).status, 403);
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
test('completed credential input clears its short timeout without extending the fixed setup deadline', async t => {
  let url, cancelled = 0;
  const prompt = await createPrompt({
    open: async value => { url = value; await request(url, { headers: navigation }); },
    timeoutMs: 250, deadlineMs: 2000, onCancel: () => cancelled++,
  });
  t.after(() => prompt.close());
  const answer = prompt.ask('credentials');
  const headers = { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' };
  const state = JSON.parse((await request(`${url}/state`, { headers: sameOrigin })).text);
  assert.equal((await request(`${url}/submit`, { method: 'POST', headers,
    body: { revision: state.revision, action: 'submit', values: synthetic } })).status, 200);
  await answer;
  // Model a bank redirect/manual step that outlives the completed input's
  // budget. There is no outstanding secret request to time out at this point.
  await delay(350);
  assert.equal(cancelled, 0, 'a completed local form must not close the bank browser');
  assert.equal(JSON.parse((await request(`${url}/state`, { headers: sameOrigin })).text).stage, 'waiting');
  prompt.close();
  assert.equal(cancelled, 0);

  // The per-input budget is separate from the original absolute procedure
  // deadline: a later credential request may never buy another full lease.
  let expired = 0;
  const deadline = await createPrompt({ open: async () => {}, timeoutMs: 1000,
    deadlineMs: 100, onCancel: () => expired++ });
  t.after(() => deadline.close());
  await delay(60);
  await assert.rejects(deadline.ask('credentials'), /input_timeout/);
  assert.equal(expired, 1);
});
test('local form supports optional TOTP and explains independent enablement and browser save prompt', () => {
  const html = promptHtml('synthetic-nonce');
  assert.ok(html.includes(TOTP_HELP)); assert.equal(html.split(SAVE_WARNING).length - 1, 2);
  assert.match(html, /role="alert"/); assert.match(html, /<label for="totp">/);
  assert.doesNotMatch(html, /id="code"|code-fields|values\.code|stage==='code'/);
  assert.doesNotMatch(html, /<input id="totp"[^>]*required/); assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//);
});
test('cancel, timeout and opener failure close listener and reject pending secret request', async t => {
  let url; let cancelCount = 0;
  const prompt = await createPrompt({ open: async value => { url = value; await request(url, { headers: navigation }); }, onCancel: () => cancelCount++ });
  t.after(() => prompt.close());
  const answer = prompt.ask('credentials'); const rejected = assert.rejects(answer, /user_cancelled/);
  await request(`${url}/submit`, { method: 'POST', headers: { ...sameOrigin, Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: { revision: 2, action: 'cancel', values: {} } });
  await rejected; await delay(10); assert.equal(cancelCount, 1); await assert.rejects(request(url));
  const timed = await createPrompt({ open: async () => {}, timeoutMs: 20 }); await assert.rejects(timed.ask('credentials'), /input_timeout/);
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
  nativeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 't-bank-native-test-'));
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
    const account = crypto.createHash('sha256').update('synthetic-missing-bank-key').digest('hex');
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
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/trelio-t-bank.mjs', import.meta.url)), 'doctor'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnvironment(),
        TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 't-bank',
        TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member } });
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
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 't-bank',
    TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  await assert.rejects(run(['start']), error => error.code === state.error);
  const directory = storageDirectory(nativeRoot, identity);
  for (const name of ['lease.json', 'control.json', 'vault.json'])
    await assert.rejects(fs.lstat(path.join(directory, name)), { code: 'ENOENT' });
});
test('Windows DPAPI roundtrip and tamper check execute on Windows, not a mocked platform', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await runPrivate(helper, ['self-test'])).toString(), /roundtrip-tamper-request-title-ok/);
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
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 't-bank', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const directory = storageDirectory(nativeRoot, identity); await ensurePrivateDirectory(directory, helper);
  const now = Date.now(), lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, guardPid: process.pid, startedAt: now, expiresAt: now + LEASE_MS };
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end(JSON.stringify({ sessionId: lease.leaseId, phase: 'ready', expiresAt: lease.expiresAt })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const leaseFile = path.join(directory, 'lease.json'); await atomicWrite(leaseFile, JSON.stringify(lease), helper);
  await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: lease.leaseId, port: server.address().port, token: crypto.randomBytes(32).toString('hex') }), helper);
  const a = await run(['start']), b = await run(['start']); assert.deepEqual(a, b); assert.equal(requests, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(leaseFile, 'utf8')), lease);
  await atomicWrite(leaseFile, JSON.stringify({ ...lease, expiresAt: now - 1 }), helper); await assert.rejects(run(['start']), /expired_guard_still_running/);
  await atomicWrite(leaseFile, JSON.stringify({ ...lease, runtimeVersion: '0.0.0' }), helper); await assert.rejects(run(['start']), /stop_previous_runtime/);
});
test('runtime version is tied to the immutable package manifest', async () => {
  const release = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));
  assert.equal(release.runtime.version, RUNTIME_VERSION); assert.equal(release.runtime.minimumHostVersion, '3.4.0');
  assert.equal(release.release.version, '2.3.3');
});
test('status and stop report a dead supervisor as closed without calling its stale control port', { skip: !supported }, async t => {
  const env = { TRELIO_CONFIG_HOME: nativeRoot, TRELIO_SKILL_ID: 't-bank', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member };
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
  assert.equal(requests, 0, 'the old port may already belong to another process');
});
test('bank native storage and guardian copies cannot drift from the reviewed Gosuslugi primitives', async () => {
  // Packages are deliberately self-contained: no cross-skill imports or new
  // builder path exceptions. Only branding/key namespaces differ. A security
  // fix to either copy must update the other and pass both native OS suites.
  const specialize = text => text.replaceAll('GosuslugiNative', 'TBankNative').replaceAll('gosuslugi', 't-bank')
    .replaceAll('Госуслугами', 'Т‑Банком').replaceAll('Госуслугах', 'Т‑Банке').replaceAll('Госуслуги', 'Т‑Банк').replaceAll('Госуслуг', 'Т‑Банка');
  for (const name of ['native.mjs', 'native-macos.swift', 'native-key-macos.swift',
    'native-windows.cs', 'private-directory.ps1']) {
    const source = await fs.readFile(new URL(`../../gosuslugi/scripts/${name}`, import.meta.url), 'utf8');
    assert.equal(await fs.readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8'), specialize(source), name);
  }
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
// Cold .NET + Node startup on a shared Windows runner can exceed 1.4 seconds;
// expiring before the fixture publishes its owned PIDs proves no hang cleanup.
// Give that fixture six seconds, still well below the production hard limit.
// The larger candidate lease in elapsed-lease must be reduced to this original
// budget, and both expiry cases must finish before that candidate could expire.
const guardianTestLeaseMs = 6000;
const guardianCandidateLeaseMs = 20000;
for (const mode of ['hang', 'crash', 'guard-crash', 'elapsed-lease']) test(`native guardian reaps only its own process tree: ${mode}`, { skip: !supported, timeout: 25000 }, async t => {
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
  try { await waitUntil(async () => { try { await fs.access(file); return true; } catch { return false; } }); }
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

test('bank storage codec matches the reviewed Playwright source', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../development/build-storage-codec.mjs', import.meta.url)), '--check'], { stdio: 'pipe' });
});
test('explicit show can reveal a private bank challenge without reading its fields', async () => {
  const { portal, state } = manualCodePortal({ afterWait() {} });
  await portal.show();
  assert.equal(state.focused, 1); assert.equal(state.saved, 0); assert.equal(state.waits, 0);
});
