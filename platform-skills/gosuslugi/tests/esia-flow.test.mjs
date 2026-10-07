import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceFlow, entryUrl, externalUrl, serviceForOrigin } from '../scripts/esia-flow.mjs';
import { EventEmitter } from 'node:events';
import { PlaywrightAuthorizationFlow } from '../scripts/playwright-flow.mjs';
import { safeAuthorizationFailure } from '../scripts/playwright-client.mjs';
const gas = { origin: 'https://first.example.org', entryUrl: 'https://first.example.org/' };
const callback = 'https://first.example.org/oauth/callback?fixed=1';
const state = 'synthetic-state-only';
function authorization(redirect = callback, overrides = {}) {
  const url = new URL('https://esia.gosuslugi.ru/aas/oauth2/ac');
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
test('only the actual bound ESIA transaction unlocks credentials and a single matching callback', () => {
  const flow = new ServiceFlow(gas);
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeNavigation(authorization());
  flow.allowSecret();
  flow.observeNavigation(returned());
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeResponse(returned(), 302);
  assert.equal(flow.hasAuthenticatedReturn, true);
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  assert.throws(() => flow.observeNavigation(returned()), /service_callback_already_used/);
  assert.throws(() => flow.observeNavigation(authorization()), /service_callback_already_used/);
  assert.equal(flow.redact(`url ${state} synthetic-code-only`), 'url [redacted] [redacted]');
});

test('callback scope, state, fixed query, errors, duplicate parameters and transaction replacement fail closed', () => {
  for (const target of [
    'https://esia.gosuslugi.ru/cb',
    'https://user:pass@broker.example.org/cb',
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
  const unbound = new ServiceFlow(gas); unbound.observeNavigation(returned());
  assert.equal(unbound.hasAuthenticatedReturn, false);
  assert.throws(() => unbound.allowSecret(), /service_authorization_request_required/);
});

test('callback rejection reports only the exact failed invariant and never weakens binding', () => {
  const cases = [
    [returned({}, 'https://first.example.org/wrong'), 'GET', 'target'],
    [returned(), 'POST', 'method'],
    [returned() + '#synthetic-private-fragment', 'GET', 'fragment'],
    [returned({ state: 'synthetic-private-wrong-state' }), 'GET', 'state'],
    [returned({}, callback.replace('fixed=1', 'fixed=2')), 'GET', 'query'],
  ];
  for (const [url, method, reason] of cases) {
    const flow = new ServiceFlow(gas); flow.observeNavigation(authorization());
    assert.throws(() => flow.observeNavigation(url, method), error => {
      assert.equal(error.code, `service_callback_rejected_${reason}`);
      assert.deepEqual(safeAuthorizationFailure(error), { error: error.code });
      assert.doesNotMatch(JSON.stringify(safeAuthorizationFailure(error)), /https:|synthetic|code=|state=/);
      return true;
    });
    assert.equal(flow.callbackSeen, false); assert.equal(flow.hasAuthenticatedReturn, false);
  }
  const valid = new ServiceFlow(gas); valid.observeNavigation(authorization());
  valid.observeNavigation(returned()); valid.observeResponse(returned(), 200);
  assert.equal(valid.hasAuthenticatedReturn, true, 'the full original binding remains required');
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

test('external callback errors do not revoke a verified ESIA response or permit another secret input', () => {
  for (const status of [200, 302, 401, 403, 500, 503]) {
    const flow = new ServiceFlow(gas);
    flow.observeNavigation(authorization()); flow.observeNavigation(returned());
    flow.observeResponse(returned(), status);
    assert.equal(flow.error, null); assert.equal(flow.hasAuthenticatedReturn, true);
    assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  }
});

test('HTTP errors on an external entry stay caller-owned while ESIA HTTP errors remain provider failures', () => {
  const flow = new ServiceFlow(gas, { reused: true });
  flow.observeResponse(gas.entryUrl, 401);
  assert.equal(flow.error, null); assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeResponse(gas.entryUrl, 503);
  assert.equal(flow.error, null);
  flow.observeNavigation(authorization()); flow.observeResponse(authorization(), 503);
  assert.equal(flow.error, 'service_http_error'); assert.equal(flow.hasAuthenticatedReturn, false);
});

// Event fixtures deliberately vary the order of Page, opener, response and
// document-commit delivery. The real headed test separately proves that this
// choreography matches Chromium/Edge, including a self-closing SSO popup.
function browserFixture(service = gas) {
  const context = new EventEmitter(), pages = [];
  context.pages = () => [...pages];
  function makePage(opener = null, url = service.origin) {
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
  const errors = [], failures = [], flow = new ServiceFlow(service);
  function start() {
    watcher = new PlaywrightAuthorizationFlow(original, flow, {
      onBinding: () => binds++, onError: error => { errors.push(error.code); failures.push(error); watcher.close(); },
    });
    return watcher;
  }
  return { context, original, makePage, request, response, start, errors, failures, flow,
    get binds() { return binds; } };
}
const eventsSettled = () => new Promise(resolve => setImmediate(resolve));

test('routing state after an accepted callback stays in its exact HTTP return chain', () => {
  const b = browserFixture(), watcher = b.start();
  b.request(b.original, authorization());
  const cb = b.request(b.original, returned()); b.response(cb, 302);
  const cabinet = b.request(b.original, gas.origin + '/cabinet?state=synthetic-route', { parent: cb });
  b.response(cabinet, 302);
  assert.equal(watcher.returned, false, 'routing state and HTTP acceptance do not replace a document commit');
  // The exception applies to every exact redirect hop, not to an origin-wide
  // state waiver. The actual callback state remains the original binding.
  const final = b.request(b.original, gas.origin + '/cabinet/main?state=another-route', { parent: cabinet });
  b.response(final); b.original.commit(final.url());
  assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
  assert.throws(() => b.flow.allowSecret(), /service_authorization_request_required/);
  assert.throws(() => b.flow.observeNavigation(returned()), /service_callback_already_used/);
  watcher.close();
});

test('service redirect continuation cannot replace callback checks or authorize unrelated navigation', () => {
  for (const mode of ['unrelated', 'http-pending', 'post', 'same-callback']) {
    const b = browserFixture(), watcher = b.start();
    b.request(b.original, authorization());
    const cb = b.request(b.original, returned());
    if (mode !== 'http-pending') b.response(cb, 302);
    let target = gas.origin + '/cabinet?state=synthetic-route';
    if (mode === 'same-callback') target = returned();
    const next = b.request(b.original, target, {
      parent: mode === 'unrelated' ? null : cb, method: mode === 'post' ? 'POST' : 'GET',
    });
    b.response(next); b.original.commit(target);
    assert.equal(watcher.returned, false, mode);
    if (mode !== 'foreign-origin') assert.equal(b.errors.length, 1, mode);
    watcher.close();
  }
});

test('any relying party may issue its own parameters in the exact accepted callback redirect chain', () => {
  for (const origin of ['https://unlisted.example.org', 'https://another.example.net']) {
    const service = serviceForOrigin(origin), cbPath = origin + '/auth/return';
    const b = browserFixture(service), watcher = b.start();
    b.request(b.original, authorization(cbPath));
    const cb = b.request(b.original, returned({}, cbPath)); b.response(cb, 302);
    // Both steps are site-owned HTTP redirects, not new OAuth callbacks. The
    // generic observer must not know a cabinet route or a provider's token name.
    const first = b.request(b.original, origin + '/next?state=route&access_token=synthetic-service-token', { parent: cb });
    b.response(first, 303);
    assert.equal(watcher.returned, false, 'a redirect and token do not replace a document commit');
    const final = b.request(b.original, origin + '/work?code=site-code&id_token=site-id&state=one&state=two', { parent: first });
    b.response(final); b.original.commit(final.url());
    assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
    assert.throws(() => b.flow.allowSecret(), /service_authorization_request_required/);
    assert.equal(b.flow.redact('synthetic-service-token site-code site-id'), '[redacted] [redacted] [redacted]');
    // Even a redirect cannot replay the bound callback or start another ESIA
    // transaction after the original callback has revoked secret access.
    assert.throws(() => b.flow.observeNavigation(authorization(cbPath)), /service_callback_already_used/);
    b.request(b.original, authorization(cbPath), { parent: final });
    assert.deepEqual(b.errors, []); assert.equal(watcher.returned, true, 'later caller-owned navigation cannot revoke the frozen proof');
    watcher.close();
  }
});

test('a site token is not accepted without the exact HTTP callback chain', () => {
  for (const mode of ['unrelated', 'http-pending', 'post', 'same-callback']) {
    const b = browserFixture(), watcher = b.start();
    b.request(b.original, authorization());
    const cb = b.request(b.original, returned());
    if (mode !== 'http-pending') b.response(cb, 302);
    let target = gas.origin + '/work?access_token=synthetic-service-token';
    if (mode === 'same-callback') target = returned({ access_token: 'synthetic-service-token' });
    const next = b.request(b.original, target, {
      parent: mode === 'unrelated' ? null : cb,
      method: mode === 'post' ? 'POST' : 'GET',
    });
    b.response(next); b.original.commit(target);
    assert.equal(watcher.returned, false, mode);
    assert.equal(b.errors.length, 1, mode);
    assert.doesNotMatch(JSON.stringify(b.failures.map(safeAuthorizationFailure)), /synthetic-service-token|access_token|https:.*work/);
    watcher.close();
  }
});

test('a committed verified ESIA return detaches observation before the caller continues its site flow', () => {
  const b = browserFixture(), watcher = b.start();
  b.request(b.original, authorization());
  const cb = b.request(b.original, returned()); b.response(cb); b.original.commit(cb.url());
  assert.equal(watcher.returned, true); assert.equal(watcher.closed, true);
  assert.equal(b.context.listenerCount('request'), 0);
  assert.equal(b.original.listenerCount('framenavigated'), 0);
  // No callbacks or browser restrictions remain for the caller's own SSO,
  // token-bearing SPA route, business error or a different HTTPS site.
  const next = b.request(b.original, 'https://other.example.org/work?code=site-code&access_token=site-token');
  b.response(next, 500); b.original.commit(next.url());
  assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
  assert.throws(() => b.flow.allowSecret(), /service_authorization_request_required/);
  assert.throws(() => b.flow.observeNavigation(returned()), /service_callback_already_used/);
});

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

test('an early popup with an empty initial URL cannot fail or prove an ESIA return', async () => {
  for (const initial of ['', 'about:blank']) {
    const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, initial);
    // The request precedes Page publication, as it does in real Chromium. The
    // initial placeholder commit is then replayed after the exact opener check.
    b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
    assert.equal(b.binds, 1); assert.deepEqual(b.errors, []); assert.equal(watcher.returned, false);
    const cb = b.request(popup, returned()); b.response(cb); popup.commit(cb.url());
    assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []); watcher.close();
  }
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
  // the document return of the popup whose ESIA request received credentials.
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

test('a callback redirected through the official identity chooser needs one selected role and a service document', async () => {
  const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, authorization());
  b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
  const cb = b.request(popup, returned()); b.response(cb, 302);
  const roles = b.request(popup, 'https://roles.gosuslugi.ru/roles', { parent: cb });
  b.response(roles); popup.commit(roles.url());
  assert.equal(b.flow.callbackAccepted, true);
  assert.equal(watcher.returned, false, 'the role chooser is not the relying-party return');
  const unrelated = b.request(popup, gas.origin + '/cabinet');
  b.response(unrelated); popup.commit(unrelated.url());
  assert.equal(watcher.returned, false, 'a new service navigation without the bounded role click is insufficient');
  popup.commit(roles.url());
  watcher.markPersonalRoleChoice();
  const cabinet = b.request(popup, gas.origin + '/cabinet');
  b.response(cabinet); popup.commit(cabinet.url());
  assert.equal(watcher.returned, true);
  popup.close();
  assert.deepEqual(b.errors, []);
  watcher.close();
});

test('popup close, failed/wrong callback, second auth page and closed opener fail without closing caller pages', async () => {
  for (const mode of ['close', 'wrong-state', 'second-page', 'opener-close']) {
    const b = browserFixture(), watcher = b.start(), popup = b.makePage(b.original, authorization());
    b.request(popup, authorization()); b.context.emit('page', popup); await eventsSettled();
    if (mode === 'close') popup.close();
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

test('generic broker callbacks and cross-origin redirects return browser control without a site catalog', () => {
  const origin = 'https://unlisted.example.net', broker = 'https://identity.example.org';
  const b = browserFixture(serviceForOrigin(origin)), watcher = b.start();
  assert.equal(entryUrl(broker, b.flow.service), false);
  assert.equal(externalUrl(broker), true);
  b.request(b.original, broker + '/authorize?state=site-state');
  const auth = b.request(b.original, authorization(broker + '/esia/callback'));
  b.response(auth);
  const cb = b.request(b.original, returned({}, broker + '/esia/callback')); b.response(cb, 302);
  const cabinet = b.request(b.original, origin + '/work?state=outer-state&access_token=site-token', { parent: cb });
  b.response(cabinet, 503);
  assert.equal(watcher.returned, false);
  b.original.commit(cabinet.url() + '#view');
  assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
  assert.deepEqual(watcher.serviceResponse, { httpStatus: 503, httpOrigin: origin });
  assert.throws(() => b.flow.allowSecret(), /service_authorization_request_required/);
  watcher.close();
});

test('an external callback error page is returned separately from ESIA success', () => {
  for (const status of [401, 403, 500, 503]) {
    const b = browserFixture(), watcher = b.start();
    b.request(b.original, authorization());
    const cb = b.request(b.original, returned()); b.response(cb, status); b.original.commit(cb.url());
    assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
    assert.deepEqual(watcher.serviceResponse, { httpStatus: status, httpOrigin: gas.origin });
    watcher.close();
  }
});

test('an unrelated external navigation cannot substitute the verified ESIA return even with the same callback state', () => {
  const b = browserFixture(), watcher = b.start();
  b.request(b.original, authorization());
  const cb = b.request(b.original, returned()); b.response(cb, 302);
  const unrelated = b.request(b.original, 'https://foreign.example.org/work');
  b.response(unrelated); b.original.commit(unrelated.url());
  assert.equal(watcher.returned, false); watcher.close();
});

test('ESIA HTTP 503 keeps only its first safe status/origin and never proves login', () => {
  const b = browserFixture(), watcher = b.start();
  b.response(b.request(b.original, gas.origin + '/asset', { navigation: false }), 503);
  b.response(b.request(b.makePage(null), authorization()), 502);
  assert.equal(b.flow.error, null);
  const auth = b.request(b.original, authorization()); b.response(auth, 503);
  b.flow.observeResponse(authorization(), 502);
  const error = b.failures[0];
  assert.deepEqual(safeAuthorizationFailure(error), {
    error: 'service_http_error', httpStatus: 503, httpOrigin: 'https://esia.gosuslugi.ru',
  });
  assert.deepEqual(Object.keys(error).sort(), ['code', 'httpOrigin', 'httpStatus']);
  assert.equal(watcher.returned, false);
  assert.doesNotMatch(JSON.stringify(error), /synthetic-code|synthetic-state/);
});
