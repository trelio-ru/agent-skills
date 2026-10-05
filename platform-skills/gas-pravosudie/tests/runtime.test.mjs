import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  browserSessionRuntime,
  childEnvironment,
  decryptRecord,
  encryptRecord,
  guardianConfig,
  identityFromEnv,
  LEASE_MS,
  officialCourtOrigin,
  officialCourtUrl,
  officialEsiaUrl,
  RUNTIME_VERSION,
  staticEsiaResourceAllowed,
} from '../scripts/core.mjs';
import { CourtPortal, launchOwnedBrowser, validatedStorage } from '../scripts/browser.mjs';
import { keychainStatus, nativeHelper, runPrivate } from '../scripts/native.mjs';
import { compileScenario, executeScenario } from '../scripts/scenario.mjs';
import { parseArguments } from '../scripts/trelio-gas-pravosudie.mjs';
import { newBackgroundContext } from '../scripts/windows.mjs';
// The shared provider selector runs this entrypoint on each CI OS. Keep the
// auth lifecycle regressions in that gate without changing the global matrix.
import './sign-in-regressions.mjs';
import './http-navigation-regressions.mjs';

const identity = identityFromEnv({
  TRELIO_SKILL_ID: 'gas-pravosudie',
  TRELIO_SKILL_COMPANY_ID: '11111111-1111-4111-8111-111111111111',
  TRELIO_SKILL_MEMBER_ID: '22222222-2222-4222-8222-222222222222',
});

test('runtime binds only the shared 30-minute non-manual protected snapshot policy', async () => {
  const startedAt = Date.now();
  const fixture = new URL('browser-session-fixture.mjs', import.meta.url).href;
  const environment = policy => ({
    TRELIO_BROWSER_SESSION_MODULE_URL: fixture,
    TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify(policy),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(startedAt),
    TRELIO_BROWSER_SESSION_DEADLINE_AT: String(startedAt + policy.leaseMs),
  });
  const exact = { apiVersion: 1, sessionClass: 'protected-snapshot', leaseMs: LEASE_MS, manualAssist: false };
  assert.equal((await browserSessionRuntime(environment(exact))).binding.manualAssist, false);
  await assert.rejects(browserSessionRuntime(environment({ ...exact, manualAssist: true })),
    /browser_session_policy_invalid/);
  await assert.rejects(browserSessionRuntime(environment({ ...exact, leaseMs: LEASE_MS + 1 })),
    /browser_session_policy_invalid/);
});

test('encrypted court snapshot is randomized, identity-bound and tamper-evident', () => {
  const key = crypto.randomBytes(32);
  const state = { schema: 1, storage: { cookies: [{ domain: '.sudrf.ru', value: 'synthetic-cookie' }], origins: [] } };
  const first = encryptRecord(key, identity, state);
  assert.ok(!first.includes('synthetic-cookie'));
  assert.deepEqual(decryptRecord(key, identity, first), state);
  assert.notEqual(first, encryptRecord(key, identity, state));
  assert.throws(() => decryptRecord(key, { ...identity, member: '33333333-3333-4333-8333-333333333333' }, first),
    /vault_corrupt_or_wrong_identity/);
  const envelope = JSON.parse(first);
  const changed = Buffer.from(envelope.data, 'base64');
  changed[0] ^= 1;
  envelope.data = changed.toString('base64');
  assert.throws(() => decryptRecord(key, identity, JSON.stringify(envelope)), /vault_corrupt_or_wrong_identity/);
});

test('identity and process environment do not accept another skill, connection or ambient secrets', () => {
  assert.equal(identity.connection, 'browser');
  for (const env of [
    {},
    { TRELIO_SKILL_ID: 'gosuslugi', TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member },
    { TRELIO_SKILL_ID: 'gas-pravosudie', TRELIO_SKILL_COMPANY_ID: identity.company,
      TRELIO_SKILL_MEMBER_ID: identity.member, TRELIO_SKILL_CONNECTION_ID: crypto.randomUUID() },
  ]) assert.throws(() => identityFromEnv(env), /host_identity_required|unexpected_company_connection/);
  assert.deepEqual(childEnvironment({ PATH: '/safe', HOME: '/owner', DEBUG: '*', NODE_OPTIONS: '--inspect', TOKEN: 'secret' }),
    { PATH: '/safe', HOME: '/owner' });
});

test('official origins are parsed exactly and only court state is durable', () => {
  for (const value of ['https://ej.sudrf.ru/', 'https://sudrf.ru/path', 'https://region.sudrf.ru/case']) {
    assert.equal(officialCourtUrl(value), true);
  }
  for (const value of ['http://ej.sudrf.ru/', 'https://sudrf.ru.evil.example/', 'https://user@sudrf.ru/',
    'https://sudrf.ru:8443/', 'not-a-url']) assert.equal(officialCourtUrl(value), false);
  assert.equal(officialCourtOrigin('https://ej.sudrf.ru'), true);
  assert.equal(officialCourtOrigin('https://ej.sudrf.ru/'), false);
  assert.equal(officialEsiaUrl('https://esia.gosuslugi.ru/login'), true);
  assert.equal(officialEsiaUrl('https://gosuslugi.ru.evil.example/'), false);
  assert.deepEqual(validatedStorage({
    cookies: [{ domain: '.ej.sudrf.ru' }],
    origins: [{ origin: 'https://ej.sudrf.ru', localStorage: [] }],
  }).origins.length, 1);
  for (const state of [
    { cookies: [{ domain: '.gosuslugi.ru' }], origins: [] },
    { cookies: [], origins: [{ origin: 'https://esia.gosuslugi.ru' }] },
    { cookies: [{ domain: '.sudrf.ru.evil.example' }], origins: [] },
  ]) assert.throws(() => validatedStorage(state), /storage_state_origin_rejected/);
});

test('ESIA static host is resource-only and never general navigation or API access', () => {
  const asset = { url: 'https://gu-st.ru/htdocs/js/angular.min.js', navigation: false, method: 'GET', resourceType: 'script' };
  assert.equal(staticEsiaResourceAllowed(asset), true);
  assert.equal(staticEsiaResourceAllowed({ ...asset, method: 'HEAD', resourceType: 'font' }), true);
  assert.equal(staticEsiaResourceAllowed({ ...asset, url: 'https://gu-st.ru/htdocs/tpl/index/main.html', resourceType: 'xhr' }), true);
  for (const changed of [
    { navigation: true }, { method: 'POST' }, { resourceType: 'document' },
    { url: 'https://gu-st.ru/api/profile', resourceType: 'xhr' },
    { url: 'https://cdn.gu-st.ru/htdocs/js/a.js' },
    { url: 'https://gu-st.ru.evil.example/a.js' },
  ]) assert.equal(staticEsiaResourceAllowed({ ...asset, ...changed }), false, JSON.stringify(changed));
});

test('CLI has no headless, secret or lease extension options; cabinet work needs no separate start confirmation', () => {
  assert.equal(parseArguments(['start']).command, 'start');
  assert.equal(parseArguments(['start', '--channel', 'chrome']).options['--channel'], 'chrome');
  for (const option of ['--headless', '--password', '--otp', '--token', '--ttl', '--extend', '--focus']) {
    assert.throws(() => parseArguments(['start', option, 'value']), /unsupported_option/);
  }
  const session = crypto.randomUUID();
  assert.throws(() => parseArguments(['prepare-sign-in', '--session', session, '--input-file', '/tmp/client.json']),
    /authorization_permission_required/);
  assert.equal(parseArguments(['prepare-sign-in', '--session', session, '--input-file', '/tmp/client.json', '--confirm'])
    .command, 'prepare-sign-in');
  assert.throws(() => parseArguments(['forget']), /explicit_confirmation_required/);
  assert.equal(LEASE_MS, 1_800_000);
});

test('full Playwright result keeps requested data but suppresses auth-shaped fields', async () => {
  const result = await executeScenario(compileScenario(`return {
    status: 'Зарегистрировано',
    token: 'synthetic-token',
    nested: { session_id: 'synthetic-session', cookies: ['synthetic-cookie'] },
  };`), { context: {}, page: {} });
  assert.deepEqual(result.result, {
    status: 'Зарегистрировано',
    token: '[redacted]',
    nested: { session_id: '[redacted]', cookies: '[redacted]' },
  });
  assert.ok(!JSON.stringify(result).includes('synthetic-token'));
  assert.ok(!JSON.stringify(result).includes('synthetic-cookie'));
});

test('standard court agreement is checked in background before the single login click', async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gas-client-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'scripts', 'playwright-client.mjs');
  const guidePath = path.join(directory, 'references', 'playwright-client.md');
  await fs.mkdir(path.dirname(modulePath));
  await fs.mkdir(path.dirname(guidePath));
  await fs.writeFile(guidePath, '# synthetic client\n');
  await fs.writeFile(modulePath, `export async function createEsiaAuthorization(page, options) {
    globalThis.__gasClientOptions = options;
    return {
      request: Promise.resolve({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: options.origin, expiresAt: Date.now() + 1000, arguments: ['authorize', '--confirm'] }),
      authenticated: new Promise(() => {}),
      close: async () => {},
    };
  }\n`);
  const calls = [];
  let checked = false;
  const controls = {
    '#iAgree[type="checkbox"]:visible': { count: async () => 1, isChecked: async () => checked,
      check: async () => { checked = true; calls.push('check'); } },
    'a[href="/info/useragreement"]:visible': { count: async () => 1, first() { return this; },
      innerText: async () => 'Пользовательское соглашение' },
    'label[for="iAgree"]:visible': { count: async () => 1, first() { return this; },
      innerText: async () => 'Я ознакомился(ась) с «Пользовательским соглашением»\nи согласен(на) на обработку персональных данных.' },
    'button.esiaLogin:visible,button.esia-login:visible': { filter() { return this; }, count: async () => 1,
      click: async () => { calls.push('login'); } },
    'input[type="checkbox"]:visible': { count: async () => 1 },
  };
  const page = { url: () => 'https://ej.sudrf.ru/', locator: selector => controls[selector], bringToFront: async () => calls.push('focus') };
  const portal = new CourtPortal({}, async () => {});
  portal.page = page;
  const result = await portal.prepareSignIn({
    modulePath,
    configHome: directory,
    options: { company: identity.company, member: identity.member },
    guidePath,
    ownership: 'caller',
    browserAccess: 'full_playwright_context',
  }, 'Проверить обращение');
  assert.equal(result.phase, 'authorization_required');
  assert.deepEqual(calls, ['check', 'login']);
  assert.equal(checked, true);
  assert.equal(globalThis.__gasClientOptions.origin, 'https://ej.sudrf.ru');
  assert.equal(globalThis.__gasClientOptions.confirm, true);
  assert.equal(globalThis.__gasClientOptions.requestTitle, 'Проверить обращение');
  delete globalThis.__gasClientOptions;
  await portal.close();
});

test('collapsed live navigation is expanded before the exact court login entry is clicked', async () => {
  const calls = [];
  let entryVisible = false;
  const entry = {
    count: async () => 1,
    isVisible: async () => entryVisible,
    click: async () => { calls.push('login-entry'); },
  };
  const menu = {
    filter(options) {
      assert.match('Показать меню', options.hasText);
      return this;
    },
    count: async () => 1,
    click: async () => { entryVisible = true; calls.push('menu'); },
  };
  const portal = new CourtPortal({}, async () => {});
  portal.page = {
    url: () => 'https://ej.sudrf.ru/',
    locator: selector => ({
      '#iAgree[type="checkbox"]:visible': { count: async () => 0 },
      'a[title="Вход"]': entry,
      'button.navbar-toggle:visible': menu,
    })[selector],
    waitForLoadState: async () => {},
  };

  await portal.ensureAuthorizationPage();
  assert.deepEqual(calls, ['menu', 'login-entry']);
});

test('an extra checkbox or changed consent text blocks before helper import or login click', async () => {
  const gosuslugiRoot = fileURLToPath(new URL('../../gosuslugi/', import.meta.url));
  let checkboxCount = 2;
  let labelText = 'Я ознакомился(ась) с «Пользовательским соглашением» и согласен(на) на обработку персональных данных.';
  let clicked = false;
  const controls = {
    '#iAgree[type="checkbox"]:visible': { count: async () => 1 },
    'a[href="/info/useragreement"]:visible': { count: async () => 1, first() { return this; },
      innerText: async () => 'Пользовательское соглашение' },
    'label[for="iAgree"]:visible': { count: async () => 1, first() { return this; },
      innerText: async () => labelText },
    'button.esiaLogin:visible,button.esia-login:visible': { filter() { return this; }, count: async () => 1,
      click: async () => { clicked = true; } },
    'input[type="checkbox"]:visible': { count: async () => checkboxCount },
  };
  const client = {
    modulePath: path.join(gosuslugiRoot, 'scripts', 'playwright-client.mjs'),
    guidePath: path.join(gosuslugiRoot, 'references', 'playwright-client.md'),
    configHome: '/tmp',
    options: { company: identity.company, member: identity.member },
    ownership: 'caller',
    browserAccess: 'full_playwright_context',
  };
  for (const changed of ['extra-checkbox', 'changed-label']) {
    if (changed === 'changed-label') {
      checkboxCount = 1;
      labelText = 'Я согласен на дополнительную передачу данных третьим лицам.';
    }
    const portal = new CourtPortal({}, async () => {});
    portal.page = { url: () => 'https://ej.sudrf.ru/', locator: selector => controls[selector] };
    await assert.rejects(portal.prepareSignIn(client), /court_consent_changed/);
  }
  assert.equal(clicked, false);
});

test('headed launch registers native ownership before Playwright connect', async () => {
  const calls = [];
  const server = { process: () => ({ pid: 12345 }), wsEndpoint: () => 'private-endpoint',
    kill: async () => { calls.push('kill'); } };
  const browser = {};
  const playwright = { chromium: {
    launchServer: async options => { calls.push('launch'); assert.equal(options.headless, false); return server; },
    connect: async endpoint => { calls.push('connect'); assert.equal(endpoint, 'private-endpoint'); return browser; },
  } };
  const result = await launchOwnedBrowser({ playwright, permit: async (op, extra) => {
    calls.push('own'); assert.equal(op, 'own'); assert.equal(extra.pid, 12345);
  } });
  assert.equal(result.browser, browser);
  assert.deepEqual(calls, ['launch', 'own', 'connect']);
});

test('owned context creates its initial page as an unfocused background target', async () => {
  const calls = [];
  const page = { isClosed: () => false };
  let pagePredicate;
  let resolvePage;
  const pageReady = new Promise(resolve => { resolvePage = resolve; });
  const context = {
    pages: () => [],
    waitForEvent: (_name, options) => { pagePredicate = options.predicate; return pageReady; },
    newCDPSession: async () => ({
      send: async method => {
        assert.equal(method, 'Target.getTargetInfo');
        return { targetInfo: { targetId: 'target-1', browserContextId: 'context-1' } };
      },
      detach: async () => {},
    }),
    close: async () => {},
  };
  let contextReads = 0;
  const session = {
    send: async (method, options) => {
      if (method === 'Target.getBrowserContexts') {
        contextReads += 1;
        return { browserContextIds: contextReads === 1 ? [] : ['context-1'] };
      }
      if (method === 'Target.createTarget') {
        calls.push(options);
        setImmediate(async () => {
          assert.equal(await pagePredicate(page), true);
          resolvePage(page);
        });
        return { targetId: 'target-1' };
      }
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const browser = {
    newBrowserCDPSession: async () => session,
    newContext: async options => {
      assert.deepEqual(options.storageState, { cookies: [], origins: [] });
      return context;
    },
  };
  const owned = await newBackgroundContext(browser, { storageState: { cookies: [], origins: [] } });
  assert.equal(await owned.newPage(), page);
  assert.deepEqual(calls, [{
    url: 'about:blank',
    browserContextId: 'context-1',
    background: true,
    focus: false,
    newWindow: true,
  }]);
});

test('a replaced court tab is rebound without creating or focusing another page', async () => {
  const calls = [];
  const closed = { isClosed: () => true, url: () => 'https://ej.sudrf.ru/' };
  const survivor = {
    isClosed: () => false,
    url: () => 'https://ej.sudrf.ru/appeal/list',
    locator: () => ({ count: async () => 0 }),
    bringToFront: async () => { calls.push('focus'); },
  };
  const portal = new CourtPortal({}, async () => { calls.push('permit'); });
  portal.page = closed;
  portal.context = {
    pages: () => [closed, survivor],
    newPage: async () => { calls.push('new-page'); return survivor; },
  };

  const handles = await portal.playwrightContext();

  assert.equal(handles.page, survivor);
  assert.deepEqual(calls, ['permit', 'permit']);
});

test('runtime release binds the common protected-snapshot contract', async () => {
  const release = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));
  assert.equal(release.release.version, '4.0.5');
  assert.equal(release.runtime.version, RUNTIME_VERSION);
  assert.equal(release.runtime.minimumHostVersion, '2.4.0');
  assert.deepEqual(release.runtime.browserSession, {
    apiVersion: 1,
    sessionClass: 'protected-snapshot',
    leaseMs: 1_800_000,
    manualAssist: false,
  });
});

test('private guardian config allows one UTF-8 preamble but no second one', () => {
  assert.deepEqual(guardianConfig('\uFEFF{"value":"суд"}'), { value: 'суд' });
  assert.throws(() => guardianConfig('\uFEFF\uFEFF{}'), /guardian_config_invalid/);
});

const supported = ['darwin', 'win32'].includes(process.platform);
let nativeRoot;
let helper;
test.before(async () => {
  if (!supported) return;
  nativeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gas-pravosudie-native-test-'));
  helper = await nativeHelper(nativeRoot);
});
test.after(async () => { if (nativeRoot) await fs.rm(nativeRoot, { recursive: true, force: true }); });

test('native helper uses the noninteractive Keychain/DPAPI guardian mechanism', { skip: !supported }, async () => {
  const result = (await runPrivate(helper, ['probe'])).toString();
  assert.match(result, process.platform === 'darwin'
    ? /macos-keychain-continuous-guard-v1/
    : /windows-dpapi-job-continuous-v1/);
  const keychain = await keychainStatus(helper);
  if (process.platform === 'darwin') assert.ok(['ready', 'action_required'].includes(keychain.status));
  else assert.deepEqual(keychain, { status: 'not_applicable' });
});

test('Windows DPAPI synthetic roundtrip is available without CredUI', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await runPrivate(helper, ['self-test'])).toString(), /dpapi-current-user-roundtrip-tamper-ok/);
});
