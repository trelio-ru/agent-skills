import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations, matches, snapshot } from '../scripts/operations.mjs';

const roles = ['video_landscape_30s', 'video_portrait_4_5_180s', 'video_portrait_9_16_180s'];
const banner = () => ({ id: 1, name: 'Synthetic banner', content: {
  icon_256x256: { id: 2, type: 'static', flags: [], variants: { original: { width: 256, size: 100, url: 'https://example.invalid/icon.png' } } },
  ...Object.fromEntries(roles.map((role, i) => [role, { id: i + 3, type: 'video', is_autogen: true,
    flags: ['autogen_video', 'autogen_from_html', ...(i ? ['autogen_video_portrait'] : [])],
    variants: { internal: { width: 1080, height: 1920, size: 200, bitrate: 100.5, media_type: 'video', url: 'https://example.invalid/video.mp4' } } }])),
} });
function memory() {
  let state = { credentials: {}, plans: {}, operations: {} };
  return { owner: { account: 'synthetic-account', binding: 'synthetic-binding', company: 'synthetic-company', member: 'synthetic-member' },
    read: async () => structuredClone(state), write: async value => { state = structuredClone(value); }, lock: action => action() };
}
test('content flags ignore only known unique direct-role ordering without mutating either snapshot', () => {
  const first = banner(), second = structuredClone(first);
  for (const role of roles) second.content[role].flags.reverse();
  const originals = structuredClone({ first, second });
  assert.notEqual(JSON.stringify(first), JSON.stringify(second));
  assert.equal(snapshot(first), snapshot(second)); assert.equal(matches(second, first), true);
  assert.equal(matches(second.content, first.content, 'content'), true);
  assert.deepEqual({ first, second }, originals);
  // Even a shared input object cannot extend normalization to an unknown role.
  const unknown = banner(); unknown.content.other_role = unknown.content[roles[0]];
  const changed = structuredClone(unknown); changed.content.other_role.flags.reverse();
  assert.notEqual(snapshot(unknown), snapshot(changed)); assert.equal(matches(changed, unknown), false);
});
const changes = {
  id: value => { value.content[roles[0]].id++; },
  id_type: value => { value.content[roles[0]].id = String(value.content[roles[0]].id); },
  role_removed: value => { delete value.content[roles[0]]; },
  role_added: value => { value.content.another_role = { id: 100 }; },
  media_type: value => { value.content[roles[0]].type = 'static'; },
  membership: value => { value.content[roles[0]].flags.pop(); },
  duplicate: value => { value.content[roles[0]].flags.push('autogen_video'); },
  flags_type: value => { value.content[roles[0]].flags = {}; },
  flags_missing: value => { delete value.content[roles[0]].flags; },
  variant: value => { value.content[roles[0]].variants.internal.width++; },
  variant_type: value => { value.content[roles[0]].variants.internal.size = '200'; },
  variant_url: value => { value.content[roles[0]].variants.internal.url += '?changed=1'; },
  variant_added: value => { value.content[roles[0]].variants.new_variant = { size: 1 }; },
  extra: value => { value.content[roles[0]].extra = true; },
  missing: value => { delete value.content[roles[0]].is_autogen; },
  other_array: value => { value.other.reverse(); },
};
test('content flags preserve complete optimistic checks and real content changes before dispatch', async () => {
  for (const mode of ['order', ...Object.keys(changes)]) {
    const store = memory(); let current = { ...banner(), other: [1, 2] }, writes = 0, sent;
    const api = { auth: { groups: 'ad_groups' }, access: 'synthetic-only-token', get: async () => structuredClone(current),
      endpoint: () => '/synthetic-only', request: async (_method, _route, { body }) => { writes++; sent = structuredClone(body); Object.assign(current, body); return {}; } };
    const ops = new Operations(store, api), payload = { name: 'Synthetic static-only', content: { icon_256x256: { id: 2 } } };
    const plan = await ops.plan({ kind: 'update', entity: 'banners', id: 1, payload });
    const original = structuredClone(plan.operation.before), originalPayload = structuredClone(plan.operation.payload);
    for (const role of roles) current.content[role].flags.reverse();
    if (mode !== 'order') changes[mode](current);
    if (mode === 'order') {
      assert.equal((await ops.apply(plan.planId, plan.planHash, 'synthetic-flags-order')).phase, 'verified');
      assert.deepEqual(sent, payload);
    } else {
      await assert.rejects(ops.apply(plan.planId, plan.planHash, `synthetic-flags-${mode}`), { code: 'object_changed_replan_required' });
      assert.equal(Object.keys((await store.read()).operations).length, 0);
    }
    assert.equal(writes, mode === 'order' ? 1 : 0);
    assert.deepEqual(plan.operation.before, original); assert.deepEqual(plan.operation.payload, originalPayload);
    assert.deepEqual((await store.read()).plans[plan.planId].op.before, original);
  }
});
test('unknown flags, duplicates and nested lookalike fields retain strict order semantics', () => {
  for (const flags of [['autogen_video', 'unknown'], ['autogen_video', 'autogen_from_html', 'autogen_video']]) {
    const first = banner(); first.content[roles[0]].flags = flags;
    const second = structuredClone(first); second.content[roles[0]].flags = [...flags.slice(1), flags[0]];
    assert.notEqual(snapshot(first), snapshot(second)); assert.equal(matches(second, first), false);
  }
  const first = banner(); first.content[roles[0]].variants.internal.flags = ['autogen_video', 'autogen_from_html'];
  const second = structuredClone(first); second.content[roles[0]].variants.internal.flags.reverse();
  assert.notEqual(snapshot(first), snapshot(second)); assert.equal(matches(second, first), false);
  assert.equal(matches(['autogen_from_html', 'autogen_video'], ['autogen_video', 'autogen_from_html'], 'flags'), false);
});
