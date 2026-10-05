import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapBrowser } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';

// Twelve headed synthetic scenarios exhausted four minutes on the persistent
// ARM64 Windows CI VM after the native/browser suites. Keep a six-minute native
// test guard and a separate outer budget for bootstrap/cleanup. Production's
// 30-minute lease is unchanged; the worker writes synthetic progress so an
// interrupted run reports its actual stage rather than a missing result file.
const SYNTHETIC_GUARD_MS = 360_000;

test('ordinary Playwright context survives ESIA and supports arbitrary code, uploads and downloads',
  { skip: !['darwin', 'win32'].includes(process.platform), timeout: 420_000 }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'esia-playwright-'));
    let child;
    try {
      await bootstrapBrowser(root);
      const helper = await nativeHelper(root), file = path.join(root, 'result.json');
      // mkdtemp is only the synthetic fixture's parent. Elevated Windows CI
      // gives it an Administrators owner; it is not a private credential path.
      // The real SDK creates its own new handoff directory through the native
      // exact-owner/DACL primitive, which this test exercises without repairing
      // the pre-existing temporary directory or relaxing runtime verification.
      child = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('playwright-client-worker.mjs', import.meta.url)), String(SYNTHETIC_GUARD_MS)],
        { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      child.stdin.end(JSON.stringify({ root, file }) + '\n'); await exited;
      const result = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(result.ok, true, `${result.stage}: ${result.diagnostic}`);
      assert.throws(() => process.kill(result.browserPid, 0), { code: 'ESRCH' });
    } finally {
      if (child?.exitCode === null) child.kill();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
