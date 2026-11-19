import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeWorkflow, parseWorkflow } from '../scripts/editor-workflows.mjs';
import { parseCommand, runEditors } from '../scripts/trelio-google-editors.mjs';

const docUrl = 'https://docs.google.com/document/d/synthetic_document_1234/edit';
const sheetUrl = 'https://docs.google.com/spreadsheets/d/synthetic_sheet_1234/edit#gid=0';
const docSpec = { url: docUrl, title: 'Fixture', search: 'first marker', replacement: 'second marker' };

test('validate the exact editor URL and command before touching the host', async () => {
  assert.deepEqual(await runEditors(['__trelio_accounts_import'], {}), { schemaVersion: 1, accounts: [] });
  assert.equal((await runEditors(['replace-document-text', '--spec', '{}'], {})).code, 'EDITORS_SPEC_INVALID');
  assert.equal((await runEditors(['navigate', '--url', docUrl], {})).code, 'EDITORS_HOST_REQUIRED');
  assert.equal(parseCommand(['navigate', '--url', sheetUrl]).args.url, sheetUrl);
  assert.equal(parseCommand(['navigate', '--url', docUrl + '?usp=sharing']).args.url, docUrl);
  assert.equal(parseCommand(['navigate', '--url', docUrl + '?usp=drive_link&tab=t.0']).args.url, docUrl + '?tab=t.0');
  assert.equal(parseCommand(['navigate', '--url', sheetUrl.replace('#gid', '?gid') + '&usp=sharing']).args.url, sheetUrl);
  assert.throws(() => parseCommand(['navigate', '--url', sheetUrl.replace('#gid', '?gid') + '#gid=3']), /EDITORS_TARGET_INVALID/u);
  assert.throws(() => parseCommand(['navigate', '--url', docUrl.replace('/edit', '/export?format=txt')]), /EDITORS_TARGET_INVALID/u);
  assert.throws(() => parseCommand(['navigate', '--url', docUrl.replace('.com/', '.com.evil.test/')]), /EDITORS_TARGET_INVALID/u);
  assert.throws(() => parseCommand(['navigate', '--url', docUrl + '?token=abcdef']), /EDITORS_TARGET_INVALID/u);
  assert.throws(() => parseCommand(['navigate', '--url', docUrl + '?tab=other']), /EDITORS_TARGET_INVALID/u);
  assert.throws(() => parseWorkflow('replace-document-text', JSON.stringify({ ...docSpec, replacement: 'first marker twice' })), /EDITORS_SPEC_INVALID/u);
  assert.throws(() => parseWorkflow('copy-document', JSON.stringify({ url: docUrl, title: 'Fixture', newTitle: 'Copy', destination: 'shared_drive' })), /EDITORS_SPEC_INVALID/u);
  assert.throws(() => parseCommand(['upload-file', '--frameId', 'frame', '--x', '1', '--y', '2', '--file', 'relative.csv']), /EDITORS_COMMAND_INVALID/u);
  assert.throws(() => parseWorkflow('find-sheet-rows', JSON.stringify({
    url: sheetUrl, title: 'Fixture', sheet: 'Test', range: 'C2:D5', column: 2, value: 'value',
  })), /EDITORS_SPEC_INVALID/u);
});

async function docsFixture(t, { errorAfterClick = false, persistWrite = true, initial = 'first marker', title = 'Fixture', fieldMismatch = false,
  unexpectedEdit = '', createPage = false, copyWithSharing = false, openedReference = null, targetReference = docUrl,
  blockedExport = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'editors-doc-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'fixture.txt');
  let document = initial;
  let serial = 0;
  let page = 'editor';
  let field;
  let selectAll = false;
  let fields = {};
  let toggles = { 'Match using regular expressions': true, 'Ignore diacritics (ä = a)': true, 'Match case': false };
  let clickHandlers = [];
  let writes = 0;
  let navigations = 0;
  let exports = 0;
  let copies = 0;
  let lastFrame;
  const result = { state: 'ready', kind: 'trelio.browser-text/v1', documentReference: openedReference, sessionId: 'fixture-session' };
  function frame(args) {
    const controls = [];
    function control(role, label, handler, checked) {
      controls.push({ role, label, x: clickHandlers.length, y: 1, ...(checked === undefined ? {} : { checked }) });
      clickHandlers.push(handler);
    }
    clickHandlers = [];
    if (page === 'editor') {
      control('menuitem', 'Edit', () => { page = 'edit-menu'; });
      control('menuitem', 'File', () => { page = 'file-menu'; });
      control('textbox', 'Rename', () => { field = 'Rename'; fields.Rename = title; });
      control('button', 'Document status: Saved to Drive');
    }
    if (page === 'edit-menu') control('menuitem', 'Find and replace Ctrl+H', () => { page = 'dialog'; });
    if (page === 'file-menu') {
      control('menuitem', 'Download ►', () => { page = 'download'; });
      control('menuitem', 'Make a copy', () => { page = 'copy'; });
    }
    if (page === 'download') control('menuitem', 'Plain Text (.txt)');
    if (page === 'copy') {
      control('textbox', 'Name', () => { field = 'Name'; });
      control('button', 'Folder picker. Currently selected folder is "My Drive".');
      control('checkbox', 'Share it with the same people', undefined, copyWithSharing);
      control('checkbox', 'Copy comments and suggestions', undefined, false);
      control('button', 'Make a copy', () => {
        copies += 1;
        page = 'editor';
        title = fields.Name;
        result.documentReference = docUrl.replace('document_1234', 'document_9876');
      });
    }
    let text = '';
    if (page === 'dialog') {
      for (const label of ['Find', 'Replace with']) control('textbox', label, () => { field = label; });
      for (const label of Object.keys(toggles)) control('checkbox', label, () => { toggles[label] = !toggles[label]; }, toggles[label]);
      if (fields.Find) {
        const count = document.split(fields.Find).length - 1;
        text = (count === 0 ? '0' : '1') + ' of ' + count;
        if (count) {
          control('button', 'Replace', () => {
            writes += 1;
            if (persistWrite) document = document.replace(fields.Find, fields['Replace with']) + unexpectedEdit;
            if (errorAfterClick) return { state: 'error', reason: 'browser_process_lost' };
          });
          control('button', 'Replace all', () => { throw Error('bulk replace is forbidden'); });
        }
      }
      control('button', 'Done', () => { page = 'editor'; });
    }
    lastFrame = 'frame-' + ++serial;
    return { ...result, title: title + ' - Google Docs', frameId: lastFrame, text, nextOffset: null, scanLimited: false, nextControlsOffset: null,
      controls: controls.filter(item => !args.controlQuery || item.label.toLowerCase().includes(args.controlQuery.toLowerCase())),
      ...(args.checks ? { fieldChecks: args.checks.map(({ id, label, values }) => ({
        id, state: !fieldMismatch && values.includes(fields[label]) ? 'matches' : 'different',
      })) } : {}) };
  }
  const perform = async (op, args) => {
    if (op === 'navigate') {
      assert.equal(args.url, createPage && navigations === 0 ? 'https://docs.google.com/document/create' : targetReference);
      if (createPage && navigations === 0) title = 'Untitled document';
      page = 'editor';
      fields = {};
      toggles = { 'Match using regular expressions': true, 'Ignore diacritics (ä = a)': true, 'Match case': false };
      result.documentReference = targetReference;
      navigations += 1;
      return result;
    }
    if (op === 'read-text') return result.documentReference ? frame(args) : { state: 'error', reason: 'session_closed' };
    assert.equal(args.frameId, lastFrame);
    lastFrame = undefined;
    if (op === 'click') return clickHandlers[args.x]() || result;
    if (op === 'download-attachment') {
      assert.equal(page, 'download');
      assert.equal(args.x, 0);
      if (blockedExport) return { state: 'error', reason: 'document_blocked' };
      page = 'editor';
      exports += 1;
      const bytes = Buffer.from(document);
      await writeFile(filePath, bytes);
      return { ...result, kind: 'trelio.browser-file/v1', mimeType: 'text/plain', filePath,
        sizeBytes: bytes.length, expiresAt: Date.now() + 60_000, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    if (op === 'key') {
      if (args.key === 'Enter') {
        assert.equal(field, 'Rename');
        title = fields.Rename;
        return result;
      }
      assert.ok(['Meta+A', 'Control+A'].includes(args.key));
      selectAll = true;
      return result;
    }
    if (op === 'type-text') {
      assert.ok(selectAll && field);
      fields[field] = args.text;
      selectAll = false;
      return result;
    }
    assert.fail(op);
  };
  return { perform, state: () => ({ document, writes, navigations, exports }), currentTitle: () => title, copyCount: () => copies };
}

test('one literal replacement verifies the whole document via two exports without navigating during autosave', async (t) => {
  const fake = await docsFixture(t);
  const output = await executeWorkflow('replace-document-text', parseWorkflow('replace-document-text', JSON.stringify(docSpec)), fake.perform);
  assert.deepEqual(fake.state(), { document: 'second marker', writes: 1, navigations: 1, exports: 2 });
  assert.equal(output.outcome, 'verified');
  assert.equal(output.originalCount, 0);
  assert.equal(output.replacementCount, 1);
});

test('replacement keeps the already verified file and tab open but navigates from a different tab', async (t) => {
  const targetReference = docUrl + '?tab=t.0';
  const spec = parseWorkflow('replace-document-text', JSON.stringify({ ...docSpec, url: targetReference }));
  for (const [openedReference, expectedNavigations] of [[targetReference, 0], [docUrl + '?tab=t.other', 1]]) {
    const fake = await docsFixture(t, { openedReference, targetReference });
    // A replacement on the exact open editor must succeed without dispatching
    // a reload, even if another top-level navigation would be refused.
    const perform = (operation, args) => {
      if (expectedNavigations === 0) assert.notEqual(operation, 'navigate');
      return fake.perform(operation, args);
    };
    assert.equal((await executeWorkflow('replace-document-text', spec, perform)).outcome, 'verified');
    assert.deepEqual(fake.state(), { document: 'second marker', writes: 1, navigations: expectedNavigations, exports: 2 });
  }
  const wrongTitle = await docsFixture(t, { openedReference: targetReference, title: 'Another file' });
  await assert.rejects(executeWorkflow('replace-document-text', spec, wrongTitle.perform),
    error => error.code === 'EDITORS_TARGET_UNVERIFIED' && error.outcome === 'not_dispatched');
  assert.equal(wrongTitle.state().writes, 0);
  assert.equal(wrongTitle.state().navigations, 0);
});

test('browser refusals keep their before-write stage and never launch a second route', async (t) => {
  const spec = parseWorkflow('replace-document-text', JSON.stringify(docSpec));
  const observed = [];
  await assert.rejects(executeWorkflow('replace-document-text', spec, async operation => {
    observed.push(operation);
    return { state: 'error', reason: 'document_blocked' };
  }), error => error.code === 'EDITORS_DOCUMENT_BLOCKED' && error.stage === 'document_observation'
    && error.outcome === 'not_dispatched');
  assert.deepEqual(observed, ['read-text']);
  const fake = await docsFixture(t, { openedReference: docUrl, blockedExport: true });
  await assert.rejects(executeWorkflow('replace-document-text', spec, fake.perform),
    error => error.code === 'EDITORS_DOCUMENT_BLOCKED' && error.stage === 'baseline_export'
      && error.outcome === 'not_dispatched');
  assert.deepEqual(fake.state(), { document: 'first marker', writes: 0, navigations: 0, exports: 0 });
});

test('a lost Replace response can be verified but cannot trigger another Replace', async (t) => {
  for (const persistWrite of [true, false]) {
    const fake = await docsFixture(t, { errorAfterClick: true, persistWrite });
    const attempt = executeWorkflow('replace-document-text', parseWorkflow('replace-document-text', JSON.stringify(docSpec)), fake.perform);
    if (persistWrite) assert.equal((await attempt).outcome, 'verified');
    else await assert.rejects(attempt, error => error.code === 'EDITORS_ACTION_UNKNOWN' && error.outcome === 'unknown');
    assert.equal(fake.state().writes, 1);
    assert.equal(fake.state().navigations, 1);
    assert.equal(fake.state().exports, 2);
  }
});

test('a concurrent unrelated edit does not verify merely because the replacement appears', async (t) => {
  const fake = await docsFixture(t, { unexpectedEdit: '\nConcurrent edit' });
  await assert.rejects(executeWorkflow('replace-document-text', parseWorkflow('replace-document-text', JSON.stringify(docSpec)), fake.perform),
    error => error.code === 'EDITORS_ACTION_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(fake.state().writes, 1);
});

test('ambiguous matches, wrong document and an unchecked input are read-only refusals', async (t) => {
  for (const [options, code] of [
    [{ initial: 'first marker first marker' }, 'EDITORS_TARGET_AMBIGUOUS'],
    [{ initial: 'first marker second marker' }, 'EDITORS_REPLACEMENT_ALREADY_PRESENT'],
    [{ title: 'Another file' }, 'EDITORS_TARGET_UNVERIFIED'],
    [{ fieldMismatch: true }, 'EDITORS_FIND_UNVERIFIED'],
  ]) {
    const fake = await docsFixture(t, options);
    await assert.rejects(executeWorkflow('replace-document-text', parseWorkflow('replace-document-text', JSON.stringify(docSpec)), fake.perform),
      error => error.code === code && error.outcome === 'not_dispatched');
    assert.equal(fake.state().writes, 0);
  }
});


test('a retired initial editor observation reads the same session without sending navigation again', async (t) => {
  const fake = await docsFixture(t);
  const calls = [];
  let retired = false;
  const value = await executeWorkflow('replace-document-text', parseWorkflow('replace-document-text', JSON.stringify(docSpec)), async (op, args) => {
    calls.push(op);
    const result = await fake.perform(op, args);
    if (!retired && op === 'navigate') {
      retired = true;
      return { state: 'error', reason: 'stale_frame', sessionId: result.sessionId };
    }
    return result;
  });
  assert.equal(value.outcome, 'verified');
  assert.deepEqual(calls.slice(0, 3), ['read-text', 'navigate', 'read-text']);
  assert.deepEqual(fake.state(), { document: 'second marker', writes: 1, navigations: 1, exports: 2 });
});

test('a retired read checks the fresh file, session and browser refusal before any input', async () => {
  const spec = parseWorkflow('replace-document-text', JSON.stringify(docSpec));
  const stale = { state: 'error', reason: 'stale_frame', sessionId: 'fixture-session' };
  const ready = { state: 'ready', kind: 'trelio.browser-text/v1', documentReference: docUrl, title: 'Fixture - Google Docs', sessionId: stale.sessionId };
  for (const [next, code] of [
    [stale, 'EDITORS_BROWSER_UNAVAILABLE'],
    [{ ...ready, sessionId: 'different-session' }, 'EDITORS_SESSION_CHANGED'],
    [{ ...ready, title: 'Wrong file - Google Docs' }, 'EDITORS_TARGET_UNVERIFIED'],
    [{ ...stale, reason: 'document_blocked' }, 'EDITORS_DOCUMENT_BLOCKED'],
    [{ ...stale, reason: 'session_closed' }, 'EDITORS_BROWSER_UNAVAILABLE'],
  ]) {
    const calls = [];
    await assert.rejects(executeWorkflow('replace-document-text', spec, async op => {
      calls.push(op);
      return calls.length === 1 ? stale : next;
    }), error => error.code === code && error.outcome === 'not_dispatched');
    assert.deepEqual(calls, ['read-text', 'read-text']);
  }
});

test('a stale response on a Replace click never sends the click again', async (t) => {
  const fake = await docsFixture(t, { errorAfterClick: true, persistWrite: false, openedReference: docUrl });
  const spec = parseWorkflow('replace-document-text', JSON.stringify(docSpec));
  await assert.rejects(executeWorkflow('replace-document-text', spec, async (op, args) => {
    const r = await fake.perform(op, args);
    return op === 'click' && r.reason === 'browser_process_lost' ? { state: 'error', reason: 'stale_frame', sessionId: 'fixture-session' } : r;
  }), error => error.code === 'EDITORS_ACTION_UNKNOWN' && error.outcome === 'unknown');
  assert.equal(fake.state().writes, 1);
  assert.equal(fake.state().navigations, 0);
});

test('a preparing browser acknowledges a single navigation before the first inspection', async () => {
  const calls = [];
  const spec = parseWorkflow('inspect-file', JSON.stringify({ url: docUrl, title: 'Fixture' }));
  const status = { state: 'ready', sessionId: 'cold-owner', kind: 'trelio.browser-text/v1', title: 'Fixture - Google Docs', documentReference: docUrl };
  const value = await executeWorkflow('inspect-file', spec, async (operation, args) => {
    calls.push(operation);
    if (operation === 'navigate') {
      assert.equal(args.url, docUrl);
      return { state: 'preparing' };
    }
    return status;
  });
  assert.deepEqual(calls, ['navigate', 'wait', 'read-text']);
  assert.equal(value.url, docUrl);
});

test('rename and create use the protected title field, verify saved state and reopen the exact result', async (t) => {
  for (const [name, input] of [
    ['rename-file', { url: docUrl, title: 'Fixture', newTitle: 'New title' }],
    ['create-document', { title: 'New title' }],
  ]) {
    const fake = await docsFixture(t, { createPage: name === 'create-document' });
    const output = await executeWorkflow(name, parseWorkflow(name, JSON.stringify(input)), fake.perform);
    assert.deepEqual(output, { outcome: 'verified', title: 'New title', url: docUrl });
    assert.equal(fake.currentTitle(), 'New title');
    assert.equal(fake.state().navigations, 2);
  }
});

test('copy verifies the My Drive destination and refuses inherited sharing without committing', async (t) => {
  const command = 'copy-document';
  const spec = parseWorkflow(command, JSON.stringify({ url: docUrl, title: 'Fixture', newTitle: 'My copy', destination: 'my_drive' }));
  const allowed = await docsFixture(t);
  const refused = await docsFixture(t, { copyWithSharing: true });
  assert.deepEqual(await executeWorkflow(command, spec, allowed.perform), {
    outcome: 'verified', title: 'My copy', url: docUrl.replace('document_1234', 'document_9876'),
  });
  await assert.rejects(executeWorkflow(command, spec, refused.perform), error =>
    error.code === 'EDITORS_UI_UNSUPPORTED' && error.outcome === 'not_dispatched');
  assert.equal(allowed.copyCount(), 1);
  assert.equal(refused.copyCount(), 0);
});

test('range reading verifies the selected sheet and consumes one host receipt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'editors-sheet-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'fixture.csv');
  const csv = Buffer.from('id,quantity\r\n001,0\r\n002,12\r\n');
  await writeFile(filePath, csv);
  const spec = parseWorkflow('find-sheet-rows', JSON.stringify({
    url: sheetUrl, title: 'Fixture', sheet: 'Testing', range: 'A2:B4', column: 1, value: '001',
  }));
  let view = 'sheet', captured = 0, downloaded = 0;
  const base = { state: 'ready', kind: 'trelio.browser-text/v1', sessionId: 'fixture-session', title: 'Fixture - Google Sheets',
    documentReference: sheetUrl, scanLimited: false, nextControlsOffset: null };
  const perform = async (op, args) => {
    if (op === 'navigate') return base;
    if (op === 'read-text') {
      const controls = view === 'sheet' ? [
        { label: 'Testing', role: 'option', selected: true, x: 1 },
        { label: 'File', role: 'menuitem', x: 2 },
      ] : view === 'file' ? [{ label: 'Download ►', role: 'menuitem', x: 3 }]
        : [{ label: 'Comma-separated values (.csv)', role: 'menuitem', x: 4 }];
      return { ...base, frameId: String(++captured), controls: controls.filter(control =>
        !args.controlQuery || control.label.toLowerCase().includes(args.controlQuery.toLowerCase())) };
    }
    assert.equal(args.frameId, String(captured));
    if (op === 'click') {
      assert.ok([2, 3].includes(args.x));
      view = args.x === 2 ? 'file' : 'formats';
      return base;
    }
    assert.equal(op, 'download-attachment');
    assert.equal(args.x, 4);
    downloaded += 1;
    view = 'sheet';
    return { ...base, kind: 'trelio.browser-file/v1', mimeType: 'text/csv', filePath,
      expiresAt: Date.now() + 60_000, sizeBytes: csv.length, sha256: createHash('sha256').update(csv).digest('hex') };
  };
  const result = await executeWorkflow('find-sheet-rows', spec, perform);
  assert.equal(downloaded, 1);
  assert.deepEqual(result.matches, [{ row: 2, values: ['001', '0'] }]);
});

test('adding a sheet verifies its new gid and never repeats the creation click', async () => {
  const newUrl = sheetUrl.replace('#gid=0', '#gid=5');
  const calls = [];
  let address = sheetUrl, frameId = 0, created = false;
  const perform = async (op, args) => {
    const base = { state: 'ready', kind: 'trelio.browser-text/v1', sessionId: 'fixture-session',
      title: 'Fixture - Google Sheets', scanLimited: false, nextControlsOffset: null };
    if (op === 'navigate') {
      calls.push(args.url === sheetUrl ? 'open old' : 'open new');
      address = args.url;
      return base;
    }
    if (op === 'click') {
      assert.equal(args.frameId, String(frameId));
      assert.equal(args.x, 0);
      calls.push('add');
      address = newUrl;
      created = true;
      return { ...base, state: 'error', reason: 'browser_process_lost' };
    }
    const labels = ['Add sheet', 'Sheet1', 'Document status: Saved to Drive', ...(created ? ['Sheet2'] : [])];
    return { ...base, documentReference: address, frameId: String(++frameId),
      controls: labels.map((label, x) => ({ label, role: 'button', x, y: 1 })).filter(item =>
        !args.controlQuery || item.label.toLowerCase().includes(args.controlQuery.toLowerCase())) };
  };
  const spec = parseWorkflow('add-sheet', JSON.stringify({ url: sheetUrl, title: 'Fixture' }));
  assert.deepEqual(await executeWorkflow('add-sheet', spec, perform),
    { outcome: 'verified', sheet: 'Sheet2', url: newUrl });
  assert.deepEqual(calls, ['open old', 'add', 'open new']);
});
