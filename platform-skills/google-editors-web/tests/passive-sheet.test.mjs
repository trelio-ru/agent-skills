import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';
import { executeWorkflow, parseWorkflow } from '../scripts/editor-workflows.mjs';

const url = 'https://docs.google.com/spreadsheets/d/synthetic_spreadsheet/edit#gid=12';
const spec = { url, title: 'Fixture', sheet: 'Example', range: 'A2:B2' };
const csv = 'header,value\r\n001,"12,4"\r\nprivate-outside-the-range,x\r\n';

// Reproduce only the browser's native contract. The fixture has no filesystem
// API for inline transport. An uncertain click or stale file receipt cannot
// be mistaken for the selected cells.
function sheetBrowser({ csvText, address, downloadKind, replySession, changedAfter, expectedInline = true }) {
  let view = 'sheet', frame = 0, received = 0;
  const base = { state: 'ready', reason: 'none', sessionId: 'fixture-session', kind: 'trelio.browser-text/v1',
    title: 'Fixture - Google Sheets', documentReference: address, scanLimited: false, nextControlsOffset: null };
  const perform = async (op, args) => {
    if (op === 'navigate') return base;
    if (op === 'read-text') {
      const item = view === 'sheet' ? { label: 'File', x: 1 } : view === 'file'
        ? { label: 'Download ►', x: 2 } : { label: 'Comma-separated values (.csv)', x: 3 };
      return { ...base, frameId: String(++frame), controls: [{ role: 'menuitem', y: 1, ...item }] };
    }
    if (args.frameId !== String(frame)) throw Error('stale fixture frame');
    if (op === 'click' && (view === 'sheet' && args.x === 1 || view === 'file' && args.x === 2)) {
      view = view === 'sheet' ? 'file' : 'formats';
      return base;
    }
    if (op !== 'download-attachment' || view !== 'formats' || args.x !== 3) throw Error('unexpected browser operation');
    if (expectedInline !== (args.inlineMimeType === 'text/csv')) throw Error('wrong export mode');
    received++;
    view = 'sheet';
    if (changedAfter) base.documentReference = changedAfter;
    return { state: 'ready', reason: 'none', kind: downloadKind, sessionId: replySession, mimeType: 'text/csv',
      ...(downloadKind === 'trelio.browser-inline-text/v1' ? { text: csvText } : { filePath: 'synthetic-fixture.csv' }) };
  };
  return { perform, received: () => received };
}

const normal = { csvText: csv, address: url, replySession: 'fixture-session', downloadKind: 'trelio.browser-inline-text/v1' };

test('inspection from an exact link discovers only its visible editor title and current sheet reference', async () => {
  const command = 'inspect-file', base = url.split('#')[0];
  const inspect = (input, observed) => executeWorkflow(command, parseWorkflow(command, JSON.stringify(input)),
    sheetBrowser({ ...normal, address: observed }).perform);
  assert.deepEqual(await inspect({ url: base }, url), { kind: 'spreadsheets', title: 'Fixture', url });
  await assert.rejects(inspect({ url: base }, url.replace('synthetic_spreadsheet','different_spreadsheet')), /EDITORS_TARGET_UNVERIFIED/);
  await assert.rejects(inspect({ url }, url.replace('gid=12','gid=13')), /EDITORS_TARGET_UNVERIFIED/);
  await assert.rejects(inspect({ url, title: 'Other' }, url), /EDITORS_TARGET_UNVERIFIED/);
});

test('typed same-session CSV is bounded and verified against the exact editor before and after reading', async () => {
  const command = 'read-sheet-range', input = parseWorkflow(command, JSON.stringify(spec));
  assert.deepEqual((await executeWorkflow(command, input, sheetBrowser({ ...normal, csvText: '' }).perform)).values, [['','']]);
  for (const [patch, code] of [
    [{ address: url.replace('gid=12', 'gid=1') }, 'EDITORS_TARGET_UNVERIFIED'],
    [{ changedAfter: url.replace('synthetic_spreadsheet','different_spreadsheet') }, 'EDITORS_TARGET_UNVERIFIED'],
    [{ changedAfter: url.replace('gid=12','gid=13') }, 'EDITORS_TARGET_UNVERIFIED'],
    [{ downloadKind: 'trelio.browser-file/v1' }, 'EDITORS_EXPORT_UNVERIFIED'],
    [{ replySession: 'other-session' }, 'EDITORS_SESSION_CHANGED'],
    [{ csvText: '\uD800' }, 'EDITORS_EXPORT_UNVERIFIED'],
    [{ csvText: 'я'.repeat(1024 * 1024 + 1) }, 'EDITORS_CSV_INVALID'],
  ]) {
    const browser = sheetBrowser({ ...normal, ...patch });
    await assert.rejects(executeWorkflow(command, input, browser.perform), new RegExp(code));
    assert.equal(browser.received(), patch.address ? 0 : 1);
  }
  const file = sheetBrowser({ ...normal, downloadKind: 'trelio.browser-file/v1', expectedInline: false });
  assert.equal((await executeWorkflow('export-file', parseWorkflow('export-file', JSON.stringify({
    url, title: spec.title, format: 'csv',
  })), file.perform)).kind, 'trelio.browser-file/v1');
});

test('the packaged CLI exposes only declared passive commands and never returns the inline transfer or its other rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trelio-editors-passive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = JSON.parse(buildRuntimePackage(fileURLToPath(new URL('../', import.meta.url))).packageBytes);
  for (const item of artifact.files) {
    const target = join(directory, item.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(item.contentBase64, 'base64'));
  }
  const { runEditors } = await import(pathToFileURL(join(directory, 'trelio-google-editors.mjs')));
  const descriptor = JSON.parse(await readFile(join(directory,'trelio-assistant-execution.json'),'utf8'));
  const catalog = await runEditors(['commands'], {});
  assert.equal(descriptor.schemaVersion, 3);
  assert.deepEqual(descriptor.taskCommands.flat().sort(), Object.keys(catalog.commands).filter(c => !['setup','show-login','disconnect'].includes(c)).sort());
  assert.deepEqual(descriptor.readOnlyCommands.flat().sort(),
    ['commands','guides','doctor','inspect-file','select-sheet','read-sheet-range','find-sheet-rows'].sort());

  // Feed the same materialized entrypoint an old and a new host. The old
  // host would persist a normal download if called; reject it before any I/O.
  const markers = ['PRESENTATION','SEMANTIC_CONTROLS','FORM_CHECKS','ATTACHMENT_REDIRECT','EMBEDDED_PICKER','DOCUMENT_REFERENCE']
    .map(name => "export const VISUAL_" + name + "_API = 'trelio.visual-" + name.toLowerCase().replaceAll('_','-') + "/v1';").join('\n');
  const oldHost = join(directory,'old.mjs'), host = join(directory,'host.mjs');
  await writeFile(oldHost, markers + "\nexport function runVisualSession(){throw Error('old host should receive no operation')}");
  await writeFile(host, markers + "\nexport const VISUAL_INLINE_TEXT_API='trelio.browser-inline-text/v1';\n" + sheetBrowser.toString()
    + '\nexport const runVisualSession=({operation,args})=>browser.perform(operation,args);\nconst browser=sheetBrowser(' + JSON.stringify(normal) + ');');
  const env = file => ({ TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(file).href, TRELIO_SKILL_ID: 'google-editors-web' });
  const before = await readdir(directory);
  for (const [name, input, key, expected] of [
    ['read-sheet-range', spec, 'values', [['001','12,4']]],
    ['find-sheet-rows', { ...spec, column: 1, value: '001' }, 'matches', [{ row: 2, values: ['001','12,4'] }]],
  ]) {
    const argv = [name, '--spec', JSON.stringify(input)];
    assert.equal((await runEditors(argv, env(oldHost))).code, 'EDITORS_HOST_UPGRADE_REQUIRED');
    assert.deepEqual(await runEditors(argv, env(host)), {
      schemaVersion: 1, state: 'ready', sheet: 'Example', range: 'A2:B2', representation: 'displayed_values', [key]: expected,
    });
    assert.equal((await runEditors([...argv,'--operation','download-attachment'], env(host))).code, 'EDITORS_COMMAND_INVALID');
    assert.equal((await runEditors([name,'--spec',JSON.stringify({ ...input, operation: 'click' })], env(host))).code, 'EDITORS_SPEC_INVALID');
  }
  assert.deepEqual(await readdir(directory), before);
});

test('sheet selection accepts only an exact menu item exposed by All sheets and checks its gid or active option', async () => {
  const name = 'select-sheet';
  const input = parseWorkflow(name, JSON.stringify({ url, title: 'Fixture', sheet: 'Example' }));
  const other = url.replace('gid=12', 'gid=13');
  async function select({ unrelatedMenu = false, active = false, next = other }) {
    let view = 'sheet', address = url;
    return executeWorkflow(name, input, async (operation, args) => {
      const base = { kind: 'trelio.browser-text/v1', state: 'ready', reason: 'none', sessionId: 'fixture',
        title: 'Fixture - Google Sheets', documentReference: address };
      if (operation === 'navigate') return base;
      if (operation === 'click') {
        if (args.x === 1 && view === 'sheet') view = 'menu';
        else if (args.x === 2 && view === 'menu') { view = 'selected'; address = next; }
        else assert.fail('unexpected click');
        return base;
      }
      assert.equal(operation, 'read-text');
      const tab = { role: active ? 'option' : 'button', label: 'Example', x: 0, ...(active ? { selected: true } : {}) };
      const controls = [tab, { role: 'button', label: 'All sheets', x: 1 }];
      if (unrelatedMenu || view === 'menu') controls.push({ role: 'menuitem', label: 'Example', x: 2 });
      return { ...base, frameId: 'fresh', scanLimited: false, nextControlsOffset: null, controls };
    });
  }
  assert.deepEqual(await select({}), { sheet: 'Example', url: other });
  assert.deepEqual(await select({ next: url, active: true }), { sheet: 'Example', url });
  await assert.rejects(select({ unrelatedMenu: true }), /EDITORS_TARGET_AMBIGUOUS/);
  await assert.rejects(select({ next: url }), /EDITORS_TARGET_UNVERIFIED/);
  await assert.rejects(select({ next: url.replace('synthetic_spreadsheet','other_spreadsheet') }), /EDITORS_TARGET_UNVERIFIED/);
});
