import { authOrigin, requireThat, RuntimeError } from './core.mjs';
import { entryUrl, externalUrl } from './esia-flow.mjs';

/**
 * Observe one OAuth transaction in the original page or its new direct popup.
 * Context events are essential: Page's popup event arrives after the popup's
 * first request. No URL is reconstructed and no page/network route is changed.
 * All request objects and OAuth values stay in caller RAM, never in a result.
 */
export class PlaywrightAuthorizationFlow {
  constructor(page, flow, { onBinding, onError }) {
    this.original = page;
    this.context = page.context();
    this.flow = flow;
    this.onBinding = onBinding;
    this.onError = onError;
    this.existing = new Set(this.context.pages());
    this.records = new Map();
    this.unassigned = [];
    this.active = null;
    this.closed = false;
    this.postCount = 0;
    this.returnRequests = new WeakSet();
    this.returnResponses = new WeakMap();
    this.serviceResponse = null;
    this.returnCommitted = false;
    this.roleReturnRequests = new WeakSet();
    this.roleChoiceRecord = null;
    this.onRequest = request => this.observeRequest(request);
    this.onResponse = response => this.observeResponse(response);
    this.onPage = created => {
      this.guard(() => {
        this.record(created);
        // An early navigation can have a Frame before Playwright connects it
        // to a Page. Retry that exact Request after Page creation, not a guessed
        // URL match. Page's initial URL is itself an observed document commit.
        this.flushUnassigned();
        this.deliver(created, { kind: 'commit', url: created.url() });
      });
    };
    this.record(page);
    this.context.on('request', this.onRequest);
    this.context.on('response', this.onResponse);
    this.context.on('page', this.onPage);
  }

  guard(action) {
    if (this.closed) return;
    try {
      action();
      // The helper's scope ends at the first verified non-ESIA document return.
      // Freeze the proof and remove listeners immediately, even if the native
      // authorizer has not claimed/completed yet. Later site-owned OAuth, JS
      // routing, errors or popup closure must not turn ESIA success into a
      // provider failure. No further secret input is possible after callback.
      if (this.returned) this.close();
    } catch (error) {
      const safe = error instanceof RuntimeError ? error : new RuntimeError('authorization_result_unknown');
      this.flow.error ||= safe.code;
      this.close();
      this.onError(safe);
    }
  }

  record(page) {
    if (this.records.has(page)) return this.records.get(page);
    if (page !== this.original && (this.existing.has(page) || page.context() !== this.context)) return null;
    requireThat(this.records.size < 32, 'authorization_pages_exceeded');
    const record = { page, eligible: page === this.original ? true : null, events: [], navigation: null, committed: null };
    record.onCommit = frame => {
      if (frame === page.mainFrame()) this.guard(() => this.deliver(page, { kind: 'commit', url: frame.url() }));
    };
    record.onClose = () => this.guard(() => this.deliver(page, { kind: 'close' }));
    this.records.set(page, record);
    page.on('framenavigated', record.onCommit);
    page.on('close', record.onClose);
    if (record.eligible === null) {
      // Establish opener identity once, before any bound request can publish a
      // capability. Existing tabs, unrelated popups and descendants cannot be
      // adopted. Buffer early request/response/commit/close events in order so
      // even a fast SSO popup may return and close while opener() is pending.
      Promise.resolve().then(() => page.opener()).then(opener => this.guard(() => {
        record.eligible = opener === this.original && !this.original.isClosed();
        const events = record.events; record.events = [];
        if (record.eligible) for (const event of events) this.process(record, event);
      }), () => this.guard(() => { record.eligible = false; record.events = []; }));
    }
    return record;
  }

  deliver(page, event) {
    const record = this.record(page);
    if (!record || record.eligible === false || this.closed) return;
    if (record.eligible === null) {
      requireThat(record.events.length < 128, 'authorization_events_exceeded');
      record.events.push(event);
    } else this.process(record, event);
  }

  requestPage(request) {
    try {
      const frame = request.frame(), page = frame.page();
      return frame === page.mainFrame() ? page : false;
    } catch { return null; }
  }

  routeEvent(request, event) {
    const page = this.requestPage(request);
    if (page) this.deliver(page, event);
    else if (page === null && request.isNavigationRequest() && !request.serviceWorker()) {
      // Bound the private queue, including a browser that never produces a
      // Page. A missing frame is never permission to bind by URL/origin alone.
      requireThat(this.unassigned.length < 128, 'authorization_events_exceeded');
      this.unassigned.push({ request, event });
    }
  }

  flushUnassigned() {
    const events = this.unassigned; this.unassigned = [];
    for (const { request, event } of events) this.routeEvent(request, event);
  }

  observeRequest(request) {
    this.guard(() => {
      if (!request.isNavigationRequest() && !(authOrigin(request.url()) && request.method() === 'POST')) return;
      this.flushUnassigned();
      this.routeEvent(request, { kind: 'request', request });
    });
  }

  observeResponse(response) {
    this.guard(() => {
      const request = response.request();
      if (!request.isNavigationRequest()) return;
      this.flushUnassigned();
      this.routeEvent(request, { kind: 'response', request, url: response.url(), status: response.status() });
    });
  }

  process(record, event) {
    if (this.closed) return;
    // Buffered popup events can be delivered in one guard after opener proof.
    // Stop at the verified return inside that batch as well as between events.
    if (this.returned) { this.close(); return; }
    if (event.kind === 'request') {
      const { request } = event;
      const url = request.url(), navigation = request.isNavigationRequest();
      const oauth = navigation && authOrigin(url) && new URL(url).searchParams.has('redirect_uri');
      if (oauth) {
        requireThat(!this.active || this.active === record, 'authorization_page_changed');
        requireThat(!this.original.isClosed() &&
          (record.page === this.original || entryUrl(this.original.url(), this.flow.service)), 'authorization_target_mismatch');
        this.flow.observeNavigation(url, request.method());
        this.active = record;
        this.onBinding();
      } else if (this.active === record || !this.active && record.page === this.original) {
        if (navigation) {
          const callbackSeen = this.flow.callbackSeen;
          const target = new URL(url), callback = this.flow.binding?.callback;
          // ESIA's callback and a site's subsequent redirects are different
          // protocol steps. Once that exact callback has succeeded, the site's
          // server may issue its own token/routing query on another path. The
          // Request object's HTTP ancestry proves where this URL came from;
          // names such as access_token or state do not make it a new ESIA reply.
          // No provider-specific host/path/query list is needed. The actual
          // ESIA callback still passes the full guard, as do a new ESIA request
          // and an unrelated navigation. The site's outer OAuth/SSO flow is
          // caller-owned; it is not another transaction for this helper.
          const returnTarget = this.flow.callbackAccepted &&
            externalUrl(url) && callback &&
            (target.origin !== callback.origin || target.pathname !== callback.pathname) &&
            request.method() === 'GET';
          const serviceRedirect = returnTarget && this.returnRequests.has(request.redirectedFrom());
          if (serviceRedirect) {
            // These values never leave private caller RAM. Remember them for
            // the existing redactor without logging or exporting a return URL.
            for (const name of ['code', 'state', 'error_description', 'access_token', 'id_token'])
              for (const value of target.searchParams.getAll(name)) this.flow.remember(value);
          }
          if (!serviceRedirect) this.flow.observeNavigation(url, request.method());
          if (!callbackSeen && this.flow.callbackSeen) this.returnRequests.add(request);
        }
      } else return;
      if (this.active === record && authOrigin(url) && request.method() === 'POST') this.postCount++;
      if (navigation) {
        if (request.redirectedFrom() && this.returnRequests.has(request.redirectedFrom())) this.returnRequests.add(request);
        if (request.redirectedFrom() && this.roleReturnRequests.has(request.redirectedFrom()))
          this.roleReturnRequests.add(request);
        // A verified callback can redirect to the official role chooser.
        // Its later personal-card click starts a new navigation rather than
        // another HTTP redirect, so retain that exact continuation separately.
        if (this.roleChoiceRecord === record && externalUrl(url))
          this.roleReturnRequests.add(request);
        record.navigation = request;
      }
    } else if (event.kind === 'response') {
      if (this.active !== record && (this.active || record.page !== this.original)) return;
      this.flow.observeResponse(event.url, event.status);
      if (this.flow.error) throw new RuntimeError(this.flow.error, this.flow.httpFailure);
      if (externalUrl(event.url) && Number.isInteger(event.status) && event.status >= 200 && event.status <= 599) {
        // The external site's HTTP error is evidence for the caller. It does
        // not turn a verified ESIA response into a provider refusal or permit
        // replay. Retain it by exact Request object until that document commits.
        this.returnResponses.set(event.request, { httpStatus: event.status, httpOrigin: new URL(event.url).origin });
        if (record.committed === event.request) this.serviceResponse = this.returnResponses.get(event.request);
      }
    } else if (event.kind === 'commit') {
      // A fragment belongs to the site's document, not to its HTTP Request.
      // Strip only that fragment for the exact request/commit comparison; the
      // callback itself still rejects fragments under the OAuth guard.
      // A newly published popup can still have an empty URL or about:blank
      // while its initial request is buffered. Such a placeholder supplies no
      // document proof and must not fail URL parsing before opener resolution.
      if (this.active === record && record.navigation && externalUrl(event.url)) {
        const committed = new URL(event.url); committed.hash = '';
        if (record.navigation.url() === committed.href &&
          (this.returnRequests.has(record.navigation) || this.roleReturnRequests.has(record.navigation))) {
          this.returnCommitted = true;
          record.committed = record.navigation;
          this.serviceResponse = this.returnResponses.get(record.navigation) ?? null;
        }
      }
      if (this.active && this.active.page !== this.original && record.page === this.original)
        requireThat(this.flow.callbackSeen ? externalUrl(event.url) : entryUrl(event.url, this.flow.service),
          'authorization_target_mismatch');
    } else if (event.kind === 'close') {
      if (record.page === this.original) throw new RuntimeError('browser_closed');
      // A popup may execute its own postMessage + window.close immediately.
      // Preserve the verified callback document proof, but never treat closing
      // or an opener message alone as success or repeat the original action.
      if (record === this.active) requireThat(this.returned, 'authorization_popup_closed');
    }
  }

  get page() { return this.active?.page ?? this.original; }
  markPersonalRoleChoice() {
    // Called only by the broker immediately before its bounded official card
    // click. It never accepts a new OAuth binding or treats the click as login.
    requireThat(!this.closed && this.active && this.flow.callbackAccepted &&
      !this.returned && new URL(this.active.page.url()).origin === 'https://roles.gosuslugi.ru',
    'role_chooser_required');
    this.roleChoiceRecord = this.active;
  }
  get returned() {
    return !this.original.isClosed() && this.returnCommitted && this.serviceResponse !== null && this.flow.hasAuthenticatedReturn;
  }

  close() {
    this.closed = true;
    this.context.off('request', this.onRequest);
    this.context.off('response', this.onResponse);
    this.context.off('page', this.onPage);
    for (const record of this.records.values()) {
      record.page.off('framenavigated', record.onCommit);
      record.page.off('close', record.onClose);
      record.events = [];
    }
    this.records.clear(); this.unassigned = []; this.existing.clear();
    // Caller keeps every page; removing listeners never destroys its draft.
  }
}
