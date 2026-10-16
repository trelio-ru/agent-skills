import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Api } from '../scripts/api.mjs';
import { Operations, prepare } from '../scripts/operations.mjs';
import { audience, sources, vkGroups, vkGroupQuery } from '../scripts/diagnostics.mjs';
import { argumentsOf } from '../scripts/trelio-vk-ads.mjs';

// All rows and identities are synthetic. Production HTTP paths go through the
// actual Api boundary, but the injected fetcher never leaves this process.
class MemoryStore {
  constructor(shared = { value: { credentials: {}, plans: {}, operations: {} } }, owner = {
    account: crypto.randomUUID(), company: crypto.randomUUID(), member: crypto.randomUUID(), binding: 'a'.repeat(64),
  }) { this.shared = shared; this.owner = owner; }
  async read() { return structuredClone(this.shared.value); }
  async write(value) { this.shared.value = structuredClone(value); }
  async lock(fn) { return fn(); }
}
const json = (value, status = 200) => status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(value), { status });
const create = () => ({ kind: 'audience', entity: 'vk-groups', action: 'create', groupQuery: 'sample_group', payload: { object_id: 101 } });
const remove = () => ({ kind: 'audience', entity: 'vk-groups', action: 'delete', id: 901 });
function fixture() {
  const store = new MemoryStore(), calls = [], model = {
    dictionary: [{ id: 101, shortname: 'sample_group', name: 'Synthetic community', members_count: 2500, users: ['must-not-escape'] }],
    sources: [], failure: null, readStatus: 200, partial: false, used: false,
  };
  const api = new Api({ groups: 'ad_groups', client_secret: 'synthetic-secret' }, { sleep: async () => {}, fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://ads.vk.com'); assert.equal(options.redirect, 'error');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (options.method !== 'GET') {
      assert.ok(Object.values(store.shared.value.operations).some(v => v.phase === 'unknown'), 'journal precedes network dispatch');
      if (url.pathname === '/api/v2/remarketing/vk_groups.json') {
        assert.equal(options.method, 'POST'); assert.deepEqual(body, { object_id: 101 });
        model.sources.push({ id: 901, object_id: body.object_id, name: 'Synthetic community', shortname: 'sample_group',
          status: 'loading', loaded_users_count: 0, users_count: 2500, users: ['must-not-escape'], history: ['must-not-escape'] });
        if (model.failure === 'after-write') throw Error('private');
        if (model.failure === 'readback') model.readStatus = 403;
        return json({ ...model.sources[0], private: 'must-not-escape' }, 201);
      }
      if (url.pathname === '/api/v2/remarketing/vk_groups/901.json') {
        assert.equal(options.method, 'DELETE');
        if (model.used) return json({ error: { code: 'conflict' } }, 409);
        model.sources = [];
        if (model.failure === 'after-write') throw Error('private');
        if (model.failure === 'partial') model.partial = true;
        return json({}, 204);
      }
      if (url.pathname === '/api/v2/remarketing/segments.json') {
        model.segment = { id: 11, name: body.name, pass_condition: body.pass_condition, relations_count: body.relations.length };
        // A relation's opaque object reference is a third namespace, distinct
        // from both the public group id101 and registered source id901.
        model.relations = body.relations.map(v => ({ ...v, id: 501, object_id: 701 }));
        return json({ id: 11 });
      }
      throw Error('Unexpected mutation');
    }
    if (url.pathname === '/api/v2/vk_groups.json') {
      assert.ok(url.searchParams.get('_q')); assert.equal(url.searchParams.has('limit'), false);
      return json({ items: model.dictionary, count: model.dictionary.length });
    }
    if (url.pathname === '/api/v2/remarketing/vk_groups.json') {
      if (model.readStatus !== 200) return json({}, model.readStatus);
      const items = model.sources.filter(v => !url.searchParams.has('_id__in') || String(v.id) === url.searchParams.get('_id__in'));
      return json({ items, ...(model.partial ? {} : { count: items.length }) });
    }
    if (url.pathname === '/api/v2/remarketing/segments/11.json') return json(model.segment);
    if (url.pathname === '/api/v2/remarketing/segments/11/relations.json') return json({ items: model.relations });
    throw Error('Unexpected read');
  } }); api.access = 'synthetic-token';
  return { store, api, calls, model, ops: new Operations(store, api) };
}
async function apply(f, spec, operation) {
  const plan = await f.ops.plan(spec); return f.ops.apply(plan.planId, plan.planHash, operation);
}
function readFixture() {
  const f = fixture();
  f.model.sources = [{ id: 901, object_id: 101, name: 'Synthetic community', shortname: 'sample_group',
    status: 'loaded', loaded_users_count: 123, users_count: 2500, users: ['must-not-escape'] }];
  f.model.segment = { id: 11, name: 'Synthetic segment', pass_condition: 1, relations_count: 1 };
  f.model.relations = [{ id: 501, object_id: 701, object_type: 'remarketing_vk_group', params: { source_id: 101, type: 'positive' } }];
  return f;
}

test('advertising dictionary resolves exact shortname/id, never a similar display name or an arbitrary URL', async () => {
  const f = fixture();
  f.model.dictionary.push({ id: 102, shortname: 'other_group', name: 'sample_group', members_count: 5000, users: ['must-not-escape'] });
  const result = await vkGroups(f.api, 'https://vk.com/SAMPLE_GROUP');
  assert.equal(result.resolution, 'exact_shortname'); assert.equal(result.resolved.id, 101);
  assert.equal(result.sourceRegistrationChecked, false); assert.equal(result.campaignEligibility, 'not_assessed');
  assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  assert.deepEqual(vkGroupQuery('club101'), { query: 'club101', publicId: 101 });
  assert.equal((await vkGroups(f.api, 'public101')).resolved.id, 101);
  assert.equal((await vkGroups(f.api, 'missing_group')).resolution, 'not_found_in_results');
  f.model.dictionary[1].shortname = 'SAMPLE_GROUP';
  assert.equal((await vkGroups(f.api, 'sample_group')).resolution, 'ambiguous');
  const before = f.calls.length;
  for (const value of ['https://evil.example/sample_group', 'https://vk.com@evil.example/group', 'https://vk.com/sample_group?access_token=x',
    'https://vk.com/sample_group/posts', 'http://vk.com/sample_group', '../sample_group', 'sample group', ' sample_group', [101], 'club2147483648']) {
    assert.throws(() => vkGroupQuery(value));
  }
  assert.equal(f.calls.length, before); assert.ok(f.calls.every(v => v.method === 'GET'));
  assert.equal(argumentsOf(['vk-groups', '--query', 'sample_group']).command, 'vk-groups');
  assert.throws(() => argumentsOf(['vk-groups', '--url', 'https://example.com']));
});

test('a broad lookup resolves a late exact match without returning the whole dictionary or confusing scan and preview bounds', async () => {
  const f = fixture();
  f.model.dictionary = Array.from({ length: 250 }, (_, index) => ({ id: 1000 + index, shortname: `synthetic_${index}`,
    name: `Synthetic community ${index} ${'Длинное название '.repeat(8)}`, members_count: 2000 }));
  f.model.dictionary.at(-1).shortname = 'sample_group';
  const result = await vkGroups(f.api, 'sample_group');
  assert.equal(result.resolved.id, 1249); assert.equal(result.scannedCount, 250); assert.equal(result.scanTruncated, false);
  assert.equal(result.items.length, 20); assert.equal(result.truncated, true);
  assert.ok(!result.items.some(v => v.id === result.resolved.id));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 14000);
  assert.ok(Buffer.byteLength(JSON.stringify(f.model.dictionary)) > 40000);
  const bounded = await vkGroups(f.api, 'sample_group', 5);
  assert.equal(bounded.resolved, null); assert.equal(bounded.scanTruncated, true); assert.equal(bounded.scannedCount, 5);
  f.model.dictionary[0].name = '\\'.repeat(4000); f.model.dictionary[1].name = '\\'.repeat(4000);
  const byteBounded = await vkGroups(f.api, 'sample_group');
  assert.ok(byteBounded.items.length < 20); assert.ok(Buffer.byteLength(JSON.stringify(byteBounded)) <= 14000);
  assert.equal(byteBounded.resolved.id, 1249);
});

test('registration sends public object_id once, verifies internal id by GET, and reports loading without claiming eligibility', async () => {
  const f = fixture(), result = await apply(f, create(), 'create-vk-source');
  assert.equal(result.phase, 'verified'); assert.equal(result.objectId, 901);
  assert.equal(result.observed.object_id, 101); assert.equal(result.observed.readiness.state, 'loading');
  assert.equal(result.observed.readiness.campaignEligibility, 'not_assessed');
  assert.deepEqual(result.response, { id: 901 });
  assert.ok(!JSON.stringify(f.store.shared.value).includes('must-not-escape'));
  const detail = await sources(f.api, 'vk-groups', 901); assert.equal(detail.object_id, 101);
  assert.equal(f.calls.at(-1).query._id__in, '901');
  for (const [status, count, expected] of [['loaded', 2000, 'loaded_nonempty'], ['loaded', 0, 'loaded_empty'],
    ['loaded', undefined, 'loaded_size_unknown'], ['loaded', -1, 'loaded_size_unknown'], ['unloaded', 0, 'unloaded'], ['new_state', 100, 'unknown']]) {
    f.model.sources[0].status = status; f.model.sources[0].loaded_users_count = count;
    assert.equal((await sources(f.api, 'vk-groups', 901)).readiness.state, expected);
  }
  assert.equal(f.calls.filter(v => v.method === 'POST').length, 1);
  assert.ok(f.calls.filter(v => v.method === 'GET').every(v => !/vk_groups\/901/.test(v.path)));
});

test('VK relations resolve public source_id independently of opaque relation.object_id and registered source.id', async () => {
  const f = fixture(); await apply(f, create(), 'register-for-segment');
  const spec = { kind: 'audience', entity: 'segments', action: 'create', payload: { name: 'Synthetic audience', pass_condition: 1,
    relations: [{ object_type: 'remarketing_vk_group', params: { source_id: 101, type: 'positive' } }] } };
  const plan = await f.ops.plan(spec);
  assert.equal(plan.operation.referencesBefore[0].source.id, 901);
  assert.equal((await f.ops.apply(plan.planId, plan.planHash, 'create-vk-segment')).phase, 'verified');
  const info = await audience(f.api, 11); assert.equal(info.relations.items[0].sourceMetadataState, 'resolved');
  assert.equal(info.relations.items[0].source.id, 901);
  assert.equal(info.relations.items[0].object_id, 701); assert.equal(info.relations.items[0].source.object_id, 101);
  assert.equal(info.relations.items[0].sourceMetadataState, 'resolved');
  f.model.relations.push({ ...f.model.relations[0], id: 502, params: { source_id: 102, type: 'negative' } });
  f.model.segment.relations_count = 2;
  const mismatched = await audience(f.api, 11);
  assert.equal(mismatched.relations.items[0].sourceMetadataState, 'resolved');
  assert.equal(mismatched.relations.items[1].sourceMetadataState, 'vk_group_source_not_registered_or_ambiguous');
  spec.payload.relations[0].params.source_id = 901;
  await assert.rejects(f.ops.plan(spec), { code: 'vk_group_source_not_registered_or_ambiguous' });
});

test('VK diagnostic reads cache by public identity, preserve independent relation ids and never export unknown rules or people', async () => {
  const f = readFixture();
  f.model.relations.push({ id: 502, object_id: 702, object_type: 'remarketing_vk_group',
    params: { source_id: 101, type: 'negative', unsupported_rule: 'must-not-escape' } });
  f.model.segment.relations_count = 2;
  const result = await audience(f.api, 11);
  assert.deepEqual(result.relations.items.map(v => v.sourceMetadataState), ['resolved', 'resolved']);
  assert.deepEqual(result.relations.items.map(v => v.object_id), [701, 702]);
  assert.deepEqual(result.relations.items.map(v => v.source.id), [901, 901]);
  assert.equal(result.relations.items[1].paramsProjectionComplete, false);
  assert.equal(result.relations.items[0].source.readiness.state, 'loaded_nonempty');
  assert.ok(!JSON.stringify(result).includes('must-not-escape'));
  assert.equal(f.calls.filter(v => v.path === '/api/v2/remarketing/vk_groups.json').length, 1);
  assert.ok(f.calls.every(v => v.method === 'GET' && v.query._id__in === undefined));
  delete f.model.relations[0].object_id;
  assert.equal((await audience(f.api, 11)).relations.items[0].source.id, 901);
});

test('VK metadata requires a scalar explicit public reference and complete unique inventory; no opaque-id or name fallback', async () => {
  for (const pointer of [undefined, null, [101], 0, -101, true, 'not-an-id']) {
    const f = readFixture(); f.model.relations[0].object_id = 901; f.model.relations[0].params.source_id = pointer;
    assert.equal((await audience(f.api, 11)).relations.items[0].sourceMetadataState, 'source_reference_invalid');
    assert.equal(f.calls.length, 2);
  }
  const malformed = readFixture(); malformed.model.relations[0].params.source_id = {};
  await assert.rejects(audience(malformed.api, 11), { code: 'response_invalid' });
  const partial = readFixture(); partial.model.partial = true;
  const incomplete = (await audience(partial.api, 11)).relations.items[0];
  assert.equal(incomplete.sourceMetadataState, 'vk_group_sources_incomplete'); assert.equal(incomplete.source, undefined);
  const duplicate = readFixture(); duplicate.model.sources.push({ ...duplicate.model.sources[0], id: 902 });
  assert.equal((await audience(duplicate.api, 11)).relations.items[0].sourceMetadataState, 'vk_group_source_not_registered_or_ambiguous');
  duplicate.model.sources[1].id = 901;
  assert.equal((await audience(duplicate.api, 11)).relations.items[0].sourceMetadataState, 'collection_changed');
  const absent = readFixture(); absent.model.relations[0].object_id = 901; absent.model.relations[0].params.source_id = 102;
  assert.equal((await audience(absent.api, 11)).relations.items[0].sourceMetadataState, 'vk_group_source_not_registered_or_ambiguous');
  absent.model.sources.push({ ...absent.model.sources[0], id: 902, object_id: 102 });
  const exact = (await audience(absent.api, 11)).relations.items[0];
  assert.equal(exact.sourceMetadataState, 'resolved'); assert.equal(exact.source.id, 902); assert.equal(exact.source.object_id, 102);
  assert.equal(exact.object_id, 901); assert.ok(absent.calls.every(v => v.method === 'GET'));
});

test('stale public identity, duplicates, unknown inventories and unregistered public ids stop before dispatch', async () => {
  const stale = fixture(), plan = await stale.ops.plan(create()); stale.model.dictionary[0].id = 103;
  await assert.rejects(stale.ops.apply(plan.planId, plan.planHash, 'stale-public-identity'), { code: 'vk_group_not_resolved' });
  assert.ok(stale.calls.every(v => v.method === 'GET'));
  const duplicate = fixture(); await apply(duplicate, create(), 'initial-registration');
  await assert.rejects(duplicate.ops.plan(create()), { code: 'vk_group_source_already_registered' });
  const partial = fixture(); partial.model.partial = true;
  await assert.rejects(partial.ops.plan(create()), { code: 'vk_group_sources_incomplete' });
  for (const invalid of [{ ...create(), payload: { object_id: [101] } }, { ...create(), payload: { object_id: 101, users: ['private'] } },
    { ...create(), payload: { object_id: 901 } }, { ...create(), groupQuery: 'similar_name' },
    { ...create(), action: 'update' }, { ...remove(), payload: { users: ['private'] } }]) {
    await assert.rejects(prepare(fixture().api, invalid));
  }
});

test('lost create id stays manual and blocks another operation; known readback failure recovers by GET only after restart', async () => {
  const lost = fixture(), plan = await lost.ops.plan(create()); lost.model.failure = 'after-write';
  assert.equal((await lost.ops.apply(plan.planId, plan.planHash, 'lost-vk-source-id')).phase, 'unknown');
  const before = lost.calls.length;
  assert.equal((await lost.ops.reconcile('lost-vk-source-id')).phase, 'unknown'); assert.equal(lost.calls.length, before);
  const cleanup = await lost.ops.plan(remove());
  await assert.rejects(lost.ops.apply(cleanup.planId, cleanup.planHash, 'fenced-source-cleanup'), { code: 'unresolved_write_blocks_new_mutation' });
  await lost.ops.apply(plan.planId, plan.planHash, 'another-vk-source-id');
  assert.equal(lost.calls.filter(v => v.method === 'POST').length, 1);
  const known = fixture(), knownPlan = await known.ops.plan(create()); known.model.failure = 'readback';
  assert.equal((await known.ops.apply(knownPlan.planId, knownPlan.planHash, 'known-source-id')).phase, 'written_unverified');
  const restarted = new Operations(new MemoryStore(known.store.shared, known.store.owner), known.api);
  known.model.readStatus = 200; const mark = known.calls.length;
  assert.equal((await restarted.reconcile('known-source-id')).phase, 'verified');
  assert.ok(known.calls.slice(mark).every(v => v.method === 'GET'));
  assert.equal(known.calls.filter(v => v.method === 'POST').length, 1);
  const foreign = new Operations(new MemoryStore(known.store.shared), known.api);
  await assert.rejects(foreign.apply(knownPlan.planId, knownPlan.planHash, 'foreign-source-scope'), { code: 'plan_scope_or_hash_invalid' });
});

test('changed inventory and wrong source readback stay fenced; malformed aggregate fields never export member arrays', async () => {
  const changed = fixture(), plan = await changed.ops.plan(create());
  changed.model.sources.push({ id: 902, object_id: 102, name: 'Other synthetic group' });
  await assert.rejects(changed.ops.apply(plan.planId, plan.planHash, 'changed-source-inventory'), { code: 'object_changed_replan_required' });
  assert.ok(changed.calls.every(v => v.method === 'GET'));
  const wrong = fixture(); wrong.model.failure = 'readback';
  assert.equal((await apply(wrong, create(), 'wrong-source-readback')).phase, 'written_unverified');
  wrong.model.readStatus = 200; wrong.model.sources[0].object_id = 102;
  assert.equal((await wrong.ops.reconcile('wrong-source-readback')).phase, 'written_unverified');
  wrong.model.sources[0].object_id = 101; wrong.model.sources[0].loaded_users_count = ['must-not-escape'];
  await assert.rejects(sources(wrong.api, 'vk-groups', 901), { code: 'response_invalid' });
  assert.equal((await wrong.ops.reconcile('wrong-source-readback')).phase, 'written_unverified');
  wrong.model.sources[0].loaded_users_count = 1000;
  assert.equal((await wrong.ops.reconcile('wrong-source-readback')).phase, 'verified');
  assert.equal(wrong.calls.filter(v => v.method === 'POST').length, 1);
  assert.ok(!JSON.stringify(wrong.store.shared.value).includes('must-not-escape'));
});

test('source deletion uses internal id, handles 409 and verifies absence only in a complete collection', async () => {
  const f = fixture(); await apply(f, create(), 'create-before-delete');
  f.model.failure = 'after-write';
  assert.equal((await apply(f, remove(), 'lost-source-delete')).phase, 'unknown');
  for (const status of [403, 404]) {
    f.model.readStatus = status; assert.equal((await f.ops.reconcile('lost-source-delete')).phase, 'unknown');
  }
  f.model.readStatus = 200; f.model.partial = true;
  assert.equal((await f.ops.reconcile('lost-source-delete')).phase, 'unknown');
  f.model.partial = false; const before = f.calls.length;
  const verified = await f.ops.reconcile('lost-source-delete'); assert.equal(verified.phase, 'verified'); assert.equal(verified.observed.deleted, true);
  assert.ok(f.calls.slice(before).every(v => v.method === 'GET')); assert.equal(f.calls.filter(v => v.method === 'DELETE').length, 1);
  const used = fixture(); await apply(used, create(), 'create-used-source'); used.model.used = true;
  assert.equal((await apply(used, remove(), 'delete-used-source')).phase, 'rejected');
  assert.equal(used.model.sources.length, 1); assert.equal(used.calls.filter(v => v.method === 'DELETE').length, 1);
});
