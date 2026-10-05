import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapBrowser } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';

test('real headed browser: setup closes before bank OTP, human submits directly and the same browser resumes',
  { skip: !['darwin', 'win32'].includes(process.platform), timeout: 900000 }, async t => {
    const root = process.env.TRELIO_TBANK_SYNTHETIC_ROOT || await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 't-bank-browser-test-'));
    await bootstrapBrowser(root); const helper = await nativeHelper(root), file = path.join(root, 'smoke-result.json');
    await fs.rm(file, { force: true });
    // This lease covers the entire growing fixture suite, including browser
    // startup and nine authentication cases. The dedicated ARM64 Windows
    // runner needs more than three minutes here. This ten-minute lease is only
    // a deadlock guard; hard expiry is tested separately below with its own
    // fixed synthetic lease.
    const guard = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('browser-smoke-worker.mjs', import.meta.url)), '600000'],
      { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise(resolve => guard.once('exit', resolve));
    guard.stdin.end(`${JSON.stringify({ root, file })}\n`); const guardExit = await exited;
    let result;
    try { result = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      // The native guardian can kill a stalled fixture before its catch writes
      // a result. Report only the synthetic phase, never a browser DOM dump.
      const progress = await fs.readFile(`${file}.progress`, 'utf8').catch(() => 'not started');
      assert.fail(`Synthetic browser fixture produced no result (guard exit ${guardExit}, phase ${progress}, ${error.code || 'invalid JSON'})`);
    }
    assert.equal(result.ok, true, result.diagnostic); assert.equal(result.openings, 1); assert.equal(result.phase, 'ready');
    assert.equal(result.scenarios, 9);
    // Run the same scenario executor with a blocked event loop in a separate
    // native-owned browser. This proves full JS does not replace the native
    // deadline with a cooperative Promise timeout.
    const hangFile = path.join(root, 'scenario-deadline.json');
    await fs.rm(hangFile, { force: true });
    // Playwright allows 30 seconds for a real browser launch. A 15-second
    // guardian could expire before the blocked scenario even started on a
    // slower Windows VM, testing startup speed instead of native cleanup.
    // Keep a fixed minute for startup plus the hang; the worker cannot extend
    // it, and short native deadlines are already covered in runtime.test.mjs.
    const hangGuard = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('scenario-deadline-worker.mjs', import.meta.url)), '60000'],
      { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const hangExited = new Promise(resolve => hangGuard.once('exit', resolve));
    let pids;
    t.after(() => {
      // A broken guardian regression must not leave a CPU-hung fixture on
      // the maintainer's machine. These are only the fixture's exact PIDs.
      hangGuard.kill('SIGKILL');
      for (const pid of Object.values(pids || {})) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    });
    hangGuard.stdin.end(`${JSON.stringify({ root, file: hangFile })}\n`);
    const startupDeadline = Date.now() + 45000;
    while (!pids && Date.now() < startupDeadline) {
      try { pids = JSON.parse(await fs.readFile(hangFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(pids, 'the scenario must start before its native lease expires');
    await hangExited;
    const alive = pid => {
      try {
        process.kill(pid, 0);
        return process.platform !== 'darwin' || !execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
      } catch { return false; }
    };
    for (let attempt = 0; attempt < 100 && (alive(pids.worker) || alive(pids.browser)); attempt++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pids.worker), false, 'hung scenario worker must be gone');
    assert.equal(alive(pids.browser), false, 'its real browser must also be gone');
    // The screenshots contain only empty synthetic forms, never real values.
    process.stdout.write(`Synthetic GUI artifacts: ${root}\n`);
  });
