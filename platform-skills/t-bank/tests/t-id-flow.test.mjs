import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceFlow } from '../scripts/t-id-flow.mjs';
import { EventEmitter } from 'node:events';
import { PlaywrightAuthorizationFlow } from '../scripts/playwright-flow.mjs';
const gas = { origin: 'https://first.example.org', entryUrl: 'https://first.example.org/' };
const callback = 'https://first.example.org/oauth/callback?fixed=1';
const state = 'synthetic-state-only';
function authorization(redirect = callback, overrides = {}) {
  const url = new URL('https://id.tbank.ru/auth/authorize');
  url.search = new URLSearchParams({
    redirect_uri: redirect,
    state,
    client_id: 'SYNTHETIC',
    response_type: 'code',
    ...overrides,
  });
  return url.href;
}
function returned(overrides = {}, target = callback) {
  const url = new URL(target);
  for (const [name, value] of Object.entries({ state, code: 'synthetic-code-only', ...overrides }))
    url.searchParams.set(name, value);
  return url.href;
}

test('only the actual bound T‑ID transaction unlocks credentials and a single matching callback', () => {
  const flow = new ServiceFlow(gas);
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeNavigation(authorization());
  flow.allowSecret();
  flow.observeNavigation(returned({ session_state: 'synthetic-session-state' }));
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeResponse(returned({ session_state: 'synthetic-session-state' }), 302);
  assert.equal(flow.hasAuthenticatedReturn, true);
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  assert.throws(() => flow.observeNavigation(returned()), /service_callback_already_used/);
  assert.throws(() => flow.observeNavigation(authorization()), /service_callback_already_used/);
  assert.equal(
    flow.redact(`url ${state} synthetic-code-only synthetic-session-state`),
    'url [redacted] [redacted] [redacted]',
  );
});

test('a same-origin state-only intermediate route is not mistaken for the OAuth callback', () => {
  const flow = new ServiceFlow(gas);

  // T-BKI keeps the OAuth state while moving through its own login bootstrap,
  // before the browser reaches T-ID and exposes the authorization request.
  flow.observeNavigation(`${gas.origin}/tid/bootstrap?state=${state}`);
  flow.observeResponse(`${gas.origin}/tid/bootstrap?state=${state}`, 200);
  assert.equal(flow.callbackSeen, false);
  assert.equal(flow.error, null);
  assert.equal(flow.binding, null);

  flow.observeNavigation(authorization());
  flow.observeNavigation(returned());
  flow.observeResponse(returned(), 200);
  assert.equal(flow.hasAuthenticatedReturn, true);
});

test('callback scope, state, fixed query, errors, duplicate parameters and transaction replacement fail closed', () => {
  for (const target of [
    'https://evil.org/cb',
    'http://first.example.org/cb',
    'https://first.example.org/cb#x',
    'https://first.example.org/cb?state=x',
  ])
    assert.throws(
      () => new ServiceFlow(gas).observeNavigation(authorization(target)),
      /service_redirect_rejected/,
    );
  for (const target of [
    returned({ state: 'wrong' }),
    returned({}, callback.replace('fixed=1', 'fixed=2')),
    returned({}, 'https://first.example.org/wrong'),
    returned() + '&state=duplicate',
    returned({ error: 'denied' }),
    returned({ access_token: 'not-accepted' }),
    returned() + '#fragment',
  ]) {
    const flow = new ServiceFlow(gas);
    flow.observeNavigation(authorization());
    assert.throws(
      () => flow.observeNavigation(target),
      /service_(callback_rejected|oauth_parameters_invalid|authorization_failed)/,
    );
    assert.equal(flow.hasAuthenticatedReturn, false);
  }
  const flow = new ServiceFlow(gas);
  flow.observeNavigation(authorization());
  assert.throws(
    () => flow.observeNavigation(authorization(callback, { state: 'new' })),
    /service_transaction_changed/,
  );
  assert.throws(() => new ServiceFlow(gas).observeNavigation(returned()), /service_callback_rejected/);
  for (const responseMode of ['fragment', 'form_post'])
    assert.throws(
      () => new ServiceFlow(gas).observeNavigation(authorization(callback, { response_mode: responseMode })),
      /service_redirect_rejected/,
    );
});

test('new OAuth cancels cached login proof and recorded failure cancels readiness', () => {
  const flow = new ServiceFlow(gas, { reused: true });
  assert.equal(flow.hasAuthenticatedReturn, true);
  flow.observeNavigation(authorization());
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeNavigation(returned());
  flow.error = 'service_navigation_rejected';
  assert.equal(flow.hasAuthenticatedReturn, false);
});

test('callback HTTP failure never becomes a ready service session', () => {
  const flow = new ServiceFlow(gas);
  flow.observeNavigation(authorization());
  flow.observeNavigation(returned());
  flow.observeResponse(returned(), 500);
  assert.equal(flow.error, 'service_http_error');
  assert.equal(flow.hasAuthenticatedReturn, false);
});

test('a relying-party 401 before OAuth revokes cached proof and permits sign-in, not readiness', () => {
  const flow = new ServiceFlow(gas, { reused: true });
  flow.observeResponse(gas.entryUrl, 401);
  assert.equal(flow.error, null);
  assert.equal(flow.hasAuthenticatedReturn, false);
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  flow.observeNavigation(authorization());
  flow.allowSecret();
  flow.observeNavigation(returned());
  flow.observeResponse(returned(), 401);
  assert.equal(flow.error, 'service_http_error');
  assert.equal(flow.hasAuthenticatedReturn, false);
  for (const [url, status] of [
    [authorization(), 401],
    [gas.entryUrl, 403],
  ]) {
    const rejected = new ServiceFlow(gas);
    rejected.observeResponse(url, status);
    assert.equal(rejected.error, 'service_http_error');
  }
});

// Event fixtures deliberately vary the order of Page, opener, response and
// document-commit delivery. The real headed test separately proves that this
// choreography matches Chromium/Edge, including a self-closing SSO popup.
function browserFixture() {
  const context = new EventEmitter(), pages = [];
  context.pages = () => [...pages];
  function makePage(opener = null, url = gas.origin) {
    const page = new EventEmitter();
    page.at = url; page.closed = false;
    page.frame = { page: () => page, url: () => page.at };
    page.mainFrame = () => page.frame;
    page.context = () => context;
    page.url = () => page.at;
    page.isClosed = () => page.closed;
    page.opener = async () => opener;
    page.commit = value => { page.at = value; page.emit('framenavigated', page.frame); };
    page.close = () => { page.closed = true; page.emit('close'); };
    pages.push(page);
    return page;
  }
  const original = makePage();
  function request(page, url, { navigation = true, method = 'GET', parent = null, childFrame = false, missing = false } = {}) {
    const value = { missing, url: () => url, method: () => method, isNavigationRequest: () => navigation,
      serviceWorker: () => null, redirectedFrom: () => parent,
      frame: () => { if (value.missing) throw new Error('Frame not created'); return childFrame ? { page: () => page } : page.frame; } };
    context.emit('request', value); return value;
  }
  const response = (request, status = 200) => context.emit('response', {
    request: () => request, url: request.url, status: () => status,
  });
  let watcher, binds = 0;
  const errors = [], flow = new ServiceFlow(gas);
  function start() {
    watcher = new PlaywrightAuthorizationFlow(original, flow, {
      onBinding: () => binds++, onError: error => { errors.push(error.code); watcher.close(); },
    });
    return watcher;
  }
  return { context, original, makePage, request, response, start, errors, flow,
    get binds() { return binds; } };
}
const eventsSettled = () => new Promise(resolve => setImmediate(resolve));

test('a new direct popup binds its initial request before Page publication and can close after verified SSO', async () => {
  const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, authorization());
  let resolveOpener;
  popup.opener = () => new Promise(resolve => { resolveOpener = resolve; });
  const entry = b.request(popup, authorization(), { missing: true });
  b.response(entry);
  assert.equal(b.binds, 0);
  entry.missing = false;
  b.context.emit('page', popup);
  await eventsSettled();
  const cb = b.request(popup, returned()); b.response(cb); popup.commit(returned()); popup.close();
  assert.equal(b.binds, 0, 'unproven opener cannot publish an authorization request');
  resolveOpener(b.original); await eventsSettled();
  assert.equal(b.binds, 1); assert.equal(watcher.page, popup);
  assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
  assert.equal(b.original.isClosed(), false); assert.equal(b.original.url(), gas.origin);
  watcher.close();
  assert.equal(b.context.listenerCount('request'), 0);
  assert.equal(b.original.listenerCount('close'), 0);
});

test('existing, unrelated, nested and subframe requests cannot acquire or substitute the auth page', async () => {
  const b = browserFixture(), oldPopup = b.makePage(b.original, authorization());
  const watcher = b.start();
  const unrelated = b.makePage(null, authorization()), nested = b.makePage(unrelated, authorization());
  for (const page of [oldPopup, unrelated, nested]) {
    b.request(page, authorization()); b.context.emit('page', page);
  }
  b.request(b.original, authorization(), { childFrame: true });
  b.request(b.original, authorization(), { navigation: false });
  await eventsSettled();
  assert.equal(b.binds, 0); assert.equal(b.flow.binding, null);
  const popup = b.makePage(b.original, authorization());
  b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
  assert.equal(b.binds, 1); assert.equal(watcher.page, popup);
  // A callback in the opener (or an arbitrary postMessage) cannot stand in for
  // the document return of the popup whose T‑ID request received credentials.
  const wrongPage = b.request(b.original, returned()); b.response(wrongPage); b.original.commit(returned());
  assert.equal(watcher.returned, false); assert.equal(b.flow.callbackSeen, false);
  watcher.close();
});

test('popup completion requires exact callback HTTP proof and that callback document or redirect chain', async () => {
  for (const mode of ['callback', 'redirect', 'http-pending', 'unrelated-navigation']) {
    const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, authorization());
    b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
    const cb = b.request(popup, returned());
    assert.throws(() => b.flow.allowSecret(), /service_authorization_request_required/);
    if (mode !== 'http-pending') b.response(cb, mode === 'redirect' ? 302 : 200);
    assert.equal(watcher.returned, false, 'HTTP proof cannot replace document commit');
    if (mode === 'redirect') {
      const next = b.request(popup, gas.origin + '/cabinet', { parent: cb }); b.response(next); popup.commit(next.url());
    } else if (mode === 'unrelated-navigation') {
      const next = b.request(popup, gas.origin + '/public'); b.response(next); popup.commit(next.url());
    } else popup.commit(returned());
    assert.equal(watcher.returned, mode === 'callback' || mode === 'redirect');
    if (mode === 'http-pending') {
      b.response(cb); assert.equal(watcher.returned, true);
    }
    watcher.close();
  }
});

test('original page survives a state-only bootstrap before its T-ID authorization request', async () => {
  const b = browserFixture(), watcher = b.start();
  const intermediate = b.request(b.original, `${gas.origin}/tid/bootstrap?state=${state}`);
  b.response(intermediate); b.original.commit(intermediate.url());
  assert.equal(watcher.returned, false);
  assert.equal(b.flow.callbackSeen, false);
  assert.equal(b.flow.binding, null);
  assert.deepEqual(b.errors, []);

  const auth = b.request(b.original, authorization()); b.response(auth); b.original.commit(authorization());
  assert.equal(b.binds, 1);
  const cb = b.request(b.original, returned()); b.response(cb); b.original.commit(returned());
  assert.equal(watcher.returned, true);
  assert.deepEqual(b.errors, []);
  watcher.close();
});

test('popup close, failed/wrong callback, second auth page and closed opener fail without closing caller pages', async () => {
  for (const mode of ['close', 'http-error', 'wrong-state', 'second-page', 'opener-close']) {
    const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, authorization());
    b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
    if (mode === 'close') popup.close();
    if (mode === 'http-error') { const cb = b.request(popup, returned()); b.response(cb, 500); }
    if (mode === 'wrong-state') b.request(popup, returned({ state: 'wrong' }));
    if (mode === 'second-page') {
      const other = b.makePage(b.original, authorization()); b.request(other, authorization());
      b.context.emit('page', other); await eventsSettled();
      assert.equal(watcher.page, popup, 'an auth page is never replaced');
      assert.equal(other.isClosed(), false);
    }
    if (mode === 'opener-close') b.original.close();
    assert.equal(watcher.returned, false);
    assert.equal(b.errors.length, 1);
    assert.equal(b.original.isClosed(), mode === 'opener-close');
    assert.equal(popup.isClosed(), mode === 'close');
    watcher.close();
  }
});

test('T-ID keeps numeric HTTP evidence without OAuth path/query or asset noise', () => {
  for (const status of [403,404,429,500,503]) {
    const flow = new ServiceFlow(gas); flow.observeNavigation(authorization());
    flow.observeNavigation(returned()); flow.observeResponse(returned(), status);
    assert.deepEqual(flow.httpFailure, { httpStatus: status, httpOrigin: gas.origin });
    assert.equal(JSON.stringify(flow.httpFailure).includes('state='), false);
    flow.observeResponse(returned(), 502); assert.equal(flow.httpFailure.httpStatus, status);
    assert.equal(flow.hasAuthenticatedReturn, false);
  }
  const flow = new ServiceFlow(gas); flow.observeResponse(gas.entryUrl, 401);
  assert.equal(flow.httpFailure, null);
});
