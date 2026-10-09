import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArguments as gosArguments, run as gosRun } from '../scripts/trelio-gosuslugi.mjs';
import { atomicWrite, nativeHelper, ensurePrivateDirectory } from '../scripts/native.mjs';
import { browserSessionDirectory, readAuthorization, requestLocal } from '../scripts/transport.mjs';
import { createAuthorizationBroker } from '../scripts/authorization.mjs';
import { LEASE_MS, RUNTIME_VERSION, RuntimeError } from '../scripts/core.mjs';
import { observeEsiaAuthorization, safeAuthorizationFailure } from '../scripts/playwright-client.mjs';
import { EsiaAuthorizer } from '../scripts/esia-authorizer.mjs';
import { authRpc } from '../scripts/auth-rpc.mjs';

const supported = ['darwin', 'win32'].includes(process.platform);
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
  const body = code.slice(code.indexOf('let login,'), code.indexOf('const lines = readline'));
  const helpers = [], events = [], clicks = [];
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
  const handle = await new AsyncFunction('page', 'context', 'browser', 'client',
    'createEsiaAuthorization', 'observeEsiaAuthorization', 'safeAuthorizationFailure',
    'emit', 'lines', 'origin', body + '\nreturn handle;')(page, context, browser,
      { options: {}, configHome: '/synthetic' }, create, observeEsiaAuthorization,
      safeAuthorizationFailure, value => events.push(value), { close() {} }, 'https://service.example.org');
  return { handle, helpers, page, context, browser, events, clicks };
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
    // broker must wait without invoking allowSecret or prompting for a key.
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
    const commit = setTimeout(() => { at = origin + '/cabinet'; }, 100);
    try {
      assert.deepEqual(await sso.handle({ ...claim, sessionId: ssoSession,
        requestId: sso.authorization.requestId }), { claimed: false, returned: true });
      assert.equal(sso.authorization, null);
    } finally { clearTimeout(commit); }
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
      assert.deepEqual(await broker.handle({ ...packet, command: 'choose-personal-role' }), { selected: false });
      assert.equal(clicks, 0);
      cards = 1;
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
