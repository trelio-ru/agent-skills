import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceFlow, entryUrl, serviceForOrigin, serviceUrl } from '../scripts/esia-flow.mjs';
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
const postState = 'synthetic-post-state';
const postCallback = 'https://zakaznoe.pochta.ru/oauth2/cb';
const esiaPostCallback = 'https://passport.pochta.ru/pc/ext/v1.0/authorize/esia';
function postAuthorization(overrides = {}) {
  const url = new URL('https://passport.pochta.ru/oauth2/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: 'SYNTHETIC_POST',
    scope: 'openid', state: postState, redirect_uri: postCallback, ...overrides });
  return url.href;
}
function postReturned(overrides = {}, target = postCallback) {
  const url = new URL(target);
  url.search = new URLSearchParams({ code: 'synthetic-post-code', state: postState, ...overrides });
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

test('Russian Post accepts its exact passport callback while other sites remain same-origin', () => {
  const entry = 'https://zakaznoe.pochta.ru';
  const passportCallback = 'https://passport.pochta.ru/oauth/callback?fixed=1';
  const service = serviceForOrigin(entry);
  const passport = serviceForOrigin('https://passport.pochta.ru');
  assert.deepEqual(service.callbackOrigins, [entry, 'https://passport.pochta.ru']);
  assert.deepEqual(passport.callbackOrigins, ['https://passport.pochta.ru']);
  assert.deepEqual(passport.serviceOrigins, [entry, 'https://passport.pochta.ru',
    'https://pochta.ru', 'https://www.pochta.ru']);
  assert.equal(serviceUrl('https://pochta.ru/account', passport), true);
  assert.equal(serviceUrl('https://www.pochta.ru/account', passport), true);
  assert.equal(entryUrl('https://pochta.ru/account', passport), false);
  assert.equal(serviceUrl('https://login.pochta.ru/', passport), false);
  assert.deepEqual(serviceForOrigin('https://other.example.org').callbackOrigins,
    ['https://other.example.org']);

  const flow = new ServiceFlow(service);
  flow.observeNavigation(authorization(passportCallback));
  flow.allowSecret();
  flow.observeNavigation(returned({}, passportCallback));
  flow.observeResponse(returned({}, passportCallback), 302);
  assert.equal(flow.hasAuthenticatedReturn, true);

  // The callback origin comes from the bound OAuth request. Merely matching
  // the path and state on the entry site cannot stand in for that response.
  const wrongReturn = new ServiceFlow(service);
  wrongReturn.observeNavigation(authorization(passportCallback));
  assert.throws(() => wrongReturn.observeNavigation(returned({}, entry + '/oauth/callback?fixed=1')),
    /service_callback_rejected/);
  assert.throws(() => new ServiceFlow(passport).observeNavigation(authorization(entry + '/oauth/callback')),
    /service_redirect_rejected/);
  for (const bad of [
    returned({ state: 'wrong' }, passportCallback),
    returned({}, passportCallback.replace('fixed=1', 'fixed=2')),
  ]) {
    const rejected = new ServiceFlow(service);
    rejected.observeNavigation(authorization(passportCallback));
    assert.throws(() => rejected.observeNavigation(bad), /service_callback_rejected/);
  }
  for (const unapproved of [
    'https://login.pochta.ru/oauth/callback',
    'https://passport.pochta.ru.evil.org/oauth/callback',
    'http://passport.pochta.ru/oauth/callback',
    'https://passport.pochta.ru:444/oauth/callback',
  ]) {
    assert.throws(() => new ServiceFlow(service).observeNavigation(authorization(unapproved)),
      /service_redirect_rejected/);
  }
});

test('Post ID and ESIA have separate bound state and both callbacks complete the letters login', () => {
  const flow = new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'));
  flow.observeNavigation(postAuthorization());
  assert.throws(() => flow.allowSecret(), /service_authorization_request_required/);
  flow.observeNavigation(authorization(esiaPostCallback));
  flow.allowSecret();
  const esiaReturn = returned({}, esiaPostCallback);
  flow.observeNavigation(esiaReturn);
  flow.observeResponse(esiaReturn, 303);
  assert.equal(flow.hasAuthenticatedReturn, false, 'ESIA alone does not establish the letters session');
  flow.observeNavigation(postReturned());
  assert.equal(flow.hasAuthenticatedReturn, false, 'outer callback still needs HTTP proof');
  flow.observeResponse(postReturned(), 302);
  assert.equal(flow.hasAuthenticatedReturn, true);
  assert.equal(flow.redact(`${postState} ${state} synthetic-post-code`),
    '[redacted] [redacted] [redacted]');
});

test('Post ID callback rejects swapped state, wrong order, duplicate code and an unrelated return', () => {
  for (const invalid of [
    postReturned({ state }), postReturned({ state: 'wrong' }), postReturned() + '&code=duplicate',
    postReturned() + '&state=duplicate', postReturned({ error: 'denied' }),
    postReturned({ access_token: 'not-accepted' }),
  ]) {
    const flow = new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'));
    flow.observeNavigation(postAuthorization());
    flow.observeNavigation(authorization(esiaPostCallback));
    const esiaReturn = returned({}, esiaPostCallback);
    flow.observeNavigation(esiaReturn);
    flow.observeResponse(esiaReturn, 303);
    assert.throws(() => flow.observeNavigation(invalid),
      /service_(callback_rejected|oauth_parameters_invalid)/);
    assert.equal(flow.hasAuthenticatedReturn, false);
  }
  const early = new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'));
  early.observeNavigation(postAuthorization());
  assert.throws(() => early.observeNavigation(postReturned()), /service_callback_rejected/);
  const failed = new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'));
  failed.observeNavigation(postAuthorization());
  failed.observeNavigation(authorization(esiaPostCallback));
  const esiaReturn = returned({}, esiaPostCallback);
  failed.observeNavigation(esiaReturn); failed.observeResponse(esiaReturn, 303);
  failed.observeNavigation(postReturned()); failed.observeResponse(postReturned(), 500);
  assert.equal(failed.error, 'service_http_error');
  assert.equal(failed.hasAuthenticatedReturn, false);
  assert.throws(() => new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'))
    .observeNavigation(postAuthorization({ state: '' })), /service_oauth_parameters_invalid/);
  for (const redirect_uri of [
    'https://login.pochta.ru/oauth2/cb', 'https://zakaznoe.pochta.ru.evil.org/oauth2/cb',
    'http://zakaznoe.pochta.ru/oauth2/cb', 'https://zakaznoe.pochta.ru/other',
  ]) assert.throws(() => new ServiceFlow(serviceForOrigin('https://zakaznoe.pochta.ru'))
    .observeNavigation(postAuthorization({ redirect_uri })), /service_redirect_rejected/);
});

test('tracking binds its own outer callback before ESIA and rejects wrong state, scope and lost initiation', () => {
  const origin = 'https://www.pochta.ru', target = origin + '/api/auth/callback';
  const service = serviceForOrigin(origin);
  assert.deepEqual(service.callbackOrigins, ['https://passport.pochta.ru']);
  assert.equal(entryUrl('https://passport.pochta.ru/pc/ext/v2.0/form/signIn', service), true);
  const begin = () => {
    const flow = new ServiceFlow(service);
    flow.observeNavigation(postAuthorization({ redirect_uri: target }));
    flow.observeNavigation(authorization(esiaPostCallback));
    flow.observeNavigation(returned({}, esiaPostCallback));
    flow.observeResponse(returned({}, esiaPostCallback), 303);
    assert.equal(flow.hasAuthenticatedReturn, false);
    return flow;
  };
  const flow = begin();
  flow.observeNavigation(postReturned({}, target));
  assert.equal(flow.hasAuthenticatedReturn, false);
  flow.observeResponse(postReturned({}, target), 302);
  assert.equal(flow.hasAuthenticatedReturn, true);
  assert.throws(() => flow.observeNavigation(postReturned({}, target)), /service_callback_rejected/);
  for (const invalid of [
    postReturned({ state }, target), postReturned({ state: 'wrong' }, target),
    postReturned({}, target) + '&code=duplicate', postReturned({}, target) + '&state=duplicate',
    postReturned({ error: 'denied' }, target), postReturned({ id_token: 'forbidden' }, target),
    postReturned({}, target) + '#fragment', postReturned(),
  ]) assert.throws(() => begin().observeNavigation(invalid), /service_(callback_rejected|oauth_parameters_invalid)/);
  for (const redirect_uri of [postCallback, target + '/extra', target + '?fixed=1',
    'https://pochta.ru/api/auth/callback', 'https://www.pochta.ru.evil.org/api/auth/callback']) {
    assert.throws(() => new ServiceFlow(service).observeNavigation(postAuthorization({ redirect_uri })),
      /service_redirect_rejected/);
  }
  // Attaching only after Passport has loaded cannot recover the missed state.
  const late = new ServiceFlow(serviceForOrigin('https://passport.pochta.ru'));
  late.observeNavigation(authorization(esiaPostCallback));
  late.observeNavigation(returned({}, esiaPostCallback));
  late.observeResponse(returned({}, esiaPostCallback), 302);
  assert.throws(() => late.observeNavigation(postReturned({}, target)), /service_callback_rejected/);
  const failed = begin();
  failed.observeNavigation(postReturned({}, target)); failed.observeResponse(postReturned({}, target), 500);
  assert.equal(failed.hasAuthenticatedReturn, false);
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

test('Passport-first login may commit a bound callback redirect in either Postal cabinet', () => {
  const passport = 'https://passport.pochta.ru';
  for (const destination of ['https://zakaznoe.pochta.ru/cabinet', 'https://pochta.ru/account',
    'https://www.pochta.ru/account']) {
    const b = browserFixture(serviceForOrigin(passport)), watcher = b.start();
    const oauth = authorization(passport + '/oauth/callback?fixed=1');
    b.request(b.original, oauth);
    assert.equal(b.binds, 1);
    const callbackUrl = returned({}, passport + '/oauth/callback?fixed=1');
    const callbackRequest = b.request(b.original, callbackUrl);
    b.response(callbackRequest, 302);
    const cabinet = b.request(b.original, destination, { parent: callbackRequest });
    b.response(cabinet);
    b.original.commit(cabinet.url());
    assert.equal(watcher.returned, true);
    assert.deepEqual(b.errors, []);
    watcher.close();
  }
});

test('Post ID then ESIA redirect chain requires both HTTP callbacks from either Postal entry', () => {
  for (const origin of ['https://zakaznoe.pochta.ru', 'https://passport.pochta.ru']) {
    const b = browserFixture(serviceForOrigin(origin));
    const watcher = b.start();
    const outer = b.request(b.original, postAuthorization()); b.response(outer, 303);
    assert.equal(b.binds, 0);
    const inner = b.request(b.original, authorization(esiaPostCallback), { parent: outer });
    b.response(inner, 302);
    assert.equal(b.binds, 1);
    const esiaReturn = b.request(b.original, returned({}, esiaPostCallback));
    b.response(esiaReturn, 303);
    assert.equal(watcher.returned, false);
    const postReturn = b.request(b.original, postReturned(), { parent: esiaReturn });
    b.response(postReturn, 302);
    assert.equal(watcher.returned, false);
    const cabinet = b.request(b.original, 'https://zakaznoe.pochta.ru/cabinet', { parent: postReturn });
    b.response(cabinet); b.original.commit(cabinet.url());
    assert.equal(watcher.returned, true);
    assert.deepEqual(b.errors, []);
    watcher.close();
  }
});

test('tracking consent document cannot replace the outer callback document even after its HTTP response', () => {
  const origin = 'https://www.pochta.ru', target = origin + '/api/auth/callback';
  const b = browserFixture(serviceForOrigin(origin)), watcher = b.start();
  const outer = b.request(b.original, postAuthorization({ redirect_uri: target })); b.response(outer, 302);
  b.request(b.original, authorization(esiaPostCallback));
  const inner = b.request(b.original, returned({}, esiaPostCallback)); b.response(inner, 302);
  const consent = b.request(b.original, 'https://passport.pochta.ru/consent', { parent: inner });
  b.response(consent); b.original.commit(consent.url());
  assert.equal(watcher.returned, false);
  // Consent starts a new navigation, not an HTTP redirect from the ESIA reply.
  const finish = b.request(b.original, postReturned({}, target)); b.response(finish, 302);
  assert.equal(watcher.returned, false, 'old Passport document is not the tracking callback commit');
  const cabinet = b.request(b.original, origin + '/tracking', { parent: finish });
  b.response(cabinet); b.original.commit(cabinet.url());
  assert.equal(watcher.returned, true); assert.deepEqual(b.errors, []);
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

for (const stage of ['entry', 'esia', 'callback']) {
  test(`HTTP 503 at ${stage} preserves only status/origin and never proves login`, () => {
    const b = browserFixture(), watcher = b.start();
    let url = gas.entryUrl;
    if (stage !== 'entry') {
      const auth = b.request(b.original, authorization());
      if (stage === 'esia') { b.response(auth, 503); url = authorization(); }
      else { b.response(auth); url = returned(); b.response(b.request(b.original, url), 503); }
    } else b.response(b.request(b.original, url), 503);
    const error = b.failures[0];
    assert.equal(error.code, 'service_http_error');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.httpOrigin, new URL(url).origin);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'httpOrigin', 'httpStatus']);
    assert.equal(watcher.returned, false);
    assert.ok(!JSON.stringify(error).includes('synthetic-code'));
    assert.ok(!JSON.stringify(error).includes('synthetic-state'));
  });
}

test('service response failure keeps the first status and ignores non-document/sibling errors', () => {
  const b = browserFixture(), watcher = b.start();
  b.response(b.request(b.original, gas.origin + '/asset', { navigation: false }), 503);
  const sibling = b.makePage(null);
  b.response(b.request(sibling, gas.entryUrl), 503);
  assert.equal(b.flow.error, null);
  b.response(b.request(b.original, gas.entryUrl), 502);
  b.flow.observeResponse(gas.entryUrl, 503);
  assert.deepEqual(b.flow.httpFailure, { httpStatus: 502, httpOrigin: gas.origin });
  assert.equal(watcher.returned, false);
});
