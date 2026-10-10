import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { identity, credentials, Fault, hash, scope, clean, date } from '../scripts/core.mjs';
import { Store, privateProcess } from '../scripts/storage.mjs';
import { Api } from '../scripts/api.mjs';
import { Operations, prepare, matches } from '../scripts/operations.mjs';
import { input } from '../scripts/form.mjs';
import { argumentsOf, configureWorker, setupStatus } from '../scripts/trelio-vk-ads.mjs';

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
    if (url.pathname.includes('oauth2')) return json({ access_token: 'synthetic-token', expires_in: 600 });
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
test('agency auth selects a per-client token privately and cached tokens avoid token issuance', async () => {
  const api = new Api({ ...auth(), mode: 'agency', agency_client: 'synthetic-agency-client' }, { fetcher: async (_url, opts) => {
    assert.equal(opts.body.get('grant_type'), 'agency_client_credentials'); assert.equal(opts.body.get('agency_client_name'), 'synthetic-agency-client');
    return json({ access_token: 'cached-token', expires_in: 3600 });
  } });
  await api.login(); const cached = new Api(api.auth); assert.equal(cached.access, 'cached-token');
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
  api.get = async () => { calls++; if (calls > 2) throw new Fault('permission_denied'); return { id: 1, status: 'blocked' }; };
  api.request = async () => ({});
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'plans', id: 1, payload: { status: 'active' } });
  const receipt = await ops.apply(plan.planId, plan.planHash, 'readback-failure'); assert.equal(receipt.phase, 'written_unverified');
});
test('reconcile a committed update after timeout uses only readback, never another write', async t => {
  const store = await fixture(t), api = new Api(auth()); api.access = 'token'; let writes = 0, current = { id: 9, status: 'active' };
  api.get = async () => current; api.request = async () => { writes++; current = { id: 9, status: 'blocked' }; throw new Fault('write_result_unknown'); };
  const ops = new Operations(store, api), plan = await ops.plan({ kind: 'update', entity: 'plans', id: 9, payload: { status: 'blocked' } });
  assert.equal((await ops.apply(plan.planId, plan.planHash, 'lost-update')).phase, 'unknown');
  assert.equal((await ops.reconcile('lost-update')).phase, 'verified'); assert.equal(writes, 1);
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
  api.get = async (entity, number) => entity === 'groups' ? { id: number, name: 'G', package_id: 2, ad_plan_id: 3, status: 'blocked' } : { id: number, name: 'B', status: 'blocked' };
  const ops = new Operations(store, api), plan = await ops.plan(spec); assert.equal((await ops.apply(plan.planId, plan.planHash, 'nested-create')).phase, 'verified');
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
  await configureWorker(store, operation, { prompt: async () => ({ ...auth(), client_secret: 'replacement-secret' }), makeApi: () => ({ list: async () => ({ items: [] }) }) });
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
  const store = await fixture(t, {}), state = await store.read(); assert.equal(state.credentials.client_secret, 'synthetic-only-secret');
  const text = await fs.readFile(path.join(store.dir, 'state.enc'), 'utf8'); assert.doesNotMatch(text, /synthetic-only-secret/);
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
    await setProtection(false);
    try { await assert.rejects(store.read(), { code: 'native_storage_unavailable' }); }
    finally { await setProtection(true); }
    assert.equal((await store.read()).credentials.client_secret, 'synthetic-only-secret');
    // The child ignores its parent's Restricted process policy without changing
    // machine/user policy. This is the native bootstrap regression, not a mock.
    const source = new URL('../scripts/vault-windows.ps1', import.meta.url);
    const policyScript = `
      $ErrorActionPreference='Stop'
      [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
      $packet=[Console]::In.ReadToEnd() | ConvertFrom-Json
      $before=Get-ExecutionPolicy -List | ConvertTo-Json -Compress
      $env:PSExecutionPolicyPreference='Restricted'
      $start=New-Object Diagnostics.ProcessStartInfo
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
      if((Get-ExecutionPolicy -List | ConvertTo-Json -Compress) -ne $before){exit 9}
      [Console]::Out.Write($result)
    `;
    const packet = JSON.stringify({ executable, helper: (await import('node:url')).fileURLToPath(source), input:
      JSON.stringify({ mode: 'seal', account: store.owner.account, data: Buffer.from('synthetic').toString('base64') }) });
    const result = await privateProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', policyScript], packet);
    assert.ok(result.length > 0);
  }
});
test('Linux setup fails closed rather than creating an unprotected credential store', { skip: process.platform !== 'linux' }, async t => {
  const store = await fixture(t);
  const native = new Store(store.root, store.owner); await assert.rejects(native.seal({ secret: 'synthetic' }), { code: 'secure_storage_unsupported' });
});
