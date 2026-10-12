import { check, clean, Fault, id, date } from './core.mjs';

// Never accept an API host or arbitrary path from a payload. OAuth bearer
// headers cannot follow redirects, even to the provider's other public domain.
export const ORIGIN = 'https://ads.vk.com';
const CATALOG = { packages: '/api/v2/packages.json', patterns: '/api/v2/banner_patterns.json',
  fields: '/api/v2/banner_fields.json', regions: '/api/v2/regions.json', interests: '/api/v2/interests.json' };
// API failures are persisted and later shown from receipts. Messages, URLs and
// payload values are never traversed. Nested diagnostics accept only validation
// containers (fields/items/errors), canonical field tokens and bounded indices.
const ERROR_TOKEN = /^[a-z0-9_]{1,80}$/;
const PRIVATE_FIELD = /secret|password|token|authorization|cookie|__proto__|constructor|prototype/i;
const ERROR_INDEX = /^(?:0|[1-9]\d{0,3})$/;
const ERROR_PATH = /^[a-z0-9_]{1,80}(?:\[(?:0|[1-9]\d{0,3})\]|\.[a-z0-9_]{1,80}){0,8}$/;
export function safeApiErrorDetails(details = {}, secrets = []) {
  const result = {};
  if (Number.isInteger(details?.httpStatus) && details.httpStatus >= 400 && details.httpStatus <= 599) result.httpStatus = details.httpStatus;
  const privateValues = secrets.filter(value => typeof value === 'string' && value.length);
  const safe = (field, code) => typeof code === 'string' && ERROR_TOKEN.test(code) &&
    !PRIVATE_FIELD.test(field) && !privateValues.some(value => field.includes(value) || code.includes(value));
  const fields = Object.fromEntries(Object.entries(details?.fields || {}).filter(([field, code]) =>
    ERROR_TOKEN.test(field) && safe(field, code)).slice(0, 32));
  if (Object.keys(fields).length) result.fields = fields;
  // Reprojection happens at the durable receipt boundary and after restart.
  // Validate this representation again rather than trusting previously stored
  // paths, and share the 32-entry budget with the compatible top-level fields.
  const fieldErrors = []; const seen = new Set();
  for (const item of Array.isArray(details?.fieldErrors) ? details.fieldErrors.slice(0, 32) : []) {
    const field = item?.path, code = item?.code;
    if (typeof field !== 'string' || field.length > 400 || !ERROR_PATH.test(field) || !safe(field, code)) continue;
    if (Object.keys(fields).length + fieldErrors.length >= 32) break;
    const key = `${field}:${code}`;
    if (!seen.has(key)) { seen.add(key); fieldErrors.push({ path: field, code }); }
  }
  if (fieldErrors.length) result.fieldErrors = fieldErrors;
  return result;
}
// Do not recursively search arbitrary JSON for a key called "code": a creative
// or message could contain one. Follow only explicit validation structures. The
// traversal budget also bounds work when the provider sends thousands of errors.
export function apiValidationDetails(error, secrets = []) {
  const fields = {}, fieldErrors = []; let remaining = 256;
  const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
  function fieldMap(map, prefix = '', depth = 0) {
    if (!ownObject(map) || depth > 8) return;
    for (const [field, node] of Object.entries(map).slice(0, 64)) {
      if (--remaining < 0) return;
      if (!ERROR_TOKEN.test(field) || PRIVATE_FIELD.test(field) ||
        prefix && /^\d+$/.test(field) && !ERROR_INDEX.test(field)) continue;
      const name = prefix ? ERROR_INDEX.test(field) ? `${prefix}[${field}]` : `${prefix}.${field}` : field;
      if (!prefix && typeof node?.code === 'string') fields[field] = node.code;
      else if (typeof node?.code === 'string') fieldErrors.push({ path: name, code: node.code });
      validation(node, name, depth + 1);
    }
  }
  function validation(node, prefix, depth) {
    if (!ownObject(node) || depth > 8 || remaining < 0) return;
    fieldMap(node.fields, prefix, depth);
    // List errors may be an array (its position is the index), a numeric map,
    // or records carrying an explicit index. Never copy a supplied path/name.
    for (const container of [node.items, node.errors]) {
      if (!container || typeof container !== 'object') continue;
      for (const [position, entry] of Object.entries(container).slice(0, 64)) {
        if (--remaining < 0) return;
        const index = ownObject(entry) && Object.hasOwn(entry, 'index') ? entry.index : position;
        if (!ERROR_INDEX.test(String(index))) continue;
        const name = `${prefix}[${index}]`;
        if (typeof entry?.code === 'string') fieldErrors.push({ path: name, code: entry.code });
        validation(entry, name, depth + 1);
      }
    }
  }
  fieldMap(error?.fields);
  return safeApiErrorDetails({ fields, fieldErrors }, secrets);
}
export class Api {
  constructor(auth, { fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.auth = auth; this.fetcher = fetcher; this.sleep = sleep;
    this.access = typeof auth.access_token === 'string' && auth.expires_at > Date.now() + 60000 ? auth.access_token : null;
  }
  resource(entity) {
    const name = { plans: 'ad_plans', groups: this.auth.groups, banners: 'banners' }[entity];
    check(name && ['ad_plans', 'ad_groups', 'campaigns', 'banners'].includes(name), 'entity_invalid'); return name;
  }
  endpoint(entity, objectId) { return `/api/v2/${this.resource(entity)}${objectId ? `/${id(objectId)}` : ''}.json`; }
  async request(method, route, { body, query, auth = true } = {}) {
    check(/^\/api\/v[23]\/[a-z0-9_/.]+\.json$/.test(route) && !route.includes('..'), 'api_route_invalid');
    const url = new URL(route, ORIGIN);
    for (const [k, v] of Object.entries(query || {})) { check(v !== undefined && v !== null, 'query_invalid'); url.searchParams.set(k, String(v)); }
    if (auth && !this.access) await this.login();
    const secrets = [this.auth.client_secret, this.access];
    // Only reads retry. A timeout/429/5xx during a write can follow a committed
    // change, and VK does not document a client idempotency key for these APIs.
    for (let attempt = 0; attempt < (method === 'GET' ? 3 : 1); attempt++) {
      let response;
      try { response = await this.fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(auth ? { Authorization: `Bearer ${this.access}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
        body: body ? (body instanceof URLSearchParams || body instanceof FormData ? body : JSON.stringify(body)) : undefined }); }
      catch { if (method === 'GET' && attempt < 2) { await this.sleep(500 * 2 ** attempt); continue; }
        throw new Fault(method === 'GET' ? 'network_unavailable' : 'write_result_unknown'); }
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel(); await this.sleep(500 * 2 ** attempt); continue;
      }
      if (!response.ok) {
        let details = {};
        try { const parsed = await boundedResponse(response); details = apiValidationDetails(parsed.error, secrets); } catch { /* Error bodies are optional; raw text never leaves the client. */ }
        const code = response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
          : method !== 'GET' && (response.status >= 500 || response.status === 429) ? 'write_result_unknown'
          : response.status === 405 ? 'api_method_unsupported' : 'api_rejected';
        throw new Fault(code, safeApiErrorDetails({ httpStatus: response.status, ...details }, secrets));
      }
      if (response.status === 204) return {};
      try { return clean(await boundedResponse(response), secrets); }
      catch (error) { if (error instanceof Fault && error.code !== 'response_invalid') throw error;
        throw new Fault(method === 'GET' ? 'response_invalid' : 'write_result_unknown'); }
    }
  }
  async login() {
    const body = new URLSearchParams({ grant_type: this.auth.mode === 'agency' ? 'agency_client_credentials' : 'client_credentials',
      client_id: this.auth.client_id, client_secret: this.auth.client_secret });
    if (this.auth.mode === 'agency') body.set('agency_client_name', this.auth.agency_client);
    // OAuth output is consumed privately, unlike ordinary API JSON projection.
    let response;
    try { response = await this.fetcher(new URL('/api/v2/oauth2/token.json', ORIGIN), { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
    catch { throw new Fault('network_unavailable'); }
    if (!response.ok) { await response.body?.cancel(); throw new Fault(response.status === 401 || response.status === 400 ? 'authorization_required' : response.status === 403 ? 'permission_denied' : 'network_unavailable', { httpStatus: response.status }); }
    const token = await boundedResponse(response);
    check(typeof token.access_token === 'string' && token.access_token.length > 0 && token.access_token.length < 8192 && !/[\r\n]/.test(token.access_token), 'oauth_response_invalid');
    this.access = token.access_token;
    this.auth.access_token = this.access;
    this.auth.expires_at = Date.now() + (Number.isFinite(Number(token.expires_in)) && Number(token.expires_in) > 0 ? Number(token.expires_in) : 300) * 1000;
  }
  async get(entity, objectId, fields) { return this.request('GET', this.endpoint(entity, id(objectId)), { query: fields ? { fields: fields.join(',') } : {} }); }
  async list(entity, query = {}, maximum = 1000) {
    check(Number.isInteger(maximum) && maximum > 0 && maximum <= 5000, 'list_limit_invalid');
    const items = []; let count = null;
    for (let offset = 0; offset < maximum;) {
      const limit = Math.min(200, maximum - offset);
      const page = await this.request('GET', this.endpoint(entity), { query: { ...query, limit, offset } });
      check(Array.isArray(page.items) && page.items.length <= limit, 'response_invalid');
      items.push(...page.items); offset += page.items.length; count = Number.isInteger(page.count) ? page.count : null;
      if (!page.items.length || page.items.length < limit || count !== null && offset >= count) return { items, count, truncated: false };
    }
    return { items, count, truncated: count === null || items.length < count };
  }
  async catalog(name) {
    check(CATALOG[name], 'catalog_invalid');
    // Catalogues have their own page ceilings: the packages endpoint rejects
    // the campaign-list size of 200. Let each endpoint choose its default
    // instead of guessing a shared maximum or treating a 400 as an auth error.
    // This remains one bounded page, not an exhaustive catalogue download.
    return this.request('GET', CATALOG[name]);
  }
  async stats(entity, ids, from, to, options = {}) {
    check(['plans', 'groups', 'banners'].includes(entity) && ids.length > 0 && ids.length <= 200, 'statistics_ids_invalid');
    check(new Set(ids.map(id)).size === ids.length && Object.keys(options).every(k =>
      ['family', 'period', 'metrics', 'attribution', 'conversionType', 'breakdown'].includes(k)), 'statistics_options_invalid');
    date(from); date(to); check(from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 < 365, 'statistics_dates_invalid');
    // The official v2/v3 Statistics contract lists metric sets and goal types,
    // but no placement/device breakdown argument. Reject that request locally
    // rather than inventing dimensions or implying a zero report from totals.
    check(!options.breakdown || options.breakdown === 'none', 'statistics_breakdown_not_documented');
    const family = options.family || 'general', period = options.period || 'day';
    check(['general', 'goals', 'inapp'].includes(family), 'statistics_family_invalid');
    check(family === 'general' || entity !== 'groups' || this.auth.groups === 'ad_groups', 'statistics_resource_not_documented');
    check(['day', 'summary'].includes(period) && (family === 'general' || period === 'day'), 'statistics_period_invalid');
    const query = { id: ids.map(id).join(','), date_from: from, date_to: to };
    if (options.attribution) { check(['conversion', 'impression'].includes(options.attribution), 'statistics_attribution_invalid'); query.attribution = options.attribution; }
    if (family === 'general') {
      check(!options.conversionType, 'statistics_options_invalid');
      const metrics = (options.metrics || 'base').split(',');
      check(metrics.length <= 14 && new Set(metrics).size === metrics.length && metrics.every(v =>
        ['all', 'base', 'events', 'video', 'carousel', 'ad_offers', 'uniques', 'uniques_video', 'tps', 'romi', 'playable', 'custom_event', 'social_network'].includes(v)), 'statistics_metrics_invalid');
      query.metrics = metrics.join(',');
    } else {
      check(!options.metrics, 'statistics_options_invalid');
      const kinds = (options.conversionType || 'postclick').split(',');
      check(kinds.length <= 3 && new Set(kinds).size === kinds.length && kinds.every(v => ['postclick', 'postview', 'total'].includes(v)), 'statistics_conversion_type_invalid');
      query.conversion_type = kinds.join(',');
    }
    return this.request('GET', `/api/v2/statistics/${family === 'general' ? '' : `${family}/`}${this.resource(entity)}/${period}.json`, { query });
  }
}
export async function boundedResponse(response, maximum = 2 * 1024 * 1024) {
  check(Number(response.headers.get('content-length') || 0) <= maximum, 'response_too_large');
  const reader = response.body?.getReader(); check(reader, 'response_invalid');
  let length = 0; const chunks = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length;
      check(length <= maximum, 'response_too_large'); chunks.push(Buffer.from(value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault('response_invalid'); }
  } finally { await reader.cancel().catch(() => {}); chunks.forEach(c => c.fill(0)); }
}
