import { check, data, id, hash, stable, Fault } from './core.mjs';
import { project, SEGMENT_FIELDS, relationMetadata, collection, sources, counterGoals } from './diagnostics.mjs';

const SEGMENTS = '/api/v2/remarketing/segments';
const RELATION_TYPES = ['remarketing_users_list', 'remarketing_counter', 'remarketing_vk_group', 'segment'];
export const managed = op => ['audience', 'goal'].includes(op.kind);
const equal = (a, b) => stable(a) === stable(b);
function keys(value, allowed) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), 'payload_field_forbidden');
}
function name(value) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 255, 'name_invalid'); }
function condition(value, count) { check(Number.isInteger(value) && value >= 1 && value <= count, 'segment_condition_invalid'); }
function params(value, type, creation = false) {
  const allowed = creation ? type === 'remarketing_counter' ? ['source_id', 'goal_id', 'left', 'right', 'type'] : ['source_id', 'type'] : ['left', 'right', 'type', 'goal_id'];
  keys(value, allowed); check(Object.keys(value).length > 0, 'payload_invalid'); data(value);
  if (creation) { value.source_id = id(value.source_id); check(['positive', 'negative'].includes(value.type), 'relation_type_invalid'); }
  if (value.type !== undefined) check(['positive', 'negative'].includes(value.type), 'relation_type_invalid');
  if (value.goal_id !== undefined) check(typeof value.goal_id === 'string' && value.goal_id.length <= 4096, 'relation_goal_invalid');
  for (const field of ['left', 'right']) if (value[field] !== undefined) check(Number.isInteger(value[field]) && value[field] >= 0 && value[field] <= 365, 'relation_interval_invalid');
  if (creation && type === 'remarketing_counter') check(Object.hasOwn(value, 'goal_id') && Object.hasOwn(value, 'left') && Object.hasOwn(value, 'right'), 'relation_counter_conditions_required');
  if (value.left !== undefined && value.right !== undefined) check(value.left > value.right, 'relation_interval_invalid');
}
function relation(value) {
  keys(value, ['object_type', 'object_id', 'params']); check(RELATION_TYPES.includes(value.object_type), 'relation_source_type_unsupported');
  if (value.object_type === 'segment') { value.object_id = id(value.object_id); check(value.params === undefined, 'payload_field_forbidden'); }
  else { check(value.object_id === undefined, 'payload_field_forbidden'); params(value.params, value.object_type, true); }
  return value;
}

// Unknown params can be important rules, including rules not decoded by the
// diagnostic reader. Preserve only their opaque digest in the durable snapshot;
// never copy unknown keys/values or people into the plan/receipt. A known patch
// derives its expected full digest transiently, so concurrent unknown-rule edits
// still fail preflight and unrequested rules must survive the update.
async function segmentState(api, segmentId) {
  const objectId = id(segmentId), segment = project(await api.request('GET', `${SEGMENTS}/${objectId}.json`,
    { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS);
  check(id(segment.id) === objectId, 'readback_mismatch');
  const page = await collection(api, `${SEGMENTS}/${objectId}/relations.json`, { fields: 'id,object_id,object_type,params' }, 500, segment.relations_count);
  check(!page.truncated, 'audience_snapshot_incomplete');
  const rawParams = new Map(), relations = page.items.map(item => {
    rawParams.set(id(item.id), structuredClone(item.params ?? null));
    return { ...relationMetadata(item), paramsDigest: hash(stable(item.params ?? null)) };
  }).sort((a, b) => id(a.id) - id(b.id));
  return { snapshot: { segment, relations, count: page.count }, rawParams };
}
async function goalState(api, op) {
  const fields = ['id', 'priced_goal', 'objective', 'autobidding_mode', ...(op.entity === 'groups' ? ['package_id', 'ad_plan_id'] : [])];
  const target = project(await api.get(op.entity, op.id, fields), fields); check(id(target.id) === op.id, 'readback_mismatch');
  const counter = await sources(api, 'counters', op.counterSourceId), topId = id(counter.counter_id);
  const page = await counterGoals(api, topId), matches = page.items.filter(v => Number(v.id) === op.goalId);
  check(matches.length === 1, 'goal_not_resolved'); const goal = matches[0];
  check(typeof goal.condition === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(goal.condition) &&
    typeof goal.substr === 'string' && goal.substr.length <= 4096, 'goal_condition_invalid');
  // An exact known goal ID can be read in a partial inventory. Do not infer a
  // unique goal by display name or pretend the whole goal inventory is loaded.
  return { target, counter, goal, goalsTruncated: page.truncated };
}
async function state(api, op) {
  if (op.kind === 'goal') return { snapshot: await goalState(api, op) };
  if (op.entity === 'users-lists') return { snapshot: await sources(api, 'users-lists', op.id) };
  return segmentState(api, op.entity === 'relations' ? op.segmentId : op.id);
}
async function references(api, op) {
  const items = op.entity === 'segments' ? op.payload.relations : [op.payload];
  const result = [];
  for (const item of items) {
    if (item.object_type === 'remarketing_users_list') result.push({ type: item.object_type,
      source: await sources(api, 'users-lists', item.params.source_id) });
    else if (item.object_type === 'segment') {
      const source = project(await api.request('GET', `${SEGMENTS}/${id(item.object_id)}.json`,
        { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS);
      check(id(source.id) === id(item.object_id), 'readback_mismatch'); result.push({ type: item.object_type, source });
    } else {
      // VK validates these documented source references at mutation time.
      // No invented metadata endpoint or recursive source graph is used.
      result.push({ type: item.object_type, sourceId: item.params.source_id, resolution: 'vk_validation_required' });
    }
  }
  return result;
}

export async function prepareManaged(api, specification) {
  const op = structuredClone(specification);
  if (op.kind === 'goal') {
    keys(op, ['kind', 'entity', 'id', 'counterSourceId', 'goalId']); check(['plans', 'groups'].includes(op.entity), 'entity_invalid');
    op.id = id(op.id); op.counterSourceId = id(op.counterSourceId); op.goalId = id(op.goalId);
    op.before = (await state(api, op)).snapshot;
    op.payload = { priced_goal: { source_id: id(op.before.counter.counter_id), name: `${op.before.goal.condition}:${op.before.goal.substr}` } };
    op.note = 'Sets the explicit Top counter goal only; does not install a pixel, change strategy or prove a real business conversion';
    return op;
  }
  check(op.kind === 'audience' && ['segments', 'relations', 'users-lists'].includes(op.entity) && ['create', 'update', 'delete'].includes(op.action), 'operation_invalid');
  const allowed = ['kind', 'entity', 'action', ...(op.entity === 'relations' ? ['segmentId'] : []),
    ...(op.action !== 'create' ? ['id'] : []), ...(op.action !== 'delete' ? ['payload'] : [])];
  keys(op, allowed); check(op.action === 'delete' || op.payload && typeof op.payload === 'object', 'payload_invalid');
  if (op.payload) data(op.payload);
  if (op.entity === 'relations') op.segmentId = id(op.segmentId);
  if (op.action !== 'create') op.id = id(op.id);
  if (op.entity === 'users-lists') {
    check(op.action !== 'create', 'audience_people_upload_not_supported');
    if (op.action === 'update') { keys(op.payload, ['name']); name(op.payload.name); }
  } else if (op.entity === 'segments') {
    if (op.action !== 'delete') {
      keys(op.payload, op.action === 'create' ? ['name', 'pass_condition', 'relations'] : ['name', 'pass_condition']);
      check(Object.keys(op.payload).length > 0, 'payload_invalid');
      if (op.payload.name !== undefined) name(op.payload.name);
      if (op.action === 'create') {
        name(op.payload.name); check(Array.isArray(op.payload.relations) && op.payload.relations.length > 0 && op.payload.relations.length <= 20, 'relations_invalid');
        op.payload.relations.forEach(relation); condition(op.payload.pass_condition, op.payload.relations.length);
      }
    }
  } else if (op.action === 'create') relation(op.payload);
  else if (op.action === 'update') { keys(op.payload, ['params']); params(op.payload.params, null); }
  if (op.entity !== 'segments' || op.action !== 'create') {
    const observed = await state(api, op); op.before = observed.snapshot;
    if (op.entity === 'segments') {
      if (op.payload?.pass_condition !== undefined) condition(op.payload.pass_condition, op.before.count);
      if (op.action === 'delete') check(Array.isArray(op.before.segment.campaign_ids) && op.before.segment.campaign_ids.length === 0, 'audience_is_used_or_usage_unknown');
    }
    if (op.entity === 'relations') {
      if (op.action === 'create') check(op.payload.object_type !== 'segment' || id(op.payload.object_id) !== op.segmentId, 'segment_cycle_invalid');
      else {
        const current = op.before.relations.find(v => id(v.id) === op.id); check(current, 'relation_not_found');
        op.relationBefore = current;
        if (op.action === 'delete') condition(Number(op.before.segment.pass_condition), op.before.count - 1);
        else {
          if (op.payload.params.left !== undefined || op.payload.params.right !== undefined) check(current.object_type === 'remarketing_counter', 'relation_interval_not_supported');
          if (op.payload.params.goal_id !== undefined) check(current.object_type === 'remarketing_counter', 'relation_goal_not_supported');
          const previous = observed.rawParams.get(op.id); check(previous && typeof previous === 'object' && !Array.isArray(previous), 'relation_params_not_returned');
          const merged = { ...previous, ...op.payload.params };
          if (merged.left !== undefined && merged.right !== undefined) check(Number(merged.left) > Number(merged.right), 'relation_interval_invalid');
          op.expectedParamsDigest = hash(stable(merged));
        }
      }
    }
    if (op.entity === 'users-lists' && op.action === 'delete') check(!['pending_delete', 'deleting', 'deleted', 'deleted_to_notify'].includes(op.before.status), 'audience_delete_already_pending');
  }
  if (op.action === 'create') op.referencesBefore = await references(api, op);
  op.note = 'Audience changes may affect every campaign using this source; VK rechecks dependencies and access. No people upload or advertising activation';
  return op;
}

export async function preflightManaged(api, op) {
  if (op.before) check(equal((await state(api, op)).snapshot, op.before), 'object_changed_replan_required');
  if (op.referencesBefore) check(equal(await references(api, op), op.referencesBefore), 'source_changed_replan_required');
}
function route(op) {
  if (op.kind === 'goal') return null;
  if (op.entity === 'users-lists') return `/api/v3/remarketing/users_lists/${id(op.id)}.json`;
  if (op.entity === 'relations') return `${SEGMENTS}/${id(op.segmentId)}/relations${op.action === 'create' ? '' : `/${id(op.id)}`}.json`;
  return `${SEGMENTS}${op.action === 'create' ? '' : `/${id(op.id)}`}.json`;
}
export async function dispatchManaged(api, op) {
  if (op.kind === 'goal') return api.request('POST', api.endpoint(op.entity, op.id), { body: op.payload });
  return api.request(op.action === 'delete' ? 'DELETE' : 'POST', route(op),
    op.action === 'delete' ? {} : { body: op.entity === 'relations' && op.action === 'create' ? { items: [op.payload] } : op.payload });
}
export function managedObjectId(op, response) {
  if (op.kind === 'goal' || op.action !== 'create') return op.id;
  if (op.entity === 'relations') { check(Array.isArray(response.items) && response.items.length === 1, 'created_relation_id_unknown'); return id(response.items[0].id); }
  return id(response.id);
}
export function managedResponse(op, response) {
  // Mutation responses can carry users/history too. The receipt keeps only
  // the exact assigned ID; actual verification uses the safe GET projections.
  return { id: managedObjectId(op, response) };
}
function requested(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
    ? requested(actual[key], value) : typeof value === 'number' ? ['number', 'string'].includes(typeof actual[key]) &&
      /^\d+(?:\.\d+)?$/.test(String(actual[key])) && Number(actual[key]) === value : equal(actual[key], value));
}
export async function verifyManaged(api, op, objectId) {
  if (op.kind === 'goal') {
    const current = await goalState(api, op); check(requested(current.target, op.payload) && equal(current.counter, op.before.counter) && equal(current.goal, op.before.goal), 'readback_mismatch');
    const other = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'priced_goal'));
    check(equal(other(current.target), other(op.before.target)), 'readback_mismatch');
    return current;
  }
  if (op.action === 'delete' && op.entity !== 'relations') {
    try {
      const current = op.entity === 'users-lists' ? await sources(api, 'users-lists', op.id) :
        project(await api.request('GET', `${SEGMENTS}/${id(op.id)}.json`, { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS);
      check(id(current.id) === op.id, 'readback_mismatch');
      if (op.entity === 'users-lists' && current.status === 'deleted') return current;
    } catch (error) {
      // Only the documented 404 of the exact formerly readable object proves
      // absence. Permission, transport, parent loss and pending deletion cannot
      // unlock the receipt or authorize a second DELETE.
      if (error instanceof Fault && error.details?.httpStatus === 404) return { id: op.id, deleted: true };
      throw error;
    }
    throw new Fault('audience_deletion_not_confirmed');
  }
  if (op.entity === 'users-lists') {
    const current = await sources(api, 'users-lists', op.id); check(requested(current, op.payload), 'readback_mismatch'); return current;
  }
  const current = (await segmentState(api, op.entity === 'relations' ? op.segmentId : objectId)).snapshot;
  if (op.entity === 'segments') {
    const scalar = Object.fromEntries(Object.entries(op.payload).filter(([key]) => key !== 'relations'));
    check(requested(current.segment, scalar), 'readback_mismatch');
    if (op.action === 'create') {
      check(current.relations.length === op.payload.relations.length, 'created_children_unverified');
      const remaining = [...current.relations];
      for (const expected of op.payload.relations) {
        const found = remaining.filter(value => requested(value, expected)); check(found.length === 1, 'created_children_unverified');
        remaining.splice(remaining.indexOf(found[0]), 1);
      }
    } else {
      check(equal(current.relations, op.before.relations) && current.count === op.before.count, 'readback_mismatch');
      const unchanged = ['id', 'name', 'pass_condition', 'campaign_ids', 'flags'].filter(key => !Object.hasOwn(op.payload, key));
      check(equal(project(current.segment, unchanged), project(op.before.segment, unchanged)), 'readback_mismatch');
    }
    return current;
  }
  const siblingIds = op.before.relations.filter(v => op.action !== 'create' && id(v.id) === op.id ? false : true);
  const parentFields = ['id', 'name', 'pass_condition', 'campaign_ids', 'flags'];
  check(equal(project(current.segment, parentFields), project(op.before.segment, parentFields)), 'readback_mismatch');
  check(siblingIds.every(v => equal(current.relations.find(row => id(row.id) === id(v.id)), v)), 'readback_mismatch');
  const item = current.relations.find(v => id(v.id) === objectId);
  if (op.action === 'delete') check(!item && current.count === op.before.count - 1, 'audience_deletion_not_confirmed');
  else if (op.action === 'create') check(item && requested(item, op.payload) && current.count === op.before.count + 1, 'readback_mismatch');
  else check(item && item.object_type === op.relationBefore.object_type && Number(item.object_id) === Number(op.relationBefore.object_id) &&
    item.paramsDigest === op.expectedParamsDigest && current.count === op.before.count, 'readback_mismatch');
  return current;
}
