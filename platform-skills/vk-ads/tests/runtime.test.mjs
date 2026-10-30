import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { identity, credentials, Fault, hash, scope, clean, date } from '../scripts/core.mjs';
import { Store, privateProcess } from '../scripts/storage.mjs';
import { Api, safeApiErrorDetails, apiValidationDetails } from '../scripts/api.mjs';
import { Operations, prepare, matches } from '../scripts/operations.mjs';
import { input } from '../scripts/form.mjs';
import { argumentsOf, configureWorker, setupStatus, accountApi } from '../scripts/trelio-vk-ads.mjs';
// The provider matrix intentionally invokes this portable entrypoint on all
// three OS. Register the separate suites here too, so new modules cannot be
// checked only by a local file-specific command and silently miss hosted CI.
import './diagnostics.test.mjs';
import './audience-operations.test.mjs';
import './vk-groups.test.mjs';
import './status-recovery.test.mjs';

const owner = () => ({ account: crypto.randomUUID(), binding: 'a'.repeat(64), company: crypto.randomUUID(), member: crypto.randomUUID() });
const auth = () => ({ mode: 'client', groups: 'ad_groups', client_id: 'synthetic-client', client_secret: 'synthetic-only-secret', agency_client: '' });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
// The test codec is dependency injection at module level, never a CLI/env
// bypass. Production cannot select it and Linux remains fail-closed.
function codec() {
  const key = crypto.randomBytes(32);
  return { seal: async plain => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([c.update(plain), c.final()]); return JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), bytes: bytes.toString('base64') }); },
    open: async text => { const r = JSON.parse(text), c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64')); c.setAuthTag(Buffer.from(r.tag, 'base64')); return Buffer.concat([c.update(Buffer.from(r.bytes, 'base64')), c.final()]); } };
}
async function fixture(t, options = { codec: codec() }) {
  // Hosted Windows must report the exact bounded stage instead of leaving a
  // silent job alive for hours. Only fixed stage names are printed; paths,
  // packets, credentials and native stderr never enter the CI log.
  let stage = 'temporary-directory';
  const watchdog = process.platform === 'win32' ? setTimeout(() => {
    process.stderr.write(`VK native fixture timed out: ${stage}\n`);
    process.exit(1);
  }, 120000) : null;
  const progress = value => { stage = value; if (process.platform === 'win32') process.stderr.write(`VK native fixture: ${stage}\n`); };
  try {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vk-реклама-test-'))), store = new Store(root, owner(), options);
    t.after(async () => { await store.nativeCleanup?.(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    progress('remove-inherited-temporary-directory');
    if (process.platform === 'win32') { await fs.rmdir(root); } // Native helper creates the initial explicit DACL.
    progress('create-private-directories'); await store.init(progress);
    progress('read-empty-state'); const state = await store.read(); state.credentials = auth();
    progress('write-encrypted-state'); await store.write(state);
    progress('ready'); return store;
  } finally { clearTimeout(watchdog); }
}
test('host identity requires an exact selected local account; metadata cannot choose a path', () => {
  const o = owner(), env = { TRELIO_SKILL_ID: 'vk-ads', TRELIO_SKILL_COMPANY_ID: o.company, TRELIO_SKILL_MEMBER_ID: o.member,
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: o.account, providerRef: null, companyBinding: o.binding, name: '../../elsewhere' }) };
  assert.deepEqual(identity(env), o);
  assert.throws(() => identity({ ...env, TRELIO_SKILL_ACCOUNT_JSON: '{}' }), { code: 'account_binding_invalid' });
  assert.throws(() => identity({ ...env, TRELIO_SKILL_CONNECTION_ID: crypto.randomUUID() }), { code: 'host_identity_required' });
  assert.notEqual(scope(o), scope({ ...o, binding: 'b'.repeat(64) }));
  assert.equal(credentials(auth()).client_secret, 'synthetic-only-secret');
  assert.deepEqual(clean({ access_token: 'private', nested: ['synthetic-only-secret'] }, ['synthetic-only-secret']), { nested: ['[redacted]'] });
  assert.throws(() => argumentsOf(['apply', '--raw-token', 'x']), { code: 'command_invalid' });
  assert.throws(() => date('2026-99-01'), { code: 'date_invalid' });
  assert.throws(() => date('2026-02-30'), { code: 'date_invalid' });
});
test('GET retries safely, bounds pagination and never follows redirects with a token', async () => {
  let calls = 0; const waits = [], api = new Api(auth(), { sleep: async ms => waits.push(ms), fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://ads.vk.com'); assert.equal(options.redirect, 'error');
    if (url.pathname.includes('oauth2')) return json({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_in: 600 });
    calls++; if (calls === 1) throw new Error('raw private URL'); if (calls === 2) return json({}, 503);
    return json({ items: Array.from({ length: Number(url.searchParams.get('limit')) }, (_, i) => ({ id: i + 1 })), count: 10 });
  } });
  const result = await api.list('plans', {}, 3); assert.equal(result.items.length, 3); assert.equal(result.truncated, true);
  assert.deepEqual(waits, [500, 1000]); assert.equal(calls, 3);
  await assert.rejects(api.request('GET', '/api/v2/../leak.json'), { code: 'api_route_invalid' });
  await assert.rejects(api.get('plans'), { code: 'object_id_invalid' });
  assert.equal(calls, 3); // A missing exact ID must not silently read the collection.
});
test('writes do not retry on timeout, 429 or 5xx; 401 and 403 remain distinct', async () => {
  for (const status of [401, 403, 429, 500, 'network']) {
    let calls = 0; const api = new Api(auth(), { fetcher: async () => { calls++; if (status === 'network') throw new Error('secret'); return json({ error: { message: 'synthetic-only-secret' } }, status); } });
    api.access = 'synthetic-token';
    await assert.rejects(api.request('POST', '/api/v2/ad_plans.json', { body: {} }),
      { code: status === 401 ? 'authorization_required' : status === 403 ? 'permission_denied' : 'write_result_unknown' });
    assert.equal(calls, 1);
  }
});
test('403 failures distinguish OAuth issuance from advertising reads with fresh or cached tokens', async () => {
  for (const scenario of ['oauth_denied', 'fresh_token_api_denied', 'cached_token_api_denied']) {
    const calls = [], cached = scenario === 'cached_token_api_denied';
    const api = new Api({ ...auth(), ...(cached ? { access_token: 'synthetic-token', expires_at: Date.now() + 3600000 } : {}) }, {
      fetcher: async (url, options) => {
        const oauth = url.pathname === '/api/v2/oauth2/token.json';
        calls.push(oauth ? 'oauth_token' : 'advertising_api');
        assert.equal(options.redirect, 'error');
        if (oauth && scenario !== 'oauth_denied') return json({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_in: 600 });
        assert.equal(options.method, oauth ? 'POST' : 'GET');
        // Provider JSON cannot forge the stage, and OAuth errors are not read
        // as ordinary API data. Neither body nor private reflected values may
        // become diagnostics merely to identify the failed request boundary.
        return json({ error: { requestStage: oauth ? 'advertising_api' : 'oauth_token',
          message: 'synthetic-only-secret synthetic-token https://private.invalid' } }, 403);
      },
    });
    const requestStage = scenario === 'oauth_denied' ? 'oauth_token' : 'advertising_api';
    await assert.rejects(api.list('plans', {}, 1), error => {
      assert.equal(error.code, 'permission_denied');
      assert.deepEqual(error.details, { httpStatus: 403, requestStage, ...(scenario === 'oauth_denied' ? { oauthReason: 'not_returned' } : {}) });
      return true;
    });
    assert.deepEqual(calls, scenario === 'oauth_denied' ? ['oauth_token'] : cached ? ['advertising_api'] : ['oauth_token', 'advertising_api']);
  }
});
test('request-stage diagnostics use a closed vocabulary and preserve legacy receipt details', () => {
  for (const requestStage of ['oauth_token', 'advertising_api']) {
    const details = { httpStatus: 403, requestStage };
    assert.deepEqual(safeApiErrorDetails(safeApiErrorDetails(details)), details);
  }
  for (const requestStage of ['https://private.invalid', 'synthetic-only-secret', 'host_grant', {}, ['oauth_token'], null]) {
    assert.deepEqual(safeApiErrorDetails({ httpStatus: 403, requestStage }), { httpStatus: 403 });
  }
  assert.deepEqual(safeApiErrorDetails({ httpStatus: 403 }), { httpStatus: 403 });
});
test('catalogues use endpoint defaults instead of the rejected campaign page size', async () => {
  const routes = ['/api/v2/packages.json', '/api/v2/banner_patterns.json',
    '/api/v2/banner_fields.json', '/api/v2/regions.json', '/api/v2/interests.json'];
  const observed = [], page = { items: [{ id: 3232 }], count: 5 };
  const api = new Api(auth(), { fetcher: async (url, options) => {
    observed.push(url.pathname); assert.equal(options.method, 'GET');
    // Reproduce the real packages rejection. A guessed smaller limit would
    // still fail this fixture: endpoint defaults, not a common magic number,
    // are the contract for all independently versioned catalogues.
    if (url.searchParams.has('limit')) return json({ error: { fields: { limit: { code: 'max_value' } } } }, 400);
    assert.equal(url.search, ''); return json(page);
  } });
  api.access = 'synthetic-token';
  for (const name of ['packages', 'patterns', 'fields', 'regions', 'interests']) {
    assert.deepEqual(await api.catalog(name), page);
  }
  assert.deepEqual(observed, routes);
  await assert.rejects(api.catalog('billing'), { code: 'catalog_invalid' });
  assert.equal(observed.length, 5); // Invalid catalogue names never reach VK.
});
test('API failure projection is bounded and excludes raw text and reflected credentials', () => {
  const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field_${i}`, 'required']));
  assert.equal(Object.keys(safeApiErrorDetails({ httpStatus: 400, fields }).fields).length, 32);
  assert.deepEqual(safeApiErrorDetails({ httpStatus: 200, message: 'raw private text', fields: {
    objective: 'invalid_value', client_secret: 'required', echo: 'syntheticsecret',
    nested: { code: 'required' }, malformed: 'raw text', constructor: 'required',
  } }, ['syntheticsecret']), { fields: { objective: 'invalid_value' } });
});
test('nested validation keeps field paths and indices, never message or payload data', () => {
  const error = { fields: { campaigns: { code: 'bad_items', message: 'private', items: [
    { fields: { budget_limit_day: { code: 'min_value', message: 'private budget' }, banners: {
      code: 'bad_items', errors: { 3: { fields: { urls: { fields: { primary: { code: 'unallowed_value', url: 'https://private.invalid' } } } } } },
    } } },
  ] }, objective: { code: 'bad_value' } }, payload: { code: 'do_not_copy' } };
  const expected = { fields: { campaigns: 'bad_items', objective: 'bad_value' }, fieldErrors: [
    { path: 'campaigns[0].budget_limit_day', code: 'min_value' },
    { path: 'campaigns[0].banners', code: 'bad_items' },
    { path: 'campaigns[0].banners[3].urls.primary', code: 'unallowed_value' },
  ] };
  assert.deepEqual(apiValidationDetails(error), expected);
  assert.deepEqual(safeApiErrorDetails(expected), expected); // Receipt reprojection is idempotent.
  assert.deepEqual(apiValidationDetails({ fields: { campaigns: { fields: {
    0: { fields: { price: { code: 'bad_value' } } },
    '0001': { fields: { price: { code: 'required' } } },
    10000: { fields: { price: { code: 'required' } } },
  } } } }), { fieldErrors: [{ path: 'campaigns[0].price', code: 'bad_value' }] });
  assert.deepEqual(apiValidationDetails({ fields: { campaigns: { errors: [
    { index: 7, fields: { price: { code: 'bad_value' } } },
  ] } } }), { fieldErrors: [{ path: 'campaigns[7].price', code: 'bad_value' }] });
});
test('nested projection is bounded and rejects credential reflection, forged paths and indices', () => {
  const error = { fields: { campaigns: { code: 'bad_items', items: {
    0: { fields: { client_secret: { code: 'required' }, safe: { code: 'syntheticsecret' },
      synthetictoken: { code: 'required' }, urls: { message: { fields: { primary: { code: 'leak' } } } } } },
    1: { index: -1, fields: { price: { code: 'bad_value' } } },
    2: { index: '0002', fields: { price: { code: 'bad_value' } } },
    3: { index: 10000, fields: { price: { code: 'bad_value' } } },
  } } } };
  assert.deepEqual(apiValidationDetails(error, ['syntheticsecret', 'synthetictoken']), { fields: { campaigns: 'bad_items' } });
  assert.deepEqual(safeApiErrorDetails({ fieldErrors: [
    { path: 'campaigns[0].client_secret', code: 'required' },
    { path: 'https://private.invalid', code: 'required' },
    { path: 'campaigns[0].price', code: 'raw message' },
    { path: 'campaigns[0002].price', code: 'required' },
    { path: 'campaigns[0].price', code: 'required', message: 'private' },
    { path: 'campaigns[0].price', code: 'required' },
  ] }), { fieldErrors: [{ path: 'campaigns[0].price', code: 'required' }] });
  const many = apiValidationDetails({ fields: { campaigns: { code: 'bad_items', items:
    Array.from({ length: 1000 }, () => ({ fields: { price: { code: 'min_value' } } })),
  } } });
  assert.equal(Object.keys(many.fields).length + many.fieldErrors.length, 32);
  const deep = {}; let node = deep;
  for (let i = 0; i < 100; i++) { node.fields = { child: { code: 'required' } }; node = node.fields.child; }
  const bounded = apiValidationDetails(deep);
  assert.ok((bounded.fieldErrors?.length || 0) <= 8);
  assert.ok(bounded.fieldErrors.every(item => item.path.split('.').length <= 9));
});
test('nested diagnostics survive the API and persisted receipt without replay or weakening unknown fence', async t => {
  for (const status of [400, 403, 500]) {
    const store = await fixture(t); let writes = 0;
    const api = new Api(auth(), { fetcher: async () => { writes++; return json({ error: { fields: {
      campaigns: { code: 'bad_items', items: [{ fields: { autobidding_mode: { code: 'not_allowed_for_package', message: 'private' } } }] },
    } } }, status); } }); api.access = 'synthetic-token';
    const ops = new Operations(store, api), plan = await ops.plan({ kind: 'create', entity: 'plans', payload: { name: 'Synthetic' } });
    const receipt = await ops.apply(plan.planId, plan.planHash, 'nested-rejection');
    assert.equal(receipt.phase, status === 500 ? 'unknown' : 'rejected');
    assert.deepEqual(receipt.errorDetails, { httpStatus: status, requestStage: 'advertising_api', fields: { campaigns: 'bad_items' },
      fieldErrors: [{ path: 'campaigns[0].autobidding_mode', code: 'not_allowed_for_package' }] });
    const restartedStore = new Store(store.root, store.owner, { codec: store.codec });
    const restarted = new Operations(restartedStore, api);
    assert.deepEqual((await restartedStore.read()).operations['nested-rejection'], receipt);
    assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'another-nested-id'), receipt);
    if (status === 500) {
      const next = await restarted.plan({ kind: 'create', entity: 'plans', payload: { name: 'Different' } });
      await assert.rejects(restarted.apply(next.planId, next.planHash, 'new-unknown-write'), { code: 'unresolved_write_blocks_new_mutation' });
    }
    assert.equal(writes, 1);
  }
});
test('rejected writes retain safe API reasons across restart without replay', async t => {
  const store = await fixture(t); let writes = 0;
  const api = new Api({ ...auth(), client_secret: 'syntheticsecret' }, { fetcher: async (_url, options) => {
    assert.equal(options.method, 'POST'); writes++;
    return json({ error: { message: 'raw syntheticsecret', fields: {
      objective: { code: 'invalid_value', message: 'raw private text' },
      echo: { code: 'syntheticsecret' }, access_echo: { code: 'synthetictoken' },
      client_secret: { code: 'required' }, nested: { code: { private: 'text' } },
    } } }, 400);
  } });
  api.access = 'synthetictoken';
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'create', entity: 'plans', payload: { name: 'Synthetic' } });
  const receipt = await ops.apply(plan.planId, plan.planHash, 'rejected-create');
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.error, 'api_rejected');
  assert.deepEqual(receipt.errorDetails, { httpStatus: 400, requestStage: 'advertising_api', fields: { objective: 'invalid_value' } });
  assert.ok(!JSON.stringify(receipt).includes('syntheticsecret'));
  assert.ok(!JSON.stringify(receipt).includes('synthetictoken'));
  const restartedStore = new Store(store.root, store.owner, { codec: store.codec });
  assert.deepEqual((await restartedStore.read()).operations['rejected-create'], receipt);
  const restarted = new Operations(restartedStore, api);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'rejected-create'), receipt);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'another-rejected-id'), receipt);
  assert.equal(writes, 1); // A useful reason must never turn a receipt into replay authority.
});
test('audience DELETE durable claim survives encrypted store restart and recovers only by exact GET', async t => {
  const store = await fixture(t); let deleted = false, deletes = 0;
  const api = new Api(auth(), { fetcher: async (url, options) => {
    if (options.method === 'DELETE') { deletes++; deleted = true; throw Error('lost delete response'); }
    assert.equal(options.method, 'GET');
    if (url.pathname.endsWith('/segments/10.json')) return json(deleted ? {} :
      { id: 10, name: 'Synthetic deletion', pass_condition: 1, relations_count: 1, campaign_ids: [] }, deleted ? 404 : 200);
    assert.ok(url.pathname.endsWith('/segments/10/relations.json'));
    return json({ items: [{ id: 20, object_type: 'segment', object_id: 50 }] });
  } }); api.access = 'synthetic-token';
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'audience', entity: 'segments', action: 'delete', id: 10 });
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'durable-audience-delete')).phase, 'unknown');
  const restartedStore = new Store(store.root, store.owner, { codec: store.codec }), restarted = new Operations(restartedStore, api);
  assert.equal((await restartedStore.read()).operations['durable-audience-delete'].phase, 'unknown');
  assert.equal((await restarted.reconcile('durable-audience-delete')).phase, 'verified');
  assert.equal((await restartedStore.read()).operations['durable-audience-delete'].phase, 'verified');
  assert.equal((await restarted.apply(plan.planId, plan.planHash, 'different-delete-operation')).phase, 'verified');
  assert.equal(deletes, 1);
});
test('agency auth selects a per-client token privately and cached tokens avoid token issuance', async () => {
  const api = new Api({ ...auth(), mode: 'agency', agency_client: 'synthetic-agency-client' }, { fetcher: async (_url, opts) => {
    assert.equal(opts.body.get('grant_type'), 'agency_client_credentials'); assert.equal(opts.body.get('agency_client_name'), 'synthetic-agency-client');
    return json({ access_token: 'cached-token', refresh_token: 'cached-refresh', expires_in: 3600 });
  } });
  await api.login(); const cached = new Api(api.auth); assert.equal(cached.access, 'cached-token');
});
test('expired VK tokens refresh their existing grant and persist rotation instead of issuing duplicates', async () => {
  for (const mode of ['client', 'agency']) {
    const initial = { ...auth(), mode, agency_client: mode === 'agency' ? 'synthetic-agency' : '' }, grants = [];
    const api = new Api(initial, { fetcher: async (_url, options) => {
      grants.push(options.body.get('grant_type'));
      if (grants.length === 1) return json({ access_token: 'synthetic-first-access', refresh_token: 'synthetic-first-refresh', expires_in: 600 });
      assert.equal(options.body.get('refresh_token'), 'synthetic-first-refresh');
      assert.equal(options.body.has('agency_client_name'), false);
      return json({ access_token: 'synthetic-next-access', refresh_token: 'synthetic-next-refresh', expires_in: 600 });
    } });
    await api.login(); assert.equal(initial.refresh_token, 'synthetic-first-refresh');
    initial.expires_at = 0;
    const restarted = new Api(initial, { fetcher: api.fetcher }); await restarted.login();
    assert.deepEqual(grants, [mode === 'agency' ? 'agency_client_credentials' : 'client_credentials', 'refresh_token']);
    assert.equal(initial.refresh_token, 'synthetic-next-refresh'); assert.equal(initial.access_token, 'synthetic-next-access');
  }
});
test('OAuth expires_in uses seconds and valid cached access is reused without ignoring the expiry margin', async t => {
  const now = 1800000000000; t.mock.method(Date, 'now', () => now); let requests = 0;
  const initial = auth(), api = new Api(initial, { fetcher: async () => {
    requests++; return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: '86400' });
  } });
  await api.login(); assert.equal(initial.expires_at, now + 86400 * 1000);
  assert.equal(new Api(initial).access, 'synthetic-access'); assert.equal(requests, 1);
  assert.equal(new Api({ ...initial, expires_at: now + 60001 }).access, 'synthetic-access');
  assert.equal(new Api({ ...initial, expires_at: now + 60000 }).access, null);
  assert.equal(new Api({ ...initial, expires_at: now - 1 }).access, null);
});
test('a failed refresh never falls back to minting a token or overwrites the saved grant', async () => {
  for (const status of [400, 403, 503, 'network']) {
    const initial = { ...auth(), access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', expires_at: 0 };
    const before = structuredClone(initial); let calls = 0;
    const api = new Api(initial, { fetcher: async (_url, options) => {
      calls++; assert.equal(options.body.get('grant_type'), 'refresh_token');
      if (status === 'network') throw new Error('private transport text');
      return json({ error: { message: 'private synthetic-old-refresh' } }, status);
    } });
    await assert.rejects(api.login(), error => {
      assert.equal(error.code, status === 400 ? 'authorization_required' : status === 403 ? 'permission_denied' : 'network_unavailable');
      return true;
    });
    assert.equal(calls, 1); assert.deepEqual(initial, before); assert.equal(api.access, null);
  }
});
test('OAuth reason projection accepts documented codes only and never infers token limits from private text', async () => {
  for (const [body, oauthReason] of [
    [{ error: 'invalid_client', error_description: 'synthetic-only-secret' }, 'invalid_client'],
    [{ error: { code: 'invalid_user', message: 'private' } }, 'invalid_user'],
    [{ code: 'invalid_grant', message: 'private' }, 'invalid_grant'],
    [{ error: 'token_limit_exceeded', error_description: 'synthetic-only-secret' }, 'token_limit_exceeded'],
    [{ error: { code: 'token_limit_exceeded', message: 'private' } }, 'token_limit_exceeded'],
    [{ code: 'token_limit_exceeded', user_id: 123, message: 'private' }, 'token_limit_exceeded'],
    [{ error: 'token_limit_exceeded_private' }, 'not_recognized'],
    [{ message: 'token_limit_exceeded' }, 'not_returned'],
    [{ error: 'unknown_private_value', message: 'token limit exceeded synthetic-only-secret' }, 'not_recognized'],
    [{ error: { message: 'token limit exceeded' } }, 'not_returned'],
  ]) {
    const api = new Api(auth(), { fetcher: async () => json(body, 403) });
    await assert.rejects(api.login(), error => {
      const expected = { httpStatus: 403, requestStage: 'oauth_token', oauthReason };
      assert.deepEqual(error.details, expected); assert.deepEqual(safeApiErrorDetails(error.details), expected); return true;
    });
  }
  const oversized = new Api(auth(), { fetcher: async () => json({ error: 'invalid_client', message: 'x'.repeat(17000) }, 403) });
  await assert.rejects(oversized.login(), { details: { httpStatus: 403, requestStage: 'oauth_token', oauthReason: 'not_available' } });
  assert.deepEqual(safeApiErrorDetails({ httpStatus: 403, requestStage: 'advertising_api', oauthReason: 'invalid_client' }),
    { httpStatus: 403, requestStage: 'advertising_api' });
  assert.deepEqual(safeApiErrorDetails({ httpStatus: 403, requestStage: 'oauth_token', oauthReason: 'private' }),
    { httpStatus: 403, requestStage: 'oauth_token' });
});
test('an exact OAuth token-limit failure never revokes, remints, reads ads or alters the saved grant', async () => {
  for (const mode of ['client', 'agency']) for (const refreshing of [false, true]) {
    const initial = { ...auth(), mode, access_token: 'synthetic-old-access', expires_at: 0,
      ...(refreshing ? { refresh_token: 'synthetic-old-refresh' } : {}) };
    const before = structuredClone(initial), calls = [];
    const api = new Api(initial, { fetcher: async (url, options) => {
      calls.push(url.pathname);
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('grant_type'), refreshing ? 'refresh_token'
        : mode === 'agency' ? 'agency_client_credentials' : 'client_credentials');
      return json({ error: 'token_limit_exceeded', error_description: 'private', user_id: 123 }, 403);
    } });
    await assert.rejects(api.list('plans'), {
      code: 'permission_denied',
      details: { httpStatus: 403, requestStage: 'oauth_token', oauthReason: 'token_limit_exceeded' },
    });
    // An attempted read stops at the one original OAuth request. In particular,
    // neither the error classifier nor GET retry policy may start a second
    // grant, token/delete, or the requested advertising read after this denial.
    assert.deepEqual(calls, ['/api/v2/oauth2/token.json']);
    assert.deepEqual(initial, before); assert.equal(api.access, null);
    assert.deepEqual(safeApiErrorDetails({ httpStatus: 403, requestStage: 'advertising_api',
      oauthReason: 'token_limit_exceeded' }), { httpStatus: 403, requestStage: 'advertising_api' });
  }
});
test('malformed refresh values fail before IO and invalid rotation never replaces saved secrets', async () => {
  for (const value of ['', null, [], 'bad\nrefresh']) {
    let calls = 0; const api = new Api({ ...auth(), refresh_token: value }, { fetcher: async () => { calls++; } });
    await assert.rejects(api.login(), { code: 'oauth_refresh_invalid' }); assert.equal(calls, 0);
  }
  for (const refresh_token of ['', null, ['private'], 'bad\0refresh']) {
    const initial = { ...auth(), refresh_token: 'synthetic-old-refresh' }, before = structuredClone(initial);
    const api = new Api(initial, { fetcher: async () => json({ access_token: 'synthetic-access', refresh_token, expires_in: 600 }) });
    await assert.rejects(api.login(), { code: 'oauth_response_invalid' }); assert.deepEqual(initial, before);
  }
  const initial = { ...auth(), refresh_token: 'synthetic-old-refresh' };
  await new Api(initial, { fetcher: async () => json({ access_token: 'synthetic-access', expires_in: 600 }) }).login();
  assert.equal(initial.refresh_token, 'synthetic-old-refresh');
  const missing = new Api(auth(), { fetcher: async () => json({ access_token: 'synthetic-access', expires_in: 600 }) });
  await assert.rejects(missing.login(), { code: 'oauth_response_invalid' });
});
test('account renewal is locked before OAuth and a stale caller reuses the persisted winner after restart', async t => {
  const store = await fixture(t), state = await store.read();
  state.credentials = { ...auth(), access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', expires_at: 0 };
  state.operations.previous = { phase: 'unknown', planId: 'kept' }; state.plans.kept = { evidence: 'preserved' }; await store.write(state);
  const snapshot = structuredClone(state.credentials); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  let calls = 0; const options = { fetcher: async (_url, request) => {
    calls++; assert.equal(request.body.get('grant_type'), 'refresh_token'); entered(); await blocked;
    return json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_in: 600 });
  } };
  const first = accountApi(store, structuredClone(snapshot), options); t.after(() => release());
  // A regression which fails before the injected request must reject the
  // test, not leave it waiting forever for a signal that can no longer fire.
  await Promise.race([started, first]);
  const otherStore = new Store(store.root, store.owner, { codec: store.codec });
  t.after(() => otherStore.close());
  try { await assert.rejects(accountApi(otherStore, structuredClone(snapshot), options), { code: 'account_busy_or_recovery_required' }); }
  finally { release(); }
  const ready = await first; assert.equal(ready.access, 'synthetic-new-access'); assert.equal(calls, 1);
  const current = await store.read(); assert.equal(current.credentials.refresh_token, 'synthetic-new-refresh');
  assert.deepEqual(current.operations, state.operations); assert.deepEqual(current.plans, state.plans);
  const restarted = await accountApi(otherStore, snapshot, options);
  assert.equal(restarted.access, 'synthetic-new-access'); assert.equal(calls, 1);
  assert.doesNotMatch(await fs.readFile(path.join(store.dir, 'state.enc'), 'utf8'), /synthetic-new-access|synthetic-new-refresh/);
  const reader = new Api(current.credentials, { fetcher: async () => json({ echo: 'synthetic-new-refresh', refresh_token: 'never-export' }) });
  assert.deepEqual(await reader.get('plans', 1), { echo: '[redacted]' });
});
test('credential replacement and pending setup block renewal before any network request', async t => {
  const store = await fixture(t), initial = (await store.read()).credentials; let calls = 0;
  const options = { fetcher: async () => { calls++; throw new Error('must not reach VK'); } };
  const current = await store.read(); current.credentials.client_secret = 'replacement-secret'; await store.write(current);
  await assert.rejects(accountApi(store, initial, options), { code: 'credentials_changed' });
  current.credentials = initial; current.setup = { phase: 'waiting_input' }; await store.write(current);
  await assert.rejects(accountApi(store, initial, options), { code: 'setup_already_pending' }); assert.equal(calls, 0);
});
test('setup persists the issued refresh grant even when the readiness GET is denied', async t => {
  const store = await fixture(t), state = await store.read(), operation = crypto.randomUUID(); let issuances = 0, reads = 0;
  state.setup = { id: operation, scope: scope(store.owner), phase: 'starting', expires: Date.now() + 120000 }; await store.write(state);
  const fetcher = async (url, options) => {
    if (url.pathname.includes('oauth2')) { issuances++; return json({ access_token: 'synthetic-setup-access', refresh_token: 'synthetic-setup-refresh', expires_in: 600 }); }
    reads++; assert.equal(options.method, 'GET'); return json({}, 403);
  };
  await configureWorker(store, operation, { prompt: async () => auth(), makeApi: value => new Api(value, { fetcher }) });
  const saved = await store.read(); assert.equal(saved.setup.phase, 'failed'); assert.equal(saved.setup.error, 'permission_denied');
  assert.equal(saved.credentials.refresh_token, 'synthetic-setup-refresh');
  const next = await accountApi(store, saved.credentials, { fetcher });
  await assert.rejects(next.list('plans', {}, 1), { code: 'permission_denied' });
  assert.equal(issuances, 1); assert.equal(reads, 2);
});
test('creation pauses the entire tree, requires a group parent and rejects standalone banners', async () => {
  const api = new Api(auth());
  const op = await prepare(api, { kind: 'create', entity: 'plans', payload: { name: 'Synthetic', ad_groups: [{ name: 'Group', package_id: 1, banners: [{ textblocks: { title: { text: 'Ad' } } }] }] } });
  assert.equal(op.payload.status, 'blocked'); assert.equal(op.payload.ad_groups[0].status, 'blocked'); assert.equal(op.payload.ad_groups[0].banners[0].status, 'blocked');
  await assert.rejects(prepare(api, { kind: 'create', entity: 'plans', payload: { name: 'X', status: 'active' } }), { code: 'create_must_be_paused' });
  await assert.rejects(prepare(api, { kind: 'create', entity: 'banners', payload: {} }), { code: 'banner_create_requires_new_group' });
  await assert.rejects(prepare(api, { kind: 'create', entity: 'groups', payload: { name: 'G', package_id: 1, banners: [{ name: 'B' }] } }), { code: 'parent_plan_required' });
  await assert.rejects(prepare(api, { kind: 'update', entity: 'plans', id: 1, payload: { budget_limit_day: -1 } }), { code: 'budget_invalid' });
  await assert.rejects(prepare(api, { kind: 'create', entity: 'plans', payload: { name: 'X', targetings: { authorization: 'private' } } }), { code: 'payload_field_forbidden' });
});
test('new max_goals objects require budget while partial updates and other strategies remain available', async () => {
  const api = new Api(auth()); let reads = 0; api.get = async () => { reads++; return { id: 1, autobidding_mode: 'max_goals' }; };
  await assert.rejects(prepare(api, { kind: 'create', entity: 'plans', payload: { name: 'Synthetic', autobidding_mode: 'max_goals' } }), { code: 'autobidding_budget_required' });
  await assert.rejects(prepare(api, { kind: 'create', entity: 'plans', payload: { name: 'Synthetic', autobidding_mode: 'max_goals', budget_limit: 2000 } }), { code: 'autobidding_budget_required' });
  const spec = { kind: 'create', entity: 'plans', payload: { name: 'Synthetic', date_end: '2026-10-12', ad_groups: [
    { name: 'Group', package_id: 1, autobidding_mode: 'max_goals', budget_limit: 2000, banners: [{ name: 'Banner' }] },
  ] } };
  const finite = await prepare(api, spec); assert.equal(finite.payload.ad_groups[0].budget_limit, 2000);
  const daily = structuredClone(spec); delete daily.payload.date_end;
  daily.payload.ad_groups[0].budget_limit_day = 1000;
  assert.equal((await prepare(api, daily)).payload.ad_groups[0].budget_limit_day, 1000);
  const missing = structuredClone(daily); delete missing.payload.ad_groups[0].budget_limit; delete missing.payload.ad_groups[0].budget_limit_day;
  await assert.rejects(prepare(api, missing), { code: 'autobidding_budget_required' });
  const other = structuredClone(missing); other.payload.ad_groups[0].autobidding_mode = 'second_price';
  await prepare(api, other); // A legacy strategy is not globally forbidden by one package rejection.
  await prepare(api, { kind: 'update', entity: 'plans', id: 1, payload: { autobidding_mode: 'max_goals' } });
  assert.equal(reads, 1);
});
test('Windows native private pipe transport completes before filesystem bootstrap', { skip: process.platform !== 'win32' }, async () => {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  const executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // This control contains no private values and isolates redirected stdin/EOF
  // from ACL, modules and DPAPI. It uses the exact production child environment.
  const result = await privateProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write('ready')"], '{}', 10000);
  assert.equal(result.toString(), 'ready');
});
test('apply uses persisted receipts, verifies semantic readback and fences stale state', async t => {
  const store = await fixture(t); let current = { id: 10, budget_limit_day: '50.00' }, writes = 0;
  const api = new Api(auth()); api.access = 'token'; api.get = async () => current;
  api.request = async () => { writes++; current = { id: 10, budget_limit_day: '100.00' }; return {}; };
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'plans', id: 10, payload: { budget_limit_day: '100' } });
  const first = await ops.apply(plan.planId, plan.planHash, 'synthetic-operation'); assert.equal(first.phase, 'verified');
  assert.deepEqual(await ops.apply(plan.planId, plan.planHash, 'synthetic-operation'), first);
  assert.deepEqual(await ops.apply(plan.planId, plan.planHash, 'second-operation'), first); assert.equal(writes, 1);
  const next = await ops.plan({ kind: 'update', entity: 'plans', id: 10, payload: { budget_limit_day: '200' } }); current.budget_limit_day = '125';
  await assert.rejects(ops.apply(next.planId, next.planHash, 'stale-operation'), { code: 'object_changed_replan_required' }); assert.equal(writes, 1);
  const switched = new Store(store.root, { ...store.owner, binding: 'b'.repeat(64) }, { codec: store.codec });
  await assert.rejects(new Operations(switched, api).apply(next.planId, next.planHash, 'cross-operation'), { code: 'plan_scope_or_hash_invalid' });
});
test('only the known targeting sex set ignores ordering without changing either input', () => {
  const expected = { targetings: { sex: ['male', 'female'] } }, actual = { targetings: { sex: ['female', 'male'] } };
  const before = structuredClone({ expected, actual });
  assert.equal(matches(actual, expected), true);
  assert.equal(matches(actual.targetings, expected.targetings, 'targetings'), true); // Static mismatch diagnostic uses this entry point.
  assert.deepEqual({ expected, actual }, before);
  for (const sex of [['male'], [], ['male', 'male'], ['female', 'male', 'female'], ['unknown', 'male']]) {
    assert.equal(matches({ targetings: { sex } }, expected), false);
  }
  assert.equal(matches({ sex: ['female', 'male'] }, { sex: ['male', 'female'] }), false);
  assert.equal(matches({ content: { targetings: actual.targetings } }, { content: { targetings: expected.targetings } }), false);
  assert.equal(matches({ targetings: { regions: [2, 1] } }, { targetings: { regions: [1, 2] } }), false);
});
test('sex order normalization preserves full optimistic snapshots and dispatches only unchanged selections', async t => {
  for (const mode of ['order', 'membership', 'duplicate', 'unknown', 'other-array', 'extra-key', 'missing-key', 'type']) {
    const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0;
    let current = { id: 4, targetings: { sex: ['male', 'female'], regions: [1, 2], limit: 5 } };
    api.get = async () => structuredClone(current);
    api.request = async () => { writes++; current.targetings = { sex: ['female', 'male'], regions: [1, 2], limit: 5 }; return {}; };
    const ops = new Operations(store, api), spec = { kind: 'update', entity: 'groups', id: 4, payload: { targetings: structuredClone(current.targetings) } };
    const plan = await ops.plan(spec), original = structuredClone(plan.operation.before);
    current.targetings.sex.reverse();
    if (mode === 'membership') current.targetings.sex = ['female'];
    if (mode === 'duplicate') current.targetings.sex = ['male', 'male'];
    if (mode === 'unknown') current.targetings.sex = ['male', 'unknown'];
    if (mode === 'other-array') current.targetings.regions.reverse();
    if (mode === 'extra-key') current.extra = true;
    if (mode === 'missing-key') delete current.targetings.limit;
    if (mode === 'type') current.targetings.limit = '5';
    if (mode === 'order') assert.equal((await ops.apply(plan.planId, plan.planHash, `sex-update-${mode}`)).phase, 'verified');
    else await assert.rejects(ops.apply(plan.planId, plan.planHash, `sex-update-${mode}`), { code: 'object_changed_replan_required' });
    assert.equal(writes, mode === 'order' ? 1 : 0);
    assert.deepEqual(plan.operation.before, original);
    assert.deepEqual((await store.read()).plans[plan.planId].op.before, original);
  }
});
test('only the exact local geo location-type set ignores order without mutating inputs', () => {
  const selection = loc_type => ({ targetings: { geo: { local_geo: { loc_type, visit_type: 'usual', locations: [{ id: 1 }, { id: 2 }] } } } });
  const expected = selection(['home', 'work']), actual = selection(['work', 'home']);
  const before = structuredClone({ expected, actual });
  assert.equal(matches(actual, expected), true);
  assert.equal(matches(actual.targetings, expected.targetings, 'targetings'), true);
  assert.deepEqual({ expected, actual }, before);
  for (const loc_type of [['home'], [], ['home', 'home'], ['unknown', 'work'], ['home', 'work', 'work']]) {
    assert.equal(matches(selection(loc_type), expected), false);
  }
  const reordered = selection(['work', 'home']); reordered.targetings.geo.local_geo.locations.reverse();
  assert.equal(matches(reordered, expected), false);
  const changed = selection(['work', 'home']); changed.targetings.geo.local_geo.visit_type = 'recent';
  assert.equal(matches(changed, expected), false);
  assert.equal(matches({ loc_type: ['work', 'home'] }, { loc_type: ['home', 'work'] }), false);
  assert.equal(matches({ content: actual }, { content: expected }), false);
  assert.equal(matches(['work', 'home'], ['home', 'work'], 'constructor'), false);
});
test('local geo order normalization preserves complete optimistic snapshots before dispatch', async t => {
  for (const mode of ['order', 'membership', 'duplicate', 'unknown', 'locations', 'visit-type', 'extra-key', 'missing-key', 'type']) {
    const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0;
    const current = { id: 4, targetings: { geo: { local_geo: { loc_type: ['home', 'work'], visit_type: 'usual', locations: [{ id: 1 }, { id: 2 }], limit: 5 } } } };
    api.get = async () => structuredClone(current);
    api.request = async () => { writes++; return {}; };
    const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'groups', id: 4, payload: { targetings: structuredClone(current.targetings) } });
    const original = structuredClone(plan.operation.before), local = current.targetings.geo.local_geo;
    local.loc_type.reverse();
    if (mode === 'membership') local.loc_type = ['home'];
    if (mode === 'duplicate') local.loc_type = ['home', 'home'];
    if (mode === 'unknown') local.loc_type = ['home', 'unknown'];
    if (mode === 'locations') local.locations.reverse();
    if (mode === 'visit-type') local.visit_type = 'recent';
    if (mode === 'extra-key') local.extra = true;
    if (mode === 'missing-key') delete local.limit;
    if (mode === 'type') local.limit = '5';
    if (mode === 'order') assert.equal((await ops.apply(plan.planId, plan.planHash, `geo-update-${mode}`)).phase, 'verified');
    else await assert.rejects(ops.apply(plan.planId, plan.planHash, `geo-update-${mode}`), { code: 'object_changed_replan_required' });
    assert.equal(writes, mode === 'order' ? 1 : 0);
    assert.deepEqual(plan.operation.before, original);
    assert.deepEqual((await store.read()).plans[plan.planId].op.before, original);
  }
});
test('only an empty segments selection matches an absent exact targeting key', () => {
  const expected = { targetings: { segments: [], regions: [1, 2] } };
  const actual = { targetings: { regions: [1, 2] } };
  const original = structuredClone({ actual, expected });
  assert.equal(matches(actual, expected), true);
  assert.equal(matches(actual.targetings, expected.targetings, 'targetings'), true);
  assert.deepEqual({ actual, expected }, original);
  for (const segments of [null, false, 0, '', {}, [1], ['1'], [1, 1]]) {
    assert.equal(matches({ targetings: { ...actual.targetings, segments } }, expected), false);
    assert.equal(matches(actual, { targetings: { ...actual.targetings, segments } }), false);
  }
  assert.equal(matches({ targetings: { ...actual.targetings, segments: undefined } }, expected), false);
  assert.equal(matches({}, { segments: [] }), false);
  assert.equal(matches({ content: actual }, { content: expected }), false);
  assert.equal(matches({ targetings: {} }, { targetings: { regions: [] } }), false);
  assert.equal(matches({ targetings: { segments: [2, 1] } }, { targetings: { segments: [1, 2] } }), false);
});
test('empty segments normalization preserves full optimistic snapshots and audience changes', async t => {
  for (const mode of ['omit', 'empty', 'nonempty', 'null', 'object', 'other-array', 'extra-key', 'missing-key', 'type']) {
    const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0;
    const current = { id: 4, targetings: { regions: [1, 2], limit: 5, ...(mode === 'empty' ? {} : { segments: [] }) } };
    api.get = async () => structuredClone(current);
    api.request = async () => { writes++; delete current.targetings.segments; return {}; };
    const ops = new Operations(store, api);
    const plan = await ops.plan({ kind: 'update', entity: 'groups', id: 4, payload: { targetings: { regions: [1, 2], limit: 5, segments: [] } } });
    const before = structuredClone(plan.operation.before);
    if (mode === 'empty') current.targetings.segments = [];
    else delete current.targetings.segments;
    if (mode === 'nonempty') current.targetings.segments = [1];
    if (mode === 'null') current.targetings.segments = null;
    if (mode === 'object') current.targetings.segments = {};
    if (mode === 'other-array') current.targetings.regions.reverse();
    if (mode === 'extra-key') current.targetings.extra = true;
    if (mode === 'missing-key') delete current.targetings.limit;
    if (mode === 'type') current.targetings.limit = '5';
    const equivalent = ['omit', 'empty'].includes(mode);
    if (equivalent) assert.equal((await ops.apply(plan.planId, plan.planHash, `segments-update-${mode}`)).phase, 'verified');
    else await assert.rejects(ops.apply(plan.planId, plan.planHash, `segments-update-${mode}`), { code: 'object_changed_replan_required' });
    assert.equal(writes, equivalent ? 1 : 0);
    assert.deepEqual(plan.operation.before, before);
    assert.deepEqual((await store.read()).plans[plan.planId].op.before, before);
  }
});
test('persisted empty segments mismatch reconciles by reads without another advertising write', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0;
  const current = { id: 4, status: 'blocked', targetings: { segments: [1], regions: [2] } };
  api.get = async () => structuredClone(current);
  api.request = async () => { writes++; delete current.targetings.segments; return {}; };
  const ops = new Operations(store, api);
  const plan = await ops.plan({ kind: 'update', entity: 'groups', id: 4, payload: { targetings: { segments: [], regions: [2] } } });
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'segments-cleared')).phase, 'verified');
  // Model the exact retained receipt shape produced by the older matcher. The
  // new runtime must recover its original hash/specification, never replan or
  // resend the committed mutation. Real missing filters must keep the fence.
  const state = await store.read(), legacy = state.operations['segments-cleared'];
  legacy.phase = 'written_unverified'; delete legacy.observed;
  legacy.error = 'readback_mismatch'; legacy.errorDetails = { fields: { groups_targetings: 'readback_mismatch' } };
  await store.write(state);
  const restarted = new Operations(new Store(store.root, store.owner, { codec: store.codec }), api);
  current.targetings.segments = [3];
  assert.equal((await restarted.reconcile('segments-cleared')).phase, 'written_unverified');
  const next = await restarted.plan({ kind: 'update', entity: 'groups', id: 4, payload: { name: 'Synthetic next' } });
  await assert.rejects(restarted.apply(next.planId, next.planHash, 'segments-fence'), { code: 'unresolved_write_blocks_new_mutation' });
  delete current.targetings.segments;
  const result = await restarted.reconcile('segments-cleared');
  assert.equal(result.phase, 'verified'); assert.equal(result.errorDetails, undefined); assert.equal(result.error, undefined);
  assert.equal(result.hash, plan.planHash); assert.equal(result.planId, plan.planId); assert.equal(writes, 1);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'segments-cleared'), result);
  assert.equal(writes, 1); assert.equal(current.status, 'blocked');
});
test('unknown create survives restart and prevents a new plan from bypassing the receipt', async t => {
  const store = await fixture(t); let writes = 0; const api = new Api(auth()); api.access = 'token';
  api.request = async () => { writes++; throw new Fault('write_result_unknown'); };
  const ops = new Operations(store, api), spec = { kind: 'create', entity: 'plans', payload: { name: 'Synthetic' } };
  const plan = await ops.plan(spec), result = await ops.apply(plan.planId, plan.planHash, 'lost-create'); assert.equal(result.phase, 'unknown');
  const restarted = new Operations(new Store(store.root, store.owner, { codec: store.codec }), api);
  assert.equal((await restarted.apply(plan.planId, plan.planHash, 'other-operation')).phase, 'unknown');
  const second = await restarted.plan(spec);
  await assert.rejects(restarted.apply(second.planId, second.planHash, 'new-operation'), { code: 'unresolved_write_blocks_new_mutation' });
  assert.equal((await restarted.reconcile('lost-create')).phase, 'unknown'); assert.equal(writes, 1);
});
test('a readback 403 cannot relabel a successful write as a rejection', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let calls = 0;
  api.get = async () => { calls++; if (calls > 2) throw new Fault('permission_denied', { httpStatus: 403 }); return { id: 1, status: 'blocked' }; };
  api.request = async () => ({});
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'plans', id: 1, payload: { status: 'active' } });
  const receipt = await ops.apply(plan.planId, plan.planHash, 'readback-failure'); assert.equal(receipt.phase, 'written_unverified');
  assert.deepEqual(receipt.errorDetails, { httpStatus: 403 });
});
test('readback mismatch projects only static field codes and keeps the write fence', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0, corrected = false;
  const spec = { kind: 'create', entity: 'groups', payload: { name: 'Expected', ad_plan_id: 3, package_id: 2, budget_limit_day: 100, banners: [{ name: 'B' }] } };
  api.request = async () => { writes++; return { id: 4, banners: [{ id: 5 }] }; };
  api.get = async (entity, number) => entity === 'groups'
    ? { id: number, name: corrected ? 'Expected' : 'Private provider value', ad_plan_id: 3, package_id: 2, budget_limit_day: corrected ? '100.00' : 200, status: 'blocked' }
    : { id: number, name: 'B', ad_group_id: 4, status: 'blocked' };
  const ops = new Operations(store, api), plan = await ops.plan(spec);
  const receipt = await ops.apply(plan.planId, plan.planHash, 'readback-field-codes');
  assert.equal(receipt.phase, 'written_unverified'); assert.equal(receipt.error, 'readback_mismatch');
  assert.deepEqual(receipt.errorDetails, { fields: { groups_name: 'readback_mismatch', groups_budget_limit_day: 'readback_mismatch' } });
  assert.ok(!JSON.stringify(receipt).includes('Private provider value'));
  assert.deepEqual((await ops.reconcile('readback-field-codes')).errorDetails, receipt.errorDetails);
  const next = await ops.plan({ kind: 'update', entity: 'plans', id: 3, payload: { name: 'New' } });
  await assert.rejects(ops.apply(next.planId, next.planHash, 'mismatch-fences-write'), { code: 'unresolved_write_blocks_new_mutation' });
  corrected = true;
  assert.equal((await ops.reconcile('readback-field-codes')).phase, 'verified');
  assert.equal((await ops.reconcile('readback-field-codes')).errorDetails, undefined); assert.equal(writes, 1);
});
test('reconcile a committed update after timeout uses only readback, never another write', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0, current = { id: 9, status: 'active' };
  api.get = async () => current; api.request = async () => { writes++; current = { id: 9, status: 'blocked' }; throw new Fault('write_result_unknown', { httpStatus: 500 }); };
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'plans', id: 9, payload: { status: 'blocked' } });
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'lost-update')).phase, 'unknown');
  const reconciled = await ops.reconcile('lost-update');
  assert.equal(reconciled.phase, 'verified'); assert.equal(reconciled.errorDetails, undefined); assert.equal(writes, 1);
  assert.equal(matches({ name: null }, { name: '0' }), false);
  assert.equal(matches({ name: '1' }, { name: '01' }), false);
});
test('expired plans cannot dispatch and encrypted records reject corruption/unsafe links', async t => {
  const store = await fixture(t), api = new Api(auth()); let now = Date.now(); api.access = 'token';
  const ops = new Operations(store, api, () => now), plan = await ops.plan({ kind: 'create', entity: 'plans', payload: { name: 'X' } });
  now += 31 * 60 * 1000;
  await assert.rejects(ops.apply(plan.planId, plan.planHash, 'expired-operation'), { code: 'plan_expired' });
  const file = path.join(store.dir, 'state.enc'); const text = await fs.readFile(file, 'utf8');
  await assert.rejects(store.open(text.slice(0, -10)), { code: 'vault_corrupt_or_wrong_identity' });
  if (process.platform !== 'win32') { await fs.chmod(file, 0o644); await assert.rejects(store.read(), { code: 'unsafe_permissions' });
    await fs.chmod(file, 0o600); await fs.rename(file, `${file}.old`); await fs.symlink(`${file}.old`, file);
    await assert.rejects(store.read(), { code: 'unsafe_storage' }); }
});
test('media upload hashes bytes, sends multipart dimensions and cannot replay a changed file', async t => {
  const store = await fixture(t), file = path.join(store.root, 'synthetic.png');
  await fs.writeFile(file, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  let writes = 0; const api = new Api(auth()); api.access = 'token';
  api.request = async (method, route, options) => { assert.equal(method, 'POST'); assert.equal(route, '/api/v2/content/static.json');
    assert.ok(options.body instanceof FormData); assert.deepEqual(JSON.parse(options.body.get('data')), { width: 1080, height: 1080 }); writes++; return { id: 7 }; };
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'upload', file, width: 1080, height: 1080 });
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'creative-upload')).phase, 'uploaded_unverified'); assert.equal(writes, 1);
  const another = await ops.plan({ kind: 'upload', file, width: 1080, height: 1080 }); await fs.appendFile(file, 'changed');
  await assert.rejects(ops.apply(another.planId, another.planHash, 'changed-upload'), { code: 'media_changed' }); assert.equal(writes, 1);
});
test('advertised URL readback retains pending VK validation separately from mutation success', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token';
  api.request = async (method, route) => method === 'POST' ? { id: 99 } : { id: 99, url: 'https://example.test/offer', url_types: [] };
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'url', url: 'https://example.test/offer' });
  const receipt = await ops.apply(plan.planId, plan.planHash, 'create-ad-url'); assert.equal(receipt.phase, 'verified'); assert.deepEqual(receipt.urlTypes, []);
});
test('nested create checks every banner and does not invent child IDs', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token';
  const spec = { kind: 'create', entity: 'groups', payload: { ad_plan_id: 3, name: 'G', package_id: 2, banners: [{ name: 'B' }] } };
  api.request = async () => ({ id: 4, banners: [{ id: 5 }] });
  api.get = async (entity, number) => entity === 'groups' ? { id: number, name: 'G', package_id: 2, ad_plan_id: 3, status: 'blocked' } : { id: number, name: 'B', ad_group_id: 4, status: 'blocked' };
  const ops = new Operations(store, api), plan = await ops.plan(spec); assert.equal((await ops.apply(plan.planId, plan.planHash, 'nested-create')).phase, 'verified');
});
test('VK response alias and parent-scoped child reads reconcile a nested write without replay', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token';
  const spec = { kind: 'create', entity: 'plans', payload: { name: 'P', ad_groups: [{ name: 'G', package_id: 2, banners: [{ name: 'B' }] }] } };
  let writes = 0, visible = false;
  api.request = async (method, route, options) => {
    if (method === 'POST') { assert.equal(route, '/api/v2/ad_plans.json'); assert.ok(options.body.ad_groups); assert.equal(options.body.campaigns, undefined); writes++; return { id: 3, campaigns: [{ id: 4 }] }; }
    assert.equal(route, '/api/v2/banners.json');
    assert.equal(options.query._ad_group_id, 4); assert.equal(options.query._campaign_id, undefined);
    assert.equal(options.query.limit, 2); assert.equal(options.query.fields, 'id,ad_group_id');
    return { items: visible ? [{ id: 5, ad_group_id: 4 }] : [], count: visible ? 1 : 0 };
  };
  api.get = async (entity, number) => entity === 'plans' ? { id: number, name: 'P', status: 'blocked' }
    : entity === 'groups' ? { id: number, ad_plan_id: 3, name: 'G', package_id: 2, status: 'blocked' }
    : { id: number, ad_group_id: 4, name: 'B', status: 'blocked' };
  const ops = new Operations(store, api), plan = await ops.plan(spec);
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'nested-alias-create')).phase, 'written_unverified');
  const next = await ops.plan({ kind: 'update', entity: 'plans', id: 3, payload: { name: 'Rename' } });
  await assert.rejects(ops.apply(next.planId, next.planHash, 'blocked-until-readback'), { code: 'unresolved_write_blocks_new_mutation' });
  visible = true;
  const restarted = new Operations(new Store(store.root, store.owner, { codec: store.codec }), api);
  const receipt = await restarted.reconcile('nested-alias-create');
  assert.equal(receipt.phase, 'verified'); assert.equal(receipt.error, undefined);
  assert.deepEqual(receipt.children, [{ entity: 'groups', objectId: 4, children: [{ entity: 'banners', objectId: 5 }] }]);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'another-id-same-nested-plan'), receipt);
  assert.equal(writes, 1);
});
test('reconcile verifies a paused nested tree despite changing sex order with no creation replay', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0, available = false;
  const spec = { kind: 'create', entity: 'plans', payload: { name: 'P', ad_groups: [{ name: 'G', package_id: 2,
    targetings: { sex: ['male', 'female'] }, banners: [{ name: 'B' }] }] } };
  api.request = async () => { writes++; return { id: 3, campaigns: [{ id: 4 }] }; };
  api.list = async () => ({ items: [{ id: 5, ad_group_id: 4 }], count: 1, truncated: false });
  api.get = async (entity, number) => {
    if (!available && entity === 'groups') throw new Fault('readback_failed');
    return entity === 'plans' ? { id: number, name: 'P', status: 'blocked' }
      : entity === 'groups' ? { id: number, name: 'G', ad_plan_id: 3, package_id: 2, targetings: { sex: ['female', 'male'] }, status: 'blocked' }
      : { id: number, name: 'B', ad_group_id: 4, status: 'blocked' };
  };
  const ops = new Operations(store, api), plan = await ops.plan(spec);
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'sex-nested-create')).phase, 'written_unverified');
  available = true;
  const restarted = new Operations(new Store(store.root, store.owner, { codec: store.codec }), api);
  const receipt = await restarted.reconcile('sex-nested-create');
  assert.equal(receipt.phase, 'verified'); assert.equal(receipt.error, undefined);
  assert.deepEqual(receipt.children, [{ entity: 'groups', objectId: 4, children: [{ entity: 'banners', objectId: 5 }] }]);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'sex-nested-create'), receipt); assert.equal(writes, 1);
});
test('persisted local geo mismatch reconciles a paused tree by reads without creation replay', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0, available = false;
  const spec = { kind: 'create', entity: 'plans', payload: { name: 'P', ad_groups: [{ name: 'G', package_id: 2,
    targetings: { geo: { local_geo: { loc_type: ['home', 'work'] } } }, banners: [{ name: 'B' }] }] } };
  api.request = async () => { writes++; return { id: 3, campaigns: [{ id: 4 }] }; };
  api.list = async () => ({ items: [{ id: 5, ad_group_id: 4 }], count: 1, truncated: false });
  api.get = async (entity, number) => entity === 'plans' ? { id: number, name: 'P', status: 'blocked' }
    : entity === 'groups' ? { id: number, name: 'G', ad_plan_id: 3, package_id: 2,
      targetings: { geo: { local_geo: { loc_type: available ? ['work', 'home'] : ['home'] } } }, status: 'blocked' }
    : { id: number, name: 'B', ad_group_id: 4, status: 'blocked' };
  const ops = new Operations(store, api), plan = await ops.plan(spec);
  const result = await ops.apply(plan.planId, plan.planHash, 'geo-nested-create');
  assert.equal(result.phase, 'written_unverified'); assert.equal(result.error, 'readback_mismatch');
  assert.deepEqual(result.errorDetails, { fields: { groups_targetings: 'readback_mismatch' } });
  const next = await ops.plan({ kind: 'update', entity: 'plans', id: 3, payload: { name: 'Rename' } });
  await assert.rejects(ops.apply(next.planId, next.planHash, 'geo-fenced-update'), { code: 'unresolved_write_blocks_new_mutation' });
  available = true;
  const restarted = new Operations(new Store(store.root, store.owner, { codec: store.codec }), api);
  const receipt = await restarted.reconcile('geo-nested-create');
  assert.equal(receipt.phase, 'verified'); assert.equal(receipt.errorDetails, undefined);
  assert.deepEqual(receipt.children, [{ entity: 'groups', objectId: 4, children: [{ entity: 'banners', objectId: 5 }] }]);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'other-geo-create-id'), receipt);
  assert.equal(writes, 1);
});
test('nested verification rejects conflicting aliases, foreign parents and incomplete child inventories', async t => {
  for (const mode of ['conflicting_alias', 'foreign_parent', 'truncated', 'extra', 'duplicate', 'ambiguous']) {
    const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0;
    const spec = { kind: 'create', entity: 'plans', payload: { name: 'P', ad_groups: [{ name: 'G', package_id: 2, banners: [{ name: 'B' }] }] } };
    if (['duplicate', 'ambiguous'].includes(mode)) spec.payload.ad_groups[0].banners.push({ name: 'B' });
    api.request = async () => { writes++; return mode === 'conflicting_alias' ? { id: 3, ad_groups: [{ id: 4 }], campaigns: [{ id: 9 }] } : { id: 3, campaigns: [{ id: 4 }] }; };
    api.get = async (entity, number) => entity === 'plans' ? { id: number, name: 'P', status: 'blocked' }
      : entity === 'groups' ? { id: number, ad_plan_id: mode === 'foreign_parent' ? 99 : 3, name: 'G', package_id: 2, status: 'blocked' }
      : { id: number, ad_group_id: 4, name: 'B', status: 'blocked' };
    api.list = async () => ({ items: ['extra', 'ambiguous'].includes(mode) ? [{ id: 5, ad_group_id: 4 }, { id: 6, ad_group_id: 4 }]
      : mode === 'duplicate' ? [{ id: 5, ad_group_id: 4 }, { id: 5, ad_group_id: 4 }] : [{ id: 5, ad_group_id: 4 }], count: ['extra', 'duplicate', 'ambiguous'].includes(mode) ? 2 : 1, truncated: mode === 'truncated' });
    const ops = new Operations(store, api), plan = await ops.plan(spec);
    assert.equal((await ops.apply(plan.planId, plan.planHash, `nested-invalid-${mode}`)).phase, 'written_unverified');
    assert.equal((await ops.reconcile(`nested-invalid-${mode}`)).phase, 'written_unverified');
    assert.equal(writes, 1);
  }
});
async function localHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: k => res.headers[k] }, text: async () => Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end(body);
  });
}
async function formLoad(url) {
  return localHttp(url, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' } });
}
function formSubmit(url, packet, extra = {}) { return localHttp(url, { method: 'POST', headers: { Origin: new URL(url).origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(packet) }); }
test('protected form rejects wrong nonce/origin, oversize body and replay; returns no secrets', async () => {
  let finished; const form = input({ open: async url => {
    assert.equal((await fetch(`${url}wrong`)).status, 403);
    const loaded = await formLoad(url); assert.equal(loaded.status, 200); assert.match(loaded.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await formSubmit(url, { action: 'save', values: auth() }, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await formSubmit(url, { action: 'save', values: { ...auth(), client_secret: 'x'.repeat(13000) } })).status, 403);
    const saved = await formSubmit(url, { action: 'save', values: auth() }); assert.equal(saved.status, 200); assert.doesNotMatch(await saved.text(), /synthetic-only-secret/);
    assert.equal((await formSubmit(url, { action: 'save', values: auth() })).status, 403); finished = url;
  } });
  assert.deepEqual(await form, auth()); await assert.rejects(fetch(finished));
});
test('protected form distinguishes cancel, expiry and opener failure and cleans up', async () => {
  await assert.rejects(input({ open: async url => { await formLoad(url); await formSubmit(url, { action: 'cancel', values: {} }); } }), { code: 'user_cancelled' });
  await assert.rejects(input({ open: async () => {}, timeout: 10 }), { code: 'input_timeout' });
  await assert.rejects(input({ open: async () => { throw new Error('private URI'); } }), { code: 'local_page_open_failed' });
});
test('submitted setup persists encrypted readiness without a chat acknowledgement; cancellation keeps prior credentials', async t => {
  const store = await fixture(t); let state = await store.read(); const operation = crypto.randomUUID();
  state.plans = { dispatched: { id: 'dispatched', op: { kind: 'update' } }, unused: { id: 'unused' } };
  state.operations.previous = { planId: 'dispatched', phase: 'verified' };
  state.setup = { id: operation, scope: scope(store.owner), phase: 'starting', expires: Date.now() + 60000 }; await store.write(state);
  await configureWorker(store, operation, { prompt: async () => ({ ...auth(), client_secret: 'replacement-secret' }), makeApi: value => ({ auth: value, login: async () => {}, list: async () => ({ items: [] }) }) });
  state = await store.read(); assert.equal(state.setup.phase, 'ready'); assert.equal(state.credentials.client_secret, 'replacement-secret');
  assert.deepEqual(Object.keys(state.plans), ['dispatched']);
  assert.equal(state.operations.previous.phase, 'verified');
  assert.doesNotMatch(await fs.readFile(path.join(store.dir, 'state.enc'), 'utf8'), /replacement-secret|synthetic-client/);
  state.setup = { id: operation, scope: scope(store.owner), phase: 'starting', expires: Date.now() + 60000 }; await store.write(state);
  await configureWorker(store, operation, { prompt: async () => { throw new Fault('user_cancelled'); } });
  state = await store.read(); assert.equal(state.setup.phase, 'cancelled'); assert.equal(state.credentials.client_secret, 'replacement-secret');
});
test('setup status retains scope/lease, distinguishes process loss/expiry and returns a phase change immediately', async t => {
  const store = await fixture(t), state = await store.read(), operation = crypto.randomUUID();
  // Native storage involves real OS processes. A five-second lease and one-
  // second observation race assert CPU speed rather than continuation semantics.
  state.setup = { id: operation, scope: scope(store.owner), phase: 'waiting_input', pid: process.pid, expires: Date.now() + 120000 };
  await store.write(state);
  const pending = await setupStatus(store, operation); assert.equal(pending.phase, 'waiting_input'); assert.equal(pending.continuation.operation, operation);
  const timer = setTimeout(async () => { const current = await store.read(); current.setup.phase = 'checking'; await store.write(current); }, 20);
  t.after(() => clearTimeout(timer));
  const changed = await setupStatus(store, operation, 30000); assert.equal(changed.phase, 'checking'); assert.equal(changed.expiresAt, pending.expiresAt);
  const current = await store.read(); current.setup.pid = 2147483647; await store.write(current);
  assert.equal((await setupStatus(store, operation)).phase, 'process_lost');
  current.setup.expires = Date.now() - 1; await store.write(current); assert.equal((await setupStatus(store, operation)).phase, 'expired');
  const elsewhere = new Store(store.root, { ...store.owner, binding: 'b'.repeat(64) }, { codec: store.codec });
  await assert.rejects(setupStatus(elsewhere, operation), { code: 'setup_not_found' });
});
test('native storage roundtrip, private ACL and wrong-account rejection on the real supported OS', { skip: !['darwin', 'win32'].includes(process.platform) }, async t => {
  t.diagnostic('native roundtrip: bootstrap');
  const store = await fixture(t, {}), state = await store.read(); assert.equal(state.credentials.client_secret, 'synthetic-only-secret');
  const text = await fs.readFile(path.join(store.dir, 'state.enc'), 'utf8'); assert.doesNotMatch(text, /synthetic-only-secret/);
  t.diagnostic('native roundtrip: wrong-account');
  const stranger = new Store(store.root, owner()); await assert.rejects(stranger.open(text));
  if (process.platform === 'darwin') {
    const source = await fs.readFile(new URL('../scripts/vault-key.swift', import.meta.url));
    const binary = path.join(store.root, 'native', 'vk-ads', `vault-${hash(source).slice(0, 24)}`);
    store.nativeCleanup = async () => { await privateProcess(binary, [], JSON.stringify({ account: store.owner.account, mode: 'delete' })); await privateProcess(binary, [], JSON.stringify({ account: stranger.owner.account, mode: 'delete' })); stranger.close(); };
  } else {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT, executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const aclScript = `
      $ErrorActionPreference='Stop'
      [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
      [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35') | Out-Null
      $packet=([Web.Script.Serialization.JavaScriptSerializer]::new()).DeserializeObject([Console]::In.ReadToEnd())
      $acl=[IO.File]::GetAccessControl($packet.path)
      $acl.SetAccessRuleProtection([bool]$packet.protected,$false)
      [IO.File]::SetAccessControl($packet.path,$acl)
    `;
    const setProtection = protectedValue => privateProcess(executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', aclScript],
      JSON.stringify({ path: path.join(store.dir, 'state.enc'), protected: protectedValue }));
    // Real native negative evidence: opening inheritance must block the read
    // before decryption; repairing this synthetic ACL restores the same state.
    t.diagnostic('native roundtrip: open-inheritance');
    await setProtection(false);
    try { await assert.rejects(store.read(), { code: 'native_storage_unavailable' }); }
    finally { await setProtection(true); }
    t.diagnostic('native roundtrip: restored-private-read');
    assert.equal((await store.read()).credentials.client_secret, 'synthetic-only-secret');
    // The child ignores its parent's Restricted process policy without changing
    // machine/user policy. This is the native bootstrap regression, not a mock.
    const source = new URL('../scripts/vault-windows.ps1', import.meta.url);
    const policyScript = `
      $ErrorActionPreference='Stop'
      [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
      # JSON and serialization are fixed Framework operations, as in the real
      # helper. Implicit utility-module discovery otherwise consumes the native
      # deadline before the policy assertion runs on a cold hosted image.
      [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35') | Out-Null
      $packet=([Web.Script.Serialization.JavaScriptSerializer]::new()).DeserializeObject([Console]::In.ReadToEnd())
      $before=[Management.Automation.PSSerializer]::Serialize((Microsoft.PowerShell.Security\\Get-ExecutionPolicy -List))
      $env:PSExecutionPolicyPreference='Restricted'
      $start=[Diagnostics.ProcessStartInfo]::new()
      $start.FileName=$packet.executable
      $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$packet.helper+'"'
      $start.UseShellExecute=$false
      $start.RedirectStandardInput=$true
      $start.RedirectStandardOutput=$true
      $start.RedirectStandardError=$true
      $start.EnvironmentVariables.Remove('PSExecutionPolicyPreference')
      $child=[Diagnostics.Process]::Start($start)
      $child.StandardInput.Write($packet.input); $child.StandardInput.Close()
      $result=$child.StandardOutput.ReadToEnd(); $child.WaitForExit()
      if($child.ExitCode -ne 0){exit 8}
      $env:PSExecutionPolicyPreference='Bypass'
      if([Management.Automation.PSSerializer]::Serialize((Microsoft.PowerShell.Security\\Get-ExecutionPolicy -List)) -ne $before){exit 9}
      [Console]::Out.Write($result)
    `;
    const packet = JSON.stringify({ executable, helper: (await import('node:url')).fileURLToPath(source), input:
      JSON.stringify({ mode: 'seal', account: store.owner.account, data: Buffer.from('synthetic').toString('base64') }) });
    t.diagnostic('native roundtrip: process-policy');
    const result = await privateProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', policyScript], packet);
    assert.ok(result.length > 0);
  }
});
test('Linux setup fails closed rather than creating an unprotected credential store', { skip: process.platform !== 'linux' }, async t => {
  const store = await fixture(t);
  const native = new Store(store.root, store.owner); await assert.rejects(native.seal({ secret: 'synthetic' }), { code: 'secure_storage_unsupported' });
});
