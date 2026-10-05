import { spawn } from 'node:child_process';
import { nativeRequestTitleInput } from './native.mjs';

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 256 * 1024;

function validTitle(value) {
  try { nativeRequestTitleInput(value); return value; } catch { return null; }
}

function appServerEnvironment(environment) {
  // The title is local UI context. Do not pass Trelio credentials or arbitrary
  // provider environment through to the separate Codex metadata reader.
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot',
    'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'CODEX_HOME'];
  return Object.fromEntries(keys.filter(key => environment[key]).map(key => [key, environment[key]]));
}

export async function readCodexThreadTitle(threadId, {
  environment = process.env, executable = 'codex', arguments: args = ['app-server', '--stdio'],
  timeoutMs = 3000, spawnProcess = spawn,
} = {}) {
  if (!THREAD_ID.test(threadId || '')) return null;
  return new Promise(resolve => {
    let child, settled = false, buffer = '', bytes = 0;
    const finish = title => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child?.kill(); resolve(title);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawnProcess(executable, args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: appServerEnvironment(environment),
      });
    } catch { finish(null); return; }
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) { finish(null); return; }
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let packet; try { packet = JSON.parse(line); } catch { continue; }
        if (packet.id === 1 && packet.result) {
          try {
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/read',
              params: { threadId, includeTurns: false } })}\n`);
          } catch { finish(null); }
        } else if (packet.id === 1 && packet.error) finish(null);
        else if (packet.id === 2) {
          const thread = packet.result?.thread;
          finish(thread?.id === threadId ? validTitle(thread.name) : null);
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'trelio-gosuslugi-title', version: '1' } } })}\n`);
    } catch { finish(null); }
  });
}

export async function resolveRequestTitle(requestTitle, { environment = process.env,
  readThreadTitle = readCodexThreadTitle } = {}) {
  const threadId = environment.CODEX_THREAD_ID;
  if (threadId) {
    // Codex owns the chat name. Prefer its exact metadata over every caller
    // hint; an explicitly supplied title is used only if this read fails.
    const title = validTitle(await readThreadTitle(threadId, { environment }).catch(() => null));
    if (title) return title;
  }
  // A caller may supply a verified exact title as a fallback. Without one,
  // the native helper uses its neutral reason rather than a guessed topic.
  return validTitle(requestTitle);
}
