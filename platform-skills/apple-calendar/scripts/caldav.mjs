import { xml2js } from '../.build/xml.mjs';
import { Fault, check, hash, interval } from './core.mjs';

const ROOT = 'https://caldav.icloud.com/';
const MAX_BYTES = 5 * 1024 * 1024;
const local = node => node?.name?.split(':').pop();
const children = (node, name) => (node?.elements || []).filter(child => local(child) === name);
const child = (node, name) => children(node, name)[0];
const content = node => (node?.elements || []).map(part => part.text ?? part.cdata ?? content(part)).join('');
const property = (node, name) => content(child(node, name));
export const escapeXml = value => String(value).replace(/[<>&"']/g, symbol =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[symbol]);

export function appleUrl(value, base = ROOT) {
  let url;
  try { url = new URL(value, base); } catch { throw new Fault('server_url_invalid'); }
  // Discovery and redirects are provider input. Validate every hop before
  // attaching Authorization, including relative hrefs in a multistatus body.
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search &&
    (!url.port || url.port === '443') &&
    /^(?:caldav|p\d{2,3}-caldav)\.icloud\.com$/.test(url.hostname), 'server_origin_denied');
  check(!/%2f|%5c|%00|\\/i.test(url.pathname), 'server_path_invalid');
  return url.href;
}

export function multistatus(xml, base) {
  check(Buffer.byteLength(xml) <= MAX_BYTES && !/<!DOCTYPE|<!ENTITY/i.test(xml), 'xml_invalid');
  let document;
  try { document = xml2js(xml, { compact: false, ignoreComment: true, ignoreInstruction: true }); }
  catch { throw new Fault('xml_invalid'); }
  const root = child(document, 'multistatus');
  check(root, 'multistatus_required');
  const responses = children(root, 'response');
  check(responses.length <= 2000 && !child(root, 'number-of-matches-within-limits'), 'response_limit_exceeded');
  return responses.map(response => {
    const href = property(response, 'href');
    check(href, 'response_href_missing');
    const props = children(response, 'propstat').filter(stat => /\s200(?:\s|$)/.test(property(stat, 'status')))
      .flatMap(stat => child(stat, 'prop')?.elements || []);
    return { url: appleUrl(href, base), props: { elements: props }, status: property(response, 'status') };
  });
}

const propfind = properties => `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${properties}</d:prop></d:propfind>`;

export class CalDAV {
  constructor(credentials, { fetcher = fetch } = {}) {
    this.credentials = credentials;
    this.fetcher = fetcher;
  }
  async request(method, input, { body, headers = {}, allowMissing = false } = {}) {
    let url = appleUrl(input);
    const deadline = AbortSignal.timeout(30000);
    for (let redirects = 0; redirects <= 4; redirects++) {
      let response;
      try {
        response = await this.fetcher(url, { method, body, signal: deadline, redirect: 'manual',
          headers: { 'User-Agent': 'Trelio-Apple-Calendar/1.0.2',
            Authorization: `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`,
            ...(body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}), ...headers } });
      } catch { throw new Fault('network_outcome_unknown'); }
      if ([301, 302, 307, 308].includes(response.status)) {
        // An automatic redirected PUT/DELETE would be a second dispatch. Only
        // read discovery may follow a validated iCloud redirect.
        check(['GET', 'PROPFIND', 'REPORT'].includes(method), 'write_redirect_requires_reconciliation');
        const location = response.headers.get('location');
        await response.body?.cancel();
        check(location && redirects < 4, 'redirect_invalid');
        url = appleUrl(location, url);
        continue;
      }
      if (response.status === 401) { await response.body?.cancel(); throw new Fault('needs_reconnect'); }
      if (response.status === 403) { await response.body?.cancel(); throw new Fault('calendar_access_denied'); }
      if (response.status === 412) { await response.body?.cancel(); throw new Fault('calendar_changed'); }
      if (response.status === 429) { await response.body?.cancel(); throw new Fault('rate_limited'); }
      if (response.status === 404 && allowMissing) { await response.body?.cancel(); return { missing: true }; }
      if (!response.ok) { await response.body?.cancel(); throw new Fault('server_request_failed'); }
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of response.body || []) {
          bytes += chunk.length;
          check(bytes <= MAX_BYTES, 'response_limit_exceeded');
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { throw error instanceof Fault ? error : new Fault('network_outcome_unknown'); }
      return { url, status: response.status, text: Buffer.concat(chunks).toString('utf8'),
        etag: response.headers.get('etag'), scheduleTag: response.headers.get('schedule-tag') };
    }
    throw new Fault('redirect_invalid');
  }
  async properties(url, properties, depth = '0') {
    const response = await this.request('PROPFIND', url, { body: propfind(properties), headers: { Depth: depth } });
    check(response.status === 207, 'multistatus_required');
    return multistatus(response.text, response.url);
  }
  async calendars() {
    const root = await this.properties(ROOT, '<d:current-user-principal/>');
    const principalHref = property(child(root[0]?.props, 'current-user-principal'), 'href');
    check(principalHref, 'principal_missing');
    const principal = appleUrl(principalHref, root[0].url);
    const details = await this.properties(principal, '<c:calendar-home-set/><c:calendar-user-address-set/>');
    const homeHref = property(child(details[0]?.props, 'calendar-home-set'), 'href');
    check(homeHref, 'calendar_home_missing');
    const home = appleUrl(homeHref, principal);
    this.addresses = children(child(details[0].props, 'calendar-user-address-set'), 'href')
      .map(value => content(value).toLowerCase()).filter(value => value.startsWith('mailto:'));
    const rows = await this.properties(home, '<d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/><c:calendar-timezone/><a:calendar-color/>', '1');
    const calendars = rows.filter(row => child(child(row.props, 'resourcetype'), 'calendar')).map(row => {
      check(new URL(row.url).pathname.endsWith('/'), 'calendar_collection_invalid');
      const privileges = children(child(row.props, 'current-user-privilege-set'), 'privilege')
        .flatMap(value => (value.elements || []).map(local));
      const components = children(child(row.props, 'supported-calendar-component-set'), 'comp').map(node => node.attributes?.name);
      return { id: hash(row.url).slice(0, 32), url: row.url,
        name: property(row.props, 'displayname'),
        writable: privileges.includes('all') || privileges.includes('write') || privileges.includes('write-content'),
        canDelete: privileges.includes('all') || privileges.includes('write') || privileges.includes('unbind'),
        canCreate: privileges.includes('all') || privileges.includes('write') || privileges.includes('bind'),
        events: !components.length || components.includes('VEVENT') };
    }).filter(row => row.events);
    check(calendars.length <= 200, 'calendar_limit_exceeded');
    return calendars;
  }
  async events(calendar, from, to) {
    const range = interval(from, to);
    const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const response = await this.request('REPORT', calendar.url, { body, headers: { Depth: '1' } });
    check(response.status === 207, 'multistatus_required');
    const rows = multistatus(response.text, calendar.url);
    check(rows.length <= 1000, 'event_limit_exceeded');
    return rows.map(row => {
      check(row.url.startsWith(calendar.url) && row.url !== calendar.url && !row.status, 'event_scope_invalid');
      const data = property(row.props, 'calendar-data');
      check(data && property(row.props, 'getetag'), 'event_data_missing');
      return { id: hash(row.url).slice(0, 32), url: row.url, data, etag: property(row.props, 'getetag'), calendarId: calendar.id };
    });
  }
  async get(url) { return this.request('GET', url, { allowMissing: true }); }
}
