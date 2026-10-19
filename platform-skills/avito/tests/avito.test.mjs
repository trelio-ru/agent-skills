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
  assert.equal((await runAvito(['doctor'], {})).hostVisualAvailable, false);
  await assert.rejects(runAvito(['screenshot'], {}), /AVITO_HOST_REQUIRED/);
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
