import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CalendarUI, WorkflowError, calculateFreeSlots, executeWorkflow, localInstant,
  parseDayText, parseWorkflowSpec, workflowPage } from '../scripts/calendar-workflows.mjs';

const target = { calendar: 'Demo [east]', date: '2030-05-12', timeZone: 'Europe/Moscow',
  title: 'Synthetic, review', startTime: '12:00', endTime: '12:05' };
const row = value => `С ${value.startTime} до ${value.endTime}, ${value.title}, Календарь: ${value.calendar}, Место не указано, 12 мая 2030`;
test('workflow specs validate exact targets and DST before any host or UI access', () => {
  assert.equal(new Date(localInstant('2026-11-11', '12:00', 'Europe/Moscow')).toISOString(), '2026-11-11T09:00:00.000Z');
  assert.throws(() => localInstant('2026-03-08', '02:30', 'America/New_York'), /CALENDAR_TIME_NONEXISTENT/);
  assert.throws(() => localInstant('2026-11-01', '01:30', 'America/New_York'), /CALENDAR_TIME_AMBIGUOUS/);
  const moved = parseWorkflowSpec('move-event', JSON.stringify({ target, date: '2030-05-12', startTime: '12:10' }));
  assert.equal(moved.endTime, '12:15');
  for (const [command, spec] of [
    ['create-event', { ...target, calendar: '' }], ['create-event', { ...target, guests: ['outsider@example.test'] }],
    ['create-event', { ...target, notifications: [10] }], ['delete-event', { target: { title: target.title } }],
    ['read-day', { calendar: 'Demo', date: '2030-02-31', timeZone: 'Europe/Moscow' }],
    ['find-events', { calendar: 'Demo', from: '2030-05-12', to: '2030-05-19', timeZone: 'UTC', query: 'x' }],
    ['move-event', { target, date: '2030-05-12', startTime: '23:59' }],
  ]) assert.throws(() => parseWorkflowSpec(command, JSON.stringify(spec)), WorkflowError);
});

test('calendar row parsing preserves title commas and independently verifies native count coverage', () => {
  const parsed = parseDayText(`1 мероприятие, ${target.calendar}\n${row(target)}`, target);
  assert.equal(parsed.coverage.complete, true);
  assert.equal(parsed.events[0].title, target.title);
  assert.equal(parseDayText(`2 мероприятия, ${target.calendar}\n${row(target)}`, target).coverage.complete, false);
  assert.equal(parseDayText(`Мероприятий нет, ${target.calendar}`, target).coverage.complete, true);
  assert.equal(parseDayText('A new, unknown Calendar layout', target).coverage.complete, false);
  assert.equal(parseDayText(`1 мероприятие, ${target.calendar}\n${row({ ...target, title: 'x'.repeat(300) })}`, target).coverage.complete, false);
});

test('free time merges overlaps, ignores verified Free and treats unknown/all-day conservatively', () => {
  const day = { calendar: target.calendar, date: target.date, timeZone: target.timeZone, coverage: { complete: true }, events: [
    { startTime: '10:00', endTime: '11:00', availability: 'busy' },
    { startTime: '10:30', endTime: '12:00', availability: 'unknown' },
    { startTime: '12:00', endTime: '13:00', availability: 'free' },
  ] };
  const free = calculateFreeSlots(day, { fromTime: '09:00', toTime: '14:00', durationMinutes: 60 });
  assert.deepEqual(free.slots, [{ startTime: '09:00', endTime: '10:00' }, { startTime: '12:00', endTime: '14:00' }]);
  assert.equal(free.coverage.conservative, true); assert.equal(free.coverage.complete, false);
  assert.deepEqual(calculateFreeSlots({ ...day, events: [{ allDay: true, availability: 'unknown' }] },
    { fromTime: '09:00', toTime: '14:00', durationMinutes: 5 }).slots, []);
});

test('structured row pagination stays below the real escaped envelope budget and detects a changed observation', () => {
  const events = Array.from({ length: 80 }, (_, n) => ({ ...target, title: `${n} ${'\\"😀'.repeat(50)}` }));
  const result = { events, coverage: { complete: true } }, retained = []; let offset = 0, hash;
  do {
    const page = workflowPage('read-day', { offset }, result);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8000);
    const stdout = JSON.stringify(page);
    const data = { schemaVersion: 1, operation: 'skill_run', stdout };
    assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] })) < 40000);
    if (hash) assert.equal(page.page.observationHash, hash); hash = page.page.observationHash;
    retained.push(...page.events); offset = page.page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(retained, events);
  assert.notEqual(workflowPage('read-day', {}, { ...result, events: events.slice(1) }).page.observationHash, hash);
});

const frame = (controls, text = '', extra = {}) => ({ kind: 'trelio.browser-text/v1', state: 'ready',
  frameId: randomUUID(), title: 'Google Календарь - воскресенье, 12 мая 2030', text, controls,
  width: 1400, height: 900, nextOffset: null, nextControlsOffset: null, scanLimited: false, ...extra });
test('semantic action resolution uses new geometry and refuses duplicate labels without clicking', async () => {
  let x = 10, writes = 0, clicked;
  const ui = new CalendarUI(async (operation, args) => {
    if (operation === 'click') { writes++; clicked = args.x; return frame([]); }
    return frame([{ role: 'button', label: 'Save', x: (x += 9), y: 30 }]);
  });
  await ui.click(['Save']); assert.equal(writes, 1); assert.equal(clicked, x); assert.ok(clicked > 19);
  const ambiguous = new CalendarUI(async () => frame([{ role: 'button', label: 'Save', x: 10, y: 20 },
    { role: 'button', label: 'Save', x: 30, y: 20 }]));
  await assert.rejects(ambiguous.click(['Save']), /CALENDAR_UI_AMBIGUOUS/);
  const exactValue = new CalendarUI(async () => frame([{ role: 'option', label: 'add Work', x: 10, y: 20 }]));
  assert.equal(await exactValue.find(['Work'], ['option'], { optional: true, verbatim: true }), null);
});

/** Stateful synthetic UI, deliberately exposed only as the public text/input
 * protocol. Commits really alter the fake schedule before a reply can be lost;
 * this exercises recovery decisions rather than matching implementation text.
 */
function syntheticCalendar({ loseSave = false, loseDelete = false, recurring = false, fieldMismatch = false, existing = false, hidePersisted = false } = {}) {
  let page = 'day', focus, saved = existing, deleted = false, selected;
  let saveCalls = 0, deleteCalls = 0, lastControls = [];
  const values = { 'Основной часовой пояс': 'Europe/Moscow', 'Начало мероприятия': 'Europe/Moscow',
    'Периодичность': recurring ? 'Каждый день' : 'Не повторяется', 'Календарь': target.calendar, 'Статус': 'Занят/занята', 'Гости': '' };
  const c = (role, label, extras = {}) => ({ role, label, ...extras });
  const account = c('link', 'Аккаунт Google: Synthetic account');
  const controls = () => [account, c('checkbox', target.calendar, { checked: true }), ...({
    day: [c('button', 'Настройки'), c('button', 'Создать'), ...(saved ? [c('button', target.title)] : [])],
    settingsMenu: [c('menuitem', 'Настройки'), c('menuitem', 'Корзина')],
    settings: [c('combobox', 'Основной часовой пояс')],
    createMenu: [c('menuitem', 'Мероприятие')],
    editor: [c('textbox', 'Название'), c('checkbox', 'Весь день', { checked: false }), c('combobox', 'Периодичность'),
      c('combobox', 'Календарь'), c('combobox', 'Статус'), c('button', 'Часовой пояс'), c('button', 'Сохранить'),
      c('button', 'Отменить изменения'), c('combobox', 'Гости'), c('button', 'Добавить видеоконференцию Google Meet'), ...['Дата начала', 'Дата окончания', 'Время начала', 'Время окончания'].map(label => c('textbox', label))],
    calendarOptions: [c('option', target.calendar)], statusOptions: [c('option', 'Свободен/свободна')],
    zone: [c('combobox', 'Начало мероприятия')],
    card: [c('button', 'Изменить мероприятие'), c('button', 'Удалить мероприятие')],
    trash: [c('link', target.calendar), ...(deleted ? [c('button', `Восстановить мероприятие "${target.title}"`)] : [])],
  }[page] || [])];
  function observation(args = {}) {
    const all = controls().map((control, index) => ({ ...control, x: 20 + index * 30, y: 60 }));
    lastControls = all;
    const rendered = page === 'day' ? saved && !(hidePersisted && saveCalls) ? `1 мероприятие, ${target.calendar}\n${row(target)}` : `Мероприятий нет, ${target.calendar}`
      : page === 'card' ? `${target.title}\n${target.calendar}\n12 мая\nСвободен/свободна`
      : page === 'trash' ? `${target.title}\n${target.startTime}` : '';
    return frame(all.filter(control => !args.controlQuery || control.label.toLowerCase().includes(args.controlQuery.toLowerCase())), rendered,
      { ...(page === 'settings' ? { title: 'Google Календарь - Общие настройки' } : {}),
        ...(args.checks ? { fieldChecks: args.checks.map(check => ({ id: check.id,
          state: fieldMismatch && check.label === 'Дата окончания' ? 'different'
            : check.values.some(expected => check.match === 'contains' ? values[check.label]?.includes(expected) : values[check.label] === expected) ? 'matches' : 'different' })) } : {}) });
  }
  return { get saves() { return saveCalls; }, get deletes() { return deleteCalls; }, get saved() { return saved; },
    async call(operation, args = {}) {
      if (operation === 'navigate') page = 'day';
      if (operation === 'type-text') values[focus] = args.text;
      if (operation === 'key' && args.key === 'Escape' && page === 'zone') page = 'editor';
      if (operation === 'click') {
        const control = lastControls.find(control => control.x === args.x && control.y === args.y);
        assert.ok(control, 'only coordinates from the current observation can be clicked');
        const label = control.label;
        if (['textbox', 'combobox'].includes(control.role)) focus = label;
        if (label === 'Настройки') page = page === 'settingsMenu' ? 'settings' : 'settingsMenu';
        else if (label === 'Корзина') page = 'trash';
        else if (label === 'Создать') page = 'createMenu';
        else if (label === 'Мероприятие') page = 'editor';
        else if (label === 'Календарь') { selected = label; page = 'calendarOptions'; }
        else if (label === 'Статус') { selected = label; page = 'statusOptions'; }
        else if (control.role === 'option') { values[selected] = label; page = 'editor'; }
        else if (label === 'Часовой пояс') page = 'zone';
        else if (label === target.title) page = 'card';
        else if (label === 'Изменить мероприятие') page = 'editor';
        else if (label === 'Отменить изменения') page = 'day';
        else if (label === 'Сохранить') {
          saveCalls++; saved = true; page = 'day';
          if (loseSave) throw Error('PRIVATE_LOST_SAVE_REPLY');
        } else if (label === 'Удалить мероприятие') {
          deleteCalls++; saved = false; deleted = true; page = 'day';
          if (loseDelete) throw Error('PRIVATE_LOST_DELETE_REPLY');
        }
      }
      return observation(args);
    } };
}

test('real recipe commits once and reloads the exact event; a lost Save reply stays unknown without replay', async () => {
  const spec = { ...target, availability: 'free', notifications: [], guests: [] };
  const ui = syntheticCalendar();
  const result = await executeWorkflow('create-event', spec, ui.call.bind(ui));
  assert.equal(ui.saves, 1); assert.equal(result.action, 'created');
  const lost = syntheticCalendar({ loseSave: true });
  await assert.rejects(executeWorkflow('create-event', spec, lost.call.bind(lost)), error =>
    error.code === 'CALENDAR_ACTION_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(lost.saves, 1); assert.equal(lost.saved, true, 'the mutation happened even though the reply was lost');
});
test('a changed accepted form value and recurring scope stop before Save', async () => {
  for (const options of [{ fieldMismatch: true }, { recurring: true }]) {
    const ui = syntheticCalendar(options);
    await assert.rejects(executeWorkflow('create-event', target, ui.call.bind(ui)), error =>
      error.code === 'CALENDAR_FORM_UNVERIFIED' && error.outcome === 'not_dispatched');
    assert.equal(ui.saves, 0);
  }
});
test('a lost Delete reply cannot cause a second deletion or a Save', async () => {
  const ui = syntheticCalendar({ existing: true, loseDelete: true });
  await assert.rejects(executeWorkflow('delete-event', { target }, ui.call.bind(ui)), error =>
    error.code === 'CALENDAR_ACTION_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(ui.deletes, 1); assert.equal(ui.saves, 0); assert.equal(ui.saved, false);
});
test('ordinary deletion is verified by fresh day absence and one exact Trash entry', async () => {
  const ui = syntheticCalendar({ existing: true });
  const result = await executeWorkflow('delete-event', { target }, ui.call.bind(ui));
  assert.equal(result.action, 'deleted_to_trash'); assert.equal(ui.deletes, 1); assert.equal(ui.saves, 0);
});
test('English day summaries and all-day rows preserve explicit coverage', () => {
  const parsed = parseDayText(`2 events, ${target.calendar}\nFrom 12:00pm to 12:05pm, ${target.title}, Calendar: ${target.calendar}, No location, May 12, 2030\nAll day, Away, Calendar: ${target.calendar}, May 12, 2030`, target);
  assert.equal(parsed.coverage.complete, true); assert.equal(parsed.events[0].startTime, '12:00');
  assert.equal(parsed.events[1].allDay, true);
});
test('a positive Save without persisted read-back remains unknown and is not sent again', async () => {
  const ui = syntheticCalendar({ hidePersisted: true });
  await assert.rejects(executeWorkflow('create-event', target, ui.call.bind(ui), { sleep: async () => {} }), error =>
    error.code === 'CALENDAR_ACTION_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(ui.saves, 1); assert.equal(ui.saved, true);
});
test('delayed panels are observed again without input replay; an existing quick draft is preserved', async () => {
  let reads = 0, clicks = 0;
  const ui = new CalendarUI(async (operation) => {
    if (operation === 'click') clicks++;
    return frame(++reads < 3 ? [] : [{ role: 'button', label: 'Save', x: reads * 10, y: 50 }]);
  }, { sleep: async () => {} });
  await ui.click(['Save']); assert.equal(clicks, 1); assert.ok(reads >= 5);
  const draft = new CalendarUI(async operation => {
    assert.ok(['status', 'read-text'].includes(operation), 'an existing draft must not receive navigation/input');
    return frame([{ role: 'button', label: 'Сохранить', x: 20, y: 50 }], 'Мероприятие создается.');
  }, { sleep: async () => {} });
  await assert.rejects(draft.start(), /CALENDAR_DRAFT_REQUIRES_AGENT/);
});
