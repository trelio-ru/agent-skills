import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const moduleUrl = new URL('../../_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs', import.meta.url).href;

/** Real short-lived provider CLIs address two synthetic control servers under
 * the SAME account. Native helpers check actual private paths; no vault/key,
 * login, user browser, external request or real guardian is ever opened. Only
 * the two Node children created here can be terminated by these fixtures. */
export function registerParallelSessionContract(skillUrl, { identity, storageDirectory, version,
  nativeHelper, ensurePrivateDirectory, atomicWrite, verifyPrivate, childEnvironment }) {
  test('native Windows private state supports long owner paths with unchanged SID and ACL checks', {
    skip: process.platform !== 'win32', timeout: 60000,
  }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-long-owner-state-')));
    try {
      const helper = await nativeHelper(root);
      // Use ordinary caller paths, not an already-prefixed test-only shortcut.
      // The production native helper must normalize before its ACL/file APIs.
      const directory = path.join(root, 'private', 'x'.repeat(90), 'y'.repeat(90), 'z'.repeat(90));
      const file = path.join(directory, 'state.json');
      assert.ok(file.length > 300);
      await ensurePrivateDirectory(directory, helper);
      await atomicWrite(file, '{"synthetic":1}', helper);
      await verifyPrivate(file, helper);
      await atomicWrite(file, '{"synthetic":2}', helper);
      await ensurePrivateDirectory(directory, helper);
      await verifyPrivate(file, helper);
      assert.equal(await fs.readFile(file, 'utf8'), '{"synthetic":2}');
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  test('two real chat CLIs address separate workers and stop only their own synthetic guardian', {
    skip: !['darwin', 'win32'].includes(process.platform), timeout: 60000,
  }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-parallel-cli-')));
    const servers = [], children = [], closures = [], hits = [[], []], ids = [randomUUID(), randomUUID()];
    const owners = [randomUUID(), randomUUID()], account = storageDirectory(root, identity);
    const host = await import(moduleUrl);
    try {
      const helper = await nativeHelper(root);
      await ensurePrivateDirectory(account, helper);
      for (let index = 0; index < 2; index++) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true, stdio: 'ignore', shell: false });
        children.push(child);
        closures.push(new Promise(resolve => child.once('close', resolve)));
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const server = http.createServer(async (request, response) => {
          let body = ''; for await (const chunk of request) body += chunk;
          const packet = JSON.parse(body); hits[index].push(packet.command);
          assert.equal(packet.sessionId, ids[index]);
          if (packet.command === 'stop') child.kill();
          response.end(JSON.stringify({ phase: packet.command === 'stop' ? 'closed' : 'ready', sessionId: ids[index] }));
        });
        servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const directory = host.browserExecutionDirectory(account, { TRELIO_SKILL_RUNTIME_SESSION_ID: owners[index] });
        await ensurePrivateDirectory(directory, helper);
        const startedAt = Date.now();
        await atomicWrite(path.join(directory, 'lease.json'), JSON.stringify({ leaseId: ids[index], runtimeVersion: version,
          startedAt, expiresAt: startedAt + 60000, guardPid: child.pid }), helper);
        await atomicWrite(path.join(directory, 'control.json'), JSON.stringify({ leaseId: ids[index], port: server.address().port,
          token: 'a'.repeat(64) }), helper);
      }
      const command = async (index, args) => {
        const startedAt = Date.now();
        return execute(process.execPath, [fileURLToPath(new URL(`scripts/trelio-${identity.skill}.mjs`, skillUrl)), ...args], {
          windowsHide: true, timeout: 15000, encoding: 'utf8', env: { ...childEnvironment(),
            TRELIO_CONFIG_HOME: root, TRELIO_SKILL_ID: identity.skill,
            TRELIO_SKILL_COMPANY_ID: identity.company, TRELIO_SKILL_MEMBER_ID: identity.member,
            TRELIO_SKILL_RUNTIME_SESSION_ID: owners[index], TRELIO_BROWSER_SESSION_MODULE_URL: moduleUrl,
            TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', leaseMs: 1800000, manualAssist: false }),
            TRELIO_BROWSER_SESSION_STARTED_AT: String(startedAt), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(startedAt + 1800000),
          },
        });
      };
      const statuses = await Promise.all(ids.map((id, index) => command(index, ['status', '--session', id])));
      assert.deepEqual(statuses.map(value => JSON.parse(value.stdout).sessionId), ids);
      const before = hits.flat().length;
      await assert.rejects(command(0, ['stop', '--session', ids[1]]));
      assert.equal(hits.flat().length, before, 'foreign stop is refused before dispatch');
      assert.equal(JSON.parse((await command(0, ['stop', '--session', ids[0]])).stdout).phase, 'closed');
      assert.equal(JSON.parse((await command(1, ['status', '--session', ids[1]])).stdout).phase, 'ready');
      assert.equal(JSON.parse((await command(1, ['stop', '--session', ids[1]])).stdout).phase, 'closed');
      assert.equal(hits[0].filter(value => value === 'stop').length, 1);
      assert.equal(hits[1].filter(value => value === 'stop').length, 1);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(closures);
      for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
