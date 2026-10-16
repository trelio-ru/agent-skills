import { check, id, Fault, stable } from './core.mjs';

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
const SEARCH_FIELDS = ['id', 'name', 'status', 'phrases_cnt', 'stop_phrases_cnt', 'errors_cnt', 'created', 'updated', 'category'];
const PHRASE_FIELDS = ['phrase', 'stop_phrases', 'price_coeff', 'expires', 'fading', 'sub'];
const PACKAGE_FIELDS = ['id', 'name', 'description', 'objective', 'pads_tree_id', 'options', 'priced_event_type', 'paid_event_type', 'status'];
export const VK_GROUP_SOURCES = '/api/v2/remarketing/vk_groups';
const VK_GROUP_FIELDS = ['id', 'name', 'shortname', 'members_count'];
const VK_SOURCE_FIELDS = ['id', 'object_id', 'name', 'shortname', 'status', 'loaded_users_count', 'users_count'];

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

// Search is performed by the advertising dictionary, not the social API or a
// browser. A display-name hit never resolves a community. Only the exact public
// id or shortname can select a row; a URL is parsed locally and never fetched.
export function vkGroupQuery(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 255 && value === value.trim(), 'vk_group_query_invalid');
  let query = value;
  if (value.includes('://')) {
    let url; try { url = new URL(value); } catch { throw new Fault('vk_group_query_invalid'); }
    check(url.protocol === 'https:' && ['vk.com', 'www.vk.com', 'm.vk.com'].includes(url.hostname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/[a-z0-9_]+\/?$/i.test(url.pathname), 'vk_group_query_invalid');
    query = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  check(/^[a-z0-9_]{1,128}$/i.test(query), 'vk_group_query_invalid');
  query = query.toLowerCase();
  const numeric = /^(?:(?:club|public|event))?([1-9]\d{0,9})$/.exec(query);
  return { query, ...(numeric ? { publicId: id(numeric[1]) } : { shortname: query }) };
}
export async function vkGroups(api, query, maximum = 500) {
  const selector = vkGroupQuery(query);
  const page = await collection(api, '/api/v2/vk_groups.json', { _q: selector.query, fields: VK_GROUP_FIELDS.join(',') }, maximum);
  const items = page.items.map(v => vkMetadata(v, VK_GROUP_FIELDS));
  const matches = items.filter(v => selector.publicId !== undefined ? v.id === selector.publicId :
    typeof v.shortname === 'string' && v.shortname.toLowerCase() === selector.shortname);
  const result = { items: [], count: page.count, query: selector.query, resolved: matches.length === 1 ? matches[0] : null,
    resolution: matches.length === 1 ? selector.publicId !== undefined ? 'exact_public_id' : 'exact_shortname' :
      matches.length > 1 ? 'ambiguous' : 'not_found_in_results',
    // The legacy dictionary contract describes an audience threshold; current
    // rows alone do not prove eligibility or absence of a missing community.
    sourceRegistrationChecked: false, campaignEligibility: 'not_assessed',
    scannedCount: items.length, scanTruncated: page.truncated, truncated: page.truncated };
  // Broad queries can return hundreds of unrelated groups. Scan the selected
  // bound before resolving identity, but do not copy that whole dictionary into
  // the model's result. A late exact match stays visible outside the preview.
  // Scan completeness and output truncation must remain independent evidence.
  const outputBytes = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  check(outputBytes() <= 14000, 'vk_group_metadata_too_large');
  for (const item of items) {
    if (result.items.length >= 20) break;
    result.items.push(item);
    if (outputBytes() > 14000) { result.items.pop(); break; }
  }
  result.truncated ||= result.items.length < items.length;
  return result;
}
function vkMetadata(value, fields) {
  const result = project(value, fields); result.id = id(result.id);
  // These fields are aggregate integers, never arrays of members. Reject a
  // changed representation at the projection boundary rather than leaking it
  // under a harmless-sounding count field. Negative sentinels remain unknown.
  for (const key of ['members_count', 'users_count', 'loaded_users_count']) if (Object.hasOwn(result, key) && result[key] !== null) {
    check(['number', 'string'].includes(typeof result[key]) && /^-?(?:0|[1-9]\d{0,9})$/.test(String(result[key])) &&
      Math.abs(Number(result[key])) <= 2147483647, 'response_invalid');
  }
  for (const key of ['name', 'shortname', 'status']) if (Object.hasOwn(result, key)) check(result[key] === null || typeof result[key] === 'string', 'response_invalid');
  return result;
}
function vkSourceMetadata(value) {
  const result = vkMetadata(value, VK_SOURCE_FIELDS);
  check(['number', 'string'].includes(typeof result.object_id) && /^-?[1-9]\d{0,9}$/.test(String(result.object_id)) &&
    Math.abs(Number(result.object_id)) <= 2147483647, 'response_invalid');
  result.object_id = Number(result.object_id);
  const loaded = result.loaded_users_count;
  const knownSize = ['number', 'string'].includes(typeof loaded) && /^(?:0|[1-9]\d{0,9})$/.test(String(loaded)) && Number(loaded) <= 2147483647;
  result.readiness = { state: result.status === 'loading' || result.status === 'unloaded' ? result.status : result.status !== 'loaded' ? 'unknown' :
    !knownSize ? 'loaded_size_unknown' : Number(loaded) === 0 ? 'loaded_empty' : 'loaded_nonempty',
    campaignEligibility: 'not_assessed' };
  return result;
}
export async function vkGroupSources(api, maximum = 500, sourceId) {
  // The individual resource documents DELETE only. Exact reads use the
  // collection's _id__in filter, also used by the first-party source picker;
  // never invent a GET on the single-object endpoint or fall back after 403.
  const page = await collection(api, `${VK_GROUP_SOURCES}.json`, { fields: VK_SOURCE_FIELDS.join(','),
    ...(sourceId === undefined ? {} : { _id__in: id(sourceId) }) }, maximum);
  return { ...page, items: page.items.map(vkSourceMetadata) };
}
export async function vkGroupSourceByPublicId(api, publicId) {
  const page = await vkGroupSources(api, 5000);
  check(!page.truncated, 'vk_group_sources_incomplete');
  const found = page.items.filter(v => Number(v.object_id) === id(publicId));
  check(found.length === 1, 'vk_group_source_not_registered_or_ambiguous');
  return found[0];
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
    const family = { remarketing_counter: 'counters', remarketing_users_list: 'users-lists', segment: 'segments', remarketing_search_phrases: 'search-phrases', remarketing_vk_group: 'vk-groups' };
    const type = Object.hasOwn(family, item.object_type) ? family[item.object_type] : undefined;
    item.sourceMetadataState = 'type_not_supported';
    if (!type) continue;
    // Search phrase relations have an internal object_id distinct from the
    // list addressed by the v3 API. Use the explicit source_id; an absent or
    // malformed reference is not permission to guess from object_id/name.
    const pointer = type === 'search-phrases' ? item.params?.source_id : item.object_id;
    if (!/^[1-9]\d{0,9}$/.test(String(pointer)) || Number(pointer) > 2147483647) {
      item.sourceMetadataState = 'source_reference_invalid'; continue;
    }
    const sourceId = id(pointer);
    const key = `${type}:${sourceId}`;
    if (!cache.has(key)) {
      if (cache.size >= 20) { item.sourceMetadataState = 'lookup_limit'; continue; }
      try {
        const source = type === 'segments' ? project(await api.request('GET', `/api/v2/remarketing/segments/${id(item.object_id)}.json`,
          { query: { fields: SEGMENT_FIELDS.join(',') } }), SEGMENT_FIELDS) : await sources(api, type, sourceId);
        check(id(source.id) === sourceId, 'readback_mismatch');
        cache.set(key, { source, sourceMetadataState: 'resolved' });
      } catch (error) { cache.set(key, { sourceMetadataState: error.code || 'source_read_failed' }); }
    }
    Object.assign(item, cache.get(key));
    // The cache belongs to the internal source id. Each relation must still
    // agree with that source's public object_id, including a second relation
    // sharing the cached source with a different (or malformed) source_id.
    if (type === 'vk-groups' && item.source && item.params?.source_id !== undefined) {
      try { check(id(item.source.object_id) === id(item.params.source_id), 'vk_group_source_reference_mismatch'); }
      catch { item.sourceMetadataState = 'vk_group_source_reference_mismatch'; }
    }
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
  if (type === 'search-phrases') return objectId === undefined ? searchPhraseLists(api, maximum) : searchPhrases(api, objectId);
  if (type === 'vk-groups') {
    const page = await vkGroupSources(api, maximum, objectId);
    if (objectId === undefined) return page;
    const found = page.items.filter(v => v.id === id(objectId)); check(found.length === 1, 'vk_group_source_not_resolved');
    return { ...found[0], metadataListTruncated: page.truncated };
  }
  const definition = sourceDefinition(type), query = { fields: definition.fields.join(',') };
  if (objectId !== undefined) {
    const result = project(await api.request('GET', `${definition.route}/${id(objectId)}.json`, { query }), definition.fields);
    check(id(result.id) === id(objectId), 'readback_mismatch'); return result;
  }
  const page = await collection(api, `${definition.route}.json`, query, maximum);
  return { ...page, items: page.items.map(v => project(v, definition.fields)) };
}

// This v3 endpoint documents ids, not offset/limit pagination. Read only one
// bounded metadata response; never send the campaign-list pagination scheme or
// claim a complete inventory when the endpoint supplies no count.
export async function searchPhraseLists(api, maximum = 500, listId) {
  check(Number.isInteger(maximum) && maximum > 0 && maximum <= 5000, 'list_limit_invalid');
  const query = listId === undefined ? {} : { ids: id(listId) };
  const page = await api.request('GET', '/api/v3/search_phrases.json', { query });
  check(Array.isArray(page.items) && page.items.length <= 5000, 'response_invalid');
  const items = page.items.slice(0, maximum).map(v => project(v, SEARCH_FIELDS));
  const seen = new Set();
  for (const item of items) { const key = id(item.id); check(!seen.has(key), 'collection_changed'); seen.add(key); }
  if (listId !== undefined) {
    check(page.items.length === 1 && id(items[0]?.id) === id(listId), 'search_phrase_list_not_resolved');
    return items[0];
  }
  const count = countOf(page.count);
  check(count === null || count >= page.items.length, 'response_invalid');
  return { items, count, truncated: page.items.length > maximum || count === null || items.length !== count };
}

export async function searchPhrases(api, listId) {
  const sourceId = id(listId), before = await searchPhraseLists(api, 1, sourceId);
  const page = await api.request('GET', `/api/v3/search_phrases/${sourceId}.json`);
  check(Array.isArray(page.items) && page.items.length <= 5000, 'response_invalid');
  const items = page.items.slice(0, 500).map(value => {
    const result = project(value, PHRASE_FIELDS);
    check(typeof result.phrase === 'string' && result.phrase.length > 0 &&
      (result.stop_phrases === undefined || Array.isArray(result.stop_phrases) && result.stop_phrases.every(v => typeof v === 'string')), 'response_invalid');
    // Neither unknown field names nor original error/file rows leave this
    // projection. Their presence still prevents a claim of decoded full rules.
    return { ...result, ruleProjectionComplete: Object.keys(value).every(k => PHRASE_FIELDS.includes(k)) };
  });
  // An edit between metadata and contents must not yield a convincing hybrid
  // audience rule. This is an optimistic consistency check, not atomic API CAS.
  const after = await searchPhraseLists(api, 1, sourceId);
  check(stable(before) === stable(after), 'collection_changed');
  const count = countOf(before.phrases_cnt), contentCount = countOf(page.count);
  check(contentCount === null || contentCount >= page.items.length, 'response_invalid');
  const countMatches = count === null ? null : count === page.items.length;
  // The source's JSON write schema defines list-level stop_phrases separately
  // from the per-phrase read rows. When the same root field is returned, project
  // it explicitly. Do not treat empty per-phrase arrays as evidence that
  // the source's declared exclusions are absent. Read the exact known
  // root field when returned; never derive its words from the list title.
  const declaredStops = countOf(before.stop_phrases_cnt), hasGlobalStops = Object.hasOwn(page, 'stop_phrases');
  const validGlobalStops = hasGlobalStops && Array.isArray(page.stop_phrases) && page.stop_phrases.length <= 5000 &&
    page.stop_phrases.every(v => typeof v === 'string' && v.length <= 4096);
  const globalStops = validGlobalStops ? page.stop_phrases.slice(0, 500) : null;
  const globalCountMatches = validGlobalStops && declaredStops !== null ? declaredStops === page.stop_phrases.length : null;
  const globalComplete = validGlobalStops && globalCountMatches === true && globalStops.length === page.stop_phrases.length;
  const globalState = !hasGlobalStops ? 'not_returned' : !validGlobalStops ? 'representation_not_supported'
    : globalStops.length < page.stop_phrases.length ? 'bounded' : globalCountMatches === false ? 'metadata_count_mismatch'
    : globalComplete ? 'resolved' : 'returned_without_count';
  return { ...before, items, returnedCount: page.items.length,
    truncated: page.items.length > items.length || countMatches !== true || contentCount !== null && contentCount !== page.items.length ||
      validGlobalStops && globalStops.length < page.stop_phrases.length,
    errorsCount: countOf(page.errors_cnt ?? before.errors_cnt),
    itemCountMatchesMetadata: countMatches,
    ruleProjectionComplete: Object.keys(page).every(k => ['items', 'count', 'errors_cnt', 'stop_phrases'].includes(k)) &&
      (!hasGlobalStops || validGlobalStops) && items.every(v => v.ruleProjectionComplete),
    declaredStopPhraseCount: declaredStops,
    globalStopPhrases: globalStops, globalStopPhrasesState: globalState,
    globalStopPhraseCoverageComplete: globalComplete,
    // The official read example returns a bare expires number but does not
    // define its unit. Keep raw expires/fading/sub, without deriving days or
    // inventing an expansion switch from the name or substring.
    expiresUnit: 'not_established_by_read_contract', expansionState: 'not_documented',
    stopPhraseScope: 'per_phrase_as_returned', globalStopPhraseScope: 'source_list_as_returned',
    note: 'Phrase and stop_phrases are source rules, not personal audience members; source title does not establish these rules' };
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
const PAID_EVENTS = { 0: 'impressions_1000', 1: 'clicks', 7: 'conversion', 1013: 'full_video_view', 1017: 'video_10_seconds' };
export async function optimization(api, groupId) {
  const group = await api.get('groups', id(groupId), ['id', 'ad_plan_id', 'package_id', 'objective', 'autobidding_mode', 'priced_goal']);
  check(id(group.id) === id(groupId), 'readback_mismatch'); const pkg = await packageInfo(api, group.package_id);
  const parent = group.ad_plan_id ? project(await api.get('plans', id(group.ad_plan_id), ['id', 'objective', 'autobidding_mode', 'priced_goal']),
    ['id', 'objective', 'autobidding_mode', 'priced_goal']) : null;
  if (parent) check(id(parent.id) === id(group.ad_plan_id), 'readback_mismatch');
  const result = { group: project(group, ['id', 'ad_plan_id', 'package_id', 'objective', 'autobidding_mode', 'priced_goal']),
    parent, package: project(pkg, ['id', 'name', 'objective', 'priced_event_type', 'paid_event_type']),
    optimizedEvent: Object.hasOwn(EVENT_TYPES, pkg.priced_event_type) ? EVENT_TYPES[pkg.priced_event_type] : 'unknown', bindingState: 'not_configured',
    // Keep the first release's field as an explicitly scoped compatibility
    // alias. Package event codes are not a decoded effective group strategy;
    // paid_event_type describes billing and must not become optimization data.
    optimizedEventScope: 'package_priced_event_type',
    paidEvent: Object.hasOwn(PAID_EVENTS, pkg.paid_event_type) ? PAID_EVENTS[pkg.paid_event_type] : 'unknown',
    strategy: { groupAutobiddingMode: group.autobidding_mode ?? null, parentAutobiddingMode: parent?.autobidding_mode ?? null,
      effectiveGoalInterpretation: 'not_established_by_package_codes' },
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
