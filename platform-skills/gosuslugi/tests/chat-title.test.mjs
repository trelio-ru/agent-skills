import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { resolveCodexExecutable, readCodexThreadTitle, resolveRequestTitle } from '../scripts/chat-title.mjs';
import { nativeRequestTitleInput } from '../scripts/native.mjs';

const threadId = '33333333-3333-4333-8333-333333333333';
const title = 'Проверить название чата';
const bundleCli = application =>
  `/Applications/${application}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const absent = () => { throw Object.assign(new Error('synthetic_missing'), { code: 'ENOENT' }); };

function bundleFilesystem(application) {
  const executable = bundleCli(application);
  return {
    realpath: async candidate => candidate === executable ? executable : absent(),
    stat: async candidate => { assert.equal(candidate, executable); return { isFile: () => true }; },
    access: async (candidate, mode) => { assert.equal(candidate, executable); assert.equal(mode, constants.X_OK); },
  };
}

// This is a real subprocess/protocol fixture, not a pre-resolved title. The
// platform filesystem supplies the fixed bundle path, and the adapter executes
// that synthetic CLI with the exact restricted environment on each native OS.
function protocolFixture(responseThreadId = threadId) {
  return `let pending = ''; process.stdin.on('data', chunk => {
    pending += chunk.toString(); let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const packet = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (packet.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
      if (packet.id === 2) {
        const valid = packet.method === 'thread/read' && packet.params.threadId === ${JSON.stringify(threadId)}
          && packet.params.includeTurns === false;
        process.stdout.write(JSON.stringify({ id: 2, result: { thread: {
          id: ${JSON.stringify(responseThreadId)}, name: valid ? ${JSON.stringify(title)} : 'invalid'
        } } }) + '\\n');
      }
    }
  });`;
}

test('protected PATH resolves both desktop bundle locations before reading the exact chat', async () => {
  for (const application of ['ChatGPT', 'Codex']) {
    const environment = { PATH: '/usr/bin:/bin', CODEX_THREAD_ID: threadId,
      TRELIO_TOKEN: 'synthetic-excluded', OPENAI_API_KEY: 'synthetic-excluded' };
    let launches = 0;
    const readThreadTitle = (id, options) => readCodexThreadTitle(id, {
      ...options, platform: 'darwin', filesystem: bundleFilesystem(application),
      timeoutMs: 2000,
      spawnProcess(executable, args, childOptions) {
        launches++;
        assert.equal(executable, bundleCli(application), 'never dispatch the bare PATH alias');
        assert.deepEqual(args, ['app-server', '--stdio']);
        assert.equal(childOptions.shell, false);
        assert.equal(childOptions.env.PATH, environment.PATH, 'discovery must not widen the protected PATH');
        assert.deepEqual(Object.keys(childOptions.env), ['PATH'], 'no credentials or unrelated identity reach the metadata reader');
        return spawn(process.execPath, ['-e', protocolFixture()], childOptions);
      },
    });
    const selected = await resolveRequestTitle('Другая тема', { environment, readThreadTitle });
    assert.equal(selected, title);
    assert.equal(launches, 1);
    // The exact metadata survives the existing private stdin boundary to the
    // frozen native helper; no title is put in argv, env or persistent state.
    assert.deepEqual(JSON.parse(nativeRequestTitleInput(selected)), { schema: 1, requestTitle: title });
  }
});

test('a discovered CLI cannot supply another chat title', async () => {
  const actual = await readCodexThreadTitle(threadId, {
    environment: { PATH: '/usr/bin:/bin' }, platform: 'darwin',
    filesystem: bundleFilesystem('Codex'), timeoutMs: 2000,
    spawnProcess: (executable, args, options) => spawn(process.execPath,
      ['-e', protocolFixture('44444444-4444-4444-8444-444444444444')], options),
  });
  assert.equal(actual, null);
});

test('executable discovery skips relative PATH, directories and non-executable candidates', async () => {
  const seen = [];
  const environment = { PATH: '.:relative:/directory:/denied:/trusted' };
  const executable = await resolveCodexExecutable({ environment, platform: 'linux', filesystem: {
    realpath: async candidate => { seen.push(candidate); return candidate; },
    stat: async candidate => ({ isFile: () => candidate !== '/directory/codex' }),
    access: async candidate => { if (candidate === '/denied/codex') throw new Error('synthetic_denied'); },
  } });
  assert.equal(executable, '/trusted/codex');
  assert.deepEqual(seen, ['/directory/codex', '/denied/codex', '/trusted/codex']);
  const windowsCli = await resolveCodexExecutable({
    environment: { PATH: String.raw`.;relative;C:\Tools` }, platform: 'win32',
    filesystem: {
      realpath: async candidate => candidate,
      stat: async () => ({ isFile: () => true }), access: async () => {},
    },
  });
  assert.equal(windowsCli, String.raw`C:\Tools\codex.exe`);
});

test('missing CLI or invalid thread stays neutral without spawning', async () => {
  let launches = 0;
  const options = { environment: { PATH: '' }, platform: 'darwin',
    filesystem: { realpath: async () => absent() },
    spawnProcess: () => { launches++; throw new Error('unexpected_launch'); } };
  assert.equal(await readCodexThreadTitle(threadId, options), null);
  assert.equal(await readCodexThreadTitle('not-a-thread', options), null);
  assert.equal(launches, 0);
});

test('the title deadline also covers discovery and prevents a late child launch', async () => {
  let releaseDiscovery, launches = 0;
  const waiting = new Promise(resolve => { releaseDiscovery = resolve; });
  const result = await readCodexThreadTitle(threadId, {
    environment: { PATH: '/trusted' }, platform: 'linux', timeoutMs: 20,
    filesystem: {
      realpath: async () => waiting,
      stat: async () => ({ isFile: () => true }), access: async () => {},
    },
    spawnProcess: () => { launches++; throw new Error('unexpected_launch'); },
  });
  assert.equal(result, null);
  releaseDiscovery('/trusted/codex');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
});
