import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicWrite, ensurePrivateDirectory, nativeHelper, verifyPrivate } from '../scripts/native.mjs';
import { browserProfile, browserStorage, forgetBrowserState, readBrowserState, writeBrowserState, readBrowserEndpointFile } from '../scripts/profile.mjs';
import { childEnvironment, LEASE_MS } from '../scripts/core.mjs';

const fixture = fileURLToPath(new URL('./profile-fixture.mjs', import.meta.url));
const identity = { skill: 'whatsapp-web', company: '10000000-0000-4000-8000-000000000001',
  member: '10000000-0000-4000-8000-000000000002', connection: '10000000-0000-4000-8000-000000000003' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('Windows endpoint sharing contention is only a pending read of the same file', async () => {
  const file = 'synthetic-DevToolsActivePort';
  let reads = 0;
  const reader = async (target, encoding) => {
    assert.equal(target, file); assert.equal(encoding, 'utf8'); reads++;
    if (reads === 1) throw Object.assign(new Error('not exported'), { code: 'EBUSY' });
    return 'synthetic endpoint contents';
  };
  assert.equal(await readBrowserEndpointFile(file, { platform: 'win32', readFile: reader }), null);
  assert.equal(reads, 1, 'the helper does not retry or extend the caller deadline itself');
  assert.equal(await readBrowserEndpointFile(file, { platform: 'win32', readFile: reader }), 'synthetic endpoint contents');
  for (const [platform, code] of [['win32', 'EACCES'], ['win32', 'EPERM'], ['darwin', 'EBUSY']]) {
    const error = Object.assign(new Error('not exported'), { code });
    await assert.rejects(readBrowserEndpointFile(file, { platform, readFile: async () => { throw error; } }), value => value === error);
  }
});
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  throw Error('condition timed out');
}
async function setup(prefix) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  // Only Windows storage needs the native ACL helper. POSIX store regressions
  // also run on Linux without granting that OS production browser admission.
  const helper = process.platform === 'win32' ? await nativeHelper(root) : undefined;
  const directory = path.join(root, 'connection');
  await ensurePrivateDirectory(directory, helper);
  return { root, directory, helper, identity };
}

test('ordinary profile and plain journal never import legacy encrypted data; reset remains browser-scoped', async () => {
  const config = await setup('wa-local-store-');
  try {
    const legacy = path.join(config.directory, 'browser');
    await ensurePrivateDirectory(legacy, config.helper);
    const oldFiles = [path.join(legacy, 'session.json'), path.join(legacy, 'profile.sparseimage'), path.join(config.directory, 'session.json')];
    for (const file of oldFiles) await atomicWrite(file, 'LEGACY_SYNTHETIC_SENTINEL', config.helper);
    assert.equal(await readBrowserState(config), null);
    const profile = await browserProfile({ config });
    assert.equal(profile.path, path.join(config.directory, 'state', 'chrome-profile'));
    await verifyPrivate(profile.path, config.helper, true);
    const serialized = JSON.stringify({ schema: 2, transport: 'browser', policy: 'read-only', attempts: { SYNTHETIC_CLAIM: { state: 'unknown' } } });
    await writeBrowserState(config, serialized);
    assert.equal(await readBrowserState(config), serialized);
    const journal = browserStorage(config.directory).journal;
    assert.match(await fs.readFile(journal, 'utf8'), /SYNTHETIC_CLAIM/);
    await verifyPrivate(journal, config.helper);
    await assert.rejects(readBrowserState({ ...config, identity: { ...identity, member: randomUUID() } }), /browser_state_invalid/);
    await atomicWrite(journal, 'null', config.helper);
    await assert.rejects(readBrowserState(config), /browser_state_invalid/);
    await forgetBrowserState(config);
    await assert.rejects(fs.stat(profile.path), /ENOENT/);
    await assert.rejects(fs.stat(journal), /ENOENT/);
    for (const file of oldFiles) assert.equal(await fs.readFile(file, 'utf8'), 'LEGACY_SYNTHETIC_SENTINEL');
    if (process.platform === 'win32') {
      // UUID namespaces and atomic filenames routinely approach MAX_PATH.
      // Exercise native ACL creation/read-back beyond it, without moving the
      // helper cache or changing the machine-wide Windows path policy.
      const deep = { ...config, directory: path.join(config.directory, 'a'.repeat(100), 'b'.repeat(100)) };
      assert.ok(browserStorage(deep.directory).journal.length > 260);
      await browserProfile({ config: deep });
      await writeBrowserState(deep, serialized);
      assert.equal(await readBrowserState(deep), serialized);
      await forgetBrowserState(deep);
      assert.equal(await readBrowserState(deep), null);
    }
  } finally { await fs.rm(config.root, { recursive: true }); }
});

test('ordinary profile rejects a redirected directory without touching its target', { skip: process.platform === 'win32' }, async () => {
  const config = await setup('wa-profile-link-');
  try {
    const other = path.join(config.root, 'unrelated');
    await fs.mkdir(other, { mode: 0o700 });
    await fs.writeFile(path.join(other, 'sentinel'), 'UNRELATED', { mode: 0o600 });
    await fs.symlink(other, browserStorage(config.directory).state);
    await assert.rejects(browserProfile({ config }), /unsafe_storage/);
    assert.equal(await fs.readFile(path.join(other, 'sentinel'), 'utf8'), 'UNRELATED');
  } finally { await fs.rm(config.root, { recursive: true }); }
});

test('browser doctor reports ordinary storage without inspecting an existing legacy vault',
  { skip: !['darwin', 'win32'].includes(process.platform), timeout: 60000 }, async () => {
    const config = await setup('wa-profile-doctor-');
    try {
      const directory = path.join(config.root, 'integrations', 'whatsapp-web', identity.company, identity.member, identity.connection);
      await ensurePrivateDirectory(path.join(directory, 'browser'), config.helper);
      await atomicWrite(path.join(directory, 'browser', 'session.json'), 'NOT_A_VAULT', config.helper);
      const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/trelio-whatsapp.mjs', import.meta.url)), 'doctor', '--mode', 'browser'], {
        env: { ...childEnvironment(), TRELIO_CONFIG_HOME: config.root, TRELIO_SKILL_ID: identity.skill,
          TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member,
          TRELIO_SKILL_CONNECTION_ID: identity.connection, TRELIO_SKILL_CONNECTION_CONFIG_JSON: '{}' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      assert.equal(code, 0, error);
      const result = JSON.parse(output);
      assert.equal(result.mode, 'browser'); assert.equal(result.supported, true);
      assert.equal(result.encryption, 'none'); assert.equal(result.storedVault, false);
      assert.equal(result.storedProfile, false); assert.equal(result.keychain.status, 'not_applicable');
      assert.equal(await fs.readFile(path.join(directory, 'browser', 'session.json'), 'utf8'), 'NOT_A_VAULT');
    } finally { await fs.rm(config.root, { recursive: true }); }
  });

test('persistent Chromium profile retains opaque keys and claims across launches; native cleanup closes owned processes',
  { skip: !['darwin', 'win32'].includes(process.platform), timeout: 300000 }, async () => {
    const config = await setup('wa-profile-native-');
    config.helper = await nativeHelper(config.root);
    const sessions = [];
    let acceptanceError;
    const launch = async (testMode, duration = 60000) => {
      for (const file of ['result.json', 'error.json', 'snapshot.png', 'stage.txt']) await fs.rm(path.join(config.directory, file), { force: true });
      const startedAt = Date.now(), leaseId = randomUUID();
      const child = spawn(config.helper, ['guard', process.execPath, fixture, String(duration)], {
        detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const session = { child }; sessions.push(session);
      child.stdin.end(`${JSON.stringify({ ...config, leaseId, startedAt, expiresAt: startedAt + LEASE_MS,
        transport: 'browser', mode: 'start', testMode })}\n`);
      await until(async () => {
        const error = await fs.readFile(path.join(config.directory, 'error.json'), 'utf8').catch(() => null);
        if (error) throw Error(`fixture failed: ${error}`);
        return Boolean(await fs.stat(path.join(config.directory, 'result.json')).catch(() => null));
      }, 70000).catch(async (error) => {
        const stage = await fs.readFile(path.join(config.directory, 'stage.txt'), 'utf8').catch(() => 'not_started');
        throw Error(`fixture ${testMode} stalled at ${stage}: ${error.message}`);
      });
      session.result = JSON.parse(await fs.readFile(path.join(config.directory, 'result.json'), 'utf8'));
      assert.equal(session.result.keyPreserved, true); assert.equal(session.result.extractable, false); assert.equal(session.result.usable, true);
      assert.equal(session.result.policy, 'read-only'); assert.equal(session.result.claimCount, 1);
      assert.equal(session.result.storage.mechanism, 'local_profile'); assert.equal(session.result.storage.encryptedByTrelio, false);
      assert.equal(session.result.profile, browserStorage(config.directory).profile);
      return session;
    };
    try {
      for (const mode of ['write', 'read']) {
        const session = await launch(mode);
        await until(() => !alive(session.child.pid) && !alive(session.result.browserPid));
      }
      await assert.rejects(fs.stat(path.join(config.directory, 'browser', 'profile.sparseimage')), /ENOENT/);
      let session = await launch('hold');
      process.kill(session.child.pid, 'SIGKILL');
      await until(() => !alive(session.result.browserPid));
      // A blocked JS event loop cannot postpone the independent native timer.
      session = await launch('stall', 10000);
      await until(() => !alive(session.child.pid) && !alive(session.result.browserPid), 20000);
    } catch (error) {
      acceptanceError = error; throw error;
    } finally {
      for (const session of sessions) if (alive(session.child.pid)) {
        try { process.platform === 'win32' ? session.child.kill() : process.kill(-session.child.pid, 'SIGKILL'); } catch {}
      }
      await until(() => sessions.every(session => !session.result || !alive(session.result.browserPid))).catch(() => {});
      // Preserve a still-used fixture for diagnosis instead of recursively
      // removing files while a failed cleanup leaves Chromium writing to them.
      if (sessions.every(session => !session.result || !alive(session.result.browserPid))) {
        // Windows can release the process handle before the filesystem finishes
        // releasing Chromium's lockfile after Job termination. Retry only this
        // synthetic cleanup after all recorded browser PIDs have exited. If an
        // earlier assertion failed, a cleanup error must not hide that cause.
        try { await fs.rm(config.root, { recursive: true, maxRetries: 10, retryDelay: 100 }); }
        catch (error) { throw acceptanceError ? new AggregateError([acceptanceError, error], 'profile acceptance and cleanup failed') : error; }
      }
    }
  });
