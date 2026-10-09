import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
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

export async function resolveCodexExecutable({ environment = process.env, platform = process.platform,
  filesystem = fs } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const filename = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = String(environment.PATH || '').split(platform === 'win32' ? ';' : ':')
    .filter(directory => paths.isAbsolute(directory)).map(directory => paths.join(directory, filename));
  // The signed host deliberately replaces PATH. Desktop's bundled CLI is not
  // in those system directories, so a bare "codex" silently loses the title.
  // Check only these fixed application locations; do not widen PATH, invoke a
  // shell wrapper, scan plugin caches or read another chat's private files.
  if (platform === 'darwin') {
    for (const application of ['ChatGPT', 'Codex']) {
      candidates.push(`/Applications/${application}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`);
    }
  }
  for (const candidate of new Set(candidates)) {
    try {
      const executable = await filesystem.realpath(candidate);
      if (!paths.isAbsolute(executable) || !(await filesystem.stat(executable)).isFile()) continue;
      await filesystem.access(executable, constants.X_OK);
      return executable;
    } catch { /* Missing or inaccessible CLI keeps the neutral prompt available. */ }
  }
  return null;
}

export async function readCodexThreadTitle(threadId, {
  environment = process.env, executable, arguments: args = ['app-server', '--stdio'],
  platform = process.platform, filesystem = fs,
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
    const launch = async () => {
      const resolvedExecutable = executable || await resolveCodexExecutable({ environment, platform, filesystem });
      // Discovery and metadata share one deadline. A slow filesystem must not
      // spawn a reader after the optional title lookup has already timed out.
      if (settled) return;
      if (!resolvedExecutable) { finish(null); return; }
      try {
        child = spawnProcess(resolvedExecutable, args, {
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
    };
    void launch().catch(() => finish(null));
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
