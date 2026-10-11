import { check, clean, Fault, id, date } from './core.mjs';

// Never accept an API host or arbitrary path from a payload. OAuth bearer
// headers cannot follow redirects, even to the provider's other public domain.
export const ORIGIN = 'https://ads.vk.com';
const CATALOG = { packages: '/api/v2/packages.json', patterns: '/api/v2/banner_patterns.json',
  fields: '/api/v2/banner_fields.json', regions: '/api/v2/regions.json', interests: '/api/v2/interests.json' };
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
        try { const parsed = await boundedResponse(response); details = { fields: Object.fromEntries(Object.entries(parsed.error?.fields || {})
          .filter(([k, v]) => /^[a-z0-9_]{1,80}$/.test(k) && /^[a-z0-9_]{1,80}$/.test(v?.code || '')).map(([k, v]) => [k, v.code])) }; } catch { /* Error bodies are optional; raw text never leaves the client. */ }
        const code = response.status === 401 ? 'authorization_required' : response.status === 403 ? 'permission_denied'
          : method !== 'GET' && (response.status >= 500 || response.status === 429) ? 'write_result_unknown'
          : response.status === 405 ? 'api_method_unsupported' : 'api_rejected';
        throw new Fault(code, { httpStatus: response.status, ...details });
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
  async stats(entity, ids, from, to) {
    check(['plans', 'groups', 'banners'].includes(entity) && ids.length > 0 && ids.length <= 200, 'statistics_ids_invalid');
    date(from); date(to); check(from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 < 365, 'statistics_dates_invalid');
    return this.request('GET', `/api/v2/statistics/${this.resource(entity)}/day.json`,
      { query: { id: ids.map(id).join(','), date_from: from, date_to: to, metrics: 'base' } });
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
