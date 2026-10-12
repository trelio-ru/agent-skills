import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../scripts/api.mjs';
import { argumentsOf } from '../scripts/trelio-vk-ads.mjs';
import { collection, audience, sources, placements, optimization, treePaths } from '../scripts/diagnostics.mjs';

function fixture(handler) {
  const calls = [], api = new Api({ groups: 'ad_groups', client_secret: 'synthetic-only-secret' }, {
    fetcher: async (url, options) => {
      assert.equal(url.origin, 'https://ads.vk.com'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      calls.push(url); return new Response(JSON.stringify(await handler(url)), { headers: { 'Content-Type': 'application/json' } });
    },
  }); api.access = 'synthetic-only-token'; return { api, calls };
}

test('audience describes source rules and resolves metadata without fetching people or recursive segments', async () => {
  const { api, calls } = fixture(url => {
    assert.ok(!url.searchParams.get('fields').split(',').includes('users'));
    if (url.pathname.endsWith('/segments/10.json')) return { id: 10, name: 'Synthetic segment', pass_condition: 1, relations_count: 2,
      users: [{ email: 'private@example.invalid' }], identifiers: ['private'] };
    if (url.pathname.endsWith('/relations.json')) return { items: [
      { id: 1, object_id: 20, object_type: 'remarketing_users_list', params: { source_id: 20, type: 'negative', people: ['private'] } },
      { id: 2, object_id: 30, object_type: 'segment' },
    ] };
    if (url.pathname.endsWith('/users_lists/20.json')) return { id: 20, name: 'Synthetic users list', type: 'emails', matched_ids_count: 2000,
      users: [{ email: 'private@example.invalid' }], error: [{ line: 'private@example.invalid' }] };
    if (url.pathname.endsWith('/segments/30.json')) return { id: 30, name: 'Nested segment', pass_condition: 1, relations_count: 1, users: ['private'] };
    throw new Error('Unexpected route');
  });
  const result = await audience(api, 10);
  assert.equal(result.segment.pass_condition, 1); assert.equal(result.relations.truncated, false);
  assert.equal(result.relations.items[0].source.type, 'emails'); assert.equal(result.relations.items[0].params.type, 'negative');
  assert.equal(result.relations.items[1].source.name, 'Nested segment');
  assert.equal(result.membership.includesPersonalIdentifiers, false); assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(result).includes('private')); assert.equal(Object.hasOwn(result.relations.items[0].params, 'people'), false);
});

test('source projection rejects malformed selected metadata rather than exposing nested personal fields', async () => {
  const { api } = fixture(() => ({ id: 2, name: { email: 'private@example.invalid' } }));
  await assert.rejects(sources(api, 'users-lists', 2), { code: 'response_invalid' });
  await assert.rejects(sources(api, 'contacts', 2), { code: 'audience_source_type_unsupported' });
});

test('source lookup is bounded and per-source permission failure remains explicit', async () => {
  const { api, calls } = fixture(url => {
    if (url.pathname.endsWith('/segments/10.json')) return { id: 10, pass_condition: 1, relations_count: 22 };
    if (url.pathname.endsWith('/relations.json')) return { items: Array.from({ length: 22 }, (_, i) =>
      ({ id: i + 1, object_id: i + 100, object_type: 'remarketing_users_list', params: { type: 'positive' } })) };
    const n = Number(url.pathname.match(/\/(\d+)\.json$/)[1]);
    return { id: n, name: 'Synthetic list' };
  });
  const result = await audience(api, 10); assert.equal(calls.length, 22);
  assert.equal(result.relations.items[20].sourceMetadataState, 'lookup_limit');
  const denied = new Api({ groups: 'ad_groups' }, { fetcher: async url => {
    if (url.pathname.endsWith('/segments/10.json')) return new Response(JSON.stringify({ id: 10, relations_count: 1 }));
    if (url.pathname.endsWith('/relations.json')) return new Response(JSON.stringify({ items: [{ id: 1, object_id: 20, object_type: 'remarketing_users_list' }] }));
    return new Response('{}', { status: 403 });
  } }); denied.access = 'synthetic';
  assert.equal((await audience(denied, 10)).relations.items[0].sourceMetadataState, 'permission_denied');
});

test('collection preserves endpoint defaults, bounds traversal and never mistakes missing count for completeness', async () => {
  const { api, calls } = fixture(url => {
    assert.equal(url.searchParams.has('limit'), false);
    const offset = Number(url.searchParams.get('offset'));
    return { items: Array.from({ length: 20 }, (_, i) => ({ id: offset + i + 1 })), count: 100, limit: 20 };
  });
  const page = await collection(api, '/api/v2/remarketing/segments.json', {}, 25);
  assert.equal(page.items.length, 25); assert.equal(page.count, 100); assert.equal(page.truncated, true); assert.equal(calls.length, 2);
  const incomplete = fixture(() => ({ items: [{ id: 1 }] }));
  assert.equal((await collection(incomplete.api, '/api/v2/remarketing/segments.json')).truncated, true);
  const changing = fixture(() => ({ items: [{ id: 1 }], count: 2, limit: 1 }));
  await assert.rejects(collection(changing.api, '/api/v2/remarketing/segments.json'), { code: 'collection_changed' });
});

test('placements joins exact package/tree/pad ids and reports unmapped ids without inventing distribution', async () => {
  const { api } = fixture(url => {
    if (url.pathname.endsWith('/ad_groups/1.json')) return { id: 1, package_id: 2, targetings: { pads: [11, 12, 99] } };
    if (url.pathname.endsWith('/packages.json')) { assert.equal(url.searchParams.get('_id'), '2'); return { count: 1, items: [{ id: 2, pads_tree_id: 3 }] }; }
    if (url.pathname.endsWith('/pads_trees.json')) return { count: 1, items: [{ id: 3, tree: [{ name: 'Mobile', children: [{ name: 'VK', children: [{ id: 11 }, { id: 12 }] }] }] }] };
    if (url.pathname.endsWith('/packages_pads.json')) return { count: 2, items: [{ id: 11, name: 'Synthetic feed', description: 'Feed' }, { id: 12, name: 'Synthetic clips' }] };
    throw new Error('Unexpected route');
  });
  const result = await placements(api, 1);
  assert.deepEqual(result.selectedPads[0].paths, [['Mobile', 'VK']]);
  assert.equal(result.selectedPads[0].metadataResolved, true); assert.equal(result.selectedPads[2].metadataResolved, false);
  assert.deepEqual(result.selectedPads[2].paths, []); assert.equal(result.explicitSelection, true);
  assert.ok(result.note.includes('do not identify where impressions actually occurred'));
  const paths = treePaths([{ name: 'A', children: [{ id: 1 }] }, { name: 'B', children: [{ id: 1 }] }]);
  assert.deepEqual(paths.get(1), [['A'], ['B']]);
  const cycle = { children: [] }; cycle.children.push(cycle);
  assert.throws(() => treePaths([cycle]), { code: 'pad_tree_invalid' });
});

test('optimization resolves Top counter id separately from internal source id and matches condition:substr', async () => {
  const { api, calls } = fixture(url => {
    if (url.pathname.endsWith('/ad_groups/1.json')) return { id: 1, ad_plan_id: 4, package_id: 2, priced_goal: { source_id: 7, name: 'jse:signup' }, users: ['private'] };
    if (url.pathname.endsWith('/ad_plans/4.json')) return { id: 4, priced_goal: { source_id: 0, name: '' }, users: ['private'] };
    if (url.pathname.endsWith('/packages.json')) return { count: 1, items: [{ id: 2, priced_event_type: 7, paid_event_type: 0 }] };
    if (url.pathname.endsWith('/counters.json')) return { count: 1, items: [{ id: 70, counter_id: 7, name: 'Synthetic counter', working: true, status: 'active', system_status: 'active', users: ['private'] }] };
    if (url.pathname.endsWith('/counters/7/goals.json')) return { count: 1, items: [{ id: 3, condition: 'jse', substr: 'signup', goal_type: 'registration', name: 'Synthetic registration' }] };
    throw new Error('Unexpected route');
  });
  const result = await optimization(api, 1);
  assert.equal(result.bindingState, 'configured'); assert.equal(result.counter.id, 70); assert.equal(result.counter.counter_id, 7);
  assert.equal(result.goal.goal_type, 'registration'); assert.equal(result.optimizedEvent, 'conversion');
  assert.ok(!JSON.stringify(result).includes('private')); assert.equal(calls.length, 5);
});

test('empty group goal never inherits an unverified parent binding or becomes a registration claim', async () => {
  const { api, calls } = fixture(url => {
    if (url.pathname.endsWith('/ad_groups/1.json')) return { id: 1, ad_plan_id: 4, package_id: 2, priced_goal: { source_id: 0, name: '' } };
    if (url.pathname.endsWith('/ad_plans/4.json')) return { id: 4, priced_goal: { source_id: 7, name: 'jse:signup' } };
    return { count: 1, items: [{ id: 2, priced_event_type: 7 }] };
  });
  const result = await optimization(api, 1); assert.equal(result.bindingState, 'not_configured'); assert.equal(calls.length, 3);
  assert.equal(result.parent.priced_goal.source_id, 7); assert.equal(result.group.priced_goal.source_id, 0);
});

test('official integer string representations and partial goal lists preserve explicit confidence', async () => {
  const { api } = fixture(url => {
    if (url.pathname.endsWith('/ad_groups/1.json')) return { id: '1', package_id: '2', targetings: { pads: [11] }, priced_goal: { source_id: '7', name: 'jse:signup' } };
    if (url.pathname.endsWith('/packages.json')) return { count: '1', items: [{ id: '2', pads_tree_id: '0', priced_event_type: '7' }] };
    if (url.pathname.endsWith('/packages_pads.json')) return { count: '1', items: [{ id: 11, name: 'Synthetic pad' }] };
    if (url.pathname.endsWith('/counters.json')) return { count: '1', items: [{ id: '70', counter_id: '7' }] };
    if (url.pathname.endsWith('/goals.json')) return { items: [{ id: 3, condition: 'jse', substr: 'signup' }] };
    throw new Error('Unexpected route');
  });
  assert.equal((await placements(api, 1)).treeComplete, true);
  assert.equal((await optimization(api, 1)).bindingState, 'goal_match_in_partial_list');
});

test('documented statistics sets/periods/goal attribution are GET-only and arbitrary breakdowns fail before API', async () => {
  const { api, calls } = fixture(() => ({ items: [] }));
  await api.stats('groups', [1], '2026-01-01', '2026-01-02', { metrics: 'base,events,uniques', attribution: 'impression' });
  assert.equal(calls[0].searchParams.get('metrics'), 'base,events,uniques'); assert.equal(calls[0].searchParams.get('attribution'), 'impression');
  await api.stats('plans', [2], '2026-01-01', '2026-01-02', { period: 'summary' }); assert.ok(calls[1].pathname.endsWith('/ad_plans/summary.json'));
  await api.stats('groups', [1], '2026-01-01', '2026-01-02', { family: 'goals', conversionType: 'postclick,postview,total' });
  assert.equal(calls[2].pathname, '/api/v2/statistics/goals/ad_groups/day.json');
  assert.equal(calls[2].searchParams.get('conversion_type'), 'postclick,postview,total'); assert.equal(calls[2].searchParams.has('metrics'), false);
  await api.stats('banners', [3], '2026-01-01', '2026-01-02', { family: 'inapp' });
  assert.equal(calls[3].pathname, '/api/v2/statistics/inapp/banners/day.json');
  for (const options of [{ breakdown: 'pads' }, { breakdown: 'devices' }, { metrics: 'base,unknown' },
    { metrics: 'base,base' }, { family: 'goals', period: 'summary' }, { family: 'goals', metrics: 'base' }, { family: 'goals', conversionType: 'other' }]) {
    await assert.rejects(api.stats('groups', [1], '2026-01-01', '2026-01-02', options));
  }
  assert.equal(calls.length, 4);
});

test('CLI exposes bounded diagnostic commands without raw paths, credential fields or audience upload', () => {
  assert.equal(argumentsOf(['audiences', '--id', '1']).command, 'audiences');
  assert.equal(argumentsOf(['placements', '--group', '1']).flags.group, '1');
  assert.equal(argumentsOf(['stats', '--family', 'goals', '--conversion-type', 'total']).flags.family, 'goals');
  assert.throws(() => argumentsOf(['audiences', '--file', '/private/data']), { code: 'command_invalid' });
  assert.throws(() => argumentsOf(['sources', '--fields', 'users']), { code: 'command_invalid' });
});
