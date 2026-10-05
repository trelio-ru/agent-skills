import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CourtPortal } from '../scripts/browser.mjs';
import { RuntimeError } from '../scripts/core.mjs';
import { AUTHORIZATION_FAILURE_ACTION, prepareCourtSignIn, resumeCourtSignIn } from '../scripts/sign-in.mjs';
import { requestControl } from '../scripts/trelio-gas-pravosudie.mjs';

// Exercise the real browser adapter and worker orchestration together, without
// credentials, network, native unlock or a real ESIA transaction. The client
// fixture settles the same two promises as the verified Playwright helper.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gas-auth-recovery-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'scripts'));
  await fs.mkdir(path.join(directory, 'references'));
  const modulePath = path.join(directory, 'scripts', 'playwright-client.mjs');
  const guidePath = path.join(directory, 'references', 'playwright-client.md');
  await fs.writeFile(modulePath, 'export const createEsiaAuthorization = async page => page.createAuthorization();\n');
  await fs.writeFile(guidePath, '# Synthetic client\n');

  const calls = [];
  const attempts = [];
  let url = 'https://ej.sudrf.ru/';
  let checked = false;
  const controls = {};
  const context = {};
  const page = {
    context: () => context,
    isClosed: () => false,
    url: () => url,
    waitForLoadState: async () => {},
    goto: async (target, options) => { calls.push(['goto', target, options]); url = target; },
    bringToFront: async () => { calls.push(['focus']); },
    createAuthorization: () => {
      let resolve, reject;
      const authenticated = new Promise((yes, no) => { resolve = yes; reject = no; });
      const attempt = { resolve, reject, closed: 0 };
      attempts.push(attempt);
      return {
        request: Promise.resolve({ arguments: ['authorize', '--confirm'] }),
        authenticated,
        close: async () => { attempt.closed += 1; },
      };
    },
    locator: selector => controls[selector],
  };
  Object.assign(controls, {
    '#iAgree[type="checkbox"]:visible': {
      count: async () => 1, isChecked: async () => checked, check: async () => { checked = true; },
    },
    'a[href="/info/useragreement"]:visible': {
      count: async () => 1, first() { return this; }, innerText: async () => 'Пользовательское соглашение',
    },
    'label[for="iAgree"]:visible': {
      count: async () => 1, first() { return this; },
      innerText: async () => 'Я ознакомился(ась) с «Пользовательским соглашением» и согласен(на) на обработку персональных данных.',
    },
    'button.esiaLogin:visible,button.esia-login:visible': {
      filter() { return this; }, count: async () => 1,
      click: async () => {
        calls.push(['login']);
        url = 'https://esia.gosuslugi.ru/login';
        if (page.loginError) throw page.loginError;
      },
    },
    'input[type="checkbox"]:visible': { count: async () => 1 },
  });
  const portal = new CourtPortal({}, async () => {});
  portal.context = context;
  portal.page = page;
  portal.storage = async () => ({ cookies: [], origins: [] });
  const status = { phase: 'ready', error: null, expiresAt: Date.now() + 1800000, sessionId: crypto.randomUUID() };
  const transitions = [];
  const setPhase = async (phase, error = null, httpFailure = {}) => {
    delete status.httpStatus; delete status.httpOrigin;
    Object.assign(status, httpFailure);
    status.phase = phase;
    status.error = error;
    transitions.push({ phase, error });
  };
  let saved = 0;
  const save = async () => { saved += 1; };
  const client = {
    modulePath, guidePath, configHome: directory,
    options: { company: crypto.randomUUID(), member: crypto.randomUUID() },
    ownership: 'caller', browserAccess: 'full_playwright_context',
  };
  return {
    portal, page, context, controls, status, attempts, calls, transitions, setPhase, save,
    prepare: () => prepareCourtSignIn(portal, { phase: status.phase, client, setPhase }),
    resume: () => resumeCourtSignIn(portal, { phase: status.phase, setPhase, save }),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    returnToCourt: () => { url = 'https://ej.sudrf.ru/appeal/list'; },
    saved: () => saved,
  };
}

test('failed delegated login releases the helper and a separate retry reuses the same court session', async t => {
  const f = await fixture(t);
  const { sessionId, expiresAt } = f.status;
  await f.prepare();
  f.attempts[0].reject({ code: 'service_http_error', httpStatus: 503, httpOrigin: 'https://ej.sudrf.ru',
    message: 'private auth body', url: 'https://ej.sudrf.ru/callback?code=private-code' });
  await f.settle();

  await assert.rejects(f.resume(), { code: 'service_http_error' });
  assert.equal(f.status.phase, 'authorization_failed');
  assert.equal(f.status.error, 'service_http_error');
  assert.equal(f.status.httpStatus, 503);
  assert.equal(f.status.httpOrigin, 'https://ej.sudrf.ru');
  assert.equal(f.attempts[0].closed, 1);
  assert.equal(f.portal.authorization, null);
  assert.deepEqual(f.calls, [['login']]);
  assert.equal(f.saved(), 0);

  // A status/resume mistake must not discard the first safe failure or restart
  // authorization. Only the distinct, already-confirmed prepare command does.
  await assert.rejects(f.resume(), { code: 'authorization_not_started' });
  assert.equal(f.status.error, 'service_http_error');
  await f.prepare();
  assert.equal(f.status.phase, 'authorization_required');
  assert.equal(f.status.error, null);
  assert.equal(f.status.httpStatus, undefined);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.portal.page, f.page);
  assert.equal(f.portal.context, f.context);
  assert.equal(f.status.sessionId, sessionId);
  assert.equal(f.status.expiresAt, expiresAt);
  assert.deepEqual(f.calls, [
    ['login'],
    ['goto', 'https://ej.sudrf.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 }],
    ['login'],
  ]);

  f.returnToCourt();
  f.attempts[1].resolve({ context: f.context, page: f.page });
  await f.settle();
  assert.equal((await f.resume()).phase, 'ready');
  assert.equal(f.status.phase, 'ready');
  assert.equal(f.status.error, null);
  assert.equal(f.attempts[1].closed, 1);
  assert.equal(f.saved(), 1);
});

test('pending login retains its exact helper and rejects a second prepare', async t => {
  const f = await fixture(t);
  await f.prepare();
  const helper = f.portal.authorization;
  assert.deepEqual(await f.resume(), { phase: 'authorization_pending' });
  assert.equal(f.status.phase, 'authorization_pending');
  assert.equal(f.portal.authorization, helper);
  assert.equal(f.attempts[0].closed, 0);
  await assert.rejects(f.prepare(), { code: 'session_not_ready' });
  assert.deepEqual(f.calls, [['login']]);
});

test('unknown login click result records failure and never dispatches a second click automatically', async t => {
  const f = await fixture(t);
  f.page.loginError = new Error('private browser exception');
  await assert.rejects(f.prepare(), { code: 'esia_authorization_result_unknown' });
  assert.equal(f.status.phase, 'authorization_failed');
  assert.equal(f.status.error, 'esia_authorization_result_unknown');
  assert.equal(f.portal.authorization, null);
  assert.equal(f.attempts[0].closed, 1);
  assert.deepEqual(f.calls, [['login']]);
});

for (const scenario of ['cancelled', 'unsafe-error', 'wrong-context', 'wrong-page', 'invalid-return', 'missing-helper']) {
  test(`terminal ${scenario} consumes authorization without exposing auth content or declaring ready`, async t => {
    const f = await fixture(t);
    await f.prepare();
    let code;
    if (scenario === 'cancelled' || scenario === 'unsafe-error') {
      code = scenario === 'cancelled' ? 'authorization_cancelled' : 'esia_authorization_result_unknown';
      f.attempts[0].reject({ code: scenario === 'cancelled' ? code : 'private https://auth/?token=secret' });
    } else if (scenario === 'missing-helper') {
      code = 'authorization_not_started';
      f.portal.authorization = null;
    } else {
      code = scenario === 'invalid-return' ? 'authorization_return_invalid' : 'authorization_context_changed';
      f.attempts[0].resolve({
        context: scenario === 'wrong-context' ? {} : f.context,
        page: scenario === 'wrong-page' ? {} : f.page,
      });
    }
    await f.settle();
    await assert.rejects(f.resume(), { code });
    assert.equal(f.status.phase, 'authorization_failed');
    assert.equal(f.status.error, code);
    assert.equal(f.portal.authorization, null);
    assert.equal(f.attempts[0].closed, scenario === 'missing-helper' ? 0 : 1);
    assert.deepEqual(f.calls, [['login']]);
    assert.equal(f.saved(), 0);
    assert.ok(!JSON.stringify(f.status).includes('secret'));
  });
}

test('snapshot persistence failure after a verified callback preserves ready rather than replaying login', async t => {
  const f = await fixture(t);
  await f.prepare();
  f.returnToCourt();
  f.attempts[0].resolve({ context: f.context, page: f.page });
  await f.settle();
  await assert.rejects(resumeCourtSignIn(f.portal, {
    phase: f.status.phase, setPhase: f.setPhase,
    save: async () => { throw new RuntimeError('vault_write_failed'); },
  }), { code: 'vault_write_failed' });
  assert.equal(f.status.phase, 'ready');
  assert.equal(f.portal.authorization, null);
  assert.deepEqual(f.calls, [['login']]);
});

test('recovery refuses an expired permit or replaced/closed caller page before navigating', async t => {
  for (const kind of ['expired', 'closed', 'replaced']) {
    const f = await fixture(t);
    f.status.phase = 'authorization_failed';
    if (kind === 'expired') f.portal.permit = async () => { throw new RuntimeError('session_expired'); };
    if (kind === 'closed') f.page.isClosed = () => true;
    if (kind === 'replaced') f.page.context = () => ({});
    await assert.rejects(f.prepare(), {
      code: kind === 'expired' ? 'session_expired' : 'authorization_context_changed',
    });
    assert.equal(f.status.phase, 'authorization_failed');
    assert.equal(f.attempts.length, 0);
    assert.deepEqual(f.calls, []);
  }
});

test('local control preserves the original safe error and fixed recovery metadata only', async t => {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + 1800000;
  let value = {
    error: 'service_http_error', httpStatus: 503, httpOrigin: 'https://ej.sudrf.ru',
    phase: 'authorization_failed', sessionId, expiresAt,
    requiredAction: AUTHORIZATION_FAILURE_ACTION, message: 'private auth content',
  };
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const control = { port: server.address().port, token: 'a'.repeat(64) };
  const request = () => requestControl(control, { command: 'resume', sessionId });
  await assert.rejects(request(), error => {
    assert.equal(error.code, 'service_http_error');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.httpOrigin, 'https://ej.sudrf.ru');
    assert.deepEqual(error.recovery, {
      phase: 'authorization_failed', sessionId, expiresAt, requiredAction: AUTHORIZATION_FAILURE_ACTION,
    });
    assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
  for (const patch of [{ sessionId: crypto.randomUUID() }, { requiredAction: 'private content' }, { expiresAt: null }]) {
    const original = value;
    value = { ...original, ...patch };
    await assert.rejects(request(), error => error.code === 'service_http_error' && !error.recovery);
    value = original;
  }
});

test('public court HTTP 503 fails before agreement checks or a login click', async t => {
  const f = await fixture(t);
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 503 });
  await assert.rejects(f.prepare(), { code: 'service_http_error', httpStatus: 503, httpOrigin: 'https://ej.sudrf.ru' });
  assert.equal(f.status.httpStatus, 503);
  assert.equal(f.attempts.length, 0);
  assert.deepEqual(f.calls, []);
});

test('expected 401 with the exact public login agreement continues to a single ESIA handoff', async t => {
  const f = await fixture(t);
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
  assert.equal((await f.prepare()).phase, 'authorization_required');
  assert.equal(f.status.phase, 'authorization_required');
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.calls, [['login']]);
});

test('401 reached through the public login entry is recognized before preparing ESIA', async t => {
  const f = await fixture(t);
  let loginPage = false;
  f.controls['#iAgree[type="checkbox"]:visible'].count = async () => loginPage ? 1 : 0;
  f.controls['a[title="Вход"]'] = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => {
      loginPage = true;
      await f.page.goto('https://ej.sudrf.ru/account/login');
      f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
    },
  };
  assert.equal((await f.prepare()).phase, 'authorization_required');
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.calls.map(call => call[0]), ['goto', 'login']);
});

for (const changed of ['missing-checkbox', 'extra-checkbox', 'changed-label', 'missing-agreement',
  'changed-agreement', 'ambiguous-login']) {
  test(`401 with ${changed} remains a failure before consent or ESIA`, async t => {
    const f = await fixture(t);
    if (changed === 'missing-checkbox') f.controls['#iAgree[type="checkbox"]:visible'].count = async () => 0;
    if (changed === 'extra-checkbox') f.controls['input[type="checkbox"]:visible'].count = async () => 2;
    if (changed === 'changed-label') f.controls['label[for="iAgree"]:visible'].innerText = async () => 'Дополнительное согласие';
    if (changed === 'missing-agreement') f.controls['a[href="/info/useragreement"]:visible'].count = async () => 0;
    if (changed === 'changed-agreement') f.controls['a[href="/info/useragreement"]:visible'].innerText = async () => 'Другое соглашение';
    if (changed === 'ambiguous-login') f.controls['button.esiaLogin:visible,button.esia-login:visible'].count = async () => 2;
    f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
    await assert.rejects(f.prepare(), { code: 'service_http_error', httpStatus: 401 });
    assert.equal(f.status.phase, 'authorization_failed');
    assert.equal(f.status.httpStatus, 401);
    assert.equal(f.attempts.length, 0);
    assert.deepEqual(f.calls, []);
  });
}

for (const status of [403, 429, 500, 503]) {
  test(`HTTP ${status} is never exempted by an otherwise standard login form`, async t => {
    const f = await fixture(t);
    f.portal.documentResponses.set(f.page, { url: f.page.url(), status });
    await assert.rejects(f.prepare(), { code: 'service_http_error', httpStatus: status });
    assert.equal(f.attempts.length, 0);
    assert.deepEqual(f.calls, []);
  });
}

for (const origin of ['https://region.sudrf.ru', 'https://esia.gosuslugi.ru']) {
  test(`401 exception never covers ${origin}`, async t => {
    const f = await fixture(t);
    f.page.url = () => origin;
    f.portal.documentResponses.set(f.page, { url: origin, status: 401 });
    await assert.rejects(f.portal.assertAuthorizationDocumentAvailable(), {
      code: 'service_http_error', httpStatus: 401, httpOrigin: origin,
    });
  });
}

test('known login form never exempts a working document or a callback 401', async t => {
  const f = await fixture(t);
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
  await assert.rejects(f.portal.actionSafe(), { code: 'service_http_error', httpStatus: 401 });
  await f.prepare();
  f.returnToCourt();
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
  f.attempts[0].resolve({ context: f.context, page: f.page });
  await f.settle();
  await assert.rejects(f.resume(), { code: 'service_http_error', httpStatus: 401 });
  assert.equal(f.status.phase, 'authorization_failed');
  assert.equal(f.saved(), 0);
  assert.equal(f.attempts[0].closed, 1);
});

test('initial or recovery navigation response allows only the same exact login form', async t => {
  const f = await fixture(t);
  await f.portal.assertAuthorizationDocumentAvailable({ url: () => f.page.url(), status: () => 401 });
  const agreement = f.controls['a[href="/info/useragreement"]:visible'];
  agreement.innerText = async () => {
    f.returnToCourt();
    return 'Пользовательское соглашение';
  };
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 401 });
  await assert.rejects(f.portal.assertAuthorizationDocumentAvailable(), { code: 'service_http_error', httpStatus: 401 });
  assert.deepEqual(f.calls, []);
});

test('court document evidence ignores previous navigation and replaces a recovered response', async t => {
  const f = await fixture(t);
  f.portal.documentResponses.set(f.page, { url: 'https://ej.sudrf.ru/old?code=private-code', status: 503 });
  f.portal.assertDocumentAvailable();
  f.portal.documentResponses.set(f.page, { url: f.page.url(), status: 200 });
  f.portal.assertDocumentAvailable();
  const response = { url: () => f.page.url(), status: () => 503 };
  assert.throws(() => f.portal.assertDocumentAvailable(response), error =>
    error.code === 'service_http_error' && error.httpStatus === 503 && !JSON.stringify(error).includes('private'));
});

for (const patch of [{ httpStatus: '503' }, { httpStatus: 600 },
  { httpOrigin: 'https://ej.sudrf.ru/callback?state=private-state' }, { httpOrigin: 'https://private@ej.sudrf.ru' }]) {
  test('delegated court error rejects unsafe HTTP metadata ' + JSON.stringify(patch), async t => {
    const f = await fixture(t);
    await f.prepare();
    f.attempts[0].reject({ code: 'service_http_error', httpStatus: 503, httpOrigin: 'https://ej.sudrf.ru', ...patch });
    await f.settle();
    await assert.rejects(f.resume(), error => error.code === 'service_http_error' && !('httpStatus' in error));
    assert.equal(f.status.httpStatus, undefined);
    assert.ok(!JSON.stringify(f.status).includes('private'));
  });
}
