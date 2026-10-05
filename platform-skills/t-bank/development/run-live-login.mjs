import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, configRoot, identityFromEnv, LEASE_MS, requireThat, RUNTIME_VERSION, RuntimeError, storageDirectory } from '../scripts/core.mjs';
import { atomicWrite, createPrivateFile, nativeHelper, verifyPrivate, verifyKeychain } from '../scripts/native.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { readPrivateJson } from '../scripts/trelio-t-bank.mjs';

// Explicit source-maintenance entrypoint, outside the signed runtime package.
// The caller must have resolved the owner's exact company/member through the
// authorized Trelio context. Identity uses the existing host transport; no
// alternate vault, credential import, setup, or deadline override is accepted.
// All decryption and authentication remain in the unchanged production worker,
// supervised by the same native guardian and a fresh OS owner confirmation.
try {
  requireThat(process.argv.slice(2).join(' ') === '--confirm-live-login', 'explicit_live_login_required');
  requireThat(process.platform === 'darwin', 'live_diagnostic_macos_only');
  const identity = identityFromEnv(), root = configRoot(), helper = await nativeHelper(root);
  const directory = storageDirectory(root, identity);
  await verifyPrivate(directory, helper, true);
  await verifyPrivate(path.join(directory, 'vault.json'), helper);
  let previous = null;
  try { previous = await readPrivateJson(path.join(directory, 'lease.json'), helper); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    // Do not guess PID ownership or stop someone else's active procedure. A
    // stale lease is recoverable only when its native supervisor is proven dead.
    requireThat(Number.isInteger(previous.guardPid) && previous.guardPid > 1, 'stop_existing_session_first');
    let alive = true;
    try { process.kill(previous.guardPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    requireThat(!alive, 'stop_existing_session_first');
    await fs.rm(path.join(directory, 'lease.json'));
    try {
      const control = await readPrivateJson(path.join(directory, 'control.json'), helper);
      if (control.leaseId === previous.leaseId) await fs.rm(path.join(directory, 'control.json'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await verifyKeychain(helper); await loadPlaywright(root);
  const resultDirectory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tbank-live-diagnostic-'));
  const resultFile = path.join(resultDirectory, 'observations.json');
  await createPrivateFile(resultFile, '[]', helper);
  const now = Date.now();
  const lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
    startedAt: now, expiresAt: now + LEASE_MS, guardPid: null };
  const leaseFile = path.join(directory, 'lease.json');
  await createPrivateFile(leaseFile, JSON.stringify(lease), helper);
  const child = spawn(helper, ['guard', process.execPath,
    fileURLToPath(new URL('probe-live-login.mjs', import.meta.url)), String(LEASE_MS)], {
    detached: true, windowsHide: true, shell: false,
    // Only this nonsecret path is added for the diagnostic worker. Production
    // childEnvironment strips it before launching Chrome or key-reading helpers.
    env: { ...childEnvironment(), TRELIO_TBANK_DIAGNOSTIC_RESULT: resultFile },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('guardian_start_failed')));
    });
    lease.guardPid = child.pid; await atomicWrite(leaseFile, JSON.stringify(lease), helper);
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify({ ...lease, identity, root, directory, helper, mode: 'start' })}\n`);
    child.unref();
  } catch (error) {
    // A failed lease write must not leave the native process waiting forever
    // for its first configuration packet. EOF retains native-owned cleanup.
    child.stdin.destroy(); child.unref(); throw error;
  }
  process.stdout.write(`${JSON.stringify({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt,
    resultFile, requiredAction: 'Подтвердите системную разблокировку Trelio.' })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof RuntimeError ? error.code : 'diagnostic_start_failed' })}\n`);
  process.exitCode = 1;
}
