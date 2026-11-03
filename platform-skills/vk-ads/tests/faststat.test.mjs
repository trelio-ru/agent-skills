import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../scripts/api.mjs';
import { argumentsOf } from '../scripts/trelio-vk-ads.mjs';
import { faststat } from '../scripts/diagnostics.mjs';

const minute = () => ({ timestamp: 1800000000, minutely: { shows: Array(60).fill(0), clicks: Array(60).fill(0) } });
function fixture(response, groups = 'ad_groups') {
  const calls = [], api = new Api({ groups }, { fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(url.origin, 'https://ads.vk.com'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.deepEqual([...url.searchParams.keys()], ['id']);
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
  } });
  api.access = 'synthetic-only-token'; return { api, calls };
}

test('faststat uses documented fixed GET paths and projects only the requested advertising objects', async () => {
  for (const [entity, resource] of [['plans', 'ad_plans'], ['groups', 'campaigns'], ['banners', 'banners']]) {
    for (const dialect of ['ad_groups', 'campaigns']) {
      const row = minute(); row.minutely.shows[59] = 3;
      const { api, calls } = fixture({ last_seen_msg_time: { timestamp: 1800000000, ago: 12, string: 'private' },
        [resource]: { 10: { ...row, private: ['private'] }, 99: { people: ['private'] } },
        advertisers: { private: ['private'] }, users: ['private'] }, dialect);
      const result = await faststat(api, entity, ['10']);
      assert.equal(calls[0].pathname, `/api/v3/statistics/faststat/${resource}.json`);
      assert.equal(calls[0].searchParams.get('id'), '10'); assert.equal(calls.length, 1);
      assert.deepEqual(result.items, [{ id: 10, state: 'returned', ...row, complete: true }]);
      assert.deepEqual(result.lastSeenMessage, { timestamp: 1800000000, agoSeconds: 12 });
      assert.equal(result.complete, true); assert.equal(result.windowMinutes, 60);
      assert.equal(result.trafficFiltering, 'not_applied'); assert.ok(!JSON.stringify(result).includes('private'));
    }
  }
});

test('faststat preserves missing and partial telemetry instead of constructing zero delivery', async () => {
  const { api, calls } = fixture({ banners: { 10: { timestamp: 1800000000,
    minutely: { shows: [0, 2], clicks: [0, 0] } }, 11: {} } });
  const result = await faststat(api, 'banners', [10, 11, 12]);
  assert.equal(calls[0].searchParams.get('id'), '10,11,12');
  assert.deepEqual(result.lastSeenMessage, { timestamp: null, agoSeconds: null });
  assert.deepEqual(result.items[0].minutely.shows, [0, 2]);
  assert.deepEqual(result.items[1], { id: 11, state: 'returned', timestamp: null,
    minutely: { shows: null, clicks: null }, complete: false });
  assert.deepEqual(result.items[2], { id: 12, state: 'not_returned', complete: false });
  assert.equal(result.complete, false);
  const absent = await faststat(fixture({}).api, 'groups', [10]);
  assert.equal(absent.items[0].state, 'not_returned'); assert.equal(absent.complete, false);
});

test('faststat rejects invalid scopes, duplicate and oversized selectors before advertising IO', async () => {
  const { api, calls } = fixture({});
  for (const entity of ['users', 'advertisers', 'constructor', '__proto__', undefined]) {
    await assert.rejects(faststat(api, entity, [10]), { code: 'faststat_selector_invalid' });
  }
  for (const ids of [[], [10, '10'], Array.from({ length: 21 }, (_, n) => n + 1)]) {
    await assert.rejects(faststat(api, 'banners', ids), { code: 'faststat_selector_invalid' });
  }
  for (const ids of [[''], [0], [-1], [[10]], ['10,11'], [2147483648]]) {
    await assert.rejects(faststat(api, 'banners', ids), { code: 'object_id_invalid' });
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(argumentsOf(['faststat', '--entity', 'groups', '--ids', '10,11']),
    { command: 'faststat', flags: { entity: 'groups', ids: '10,11' } });
  for (const flag of ['from', 'to', 'period', 'fields', 'metrics', 'url']) {
    assert.throws(() => argumentsOf(['faststat', '--entity', 'groups', `--${flag}`, '10']), { code: 'command_invalid' });
  }
});

test('faststat rejects malformed selected numbers, arrays and containers without exporting their values', async () => {
  const cases = [null, [], { banners: [] }, { banners: null }, { last_seen_msg_time: [] },
    { last_seen_msg_time: { timestamp: 'private' } }, { last_seen_msg_time: { ago: -1 } }];
  for (const mutate of [r => { r.timestamp = 'private'; }, r => { r.timestamp = Number.MAX_SAFE_INTEGER + 1; },
    r => { r.minutely = []; }, r => { r.minutely.shows = Array(61).fill(0); },
    r => { r.minutely.shows[0] = -1; }, r => { r.minutely.shows[0] = 0.5; },
    r => { r.minutely.clicks[0] = { people: ['private'] }; }, r => { r.minutely.clicks.pop(); }]) {
    const row = minute(); mutate(row); cases.push({ banners: { 10: row } });
  }
  for (const response of cases) {
    await assert.rejects(faststat(fixture(response).api, 'banners', [10]), { code: 'response_invalid' });
  }
});

test('faststat keeps existing bounded read retry and HTTP denial semantics', async () => {
  let calls = 0;
  const api = new Api({}, { sleep: async () => {}, fetcher: async () => {
    calls++; return new Response(JSON.stringify({ error: { message: 'private' } }), { status: 503 });
  } }); api.access = 'synthetic-only-token';
  await assert.rejects(faststat(api, 'banners', [10]), { code: 'api_rejected',
    details: { httpStatus: 503, requestStage: 'advertising_api' } });
  assert.equal(calls, 3);
});
