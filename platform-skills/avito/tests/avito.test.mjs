import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvitoCommand, runAvito } from '../scripts/trelio-avito.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

test('coordinate interface rejects script/selector/path overrides before host I/O', async () => {
  assert.deepEqual(parseAvitoCommand(['scroll', '--frameId', 'frame', '--x', '0', '--y', '40', '--deltaY', '900']), { operation: 'scroll', args: { frameId: 'frame', x: 0, y: 40, deltaY: 900 } });
  for (const args of [['evaluate', '--script', 'document.body'], ['click', '--selector', '#login'], ['setup', '--executable', '/browser'], ['status', '--path', '/private'], ['key', '--frameId', 'frame', '--key', 'Enter', '--key', 'Tab']]) assert.throws(() => parseAvitoCommand(args), /AVITO_COMMAND_INVALID/);
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
