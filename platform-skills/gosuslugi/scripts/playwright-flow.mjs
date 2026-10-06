import { authOrigin, requireThat, RuntimeError } from './core.mjs';
import { entryUrl, serviceUrl } from './esia-flow.mjs';

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
    this.postReturnRequests = new WeakSet();
    this.returnCommitted = false;
    this.roleReturnRequests = new WeakSet();
    this.roleReturnAccepted = false;
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
    try { action(); } catch (error) {
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
    const record = { page, eligible: page === this.original ? true : null, events: [], navigation: null };
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
          const postCallbackSeen = this.flow.postCallbackSeen;
          const target = new URL(url), callback = this.flow.binding?.callback;
          // A relying party may keep its own routing `state` on the cabinet
          // URL after an accepted ESIA callback. That is not a second OAuth
          // reply. Only the actual HTTP redirect chain of that callback may
          // continue this way: a new navigation, the callback itself, tokens,
          // a code/error, a fragment or POST still goes through the full guard.
          // This exception creates no new proof; completion still needs the
          // exact same request chain's successful service document commit.
          const routingReturn = this.flow.callbackAccepted &&
            this.returnRequests.has(request.redirectedFrom()) &&
            serviceUrl(url, this.flow.service) && callback &&
            (target.origin !== callback.origin || target.pathname !== callback.pathname) &&
            request.method() === 'GET' && !target.hash &&
            target.searchParams.getAll('state').length === 1 &&
            !['code', 'error', 'access_token', 'id_token'].some(name => target.searchParams.has(name));
          if (!routingReturn) this.flow.observeNavigation(url, request.method());
          if (!callbackSeen && this.flow.callbackSeen) this.returnRequests.add(request);
          if (!postCallbackSeen && this.flow.postCallbackSeen) this.postReturnRequests.add(request);
        }
      } else return;
      if (this.active === record && authOrigin(url) && request.method() === 'POST') this.postCount++;
      if (navigation) {
        if (request.redirectedFrom() && this.returnRequests.has(request.redirectedFrom())) this.returnRequests.add(request);
        if (request.redirectedFrom() && this.postReturnRequests.has(request.redirectedFrom())) this.postReturnRequests.add(request);
        if (request.redirectedFrom() && this.roleReturnRequests.has(request.redirectedFrom()))
          this.roleReturnRequests.add(request);
        // A verified callback can redirect to the official role chooser.
        // Its later personal-card click starts a new navigation rather than
        // another HTTP redirect, so retain that exact continuation separately.
        if (this.roleChoiceRecord === record && serviceUrl(url, this.flow.service))
          this.roleReturnRequests.add(request);
        record.navigation = request;
      }
    } else if (event.kind === 'response') {
      if (this.active !== record && (this.active || record.page !== this.original)) return;
      this.flow.observeResponse(event.url, event.status);
      if (this.flow.error) throw new RuntimeError(this.flow.error, this.flow.httpFailure);
      if (this.roleReturnRequests.has(event.request) && serviceUrl(event.url, this.flow.service) &&
        event.status >= 200 && event.status < 400) this.roleReturnAccepted = true;
    } else if (event.kind === 'commit') {
      // Post ID may commit a consent page after ESIA and only later resume its
      // own callback. That intermediate document is not the relying party's
      // completed login. Require the outer callback's exact request/redirect
      // chain, including when consent has broken the inner HTTP redirect chain.
      const returnRequests = this.flow.postBinding ? this.postReturnRequests : this.returnRequests;
      if (this.active === record && record.navigation && returnRequests.has(record.navigation) &&
        record.navigation.url() === event.url && serviceUrl(event.url, this.flow.service)) this.returnCommitted = true;
      if (!this.flow.postBinding && this.active === record && record.navigation && this.roleReturnRequests.has(record.navigation) &&
        this.roleReturnAccepted && record.navigation.url() === event.url &&
        serviceUrl(event.url, this.flow.service)) this.returnCommitted = true;
      if (this.active && this.active.page !== this.original && record.page === this.original)
        requireThat((this.flow.callbackSeen ? serviceUrl : entryUrl)(event.url, this.flow.service),
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
    return !this.original.isClosed() && this.returnCommitted && this.flow.hasAuthenticatedReturn;
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
