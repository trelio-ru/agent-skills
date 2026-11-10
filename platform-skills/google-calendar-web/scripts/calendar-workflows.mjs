/** Calendar recipes operate only the admitted rendered-text/input protocol.
 * No selectors, saved coordinates, DOM/AX extraction, HTTP or Google API live
 * here. Resolve each action against a fresh bounded semantic observation.
 * These commands are NOT idempotent: an uncertain commit is never resubmitted.
 */
import { createHash } from 'node:crypto';
const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max = 240) => typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
export class WorkflowError extends Error {
  constructor(code, { stage = 'preflight', outcome = 'not_dispatched', reason } = {}) {
    super(code); Object.assign(this, { code, stage, outcome, reason });
  }
}
const refuse = (code = 'CALENDAR_COMMAND_INVALID') => { throw new WorkflowError(code); };
export const workflowCommands = Object.freeze({
  'list-calendars': { spec: 'string?' }, 'read-day': { spec: 'string' }, 'find-events': { spec: 'string' },
  'free-slots': { spec: 'string' }, 'create-event': { spec: 'string' },
  'move-event': { spec: 'string' }, 'delete-event': { spec: 'string' },
});
export const workflowWrites = new Set(['create-event', 'move-event', 'delete-event']);

const zones = Object.freeze({
  'Europe/Moscow': ['Москва', 'Moscow'], UTC: ['Всемирное координированное время', 'Coordinated Universal Time'],
  'Europe/London': ['Лондон', 'London'], 'Europe/Berlin': ['Берлин', 'Berlin'],
  'Europe/Paris': ['Париж', 'Paris'], 'Asia/Dubai': ['Дубай', 'Dubai'],
  'Asia/Tbilisi': ['Тбилиси', 'Tbilisi'], 'Asia/Yerevan': ['Ереван', 'Yerevan'],
  'Asia/Almaty': ['Алматы', 'Almaty'], 'Asia/Bangkok': ['Бангкок', 'Bangkok'],
  'Asia/Tokyo': ['Токио', 'Tokyo'], 'America/New_York': ['Нью-Йорк', 'New York'],
  'America/Los_Angeles': ['Лос-Анджелес', 'Los Angeles'],
});
export const supportedZones = Object.keys(zones);
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value || '')) refuse();
  const instant = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > '2100-12-31') refuse();
  return value;
}
const time = value => { if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value || '')) refuse(); return value; };
const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

/** Detect skipped and repeated local times with the real IANA rules. Never
 * silently choose one side of a DST fold. UI automation cannot reliably set an
 * offset hidden behind an ambiguous wall clock, so that case needs the agent.
 */
export function localInstant(day, at, zone) {
  date(day); time(at);
  let formatter;
  try { formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { refuse(); }
  const naive = Date.parse(`${day}T${at}:00Z`), matches = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = naive - offset * 60_000;
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === `${day}T${at}`) matches.push(candidate);
  }
  if (matches.length !== 1) refuse(matches.length ? 'CALENDAR_TIME_AMBIGUOUS' : 'CALENDAR_TIME_NONEXISTENT');
  return matches[0];
}
function base(value) {
  if (!text(value.calendar, 120)) refuse();
  date(value.date);
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { refuse(); }
  if (typeof value.timeZone !== 'string') refuse();
}
function target(value) {
  if (!known(value, ['calendar', 'date', 'timeZone', 'title', 'startTime', 'endTime'])) refuse();
  base(value); if (!text(value.title)) refuse(); time(value.startTime); time(value.endTime);
  if (localInstant(value.date, value.endTime, value.timeZone) <= localInstant(value.date, value.startTime, value.timeZone)) refuse();
}
export function parseWorkflowSpec(operation, source) {
  let value; try { value = operation === 'list-calendars' && source === undefined ? {} : JSON.parse(source); } catch { refuse(); }
  if (!object(value)) refuse();
  if (value.offset !== undefined && (!Number.isInteger(value.offset) || value.offset < 0 || value.offset > 2000)) refuse();
  if (operation === 'list-calendars') {
    if (!known(value, ['offset'])) refuse();
  } else if (operation === 'read-day') {
    if (!known(value, ['calendar', 'date', 'timeZone', 'offset'])) refuse(); base(value);
  } else if (operation === 'find-events') {
    if (!known(value, ['calendar', 'from', 'to', 'timeZone', 'query', 'offset']) || !text(value.query, 120)) refuse();
    base({ ...value, date: value.from }); date(value.to);
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000;
    if (days < 0 || days > 6) refuse();
  } else if (operation === 'free-slots') {
    if (!known(value, ['calendar', 'date', 'timeZone', 'fromTime', 'toTime', 'durationMinutes', 'offset'])) refuse(); base(value);
    time(value.fromTime); time(value.toTime);
    localInstant(value.date, value.fromTime, value.timeZone); localInstant(value.date, value.toTime, value.timeZone);
    if (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440
      || minutes(value.toTime) <= minutes(value.fromTime)) refuse();
  } else if (operation === 'create-event') {
    if (!known(value, ['calendar', 'date', 'timeZone', 'title', 'startTime', 'endTime', 'availability', 'notifications', 'description', 'location', 'guests'])) refuse();
    target(Object.fromEntries(['calendar', 'date', 'timeZone', 'title', 'startTime', 'endTime'].map(key => [key, value[key]])));
    if (value.availability !== undefined && !['busy', 'free'].includes(value.availability)) refuse();
    if (value.notifications !== undefined && (!Array.isArray(value.notifications) || value.notifications.length)) refuse('CALENDAR_NOTIFICATIONS_REQUIRE_AGENT');
    if (value.guests !== undefined && (!Array.isArray(value.guests) || value.guests.length)) refuse('CALENDAR_GUESTS_REQUIRE_AGENT');
    for (const key of ['description', 'location']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].isWellFormed() || normalize(value[key]).length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value[key]))) refuse();
    if (!Object.hasOwn(zones, value.timeZone)) refuse('CALENDAR_ZONE_REQUIRES_AGENT');
  } else if (operation === 'move-event') {
    if (!known(value, ['target', 'date', 'startTime', 'endTime'])) refuse(); target(value.target);
    date(value.date); time(value.startTime);
    const duration = minutes(value.target.endTime) - minutes(value.target.startTime);
    if (value.endTime === undefined) {
      if (minutes(value.startTime) + duration >= 1440) refuse('CALENDAR_MULTIDAY_REQUIRES_AGENT');
      value.endTime = clock(minutes(value.startTime) + duration);
    }
    target({ ...value.target, date: value.date, startTime: value.startTime, endTime: value.endTime });
  } else if (operation === 'delete-event') {
    if (!known(value, ['target'])) refuse(); target(value.target);
    if (value.target.title.length > 80) refuse('CALENDAR_LONG_TITLE_REQUIRES_AGENT');
  } else refuse();
  return value;
}

export const labels = Object.freeze({
  create: ['Создать', 'Create'], event: ['Мероприятие', 'Event'], more: ['Другие параметры', 'More options'],
  title: ['Название', 'Title', 'Add title'], save: ['Сохранить', 'Save'],
  startDate: ['Дата начала', 'Start date'], endDate: ['Дата окончания', 'End date'],
  startTime: ['Время начала', 'Start time'], endTime: ['Время окончания', 'End time'],
  primaryZone: ['Основной часовой пояс', 'Primary time zone'], settingsPage: ['Настройки', 'Settings'],
  zone: ['Часовой пояс', 'Time zone'], zoneStart: ['Начало мероприятия', 'Event start time zone', 'Start time zone'],
  repeatField: ['Периодичность', 'Recurrence'], statusField: ['Статус', 'Show me as', 'Availability'],
  ok: ['ОК', 'OK'], allDay: ['Весь день', 'All day'], repeat: ['Не повторяется', 'Does not repeat'],
  busy: ['Занят/занята', 'Busy'], free: ['Свободен/свободна', 'Free'],
  removeNotification: ['Удалить уведомление', 'Remove notification'],
  guests: ['Гости', 'Guests', 'Add guests'], meet: ['Добавить видеоконференцию Google Meet', 'Add Google Meet video conferencing'],
  description: ['Описание', 'Description', 'Add description'], location: ['Укажите место проведения', 'Location', 'Add location'],
  edit: ['Изменить мероприятие', 'Edit event'], remove: ['Удалить мероприятие', 'Delete event'],
  cancelEdit: ['Отменить изменения', 'Cancel changes'], settings: ['Настройки', 'Settings menu', 'Settings'],
  trash: ['Корзина', 'Trash'], calendar: ['Календарь', 'Calendar'],
});
// The signed host compares these business fields privately. Raw CLI callers
// cannot add checks, labels or origins; no field value returns to the agent.
export const fieldCheckPolicy = Object.freeze({ origins: ['https://calendar.google.com'],
  labels: [...new Set(['title', 'startDate', 'endDate', 'startTime', 'endTime', 'primaryZone', 'zoneStart', 'repeatField', 'statusField', 'calendar', 'description', 'location', 'guests'].flatMap(key => labels[key]))] });
const uiLabel = value => normalize(value).replace(/\b(?:arrow_drop_down|add)\b/gu, '').trim();
const equals = (a, b) => normalize(a).toLocaleLowerCase() === normalize(b).toLocaleLowerCase();

/** This object owns a single invocation, not the account/session. The generic
 * host still enforces origin, auth, frame, process, lease and private storage.
 * Readiness polls are read-only; no input, Save or Delete is ever retried.
 */
export class CalendarUI {
  constructor(call, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { call, now, sleep, deadline: now() + 180_000, calls: 0, commitStarted: false, stage: 'preflight', locale: 'ru', calendarNames: [] });
  }
  async request(operation, args = {}) {
    if (++this.calls > 400 || this.now() >= this.deadline) throw new WorkflowError('CALENDAR_WORKFLOW_LIMIT');
    let result;
    try { result = await this.call(operation, args); }
    catch { throw new WorkflowError('CALENDAR_UI_UNAVAILABLE', { stage: this.stage }); }
    if (result?.state === 'preparing') {
      const until = Math.min(this.deadline, this.now() + 30_000);
      do { await this.sleep(200); result = await this.call('status', {}); }
      while (result?.state === 'preparing' && this.now() < until);
      if (['ready', 'saved_unverified'].includes(result?.state) && operation === 'navigate') return this.request('read-text');
    }
    if (result?.state !== 'ready') throw new WorkflowError(result?.state === 'manual_input_required'
      || ['authentication_required', 'authentication_setup_required', 'manual_control_active'].includes(result?.reason)
      ? 'CALENDAR_AUTH_REQUIRED' : 'CALENDAR_UI_UNAVAILABLE', { stage: this.stage, reason: result?.reason });
    if (result.kind !== 'trelio.browser-text/v1' || !Array.isArray(result.controls)
      || typeof result.text !== 'string' || !Object.hasOwn(result, 'nextControlsOffset')) throw new WorkflowError('CALENDAR_SEMANTICS_REQUIRED');
    return result;
  }
  async observe(args = {}) { return this.request('read-text', args); }
  async input(operation, frame, args) { return this.request(operation, { frameId: frame.frameId, ...args }); }
  async controls(query = '') {
    const result = [], offsets = new Set(); let offset = 0, frame;
    do {
      if (offsets.has(offset)) refuse('CALENDAR_UI_UNSUPPORTED'); offsets.add(offset);
      frame = await this.observe({ controlQuery: query.slice(0, 120), controlOffset: offset, query: query.slice(0, 120) });
      if (frame.scanLimited) refuse('CALENDAR_COVERAGE_INCOMPLETE');
      result.push(...frame.controls.map(control => ({ control, frame })));
      offset = frame.nextControlsOffset;
    } while (offset !== null && offsets.size < 31);
    if (offset !== null) refuse('CALENDAR_COVERAGE_INCOMPLETE');
    return result;
  }
  async find(names, roles = ['button'], { optional = false, contains = false, verbatim = false } = {}) {
    // SPA transitions can return a ready document before its next panel renders.
    // Poll observations only; never repeat an input to force the panel open.
    for (let pass = 0; pass < 5; pass++) {
      for (const name of names) {
        const match = control => {
          const value = control.role === 'button' && !verbatim ? uiLabel(control.label) : normalize(control.label);
          return roles.includes(control.role) && (contains ? value.toLocaleLowerCase().includes(name.toLocaleLowerCase()) : equals(value, name));
        };
        const matches = (await this.controls(name)).filter(({ control }) => match(control));
        if (matches.length > 1) refuse('CALENDAR_UI_AMBIGUOUS');
        if (matches.length === 1) {
          // Pagination invalidates old observation tokens. Resolve the SAME
          // unique control again immediately before using its current geometry.
          const frame = await this.observe({ controlQuery: name.slice(0, 120), query: name.slice(0, 120) });
          const current = frame.controls.filter(match);
          if (current.length !== 1 || frame.nextControlsOffset !== null) refuse('CALENDAR_UI_AMBIGUOUS');
          return { frame, control: current[0] };
        }
      }
      if (pass < 4) await this.sleep(200);
    }
    if (!optional) refuse('CALENDAR_UI_UNSUPPORTED');
    return null;
  }
  async click(names, roles = ['button', 'menuitem'], options) {
    const found = await this.find(names, roles, options);
    if (!found) return null;
    return this.input('click', found.frame, { x: found.control.x, y: found.control.y });
  }
  async fill(names, value, { blur = true } = {}) {
    const { frame, control } = await this.find(names, ['textbox', 'combobox']);
    let current = await this.input('click', frame, { x: control.x, y: control.y });
    current = await this.input('key', current, { key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' });
    current = await this.input('type-text', current, { text: value });
    return blur ? this.input('key', current, { key: 'Tab' }) : current;
  }
  async compare(names, values, { match = 'equals' } = {}) {
    const found = await this.find(names, ['textbox', 'combobox', 'select']);
    const frame = await this.observe({ controlQuery: found.control.label, checks: [
      { id: 'expected', label: found.control.label, match, values }
    ] });
    if (frame.fieldChecks?.length !== 1) refuse('CALENDAR_FORM_UNVERIFIED');
    return frame.fieldChecks[0].state;
  }
  async verify(names, values, options) {
    if (await this.compare(names, values, options) !== 'matches') refuse('CALENDAR_FORM_UNVERIFIED');
  }
  async allText() {
    let offset = 0, text = '', frame; const seen = new Set();
    do {
      if (seen.has(offset) || seen.size >= 18) refuse('CALENDAR_COVERAGE_INCOMPLETE'); seen.add(offset);
      frame = await this.observe({ offset, includeControls: false });
      if (frame.scanLimited) refuse('CALENDAR_COVERAGE_INCOMPLETE');
      text += frame.text; offset = frame.nextOffset;
    } while (offset !== null);
    return { text, frame };
  }
  async start() {
    // Preserve an existing editor for the agent instead of discarding another
    // draft just to make a recipe's initial state convenient.
    let status = await this.call('status', {});
    // An explicit previous close acknowledges before its worker finishes
    // stop/save/unclaim. Observe that lifecycle; do not dispatch into the
    // closing owner or reset its authentication to manufacture readiness.
    for (let n = 0; ['closed', 'preparing'].includes(status?.state) && n < 150; n++) {
      await this.sleep(200); status = await this.call('status', {});
    }
    if (['closed', 'preparing'].includes(status?.state)) refuse('CALENDAR_UI_UNAVAILABLE');
    if (status?.state === 'manual_input_required') refuse('CALENDAR_AUTH_REQUIRED');
    let frame = status?.state === 'ready' ? await this.observe()
      : await this.request('navigate', { url: 'https://calendar.google.com/calendar/r' });
    if (/Страница редактирования мероприятия|Event editing page/u.test(frame.text)
      || await this.find(labels.save, ['button'], { optional: true })) refuse('CALENDAR_DRAFT_REQUIRES_AGENT');
    if (!/Календарь|Calendar/u.test(frame.title) || /Выберите аккаунт|Choose an account|Войти в аккаунт|Sign in/u.test(frame.text)) refuse('CALENDAR_AUTH_REQUIRED');
    this.locale = /Календарь/u.test(frame.title) ? 'ru' : 'en';
    if (/Корзина|Trash|настройки|Settings/iu.test(frame.title)) {
      const prior = accountLabel(frame);
      frame = await this.request('navigate', { url: 'https://calendar.google.com/calendar/r' });
      if (accountLabel(frame) !== prior) refuse('CALENDAR_ACCOUNT_MISMATCH');
    }
    return frame;
  }
}

const dateLabel = (day, locale) => new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${day}T12:00:00Z`)).replace(/ г\.$/u, '');
function parseClock(value) {
  const match = normalize(value).toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/u);
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2] || 0);
  if (minute > 59 || hour > (match[3] ? 12 : 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3] === 'pm' ? 12 : 0);
  return clock(hour * 60 + minute);
}

/** Parse only the Calendar's rendered accessibility summaries, with its own
 * per-calendar count as an independent coverage check. A missing/changed
 * grammar is incomplete coverage, never an empty schedule. Commas in titles
 * do not act as separators: the known calendar suffix owns that boundary.
 */
export function parseDayText(source, { calendar, date: day, timeZone }) {
  const lines = source.split('\n').map(normalize).filter(Boolean), events = [];
  let expected = 0, countKnown = false;
  const count = new RegExp(`^(\\d+) (?:мероприятие|мероприятия|мероприятий|events?)(?: на весь день| all.day)?, ${escape(calendar)}$`, 'iu');
  const empty = new RegExp(`^(?:Мероприятий нет|Нет мероприятий на весь день|No events|No all.day events), ${escape(calendar)}$`, 'iu');
  for (const line of lines) {
    const total = line.match(count);
    if (total) { expected += Number(total[1]); countKnown = true; continue; }
    if (empty.test(line)) { countKnown = true; continue; }
    const marker = [`, Календарь: ${calendar},`, `, Calendar: ${calendar},`, `, ${calendar},`].find(value => line.includes(value));
    if (!marker) continue;
    const at = line.lastIndexOf(marker), prefix = line.slice(0, at);
    if (!line.includes(dateLabel(day, 'ru')) && !line.includes(dateLabel(day, 'en'))) continue;
    const timed = prefix.match(/^(?:С |From )?([\d:]+\s*(?:am|pm)?) (?:до|to) ([\d:]+\s*(?:am|pm)?), (.+)$/iu);
    const allDay = prefix.match(/^(?:Весь день|All day), (.+)$/iu);
    if (timed) {
      const startTime = parseClock(timed[1]), endTime = parseClock(timed[2]);
      if (!startTime || !endTime || minutes(endTime) <= minutes(startTime)) continue;
      events.push({ calendar, date: day, timeZone, title: timed[3], startTime, endTime, availability: 'unknown', allDay: false });
    } else if (allDay) events.push({ calendar, date: day, timeZone, title: allDay[1], availability: 'unknown', allDay: true });
  }
  const titlesComplete = events.every(event => event.title.length <= 240);
  return { calendar, date: day, timeZone, events: events.slice(0, 250).map(event => event.title.length <= 240 ? event
    : { ...event, title: event.title.slice(0, 240), titleTruncated: true }),
    coverage: { complete: countKnown && expected === events.length && events.length <= 250 && titlesComplete,
      expectedCount: countKnown ? expected : null, observedCount: events.length, limit: 250 } };
}

function accountLabel(frame) {
  const account = frame.controls.filter(control => control.role === 'link' && /^(?:Аккаунт Google:|Google Account:)/u.test(control.label));
  if (account.length !== 1) refuse('CALENDAR_ACCOUNT_REQUIRES_AGENT');
  return account[0].label;
}
async function calendarInventory(ui) {
  const controls = (await ui.controls()).map(item => item.control);
  const calendars = controls.filter(control => control.role === 'checkbox' && typeof control.checked === 'boolean')
    .map(control => ({ name: control.label, selected: control.checked }));
  if (!calendars.length) refuse('CALENDAR_SIDEBAR_REQUIRES_AGENT');
  ui.calendarNames = calendars.map(calendar => calendar.name);
  return calendars;
}
const expectedZone = zone => [zone, ...['ru-RU', 'en-US'].map(locale =>
  new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'long' }).formatToParts().find(part => part.type === 'timeZoneName').value)];
async function verifyDisplayZone(ui, zone) {
  if (ui.verifiedZone === zone) return;
  if (!zones[zone]) refuse('CALENDAR_ZONE_REQUIRES_AGENT');
  // Read the primary display zone without changing it. A mismatch requires
  // the agent; interpreting wall-clock rows in a guessed zone is unsafe.
  await ui.click(labels.settings, ['button']); await ui.click(labels.settingsPage, ['menuitem']);
  await ui.verify(labels.primaryZone, expectedZone(zone), { match: 'contains' });
  const frame = await ui.request('navigate', { url: 'https://calendar.google.com/calendar/r' });
  if (accountLabel(frame) !== ui.account) refuse('CALENDAR_ACCOUNT_MISMATCH');
  ui.verifiedZone = zone;
}
async function goDay(ui, spec) {
  await verifyDisplayZone(ui, spec.timeZone);
  const [year, month, day] = spec.date.split('-').map(Number);
  // This is a public Calendar UI route, not a Calendar API endpoint. Never
  // construct event IDs/URLs. An account switch caused by Google's routing is
  // detected before any write instead of silently accepting another account.
  const frame = await ui.request('navigate', { url: `https://calendar.google.com/calendar/r/day/${year}/${month}/${day}` });
  if (accountLabel(frame) !== ui.account) refuse('CALENDAR_ACCOUNT_MISMATCH');
  if (!frame.title.includes(dateLabel(spec.date, ui.locale))) refuse('CALENDAR_DATE_REQUIRES_AGENT');
  return frame;
}
async function requireCalendar(ui, calendar) {
  const found = await ui.find([calendar], ['checkbox'], { verbatim: true });
  if (typeof found.control.checked !== 'boolean') refuse('CALENDAR_CALENDAR_STATE_UNKNOWN');
  if (!found.control.checked) {
    await ui.input('click', found.frame, { x: found.control.x, y: found.control.y });
    const checked = await ui.find([calendar], ['checkbox'], { verbatim: true });
    if (checked.control.checked !== true) refuse('CALENDAR_CALENDAR_STATE_UNKNOWN');
  }
}
async function readDay(ui, spec) {
  await goDay(ui, spec); await requireCalendar(ui, spec.calendar);
  const { text } = await ui.allText();
  return parseDayText(text, spec);
}
const timedTarget = event => Object.fromEntries(['calendar', 'date', 'timeZone', 'title', 'startTime', 'endTime'].map(key => [key, event[key]]));
const sameTarget = (a, b) => ['calendar', 'date', 'title', 'startTime', 'endTime'].every(key => normalize(a[key]) === normalize(b[key]));

async function openEvent(ui, spec) {
  // Read-back must independently locate the exact tuple, not just a title.
  // Duplicate candidates or incomplete coverage require an agent decision.
  const day = await readDay(ui, spec);
  if (!day.coverage.complete) refuse('CALENDAR_COVERAGE_INCOMPLETE');
  if (day.events.filter(event => sameTarget(event, spec)).length !== 1) refuse('CALENDAR_TARGET_AMBIGUOUS');
  for (let scan = 0; scan < 26; scan++) {
    const candidates = (await ui.controls(spec.title.slice(0, 80))).filter(({ control }) => control.role === 'button' && control.label.includes(spec.title.slice(0, 80)));
    if (candidates.length > 1) refuse('CALENDAR_TARGET_AMBIGUOUS');
    if (candidates.length === 1) {
      const current = await ui.observe({ controlQuery: spec.title.slice(0, 80) });
      const match = current.controls.filter(control => control.role === 'button' && control.label.includes(spec.title.slice(0, 80)));
      if (match.length !== 1 || current.nextControlsOffset !== null) refuse('CALENDAR_TARGET_AMBIGUOUS');
      await ui.input('click', current, { x: match[0].x, y: match[0].y });
      const card = await ui.allText();
      if (!card.text.includes(spec.title) || !card.text.includes(spec.calendar)
        || !card.text.includes(dateLabel(spec.date, ui.locale).replace(/,? \d{4}$/u, ''))) refuse('CALENDAR_CARD_MISMATCH');
      return card;
    }
    const frame = await ui.observe();
    // Wheel placement is relative viewport geometry over the calendar pane,
    // never a saved event coordinate. A bounded unsuccessful scan is unknown
    // visibility; it cannot establish that the event does not exist.
    await ui.input('scroll', frame, { x: Math.round(frame.width * .75), y: Math.round(frame.height * .6), deltaY: scan === 0 ? -10000 : 500 });
  }
  refuse('CALENDAR_TARGET_NOT_VISIBLE');
}
async function openOrdinaryEditor(ui) {
  await ui.click(labels.edit, ['button']);
  const allDay = await ui.find(labels.allDay, ['checkbox']);
  if (allDay.control.checked !== false) refuse('CALENDAR_ALLDAY_REQUIRES_AGENT');
  await ui.verify(labels.repeatField, labels.repeat);
}
async function choose(ui, names, desired, { optional = false, verbatim = false } = {}) {
  const found = await ui.find(names, ['combobox', 'select'], { optional, verbatim });
  if (!found) return false;
  await ui.input('click', found.frame, { x: found.control.x, y: found.control.y });
  await ui.click(desired, ['option'], { verbatim: true });
  return true;
}
async function setZone(ui, timeZone) {
  // A new event inherits the UI zone. Verify it rather than searching city
  // suggestions: several unrelated places can share the same city name.
  // Changing a mismatched default requires the agent's explicit picker review.
  await verifyEventZone(ui, timeZone);
}
async function verifyEventZone(ui, zone) {
  if (!zones[zone]) refuse('CALENDAR_ZONE_REQUIRES_AGENT');
  await ui.click(labels.zone);
  await ui.verify(labels.zoneStart, expectedZone(zone), { match: 'contains' });
  // Escape closes this read-only dialog without applying any zone change.
  const frame = await ui.observe(); await ui.input('key', frame, { key: 'Escape' });
}
const dateAlternatives = (day, locale) => {
  const result = [day];
  for (const month of ['long', 'short']) {
    const value = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US',
      { day: 'numeric', month, year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
    result.push(value, value.replace(/ г\.$/u, ''), value.replace(/\./gu, '').replace(/ г$/u, ''));
  }
  return [...new Set(result)];
};
const timeAlternatives = value => {
  const hour = Number(value.slice(0, 2)), minute = value.slice(3), suffix = hour < 12 ? 'AM' : 'PM';
  return [...new Set([value, `${hour}:${minute}`, `${hour % 12 || 12}:${minute}${suffix}`, `${hour % 12 || 12}:${minute} ${suffix}`,
    `${hour % 12 || 12}:${minute}${suffix.toLowerCase()}`, `${hour % 12 || 12}:${minute} ${suffix.toLowerCase()}`])];
};
async function setTimes(ui, spec) {
  const displayed = dateLabel(spec.date, ui.locale);
  await ui.fill(labels.startDate, displayed);
  await ui.fill(labels.startTime, spec.startTime);
  await ui.fill(labels.endDate, displayed);
  await ui.fill(labels.endTime, spec.endTime);
  // Date/time widgets can accept typing yet reject or normalize it on blur.
  // Check all four accepted values before any Save, without exposing values.
  await ui.verify(labels.startDate, dateAlternatives(spec.date, ui.locale));
  await ui.verify(labels.endDate, dateAlternatives(spec.date, ui.locale));
  await ui.verify(labels.startTime, timeAlternatives(spec.startTime));
  await ui.verify(labels.endTime, timeAlternatives(spec.endTime));
}
async function commit(ui, names) {
  const found = await ui.find(names, ['button']);
  // Set the uncertainty fence BEFORE the single native dispatch. A failure
  // after this point permits read-back only, never another Save/Delete.
  ui.stage = 'request'; ui.commitStarted = true;
  return ui.input('click', found.frame, { x: found.control.x, y: found.control.y });
}
async function verifiedEvent(ui, spec) {
  ui.stage = 'verification';
  const day = await readDay(ui, spec);
  if (!day.coverage.complete || day.events.filter(event => sameTarget(event, spec)).length !== 1) refuse('CALENDAR_RESULT_UNVERIFIED');
  await openEvent(ui, spec);
  return timedTarget(spec);
}

/** Merge occupied intervals, keeping safe candidate slots explicit when a
 * read-only/private event does not reveal availability. Unknown is occupied,
 * never free; conservative results are not claimed to be exhaustive.
 */
export function calculateFreeSlots(day, { fromTime, toTime, durationMinutes }) {
  const from = minutes(fromTime), to = minutes(toTime), occupied = [];
  for (const event of day.events) if (event.availability !== 'free') occupied.push(event.allDay ? [from, to]
    : [Math.max(from, minutes(event.startTime)), Math.min(to, minutes(event.endTime))]);
  occupied.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of occupied.filter(([a, b]) => b > a)) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
  }
  const slots = []; let cursor = from;
  for (const [start, end] of [...merged, [to, to]]) {
    if (start - cursor >= durationMinutes) slots.push({ startTime: clock(cursor), endTime: clock(start) });
    cursor = Math.max(cursor, end);
  }
  const unknownAvailability = day.events.filter(event => event.availability === 'unknown').length;
  return { calendar: day.calendar, date: day.date, timeZone: day.timeZone, durationMinutes, slots,
    coverage: { ...day.coverage, complete: day.coverage.complete && unknownAvailability === 0, conservative: unknownAvailability > 0, unknownAvailability } };
}

/** Generic skill stdout is a bounded text envelope, not a native frame. Page
 * structured rows BEFORE serialization instead of truncating JSON or forging
 * a host observation marker. A hash detects changed reads between pages; it is
 * not a Google event ID, access token or mutation/idempotency proof.
 */
export function workflowPage(operation, spec, result) {
  const key = ['events', 'calendars', 'slots'].find(key => Array.isArray(result[key]));
  const envelope = { kind: 'trelio.calendar-workflow/v1', schemaVersion: 1, state: 'ready', operation, ...result };
  if (key) {
    const all = result[key], offset = spec.offset || 0;
    const observationHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    let count = Math.min(10, Math.max(0, all.length - offset));
    const project = () => ({ ...envelope, [key]: all.slice(offset, offset + count),
      coverage: { ...result.coverage, sourceComplete: result.coverage.complete,
        complete: result.coverage.complete && offset === 0 && count === all.length },
      page: { offset, returned: count, nextOffset: offset + count < all.length ? offset + count : null, observationHash } });
    while (count > 0 && Buffer.byteLength(JSON.stringify(project())) > 8000) count--;
    if (!count && offset < all.length) refuse('CALENDAR_OUTPUT_LIMIT');
    const value = project();
    if (Buffer.byteLength(JSON.stringify(value)) > 8000) refuse('CALENDAR_OUTPUT_LIMIT');
    return value;
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > 8000) refuse('CALENDAR_OUTPUT_LIMIT');
  return envelope;
}

export async function executeWorkflow(operation, spec, call, options) {
  const ui = new CalendarUI(call, options);
  try {
    const start = await ui.start(); ui.account = accountLabel(start);
    const inventory = await calendarInventory(ui);
    let result;
    if (operation === 'list-calendars') result = { calendars: inventory, coverage: { complete: false, scope: 'visible_viewport' } };
    else if (operation === 'read-day') result = await readDay(ui, spec);
    else if (operation === 'find-events') {
      const days = [], events = [];
      for (let at = Date.parse(spec.from); at <= Date.parse(spec.to); at += 86_400_000) {
        const day = await readDay(ui, { ...spec, date: new Date(at).toISOString().slice(0, 10) });
        days.push({ date: day.date, ...day.coverage });
        events.push(...day.events.filter(event => event.title.toLocaleLowerCase().includes(spec.query.toLocaleLowerCase())));
      }
      result = { calendar: spec.calendar, from: spec.from, to: spec.to, timeZone: spec.timeZone,
        events, coverage: { complete: days.every(day => day.complete), days } };
    } else if (operation === 'free-slots') {
      const day = await readDay(ui, spec);
      if (!day.coverage.complete) refuse('CALENDAR_COVERAGE_INCOMPLETE');
      for (const event of day.events.slice(0, 10)) {
        if (event.allDay) continue;
        const card = await openEvent(ui, event);
        if (/\n(?:Свободен\/свободна|Free)(?:\n|$)/u.test(card.text)) event.availability = 'free';
        else {
          const edit = await ui.find(labels.edit, ['button'], { optional: true });
          if (edit) {
            await ui.input('click', edit.frame, { x: edit.control.x, y: edit.control.y });
            const busy = await ui.compare(labels.statusField, labels.busy) === 'matches';
            const free = busy ? false : await ui.compare(labels.statusField, labels.free) === 'matches';
            event.availability = busy ? 'busy' : free ? 'free' : 'unknown';
            await ui.click(labels.cancelEdit);
            continue;
          }
        }
        const frame = await ui.observe(); await ui.input('key', frame, { key: 'Escape' });
      }
      result = calculateFreeSlots(day, spec);
    } else if (operation === 'create-event') {
      const day = await readDay(ui, spec);
      if (!day.coverage.complete) refuse('CALENDAR_COVERAGE_INCOMPLETE');
      if (day.events.some(event => normalize(event.title) === normalize(spec.title))) refuse('CALENDAR_TARGET_EXISTS');
      await ui.click(labels.create, ['button']); await ui.click(labels.event, ['menuitem', 'button']);
      const more = await ui.find(labels.more, ['button'], { optional: true });
      if (more) await ui.input('click', more.frame, { x: more.control.x, y: more.control.y });
      const allDay = await ui.find(labels.allDay, ['checkbox']);
      if (allDay.control.checked === true) await ui.input('click', allDay.frame, { x: allDay.control.x, y: allDay.control.y });
      else if (allDay.control.checked !== false) refuse('CALENDAR_CALENDAR_STATE_UNKNOWN');
      await ui.verify(labels.repeatField, labels.repeat);
      await ui.fill(labels.title, spec.title);
      await choose(ui, [...labels.calendar, ...ui.calendarNames], [spec.calendar], { verbatim: true });
      await setZone(ui, spec.timeZone); await setTimes(ui, spec);
      if (spec.availability) await choose(ui, labels.statusField, labels[spec.availability]);
      if (spec.notifications) {
        for (let n = 0; n < 10; n++) {
          const matches = (await ui.controls(labels.removeNotification[ui.locale === 'ru' ? 0 : 1])).filter(({ control }) => control.role === 'button');
          if (!matches.length) break;
          // These are all notification rows in the draft we just created.
          // Resolve the first remaining row afresh; never save a row index or
          // coordinate across removal/reflow of its preceding sibling.
          const frame = await ui.observe({ controlQuery: labels.removeNotification[ui.locale === 'ru' ? 0 : 1] });
          const first = frame.controls.find(control => control.role === 'button');
          if (!first) refuse('CALENDAR_UI_UNSUPPORTED');
          await ui.input('click', frame, { x: first.x, y: first.y });
        }
        if ((await ui.controls(labels.removeNotification[ui.locale === 'ru' ? 0 : 1])).length) refuse('CALENDAR_UI_UNSUPPORTED');
      }
      if (spec.description) { await ui.fill(labels.description, spec.description); await ui.verify(labels.description, [normalize(spec.description)]); }
      if (spec.location) { await ui.fill(labels.location, spec.location); await ui.verify(labels.location, [normalize(spec.location)]); }
      await ui.verify(labels.guests, ['']);
      // A calendar preference may auto-create conferencing. Do not silently
      // save that external side effect under a no-conference ordinary recipe.
      await ui.find(labels.meet, ['button']);
      await ui.verify(labels.calendar, [spec.calendar]);
      if (spec.availability) await ui.verify(labels.statusField, labels[spec.availability]);
      await ui.verify(labels.title, [spec.title]);
      await verifyEventZone(ui, spec.timeZone);
      await commit(ui, labels.save);
      result = { event: await verifiedEvent(ui, spec), action: 'created', verification: 'reloaded_day_and_exact_card' };
    } else if (operation === 'move-event') {
      await openEvent(ui, spec.target); await openOrdinaryEditor(ui);
      await verifyEventZone(ui, spec.target.timeZone);
      const moved = { ...spec.target, date: spec.date, startTime: spec.startTime, endTime: spec.endTime };
      await setTimes(ui, moved); await commit(ui, labels.save);
      result = { event: await verifiedEvent(ui, moved), action: 'moved', verification: 'reloaded_day_and_exact_card' };
    } else if (operation === 'delete-event') {
      await openEvent(ui, spec.target); await openOrdinaryEditor(ui); await ui.click(labels.cancelEdit);
      await openEvent(ui, spec.target); await commit(ui, labels.remove);
      ui.stage = 'verification';
      const day = await readDay(ui, spec.target);
      if (!day.coverage.complete || day.events.some(event => sameTarget(event, spec.target))) refuse('CALENDAR_RESULT_UNVERIFIED');
      await ui.click(labels.settings); await ui.click(labels.trash); await ui.click([spec.target.calendar], ['link'], { verbatim: true });
      const trash = await ui.allText();
      const restore = await ui.find([`Восстановить мероприятие "${spec.target.title}"`, `Restore event "${spec.target.title}"`], ['button'], { optional: true, verbatim: true });
      if (!restore || !trash.text.includes(spec.target.startTime)) refuse('CALENDAR_RESULT_UNVERIFIED');
      result = { event: timedTarget(spec.target), action: 'deleted_to_trash', verification: 'reloaded_day_and_trash' };
    } else refuse();
    return workflowPage(operation, spec, result);
  } catch (error) {
    // Preserve the business uncertainty even if a later read, dialog or auth
    // check fails. The outer CLI serializes only these fixed codes/stages.
    throw new WorkflowError(ui.commitStarted ? 'CALENDAR_ACTION_UNKNOWN'
      : error instanceof WorkflowError ? error.code : 'CALENDAR_WORKFLOW_FAILED',
    { stage: ui.stage, outcome: ui.commitStarted ? 'unknown' : 'not_dispatched', reason: error instanceof WorkflowError ? error.reason : undefined });
  }
}
