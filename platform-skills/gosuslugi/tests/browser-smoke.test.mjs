import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapBrowser } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';

function browserAlive(pid) {
  try {
    process.kill(pid, 0);
    // A macOS zombie has already exited and cannot retain an unlocked browser.
    // Its reaping by launchd is outside this worker's process lifetime.
    if (process.platform === 'darwin') return !execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
    return true;
  } catch (error) { if (error.code === 'ESRCH' || error.status === 1) return false; throw error; }
}

async function runBrowserSmoke(scene) {
    // Preparation is explicit and stays outside the guarded browser lifetime.
    // A missing real editor dependency must fail, never skip its regression.
    if (scene === 'rich-text') await fs.access(new URL('fixtures/quill/node_modules/quill/dist/quill.js', import.meta.url)).catch(() => {
      throw Error('Install the locked editor fixture: npm ci --prefix platform-skills/gosuslugi/tests/fixtures/quill --ignore-scripts');
    });
    const root = process.env.TRELIO_GOSUSLUGI_SYNTHETIC_ROOT || await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gosuslugi-browser-test-'));
    await bootstrapBrowser(root); const helper = await nativeHelper(root), file = path.join(root, scene === 'rich-text' ? 'rich-text-smoke-result.json' : 'smoke-result.json');
    await fs.rm(file, { force: true });
    // Browser launch alone may legitimately take up to 30 seconds. The former
    // 25-second lease killed slow hosted Macs before Playwright could report a
    // result. Keep a hard synthetic minute; production's deadline is unchanged
    // and crash/expiry guarantees are covered by separate native tests.
    const guard = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('browser-smoke-worker.mjs', import.meta.url)), '60000'],
      { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise(resolve => guard.once('exit', resolve));
    guard.stdin.end(`${JSON.stringify({ root, file, scene })}\n`); await exited;
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(result.ok, true, result.diagnostic); assert.equal(result.openings, scene === 'rich-text' ? 0 : 1); assert.equal(result.phase, 'ready');
    assert.ok(Number.isInteger(result.browserPid) && result.browserPid > 1);
    for (let attempt = 0; attempt < 50 && browserAlive(result.browserPid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(browserAlive(result.browserPid), false, 'native shutdown must reap the owned browser before success');
    // The screenshots contain only empty synthetic forms, never real values.
    process.stdout.write(`Synthetic GUI artifacts: ${root}\n`);
}

const nativeOptions = { skip: !['darwin', 'win32'].includes(process.platform), timeout: 180000 };
test('real headed browser: one local form, optional TOTP, actual SMS challenge and same browser through authentication',
  nativeOptions, () => runBrowserSmoke('portal'));
test('real Quill: exact text, form-model synchronization, restored draft and field constraints without submission',
  nativeOptions, () => runBrowserSmoke('rich-text'));
