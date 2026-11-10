import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseCalendarCommand, runCalendar } from '../scripts/trelio-google-calendar.mjs';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';
import { registerInstructionGuideContract } from '../../tools/instruction-guide-contract.mjs';
import './workflows.test.mjs';

registerInstructionGuideContract(new URL('../', import.meta.url));

test('command validation and empty account discovery perform no identity/browser I/O', async () => {
  const inaccessible = new Proxy({}, { get() { throw Error('PRIVATE_ENV_CANARY'); } });
  assert.deepEqual(await runCalendar(['__trelio_accounts_import'], inaccessible), { schemaVersion: 1, accounts: [] });
  assert.ok((await runCalendar(['commands'], inaccessible)).commands.screenshot);
  for (const argv of [
    ['__trelio_accounts_import', '--account', 'foreign'], ['evaluate', '--script', 'PRIVATE_CANARY'],
    ['setup', '--presentation', 'hidden'], ['navigate', '--url', 'https://calendar.google.com/', '--executable', '/browser'],
    ['click', '--selector', '#save'], ['click', '--frameId', 'f', '--x', '', '--y', '1'],
    ['read-text', '--includeControls', 'yes'], ['read-text', '--checks', '[]'], ['status', '--profile', '/private'],
    ['key', '--frameId', 'f', '--key', 'Enter', '--key', 'Tab'],
  ]) {
    assert.throws(() => parseCalendarCommand(argv), /CALENDAR_COMMAND_INVALID/);
    const result = await runCalendar(argv, inaccessible);
    assert.equal(result.code, 'CALENDAR_COMMAND_INVALID');
    assert.equal(result.diagnostic.outcome, 'not_dispatched');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
  assert.deepEqual(parseCalendarCommand(['scroll', '--frameId', 'fresh', '--x', '10', '--y', '20', '--deltaY', '-500']),
    { operation: 'scroll', args: { frameId: 'fresh', x: 10, y: 20, deltaY: -500 } });
});

async function hostFixture(t, marker = 'trelio.visual-presentation/v1') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-host-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const host = path.join(directory, `${randomUUID()}.mjs`);
  await fs.writeFile(host, `export const VISUAL_PRESENTATION_API=${JSON.stringify(marker)};
    export const VISUAL_SEMANTIC_CONTROLS_API='trelio.visual-semantic-controls/v1';
    export const VISUAL_FORM_CHECKS_API='trelio.visual-form-checks/v1';
    export const calls=[];
    export function runVisualSession(input) { calls.push(input);
      if(input.env.FAIL) throw Error('PRIVATE_PROVIDER_EXCEPTION');
      return JSON.parse(input.env.RESULT || '{"kind":"trelio.visual-browser/v1","state":"closed","reason":"none"}'); }
  `);
  const env = { TRELIO_SKILL_ID: 'google-calendar-web', TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href,
    TRELIO_HOST_RUNTIME_VERSION: '3.32.0' };
  return { env, ...(await import(pathToFileURL(host).href)) };
}

test('signed route pins hidden text mode and exact Google origins; an old host cannot open a window', async t => {
  const old = await hostFixture(t, 'unsupported');
  assert.equal((await runCalendar(['setup'], old.env)).code, 'CALENDAR_HOST_UPGRADE_REQUIRED');
  assert.equal(old.calls.length, 0);
  assert.equal((await runCalendar(['close'], old.env)).state, 'closed');
  const current = await hostFixture(t);
  await runCalendar(['setup'], current.env);
  assert.equal(current.calls.length, 1);
  const input = current.calls[0];
  assert.equal(input.presentation, 'hidden');
  assert.equal(input.observationMode, 'text');
  assert.equal(input.semanticControls, true);
  assert.deepEqual(input.origins, ['https://calendar.google.com', 'https://accounts.google.com', 'https://workspace.google.com',
    'https://accounts.youtube.com', 'https://accounts.google.ru', 'https://google.com', 'https://google.ru', 'https://youtube.com']);
  assert.deepEqual(input.args, { url: 'https://accounts.google.com/ServiceLogin?service=cl&continue=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fr' });
  assert.equal(input.externalNavigation, undefined);
  assert.equal(input.authentication, undefined, 'no password recipe or imported browser profile');
});

test('lost writes, post-click auth/navigation failures and malformed replies never replay or leak data', async t => {
  const fixture = await hostFixture(t);
  const argv = ['click', '--frameId', 'fresh', '--x', '20', '--y', '30'];
  for (const reason of ['operation_failed', 'manual_control_active', 'navigation_blocked', 'lease_expired', 'session_closed', 'http_document_failure']) {
    const result = await runCalendar(argv, { ...fixture.env, RESULT: JSON.stringify({ kind: 'trelio.visual-browser/v1',
      state: 'error', reason, httpStatus: reason === 'http_document_failure' ? 503 : undefined,
      message: 'PRIVATE_PAGE_CONTENT' }) });
    assert.equal(result.code, 'CALENDAR_ACTION_UNKNOWN');
    assert.equal(result.diagnostic.operationKind, 'write');
    assert.equal(result.diagnostic.outcome, 'unknown');
    assert.equal(result.diagnostic.recovery.retry, 'forbidden');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
  const before = fixture.calls.length;
  const thrown = await runCalendar(argv, { ...fixture.env, FAIL: '1' });
  assert.equal(fixture.calls.length, before + 1, 'a failed input is dispatched once only');
  assert.equal(thrown.diagnostic.outcome, 'unknown');
  assert.ok(!JSON.stringify(thrown).includes('PRIVATE_PROVIDER_EXCEPTION'));
  const malformed = await runCalendar(argv, { ...fixture.env, RESULT: 'null' });
  assert.equal(malformed.code, 'CALENDAR_RESULT_INVALID');
  assert.equal(malformed.diagnostic.outcome, 'unknown');
  const stale = await runCalendar(argv, { ...fixture.env, RESULT: JSON.stringify({
    kind: 'trelio.visual-browser/v1', state: 'error', reason: 'stale_frame' }) });
  assert.equal(stale.diagnostic.outcome, 'not_dispatched');
  assert.equal(stale.diagnostic.recovery.retry, 'forbidden', 'no automatic click retry even for an old frame');
});

test('read diagnostics distinguish access and provider failures without leaking foreign host fields', async t => {
  const fixture = await hostFixture(t);
  for (const httpStatus of [401, 403, 500, 503]) {
    const result = await runCalendar(['read-text'], { ...fixture.env, RESULT: JSON.stringify({
      kind: 'trelio.browser-text/v1', state: 'error', reason: 'http_document_failure', httpStatus,
      url: 'https://private.invalid/PRIVATE_CANARY', text: 'PRIVATE_PROVIDER_BODY',
    }) });
    assert.equal(result.diagnostic.category, [401, 403].includes(httpStatus) ? 'access' : 'runtime');
    assert.equal(result.diagnostic.outcome, 'not_dispatched');
    assert.deepEqual(result.diagnostic.evidence, { httpStatus });
    assert.equal(result.diagnostic.recovery.retry, 'forbidden');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  }
  const unknownReason = await runCalendar(['read-text'], { ...fixture.env, RESULT: JSON.stringify({
    kind: 'trelio.browser-text/v1', state: 'error', reason: 'PRIVATE_NATIVE_EXCEPTION', httpStatus: 200,
  }) });
  assert.equal(unknownReason.browserReason, undefined);
  assert.deepEqual(unknownReason.diagnostic.evidence, {});
  assert.ok(!JSON.stringify(unknownReason).includes('PRIVATE_'));
  const missing = await runCalendar(['status'], { TRELIO_SKILL_ID: 'google-calendar-web',
    TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(path.join(os.tmpdir(), randomUUID(), 'missing.mjs')).href });
  assert.equal(missing.code, 'CALENDAR_RUNTIME_FAILED');
  assert.equal(missing.diagnostic.stage, 'preflight');
  assert.equal(missing.diagnostic.outcome, 'not_dispatched');
});

test('the deterministic materialized package starts without browser access and keeps the host dependency explicit', async t => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const built = buildRuntimePackage(source);
  assert.deepEqual(built.packageBytes, buildRuntimePackage(source).packageBytes);
  const release = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-package-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of JSON.parse(built.packageBytes).files) {
    const target = path.join(directory, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(file.contentBase64, 'base64'));
  }
  const entry = path.join(directory, release.runtime.entrypoint.path);
  const env = { HOME: directory, USERPROFILE: directory, SystemRoot: process.env.SystemRoot,
    TRELIO_VISUAL_SESSION_MODULE_URL: 'file:///must-not-load.mjs' };
  for (const operation of ['__trelio_accounts_import', 'commands', 'doctor']) {
    const child = spawnSync(process.execPath, [entry, operation], { cwd: directory, env, encoding: 'utf8', timeout: 15000, input: null });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    if (operation === 'doctor') {
      assert.equal(result.minimumHostVersion, release.runtime.minimumHostVersion);
      assert.equal(result.browser, 'not_checked');
    }
  }
  const failed = spawnSync(process.execPath, [entry, 'click', '--selector', 'PRIVATE_CANARY'], {
    cwd: directory, env, encoding: 'utf8', timeout: 15000, input: null });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).code, 'CALENDAR_COMMAND_INVALID');
  assert.equal(failed.stderr, '');
  assert.ok(!failed.stdout.includes('PRIVATE_CANARY'));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['calendar-workflows.mjs', 'instruction-guides', 'trelio-google-calendar.mjs']);
});
