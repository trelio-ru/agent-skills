import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseVkCommand, runVk } from '../scripts/trelio-vk.mjs';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));

test('closed coordinate interface rejects executable, script, selector and attachment overrides', async () => {
  assert.deepEqual(parseVkCommand(['scroll', '--frameId', 'frame', '--x', '0', '--y', '40', '--deltaY', '-900']), {
    operation: 'scroll', args: { frameId: 'frame', x: 0, y: 40, deltaY: -900 },
  });
  for (const args of [
    ['evaluate', '--script', 'document.body'], ['click', '--selector', '#login'],
    ['setup', '--executable', '/browser'], ['setup', '--url', 'https://other.test'],
    ['status', '--path', '/private'], ['screenshot', '--observationMode', 'image'],
    ['download-attachment', '--url', 'https://vk.ru/file'], ['download-attachment', '--output', '/file'],
    ['key', '--frameId', 'frame', '--key', 'Enter', '--key', 'Tab'],
    ['click', '--frameId', 'frame', '--x', '', '--y', '1'],
    ['click', '--frameId', 'frame', '--x', '1e2', '--y', '1'],
    ['click', '--frameId', 'frame', '--x', '9007199254740992', '--y', '1'],
    ['read-text', '--includeControls', 'sometimes'], ['navigate', '--url'],
    ['submit-search', '--frameId', 'f', '--x', '1'],
    ['upload-files', '--frameId', 'f', '--x', '1', '--y', '2', '--files', 'not json'],
    ['upload-files', '--frameId', 'f', '--x', '1', '--y', '2', '--files', '[]'],
    ['upload-files', '--frameId', 'f', '--x', '1', '--y', '2', '--files', '[null]'],
    ['upload-files', '--frameId', 'f', '--x', '1', '--y', '2', '--files', '["relative"]'],
  ]) assert.throws(() => parseVkCommand(args), /VK_COMMAND_INVALID/);
});

test('first discovery and metadata need no account, environment, browser or secure store', async () => {
  const noEnvironmentAccess = new Proxy({}, { get() { throw new Error('unexpected environment access'); } });
  assert.deepEqual(await runVk(['__trelio_accounts_import'], noEnvironmentAccess), { schemaVersion: 1, accounts: [] });
  const commands = await runVk(['commands'], noEnvironmentAccess);
  assert.equal(commands.schemaVersion, 1);
  assert.deepEqual(commands.commands['download-attachment'], { frameId: 'string', x: 'number', y: 'number' });
  assert.equal((await runVk(['guides'], noEnvironmentAccess)).guides.length, 3);
  for (const command of ['commands', 'guides', '__trelio_accounts_import']) {
    await assert.rejects(runVk([command, '--path', '/private'], noEnvironmentAccess), /VK_COMMAND_INVALID/);
  }
  const doctor = await runVk(['doctor'], {});
  const release = JSON.parse(await fs.readFile(path.join(source, 'release.json'), 'utf8'));
  assert.equal(doctor.hostVisualAvailable, false);
  assert.equal(doctor.accountSelected, false);
  assert.equal(doctor.minimumHostVersion, release.runtime.minimumHostVersion);
  for (const env of [{}, { TRELIO_VISUAL_SESSION_MODULE_URL: 'not a URL' },
    { TRELIO_SKILL_ID: 'vk', TRELIO_VISUAL_SESSION_MODULE_URL: 'https://other.test/host.mjs' },
    { TRELIO_SKILL_ID: 'vk-ads', TRELIO_VISUAL_SESSION_MODULE_URL: 'file:///must-not-load.mjs' }]) {
    await assert.rejects(runVk(['screenshot'], env), /VK_HOST_REQUIRED/);
  }
});

test('packaged first-install CLI preserves existing sessions and delivers complete hashed guides', async t => {
  const built = buildRuntimePackage(source);
  assert.deepEqual(built.packageBytes, buildRuntimePackage(source).packageBytes);
  const artifact = JSON.parse(built.packageBytes);
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-vk-package-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const item of artifact.files) {
    const file = path.join(temporary, item.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(item.contentBase64, 'base64'));
  }
  const marker = path.join(temporary, 'existing-session-marker');
  await fs.writeFile(marker, 'synthetic durable session');
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(temporary, 'trelio-vk.mjs'), ...args], {
    cwd: temporary, encoding: 'utf8', timeout: 15_000,
    env: { HOME: temporary, USERPROFILE: temporary, SystemRoot: process.env.SystemRoot, ...extra },
  });
  // Execute the real packaged host handshake, not only the exported function.
  // Poisoned hints must remain unused before account selection on every OS.
  const discovery = run(['__trelio_accounts_import'], {
    TRELIO_VISUAL_SESSION_MODULE_URL: 'file:///must-not-load.mjs',
    TRELIO_SKILL_ACCOUNT_JSON: 'untrusted-invalid-json',
  });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(discovery.stderr, '');
  assert.deepEqual(JSON.parse(discovery.stdout), { schemaVersion: 1, accounts: [] });
  assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic durable session');
  const result = run(['guides']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.requiredBeforeWork, 'all_in_order');
  assert.equal(metadata.guides.length, 3);
  for (const [index, guide] of metadata.guides.entries()) {
    const name = ['workflow.md', 'security.md', 'uploads.md'][index];
    assert.equal(await fs.realpath(guide.path), await fs.realpath(path.join(temporary, 'references', name)));
    const bytes = await fs.readFile(guide.path);
    assert.equal(bytes.length, guide.sizeBytes);
    assert.ok(bytes.length <= 16384, `${name}: preserve bounded complete delivery`);
    // Git's native Windows checkout uses CRLF. Budget the actual delivered
    // bytes for both checkout formats so a document cannot pass locally and
    // exceed the complete-guide limit only on Windows.
    const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
    assert.ok(Buffer.byteLength(lf.replace(/\n/g, '\r\n')) <= 16384,
      `${name}: complete delivery must fit with Windows line endings`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), guide.sha256);
    assert.equal(bytes.toString('utf8').replace(/\r\n/g, '\n'),
      (await fs.readFile(path.join(source, 'references', name), 'utf8')).replace(/\r\n/g, '\n'));
  }
  assert.deepEqual((await fs.readdir(temporary)).sort(), ['existing-session-marker', 'references', 'trelio-vk.mjs']);
  const instructions = (await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).trim();
  assert.ok(Buffer.byteLength(instructions) <= 16384);
  const data = { instructions, runtime: built.manifest, context: 'x'.repeat(4096) };
  assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: data,
    content: [{ type: 'text', text: JSON.stringify(data) }] })) <= 40000);
});

test('signed host dispatch fixes VK scope, text mode, attachments and search pacing', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-vk-api-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, `export const VISUAL_FILE_UPLOAD_API = 'trelio.visual-file-upload/v1';
  export function runVisualSession({env,...input}) {
    return input.operation === 'status' ? { state: 'saved_unverified' } : input;
  }`);
  const env = { TRELIO_SKILL_ID: 'vk', TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href,
    TRELIO_SKILL_ACCOUNT_JSON: 'synthetic-account', TRELIO_OBSERVATION_MODE: 'image',
    TRELIO_VISUAL_ORIGINS: 'https://other.test' };
  const setup = await runVk(['setup'], env);
  assert.equal(setup.observationMode, 'text');
  assert.equal(setup.attachmentDownloads, true);
  assert.equal(setup.fileUploads, true);
  assert.deepEqual(setup.domains, ['vk.ru', 'vk.com']);
  assert.deepEqual(setup.origins, [
    'https://vk.ru', 'https://www.vk.ru', 'https://m.vk.ru',
    'https://vk.com', 'https://www.vk.com', 'https://m.vk.com',
    'https://id.vk.ru', 'https://id.vk.com', 'https://login.vk.ru', 'https://login.vk.com',
    'https://connect.vk.com',
    'https://vk.me',
  ]);
  assert.deepEqual(setup.args, { url: 'https://vk.ru/' });
  for (const origin of setup.origins) {
    assert.equal((await runVk(['navigate', '--url', `${origin}/`], env)).args.url, `${origin}/`);
  }
  // Product sections are user-selected, not an exclusion list in the skill.
  // These calls exercise provider validation and the exact signed host policy;
  // they do not claim that a fixture rendered the real payment/call interface.
  for (const url of ['https://vk.ru/calls', 'https://vk.com/video',
    'https://ads.vk.com/', 'https://pay.vk.com/', 'https://api.vk.com/',
    'https://login.id.vk.ru/', 'https://vk.me/']) {
    const section = await runVk(['navigate', '--url', url], env);
    assert.equal(section.operation, 'navigate');
    assert.equal(section.args.url, url);
    assert.deepEqual(section.domains, setup.domains);
    assert.deepEqual(section.origins, setup.origins);
  }
  const enter = await runVk(['submit-search', '--frameId', 'fresh'], env);
  assert.equal(enter.operation, 'submit');
  assert.deepEqual(enter.args, { action: 'key', key: 'Enter', frameId: 'fresh' });
  assert.deepEqual((await runVk(['submit-search', '--frameId', 'fresh', '--x', '21', '--y', '32'], env)).args,
    { action: 'click', frameId: 'fresh', x: 21, y: 32 });
  assert.equal((await runVk(['search-ready', '--frameId', 'fresh'], env)).operation, 'request-ready');
  assert.deepEqual((await runVk(['read-text', '--query', 'Сообщения', '--offset', '6000', '--includeControls', 'false'], env)).args,
    { query: 'Сообщения', offset: 6000, includeControls: false });
  const file = await runVk(['download-attachment', '--frameId', 'fresh', '--x', '10', '--y', '20'], env);
  assert.equal(file.operation, 'download-attachment');
  assert.deepEqual(file.args, { frameId: 'fresh', x: 10, y: 20 });
  const files = [path.join(temporary, 'original.docx'), path.join(temporary, 'original.zip')];
  const upload = await runVk(['upload-files', '--frameId', 'fresh', '--x', '10', '--y', '20',
    '--files', JSON.stringify(files)], env);
  assert.equal(upload.operation, 'upload-files');
  assert.equal(upload.fileUploads, true);
  assert.deepEqual(upload.args, { frameId: 'fresh', x: 10, y: 20, files });
  assert.deepEqual(await runVk(['status'], env), { state: 'saved_unverified' });
  for (const operation of ['show-login', 'wait', 'ready', 'screenshot', 'close', 'disconnect']) {
    assert.equal((await runVk([operation], env)).operation, operation);
  }
});

test('first navigation enters manual login; restored session and pending failures retain their state', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-vk-login-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, `export const calls = [];
    export function runVisualSession({env,...input}) {
      calls.push(input);
      if (input.operation === 'status') return JSON.parse(env.TEST_STATUS);
      return input;
    }`);
  const { calls } = await import(pathToFileURL(host).href);
  const env = { TRELIO_SKILL_ID: 'vk', TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href };
  const navigate = status => runVk(['navigate', '--url', 'https://vk.ru/synthetic-profile'],
    { ...env, TEST_STATUS: JSON.stringify(status) });
  const first = await navigate({ state: 'not_configured' });
  assert.deepEqual(calls.map(call => call.operation), ['status', 'setup']);
  assert.equal(first.operation, 'setup');
  assert.deepEqual(first.args, { url: 'https://vk.ru/' });
  assert.equal(first.observationMode, 'text');
  for (const state of ['saved_unverified', 'ready']) {
    calls.length = 0;
    assert.equal((await navigate({ state })).operation, 'navigate');
    assert.deepEqual(calls.map(call => call.operation), ['status', 'navigate']);
  }
  for (const state of ['preparing', 'manual_input_required', 'error', 'closed']) {
    calls.length = 0;
    const status = { state, reason: 'synthetic-preserved-reason' };
    assert.deepEqual(await navigate(status), status);
    assert.deepEqual(calls.map(call => call.operation), ['status']);
  }
});

test('outgoing file selection requires the actual additive host API before dispatch', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-vk-old-upload-host-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, 'export function runVisualSession() { throw new Error("MUST_NOT_DISPATCH"); }');
  await assert.rejects(runVk(['upload-files', '--frameId', 'fresh', '--x', '1', '--y', '2',
    '--files', JSON.stringify([path.join(temporary, 'original.bin')])],
  { TRELIO_SKILL_ID: 'vk', TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href }), /VK_HOST_UPGRADE_REQUIRED/);
});

test('VK hostname scope rejects lookalikes, credentials, ports and unsafe schemes before host import', async () => {
  const env = { TRELIO_SKILL_ID: 'vk', TRELIO_VISUAL_SESSION_MODULE_URL: 'file:///must-not-load.mjs' };
  for (const url of ['https://other.test/', 'https://vk.ru.other.test/', 'https://other-vk.ru/',
    'https://pay.vk.com.other.test/', 'https://other-vk.com/', 'https://vk.me.other.test/',
    'https://other.vk.me/', 'https://www.vk.ru.other.test/',
    'https://vk.ru:444/', 'https://user:password@vk.ru/', 'http://vk.ru/', 'file:///private',
    'http://pay.vk.com/', 'https://pay.vk.com:444/', 'https://user:password@pay.vk.com/',
    'javascript:alert(1)', 'not a url']) {
    await assert.rejects(runVk(['navigate', '--url', url], env), /VK_NAVIGATION_BLOCKED/);
  }
});

test('real CLI never exposes raw host exception, input, URL or private path', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-vk-error-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, 'export function runVisualSession() { throw new Error("synthetic-private-host-detail"); }');
  const result = spawnSync(process.execPath, [path.join(source, 'scripts', 'trelio-vk.mjs'), 'screenshot'], {
    encoding: 'utf8', timeout: 15_000,
    env: { SystemRoot: process.env.SystemRoot, TRELIO_SKILL_ID: 'vk',
      TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, state: 'error', code: 'VK_RUNTIME_FAILED' });
  assert.ok(!result.stdout.includes(temporary));
});
