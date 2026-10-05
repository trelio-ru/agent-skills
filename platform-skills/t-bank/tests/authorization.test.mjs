import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArguments as bankArguments, run as bankRun } from '../scripts/trelio-t-bank.mjs';
import { nativeHelper, ensurePrivateDirectory } from '../scripts/native.mjs';
import { browserSessionDirectory, readAuthorization, requestLocal } from '../scripts/transport.mjs';
import { createAuthorizationBroker } from '../scripts/authorization.mjs';
import { LEASE_MS, RUNTIME_VERSION } from '../scripts/core.mjs';
import { TIdAuthorizer } from '../scripts/t-id-authorizer.mjs';
import { authRpc } from '../scripts/auth-rpc.mjs';

const supported = ['darwin', 'win32'].includes(process.platform);
const identity = {
  company: '11111111-1111-4111-8111-111111111111',
  member: '22222222-2222-4222-8222-222222222222',
};
const origin = 'https://ordinary.example.org';

test('delegated authorization permission is required before host identity, local setup or native unlock', async () => {
  assert.equal(bankArguments(['start']).command, 'start');
  for (const args of [['authorize'], ['authorize', '--origin', origin]]) {
    assert.throws(() => bankArguments(args), /authorization_permission_required/);
    await assert.rejects(bankRun(args), /authorization_permission_required/);
  }
  assert.throws(() => bankArguments(['start', '--confirm', '--service-url', origin]), /unsupported_option/);
  assert.throws(() => bankArguments(['services']), /unknown_command/);
  const args = [
    'authorize',
    '--browser-session',
    crypto.randomUUID(),
    '--request',
    crypto.randomUUID(),
    '--origin',
    origin,
    '--confirm',
    '--request-title',
    'Вход на сайт через T‑ID',
  ];
  assert.equal(bankArguments(args).command, 'authorize');
  assert.throws(() => bankArguments([...args, '--channel', 'chrome']), /unsupported_option/);

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
    let at = 'https://id.tbank.ru/auth/login/',
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
    for (const [who, id, site] of [
      [{ ...identity, company: '33333333-3333-4333-8333-333333333333' }, original.requestId, origin],
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
      { requestId: crypto.randomUUID() },
    ])
      await assert.rejects(broker.handle({ ...claim, ...change }));
    assert.equal(portal.authLocked, false);
    at = 'about:blank';
    const firstDocument = setTimeout(() => { at = 'https://id.tbank.ru/auth/login/'; }, 100);
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
    at = 'https://id.tbank.ru/auth/login/';
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

test('idle authorizer closes on peer loss and notices a human-completed return', async () => {
  for (const kind of ['lost', 'returned']) {
    const authorizer = new TIdAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
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

test('client discovery is static and the SDK does not expose a secret or launch a browser', async () => {
  assert.equal(bankArguments(['client']).command, 'client');
  assert.throws(() => bankArguments(['client', '--confirm']), /unsupported_option/);
  const sdk = await fs.readFile(new URL('../scripts/playwright-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sdk, /vaultKey|decryptRecord|deleteVaultKey|launchPersistentContext|launchOwnedBrowser/);
  const { createTIdAuthorization } = await import('../scripts/playwright-client.mjs');
  await assert.rejects(createTIdAuthorization(null, {}), /authorization_permission_required/);
});

test('callback beginning between auth-state and observation waits without another credential operation', async () => {
  const authorizer = new TIdAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
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
  const authorizer = new TIdAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  const operations = [];
  let returning = false;
  authorizer.call = async (command, packet) => {
    if (command === 'auth-state') return { atAuth: !returning, returning, returned: returning };
    if (command === 'complete') return { returned: true };
    assert.equal(command, 'auth-operation'); operations.push(packet.operation);
    if (packet.operation === 'observe') return { text: '', queries: {
      phone: { count: 0 }, fallbackphone: { count: 0 }, password: { count: 1 },
      username: { count: 0 }, code: { count: 0 }, codefields: { count: 0 }, submit: { count: 1 },
      declinepinbutton: { count: 0 }, declinepinlink: { count: 0 }, checkboxes: { fields: [] }, onlyinput: { count: 0 },
      passwordlabel: { count: 0 },
    } };
    assert.equal(packet.operation, 'type'); returning = true;
    throw Object.assign(new Error('authorization_return_in_progress'), { code: 'authorization_return_in_progress' });
  };
  assert.equal(await authorizer.authenticate({ password: 'synthetic-password' }), true);
  assert.equal(authorizer.passwordSent, true);
  assert.deepEqual(operations, ['observe', 'type'], 'no subsequent submit or second input');
});

test('saved TOTP waits through the empty post-submit T-ID document without replaying the code', async () => {
  const phases = [], operations = [];
  let stateReads = 0, observations = 0;
  const authorizer = new TIdAuthorizer({}, {
    permit: async () => {},
    onPhase: async (phase, reason) => phases.push({ phase, reason }),
  });
  const queries = (codeCount) => ({
    phone: { count: 0 }, fallbackphone: { count: 0 }, password: { count: 0 },
    username: { count: 0 }, code: { count: codeCount }, codefields: { count: codeCount },
    submit: { count: 0 }, declinepinbutton: { count: 0 }, declinepinlink: { count: 0 },
    checkboxes: { fields: [] }, onlyinput: { count: 0 }, passwordlabel: { count: 0 },
  });
  authorizer.call = async (command, packet) => {
    if (command === 'auth-state') {
      stateReads++;
      if (stateReads === 1) return { atAuth: true, returned: false, postCount: 1 };
      if (stateReads <= 3) return { atAuth: true, returned: false, postCount: 2 };
      return { atAuth: false, returned: true, postCount: 2 };
    }
    if (command === 'complete') return { returned: true };
    if (command === 'protect-input') return { protected: true };
    assert.equal(command, 'auth-operation');
    operations.push(packet.operation);
    if (packet.operation === 'type') return { typed: true };
    assert.equal(packet.operation, 'observe');
    observations++;
    if (observations <= 2) {
      return {
        text: 'Введите код из приложения для аутентификации',
        queries: queries(1),
      };
    }
    // T-ID has accepted the auto-submitted TOTP and temporarily exposes no
    // challenge controls before the verified relying-party callback commits.
    return { text: '', queries: queries(0) };
  };

  assert.equal(await authorizer.authenticate({ totp: 'JBSWY3DPEHPK3PXP' }), true);
  assert.equal(operations.filter(operation => operation === 'type').length, 1);
  assert.deepEqual(phases, [
    { phase: 'authenticating', reason: undefined },
    { phase: 'authorized', reason: undefined },
  ]);
});

test('T‑ID data-sharing consent is always left to the person in the bound page', async () => {
  const phases = [], operations = [], calls = [];
  const authorizer = new TIdAuthorizer({}, {
    permit: async () => {},
    onPhase: async value => phases.push(value),
  });
  authorizer.call = async (command, packet) => {
    calls.push(command);
    if (command === 'auth-state') return { atAuth: true, returned: false };
    assert.equal(command, 'auth-operation');
    operations.push(packet.operation);
    assert.equal(packet.operation, 'observe');
    return { text: 'Выберите данные, которые хотите передать сервису', queries: {
      phone: { count: 0 }, fallbackphone: { count: 0 }, password: { count: 0 },
      username: { count: 0 }, code: { count: 0 }, codefields: { count: 0 }, submit: { count: 1 },
      declinepinbutton: { count: 0 }, declinepinlink: { count: 0 }, checkboxes: { fields: [{ checked: false, label: 'Согласен на передачу данных' }] },
      onlyinput: { count: 0 }, passwordlabel: { count: 0 },
    } };
  };
  assert.equal(await authorizer.authenticate({}), false);
  assert.deepEqual(operations, ['observe'], 'the runtime must not click a consent control');
  assert.deepEqual(calls, ['auth-state', 'auth-operation'], 'manual T‑ID must not take focus without a show request');
  assert.deepEqual(phases, ['authenticating', 'user_required']);
});

test('callback request revokes the next secret character even before the old auth URL changes', async () => {
  let callbackSeen = false, disposed = false;
  const typed = [];
  const element = { evaluate: async callback => callback({ tagName: 'INPUT', readOnly: false, disabled: false }), fill: async () => {},
    type: async character => { typed.push(character); callbackSeen = true; },
    dispose: async () => { disposed = true; } };
  const target = { filter() { return this; }, count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true, elementHandle: async () => element };
  const page = { url: () => 'https://id.tbank.ru/auth/login', locator: () => target };
  const flow = { allowSecret() {
    if (callbackSeen) throw Object.assign(new Error('service_authorization_request_required'), { code: 'service_authorization_request_required' });
  } };
  await assert.rejects(authRpc(page, flow, { operation: 'type', query: { css: 'input' }, text: '123456' }, async () => {}),
    /service_authorization_request_required/);
  assert.deepEqual(typed, ['1']); assert.equal(disposed, true);
});

test('T-ID phone input does not duplicate the provider-owned Russian country prefix', async () => {
  let value = '+7';
  const typed = [], pressed = [];
  const element = {
    evaluate: async callback => callback({ tagName: 'INPUT', readOnly: false, disabled: false, value }),
    fill: async () => { value = '+7'; },
    type: async character => {
      typed.push(character);
      // This is the behavior of the real controlled T-ID field: clearing it
      // retains +7 and each typed character belongs to the national number.
      const national = value.replace(/\D/g, '').slice(1) + character;
      value = `+7${national.slice(0, 10)}`;
    },
    press: async key => { pressed.push(key); },
    dispose: async () => {},
  };
  const target = {
    filter() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    elementHandle: async () => element,
  };
  const page = { url: () => 'https://id.tbank.ru/auth/login', locator: () => target };
  const flow = { allowSecret() {} };

  await authRpc(page, flow, {
    operation: 'type',
    inputKind: 't-id-phone',
    query: { css: 'input[autocomplete="tel"]' },
    text: '+79991234567',
  }, async () => {});

  assert.equal(typed.join(''), '9991234567');
  assert.equal(value, '+79991234567');

  await authRpc(page, flow, {
    operation: 'submit-phone',
    query: { css: 'input[autocomplete="tel"]' },
    text: '+79991234567',
  }, async () => {});

  assert.deepEqual(pressed, ['Enter']);
});

test('auth click remains bound to its node and a callback during the final permit cancels dispatch', async () => {
  let permits = 0, clicked = false, disposed = false, callbackSeen = false;
  const element = { innerText: async () => 'Войти', click: async () => { clicked = true; },
    dispose: async () => { disposed = true; } };
  const target = { filter() { return this; }, count: async () => 1, innerText: async () => 'Войти',
    isVisible: async () => true, isEnabled: async () => true, elementHandle: async () => element,
    click: () => assert.fail('locator must not resolve again on a different document') };
  const page = { url: () => 'https://id.tbank.ru/auth/login', locator: () => target };
  const flow = { allowSecret() {
    if (callbackSeen) throw new Error('service_authorization_request_required');
  } };
  await assert.rejects(authRpc(page, flow, { operation: 'click', query: { css: 'button' } },
    async () => { if (++permits === 2) callbackSeen = true; }), /service_authorization_request_required/);
  assert.equal(permits, 2); assert.equal(clicked, false); assert.equal(disposed, true);
});
