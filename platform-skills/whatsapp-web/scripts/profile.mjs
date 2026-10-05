import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { childEnvironment, identityKey, requireThat, RuntimeError } from './core.mjs';
import { atomicWrite, ensurePrivateDirectory, verifyPrivate } from './native.mjs';

const STATE_LIMIT = 24 * 1024 * 1024;

// Use the same persistent-profile layout as Telegram Web. Chromium writes its
// complete native storage here, including non-extractable IndexedDB CryptoKeys;
// exporting storageState to JSON would silently lose those objects. This is an
// ordinary local directory, not an encrypted volume or an OS credential vault.
export function browserStorage(directory) {
  const state = path.join(directory, 'state');
  return { state, profile: path.join(state, 'chrome-profile'), journal: path.join(state, 'browser-state.json') };
}

export async function readBrowserState(config) {
  const { journal } = browserStorage(config.directory);
  try {
    await verifyPrivate(journal, config.helper);
    requireThat((await fs.stat(journal)).size <= STATE_LIMIT, 'browser_state_too_large');
    const record = JSON.parse(await fs.readFile(journal, 'utf8'));
    // This binding detects a misplaced journal; it is not a cryptographic
    // boundary against another process running as the same OS user.
    requireThat(record && record.schema === 1 && record.identity === identityKey(config.identity) &&
      (record.serialized === null || typeof record.serialized === 'string'), 'browser_state_invalid');
    return record.serialized;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new RuntimeError('browser_state_invalid');
    throw error;
  }
}

export async function writeBrowserState(config, serialized) {
  requireThat(serialized === null || typeof serialized === 'string', 'browser_state_invalid');
  const storage = browserStorage(config.directory);
  const value = JSON.stringify({ schema: 1, identity: identityKey(config.identity), serialized });
  requireThat(Buffer.byteLength(value) <= STATE_LIMIT, 'browser_state_too_large');
  await ensurePrivateDirectory(storage.state, config.helper);
  await atomicWrite(storage.journal, value, config.helper);
}

export async function forgetBrowserState(config) {
  const storage = browserStorage(config.directory);
  // Forget targets only the new browser store. In particular, never traverse,
  // decrypt or delete browser/session.json, profile.sparseimage, OS keys, or the
  // independent protocol session. The storage transition uses a fresh QR login.
  for (const [file, directory] of [[storage.profile, true], [storage.journal, false]]) {
    try { await verifyPrivate(file, config.helper, directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // On Windows Job termination and release of Chromium file handles can be
    // separated by a short interval. A bounded cleanup retry does not restart
    // the browser, extend its lease, or retry any messaging action.
    await fs.rm(file, { recursive: directory, maxRetries: 10, retryDelay: 100 });
  }
}

export async function browserProfile({ config }) {
  const storage = browserStorage(config.directory);
  await ensurePrivateDirectory(storage.state, config.helper);
  await ensurePrivateDirectory(storage.profile, config.helper);
  return { path: storage.profile };
}

export async function browserExecutable(channel, platform = process.platform, env = process.env) {
  requireThat(['chrome', 'msedge'].includes(channel), 'unsupported_browser');
  requireThat(['darwin', 'win32'].includes(platform), 'unsupported_browser_profile_platform');
  let candidates;
  if (platform === 'darwin') {
    candidates = [channel === 'msedge' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  } else {
    const suffix = channel === 'msedge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe']
      : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    // The signed host may omit ProgramFiles from its environment. Fixed system
    // installation roots remain valid fallbacks; a shell/PATH browser lookup
    // must never replace the selected channel or reuse the user's own profile.
    const roots = [env.PROGRAMFILES || env.ProgramFiles || 'C:\\Program Files',
      env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA];
    candidates = roots.filter(Boolean).map(root => path.win32.join(root, ...suffix));
  }
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new RuntimeError('browser_not_installed');
}

// The loopback CDP endpoint is only an internal Playwright transport. It is
// never returned to the caller; neither endpoint discovery nor browser launch
// opens or copies an existing user Chrome session. The native guardian owns the
// process group on macOS and the worker/browser Job Object on Windows.
export async function readBrowserEndpointFile(file, { platform = process.platform, readFile = fs.readFile } = {}) {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    // Edge briefly denies sharing while writing DevToolsActivePort on Windows.
    // Treat only that EBUSY as "not ready" in the existing deadline/permit loop.
    // No browser is relaunched, no file is changed and permission/format errors
    // still fail closed. Injectable read/platform are synthetic test seams.
    if (error.code === 'ENOENT' || (platform === 'win32' && error.code === 'EBUSY')) return null;
    throw error;
  }
}

export async function launchProfileBrowser({ playwright, profile, permit,
  channel = process.platform === 'win32' ? 'msedge' : 'chrome', headless = false }) {
  const executable = await browserExecutable(channel);
  const endpointFile = path.join(profile.path, 'DevToolsActivePort');
  await fs.rm(endpointFile, { force: true });
  const child = spawn(executable, [`--user-data-dir=${profile.path}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-breakpad', '--disable-crash-reporter', '--disable-extensions',
    '--disable-background-networking', ...(headless ? ['--headless=new'] : []), 'about:blank'],
  { detached: true, windowsHide: true, shell: false, env: childEnvironment(), stdio: 'ignore' });
  const server = new EventEmitter();
  let browser, exited = false;
  const completed = new Promise(resolve => child.once('close', () => { exited = true; server.emit('close'); resolve(); }));
  server.process = () => child;
  server.kill = async () => {
    if (exited) return;
    try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  server.close = async () => {
    if (exited) return;
    // A CDP Browser object may only disconnect on browser.close(). Ask Chromium
    // itself to quit first so its persistent profile is flushed before the next
    // CLI start. Forced cleanup remains bounded by the native supervisor.
    try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {}
    let timer;
    try { await Promise.race([completed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); }
    if (!exited) await server.kill();
    await browser?.close().catch(() => {});
  };
  let launchStage = 'spawn';
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('browser_start_failed'))); });
    launchStage = 'ownership';
    await permit('own', { pid: child.pid });
    launchStage = 'endpoint';
    const until = Date.now() + 30000;
    let endpoint;
    while (Date.now() < until) {
      await permit(); requireThat(!exited, 'browser_closed');
      try {
        const value = await readBrowserEndpointFile(endpointFile);
        if (value !== null) {
          requireThat(value.length < 512, 'browser_endpoint_invalid');
          const [port, route] = value.trim().split(/\r?\n/);
          requireThat(/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535 &&
            /^\/devtools\/browser\/[a-f0-9-]{36}$/.test(route), 'browser_endpoint_invalid');
          endpoint = `http://127.0.0.1:${port}`; break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    requireThat(endpoint, 'browser_start_timeout');
    launchStage = 'cdp';
    // DevToolsActivePort can appear before Edge begins accepting loopback CDP
    // connections on a slow Windows desktop. Connecting is read-only and stays
    // inside the same owned process and lease, so retry only transient CDP
    // startup failures without launching another browser or touching a chat.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await permit();
      requireThat(!exited, 'browser_closed');
      try {
        browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: 10_000 });
        break;
      } catch (error) {
        const transient = /(?:timeout|ECONNREFUSED|ECONNRESET|socket hang up)/iu.test(String(error?.message || ''));
        if (!transient || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    const context = browser.contexts()[0]; requireThat(context, 'browser_context_missing');
    return { browser, context, server };
  } catch (error) {
    await server.kill();
    // Keep the external response content-free while distinguishing a native
    // ownership failure from Chromium startup and CDP transport failures.
    // This makes a slow Windows runner diagnosable without logging a profile,
    // browser stderr, endpoint URL, or any session material.
    const code = launchStage === 'ownership' ? 'browser_ownership_failed'
      : launchStage === 'cdp' ? 'browser_cdp_connect_failed' : 'browser_start_failed';
    const failure = error instanceof RuntimeError ? error : new RuntimeError(code);
    // Internal acceptance evidence may expose only our fixed stage and an
    // allowlisted OS code. Never copy a raw message, browser endpoint, profile
    // path or stderr. Ordinary CLI projections continue to return typed codes.
    failure.launchStage = launchStage;
    if (['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)) {
      failure.systemCode = error.code;
    }
    throw failure;
  }
}
