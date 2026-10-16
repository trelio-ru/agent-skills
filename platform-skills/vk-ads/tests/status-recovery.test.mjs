import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations } from '../scripts/operations.mjs';
import { Fault, scope } from '../scripts/core.mjs';

const NOW = Date.parse('2030-01-01T10:00:00Z');
const copy = value => structuredClone(value);
const SPEC = { kind: 'status-recovery', entity: 'plans', id: 10, originalOperationId: 'original-status',
  guard: { endDate: '2030-01-03', maximumTotalBudget: '300', maximumDailyBudget: '150', groups: [
    { id: 20, status: 'active', budgetLimit: '100', budgetLimitDay: '50', banners: [{ id: 30, status: 'active' }] },
    { id: 21, status: 'blocked', budgetLimit: '100', budgetLimitDay: '50', banners: [{ id: 31, status: 'blocked' }] },
    { id: 22, status: 'blocked', budgetLimit: '100', budgetLimitDay: '50', banners: [{ id: 32, status: 'blocked' }] },
  ] } };

// The memory adapter clones each read/write, just like an encrypted durable
// envelope. Restart tests instantiate new Operations over the same committed
// state, so accidental mutation of an unsaved JS object cannot fake durability.
async function fixture() {
  let committed = { credentials: { client_id: 'synthetic', client_secret: 'synthetic-secret', groups: 'ad_groups' }, plans: {}, operations: {} };
  let tail = Promise.resolve();
  const store = { owner: { account: 'test-account', company: 'test-company', member: 'test-member', binding: 'test-binding' },
    read: async () => copy(committed), write: async value => { committed = copy(value); },
    lock: async fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  const parent = { id: 10, name: 'Synthetic parent', status: 'blocked', updated: '2030-01-01 09:00:00',
    budget_limit: null, budget_limit_day: null, objective: 'site_conversions', date_end: '2030-01-03' };
  const groups = SPEC.guard.groups.map(g => ({ id: g.id, ad_plan_id: 10, name: `Group ${g.id}`, status: g.status,
    updated: '2030-01-01 09:00:00', budget_limit: g.budgetLimit, budget_limit_day: g.budgetLimitDay,
    date_end: '2030-01-03', targetings: { regions: [1], segments: [2] }, package_id: 1 }));
  const banners = groups.map(g => ({ id: g.id + 10, ad_group_id: g.id, name: 'Synthetic creative', status: g.status,
    updated: '2030-01-01 09:00:00', moderation_status: 'allowed', content: { primary: { id: 1 } },
    urls: { primary: { id: 2, url: 'https://example.com/approved' } }, textblocks: { title: { text: 'Synthetic approved text' } } }));
  let posts = 0, listHook = null, getHook = null, dispatchHook = null;
  const requests = [];
  const api = { auth: committed.credentials, access: 'synthetic-token', endpoint: (entity, id) => `/api/v2/ad_plans/${id}.json`,
    get: async (entity, id, fields) => { assert.equal(entity, 'plans'); assert.equal(id, 10); if (getHook) await getHook(); return copy(parent); },
    list: async (entity, query, maximum) => {
      const items = entity === 'groups' ? groups : banners.filter(b => b.ad_group_id === query._ad_group_id);
      assert.ok(query.fields && maximum > 0); const page = { items: copy(items), count: items.length, truncated: false };
      if (listHook) await listHook(entity, page, query); return page;
    },
    request: async (method, route, options) => {
      requests.push({ method, route, body: copy(options?.body) }); posts++;
      assert.equal(method, 'POST'); assert.equal(route, '/api/v2/ad_plans/10.json'); assert.deepEqual(options.body, { status: 'active' });
      if (posts === 1) throw new Fault('write_result_unknown');
      if (dispatchHook) return dispatchHook(); parent.status = 'active'; parent.updated = '2030-01-01 10:00:01'; return {};
    } };
  const ops = new Operations(store, api, () => NOW);
  const initial = await ops.plan({ kind: 'update', entity: 'plans', id: 10, payload: { status: 'active' } });
  assert.equal((await ops.apply(initial.planId, initial.planHash, 'original-status')).phase, 'unknown');
  return { store, api, ops, parent, groups, banners, requests, count: () => posts,
    mutate: fn => { fn(committed); }, listHook: fn => { listHook = fn; }, getHook: fn => { getHook = fn; }, dispatchHook: fn => { dispatchHook = fn; } };
}

test('bounded status recovery verifies full tree, preserves uncertainty and dispatches exactly once across restart', async () => {
  const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
  assert.equal(plan.operation.review.groups.length, 3); assert.equal(plan.operation.effect.additionalDispatchesMaximum, 1);
  const recovery = await f.ops.apply(plan.planId, plan.planHash, 'recover-status');
  assert.equal(recovery.phase, 'verified'); assert.equal(recovery.recoveryOf, 'original-status'); assert.equal(f.count(), 2);
  const state = await f.store.read(), old = state.operations['original-status'];
  assert.equal(old.phase, 'resolved_by_status_recovery'); assert.equal(old.error, 'write_result_unknown');
  assert.equal(old.resolution.originalRequestOutcome, 'unknown'); assert.equal(old.resolution.currentStateVerified, true);
  assert.equal(old.statusRecoveryOperation, 'recover-status'); assert.equal(old.hash, state.plans[old.planId].hash);
  const restarted = new Operations(f.store, f.api, () => NOW);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'recover-status'), recovery);
  assert.deepEqual(await restarted.apply(plan.planId, plan.planHash, 'another-operation'), recovery);
  assert.equal(f.count(), 2); assert.deepEqual(f.banners.map(b => b.status), ['active', 'blocked', 'blocked']);
});

test('another timeout consumes the single recovery attempt; only GET reconciliation may finish it', async () => {
  const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
  f.dispatchHook(() => { throw new Fault('write_result_unknown'); });
  assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'recover-status')).phase, 'unknown');
  await assert.rejects(f.ops.plan(copy(SPEC)), { code: 'status_recovery_attempt_used' });
  const restarted = new Operations(f.store, f.api, () => NOW);
  assert.equal((await restarted.reconcile('recover-status')).phase, 'unknown'); assert.equal(f.count(), 2);
  f.parent.status = 'active'; f.parent.updated = '2030-01-01 10:00:05';
  assert.equal((await restarted.reconcile('recover-status')).phase, 'verified');
  assert.equal((await f.store.read()).operations['original-status'].phase, 'resolved_by_status_recovery');
  assert.equal(f.count(), 2);
});

test('old desired-state GET verification alone cannot clear an unresolved recovery receipt', async () => {
  const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
  f.dispatchHook(() => { f.parent.status = 'active'; throw new Fault('write_result_unknown'); });
  await f.ops.apply(plan.planId, plan.planHash, 'recover-status');
  assert.equal((await f.ops.reconcile('original-status')).phase, 'verified');
  const next = await f.ops.plan({ kind: 'update', entity: 'plans', id: 10, payload: { name: 'New' } });
  await assert.rejects(f.ops.apply(next.planId, next.planHash, 'another-write'), { code: 'unresolved_write_blocks_new_mutation' });
  assert.equal((await f.ops.reconcile('recover-status')).phase, 'verified'); assert.equal(f.count(), 2);
});

test('source eligibility cannot borrow create, different fields/target/scope or unrelated unknown writes', async () => {
  for (const mode of ['create', 'budget', 'extra-status-field', 'different-target', 'before-active', 'scope', 'hash', 'missing-plan', 'written-unverified', 'accepted', 'another-unknown']) {
    const f = await fixture();
    f.mutate(state => {
      const old = state.operations['original-status'], p = state.plans[old.planId];
      if (mode === 'create') p.op.kind = 'create';
      if (mode === 'budget') p.op.payload = { budget_limit: '100' };
      if (mode === 'extra-status-field') p.op.payload.name = 'Changed';
      if (mode === 'different-target') p.op.id = 11;
      if (mode === 'before-active') p.op.before.status = 'active';
      if (mode === 'scope') old.scope = 'foreign';
      if (mode === 'hash') old.hash = 'other';
      if (mode === 'missing-plan') delete state.plans[old.planId];
      if (mode === 'written-unverified') old.phase = 'written_unverified';
      if (mode === 'accepted') old.phase = 'accepted_unknown';
      if (mode === 'another-unknown') state.operations.foreign = { operationId: 'foreign-unknown', phase: 'unknown' };
    });
    await assert.rejects(f.ops.plan(copy(SPEC)), undefined, mode); assert.equal(f.count(), 1);
  }
});

test('fresh status recovery rejects changes to any bounded configuration and membership before dispatch', async () => {
  for (const mode of ['parent-status', 'parent-updated', 'parent-budget', 'group-status', 'group-budget', 'daily-budget', 'targeting', 'creative', 'url', 'text', 'extra-group', 'extra-banner', 'missing-group', 'missing-banner', 'wrong-parent', 'moderation']) {
    const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
    if (mode === 'parent-status') f.parent.status = 'active';
    if (mode === 'parent-updated') f.parent.updated = '2030-01-01 10:00:00';
    if (mode === 'parent-budget') f.parent.budget_limit_day = '200';
    if (mode === 'group-status') f.groups[1].status = 'active';
    if (mode === 'group-budget') f.groups[0].budget_limit = '101';
    if (mode === 'daily-budget') f.groups[0].budget_limit_day = '51';
    if (mode === 'targeting') f.groups[0].targetings.regions = [3];
    if (mode === 'creative') f.banners[0].content.primary.id = 3;
    if (mode === 'url') f.banners[0].urls.primary.id = 3;
    if (mode === 'text') f.banners[0].textblocks.title.text = 'Changed';
    if (mode === 'extra-group') f.groups.push({ ...copy(f.groups[0]), id: 23 });
    if (mode === 'extra-banner') f.banners.push({ ...copy(f.banners[0]), id: 33 });
    if (mode === 'missing-group') f.groups.pop();
    if (mode === 'missing-banner') f.banners.pop();
    if (mode === 'wrong-parent') f.groups[0].ad_plan_id = 11;
    if (mode === 'moderation') f.banners[0].moderation_status = 'pending';
    await assert.rejects(f.ops.apply(plan.planId, plan.planHash, 'recover-status'), undefined, mode);
    assert.equal(f.count(), 1, mode); assert.equal((await f.store.read()).operations['original-status'].statusRecoveryOperation, undefined);
  }
});

test('missing counts, duplicate IDs, malformed budgets and incomplete creative sections never admit recovery', async () => {
  for (const mode of ['count', 'truncated', 'duplicate-group', 'duplicate-banner', 'array-id', 'missing-targeting', 'missing-content', 'unlimited', 'invalid-period', 'missing-updated']) {
    const f = await fixture();
    f.listHook((entity, page) => {
      if (mode === 'count') delete page.count;
      if (mode === 'truncated') page.truncated = true;
      if (mode === 'duplicate-group' && entity === 'groups') page.items[1] = copy(page.items[0]);
      if (mode === 'duplicate-banner' && entity === 'banners') page.items[0].id = 31;
      if (mode === 'array-id') page.items[0].id = [page.items[0].id];
    });
    if (mode === 'missing-targeting') delete f.groups[0].targetings;
    if (mode === 'missing-content') delete f.banners[0].content;
    if (mode === 'unlimited') f.groups[0].budget_limit = '-1';
    if (mode === 'invalid-period') f.groups[0].date_end = '2030-01-04';
    if (mode === 'missing-updated') delete f.parent.updated;
    await assert.rejects(f.ops.plan(copy(SPEC)), undefined, mode); assert.equal(f.count(), 1);
  }
});

test('read-back of active alone cannot resolve changed targeting, creative, caps or missing coverage', async () => {
  for (const mode of ['status', 'creative', 'targeting', 'cap', 'missing-count']) {
    const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
    f.dispatchHook(() => {
      f.parent.status = mode === 'status' ? 'blocked' : 'active';
      if (mode === 'creative') f.banners[0].textblocks.title.text = 'Concurrent edit';
      if (mode === 'targeting') f.groups[0].targetings.regions = [4];
      if (mode === 'cap') f.groups[0].budget_limit = '101';
      if (mode === 'missing-count') f.listHook((entity, page) => { delete page.count; });
      return {};
    });
    assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'recover-status')).phase, 'written_unverified');
    assert.equal((await f.store.read()).operations['original-status'].phase, 'unknown'); assert.equal(f.count(), 2);
    await assert.rejects(f.ops.plan(copy(SPEC))); assert.equal(f.count(), 2);
  }
});

test('one root admits only one recovery despite two prepared plans and concurrent apply callers', async () => {
  const f = await fixture(), first = await f.ops.plan(copy(SPEC)), second = await f.ops.plan(copy(SPEC));
  const results = await Promise.allSettled([f.ops.apply(first.planId, first.planHash, 'recover-first'), f.ops.apply(second.planId, second.planHash, 'recover-second')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.count(), 2);
});

test('scope, guard, expiry, changed source and legacy resource checks remain closed', async () => {
  for (const mode of ['scope', 'extra-key', 'extra-group-key', 'guard-budget', 'guard-date', 'no-active', 'legacy', 'expired', 'changed-source']) {
    const f = await fixture(), spec = copy(SPEC);
    if (mode === 'scope') f.mutate(s => { s.operations['original-status'].scope = scope({ ...f.store.owner, company: 'other' }); });
    if (mode === 'extra-key') spec.payload = { status: 'active' };
    if (mode === 'extra-group-key') spec.guard.groups[0].targeting = {};
    if (mode === 'guard-budget') spec.guard.maximumTotalBudget = '299';
    if (mode === 'guard-date') spec.guard.endDate = '2030-01-01';
    if (mode === 'no-active') spec.guard.groups.forEach(g => { g.status = 'blocked'; });
    if (mode === 'legacy') f.api.auth.groups = 'campaigns';
    if (['expired', 'changed-source'].includes(mode)) {
      const plan = await f.ops.plan(spec);
      if (mode === 'expired') await assert.rejects(new Operations(f.store, f.api, () => NOW + 1800001).apply(plan.planId, plan.planHash, 'recover-status'), { code: 'plan_expired' });
      else { f.mutate(s => { s.operations['original-status'].hash = 'changed'; }); await assert.rejects(f.ops.apply(plan.planId, plan.planHash, 'recover-status')); }
    } else await assert.rejects(f.ops.plan(spec), undefined, mode);
    assert.equal(f.count(), 1);
  }
});

test('already active is handled by old GET reconciliation without a recovery dispatch', async () => {
  const f = await fixture(); f.parent.status = 'active';
  await assert.rejects(f.ops.plan(copy(SPEC)), { code: 'status_recovery_parent_changed' });
  assert.equal((await f.ops.reconcile('original-status')).phase, 'verified'); assert.equal(f.count(), 1);
});

test('generated derivatives and raw mutation metadata are excluded; exact assets and landing still stay guarded', async () => {
  const f = await fixture();
  f.banners[0].content.primary.variants = { '100x100': { url: 'https://example.com/generated-a' } };
  f.banners[0].owner = { people: ['synthetic-person'] };
  const plan = await f.ops.plan(copy(SPEC));
  assert.ok(!JSON.stringify(plan).includes('generated-a')); assert.ok(!JSON.stringify(plan).includes('synthetic-person'));
  f.dispatchHook(() => { f.parent.status = 'active'; f.banners[0].content.primary.variants['100x100'].url = 'https://example.com/generated-b'; return { unrequested: 'synthetic-private-response' }; });
  const receipt = await f.ops.apply(plan.planId, plan.planHash, 'recover-status');
  assert.equal(receipt.phase, 'verified'); assert.ok(!JSON.stringify(receipt).includes('synthetic-private-response'));
  assert.equal(f.count(), 2);
});

test('source resolution failure during GET-only recovery never drops the pending fence', async () => {
  const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
  f.dispatchHook(() => { throw new Fault('write_result_unknown'); });
  await f.ops.apply(plan.planId, plan.planHash, 'recover-status'); f.parent.status = 'active';
  f.mutate(s => { s.operations['original-status'].phase = 'accepted_unknown'; });
  const receipt = await f.ops.reconcile('recover-status');
  assert.equal(receipt.phase, 'unknown'); assert.equal(receipt.error, 'status_recovery_source_not_unknown'); assert.equal(f.count(), 2);
});

test('a failed final local save preserves both claims and completes by GET after restart without another dispatch', async () => {
  const f = await fixture(), plan = await f.ops.plan(copy(SPEC));
  const save = f.store.write; let failed = false;
  f.store.write = async value => {
    if (!failed && value.operations['recover-status']?.phase === 'verified') { failed = true; throw new Error('synthetic save failure'); }
    return save(value);
  };
  assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'recover-status')).phase, 'written_unverified');
  const restarted = new Operations(f.store, f.api, () => NOW);
  assert.equal((await restarted.reconcile('recover-status')).phase, 'verified'); assert.equal(f.count(), 2);
  assert.equal((await f.store.read()).operations['original-status'].resolution.currentStateVerified, true);
});

test('recovery shares only the existing targeting snapshot equivalences and preserves all other changes', async () => {
  for (const mode of ['sex-order', 'location-order', 'empty-segments', 'duplicate', 'membership', 'other-array']) {
    const f = await fixture();
    f.groups[0].targetings = { sex: ['male', 'female'], geo: { local_geo: { loc_type: ['home', 'work'] } }, segments: [], regions: [1, 2] };
    const plan = await f.ops.plan(copy(SPEC));
    if (mode === 'sex-order') f.groups[0].targetings.sex.reverse();
    if (mode === 'location-order') f.groups[0].targetings.geo.local_geo.loc_type.reverse();
    if (mode === 'empty-segments') delete f.groups[0].targetings.segments;
    if (mode === 'duplicate') f.groups[0].targetings.sex = ['female', 'male', 'male'];
    if (mode === 'membership') f.groups[0].targetings.sex = ['male'];
    if (mode === 'other-array') f.groups[0].targetings.regions.reverse();
    if (['sex-order', 'location-order', 'empty-segments'].includes(mode)) {
      assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'recover-status')).phase, 'verified'); assert.equal(f.count(), 2);
    } else { await assert.rejects(f.ops.apply(plan.planId, plan.planHash, 'recover-status')); assert.equal(f.count(), 1); }
  }
});
