import ICAL from '../.build/ical.mjs';
import { Temporal } from '../.build/temporal.mjs';
import crypto from 'node:crypto';
import { check, Fault, object, text, timezone, interval, stable } from './core.mjs';

const zoneCache = new Map();
function ensureTimezones(calendar) {
  // CalDAV requires definitions for TZID references. Build VTIMEZONE from the
  // same current ICU/IANA rules used by Temporal, rather than shipping an old
  // Olson snapshot or asking a server to guess an undefined timezone. The
  // supported 1900..2099 interval is explicit; beyond it no read/write is claimed.
  const zones = new Set(calendar.getAllSubcomponents('vevent').flatMap(event =>
    ['dtstart','dtend','recurrence-id'].map(name => event.getFirstProperty(name)?.getParameter('tzid')).filter(Boolean)));
  for (const zone of zones) {
    if (calendar.getAllSubcomponents('vtimezone').some(value => value.getFirstPropertyValue('tzid') === zone)) continue;
    if (!zoneCache.has(zone)) {
      const component = new ICAL.Component('vtimezone');
      component.addPropertyWithValue('tzid', zone);
      let cursor = Temporal.Instant.from('1900-01-01T00:00:00Z').toZonedDateTimeISO(zone);
      const groups = new Map();
      const offsetText = nanoseconds => {
        const seconds = Math.abs(nanoseconds / 1e9);
        const pad = number => String(Math.floor(number)).padStart(2, '0');
        return `${nanoseconds < 0 ? '-' : '+'}${pad(seconds / 3600)}:${pad(seconds % 3600 / 60)}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`;
      };
      const add = (instant, from, to) => {
        const key = `${from}/${to}`;
        const local = new Date(Number(instant.epochMilliseconds) + from / 1e6).toISOString().slice(0,19);
        if (!groups.has(key)) {
          const observation = new ICAL.Component(to > from ? 'daylight' : 'standard');
          observation.addPropertyWithValue('dtstart', ICAL.Time.fromString(local));
          observation.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromString(offsetText(from)));
          observation.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromString(offsetText(to)));
          component.addSubcomponent(observation); groups.set(key, observation);
        } else groups.get(key).addPropertyWithValue('rdate', ICAL.Time.fromString(local));
      };
      add(cursor.toInstant(), cursor.offsetNanoseconds, cursor.offsetNanoseconds);
      for (let count = 0; ; count++) {
        check(count < 1000, 'timezone_transition_limit');
        const next = cursor.getTimeZoneTransition('next');
        if (!next || next.year >= 2101) break;
        add(next.toInstant(), cursor.offsetNanoseconds, next.offsetNanoseconds);
        cursor = next;
      }
      zoneCache.set(zone, component.toJSON());
      check(zoneCache.size <= 200, 'timezone_limit');
    }
    calendar.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(zoneCache.get(zone)))));
  }
}

export function parse(data) {
  check(typeof data === 'string' && Buffer.byteLength(data) <= 1024 * 1024, 'event_too_large');
  let calendar;
  try { calendar = new ICAL.Component(ICAL.parse(data)); }
  catch { throw new Fault('calendar_data_invalid'); }
  check(calendar.name === 'vcalendar', 'calendar_data_invalid');
  const components = calendar.getAllSubcomponents('vevent');
  check(components.length > 0 && components.length <= 1000, 'event_components_invalid');
  const uid = components[0].getFirstPropertyValue('uid');
  check(typeof uid === 'string' && uid.length > 0 && components.every(event => event.getFirstPropertyValue('uid') === uid), 'event_uid_invalid');
  return calendar;
}
function zoneOf(component, field, fallback) {
  const property = component.getFirstProperty(field);
  return property?.getParameter('tzid') || (property?.getFirstValue()?.zone?.tzid === 'UTC' ? 'UTC' : fallback);
}
export function epoch(time, zone) {
  if (!time.isDate && time.zone?.tzid && !['floating', 'local'].includes(time.zone.tzid)) {
    return time.toUnixTime() * 1000;
  }
  const fields = { timeZone: timezone(zone), year: time.year, month: time.month, day: time.day,
    hour: time.isDate ? 0 : time.hour, minute: time.isDate ? 0 : time.minute, second: time.isDate ? 0 : time.second };
  try { return Number(Temporal.ZonedDateTime.from(fields, { disambiguation: 'compatible' }).epochMilliseconds); }
  catch { throw new Fault('event_time_invalid'); }
}
const idOf = component => component.getFirstPropertyValue('recurrence-id')?.toString() || null;
function summary(component) {
  return { uid: component.getFirstPropertyValue('uid'), title: component.getFirstPropertyValue('summary') || '',
    description: component.getFirstPropertyValue('description') || '', location: component.getFirstPropertyValue('location') || '',
    url: component.getFirstPropertyValue('url') || '', status: component.getFirstPropertyValue('status') || 'CONFIRMED',
    transparency: component.getFirstPropertyValue('transp') || 'OPAQUE',
    organizer: component.getFirstPropertyValue('organizer') || null,
    attendees: component.getAllProperties('attendee').map(property => ({ address: property.getFirstValue(),
      name: property.getParameter('cn') || '', status: property.getParameter('partstat') || 'NEEDS-ACTION' })),
    alarms: component.getAllSubcomponents('valarm').map(alarm => ({ action: alarm.getFirstPropertyValue('action'),
      trigger: alarm.getFirstPropertyValue('trigger')?.toString() })) };
}

export function occurrences(resource, from, to, fallback = 'Europe/Moscow', budget = { count: 0 }) {
  const range = interval(from, to);
  check(range.start >= Date.UTC(1900,0,1) && range.end <= Date.UTC(2100,0,1), 'supported_date_range_exceeded');
  const calendar = parse(resource.data);
  const components = calendar.getAllSubcomponents('vevent');
  const masters = components.filter(component => !idOf(component));
  check(masters.length <= 1, 'multiple_master_events');
  const master = masters[0];
  const results = [];
  const emitted = new Set();
  function append(component, start, end, recurrenceId) {
    if (String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    const zone = zoneOf(component, 'dtstart', fallback);
    const begin = epoch(start, zone), finish = epoch(end, zoneOf(component, 'dtend', zone));
    check(finish >= begin, 'event_duration_invalid');
    if (begin >= range.end || finish <= range.start && (finish !== begin || begin < range.start)) return;
    results.push({ ...summary(component), id: resource.id, calendarId: resource.calendarId, etag: resource.etag,
      recurrenceId, start: new Date(begin).toISOString(), end: new Date(finish).toISOString(),
      timezone: zone, allDay: start.isDate, recurring: Boolean(master && new ICAL.Event(master).isRecurring()) });
    check(results.length <= 2000, 'occurrence_limit_exceeded');
  }
  if (master) {
    // ICAL's iterator preserves RRULE/RDATE/EXDATE and RANGE=THISANDFUTURE.
    // Conversion to instants happens per occurrence, so DST changes never turn
    // a weekly 09:00 meeting into a fixed UTC-hour meeting.
    const event = new ICAL.Event(master, { exceptions: components.filter(component => idOf(component)) });
    const iterator = event.iterator();
    for (;;) {
      const next = iterator.next();
      if (!next) break;
      check(++budget.count <= 100000, 'recurrence_expansion_limit');
      const current = epoch(next, zoneOf(master, 'dtstart', fallback));
      if (current >= range.end) break;
      const details = event.getOccurrenceDetails(next);
      const component = details.item.component;
      const recurrenceId = event.isRecurring() || component !== master ? next.toString() : null;
      emitted.add(idOf(component));
      append(component, details.startDate, details.endDate, recurrenceId);
      if (!event.isRecurring()) break;
    }
  }
  // An exception can be moved into this window from an original occurrence
  // outside it. REPORT returns the resource, and this pass retains that event.
  for (const component of components.filter(value => idOf(value) && !emitted.has(idOf(value)))) {
    const event = new ICAL.Event(component);
    append(component, event.startDate, event.endDate, idOf(component));
  }
  return results;
}

function setDate(component, name, value, zone, allDay) {
  text(value, 80);
  check(/^(?:19|20)\d{2}-/.test(value), 'supported_date_range_exceeded');
  let local;
  try {
    if (allDay) {
      check(/^\d{4}-\d{2}-\d{2}$/.test(value), 'all_day_date_required');
      local = Temporal.PlainDate.from(value).toString();
    }
    else {
      const absolute = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
      const zoned = absolute ? Temporal.Instant.from(value).toZonedDateTimeISO(zone)
        : Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: 'reject' });
      local = zoned.toPlainDateTime().toString({ smallestUnit: 'second' });
    }
  } catch { throw new Fault('event_time_invalid_or_ambiguous'); }
  component.removeAllProperties(name);
  const property = new ICAL.Property(name);
  property.setValue(ICAL.Time.fromString(local));
  if (!allDay) property.setParameter('tzid', zone);
  component.addProperty(property);
}
function setText(component, name, value) {
  component.updatePropertyWithValue(name, text(value));
}
const EDIT_FIELDS = ['title', 'description', 'location', 'url', 'start', 'end', 'timezone', 'allDay',
  'recurrence', 'attendees', 'alarms', 'transparency', 'status'];

export function editFields(component, changes, defaultZone) {
  object(changes, EDIT_FIELDS);
  const zone = timezone(changes.timezone || zoneOf(component, 'dtstart', defaultZone));
  const allDay = changes.allDay ?? Boolean(component.getFirstPropertyValue('dtstart')?.isDate);
  check(typeof allDay === 'boolean', 'all_day_invalid');
  if (changes.timezone !== undefined || changes.allDay !== undefined) {
    check(changes.start !== undefined && changes.end !== undefined, 'date_pair_required');
  }
  for (const [field, property] of [['title','summary'],['description','description'],['location','location'],['url','url']]) {
    if (changes[field] !== undefined) setText(component, property, changes[field]);
  }
  if (changes.url) {
    let value;
    try { value = new URL(changes.url); } catch { throw new Fault('event_url_invalid'); }
    check(['https:', 'http:'].includes(value.protocol) && !value.username && !value.password, 'event_url_invalid');
  }
  for (const [field, property] of [['start','dtstart'],['end','dtend']]) {
    if (changes[field] !== undefined) setDate(component, property, changes[field], zone, allDay);
  }
  if (changes.end !== undefined) component.removeAllProperties('duration');
  const event = new ICAL.Event(component);
  check(event.startDate && epoch(event.endDate, zone) > epoch(event.startDate, zone), 'event_duration_invalid');
  if (changes.recurrence !== undefined) {
    for (const name of ['rrule', 'rdate', 'exdate']) component.removeAllProperties(name);
    if (changes.recurrence !== null) {
      const value = text(changes.recurrence, 1000);
      check(!/[\n\r]/.test(value), 'recurrence_invalid');
      try { component.addPropertyWithValue('rrule', ICAL.Recur.fromString(value)); }
      catch { throw new Fault('recurrence_invalid'); }
    }
  }
  if (changes.attendees !== undefined) {
    check(Array.isArray(changes.attendees) && changes.attendees.length <= 100, 'attendees_invalid');
    component.removeAllProperties('attendee');
    const seen = new Set();
    for (const attendee of changes.attendees) {
      object(attendee, ['email', 'name']);
      check(typeof attendee.email === 'string' && /^[^\s@:\r\n]+@[^\s@:\r\n]+\.[^\s@:\r\n]+$/.test(attendee.email) &&
        !seen.has(attendee.email.toLowerCase()), 'attendee_invalid');
      seen.add(attendee.email.toLowerCase());
      const property = new ICAL.Property('attendee');
      property.setValue(`mailto:${attendee.email}`);
      property.setParameter('partstat', 'NEEDS-ACTION');
      property.setParameter('rsvp', 'TRUE');
      if (attendee.name) property.setParameter('cn', text(attendee.name, 200));
      component.addProperty(property);
    }
  }
  if (changes.alarms !== undefined) {
    check(Array.isArray(changes.alarms) && changes.alarms.length <= 5, 'alarms_invalid');
    component.removeAllSubcomponents('valarm');
    for (const minutes of changes.alarms) {
      check(Number.isInteger(minutes) && minutes >= 0 && minutes <= 40320, 'alarm_invalid');
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', component.getFirstPropertyValue('summary') || 'Event');
      alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60));
      component.addSubcomponent(alarm);
    }
  }
  for (const [field, property, allowed] of [['status','status',['CONFIRMED','TENTATIVE','CANCELLED']],
    ['transparency','transp',['OPAQUE','TRANSPARENT']]]) {
    if (changes[field] !== undefined) {
      check(allowed.includes(changes[field]), `${field}_invalid`);
      component.updatePropertyWithValue(property, changes[field]);
    }
  }
}

export function createEvent(changes, defaultZone, organizer) {
  check(changes.title && changes.start && changes.end, 'event_fields_required');
  const calendar = new ICAL.Component('vcalendar');
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//Trelio//Apple Calendar 1.0.1//EN');
  const event = new ICAL.Component('vevent');
  event.addPropertyWithValue('uid', crypto.randomUUID());
  calendar.addSubcomponent(event);
  editFields(event, changes, defaultZone);
  if (event.getAllProperties('attendee').length) {
    check(organizer, 'calendar_identity_missing');
    event.addPropertyWithValue('organizer', organizer);
  }
  stamp(event);
  ensureTimezones(calendar);
  return calendar.toString();
}
function stamp(component, advanceSequence = true) {
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  // SEQUENCE is the organizer's revision. An attendee's RSVP must keep that
  // revision, otherwise the reply can claim a meeting revision it never owned.
  if (advanceSequence) component.updatePropertyWithValue('sequence', Number(component.getFirstPropertyValue('sequence') || 0) + 1);
}
export function mutateEvent(data, spec, defaultZone, addresses) {
  const calendar = parse(data);
  const events = calendar.getAllSubcomponents('vevent');
  const master = events.find(value => !idOf(value));
  check(master, 'master_event_required');
  // A new RRULE cannot safely reinterpret existing detached exceptions. Keep
  // those explicit until a separate reviewed migration feature exists.
  check(spec.changes?.recurrence === undefined || events.length === 1, 'recurrence_has_exceptions');
  let target = master;
  const single = spec.scope === 'occurrence';
  check(['series', 'occurrence'].includes(spec.scope), 'event_scope_required');
  if (single) {
    text(spec.recurrenceId, 80);
    let recurrence;
    try { recurrence = ICAL.Time.fromString(spec.recurrenceId); } catch { throw new Fault('recurrence_id_invalid'); }
    // Match an actual original occurrence. A fabricated recurrence-id must not
    // silently create an unrelated event inside this resource.
    const event = new ICAL.Event(master);
    check(event.isRecurring(), 'event_not_recurring');
    let found = false;
    const iterator = event.iterator();
    for (let index = 0; index < 100000; index++) {
      const next = iterator.next();
      if (!next || next.compare(recurrence) > 0) break;
      if (next.toString() === recurrence.toString()) { found = true; break; }
    }
    check(found, 'occurrence_missing');
    target = events.find(value => idOf(value) === recurrence.toString());
    if (!target) {
      target = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
      for (const field of ['rrule','rdate','exdate']) target.removeAllProperties(field);
      target.addPropertyWithValue('recurrence-id', recurrence);
      const rid = target.getFirstProperty('recurrence-id');
      const tzid = master.getFirstProperty('dtstart').getParameter('tzid');
      if (tzid) rid.setParameter('tzid', tzid);
      const duration = new ICAL.Event(master).duration;
      const end = recurrence.clone(); end.addDuration(duration);
      target.removeAllProperties('duration');
      target.updatePropertyWithValue('dtstart', recurrence.clone());
      target.updatePropertyWithValue('dtend', end);
      if (tzid) for (const field of ['dtstart','dtend']) target.getFirstProperty(field).setParameter('tzid', tzid);
      calendar.addSubcomponent(target);
    }
  }
  const organizer = String(target.getFirstPropertyValue('organizer') || '').toLowerCase();
  if (spec.action === 'reply') {
    check(['ACCEPTED','DECLINED','TENTATIVE'].includes(spec.response), 'reply_invalid');
    const matching = target.getAllProperties('attendee').filter(property => addresses.includes(String(property.getFirstValue()).toLowerCase()));
    check(matching.length === 1 && organizer, 'attendee_identity_ambiguous');
    matching[0].setParameter('partstat', spec.response);
    matching[0].setParameter('rsvp', 'FALSE');
  } else {
    // CalDAV auto-scheduling may notify all attendees on any PUT. Only the
    // organizer may edit an invitation; attendees use the narrow reply action.
    check(!target.getAllProperties('attendee').length || organizer && addresses.includes(organizer), 'organizer_required');
    if (spec.action === 'delete' && single) target.updatePropertyWithValue('status', 'CANCELLED');
    else editFields(target, spec.changes || {}, defaultZone);
  }
  stamp(target, spec.action !== 'reply');
  ensureTimezones(calendar);
  return calendar.toString();
}

export function fingerprint(data) {
  // Server-added timestamps and product metadata do not invalidate a read-back.
  // RFC6638 SCHEDULE-STATUS is the server's transport/delivery annotation, not
  // an attendee's PARTSTAT or the requested event. Ignore only that exact
  // parameter; unknown Apple properties and all semantic values stay compared.
  const normalize = component => {
    const [name, properties, components] = component;
    const ignored = new Set(['dtstamp', 'last-modified', 'created', 'prodid']);
    return [name, properties.filter(property => !ignored.has(property[0])).map(property => {
      const parameters = { ...property[1] };
      delete parameters['schedule-status'];
      return [property[0], parameters, property[2], ...property.slice(3)];
    }).sort((a,b) => stable(a).localeCompare(stable(b))),
      components.map(normalize).sort((a,b) => stable(a).localeCompare(stable(b)))];
  };
  return stable(normalize(parse(data).toJSON()));
}
export function freeWindows(events, from, to, minutes) {
  const range = interval(from, to);
  check(Number.isInteger(minutes) && minutes > 0 && minutes <= 1440, 'duration_invalid');
  const busy = events.filter(event => event.transparency !== 'TRANSPARENT' && event.status !== 'CANCELLED')
    .map(event => [Math.max(range.start, Date.parse(event.start)), Math.min(range.end, Date.parse(event.end))])
    .filter(([start,end]) => end > start).sort((a,b) => a[0]-b[0]);
  let cursor = range.start;
  const free = [];
  for (const [start,end] of [...busy, [range.end,range.end]]) {
    if (start - cursor >= minutes * 60000) free.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
    cursor = Math.max(cursor, end);
  }
  return free;
}
