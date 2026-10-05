import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrapBrowser } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';

test('ordinary Playwright context survives T‑ID and supports arbitrary code, uploads and downloads',
  { skip: !['darwin', 'win32'].includes(process.platform), timeout: 600000 }, async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tid-playwright-'));
    let child;
    try {
      await bootstrapBrowser(root);
      const helper = await nativeHelper(root), file = path.join(root, 'result.json');
      // mkdtemp is only the synthetic fixture's parent. Elevated Windows CI
      // gives it an Administrators owner; it is not a private credential path.
      // The real SDK creates its own new handoff directory through the native
      // exact-owner/DACL primitive, which this test exercises without repairing
      // the pre-existing temporary directory or relaxing runtime verification.
      // Browser startup plus the complete caller-owned handoff takes more than
      // 90 seconds on the dedicated ARM64 Windows runner. This five-minute
      // lease is a deadlock guard, not a performance threshold.
      child = spawn(helper, ['guard', process.execPath, fileURLToPath(new URL('playwright-client-worker.mjs', import.meta.url)), '300000'],
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
