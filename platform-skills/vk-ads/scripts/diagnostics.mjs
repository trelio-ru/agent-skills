import { check, id, Fault } from './core.mjs';

// Audience endpoints may expose account owners, upload history and original
// user identifiers when fields are broadened. Request and project only public
// structure/counts: a provider ignoring fields must not leak the extra payload.
const SOURCES = {
  counters: { route: '/api/v2/remarketing/counters', fields: ['id', 'counter_id', 'name', 'status', 'system_status', 'type', 'working', 'domain'] },
  'users-lists': { route: '/api/v3/remarketing/users_lists', fields: ['id', 'name', 'type', 'status', 'entries_count', 'ids_count', 'matched_ids_count', 'base', 'created', 'updated'] },
};
export const SEGMENT_FIELDS = ['id', 'name', 'pass_condition', 'relations_count', 'campaign_ids', 'flags', 'created', 'updated'];
export const RELATION_PARAMS = ['source_id', 'goal_id', 'left', 'right', 'type', 'event_id', 'max_count', 'reach', 'source_type', 'game'];
const GOAL_FIELDS = ['id', 'name', 'condition', 'substr', 'goal_type', 'value'];
const PACKAGE_FIELDS = ['id', 'name', 'description', 'objective', 'pads_tree_id', 'options', 'priced_event_type', 'paid_event_type', 'status'];

export function project(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'response_invalid');
  return Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => {
    const v = value[k];
    if (k === 'options') { check(v === null || v && typeof v === 'object' && !Array.isArray(v), 'response_invalid'); return [k, v]; }
    if (k === 'priced_goal' && v !== null) return [k, project(v, ['source_id', 'name'])];
    check(v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) ||
      typeof v === 'string' && v.length <= 4096 || Array.isArray(v) && v.length <= 5000 &&
      v.every(x => typeof x === 'string' && x.length <= 4096 || typeof x === 'number' && Number.isFinite(x)), 'response_invalid');
    return [k, v];
  }));
}
export function relationMetadata(value) {
  const result = project(value, ['id', 'object_id', 'object_type']);
  if (value.params !== undefined) {
    result.params = value.params === null ? null : project(value.params, RELATION_PARAMS);
    // Unsupported parameter keys must not silently turn a partial rule into a
    // complete audience description. Preserve only the completeness flag, not
    // unknown keys or values that can contain identifiers of real people.
    result.paramsProjectionComplete = value.params === null || Object.keys(value.params).every(k => RELATION_PARAMS.includes(k));
  }
  return result;
}
export function sourceDefinition(type) { check(Object.hasOwn(SOURCES, type), 'audience_source_type_unsupported'); return SOURCES[type]; }
function countOf(value) {
  if (value === null || value === undefined) return null;
  check(/^(?:0|[1-9]\d{0,9})$/.test(String(value)) && Number(value) <= 2147483647, 'response_invalid');
  return Number(value);
}

// Use the endpoint's own default page size, rather than the ad-list size 200.
// A missing count/limit does not prove completeness, even after a short page.
// Explicit segment.relations_count may supply the independently read bound.
export async function collection(api, route, query = {}, maximum = 500, expectedCount = null) {
  check(Number.isInteger(maximum) && maximum > 0 && maximum <= 5000, 'list_limit_invalid');
  const items = []; let count = countOf(expectedCount);
  let complete = false; const seen = new Set();
  for (let pages = 0; pages < 250 && items.length < maximum; pages++) {
    const page = await api.request('GET', route, { query: { ...query, offset: items.length } });
    check(Array.isArray(page.items) && page.items.length <= 5000, 'response_invalid');
    const currentCount = countOf(page.count), pageLimit = countOf(page.limit);
    if (currentCount !== null) {
      check(count === null || count === currentCount, 'collection_changed'); count = currentCount;
    }
    for (const item of page.items) {
      if (item.id !== undefined) { const key = id(item.id); check(!seen.has(key), 'collection_changed'); seen.add(key); }
    }
    const capacity = maximum - items.length; items.push(...page.items.slice(0, capacity));
    if (page.items.length > capacity) break;
    if (count !== null && items.length >= count) { check(items.length === count, 'collection_changed'); complete = true; break; }
    if (!page.items.length || pageLimit !== null && page.items.length < pageLimit) {
      // With no count, a declared short page terminates the bounded traversal,
      // but callers still see truncated and cannot use it as write evidence.
      break;
    }
    if (count === null && pageLimit === null) break;
  }
  return { items, count, truncated: !complete };
}
export async function segments(api, maximum = 500) {
  const page = await collection(api, '/api/v2/remarketing/segments.json', { fields: SEGMENT_FIELDS.join(',') }, maximum);
  return { ...page, items: page.items.map(v => project(v, SEGMENT_FIELDS)) };
}
export async function audience(api, segmentId) {
  const segment = project(await api.request('GET', `/api/v2/remarketing/segments/${id(segmentId)}.json`,
    { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS);
  check(id(segment.id) === id(segmentId), 'readback_mismatch');
  const relations = await collection(api, `/api/v2/remarketing/segments/${id(segmentId)}/relations.json`,
    { fields: 'id,object_id,object_type,params' }, 500, segment.relations_count);
  const items = relations.items.map(relationMetadata);
  const cache = new Map();
  for (const item of items) {
    const family = { remarketing_counter: 'counters', remarketing_users_list: 'users-lists', segment: 'segments' };
    const type = Object.hasOwn(family, item.object_type) ? family[item.object_type] : undefined;
    item.sourceMetadataState = 'type_not_supported';
    if (!type || !/^[1-9]\d{0,9}$/.test(String(item.object_id)) || Number(item.object_id) > 2147483647) continue;
    const sourceId = id(item.object_id);
    const key = `${type}:${item.object_id}`;
    if (!cache.has(key)) {
      if (cache.size >= 20) { item.sourceMetadataState = 'lookup_limit'; continue; }
      try {
        const source = type === 'segments' ? project(await api.request('GET', `/api/v2/remarketing/segments/${id(item.object_id)}.json`,
          { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS) : await sources(api, type, item.object_id);
        check(id(source.id) === sourceId, 'readback_mismatch'); cache.set(key, { source, sourceMetadataState: 'resolved' });
      } catch (error) { cache.set(key, { sourceMetadataState: error.code || 'source_read_failed' }); }
    }
    Object.assign(item, cache.get(key));
  }
  // Describes set membership rules, never the identities of audience members.
  // Do not recursively expand nested segments: that can expose cycles and an
  // unbounded network graph. The exact nested id remains available to inspect.
  return { segment, relations: { ...relations, items },
    membership: { minimumMatchingSources: segment.pass_condition ?? null,
      sourceCount: relations.count, includesPersonalIdentifiers: false,
      interpretation: 'Rules and source references only; not a list of people' } };
}
export async function sources(api, type, objectId, maximum = 500) {
  const definition = sourceDefinition(type), query = { fields: definition.fields.join(',') };
  if (objectId !== undefined) {
    const result = project(await api.request('GET', `${definition.route}/${id(objectId)}.json`, { query }), definition.fields);
    check(id(result.id) === id(objectId), 'readback_mismatch'); return result;
  }
  const page = await collection(api, `${definition.route}.json`, query, maximum);
  return { ...page, items: page.items.map(v => project(v, definition.fields)) };
}
export async function counterGoals(api, counterId) {
  const page = await collection(api, `/api/v2/remarketing/counters/${id(counterId)}/goals.json`,
    { fields: GOAL_FIELDS.join(',') }, 500);
  return { ...page, items: page.items.map(v => project(v, GOAL_FIELDS)) };
}
export async function packageInfo(api, packageId) {
  const page = await collection(api, '/api/v2/packages.json', { _id: id(packageId), fields: PACKAGE_FIELDS.join(',') }, 500);
  const found = page.items.filter(v => Number(v.id) === id(packageId));
  check(found.length === 1, 'package_not_resolved'); return project(found[0], PACKAGE_FIELDS);
}
export function treePaths(tree) {
  check(Array.isArray(tree), 'pad_tree_invalid'); const paths = new Map(); let remaining = 5000;
  function visit(node, parent, depth) {
    check(--remaining >= 0 && depth <= 12 && node && typeof node === 'object' && !Array.isArray(node), 'pad_tree_invalid');
    const names = typeof node.name === 'string' ? [...parent, node.name.slice(0, 255)] : parent;
    if (node.id !== undefined) { const key = id(node.id); paths.set(key, [...(paths.get(key) || []), names]); }
    if (node.children !== undefined) { check(Array.isArray(node.children), 'pad_tree_invalid'); node.children.forEach(v => visit(v, names, depth + 1)); }
  }
  tree.forEach(v => visit(v, [], 0)); return paths;
}
export async function placements(api, groupId) {
  const group = await api.get('groups', id(groupId), ['id', 'package_id', 'targetings']);
  check(id(group.id) === id(groupId), 'readback_mismatch'); const pkg = await packageInfo(api, group.package_id);
  const selected = group.targetings?.pads;
  check(selected === undefined || selected === null || Array.isArray(selected) && selected.length <= 200 && new Set(selected.map(id)).size === selected.length, 'pads_invalid');
  const ids = selected?.map(id) || [], paths = new Map(); let treeComplete = String(pkg.pads_tree_id) === '0';
  let treeState = treeComplete ? 'flat' : 'not_declared';
  if (pkg.pads_tree_id !== undefined && String(pkg.pads_tree_id) !== '0') {
    const page = await collection(api, '/api/v2/pads_trees.json', { _id: id(pkg.pads_tree_id), fields: 'id,tree' }, 500);
    const found = page.items.filter(v => Number(v.id) === Number(pkg.pads_tree_id));
    check(found.length <= 1, 'pad_tree_not_resolved');
    // Modern packages can reference a tree absent from this public dictionary.
    // Keep that absence explicit, but still resolve the independent pad names;
    // lack of hierarchy is not evidence that a placement is unknown or empty.
    treeState = page.truncated ? 'not_returned_in_partial_dictionary' : 'not_returned';
    if (found.length) {
      let tree = found[0].tree;
      if (typeof tree === 'string') { try { tree = JSON.parse(tree); } catch { throw new Fault('pad_tree_invalid'); } }
      for (const [key, value] of treePaths(tree)) paths.set(key, value); treeComplete = true; treeState = 'resolved';
    }
  }
  const page = ids.length ? await collection(api, '/api/v2/packages_pads.json',
    { _id__in: ids.join(','), fields: 'id,name,description,patterns' }, 1000) : { items: [], count: 0, truncated: false };
  const rows = ids.map(padId => {
    const matches = page.items.filter(v => Number(v.id) === padId);
    const metadata = matches.length === 1 ? project(matches[0], ['name', 'description']) : {};
    // Pattern lists are optional and vary across packages. A new structured
    // representation must not hide the available placement name or leak its
    // unknown fields; expose only canonical numeric/string pattern references.
    const patterns = matches[0]?.patterns;
    if (typeof patterns === 'string' && patterns.length <= 4096 || Array.isArray(patterns) && patterns.length <= 5000 &&
      patterns.every(v => typeof v === 'string' && v.length <= 4096 || typeof v === 'number' && Number.isFinite(v))) {
      Object.assign(metadata, project({ patterns }, ['patterns']));
    }
    return { id: padId, ...metadata,
      paths: paths.get(padId) || [], metadataResolved: matches.length === 1, treeResolved: paths.has(padId) };
  });
  const defaults = pkg.options?.targetings?.pads?.defaults;
  // Only numeric placement defaults are safe to expose; unknown package option
  // structures remain uninspected and cannot smuggle an arbitrary object out.
  const safeDefaults = Array.isArray(defaults) && defaults.length <= 200 && defaults.every(v => /^[1-9]\d{0,9}$/.test(String(v)) && Number(v) <= 2147483647) ? defaults.map(id) : null;
  return { groupId: id(groupId), packageId: id(pkg.id), treeId: pkg.pads_tree_id ?? null,
    selectedPads: rows, explicitSelection: ids.length > 0, dictionaryTruncated: page.truncated,
    treeComplete, treeState, packageDefaults: safeDefaults,
    note: 'Tree paths describe allowed placements; they do not identify where impressions actually occurred' };
}
const EVENT_TYPES = { 0: 'impressions', 1: 'clicks', 7: 'conversion', 30: 'app_install', 41: 'vk_community_event', 43: 'vk_mini_app_event', 51: 'lead_form', 1013: 'full_video_view', 1017: 'video_10_seconds' };
export async function optimization(api, groupId) {
  const group = await api.get('groups', id(groupId), ['id', 'ad_plan_id', 'package_id', 'objective', 'autobidding_mode', 'priced_goal']);
  check(id(group.id) === id(groupId), 'readback_mismatch'); const pkg = await packageInfo(api, group.package_id);
  const parent = group.ad_plan_id ? project(await api.get('plans', id(group.ad_plan_id), ['id', 'objective', 'autobidding_mode', 'priced_goal']),
    ['id', 'objective', 'autobidding_mode', 'priced_goal']) : null;
  if (parent) check(id(parent.id) === id(group.ad_plan_id), 'readback_mismatch');
  const result = { group: project(group, ['id', 'ad_plan_id', 'package_id', 'objective', 'autobidding_mode', 'priced_goal']),
    parent, package: project(pkg, ['id', 'name', 'objective', 'priced_event_type', 'paid_event_type']),
    optimizedEvent: Object.hasOwn(EVENT_TYPES, pkg.priced_event_type) ? EVENT_TYPES[pkg.priced_event_type] : 'unknown', bindingState: 'not_configured',
    note: 'A configured goal is not evidence of a real registration or of the event firing on the website' };
  const goal = group.priced_goal;
  if (!Object.hasOwn(group, 'priced_goal')) { result.bindingState = 'group_goal_not_returned'; return result; }
  // Report the actual group and parent values separately. An empty group goal
  // does not prove inheritance, and a parent goal must not become a guessed
  // effective conversion binding in this diagnostic.
  if (!goal || !/^[1-9]\d{0,9}$/.test(String(goal.source_id)) || Number(goal.source_id) > 2147483647 || typeof goal.name !== 'string' || !goal.name) return result;
  result.bindingState = 'source_type_not_inspected';
  if (Number(pkg.priced_event_type) !== 7) return result;
  const sourcePage = await sources(api, 'counters'), counters = sourcePage.items.filter(v => Number(v.counter_id) === Number(goal.source_id));
  result.sourceListTruncated = sourcePage.truncated; result.bindingState = 'source_not_resolved';
  if (counters.length !== 1) return result;
  result.counter = counters[0];
  const goals = await counterGoals(api, goal.source_id);
  const matching = goals.items.filter(v => `${v.condition}:${v.substr}` === goal.name);
  result.goalsTruncated = goals.truncated;
  if (matching.length === 1) { result.goal = matching[0]; result.bindingState = sourcePage.truncated || goals.truncated ? 'goal_match_in_partial_list' : 'configured'; }
  else result.bindingState = 'goal_not_resolved';
  return result;
}
