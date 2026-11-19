import { parseRange, readExportBytes, readTextExport, sliceCsv } from './editor-data.mjs';
import { selectExportedFormulas, selectExportedHeadings } from './office-export.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const EDITORS = 'https://docs.google.com';
const UI = Object.freeze({
  edit: ['Edit', 'Правка'],
  findReplace: ['Find and replace', 'Найти и заменить'],
  find: ['Find', 'Найти'],
  replacement: ['Replace with', 'Заменить на'],
  replace: ['Replace', 'Заменить'],
  close: ['Close', 'Закрыть', 'Done', 'Готово'],
  matchCase: ['Match case', 'Учитывать регистр'],
  regex: ['Match using regular expressions', 'Использовать регулярные выражения'],
  accents: ['Ignore diacritics', 'Игнорировать диакритические знаки'],
  file: ['File', 'Файл'],
  download: ['Download', 'Скачать'],
  rename: ['Rename', 'Переименовать'],
  addSheet: ['Add sheet', 'Добавить лист'],
  allSheets: ['All sheets', 'Все листы'],
  importSheet: ['Import', 'Импортировать'],
  showDocumentTabs: ['Show tabs and outlines', 'Показать вкладки и их структуру'],
  hideDocumentTabs: ['Hide tabs and outlines', 'Скрыть вкладки и их структуру'],
  copy: ['Make a copy', 'Создать копию'],
  copyName: ['Name', 'Название'],
  copyShares: ['Share it with the same people', 'Скопировать настройки доступа'],
  copyComments: ['Copy comments and suggestions', 'Скопировать комментарии и предложенные исправления'],
});

export const fieldCheckPolicy = {
  origins: [EDITORS],
  labels: [...UI.find, ...UI.replacement, ...UI.rename, ...UI.copyName],
};
const downloadFormats = {
  csv: { kind: 'spreadsheets', mime: 'text/csv', label: /(?:CSV|запятыми)/iu, query: ['Comma', 'Формат'] },
  xlsx: { kind: 'spreadsheets', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: /XLSX/iu, query: ['Microsoft', 'Microsoft'] },
  txt: { kind: 'document', mime: 'text/plain', label: /(?:TXT|plaintext)/iu, query: ['Plain', 'Текст в формате'] },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: /DOCX/iu, query: ['Microsoft', 'Microsoft'] },
  pdf: { kind: 'document', mime: 'application/pdf', label: /PDF/iu, query: ['Document', 'Документ'] },
};

export class EditorFailure extends Error {
  constructor(code, stage = 'preflight', outcome = 'not_dispatched') {
    super(code);
    this.code = code;
    this.stage = stage;
    this.outcome = outcome;
  }
}

// Admit editor navigation, never download URLs, sign-in callbacks supplied by
// the model, Drive sharing links or invented private Google service endpoints.
export function editorLink(value, requiredKind) {
  let url;
  try { url = new URL(value); } catch { throw new EditorFailure('EDITORS_TARGET_INVALID'); }
  const match = /^\/(document|spreadsheets)\/d\/([A-Za-z0-9_-]{12,180})\/edit\/?$/u.exec(url.pathname);
  if (url.origin !== EDITORS || url.username || url.password || !match || requiredKind && match[1] !== requiredKind) {
    throw new EditorFailure('EDITORS_TARGET_INVALID');
  }
  const [kind, id] = match.slice(1);
  const uiKey = kind === 'document' ? 'tab' : 'gid';
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    if (seen.has(name) || (name !== uiKey && !(name === 'usp' && ['sharing', 'drive_link'].includes(value)))) {
      throw new EditorFailure('EDITORS_TARGET_INVALID');
    }
    seen.add(name);
  }
  const tab = url.searchParams.get(uiKey);
  const gridFragment = /^#gid=(\d{1,14})$/u.exec(url.hash);
  if (kind === 'document') {
    if (url.hash || (tab !== null && !/^t\.[A-Za-z0-9_-]{1,80}$/u.test(tab))) throw new EditorFailure('EDITORS_TARGET_INVALID');
    url.search = tab === null ? '' : '?tab=' + tab;
  } else {
    if (url.hash && !gridFragment || tab !== null && !/^\d{1,14}$/u.test(tab) || tab !== null && gridFragment && tab !== gridFragment[1]) {
      throw new EditorFailure('EDITORS_TARGET_INVALID');
    }
    url.search = '';
    url.hash = tab !== null ? '#gid=' + tab : url.hash;
  }
  return { kind, id, url: url.href };
}

export const workflowCommands = Object.freeze([
  'inspect-file', 'find-document-text', 'replace-document-text', 'read-document', 'read-sheet-range', 'find-sheet-rows', 'export-file',
  'create-document', 'create-spreadsheet', 'rename-file', 'add-sheet', 'select-sheet', 'read-document-outline', 'read-document-section',
  'read-sheet-formulas', 'open-sheet-import', 'show-document-tabs', 'copy-document',
]);

const fields = {
  'inspect-file': [],
  'find-document-text': ['search'],
  'replace-document-text': ['search', 'replacement'],
  'read-document': [],
  'read-document-outline': [],
  'read-document-section': ['offset', 'limit'],
  'read-sheet-range': ['sheet', 'range'],
  'read-sheet-formulas': ['sheet', 'range'],
  'find-sheet-rows': ['sheet', 'range', 'column', 'value'],
  'export-file': ['format'],
  'rename-file': ['newTitle'],
  'add-sheet': [],
  'select-sheet': ['sheet'],
  'open-sheet-import': [],
  'show-document-tabs': [],
  'copy-document': ['newTitle', 'destination'],
};
const createKind = { 'create-document': 'document', 'create-spreadsheet': 'spreadsheets' };
const titleLabels = { document: ['Google Docs', 'Google Документы'], spreadsheets: ['Google Sheets', 'Google Таблицы'] };
const newTitles = { document: ['Untitled document', 'Новый документ'], spreadsheets: ['Untitled spreadsheet', 'Новая таблица'] };

function regularText(value, limit, allowEmpty = false) {
  return typeof value === 'string' && value.length <= limit && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(value) && value === value.trim();
}

export function parseWorkflow(name, raw) {
  let spec;
  try { spec = JSON.parse(raw); } catch { throw new EditorFailure('EDITORS_SPEC_INVALID'); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new EditorFailure('EDITORS_SPEC_INVALID');
  if (Object.hasOwn(createKind, name)) {
    if (Object.keys(spec).length !== 1 || !regularText(spec.title, 180)) throw new EditorFailure('EDITORS_SPEC_INVALID');
    return { kind: createKind[name], newTitle: spec.title };
  }
  if (!Object.hasOwn(fields, name)) throw new EditorFailure('EDITORS_SPEC_INVALID');
  const required = ['url', 'title', ...fields[name]];
  if (Object.keys(spec).length !== required.length || required.some(key => !Object.hasOwn(spec, key))
      || !regularText(spec.title, 180) || !regularText(spec.url, 480)) throw new EditorFailure('EDITORS_SPEC_INVALID');
  for (const field of ['search', 'replacement', 'sheet', 'value'].filter(key => required.includes(key))) {
    if (!regularText(spec[field], field === 'sheet' ? 100 : 240, field === 'value')) throw new EditorFailure('EDITORS_SPEC_INVALID');
  }
  if (name === 'replace-document-text' && (spec.search.includes(spec.replacement) || spec.replacement.includes(spec.search))) {
    throw new EditorFailure('EDITORS_SPEC_INVALID');
  }
  if (['rename-file', 'copy-document'].includes(name) && (!regularText(spec.newTitle, 180) || spec.newTitle === spec.title))
    throw new EditorFailure('EDITORS_SPEC_INVALID');
  if (name === 'copy-document' && spec.destination !== 'my_drive') throw new EditorFailure('EDITORS_SPEC_INVALID');
  if (name === 'read-document-section' && (!Number.isSafeInteger(spec.offset) || spec.offset < 0 || spec.offset > 2 * 1024 * 1024
      || !Number.isSafeInteger(spec.limit) || spec.limit < 1 || spec.limit > 2000)) throw new EditorFailure('EDITORS_SPEC_INVALID');
  const link = editorLink(spec.url, name.includes('document') ? 'document' : name.includes('sheet') ? 'spreadsheets' : undefined);
  if (name === 'export-file' && (!Object.hasOwn(downloadFormats, spec.format) || downloadFormats[spec.format].kind !== link.kind)) {
    throw new EditorFailure('EDITORS_SPEC_INVALID');
  }
  if (['add-sheet', 'select-sheet', 'open-sheet-import'].includes(name) && !new URL(link.url).hash) throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
  if (required.includes('range')) {
    // The name is for the human reader. The URL's gid identifies the sheet
    // even when another tab has a similar name or the toolbar is repainted.
    if (!new URL(link.url).hash) throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
    const bounds = parseRange(spec.range);
    if (Object.hasOwn(spec, 'column') && (!Number.isSafeInteger(spec.column) || spec.column < bounds.startColumn || spec.column > bounds.endColumn)) {
      throw new EditorFailure('EDITORS_SPEC_INVALID');
    }
  }
  return { ...spec, ...link };
}

const findMenu = /^(?:Find and replace|Найти и заменить)(?: [⌘Ctrl].*)?$/u;
const downloadMenu = /^(?:Download|Скачать)(?: [►▸])?$/u;
const findOptions = [[UI.regex, false], [UI.accents, false], [UI.matchCase, true]];

function labelledOption(label, prefix) {
  return label === prefix || (label.startsWith(prefix + ' (') && label.endsWith(')'));
}

class Editor {
  constructor(perform, spec, platform) {
    this.perform = perform;
    this.spec = spec;
    this.platform = platform;
    this.sessionId = null;
    this.stage = 'preflight';
  }

  async call(operation, args) {
    return this.acceptReady(await this.perform(operation, args));
  }

  acceptReady(value) {
    if (value?.state !== 'ready') {
      const codes = { document_blocked: 'EDITORS_DOCUMENT_BLOCKED', attachment_unsupported: 'EDITORS_EXPORT_UNVERIFIED',
        attachment_link_required: 'EDITORS_UI_UNSUPPORTED', attachment_too_large: 'EDITORS_RESULT_TOO_LARGE' };
      const code = value?.state === 'manual_input_required' ? 'EDITORS_MANUAL_INPUT_REQUIRED' : codes[value?.reason];
      throw new EditorFailure(code || 'EDITORS_BROWSER_UNAVAILABLE', this.stage);
    }
    if (typeof value.sessionId !== 'string' || this.sessionId && value.sessionId !== this.sessionId) throw new EditorFailure('EDITORS_SESSION_CHANGED');
    this.sessionId = value.sessionId;
    return value;
  }

  async observe(args = {}, { allowedTitles = [this.spec.title], allowNewSheet = false } = {}) {
    const frame = await this.call('read-text', { includeControls: true, ...args });
    return this.verifyTarget(frame, allowedTitles, allowNewSheet);
  }

  verifyTarget(frame, allowedTitles = [this.spec.title], allowNewSheet = false) {
    if (frame.kind !== 'trelio.browser-text/v1') throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
    if (!titleLabels[this.spec.kind].some(label => allowedTitles.some(title => frame.title === title + ' - ' + label))) {
      throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
    }
    let observed;
    try { observed = editorLink(frame.documentReference, this.spec.kind); }
    catch { throw new EditorFailure('EDITORS_TARGET_UNVERIFIED'); }
    const target = new URL(this.spec.url);
    const address = new URL(observed.url);
    if (observed.id !== this.spec.id || target.pathname !== address.pathname
      || (!allowNewSheet && target.hash && target.hash !== address.hash) || (target.search && target.search !== address.search)) {
      throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
    }
    return frame;
  }

  async reopen() {
    await this.navigate(this.spec.url);
    return this.observe();
  }

  async prepareReplacement() {
    this.stage = 'document_observation';
    const frame = await this.perform('read-text', { includeControls: true });
    // The exact live file/tab can go straight to the baseline export. Reloading
    // it adds a navigation before the one reviewed write and can discard the
    // editor. Reuse requires fresh host evidence, including the full selector.
    // A protected refusal must never turn into a navigation or an input.
    if (frame?.state !== 'preparing' && !(frame?.state === 'error' && frame.reason === 'session_closed')) {
      const ready = this.acceptReady(frame);
      if (ready.kind !== 'trelio.browser-text/v1') throw new EditorFailure('EDITORS_UI_UNSUPPORTED', this.stage);
      if (ready.documentReference === this.spec.url) return this.verifyTarget(ready);
    }
    this.stage = 'document_navigation';
    return this.reopen();
  }

  async navigate(url) {
    // A cold owner can acknowledge navigation before the browser boots.
    // Wait for this original dispatch; never re-issue it as a retry.
    let started = await this.perform('navigate', { url });
    if (started?.state === 'preparing') {
      const until = performance.now() + 25_000;
      do {
        started = await this.perform('wait', {});
        if (!['preparing', 'saved_unverified'].includes(started?.state)) break;
        await delay(250);
      } while (performance.now() < until);
    }
    return this.acceptReady(started);
  }

  async control(labels, role, query = undefined, predicate = () => true) {
    const frame = await this.observe(query ? { controlQuery: query } : {});
    const controls = frame.controls.filter(item => item.role === role && (typeof labels === 'function'
      ? labels(item.label) : labels instanceof RegExp ? labels.test(item.label) : labels.includes(item.label)) && predicate(item));
    if (controls.length !== 1 || frame.nextControlsOffset !== null || frame.scanLimited) throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
    return { frame, item: controls[0] };
  }

  async localized(labels, role) {
    for (const label of labels) {
      try { return await this.control([label], role, label); }
      catch (error) {
        if (!(error instanceof EditorFailure) || error.code !== 'EDITORS_UI_UNSUPPORTED') throw error;
      }
    }
    throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
  }

  async click({ frame, item }) {
    return this.call('click', { frameId: frame.frameId, x: item.x, y: item.y });
  }

  async setField(labels, value, id) {
    const control = await this.localized(labels, 'textbox');
    await this.click(control);
    const frame = await this.observe();
    await this.call('key', { frameId: frame.frameId, key: this.platform === 'darwin' ? 'Meta+A' : 'Control+A' });
    const entry = await this.observe();
    await this.call('type-text', { frameId: entry.frameId, text: value });
    return { id, label: control.item.label, match: 'equals', values: [value] };
  }

  async openFindDialog() {
    await this.click(await this.localized(UI.edit, 'menuitem'));
    const primary = (await this.observe()).title.endsWith('Google Документы') ? UI.findReplace[1] : UI.findReplace[0];
    await this.click(await this.control(findMenu, 'menuitem', primary));
    // These toggles are potentially remembered by Google, including the
    // live default to ignore accents. Read them again on the final frame.
    for (const [aliases, expected] of findOptions) {
      const prefix = aliases[Number(primary === UI.findReplace[1])];
      const toggle = await this.control(label => labelledOption(label, prefix), 'checkbox', prefix);
      if (typeof toggle.item.checked !== 'boolean') throw new EditorFailure('EDITORS_FIND_MODE_UNVERIFIED');
      if (toggle.item.checked !== expected) await this.click(toggle);
    }
  }

  async count(checks) {
    const frame = await this.observe({ checks });
    if (frame.scanLimited || frame.nextOffset !== null || checks.some(check =>
      !frame.fieldChecks?.some(result => result.id === check.id && result.state === 'matches'))) {
      throw new EditorFailure('EDITORS_FIND_UNVERIFIED');
    }
    if (!findOptions.every(([aliases, expected]) => {
      const matching = frame.controls.filter(item => item.role === 'checkbox' && aliases.some(prefix => labelledOption(item.label, prefix)));
      return matching.length === 1 && matching[0].checked === expected;
    })) throw new EditorFailure('EDITORS_FIND_MODE_UNVERIFIED');
    const counts = frame.text.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(?:из|of)\s+(\d+)\s*$/u.exec(line);
      return match ? [[Number(match[1]), Number(match[2])]] : [];
    });
    if (counts.length !== 1 || counts[0][0] > counts[0][1] || !Number.isSafeInteger(counts[0][1])) throw new EditorFailure('EDITORS_FIND_UNVERIFIED');
    return { count: counts[0][1], frame };
  }

  async closeFindDialog() {
    await this.click(await this.localized(UI.close, 'button'));
  }

  async findCount(text) {
    const field = await this.setField(UI.find, text, 'search');
    const result = await this.count([field]);
    return result.count;
  }

  async waitForSave() {
    const russian = /Google (Таблицы|Документы)$/u.test((await this.observe()).title);
    const query = russian ? 'статус документа' : 'document status';
    const saved = russian ? /^Статус документа: Сохранено на Диске[.! ]*$/u : /^Document status: Saved to Drive[.! ]*$/u;
    const until = performance.now() + 12_000;
    do {
      const status = await this.observe({ controlQuery: query });
      if (status.controls.some(item => item.role === 'button' && saved.test(item.label))) return;
      await delay(250);
    } while (performance.now() < until);
    throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
  }
}

async function renameFile(editor, newTitle) {
  const rename = await editor.localized(UI.rename, 'textbox');
  await editor.click(rename);
  const previous = await editor.observe();
  await editor.call('key', { frameId: previous.frameId, key: editor.platform === 'darwin' ? 'Meta+A' : 'Control+A' });
  const frame = await editor.observe();
  const check = { id: 'title', label: rename.item.label, match: 'equals', values: [newTitle] };
  try {
    // Title fields can save on blur; treat the first typing as the possible
    // mutation. No retry can follow an ambiguous native reply.
    await editor.call('type-text', { frameId: frame.frameId, text: newTitle });
    const interim = await editor.observe({ checks: [check] }, { allowedTitles: [editor.spec.title, newTitle] });
    if (!interim.fieldChecks?.some(value => value.id === check.id && value.state === 'matches')) throw Error('unverified title input');
    await editor.call('key', { frameId: interim.frameId, key: 'Enter' });
    editor.spec = { ...editor.spec, title: newTitle };
    await editor.waitForSave();
    const checked = await editor.reopen();
    return { outcome: 'verified', title: newTitle, url: checked.documentReference };
  } catch {
    throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
  }
}

async function addSheet(editor) {
  const { spec } = editor;
  const russian = (await editor.observe()).title.endsWith('Google Таблицы');
  const query = russian ? 'Лист' : 'Sheet';
  const defaultName = russian ? /^Лист\s*\d+$/u : /^Sheet\s*\d+$/u;
  const before = await editor.observe({ controlQuery: query });
  if (before.scanLimited || before.nextControlsOffset !== null) throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
  const original = new Set(before.controls.filter(item => item.role === 'button' && defaultName.test(item.label)).map(item => item.label));
  const add = await editor.localized(UI.addSheet, 'button');
  try {
    // Google's control creates and selects one sheet. Verify both the new
    // tab identity and its rendered name while keeping the original file ID.
    try { await editor.click(add); } catch { /* Only read-back is allowed. */ }
    const after = await editor.observe({ controlQuery: query }, { allowNewSheet: true });
    const target = new URL(after.documentReference);
    const names = after.controls.filter(item => item.role === 'button' && defaultName.test(item.label) && !original.has(item.label));
    if (after.scanLimited || after.nextControlsOffset !== null || !target.hash || target.hash === new URL(spec.url).hash || names.length !== 1) {
      throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
    }
    editor.spec = { ...spec, url: target.href };
    await editor.waitForSave();
    const verified = await editor.reopen();
    await editor.control([names[0].label], 'button', names[0].label);
    return { outcome: 'verified', sheet: names[0].label, url: verified.documentReference };
  } catch {
    throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
  }
}

async function selectSheet(editor, sheet) {
  await editor.click(await editor.localized(UI.allSheets, 'button'));
  let target;
  try {
    target = await editor.control([sheet], 'menuitem', sheet);
  } catch (error) {
    // Opening the sheet menu is local UI state. Close it on the original
    // file so the visual fallback can inspect the tabs instead of guessing.
    const frame = await editor.observe();
    await editor.call('key', { frameId: frame.frameId, key: 'Escape' });
    throw error;
  }
  await editor.click(target);
  const selected = await editor.observe({ controlQuery: sheet }, { allowNewSheet: true });
  const opened = new URL(selected.documentReference);
  if (!opened.hash || opened.hash === new URL(editor.spec.url).hash || selected.nextControlsOffset !== null
      || !selected.controls.some(item => item.role === 'button' && item.label === sheet)) {
    throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
  }
  return { sheet, url: opened.href };
}

async function showDocumentTabs(editor) {
  // The sidebar toggle changes only presentation. If the tabs are already
  // visible, preserve the current pane and the selected document tab.
  let show;
  try { show = await editor.localized(UI.showDocumentTabs, 'button'); }
  catch (error) { if (error.code !== 'EDITORS_UI_UNSUPPORTED') throw error; }
  if (show) await editor.click(show);
  await editor.localized(UI.hideDocumentTabs, 'button');
  return { outcome: 'tabs_visible', url: editor.spec.url };
}

async function createFile(editor, spec) {
  try {
    // This is Google's ordinary browser creation page. Navigation itself
    // creates the file, hence all subsequent failures keep an unknown fence.
    await editor.navigate(EDITORS + '/' + spec.kind + '/create');
    const frame = await editor.call('read-text', { includeControls: true });
    const created = editorLink(frame.documentReference, spec.kind);
    const title = newTitles[spec.kind].find(candidate =>
      titleLabels[spec.kind].some(label => frame.title === candidate + ' - ' + label));
    if (!title) throw Error('unexpected creation page');
    editor.spec = { ...created, title };
    if (title === spec.newTitle) return { outcome: 'verified', title, url: created.url };
    return await renameFile(editor, spec.newTitle);
  } catch {
    throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
  }
}

async function copyDocument(editor, spec) {
  if (new URL(spec.url).search) throw new EditorFailure('EDITORS_TARGET_UNVERIFIED');
  const russian = (await editor.observe()).title.endsWith('Google Документы');
  const folder = russian ? 'Кнопка для выбора папки. Сейчас выбрана папка "Мой диск".' : 'Folder picker. Currently selected folder is "My Drive".';
  await editor.click(await editor.localized(UI.file, 'menuitem'));
  await editor.click(await editor.localized(UI.copy, 'menuitem'));
  const name = await editor.setField(UI.copyName, spec.newTitle, 'copy_title');
  // Tying all checks to the same observation avoids copying inherited
  // sharing or comments when Google restores earlier dialog preferences.
  const dialog = await editor.observe({ checks: [name] });
  const checks = [UI.copyShares, UI.copyComments].every(labels => {
    const options = dialog.controls.filter(item => item.role === 'checkbox' && labels.includes(item.label));
    return options.length === 1 && options[0].checked === false;
  });
  const destination = dialog.controls.filter(item => item.role === 'button' && item.label === folder);
  const confirm = dialog.controls.filter(item => item.role === 'button' && UI.copy.includes(item.label));
  if (!checks || destination.length !== 1 || confirm.length !== 1 || dialog.scanLimited || dialog.nextControlsOffset !== null
      || !dialog.fieldChecks?.some(result => result.id === name.id && result.state === 'matches')) throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
  try {
    try { await editor.click({ frame: dialog, item: confirm[0] }); } catch { /* Verify the original copy only. */ }
    const until = performance.now() + 15_000;
    do {
      const frame = await editor.call('read-text', { includeControls: true });
      if (frame.kind === 'trelio.browser-text/v1' && frame.documentReference
          && titleLabels.document.some(label => frame.title === spec.newTitle + ' - ' + label)) {
        const copied = editorLink(frame.documentReference, 'document');
        if (copied.id !== spec.id) return { outcome: 'verified', title: spec.newTitle, url: copied.url };
      }
      await delay(250);
    } while (performance.now() < until);
  } catch { /* The copy click is never replayed. */ }
  throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
}

async function replaceDocument(editor, spec) {
  // Compare a fresh Google export before opening the modal. Checking only
  // the new phrase after saving could miss a second or an adjacent edit.
  editor.stage = 'baseline_export';
  const before = (await exportDocumentText(editor)).replaceAll('\r\n', '\n');
  const at = before.indexOf(spec.search);
  if (at < 0 || before.indexOf(spec.search, at + 1) !== -1) throw new EditorFailure('EDITORS_TARGET_AMBIGUOUS');
  if (before.includes(spec.replacement)) throw new EditorFailure('EDITORS_REPLACEMENT_ALREADY_PRESENT');
  const expected = before.slice(0, at) + spec.replacement + before.slice(at + spec.search.length);
  editor.stage = 'replace_dialog';
  await editor.openFindDialog();
  const search = await editor.setField(UI.find, spec.search, 'search');
  const replacement = await editor.setField(UI.replacement, spec.replacement, 'replacement');
  // Use one frame for the input check, mode, count and final button. Its token
  // is consumed on dispatch, so no other observations may intervene.
  const result = await editor.count([search, replacement]);
  if (result.count !== 1) throw new EditorFailure('EDITORS_TARGET_AMBIGUOUS');
  const buttons = result.frame.controls.filter(item => item.role === 'button' && UI.replace.includes(item.label));
  if (buttons.length !== 1) throw new EditorFailure('EDITORS_UI_UNSUPPORTED');
  // The final click never gets another attempt. Even a failed observation
  // can follow a successful Google autosave. Close the modal and use a fresh
  // server export in the same editor. Reloading immediately after Replace
  // can interrupt autosave or open Chrome's protected beforeunload handoff.
  try {
    try { await editor.click({ frame: result.frame, item: buttons[0] }); }
    catch { /* The only operation left is the read-back. */ }
    await editor.closeFindDialog();
    const after = (await exportDocumentText(editor)).replaceAll('\r\n', '\n');
    if (after !== expected) throw new EditorFailure('EDITORS_READBACK_MISMATCH');
    return { outcome: 'verified', replacementCount: 1, originalCount: 0, verification: 'fresh_text_export' };
  } catch {
    throw new EditorFailure('EDITORS_ACTION_UNKNOWN', 'readback', 'unknown');
  }
}

async function download(editor, format) {
  const before = await editor.observe();
  await editor.click(await editor.localized(UI.file, 'menuitem'));
  const russian = /Google (Таблицы|Документы)$/u.test(before.title);
  const downloadLabel = UI.download[Number(russian)];
  await editor.click(await editor.control(downloadMenu, 'menuitem', downloadLabel));
  // Google wraps the marked shortcut letter in a separate rendered element
  // (`Формат C SV` / `Текст в формате T XT`). Join whitespace only for the
  // type label, and still require one exact visible menu destination.
  const rule = downloadFormats[format];
  const { frame, item } = await editor.control(label => rule.label.test(label.replace(/\s+/gu, '')), 'menuitem', rule.query[Number(russian)]);
  const receipt = await editor.call('download-attachment', { frameId: frame.frameId, x: item.x, y: item.y });
  const after = await editor.observe();
  if (receipt.kind !== 'trelio.browser-file/v1' || receipt.mimeType !== rule.mime || before.documentReference !== after.documentReference) {
    throw new EditorFailure('EDITORS_EXPORT_UNVERIFIED');
  }
  return receipt;
}

async function exportDocumentText(editor) {
  const receipt = await download(editor, 'txt');
  return readTextExport(receipt, 'text/plain', editor.sessionId);
}

async function officeExport(editor, format) {
  const receipt = await download(editor, format);
  return readExportBytes(receipt, downloadFormats[format].mime, editor.sessionId, 20 * 1024 * 1024);
}

async function readDocumentSection(editor, { offset, limit }) {
  const document = Array.from(await exportDocumentText(editor));
  if (offset > document.length) throw new EditorFailure('EDITORS_SPEC_INVALID');
  const next = Math.min(offset + limit, document.length);
  return { text: document.slice(offset, next).join(''), offset, nextOffset: next < document.length ? next : null,
    representation: 'plain_text_export' };
}

export async function executeWorkflow(name, spec, perform, { platform = process.platform } = {}) {
  if (!workflowCommands.includes(name)) throw new EditorFailure('EDITORS_SPEC_INVALID');
  const editor = new Editor(perform, spec, platform);
  if (Object.hasOwn(createKind, name)) return createFile(editor, spec);
  if (name === 'replace-document-text') {
    await editor.prepareReplacement();
    return replaceDocument(editor, spec);
  }
  await editor.reopen();
  if (name === 'inspect-file') return { kind: spec.kind, title: spec.title, url: spec.url };
  if (name === 'rename-file') return renameFile(editor, spec.newTitle);
  if (name === 'add-sheet') return addSheet(editor);
  if (name === 'select-sheet') return selectSheet(editor, spec.sheet);
  if (name === 'show-document-tabs') return showDocumentTabs(editor);
  if (name === 'copy-document') return copyDocument(editor, spec);
  if (name === 'open-sheet-import') {
    await editor.click(await editor.localized(UI.file, 'menuitem'));
    await editor.click(await editor.localized(UI.importSheet, 'menuitem'));
    return { title: spec.title, url: spec.url, outcome: 'import_menu_selected' };
  }
  if (name === 'export-file') return download(editor, spec.format);
  if (name === 'read-document-section') return readDocumentSection(editor, spec);
  if (name === 'read-document-outline') {
    return selectExportedHeadings(await officeExport(editor, 'docx'));
  }
  if (name === 'read-sheet-formulas') {
    return { sheet: spec.sheet, range: spec.range, ...selectExportedFormulas(await officeExport(editor, 'xlsx'), spec.sheet, spec.range) };
  }
  if (name === 'read-document') {
    const document = await exportDocumentText(editor);
    if (Buffer.byteLength(JSON.stringify(document)) > 14_000) throw new EditorFailure('EDITORS_RESULT_TOO_LARGE');
    return { text: document, representation: 'plain_text_export' };
  }
  if (name === 'find-document-text') {
    await editor.openFindDialog();
    const count = await editor.findCount(spec.search);
    await editor.closeFindDialog();
    return { count };
  }
  const csv = await download(editor, 'csv');
  const values = sliceCsv(await readTextExport(csv, 'text/csv', editor.sessionId), spec.range);
  const { startColumn, startRow } = parseRange(spec.range);
  const result = name === 'find-sheet-rows' ? values.flatMap((row, offset) =>
    row[spec.column - startColumn] === spec.value ? [{ row: startRow + offset, values: row }] : []) : values;
  if (Buffer.byteLength(JSON.stringify(result)) > 14_000) throw new EditorFailure('EDITORS_RESULT_TOO_LARGE');
  return { sheet: spec.sheet, range: spec.range, representation: 'displayed_values', [name === 'find-sheet-rows' ? 'matches' : 'values']: result };
}
