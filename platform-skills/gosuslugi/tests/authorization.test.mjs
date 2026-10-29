import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArguments as gosArguments, run as gosRun } from '../scripts/trelio-gosuslugi.mjs';
import { atomicWrite, nativeHelper, ensurePrivateDirectory } from '../scripts/native.mjs';
import { browserSessionDirectory, readAuthorization, requestLocal } from '../scripts/transport.mjs';
import { createAuthorizationBroker } from '../scripts/authorization.mjs';
import { childEnvironment, LEASE_MS, RUNTIME_VERSION, RuntimeError } from '../scripts/core.mjs';
import { observeEsiaAuthorization, safeAuthorizationFailure } from '../scripts/playwright-client.mjs';
import { EsiaAuthorizer } from '../scripts/esia-authorizer.mjs';
import { authRpc } from '../scripts/auth-rpc.mjs';
import { isLoginConsent } from '../scripts/esia-consent.mjs';
import { waitForSessionChange, withSessionContinuation } from '../scripts/session-wait.mjs';
import { ServiceFlow, serviceForOrigin } from '../scripts/esia-flow.mjs';

const supported = ['darwin', 'win32'].includes(process.platform);

// Public UI vocabulary with an invented relying party; no real account,
// company, complaint or auth request is copied into the public regression.
const loginConsentText = `Разрешение на действия с персональными данными
Информационная система, которая запрашивает разрешение
Учебная информационная система
Запрашиваемые действия
Просмотр списка ваших организаций
Просмотр вашей фамилии, имени и отчества
Просмотр вашего адреса электронной почты
Просмотр вашего СНИЛС
Согласие на выдачу разрешения
Нажимая «Выдать разрешение», вы предоставляете информационной системе права на указанные действия.
Разрешение можно отозвать на Госуслугах: профиль → Согласия и доверенности → Разрешения
Выдать разрешение`;

test('login authority covers the standard ESIA profile disclosure but no other actions or scopes', () => {
  assert.equal(isLoginConsent(loginConsentText), true);
  assert.equal(isLoginConsent(loginConsentText.replaceAll('\n', '\r\n')), true);
  assert.equal(isLoginConsent(loginConsentText.replaceAll('\n', ' ')), true);
  for (const text of [
    loginConsentText.replace('Просмотр вашего СНИЛС', 'Отправка заявления'),
    loginConsentText.replace('Просмотр вашего СНИЛС', 'Просмотр ваших медицинских документов'),
    loginConsentText.replace('Просмотр вашего СНИЛС', 'Просмотр вашего СНИЛС и подписание документов'),
  ]) assert.equal(isLoginConsent(text), false);
  for (const suffix of [' CAPTCHA', ' Подтвердите push', ' Оплата', ' Подписание документа'])
    assert.equal(isLoginConsent(loginConsentText + suffix), false);
  assert.equal(isLoginConsent(loginConsentText.replace('Учебная информационная система', '')), false);
  assert.equal(isLoginConsent(loginConsentText.replace('Запрашиваемые действия', 'Действия')), false);
  assert.equal(isLoginConsent(loginConsentText + '\nЗапрашиваемые действия'), false);
  assert.equal(isLoginConsent(loginConsentText.replace(/Просмотр[^\n]+\n/g, '')), false);
  assert.equal(isLoginConsent(loginConsentText + ' '.repeat(16000)), false);
});

function consentPage() {
  const fixture = { text: loginConsentText, clicks: 0, fields: 0, buttons: 1, enabled: true,
    connected: true, consumed: false, disposed: 0, url: 'https://esia.gosuslugi.ru/consent' };
  const element = { isVisible: async () => true, isEnabled: async () => fixture.enabled,
    evaluate: async () => fixture.connected,
    click: async () => { fixture.clicks++; fixture.onClick?.(); },
    dispose: async () => { fixture.disposed++; } };
  const button = { filter() { return this; }, count: async () => fixture.buttons,
    isEnabled: async () => fixture.enabled, elementHandle: async () => element };
  const inputs = { filter() { return this; }, count: async () => fixture.fields };
  fixture.page = { url: () => fixture.url, getByRole: () => button,
    locator: selector => selector === 'body' ? { innerText: async () => fixture.text } : inputs };
  fixture.flow = { allowSecret() { if (fixture.returning) throw new RuntimeError('service_authorization_request_required'); } };
  fixture.consume = () => { assert.equal(fixture.consumed, false); fixture.consumed = true; };
  fixture.run = permit => authRpc(fixture.page, fixture.flow, { operation: 'grant-login-consent' },
    permit ?? (async () => {}), { consumeLoginConsent: fixture.consume });
  return fixture;
}

test('fixed ESIA consent action rechecks scopes, fields, native permit and callback before one click', async () => {
  const accepted = consentPage();
  assert.deepEqual(await accepted.run(), { granted: true });
  assert.equal(accepted.clicks, 1); assert.equal(accepted.consumed, true); assert.equal(accepted.disposed, 1);
  for (const change of [fixture => { fixture.text += ' Оплата'; }, fixture => { fixture.fields = 1; },
    fixture => { fixture.buttons = 2; }, fixture => { fixture.enabled = false; }]) {
    const fixture = consentPage(); change(fixture);
    assert.deepEqual(await fixture.run(), { granted: false });
    assert.equal(fixture.clicks, 0); assert.equal(fixture.consumed, false);
  }
  for (const change of [fixture => { fixture.text = fixture.text.replace('Учебная', 'Другая'); },
    fixture => { fixture.text = fixture.text.replace('Просмотр вашего СНИЛС', 'Оплата'); },
    fixture => { fixture.fields = 1; }, fixture => { fixture.connected = false; }]) {
    const fixture = consentPage(); let permits = 0;
    assert.deepEqual(await fixture.run(async () => { if (++permits === 2) change(fixture); }), { granted: false });
    assert.equal(fixture.clicks, 0); assert.equal(fixture.consumed, false);
  }
  const returning = consentPage(); let permits = 0;
  await assert.rejects(returning.run(async () => { if (++permits === 2) returning.returning = true; }),
    /service_authorization_request_required/);
  assert.equal(returning.clicks, 0); assert.equal(returning.consumed, false);
  const unclaimed = consentPage();
  await assert.rejects(authRpc(unclaimed.page, unclaimed.flow, { operation: 'grant-login-consent' }, async () => {}),
    /authorization_permission_required/);
  unclaimed.url = 'https://other.example.org/consent';
  await assert.rejects(unclaimed.run(), /secret_origin_rejected/);
  const uncertain = consentPage(); uncertain.onClick = () => { throw new RuntimeError('session_unreachable'); };
  await assert.rejects(uncertain.run(), /session_unreachable/);
  assert.equal(uncertain.clicks, 1); assert.equal(uncertain.consumed, true);
});

test('delegated authorizer grants login disclosure without a human prompt and preserves no-replay on failure', async () => {
  for (const outcome of ['granted', 'unsupported', 'uncertain']) {
    const phases = [], operations = [];
    const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async value => phases.push(value) });
    let returned = false;
    authorizer.call = async (command, packet) => {
      if (command === 'auth-state') return { atAuth: true, returned, postCount: 0 };
      if (['complete', 'show'].includes(command)) return {};
      operations.push(packet.operation);
      if (packet.operation === 'observe') return { text: loginConsentText, queries: {
        login: { count: 0 }, password: { count: 0 }, code: { count: 0 }, checkboxes: { fields: [] },
      } };
      assert.equal(packet.operation, 'grant-login-consent');
      if (outcome === 'uncertain') throw new RuntimeError('session_unreachable');
      returned = outcome === 'granted'; return { granted: returned };
    };
    if (outcome === 'uncertain') {
      await assert.rejects(authorizer.authenticate({}), /session_unreachable/);
      assert.equal(authorizer.consentSent, true);
    } else {
      assert.equal(await authorizer.authenticate({}), outcome === 'granted');
      assert.equal(phases.includes('user_required'), outcome === 'unsupported');
      if (outcome === 'unsupported') assert.equal(authorizer.manualReason, 'consent_required');
    }
    assert.deepEqual(operations, ['observe', 'grant-login-consent']);
  }
});
const identity = {
  company: '11111111-1111-4111-8111-111111111111',
  member: '22222222-2222-4222-8222-222222222222',
};
const origin = 'https://ordinary.example.org';

function observedLogin(requestWaitMs) {
  let requestResolve, requestReject, returnedResolve, returnedReject;
  const login = {
    request: new Promise((resolve, reject) => { requestResolve = resolve; requestReject = reject; }),
    authenticated: new Promise((resolve, reject) => { returnedResolve = resolve; returnedReject = reject; }),
  };
  return { observer: observeEsiaAuthorization(login, { requestWaitMs }),
    requestResolve, requestReject, returnedResolve, returnedReject };
}

test('nonblocking observer keeps a serialized caller usable between two login clicks', async () => {
  const pending = observedLogin(60000), events = [];
  let chain = Promise.resolve();
  const enqueue = action => (chain = chain.then(action));
  const request = { sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), origin,
    expiresAt: Date.now() + LEASE_MS, arguments: ['authorize', '--confirm'] };
  // The first click only opens a site-owned modal. Waiting for request here
  // would trap both the following state command and the actual login click.
  await enqueue(() => { events.push('modal'); return pending.observer.snapshot(); });
  assert.equal((await enqueue(() => pending.observer.snapshot())).phase, 'esia_request_pending');
  await enqueue(() => { events.push('popup'); pending.requestResolve(request); });
  const ready = await enqueue(() => pending.observer.snapshot());
  assert.deepEqual(events, ['modal', 'popup']);
  assert.deepEqual(ready, { phase: 'esia_authorization_required', request });
  ready.request.arguments.push('unwanted');
  request.arguments.push('also-unwanted');
  assert.deepEqual(pending.observer.snapshot().request.arguments, ['authorize', '--confirm']);
  pending.returnedResolve({ page: { secret: 'private-page' }, context: { secret: 'private-context' },
    serviceResponse: { httpStatus: 503, httpOrigin: origin, rawUrl: 'never-return' } });
  await Promise.resolve();
  assert.deepEqual(pending.observer.snapshot(), { phase: 'esia_callback_verified',
    serviceResponse: { httpStatus: 503, httpOrigin: origin } });
});

test('observer wait expiry requests inspection without cancelling the same helper', async () => {
  const pending = observedLogin(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(pending.observer.snapshot(), { phase: 'esia_request_not_observed' });
  // A later, authorized second click can still create this exact request.
  pending.requestResolve({ arguments: ['authorize'], origin });
  await Promise.resolve();
  assert.equal(pending.observer.snapshot().phase, 'esia_authorization_required');
  pending.returnedReject(new RuntimeError('service_callback_rejected_state'));
  await Promise.resolve();
  assert.deepEqual(pending.observer.snapshot(), {
    phase: 'authorization_failed', error: 'service_callback_rejected_state',
  });
});

test('observer failures are safe and sticky while verified return survives late cleanup', async () => {
  const failed = observedLogin(1000);
  failed.requestReject(new Error('private OAuth URL and password must not escape'));
  await Promise.resolve();
  failed.returnedResolve({ context: {}, page: {} });
  await Promise.resolve();
  assert.deepEqual(failed.observer.snapshot(), { phase: 'authorization_failed', error: 'authorization_result_unknown' });
  const verified = observedLogin(1000);
  verified.returnedResolve({ context: {}, page: {} });
  await Promise.resolve();
  verified.requestReject(new RuntimeError('authorization_cancelled'));
  await Promise.resolve();
  assert.deepEqual(verified.observer.snapshot(), { phase: 'esia_callback_verified' });
  for (const requestWaitMs of [0, -1, 60001, 1.5, '15']) {
    assert.throws(() => observeEsiaAuthorization({}, { requestWaitMs }), /authorization_observation_wait_invalid/);
  }
  assert.throws(() => observeEsiaAuthorization({}), /authorization_observation_invalid/);
});

// Execute the published example itself. A correct SDK is insufficient if the
// copied caller permanently locks its Page after the first settled helper.
async function guideCaller({ failCreation } = {}) {
  const guide = await fs.readFile(new URL('../references/playwright-client.md', import.meta.url), 'utf8').then(value => value.replace(/\r\n/g, '\n'));
  const code = guide.match(/```js\n([\s\S]*?)\n```/)[1];
  const body = code.slice(code.indexOf('let login,'));
  const helpers = [], events = [], clicks = [];
  let queue = Promise.resolve();
  const openBrowserController = async (_descriptor, options) => {
    let closed = false;
    return { handle: options.handle, close: async () => {
      if (closed) return;
      closed = true;
      await options.onClose();
    } };
  };
  const context = { closed: false, close() { this.closed = true; } };
  const page = { url: () => 'https://service.example.org', context: () => context,
    draft: 'prepared', files: ['attachment.txt'], consent: true,
    locator: selector => ({ click: async () => { clicks.push(selector); } }) };
  const browser = { closed: false, close() { this.closed = true; } };
  const create = async source => {
    assert.equal(source, page);
    let requestResolve, returnedResolve, returnedReject;
    const helper = { request: new Promise(resolve => { requestResolve = resolve; }),
      authenticated: new Promise((resolve, reject) => { returnedResolve = resolve; returnedReject = reject; }),
      closeCount: 0, close: async () => { helper.closeCount++; } };
    helpers.push({ helper, requestResolve, returnedResolve, returnedReject });
    if (helpers.length === failCreation) throw new RuntimeError('authorization_target_mismatch');
    return helper;
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const caller = await new AsyncFunction('page', 'context', 'browser', 'client',
    'createEsiaAuthorization', 'observeEsiaAuthorization', 'safeAuthorizationFailure',
    'emit', 'openBrowserController', 'origin', body + '\nreturn { handle, controller };')(page, context, browser,
      { options: {}, configHome: '/synthetic' }, create, observeEsiaAuthorization,
      safeAuthorizationFailure, value => { events.push(value); return value; }, openBrowserController, 'https://service.example.org');
  return { handle: caller.handle, helpers, page, context, browser, events, clicks,
    dispatch(line) { queue = queue.then(() => caller.controller.handle(JSON.parse(line))).catch(() => {}); return queue; },
    end() { return caller.controller.close(); } };
}

test('published caller continues a distinct authorized procedure without replacing its prepared Page', async () => {
  const caller = await guideCaller();
  await caller.handle({ action: 'authorize', step: 'cabinet', selector: '#first-login' });
  await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'application',
    previousOutcome: 'no_business_submission', selector: '#form-login' }), /previous_authorization_unresolved/);
  assert.equal(caller.helpers.length, 1);
  caller.helpers[0].returnedResolve({ page: caller.page, context: caller.context });
  await Promise.resolve();
  for (const previousOutcome of [undefined, 'unknown', 'sent_maybe']) {
    await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'application', previousOutcome,
      selector: '#form-login' }), /previous_authorization_unresolved/);
  }
  await caller.handle({ action: 'authorize_next_step', step: 'application',
    previousOutcome: 'no_business_submission', selector: '#form-login' });
  assert.equal(caller.helpers.length, 2); assert.equal(caller.helpers[0].helper.closeCount, 1);
  assert.deepEqual(caller.page.files, ['attachment.txt']); assert.equal(caller.page.draft, 'prepared');
  assert.equal(caller.page.consent, true); assert.equal(caller.context.closed, false); assert.equal(caller.browser.closed, false);
  await caller.handle({ action: 'state' });
  assert.equal(caller.events.at(-1).phase, 'esia_request_pending'); assert.equal(caller.events.at(-1).step, 'application');
  await caller.handle({ action: 'click_login', selector: '#modal-login' });
  assert.deepEqual(caller.clicks, ['#first-login', '#form-login', '#modal-login']);
  // The old helper's late event must keep its old generation, even while the
  // new observer is pending. No private Page/context leaves an emitted state.
  caller.helpers[0].requestResolve({ origin, arguments: ['authorize', '--confirm'] });
  await Promise.resolve();
  assert.equal(caller.events.at(-1).step, 'cabinet');
  assert.doesNotMatch(JSON.stringify(caller.events), /prepared|attachment.txt/);
  caller.helpers[1].returnedResolve({ page: caller.page, context: caller.context });
  await Promise.resolve();
  await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'application',
    previousOutcome: 'completed', selector: '#form-login' }), /distinct_authorization_step_required/);
  await caller.handle({ action: 'finish' });
  assert.equal(caller.context.closed, true); assert.equal(caller.browser.closed, true);
});

test('published caller never turns a failed authorization into a next-step retry', async () => {
  const caller = await guideCaller();
  await caller.handle({ action: 'authorize', step: 'application', selector: '#form-login' });
  caller.helpers[0].returnedReject(new RuntimeError('service_callback_rejected_state'));
  await Promise.resolve();
  await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'another_application',
    previousOutcome: 'completed', selector: '#form-login' }), /previous_authorization_unresolved/);
  assert.equal(caller.helpers.length, 1); assert.equal(caller.helpers[0].helper.closeCount, 0);
  assert.equal(caller.context.closed, false);
});

test('published caller preserves a failed helper creation instead of minting another step', async () => {
  const caller = await guideCaller({ failCreation: 2 });
  await caller.handle({ action: 'authorize', step: 'cabinet', selector: '#first-login' });
  caller.helpers[0].returnedResolve({}); await Promise.resolve();
  await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'application',
    previousOutcome: 'no_business_submission', selector: '#form-login' }), /authorization_target_mismatch/);
  await assert.rejects(caller.handle({ action: 'authorize_next_step', step: 'another_application',
    previousOutcome: 'completed', selector: '#form-login' }), /previous_authorization_unresolved/);
  assert.equal(caller.helpers.length, 2); assert.equal(caller.context.closed, false);
});

// Drive the documented host adapter as well as handle(): a generic exception must
// leave later state/finish commands usable and retain independent ESIA proof.
test('published caller isolates locator and command failures from the authorization result', async () => {
  const caller = await guideCaller();
  const privateError = new Error('https://private.example.org/application?token=synthetic-secret');
  caller.page.locator = () => ({ click: async () => { throw privateError; } });
  await caller.dispatch(JSON.stringify({ action: 'authorize', step: 'application', selector: '#missing' }));
  assert.deepEqual(caller.events.at(-1), { phase: 'caller_action_failed',
    authorization: { phase: 'esia_request_pending' }, step: 'application' });
  assert.equal(caller.context.closed, false); assert.equal(caller.browser.closed, false);
  caller.helpers[0].returnedResolve({ page: caller.page, context: caller.context });
  await Promise.resolve();
  const priorEvents = caller.events.length;
  await caller.dispatch('invalid JSON with synthetic-secret');
  assert.equal(caller.events.length, priorEvents, 'malformed input never reaches a browser handler');
  await caller.dispatch(JSON.stringify({ action: 'state' }));
  assert.deepEqual(caller.events.at(-1), { phase: 'esia_callback_verified', step: 'application' });
  assert.doesNotMatch(JSON.stringify(caller.events), /private\.example|synthetic-secret|authorization_result_unknown/);
  await caller.dispatch(JSON.stringify({ action: 'finish' }));
  assert.equal(caller.events.at(-1).phase, 'caller_closed');
  assert.equal(caller.context.closed, true); assert.equal(caller.browser.closed, true);
});

test('published caller attempts every owned close on failure through common close/expiry callback', async () => {
  for (const failure of ['helper', 'context', 'browser', 'none']) {
    const caller = await guideCaller(), closed = [];
    await caller.handle({ action: 'authorize', step: 'application', selector: '#login' });
    for (const [name, resource] of [['helper', caller.helpers[0].helper], ['context', caller.context], ['browser', caller.browser]]) {
      resource.close = async () => {
        closed.push(name);
        if (name === failure) throw new Error('private cleanup error');
      };
    }
    if (failure === 'none') await caller.end();
    else await assert.rejects(caller.end(), /caller_cleanup_failed/);
    assert.deepEqual(closed, ['helper', 'context', 'browser']);
    assert.deepEqual(caller.events.at(-1), { phase: failure === 'none' ? 'caller_closed' : 'caller_cleanup_failed' });
    await caller.handle({ action: 'finish' });
    assert.deepEqual(closed, ['helper', 'context', 'browser'], 'cleanup must not repeat');
    assert.doesNotMatch(JSON.stringify(caller.events), /private cleanup/);
  }
});

async function guideDownload() {
  const guide = (await fs.readFile(new URL('../references/playwright-client.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const code = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)]
    .map(match => match[1]).find(value => value.startsWith('async function saveCurrentPageDownload'));
  assert.ok(code, 'exercise the actual documented download implementation');
  return new Function(code + '\nreturn saveCurrentPageDownload;')();
}

test('published download observes an early waiter rejection and waits for the outstanding click', async () => {
  const save = await guideDownload();
  let rejectDownload, finishClick, clickStarted;
  const started = new Promise(resolve => { clickStarted = resolve; });
  const waiting = new Promise((_resolve, reject) => { rejectDownload = reject; });
  const clicking = new Promise(resolve => { finishClick = resolve; });
  const timeout = new Error('synthetic download timeout');
  let settled = false;
  const result = save({ waitForEvent: () => waiting }, { click: () => { clickStarted(); return clicking; } }, '/synthetic/file');
  // Observe our own test promise immediately too. An unhandled rejection from
  // a detached waiter would fail node:test independently at the next turn.
  const checked = assert.rejects(result, error => error === timeout).then(() => { settled = true; });
  await started;
  rejectDownload(timeout);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a timed-out waiter must not race a still-running click');
  finishClick();
  await checked;
});

test('published download handles click rejection and awaits saveAs success or failure', async () => {
  const save = await guideDownload();
  const clickError = new Error('synthetic locator failure'), saveError = new Error('synthetic disk failure');
  let rejectDownload;
  const waiting = new Promise((_resolve, reject) => { rejectDownload = reject; });
  const failedClick = save({ waitForEvent: () => waiting }, { click: async () => { throw clickError; } }, '/synthetic/file');
  const checked = assert.rejects(failedClick, error => error === clickError);
  await new Promise(resolve => setImmediate(resolve));
  rejectDownload(new Error('later download timeout'));
  await checked;
  for (const failSave of [false, true]) {
    let finishSave, saveStarted, settled = false;
    const started = new Promise(resolve => { saveStarted = resolve; });
    const saving = new Promise(resolve => { finishSave = resolve; });
    const calls = [];
    const download = { async saveAs(filePath) {
      calls.push(filePath); saveStarted(); await saving;
      if (failSave) throw saveError;
    } };
    const result = save({ waitForEvent: (event, options) => {
      assert.equal(event, 'download'); assert.equal(options.timeout, 20000);
      return Promise.resolve(download);
    } }, { click: async options => { assert.equal(options.timeout, 20000); } }, '/synthetic/file');
    const observed = (failSave ? assert.rejects(result, error => error === saveError) : result)
      .then(() => { settled = true; });
    await started; assert.equal(settled, false);
    finishSave(); await observed;
    assert.deepEqual(calls, ['/synthetic/file']);
  }
});

test('permission is required before host identity, local setup or native unlock', async () => {
  for (const args of [['start'], ['authorize'], ['authorize', '--origin', origin]]) {
    assert.throws(() => gosArguments(args), /authorization_permission_required/);
    await assert.rejects(gosRun(args), /authorization_permission_required/);
  }
  assert.throws(() => gosArguments(['start', '--confirm', '--service-url', origin]), /unsupported_option/);
  assert.throws(() => gosArguments(['services']), /unknown_command/);
  const args = [
    'authorize',
    '--browser-session',
    crypto.randomUUID(),
    '--request',
    crypto.randomUUID(),
    '--origin',
    origin,
    '--confirm',
  ];
  assert.equal(gosArguments(args).command, 'authorize');
  assert.throws(() => gosArguments([...args, '--channel', 'chrome']), /unsupported_option/);

});

test('session namespace retains full identity while fitting native Windows atomic-write paths', () => {
  const session = '44444444-4444-4444-8444-444444444444';
  const root = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\browser-authorization-test-abcdef';
  const directory = browserSessionDirectory(root, identity, session);
  assert.match(path.basename(directory), /^[a-f0-9]{64}$/);
  assert.ok(path.join(directory, `authorization.json.${crypto.randomUUID()}.tmp`).length < 260);
  for (const [who, id] of [
    [{ ...identity, company: '33333333-3333-4333-8333-333333333333' }, session],
    [{ ...identity, member: '33333333-3333-4333-8333-333333333333' }, session],
    [identity, crypto.randomUUID()],
  ]) assert.notEqual(browserSessionDirectory(root, who, id), directory);
  assert.throws(() => browserSessionDirectory(root, { ...identity, company: '../' }, session), /host_identity_required/);
});

test(
  'authorization capability is exact, expiring, private and consumed at return',
  { skip: !supported },
  async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'browser-authorization-test-'));
    const helper = await nativeHelper(root),
      session = crypto.randomUUID(),
      directory = browserSessionDirectory(root, identity, session);
    await ensurePrivateDirectory(directory, helper);
    const now = Date.now(),
      config = { directory, helper, identity, leaseId: session, startedAt: now, expiresAt: now + LEASE_MS };
    let at = 'https://esia.gosuslugi.ru/login/',
      cancelled = false,
      permits = 0;
    const flow = {
      binding: {},
      callbackSeen: false,
      error: null,
      hasAuthenticatedReturn: false,
      allowSecret() {
        assert.equal(this.callbackSeen, false);
      },
    };
    const portal = { service: { origin }, serviceFlow: flow, page: { url: () => at }, authLocked: false };
    const broker = createAuthorizationBroker({
      config,
      portal,
      permit: async () => {
        permits++;
      },
      port: 12345,
      onCancel: async () => {
        cancelled = true;
      },
      show: async () => {},
    });
    await broker.refresh();
    const original = broker.authorization;
    assert.equal(
      (await readAuthorization(root, identity, session, original.requestId, origin, helper)).token,
      broker.token,
    );
    const authorizationFile = path.join(directory, 'authorization.json');
    for (const change of [
      { port: 0 },
      { token: 'bad' },
      { brokerPid: 1 },
      // Native Windows writes are deliberately synchronous and can take more
      // than a second on a busy runner. Keep this descriptor impossible for
      // the whole test instead of relying on a short wall-clock offset that
      // may become valid before readAuthorization() inspects it.
      { startedAt: original.expiresAt + 1 },
    ]) {
      await atomicWrite(authorizationFile, JSON.stringify({ ...original, ...change }), helper);
      await assert.rejects(readAuthorization(root, identity, session, original.requestId, origin, helper),
        /authorization_request_mismatch/);
    }
    await atomicWrite(authorizationFile, JSON.stringify(original), helper);
    for (const [who, id, site] of [
      [{ ...identity, company: '33333333-3333-4333-8333-333333333333' }, original.requestId, origin],
      [{ ...identity, accountId: crypto.randomUUID() }, original.requestId, origin],
      [identity, crypto.randomUUID(), origin],
      [identity, original.requestId, 'https://different.example.org'],
    ])
      await assert.rejects(readAuthorization(root, who, session, id, site, helper));
    const lease = crypto.randomUUID(),
      packet = { sessionId: session, requestId: original.requestId, authorizationLease: lease };
    await assert.rejects(broker.handle({ ...packet, command: 'auth-state' }), /authorization_claim_required/);
    const claim = {
      ...packet,
      command: 'claim',
      origin,
      ...identity,
      confirmed: true,
      guardPid: process.pid,
    };
    for (const change of [
      { confirmed: false },
      { origin: 'https://different.example.org' },
      { member: 'wrong' },
      { accountId: crypto.randomUUID() },
      { requestId: crypto.randomUUID() },
    ])
      await assert.rejects(broker.handle({ ...claim, ...change }));
    assert.equal(portal.authLocked, false);
    at = 'about:blank';
    const firstDocument = setTimeout(() => { at = 'https://esia.gosuslugi.ru/login/'; }, 100);
    try { await broker.handle(claim); } finally { clearTimeout(firstDocument); }
    assert.equal(portal.authLocked, true);
    await assert.rejects(
      broker.handle({ ...claim, authorizationLease: crypto.randomUUID() }),
      /authorization_already_claimed/,
    );
    await assert.rejects(broker.handle({ ...packet, command: 'complete' }), /authorization_return_required/);
    await broker.handle({ ...packet, command: 'protect-input', text: '123456' });
    assert.equal(broker.redact('Code 123456'), 'Code [redacted]');
    config.expiresAt = Date.now() - 1;
    await assert.rejects(broker.handle({ ...packet, command: 'auth-state' }), /session_expired/);
    config.expiresAt = now + LEASE_MS;
    flow.callbackSeen = true;
    flow.hasAuthenticatedReturn = true;
    const pendingReturn = await broker.handle({ ...packet, command: 'auth-state' });
    assert.equal(pendingReturn.atAuth, false, 'callback has revoked auth input');
    assert.equal(pendingReturn.returning, true);
    assert.equal(pendingReturn.returned, false, 'HTTP response alone is not document commit');
    at = origin + '/cabinet';
    assert.equal((await broker.handle({ ...packet, command: 'auth-state' })).returned, true);
    await broker.handle({ ...packet, command: 'complete' });
    assert.equal(portal.authLocked, false);
    assert.equal(cancelled, false);
    await assert.rejects(fs.stat(path.join(directory, 'authorization.json')), /ENOENT/);
    await assert.rejects(
      broker.handle({ ...packet, command: 'auth-state' }),
      /authorization_request_mismatch/,
    );
    await broker.refresh();
    assert.equal(broker.authorization, null, 'one transaction cannot create a second request');
    assert.ok(permits >= 10);

    // A fresh synthetic SSO transaction has already received its callback HTTP
    // response, but Playwright has not committed the caller document yet. The
    // broker must grant only return observation, never invoke allowSecret or
    // prompt for a key while the separate document commit is still pending.
    const ssoSession = crypto.randomUUID();
    const ssoDirectory = browserSessionDirectory(root, identity, ssoSession);
    await ensurePrivateDirectory(ssoDirectory, helper);
    at = 'https://esia.gosuslugi.ru/login/';
    const sso = createAuthorizationBroker({
      config: { ...config, directory: ssoDirectory, leaseId: ssoSession }, portal,
      permit: async () => { permits++; }, port: 12345,
      onCancel: async () => {}, show: async () => {},
    });
    await sso.refresh();
    const ssoPacket = { ...packet, sessionId: ssoSession, requestId: sso.authorization.requestId };
    assert.deepEqual(await sso.handle({ ...claim, ...ssoPacket }),
      { claimed: true, returning: true, expiresAt: config.expiresAt });
    assert.equal((await sso.handle({ ...ssoPacket, command: 'auth-state' })).returned, false);
    at = origin + '/cabinet';
    assert.equal((await sso.handle({ ...ssoPacket, command: 'auth-state' })).returned, true);
    await sso.handle({ ...ssoPacket, command: 'complete' });
    assert.equal(sso.authorization, null);
    await fs.rm(root, { recursive: true, force: true });
  },
);

test('local protocol rejects endpoints without a private bounded capability', () => {
  for (const value of [
    { port: 80, token: 'bad' },
    { port: 0, token: 'a'.repeat(64) },
    { port: 65536, token: 'a'.repeat(64) },
  ])
    assert.throws(() => requestLocal(value, {}), /local_control_invalid/);
});

test('claim after an SSO callback waits without credentials until its exact return is verified',
  { skip: !supported }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'late-callback-claim-'));
    try {
      const helper = await nativeHelper(root);
      for (const stage of ['response_pending', 'document_pending', 'role_pending']) {
        const session = crypto.randomUUID(), leaseId = crypto.randomUUID();
        const directory = browserSessionDirectory(root, identity, session);
        await ensurePrivateDirectory(directory, helper);
        const now = Date.now(), service = serviceForOrigin(origin), flow = new ServiceFlow(service);
        flow.observeNavigation('https://esia.gosuslugi.ru/aas/oauth2/ac?' + new URLSearchParams({
          redirect_uri: origin + '/callback', state: 'synthetic-state', client_id: 'SYNTHETIC', response_type: 'code',
        }));
        let returned = false;
        const portal = { service, serviceFlow: flow, authLocked: false,
          page: { url: () => stage === 'role_pending' ? 'https://roles.gosuslugi.ru/roles' : origin + '/callback' } };
        const broker = createAuthorizationBroker({
          config: { directory, helper, identity, leaseId: session, startedAt: now, expiresAt: now + LEASE_MS },
          portal, permit: async () => {}, port: 12345, onCancel: async () => {}, show: async () => {},
          hasReturned: () => returned && flow.hasAuthenticatedReturn,
        });
        await broker.refresh();
        const packet = { sessionId: session, requestId: broker.authorization.requestId, authorizationLease: leaseId };
        const callback = origin + '/callback?state=synthetic-state&code=synthetic-code';
        flow.observeNavigation(callback);
        if (stage !== 'response_pending') flow.observeResponse(callback, 200);
        const authorizer = new EsiaAuthorizer({ identity, leaseId, guardPid: process.pid, authorization: { origin } },
          { permit: async () => {}, onPhase: async () => {} });
        authorizer.call = (command, extra = {}) => broker.handle({ ...packet, command, ...extra });
        assert.equal((await authorizer.claim()).returning, true, stage);
        assert.equal(authorizer.returnOnly, true);
        assert.equal(authorizer.completed, false, 'claim is not proof of a committed callback');
        assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
        await assert.rejects(authorizer.call('protect-input', { text: 'synthetic-secret' }),
          /service_authorization_request_required/);
        await assert.rejects(authorizer.call('complete'), /authorization_return_required/);
        const state = await authorizer.call('auth-state');
        assert.equal(state.atAuth, false); assert.equal(state.returning, true); assert.equal(state.returned, false);
        assert.equal(state.personalRolePending, stage === 'role_pending');
        // Keep a real manual chooser resumable without a decrypted record.
        if (stage === 'role_pending') {
          assert.equal(await authorizer.authenticate(null, 'manual'), false);
          assert.equal(authorizer.manualReason, 'role_choice_required');
        }
        flow.observeResponse(callback, 200); returned = true;
        assert.equal(await authorizer.authenticate(null), true);
        assert.equal(authorizer.completed, true);
        assert.equal(broker.authorization, null);
        await assert.rejects(fs.stat(path.join(directory, 'authorization.json')), /ENOENT/);
        await assert.rejects(authorizer.call('auth-state'), /authorization_request_mismatch/);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

test('a return-only authorizer never falls back to observing or entering credentials', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  authorizer.call = async command => {
    assert.equal(command, 'auth-state'); return { atAuth: true, returning: false, returned: false };
  };
  authorizer.returnOnly = true;
  await assert.rejects(authorizer.authenticate(null), /authorization_return_required/);
});

test('the native-supervised worker completes a pending callback without any credential vault or key helper',
  { skip: !supported, timeout: 30000 }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'return-only-worker-'));
    let child, server;
    try {
      const helper = await nativeHelper(root), session = crypto.randomUUID(), now = Date.now();
      const directory = path.join(root, 'worker');
      const brokerDirectory = browserSessionDirectory(root, identity, session);
      await ensurePrivateDirectory(directory, helper); await ensurePrivateDirectory(brokerDirectory, helper);
      const flow = { binding: {}, callbackSeen: true, callbackAccepted: true, hasAuthenticatedReturn: true,
        error: null, allowSecret() { throw new Error('secret access must stay revoked'); } };
      let returned = false, claims = 0, observations = 0;
      const broker = createAuthorizationBroker({
        config: { directory: brokerDirectory, helper, identity, leaseId: session,
          startedAt: now, expiresAt: now + LEASE_MS },
        portal: { service: { origin }, serviceFlow: flow, page: { url: () => origin + '/callback' } },
        permit: async () => {}, port: 12345, onCancel: async () => {}, show: async () => {},
        hasReturned: () => returned,
      });
      await broker.refresh();
      server = http.createServer(async (req, res) => {
        try {
          assert.equal(req.headers.authorization, `Bearer ${broker.token}`);
          let body = ''; for await (const chunk of req) body += chunk;
          const packet = JSON.parse(body);
          const result = await broker.handle(packet);
          if (packet.command === 'claim') { claims++; assert.equal(result.returning, true); }
          if (packet.command === 'auth-state') {
            // The first observation explicitly returns pending; the next one
            // supplies the synthetic document proof. No timing-based race can
            // make this fixture exercise the already-completed shortcut.
            observations++; returned = true;
          }
          res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.code || 'fixture_failed' })); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const authorization = { ...broker.authorization, port: server.address().port };
      child = spawn(helper, ['guard', process.execPath,
        fileURLToPath(new URL('../scripts/worker.mjs', import.meta.url)), '20000'],
      { env: childEnvironment(), stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true });
      const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      child.stdin.end(JSON.stringify({ identity, root, directory, helper,
        // Intentionally impossible: a regression into vault unlock must fail,
        // never show a real OS prompt or access the user's credential storage.
        keyHelper: path.join(root, 'forbidden-key-helper'), guardPid: child.pid,
        leaseId: crypto.randomUUID(), startedAt: now, expiresAt: now + LEASE_MS,
        mode: 'authorize', authorization }) + '\n');
      await exited;
      const receipt = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
      assert.equal(receipt.phase, 'authorized', JSON.stringify(receipt));
      assert.equal(receipt.authorization.status, 'callback_verified');
      assert.equal(claims, 1); assert.ok(observations >= 2);
      await assert.rejects(fs.stat(path.join(directory, 'vault.json')), /ENOENT/);
      assert.equal(broker.authorization, null);
    } finally {
      if (child?.exitCode === null) child.kill();
      server?.close(); server?.closeAllConnections();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('an accepted callback permits one bounded personal-role click but no earlier or ambiguous choice',
  { skip: !supported }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'role-after-callback-'));
    try {
      const helper = await nativeHelper(root), session = crypto.randomUUID();
      const directory = browserSessionDirectory(root, identity, session);
      await ensurePrivateDirectory(directory, helper);
      const now = Date.now();
      const config = { directory, helper, identity, leaseId: session,
        startedAt: now, expiresAt: now + LEASE_MS };
      const flow = { binding: {}, callbackSeen: false, callbackAccepted: false, error: null,
        allowSecret() { assert.equal(this.callbackSeen, false); } };
      let location = 'https://esia.gosuslugi.ru/login/', cards = 1, clicks = 0, marked = 0;
      const heading = { filter() { return this; }, waitFor: async () => {}, count: async () => 1 };
      const target = { filter() { return this; }, waitFor: async () => {}, count: async () => cards,
        isEnabled: async () => true,
        evaluate: async () => ({ tag: 'span', length: 12, href: null }),
        elementHandle: async () => ({ isVisible: async () => true, isEnabled: async () => true,
          evaluate: async () => ({ connected: true, tag: 'span', label: 'Частное лицо', href: null }),
          click: async () => { clicks++; location = origin + '/cabinet'; },
          dispose: async () => {} }) };
      const fields = { filter() { return this; }, count: async () => 0 };
      const portal = { service: { origin }, serviceFlow: flow, authLocked: false,
        page: { url: () => location, getByRole: () => heading, getByText: () => target,
          locator: selector => selector === 'body' ? { innerText: async () => 'Войти как Частное лицо' } : fields } };
      const broker = createAuthorizationBroker({ config, portal, permit: async () => {}, port: 12345,
        onCancel: async () => {}, show: async () => {}, hasReturned: () => false,
        onPersonalRoleChoice: () => marked++ });
      await broker.refresh();
      const packet = { sessionId: session, requestId: broker.authorization.requestId,
        authorizationLease: crypto.randomUUID() };
      await broker.handle({ ...packet, command: 'claim', origin, ...identity,
        confirmed: true, guardPid: process.pid });
      location = 'https://roles.gosuslugi.ru/roles';
      await assert.rejects(broker.handle({ ...packet, command: 'choose-personal-role' }), /role_chooser_required/);
      flow.callbackSeen = true;
      assert.equal((await broker.handle({ ...packet, command: 'auth-state' })).personalRolePending, false);
      flow.callbackAccepted = true;
      assert.equal((await broker.handle({ ...packet, command: 'auth-state' })).personalRolePending, true);
      cards = 2;
      assert.deepEqual(await broker.handle({ ...packet, command: 'review-personal-role' }),
        { state: 'ambiguous_card', personalCardCount: 2 });
      assert.equal(clicks, 0, 'review must not dispatch an identity choice');
      assert.deepEqual(await broker.handle({ ...packet, command: 'choose-personal-role' }), { selected: false });
      assert.equal(clicks, 0);
      cards = 1;
      assert.deepEqual(await broker.handle({ ...packet, command: 'review-personal-role' }),
        { state: 'personal_available', personalCardCount: 1 });
      assert.deepEqual(await broker.handle({ ...packet, command: 'choose-personal-role' }), { selected: true });
      assert.equal(marked, 1); assert.equal(clicks, 1);
      await assert.rejects(broker.handle({ ...packet, command: 'choose-personal-role' }), /role_chooser_required/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

test('idle authorizer closes on peer loss and notices a human-completed return', async () => {
  for (const kind of ['lost', 'returned']) {
    const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
    let queries = 0;
    authorizer.call = async command => {
      assert.equal(command, 'auth-state'); queries++;
      if (kind === 'lost') throw Object.assign(new Error('session_unreachable'), { code: 'session_unreachable' });
      return { returned: true };
    };
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('peer cleanup did not run')), 4000);
        const done = value => { authorizer.completed = true; resolve(value); };
        authorizer.watchPeer({ isBusy: () => false,
          onReturned: async () => done('returned'), onLost: async () => done('lost') });
      });
      assert.equal(result, kind); assert.equal(queries, 1);
    } finally { clearTimeout(timer); authorizer.completed = true; await authorizer.close(); }
  }
});

test('manual ESIA submission resumes the same delegated authorizer once', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  let reads = 0;
  let resumed = 0;
  authorizer.manualPostCount = 1;
  authorizer.call = async command => {
    assert.equal(command, 'auth-state');
    reads++;
    return { atAuth: true, returned: false, postCount: 2 };
  };
  const timeout = setTimeout(() => { authorizer.completed = true; }, 5000);
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('manual submission was not resumed')), 4000);
      authorizer.watchPeer({ isBusy: () => false,
        onReturned: async () => reject(new Error('callback did not return')),
        onProgress: async () => { resumed++; clearTimeout(deadline); resolve(); },
        onLost: async () => reject(new Error('peer was lost')) });
    });
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(resumed, 1);
    assert.ok(reads >= 2);
  } finally { clearTimeout(timeout); authorizer.completed = true; await authorizer.close(); }
});

test('delegated manual steps expose only one bounded reason category', async () => {
  const phases = [], calls = [];
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async phase => phases.push(phase) });
  authorizer.call = async command => { calls.push(command); return {}; };
  assert.equal(await authorizer.manual('consent_required'), false);
  assert.equal(authorizer.manualReason, 'consent_required');
  assert.deepEqual(phases, ['user_required']);
  assert.deepEqual(calls, ['show']);
  await assert.rejects(authorizer.manual('private page text'), /auth_manual_reason_invalid/);
});

test('post-callback personal role resumes through its single fixed action without credential input', async () => {
  const calls = [], phases = [];
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async phase => phases.push(phase) });
  let selected = false;
  authorizer.call = async command => {
    calls.push(command);
    if (command === 'auth-state') return selected
      ? { returned: true }
      : { returned: false, personalRolePending: true, postCount: 1 };
    if (command === 'choose-personal-role') { selected = true; return { selected: true }; }
    if (command === 'complete') return { returned: true };
    throw new Error(`unexpected ${command}`);
  };
  assert.equal(await authorizer.authenticate({ login: 'unused', password: 'unused' }), true);
  assert.deepEqual(calls, ['auth-state', 'choose-personal-role', 'auth-state', 'complete']);
  assert.deepEqual(phases, ['authenticating', 'authorized']);
  assert.equal(authorizer.roleSent, true);
});

test('pre-callback personal role waits for asynchronous cards and the dispatched navigation', async () => {
  const phases = [], operations = [];
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async phase => phases.push(phase) });
  let reads = 0, clicks = 0;
  authorizer.call = async (command, packet) => {
    if (command === 'auth-state') return { atAuth: true, returned: reads >= 4, postCount: 1 };
    if (command === 'complete') return { returned: true };
    assert.equal(command, 'auth-operation', 'a loading role chooser must not show a manual prompt');
    operations.push(packet.operation);
    if (packet.operation === 'observe') {
      reads++;
      // The public role application renders its heading before fetching cards.
      // After the one click it can also retain that document during navigation.
      const count = reads === 1 ? 0 : 1;
      return { text: 'Войти как', queries: {
        login: { count: 0 }, password: { count: 0 }, code: { count: 0 },
        checkboxes: { count: 0, fields: [] }, personal: { count, fields: count ? [{
          tag: 'p', length: 12, label: 'Частное лицо', disabled: false, href: null,
        }] : [] },
      } };
    }
    assert.equal(packet.operation, 'click', 'no credential input is needed on a role chooser');
    clicks++;
    assert.equal(packet.expectedLabel, 'Частное лицо');
    return { ok: true };
  };
  assert.equal(await authorizer.authenticate({}), true);
  assert.equal(clicks, 1, 'the same visible card after dispatch never authorizes a second click');
  assert.equal(authorizer.roleSent, true);
  assert.deepEqual(phases, ['authenticating', 'authorized']);
  assert.ok(operations.filter(value => value === 'observe').length >= 4);
});

test('ambiguous or explicitly manual pre-callback roles still require the human', async () => {
  for (const [requestedRole, count] of [['personal', 2], ['manual', 0]]) {
    const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
    const calls = [];
    authorizer.call = async (command, packet) => {
      calls.push(command);
      if (command === 'auth-state') return { atAuth: true, returned: false };
      if (command === 'show') return {};
      assert.equal(packet.operation, 'observe');
      return { text: 'Войти как', queries: { login: { count: 0 }, password: { count: 0 },
        code: { count: 0 }, checkboxes: { fields: [] }, personal: { count } } };
    };
    assert.equal(await authorizer.authenticate({}, requestedRole), false);
    assert.equal(authorizer.manualReason, 'role_choice_required');
    assert.equal(authorizer.roleSent, false);
    assert.deepEqual(calls, ['auth-state', 'auth-operation', 'show']);
  }
});

test('missing personal cards do not renew their readiness budget on resume', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  authorizer.personalRoleDeadline = Date.now() - 1;
  authorizer.call = async (command, packet) => {
    if (command === 'auth-state') return { atAuth: true, returned: false };
    if (command === 'show') return {};
    assert.equal(packet.operation, 'observe');
    return { text: 'Войти как', queries: { login: { count: 0 }, password: { count: 0 },
      code: { count: 0 }, checkboxes: { fields: [] }, personal: { count: 0 } } };
  };
  const deadline = authorizer.personalRoleDeadline;
  assert.equal(await authorizer.authenticate({}), false);
  assert.equal(await authorizer.authenticate({}), false);
  assert.equal(authorizer.personalRoleDeadline, deadline);
  assert.equal(authorizer.manualReason, 'role_choice_required');
  assert.equal(authorizer.roleSent, false);
});

test('role review freshly inspects the bound screen without exposing auth content or choosing an identity', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  let count = 0, inputs = false, consent = false;
  const calls = [];
  authorizer.call = async (command, packet) => {
    calls.push(command);
    if (command === 'auth-state') return { atAuth: true, returned: false };
    assert.equal(packet.operation, 'observe', 'review is read-only');
    return { text: consent ? 'Войти как. Согласие на передачу данных' : 'Войти как. Синтетическое имя',
      queries: { login: { count: inputs ? 1 : 0 }, password: { count: 0 }, code: { count: 0 },
        checkboxes: { fields: [] }, personal: { count, fields: [{ tag: 'p', length: 12,
          label: 'Синтетическое имя', disabled: false, href: null }] } } };
  };
  assert.deepEqual(await authorizer.reviewRole(), { state: 'missing_card', personalCardCount: 0 });
  count = 1;
  const ready = await authorizer.reviewRole();
  assert.deepEqual(ready, { state: 'personal_available', personalCardCount: 1 });
  assert.doesNotMatch(JSON.stringify(ready), /имя|label|text|href|password/i);
  count = 2;
  assert.deepEqual(await authorizer.reviewRole(), { state: 'ambiguous_card', personalCardCount: 2 });
  inputs = true;
  assert.deepEqual(await authorizer.reviewRole(), { state: 'authentication_fields_present' });
  inputs = false; consent = true;
  assert.deepEqual(await authorizer.reviewRole(), { state: 'unsupported_screen' });
  assert.equal(authorizer.roleSent, false);
  assert.deepEqual([...new Set(calls)], ['auth-state', 'auth-operation']);
});

test('post-callback review can resume a proven non-dispatch but never an ambiguous click', async () => {
  for (const ambiguous of [false, true]) {
    const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
    let attempts = 0, selected = false;
    authorizer.call = async command => {
      if (command === 'auth-state') return { returned: selected, personalRolePending: !selected };
      if (command === 'choose-personal-role') {
        attempts++;
        if (ambiguous) throw new RuntimeError('operation_result_unknown');
        if (attempts === 1) return { selected: false };
        selected = true; return { selected: true };
      }
      if (command === 'review-personal-role') return { state: 'personal_available', personalCardCount: 1 };
      if (command === 'show' || command === 'complete') return {};
      throw new Error(`unexpected ${command}`);
    };
    if (ambiguous) {
      await assert.rejects(authorizer.authenticate({}), /operation_result_unknown/);
      assert.equal(authorizer.roleSent, true);
      assert.deepEqual(await authorizer.reviewRole(), { state: 'choice_dispatched' });
      assert.equal(attempts, 1);
    } else {
      assert.equal(await authorizer.authenticate({}), false);
      assert.equal(authorizer.roleSent, false);
      assert.deepEqual(await authorizer.reviewRole(), { state: 'personal_available', personalCardCount: 1 });
      assert.equal(await authorizer.authenticate({}), true);
      assert.equal(attempts, 2, 'only the second operation actually dispatches a click');
    }
  }
});

test('delegated role continuation first inspects the screen and resumes only the default personal intent', async () => {
  const state = { sessionId: crypto.randomUUID(), phase: 'user_required', roleChoiceRequired: true,
    loginRole: 'personal', authorization: { status: 'user_required' } };
  assert.deepEqual(withSessionContinuation(state).continuation.arguments,
    ['review-role', '--session', state.sessionId]);
  const wait = await waitForSessionChange(async () => state, {
    '--session': state.sessionId, '--after-phase': 'authenticating', '--timeout-seconds': '1',
  });
  assert.deepEqual(wait.continuation.arguments, ['review-role', '--session', state.sessionId]);
  assert.deepEqual(withSessionContinuation({ ...state, roleReview: { state: 'personal_available' } }).continuation.arguments,
    ['resume', '--session', state.sessionId]);
  for (const reviewed of [
    { ...state, loginRole: 'manual', roleReview: { state: 'personal_available' } },
    { ...state, roleReview: { state: 'missing_card' } },
    { ...state, roleReview: { state: 'choice_dispatched' } },
  ]) assert.equal(withSessionContinuation(reviewed).continuation.arguments[0], 'wait');
});

test('client discovery is static and the SDK does not expose a secret or launch a browser', async () => {
  assert.equal(gosArguments(['client']).command, 'client');
  assert.throws(() => gosArguments(['client', '--confirm']), /unsupported_option/);
  const sdk = await fs.readFile(new URL('../scripts/playwright-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sdk, /vaultKey|decryptRecord|deleteVaultKey|launchPersistentContext|launchOwnedBrowser/);
  assert.match(sdk, /--request-title/,
    'delegated ЕСИА-вход должен передать название разговора системному unlock prompt');
  const { createEsiaAuthorization } = await import('../scripts/playwright-client.mjs');
  await assert.rejects(createEsiaAuthorization(null, {}), /authorization_permission_required/);
});

test('callback beginning between auth-state and observation waits without another credential operation', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  const calls = [];
  let stateReads = 0;
  authorizer.call = async (command, packet) => {
    calls.push(command);
    if (command === 'auth-state') {
      stateReads++;
      return stateReads === 1 ? { atAuth: true, returned: false }
        : { atAuth: false, returning: true, returned: stateReads >= 3 };
    }
    if (command === 'auth-operation' && packet.operation === 'observe')
      throw Object.assign(new Error('service_authorization_request_required'), { code: 'service_authorization_request_required' });
    assert.equal(command, 'complete', 'no type/click operation is allowed after callback');
    return { returned: true };
  };
  assert.equal(await authorizer.authenticate({}), true);
  assert.equal(authorizer.completed, true);
  assert.deepEqual(calls, ['auth-state', 'auth-operation', 'auth-state', 'auth-state', 'complete']);
});

test('a popup closing during the final credential operation waits for return without replaying input', async () => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  const operations = [];
  let returning = false;
  authorizer.call = async (command, packet) => {
    if (command === 'auth-state') return { atAuth: !returning, returning, returned: returning };
    if (command === 'complete') return { returned: true };
    assert.equal(command, 'auth-operation'); operations.push(packet.operation);
    if (packet.operation === 'observe') return { text: '', queries: {
      login: { count: 0 }, password: { count: 1 }, code: { count: 0 },
      checkboxes: { fields: [] }, personal: { count: 0 },
    } };
    assert.equal(packet.operation, 'type'); returning = true;
    throw Object.assign(new Error('authorization_return_in_progress'), { code: 'authorization_return_in_progress' });
  };
  assert.equal(await authorizer.authenticate({ password: 'synthetic-password' }), true);
  assert.equal(authorizer.passwordSent, true);
  assert.deepEqual(operations, ['observe', 'type'], 'no subsequent submit or second input');
});

test('callback request revokes the next secret character even before the old auth URL changes', async () => {
  let callbackSeen = false, disposed = false;
  const typed = [];
  const element = { evaluate: async () => 'INPUT', fill: async () => {},
    type: async character => { typed.push(character); callbackSeen = true; },
    dispose: async () => { disposed = true; } };
  const target = { filter() { return this; }, count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true, elementHandle: async () => element };
  const page = { url: () => 'https://esia.gosuslugi.ru/login', locator: () => target };
  const flow = { allowSecret() {
    if (callbackSeen) throw Object.assign(new Error('service_authorization_request_required'), { code: 'service_authorization_request_required' });
  } };
  await assert.rejects(authRpc(page, flow, { operation: 'type', query: { css: 'input' }, text: '123456' }, async () => {}),
    /service_authorization_request_required/);
  assert.deepEqual(typed, ['1']); assert.equal(disposed, true);
});

test('auth click remains bound to its node and a callback during the final permit cancels dispatch', async () => {
  let permits = 0, clicked = false, disposed = false, callbackSeen = false;
  const element = { innerText: async () => 'Войти', click: async () => { clicked = true; },
    dispose: async () => { disposed = true; } };
  const target = { filter() { return this; }, count: async () => 1, innerText: async () => 'Войти',
    isVisible: async () => true, isEnabled: async () => true, elementHandle: async () => element,
    click: () => assert.fail('locator must not resolve again on a different document') };
  const page = { url: () => 'https://esia.gosuslugi.ru/login', locator: () => target };
  const flow = { allowSecret() {
    if (callbackSeen) throw new Error('service_authorization_request_required');
  } };
  await assert.rejects(authRpc(page, flow, { operation: 'click', query: { css: 'button' } },
    async () => { if (++permits === 2) callbackSeen = true; }), /service_authorization_request_required/);
  assert.equal(permits, 2); assert.equal(clicked, false); assert.equal(disposed, true);
});

test('local authorizer HTTP transport preserves bounded service failure but rejects private or invalid fields', async t => {
  let value = { error: 'service_http_error', httpStatus: 503, httpOrigin: 'https://ej.sudrf.ru',
    message: 'private body', url: 'https://ej.sudrf.ru/callback?code=private-code' };
  const server = http.createServer((_request, response) => {
    response.writeHead(400); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const control = { port: server.address().port, token: 'a'.repeat(64) };
  const request = () => requestLocal(control, { command: 'auth-state' });
  await assert.rejects(request(), error => {
    assert.equal(error.code, 'service_http_error');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.httpOrigin, 'https://ej.sudrf.ru');
    assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
  for (const patch of [{ httpStatus: '503' }, { httpStatus: 399 }, { httpStatus: 600 },
    { httpOrigin: 'https://ej.sudrf.ru/callback?code=private-code' },
    { httpOrigin: 'https://private@ej.sudrf.ru' }, { httpOrigin: 'http://ej.sudrf.ru' },
    { error: 'session_unreachable' }]) {
    const original = value; value = { ...original, ...patch };
    await assert.rejects(request(), error => !('httpStatus' in error) && !('httpOrigin' in error));
    value = original;
  }
});
