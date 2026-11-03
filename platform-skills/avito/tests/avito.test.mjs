import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvitoCommand, runAvito } from '../scripts/trelio-avito.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

test('coordinate interface rejects script/selector/path overrides before host I/O', async () => {
  assert.deepEqual(parseAvitoCommand(['scroll', '--frameId', 'frame', '--x', '0', '--y', '40', '--deltaY', '900']), { operation: 'scroll', args: { frameId: 'frame', x: 0, y: 40, deltaY: 900 } });
  for (const args of [['evaluate', '--script', 'document.body'], ['download-attachment', '--url', 'https://example.test/file'], ['download-attachment','--output','/private/file'], ['click', '--selector', '#login'], ['setup', '--executable', '/browser'], ['status', '--path', '/private'], ['key', '--frameId', 'frame', '--key', 'Enter', '--key', 'Tab']]) assert.throws(() => parseAvitoCommand(args), /AVITO_COMMAND_INVALID/);
  assert.equal((await runAvito(['commands'], {})).schemaVersion, 1);
  const doctor = await runAvito(['doctor'], {});
  assert.equal(doctor.hostVisualAvailable, false);
  const release = JSON.parse(await fs.readFile(new URL('../release.json', import.meta.url), 'utf8'));
  assert.equal(doctor.minimumHostVersion, release.runtime.minimumHostVersion);
  await assert.rejects(runAvito(['screenshot'], {}), /AVITO_HOST_REQUIRED/);
});

test('first host account discovery works before selection and ignores caller environment', async () => {
  // The host always performs this handshake before account list/create or any
  // provider command. A real first-install failure used to be hidden by tests
  // calling runAvito directly with a preselected synthetic account.
  const noEnvironmentAccess = new Proxy({}, { get() { throw new Error('unexpected environment access'); } });
  assert.deepEqual(await runAvito(['__trelio_accounts_import'], noEnvironmentAccess), { schemaVersion: 1, accounts: [] });
  await assert.rejects(runAvito(['__trelio_accounts_import', '--path', '/private'], noEnvironmentAccess), /AVITO_COMMAND_INVALID/);
});

test('voice command selects only fresh player coordinates and requires the separate signed host API before input', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-voice-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const args = ['download-audio', '--frameId', 'fresh', '--x', '10', '--y', '20'];
  assert.deepEqual(parseAvitoCommand(args), { operation: 'download-audio', args: { frameId: 'fresh', x: 10, y: 20 } });
  const noHostAccess = new Proxy({}, { get() { throw new Error('unexpected host access'); } });
  for (const flags of [['--url', 'https://example.test/voice'], ['--selector', 'audio'], ['--output', path.join(temporary, 'voice.wav')], ['--audioDownloads', 'true']]) await assert.rejects(runAvito([...args, ...flags], noHostAccess), /AVITO_COMMAND_INVALID/);
  for (const marker of [undefined, 'trelio.visual-audio-download/unknown', 'trelio.visual-audio-download/v1']) {
    const host = path.join(temporary, `host-${marker?.endsWith('/v1') ? 'current' : marker ? 'unknown' : 'old'}.mjs`);
    await fs.writeFile(host, `export const VISUAL_AUDIO_DOWNLOAD_API=${JSON.stringify(marker) || 'undefined'};
      export const calls=[];
      export function runVisualSession({env,...input}) { calls.push(input); if(env.TEST_THROW) throw new Error('PRIVATE_AUDIO_SOURCE'); return env.TEST_RESULT ? JSON.parse(env.TEST_RESULT) : input; }`);
    const env = { TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href, TRELIO_SKILL_ID: 'avito' }, { calls } = await import(pathToFileURL(host).href);
    if (marker !== 'trelio.visual-audio-download/v1') {
      await assert.rejects(runAvito(args, env), /AVITO_HOST_UPGRADE_REQUIRED/);
      assert.equal(calls.length, 0, 'old or unknown APIs refuse before the player is clicked');
      assert.equal((await runAvito(['close'], env)).operation, 'close');
      continue;
    }
    const input = await runAvito(args, env);
    assert.equal(input.audioDownloads, true); assert.equal(input.attachmentDownloads, true); assert.equal(input.operation, 'download-audio');
    assert.deepEqual(input.args, { frameId: 'fresh', x: 10, y: 20 });
    assert.deepEqual(input.domains, ['avito.ru'], 'voice support does not invent CDN/origin permissions');
    for (const reason of ['attachment_unsupported', 'attachment_too_large', 'attachment_link_required', 'stale_frame', 'operation_failed']) {
      calls.length = 0; const failure = { state: 'error', reason };
      assert.deepEqual(await runAvito(args, { ...env, TEST_RESULT: JSON.stringify(failure) }), failure);
      assert.equal(calls.length, 1, 'a source/transfer refusal never falls back to ordinary play or another click');
    }
    calls.length = 0; await assert.rejects(runAvito(args, { ...env, TEST_THROW: '1' }), /PRIVATE_AUDIO_SOURCE/); assert.equal(calls.length, 1);
  }
});

test('materialized package exposes complete signed guides without credentials or browser I/O', async () => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const built = buildRuntimePackage(source);
  assert.deepEqual(built.packageBytes, buildRuntimePackage(source).packageBytes);
  const artifact = JSON.parse(built.packageBytes);
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-guide-')));
  try {
    for (const item of artifact.files) {
      const file = path.join(temporary, item.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(item.contentBase64, 'base64'));
    }
    // Run the exact internal host entry from the materialized signed-package
    // layout, on every native CI OS. Poison browser/account hints and preserve a
    // synthetic durable-session marker: discovery must not start, reset or
    // import an unrelated managed profile just because one exists on disk.
    const marker = path.join(temporary, 'existing-session-marker');
    await fs.writeFile(marker, 'synthetic session must survive account discovery');
    const importEnv = { HOME: temporary, USERPROFILE: temporary, SystemRoot: process.env.SystemRoot,
      TRELIO_VISUAL_SESSION_MODULE_URL: 'file:///must-not-load-visual-session.mjs',
      TRELIO_SKILL_ACCOUNT_JSON: 'invalid-untrusted-account-json' };
    const imported = spawnSync(process.execPath, [path.join(temporary, 'trelio-avito.mjs'), '__trelio_accounts_import'], {
      cwd: temporary, encoding: 'utf8', env: importEnv, timeout: 15_000,
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stderr, '');
    assert.deepEqual(JSON.parse(imported.stdout), { schemaVersion: 1, accounts: [] });
    assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic session must survive account discovery');
    assert.deepEqual((await fs.readdir(temporary)).sort(), ['existing-session-marker', 'references', 'trelio-avito.mjs']);
    await fs.unlink(marker);
    const result = spawnSync(process.execPath, [path.join(temporary, 'trelio-avito.mjs'), 'guides'], { cwd: temporary, encoding: 'utf8', env: { HOME: temporary, USERPROFILE: temporary, SystemRoot: process.env.SystemRoot }, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.requiredBeforeWork, 'all_in_order');
    assert.equal(metadata.guides.length, 2);
    for (const guide of metadata.guides) {
      const actual = await fs.readFile(guide.path);
      assert.equal(actual.length, guide.sizeBytes);
      assert.equal(createHash('sha256').update(actual).digest('hex'), guide.sha256);
      const name = path.basename(guide.path);
      assert.equal(actual.toString('utf8').replace(/\r\n/g, '\n'), (await fs.readFile(path.join(source, 'references', name), 'utf8')).replace(/\r\n/g, '\n'));
    }
    assert.deepEqual((await fs.readdir(temporary)).sort(), ['references', 'trelio-avito.mjs']);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('signed provider pins text mode and routes search through the worker pacing contract', async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-api-')));
  try {
    const host = path.join(temporary, 'host.mjs');
    await fs.writeFile(host, 'export function runVisualSession({env,...input}) { return input; }');
    const { pathToFileURL } = await import('node:url');
    const env = { TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href, TRELIO_SKILL_ID: 'avito' };
    const enter = await runAvito(['submit-search', '--frameId', 'fresh'], env);
    assert.equal(enter.observationMode, 'text');
    assert.equal(enter.attachmentDownloads, true);
    assert.equal(enter.fileUploads, true);
    const file = await runAvito(['download-attachment','--frameId','fresh','--x','10','--y','20'],env);
    assert.equal(file.operation,'download-attachment'); assert.deepEqual(file.args,{frameId:'fresh',x:10,y:20});
    assert.equal(enter.operation, 'submit');
    assert.deepEqual(enter.args, { action: 'key', key: 'Enter', frameId: 'fresh' });
    assert.deepEqual((await runAvito(['submit-search', '--frameId', 'fresh', '--x', '21', '--y', '32'], env)).args, { action: 'click', frameId: 'fresh', x: 21, y: 32 });
    assert.equal((await runAvito(['search-ready', '--frameId', 'fresh'], env)).operation, 'request-ready');
    const text = await runAvito(['read-text', '--query', 'Цена', '--offset', '6000', '--includeControls', 'false'], env);
    assert.deepEqual(text.args, { query: 'Цена', offset: 6000, includeControls: false });
    assert.equal((await runAvito(['screenshot'], env)).operation, 'screenshot');
    assert.equal((await runAvito(['close'], env)).operation, 'close');
    for (const args of [['submit-search', '--frameId', 'f', '--x', '1'], ['read-text', '--includeControls', 'sometimes'], ['navigate', '--url', 'https://www.avito.ru/', '--observationMode', 'image']]) await assert.rejects(runAvito(args, env), /AVITO_COMMAND_INVALID/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('outgoing selection accepts explicit local originals and rejects malformed input before host I/O', async () => {
  const files = ['photo.jpg', 'document.pdf', 'archive.zip', 'original.unlisted-format']
    .map(name => path.resolve(os.tmpdir(), name));
  const args = ['upload-files', '--frameId', 'fresh', '--x', '10', '--y', '20'];
  assert.deepEqual(parseAvitoCommand([...args, '--files', JSON.stringify(files)]), {
    operation: 'upload-files', args: { frameId: 'fresh', x: 10, y: 20, files },
  });
  const noHostAccess = new Proxy({}, { get() { throw new Error('unexpected host access'); } });
  for (const value of ['not-json', '{}', '[]', 'null', '"/file"',
    JSON.stringify([null]), JSON.stringify([1]), JSON.stringify(['relative.pdf']),
    JSON.stringify(['https://example.test/file.pdf']), JSON.stringify([`${files[0]}\n`]),
    JSON.stringify([`${files[0]}${'x'.repeat(4096)}`]), JSON.stringify(Array(33).fill(files[0]))]) {
    await assert.rejects(runAvito([...args, '--files', value], noHostAccess), /AVITO_COMMAND_INVALID/);
  }
  for (const flags of [[], ['--files', JSON.stringify(files), '--files', JSON.stringify(files)],
    ['--files', JSON.stringify(files), '--selector', 'input[type=file]'],
    ['--files', JSON.stringify(files), '--url', 'https://example.test/upload'],
    ['--files', JSON.stringify(files), '--fileUploads', 'true']]) {
    await assert.rejects(runAvito([...args, ...flags], noHostAccess), /AVITO_COMMAND_INVALID/);
  }
  assert.deepEqual((await runAvito(['commands'], noHostAccess)).commands['upload-files'],
    { frameId: 'string', x: 'number', y: 'number', files: 'string[]' });
});

test('outgoing dispatch pins the signed policy and never replays unknown host outcomes', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-upload-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, `export const VISUAL_FILE_UPLOAD_API = 'trelio.visual-file-upload/v1';
    export const calls = [];
    export function runVisualSession({env,...input}) {
      calls.push(input);
      if (env.TEST_THROW) throw new Error('synthetic unknown outcome');
      return env.TEST_RESULT ? JSON.parse(env.TEST_RESULT) : input;
    }`);
  const { calls } = await import(pathToFileURL(host).href);
  const env = { TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href, TRELIO_SKILL_ID: 'avito' };
  const files = [path.join(temporary, 'photo.jpg'), path.join(temporary, 'document.pdf')];
  const args = ['upload-files', '--frameId', 'fresh', '--x', '10', '--y', '20', '--files', JSON.stringify(files)];
  const selected = await runAvito(args, env);
  assert.equal(selected.operation, 'upload-files');
  assert.deepEqual(selected.args, { frameId: 'fresh', x: 10, y: 20, files });
  assert.equal(selected.fileUploads, true);
  assert.equal(selected.attachmentDownloads, true);
  assert.equal(selected.observationMode, 'text');
  assert.deepEqual(selected.origins, ['https://www.avito.ru', 'https://avito.ru']);
  assert.deepEqual(selected.domains, ['avito.ru']);
  // Preserve the host's exact bounded outcome. Selection can already trigger
  // a website upload, so a timeout/error is never an invitation to click again.
  for (const reason of ['upload_control_required', 'upload_file_invalid', 'upload_file_changed',
    'upload_too_large', 'upload_limit_reached', 'upload_timed_out', 'stale_frame']) {
    calls.length = 0;
    const result = { schemaVersion: 1, state: 'error', reason };
    assert.deepEqual(await runAvito(args, { ...env, TEST_RESULT: JSON.stringify(result) }), result);
    assert.equal(calls.length, 1);
  }
  calls.length = 0;
  await assert.rejects(runAvito(args, { ...env, TEST_THROW: '1' }), /synthetic unknown outcome/);
  assert.equal(calls.length, 1);
});

test('older hosts refuse outgoing chooser input before dispatch while cleanup remains usable', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-old-host-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const marker of [undefined, 'trelio.visual-file-upload/unknown']) {
    const host = path.join(temporary, `${marker ? 'wrong-marker' : 'missing-marker'}.mjs`);
    await fs.writeFile(host, `export const VISUAL_FILE_UPLOAD_API = ${JSON.stringify(marker) || 'undefined'};
      export function runVisualSession({operation}) {
        if (operation === 'upload-files') throw new Error('MUST_NOT_DISPATCH');
        return { operation };
      }`);
    const env = { TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href, TRELIO_SKILL_ID: 'avito' };
    await assert.rejects(runAvito(['upload-files', '--frameId', 'fresh', '--x', '1', '--y', '2',
      '--files', JSON.stringify([path.join(temporary, 'original.pdf')])], env), /AVITO_HOST_UPGRADE_REQUIRED/);
    assert.deepEqual(await runAvito(['close'], env), { operation: 'close' });
  }
});

test('materialized upload CLI routes native paths and returns only safe errors', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-avito-packaged-upload-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const artifact = JSON.parse(buildRuntimePackage(fileURLToPath(new URL('../', import.meta.url))).packageBytes);
  for (const item of artifact.files) {
    const target = path.join(temporary, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(item.contentBase64, 'base64'));
  }
  const host = path.join(temporary, 'host.mjs');
  await fs.writeFile(host, `export const VISUAL_FILE_UPLOAD_API = 'trelio.visual-file-upload/v1';
    export function runVisualSession({operation,args,fileUploads,env}) {
      if (env.TEST_THROW) throw new Error('PRIVATE_PATH:' + args.files[0]);
      if (operation !== 'upload-files' || !fileUploads || args.files[0] !== env.TEST_ORIGINAL) throw new Error('invalid dispatch');
      return { schemaVersion: 1, state: 'ready' };
    }`);
  const original = path.join(temporary, 'Исходник с пробелами.pdf');
  const args = [path.join(temporary, 'trelio-avito.mjs'), 'upload-files', '--frameId', 'fresh',
    '--x', '1', '--y', '2', '--files', JSON.stringify([original])];
  const env = { HOME: temporary, USERPROFILE: temporary, SystemRoot: process.env.SystemRoot,
    TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(host).href, TRELIO_SKILL_ID: 'avito', TEST_ORIGINAL: original };
  for (const fail of [false, true]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: temporary,
      env: { ...env, ...(fail ? { TEST_THROW: '1' } : {}) }, timeout: 15_000 });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), fail
      ? { schemaVersion: 1, state: 'error', code: 'AVITO_RUNTIME_FAILED' }
      : { schemaVersion: 1, state: 'ready' });
  }
});
