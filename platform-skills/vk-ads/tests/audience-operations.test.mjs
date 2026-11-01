import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Api } from '../scripts/api.mjs';
import { Operations, prepare } from '../scripts/operations.mjs';

// The journal algorithm is exercised with process-independent state copies;
// the native encrypted persistence regression lives beside the Store fixtures.
class MemoryStore {
  constructor(shared = { value: { credentials: {}, plans: {}, operations: {} } }, owner = {
    account: crypto.randomUUID(), company: crypto.randomUUID(), member: crypto.randomUUID(), binding: 'a'.repeat(64),
  }) { this.shared = shared; this.owner = owner; }
  async read() { return structuredClone(this.shared.value); }
  async write(value) { this.shared.value = structuredClone(value); }
  async lock(fn) { return fn(); }
}
const json = (value, status = 200) => status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(value), { status });
function fixture() {
  const store = new MemoryStore(), calls = [], model = {
    segment: { id: 10, name: 'Synthetic audience', pass_condition: 1, campaign_ids: [], flags: [] },
    relations: [
      { id: 20, object_id: 30, object_type: 'remarketing_users_list', params: { source_id: 100, type: 'positive', unsupported: { value: 'must-not-escape' } } },
      { id: 21, object_id: 50, object_type: 'segment' },
    ],
    userList: { id: 100, name: 'Synthetic list', status: 'ready', type: 'emails', users: ['must-not-escape'] },
    counter: { id: 70, counter_id: 7, name: 'Synthetic counter', working: false, status: 'active', users: ['must-not-escape'] },
    goal: { id: 3, name: 'Synthetic registration', condition: 'jse', substr: 'signup', goal_type: 'registration' },
    group: { id: 1, package_id: 2, ad_plan_id: 4, objective: 'site_conversions', autobidding_mode: 'max_goals' },
    deletion: 'normal', failure: null,
  };
  const api = new Api({ groups: 'ad_groups', client_secret: 'synthetic-only-secret' }, { sleep: async () => {}, fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://ads.vk.com'); assert.equal(options.redirect, 'error');
    calls.push({ method: options.method, path: url.pathname, body: options.body ? JSON.parse(options.body) : null });
    const body = calls.at(-1).body;
    if (options.method !== 'GET') {
      if (model.failure === 'before-write') return json({}, 503);
      if (url.pathname.endsWith('/ad_groups/1.json')) { Object.assign(model.group, body); if (model.failure === 'after-write') throw Error('private'); return json({}, 204); }
      if (url.pathname.endsWith('/users_lists/100.json')) {
        if (options.method === 'DELETE') model.userList.status = model.deletion === 'pending' ? 'pending_delete' : 'deleted';
        else Object.assign(model.userList, body);
        if (model.failure === 'after-write') throw Error('private'); return json({}, 204);
      }
      if (url.pathname.endsWith('/segments/10.json')) {
        if (options.method === 'DELETE') model.deleted = true; else Object.assign(model.segment, body);
        if (model.failure === 'after-write') throw Error('private'); return json({}, 204);
      }
      if (url.pathname.endsWith('/relations/20.json')) {
        if (options.method === 'DELETE') model.relations = model.relations.filter(v => v.id !== 20);
        else Object.assign(model.relations[0].params, body.params);
        if (model.failure === 'after-write') throw Error('private'); return json({ id: 20, users: ['must-not-escape'] });
      }
      if (url.pathname.endsWith('/segments/10/relations.json')) {
        const item = { ...body.items[0], id: 22, object_id: 1000 }; model.relations.push(item);
        if (model.failure === 'after-write') throw Error('private'); return json({ items: [{ id: 22, users: ['must-not-escape'] }] });
      }
      if (url.pathname === '/api/v2/remarketing/segments.json') {
        model.newSegment = { id: 11, name: body.name, pass_condition: body.pass_condition, campaign_ids: [] };
        model.newRelations = body.relations.map((v, i) => ({ ...v, id: 100 + i, ...(v.object_id ? {} : { object_id: 1000 + i }) }));
        if (model.failure === 'after-write') throw Error('private'); return json({ id: 11, users: ['must-not-escape'] });
      }
      throw Error('Unexpected mutation');
    }
    if (url.pathname.endsWith('/ad_groups/1.json')) return json(model.group);
    if (url.pathname.endsWith('/counters.json')) return json({ items: [model.counter] });
    if (url.pathname.endsWith('/counters/7/goals.json')) return json({ items: [model.goal] });
    if (url.pathname.endsWith('/users_lists/100.json')) {
      if (model.denied) return json({}, 403); return json(model.userList);
    }
    if (url.pathname.endsWith('/segments/50.json')) return json({ id: 50, name: 'Synthetic nested audience', pass_condition: 1, relations_count: 1 });
    if (url.pathname.endsWith('/segments/10.json')) return model.deleted ? json({}, model.denied ? 403 : 404) : json({ ...model.segment, relations_count: model.relations.length });
    if (url.pathname.endsWith('/segments/10/relations.json')) return model.relationReadMissing ? json({}, 404) : json({ items: model.relations });
    if (url.pathname.endsWith('/segments/11.json')) return json({ ...model.newSegment, relations_count: model.newRelations.length });
    if (url.pathname.endsWith('/segments/11/relations.json')) return json({ items: model.newRelations });
    throw Error('Unexpected read');
  } }); api.access = 'synthetic-only-token';
  return { store, api, ops: new Operations(store, api), model, calls };
}
const spec = (entity, action, payload, id = 10) => ({ kind: 'audience', entity, action, ...(action !== 'create' ? { id } : {}),
  ...(entity === 'relations' ? { segmentId: 10 } : {}), ...(action !== 'delete' ? { payload } : {}) });
const apply = async (f, specification, operation = 'synthetic-operation') => {
  const plan = await f.ops.plan(specification); return f.ops.apply(plan.planId, plan.planHash, operation);
};

test('segment and relation CRUD use documented single-object routes, verify every requested rule and keep people out of receipts', async () => {
  const f = fixture();
  const created = await apply(f, spec('segments', 'create', { name: 'New synthetic', pass_condition: 1,
    relations: [{ object_type: 'remarketing_users_list', params: { source_id: 100, type: 'negative' } }, { object_type: 'segment', object_id: 50 }] }), 'create-segment');
  assert.equal(created.phase, 'verified'); assert.equal(created.objectId, 11);
  assert.equal((await apply(f, spec('segments', 'update', { name: 'Renamed synthetic', pass_condition: 2 }), 'update-segment')).phase, 'verified');
  f.model.segment.pass_condition = 1;
  const added = await apply(f, spec('relations', 'create', { object_type: 'remarketing_users_list', params: { source_id: 100, type: 'positive' } }), 'create-relation');
  assert.equal(added.phase, 'verified'); assert.equal(added.objectId, 22);
  const updated = await apply(f, spec('relations', 'update', { params: { type: 'negative' } }, 20), 'update-relation');
  assert.equal(updated.phase, 'verified'); assert.deepEqual(f.model.relations[0].params.unsupported, { value: 'must-not-escape' });
  assert.equal((await apply(f, spec('relations', 'delete', null, 20), 'delete-relation')).phase, 'verified');
  assert.ok(!JSON.stringify(f.store.shared.value).includes('must-not-escape'));
  assert.equal(f.calls.filter(v => v.method !== 'GET').length, 5);
});

test('full opaque params snapshots block stale unknown-rule edits without persisting their values', async () => {
  const f = fixture(), plan = await f.ops.plan(spec('relations', 'update', { params: { type: 'negative' } }, 20));
  assert.ok(!JSON.stringify(plan).includes('must-not-escape'));
  f.model.relations[0].params.unsupported.value = 'changed-rule';
  await assert.rejects(f.ops.apply(plan.planId, plan.planHash, 'stale-unknown-rule'), { code: 'object_changed_replan_required' });
  assert.equal(f.calls.filter(v => v.method !== 'GET').length, 0);
  const sources = fixture(), create = await sources.ops.plan(spec('relations', 'create', { object_type: 'remarketing_users_list', params: { source_id: 100, type: 'positive' } }));
  sources.model.userList.name = 'Changed source';
  await assert.rejects(sources.ops.apply(create.planId, create.planHash, 'stale-source-proof'), { code: 'source_changed_replan_required' });
});

test('known delete recovers only by GET after timeout and does not interpret 403 or a missing relation endpoint as deletion', async () => {
  const f = fixture(), plan = await f.ops.plan(spec('segments', 'delete')); f.model.failure = 'after-write';
  const unknown = await f.ops.apply(plan.planId, plan.planHash, 'lost-delete-result'); assert.equal(unknown.phase, 'unknown');
  const restarted = new Operations(new MemoryStore(f.store.shared, f.store.owner), f.api);
  const before = f.calls.length, result = await restarted.reconcile('lost-delete-result');
  assert.equal(result.phase, 'verified'); assert.ok(f.calls.slice(before).every(v => v.method === 'GET'));
  await restarted.apply(plan.planId, plan.planHash, 'second-delete-id'); assert.equal(f.calls.filter(v => v.method === 'DELETE').length, 1);
  const denied = fixture(), deniedPlan = await denied.ops.plan(spec('segments', 'delete')); denied.model.failure = 'after-write';
  await denied.ops.apply(deniedPlan.planId, deniedPlan.planHash, 'denied-delete-result'); denied.model.denied = true;
  assert.equal((await denied.ops.reconcile('denied-delete-result')).phase, 'unknown');
  const missing = fixture(), missingPlan = await missing.ops.plan(spec('segments', 'delete'));
  missing.model.failure = 'before-write'; await missing.ops.apply(missingPlan.planId, missingPlan.planHash, 'unchanged-delete-result');
  missing.model.relationReadMissing = true;
  assert.equal((await missing.ops.reconcile('unchanged-delete-result')).phase, 'unknown');
});

test('async users-list deletion remains fenced until exact read confirms deleted and rename handles 204', async () => {
  const f = fixture();
  assert.equal((await apply(f, spec('users-lists', 'update', { name: 'Renamed list' }, 100), 'rename-users-list')).phase, 'verified');
  f.model.deletion = 'pending'; const pending = await apply(f, spec('users-lists', 'delete', null, 100), 'delete-users-list');
  assert.equal(pending.phase, 'written_unverified'); assert.equal(pending.error, 'audience_deletion_not_confirmed');
  const next = await f.ops.plan(spec('segments', 'update', { name: 'Other change' }));
  await assert.rejects(f.ops.apply(next.planId, next.planHash, 'blocked-by-pending'), { code: 'unresolved_write_blocks_new_mutation' });
  assert.equal((await f.ops.reconcile('delete-users-list')).phase, 'written_unverified');
  f.model.userList.status = 'deleted'; assert.equal((await f.ops.reconcile('delete-users-list')).phase, 'verified');
  assert.equal(f.calls.filter(v => v.method === 'DELETE').length, 1);
});

test('explicit Top goal derives source/condition from known ids, preserves strategy and recovers a lost response without POST replay', async () => {
  const f = fixture(), plan = await f.ops.plan({ kind: 'goal', entity: 'groups', id: 1, counterSourceId: 70, goalId: 3 });
  assert.deepEqual(plan.operation.payload, { priced_goal: { source_id: 7, name: 'jse:signup' } });
  assert.equal(plan.operation.before.counter.working, false); assert.equal(plan.operation.before.goalsTruncated, true);
  assert.ok(!JSON.stringify(plan).includes('must-not-escape')); f.model.failure = 'after-write';
  assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'lost-goal-result')).phase, 'unknown');
  const before = f.calls.length, result = await f.ops.reconcile('lost-goal-result'); assert.equal(result.phase, 'verified');
  assert.ok(f.calls.slice(before).every(v => v.method === 'GET')); assert.equal(f.model.group.autobidding_mode, 'max_goals');
  assert.equal(f.calls.filter(v => v.method === 'POST').length, 1);
  const stale = fixture(), stalePlan = await stale.ops.plan({ kind: 'goal', entity: 'groups', id: 1, counterSourceId: 70, goalId: 3 });
  stale.model.goal.substr = 'changed-event';
  await assert.rejects(stale.ops.apply(stalePlan.planId, stalePlan.planHash, 'stale-goal-result'), { code: 'object_changed_replan_required' });
});

test('lost create id remains manual even with a known parent and a matching rule; no create/write transport replay', async () => {
  const f = fixture(), plan = await f.ops.plan(spec('relations', 'create', { object_type: 'remarketing_users_list', params: { source_id: 100, type: 'positive' } }));
  f.model.failure = 'after-write'; const result = await f.ops.apply(plan.planId, plan.planHash, 'lost-relation-result'); assert.equal(result.phase, 'unknown');
  const before = f.calls.length; assert.equal((await f.ops.reconcile('lost-relation-result')).phase, 'unknown'); assert.equal(f.calls.length, before);
  await f.ops.apply(plan.planId, plan.planHash, 'second-relation-id'); assert.equal(f.calls.filter(v => v.method === 'POST').length, 1);
});

test('closed audience contracts forbid people upload, arbitrary params, last-source deletion, cycles and unproved goal ids', async () => {
  const f = fixture();
  for (const invalid of [
    spec('users-lists', 'create', { name: 'No people upload', users: ['private'] }),
    spec('relations', 'create', { object_type: 'remarketing_search_phrases', params: { source_id: 100, type: 'positive' } }),
    spec('relations', 'create', { object_type: 'segment', object_id: 10 }),
    spec('relations', 'update', { params: { source_id: 999 } }, 20),
    spec('relations', 'update', { params: { left: 12, right: 0 } }, 20),
    spec('segments', 'update', { pass_condition: 3 }),
    { kind: 'goal', entity: 'groups', id: 1, counterSourceId: 70, goalId: 999 },
    { kind: 'goal', entity: 'groups', id: 1, counterSourceId: 70, goalId: 3, source_id: 100 },
    { kind: 'goal', entity: 'groups', id: [1], counterSourceId: 70, goalId: 3 },
    spec('relations', 'create', { object_type: 'remarketing_users_list', params: { source_id: [100], type: 'positive' } }),
  ]) await assert.rejects(prepare(f.api, invalid));
  f.model.segment.pass_condition = 2; await assert.rejects(prepare(f.api, spec('relations', 'delete', null, 20)), { code: 'segment_condition_invalid' });
  f.model.segment.campaign_ids = [500]; await assert.rejects(prepare(f.api, spec('segments', 'delete')), { code: 'audience_is_used_or_usage_unknown' });
  assert.ok(f.calls.every(v => v.method === 'GET'));
});

test('wrong object id, altered siblings, source or full params cannot become verified and account scope cannot apply another plan', async () => {
  const f = fixture(), plan = await f.ops.plan(spec('relations', 'update', { params: { type: 'negative' } }, 20));
  const foreign = new Operations(new MemoryStore(f.store.shared), f.api);
  await assert.rejects(foreign.apply(plan.planId, plan.planHash, 'foreign-scope-result'), { code: 'plan_scope_or_hash_invalid' });
  f.model.failure = 'after-write'; await f.ops.apply(plan.planId, plan.planHash, 'changed-readback-result');
  f.model.relations[1].object_id = 999;
  assert.equal((await f.ops.reconcile('changed-readback-result')).phase, 'unknown');
  assert.equal(f.calls.filter(v => v.method !== 'GET').length, 1);
});

test('counter relation interval and goal filter patch preserves source and unknown rules; a reordered or dropped rule cannot pass', async () => {
  const f = fixture();
  f.model.relations[0].object_type = 'remarketing_counter';
  Object.assign(f.model.relations[0].params, { source_id: 7, goal_id: 'uss', left: 365, right: 0 });
  const result = await apply(f, spec('relations', 'update', { params: { left: 30, right: 1, goal_id: 'jse:signup', type: 'negative' } }, 20));
  assert.equal(result.phase, 'verified'); assert.equal(f.model.relations[0].params.source_id, 7);
  assert.equal(f.model.relations[0].params.goal_id, 'jse:signup'); assert.ok(f.model.relations[0].params.unsupported);
  const plan = await f.ops.plan(spec('relations', 'update', { params: { left: 10 } }, 20));
  f.model.failure = 'after-write'; await f.ops.apply(plan.planId, plan.planHash, 'dropped-unknown-rule');
  delete f.model.relations[0].params.unsupported;
  assert.equal((await f.ops.reconcile('dropped-unknown-rule')).phase, 'unknown');
  await assert.rejects(prepare(f.api, spec('relations', 'update', { params: { right: 31 } }, 20)), { code: 'relation_interval_invalid' });
});

test('wrong response identities or changed strategy after goal mutation stay unverified', async () => {
  const f = fixture(), plan = await f.ops.plan({ kind: 'goal', entity: 'groups', id: 1, counterSourceId: 70, goalId: 3 });
  f.model.failure = 'after-write'; await f.ops.apply(plan.planId, plan.planHash, 'changed-strategy-result');
  f.model.group.autobidding_mode = 'changed_strategy'; assert.equal((await f.ops.reconcile('changed-strategy-result')).phase, 'unknown');
  f.model.group.id = 999; assert.equal((await f.ops.reconcile('changed-strategy-result')).phase, 'unknown');
  assert.equal(f.calls.filter(v => v.method === 'POST').length, 1);
});
