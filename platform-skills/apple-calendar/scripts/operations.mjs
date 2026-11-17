import crypto from 'node:crypto';
import { CalDAV } from './caldav.mjs';
import { createEvent, mutateEvent, fingerprint, occurrences, freeWindows, parse } from './events.mjs';
import { check, hash, scope, stable, object, interval, Fault } from './core.mjs';

export class CalendarOperations {
  constructor(store, { makeClient = value => new CalDAV(value), clock = Date.now } = {}) {
    this.store = store; this.makeClient = makeClient; this.clock = clock;
  }
  async context() {
    const state = await this.store.read();
    check(state.credentials, 'setup_required');
    const client = this.makeClient(state.credentials);
    const all = await client.calendars();
    const calendars = all.filter(calendar => state.preferences.calendars.includes(calendar.id));
    check(calendars.length === state.preferences.calendars.length && calendars.length > 0, 'selected_calendar_unavailable');
    return { state, client, calendars };
  }
  async calendars() {
    const { calendars } = await this.context();
    return calendars.map(({ id, name, writable, canCreate, canDelete }) => ({ id, name, writable, canCreate, canDelete }));
  }
  async list({ from, to, calendarId, query, minutes }) {
    interval(from, to);
    const { state, client, calendars } = await this.context();
    const chosen = calendarId ? calendars.filter(calendar => calendar.id === calendarId) : calendars;
    check(chosen.length > 0, 'calendar_not_selected');
    const result = [], budget = { count: 0 };
    state.references ||= {};
    for (const calendar of chosen) {
      for (const resource of await client.events(calendar, from, to)) {
        state.references[resource.id] = { url: resource.url, calendarId: calendar.id };
        check(Object.keys(state.references).length <= 10000, 'reference_limit_exceeded');
        result.push(...occurrences(resource, from, to, state.preferences.timezone, budget));
        check(result.length <= 2000, 'occurrence_limit_exceeded');
      }
    }
    await this.store.write(state);
    result.sort((left,right) => left.start.localeCompare(right.start));
    if (minutes !== undefined) return { complete: true, calendars: chosen.map(calendar => calendar.id),
      windows: freeWindows(result, from, to, Number(minutes)) };
    const events = query ? result.filter(event => `${event.title}\n${event.description}\n${event.location}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : result;
    return { complete: true, events };
  }
  async resolve(context, spec) {
    const calendar = context.calendars.find(value => value.id === spec.calendarId);
    check(calendar, 'calendar_not_selected');
    const reference = context.state.references?.[spec.eventId];
    check(reference && reference.calendarId === calendar.id && reference.url.startsWith(calendar.url), 'event_reference_required');
    const resource = await context.client.get(reference.url);
    check(!resource.missing && resource.etag, 'event_missing_or_unversioned');
    parse(resource.text);
    return { calendar, resource, url: reference.url };
  }
  async read(spec) {
    const context = await this.context();
    const { resource } = await this.resolve(context, spec);
    return { eventId: spec.eventId, calendarId: spec.calendarId, etag: resource.etag, icalendar: resource.text };
  }
  async plan(spec) {
    object(spec, ['action','calendarId','eventId','scope','recurrenceId','changes','response']);
    check(['create','update','delete','reply'].includes(spec.action), 'action_invalid');
    // Closed per-action shapes prevent a reviewed field from being silently
    // ignored (for example a series scope accidentally supplied to create).
    if (spec.action === 'create') check(!['eventId','scope','recurrenceId','response'].some(key => key in spec), 'action_fields_invalid');
    else {
      check(['series','occurrence'].includes(spec.scope), 'event_scope_required');
      check(spec.scope === 'occurrence' || spec.recurrenceId === undefined, 'action_fields_invalid');
      check(spec.action === 'update' || spec.changes === undefined, 'action_fields_invalid');
      check(spec.action === 'reply' || spec.response === undefined, 'action_fields_invalid');
      check(spec.scope !== 'occurrence' || spec.changes?.recurrence === undefined, 'occurrence_recurrence_invalid');
    }
    const context = await this.context();
    const { state, client, calendars } = context;
    check(!Object.values(state.operations).some(operation => operation.state === 'unknown'), 'unknown_write_pending');
    const calendar = calendars.find(value => value.id === spec.calendarId);
    check(calendar, 'calendar_not_selected');
    let before = null, after = null, method = 'PUT', url, etag = null, scheduleTag = null;
    if (spec.action === 'create') {
      check(calendar.canCreate && calendar.writable, 'calendar_read_only');
      after = createEvent(spec.changes, state.preferences.timezone, client.addresses?.[0]);
      const uid = parse(after).getFirstSubcomponent('vevent').getFirstPropertyValue('uid');
      url = new URL(`${uid}.ics`, calendar.url).href;
    } else {
      check(calendar.writable, 'calendar_read_only');
      const resolved = await this.resolve(context, spec);
      before = resolved.resource.text;
      etag = resolved.resource.etag;
      scheduleTag = resolved.resource.scheduleTag;
      url = resolved.url;
      if (spec.action === 'delete' && spec.scope === 'series') {
        check(calendar.canDelete, 'calendar_read_only');
        // Validate organizer authority even for DELETE, which causes server
        // cancellation notices for invitations just as a scheduling PUT does.
        mutateEvent(before, { ...spec, action: 'update', changes: {} }, state.preferences.timezone, client.addresses || []);
        method = 'DELETE';
      } else after = mutateEvent(before, spec, state.preferences.timezone, client.addresses || []);
    }
    const plan = { id: crypto.randomUUID(), scope: scope(this.store.owner), created: this.clock(),
      expires: this.clock() + 15 * 60000, calendarId: calendar.id, spec, url, method, before, after, etag, scheduleTag };
    plan.hash = hash(stable(plan));
    // Plans contain calendar content and therefore live in the same encrypted
    // vault as credentials. Bound retention before any external write exists.
    for (const [id,value] of Object.entries(state.plans)) if (value.expires < this.clock()) delete state.plans[id];
    check(Object.keys(state.plans).length < 10, 'pending_plan_limit');
    state.plans[plan.id] = plan;
    await this.store.write(state);
    return { planId: plan.id, planHash: plan.hash, expiresAt: new Date(plan.expires).toISOString(),
      action: spec.action, calendar: { id: calendar.id, name: calendar.name }, scope: spec.scope || null,
      before, after, attendeesMayBeNotified: /\r?\nATTENDEE[;:]/i.test(after || before || '') };
  }
  async apply(id, digest) {
    const context = await this.context();
    const { state, client, calendars } = context;
    const plan = state.plans[id];
    check(plan && plan.hash === digest && plan.scope === scope(this.store.owner), 'plan_invalid');
    check(!state.operations[id], 'operation_already_dispatched');
    check(!Object.values(state.operations).some(operation => operation.state === 'unknown'), 'unknown_write_pending');
    check(plan.expires >= this.clock(), 'plan_expired');
    const calendar = calendars.find(value => value.id === plan.calendarId);
    check(calendar?.writable && (plan.before ? plan.method !== 'DELETE' || calendar.canDelete : calendar.canCreate), 'calendar_read_only');
    const current = await client.get(plan.url);
    if (plan.before) check(!current.missing && current.etag === plan.etag && fingerprint(current.text) === fingerprint(plan.before), 'calendar_changed');
    else check(current.missing, 'event_already_exists');
    // Persist the unknown fence before dispatch. A crash, cancellation, 5xx or
    // lost response cannot authorize another PUT/DELETE in another process.
    state.operations[id] = { state: 'unknown', plan, dispatched: this.clock(), scope: plan.scope };
    await this.store.write(state);
    try {
      await client.request(plan.method, plan.url, { ...(plan.after ? { body: plan.after } : {}), headers: {
        ...(plan.before ? { 'If-Match': plan.etag } : { 'If-None-Match': '*' }),
        ...(plan.scheduleTag ? { 'If-Schedule-Tag-Match': plan.scheduleTag } : {}) } });
    } catch (error) {
      // A definite precondition/auth rejection is recorded, but this operation
      // is still consumed. The user can review a fresh plan after resolving it.
      if (['calendar_changed','calendar_access_denied','needs_reconnect'].includes(error.code)) {
        state.operations[id].state = 'rejected';
        state.operations[id].code = error.code;
        await this.store.write(state);
      }
      throw error;
    }
    return this.reconcile(id);
  }
  async reconcile(id) {
    const { state, client } = await this.context();
    const operation = state.operations[id];
    check(operation && operation.scope === scope(this.store.owner), 'operation_missing');
    if (operation.state !== 'unknown') return { operationId: id, state: operation.state, code: operation.code };
    const current = await client.get(operation.plan.url);
    const verified = operation.plan.method === 'DELETE' ? current.missing
      : !current.missing && fingerprint(current.text) === fingerprint(operation.plan.after);
    if (!verified) return { operationId: id, state: 'unknown', requiredAction: 'Inspect this exact event and reconcile without repeating the write' };
    const eventId = hash(operation.plan.url).slice(0,32);
    operation.state = 'verified';
    operation.eventId = eventId;
    operation.verified = this.clock();
    state.references ||= {};
    if (!current.missing) state.references[hash(operation.plan.url).slice(0,32)] = { url: operation.plan.url, calendarId: operation.plan.calendarId };
    delete state.plans[id];
    // Completed receipts retain identity and outcome, not an unbounded second
    // calendar archive. Unknown operations always retain their exact evidence.
    delete operation.plan;
    const terminal = Object.entries(state.operations).filter(([,value]) => value.state !== 'unknown');
    for (const [old] of terminal.slice(0, Math.max(0, terminal.length - 100))) delete state.operations[old];
    await this.store.write(state);
    return { operationId: id, state: 'verified', eventId };
  }
}
