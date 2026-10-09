#!/usr/bin/env node
import { validateWaitOptions, waitForSessionChange, withSessionContinuation, finishedReceiptPhase } from './session-wait.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, configRoot, identityFromEnv, importExistingAccounts, LEASE_MS, requireThat, RUNTIME_VERSION, RuntimeError, serviceHttpFailure, storageDirectory } from './core.mjs';
import { atomicWrite, createPrivateFile, ensurePrivateDirectory, nativeHelper, SOURCE, verifyPrivate, keychainStatus, verifyKeychain } from './native.mjs';
import { bootstrap as bootstrapBrowser, dependencies as loadPlaywright } from './dependencies.mjs';
import { validateRequest } from './client.mjs';
import { browserStorage } from './profile.mjs';

const COMMANDS = ['help', 'doctor', 'bootstrap', 'start', 'wait', 'status', 'request', 'stop', 'forget'];
export function parseArguments(args) {
  const [command = 'doctor', ...rest] = args;
  requireThat(COMMANDS.includes(command), 'unknown_command');
  const options = {};
  while (rest.length) {
    const flag = rest.shift();
    requireThat(['--after-phase', '--timeout-seconds', '--session', '--channel', '--confirm', '--input', '--mode','--headless'].includes(flag) && !Object.hasOwn(options, flag), 'unsupported_option');
    options[flag] = ['--confirm','--headless'].includes(flag) ? true : rest.shift();
  }
  const allowed = command === 'wait' ? ['--session', '--after-phase', '--timeout-seconds'] : ['status', 'request', 'stop'].includes(command) ? ['--session', ...(command === 'request' ? ['--input'] : [])]
    : ['forget'].includes(command) ? ['--confirm', '--channel', '--mode'] : command === 'start' ? ['--channel', '--mode','--headless']
      : ['doctor', 'bootstrap'].includes(command) ? ['--mode'] : [];
  requireThat(Object.keys(options).every(key => allowed.includes(key)), 'unsupported_option');
  if (options['--channel']) requireThat(['chrome', 'msedge'].includes(options['--channel']), 'unsupported_browser');
  if (options['--mode']) requireThat(['protocol','browser'].includes(options['--mode']), 'unsupported_mode');
  requireThat(!options['--headless']||options['--mode']==='browser','headless_requires_browser_mode');
  if (options['--session']) requireThat(/^[a-f0-9-]{36}$/.test(options['--session']), 'session_invalid');
  if (['forget'].includes(command)) requireThat(options['--confirm'], 'explicit_confirmation_required');
  if (command === 'wait') validateWaitOptions(options);
  return { command, options };
}
export async function readPrivateJson(file, helper) {
  await verifyPrivate(file, helper); const stat = await fs.stat(file);
  requireThat(stat.size <= 16384, 'local_state_invalid'); return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function optionalJson(file, helper) {
  try { return await readPrivateJson(file, helper); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function requestControl(control, packet, timeoutMs = 30000) {
  requireThat(Number.isInteger(control.port) && control.port > 0 && control.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(control.token), 'local_control_invalid');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(packet);
    const req = http.request({ hostname: '127.0.0.1', port: control.port, path: '/', method: 'POST', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8');
      let bytes = 0;
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { reject(new RuntimeError('control_result_too_large')); res.destroy(); req.destroy(); return; }
        text += chunk;
      });
      // Destroyed/partial responses do not emit end. Always settle the caller
      // without retrying a mutation whose server-side outcome is unknown.
      res.on('aborted', () => reject(new RuntimeError('control_result_incomplete')));
      res.on('error', () => reject(new RuntimeError('control_result_incomplete')));
      res.on('end', () => {
        try { const value = JSON.parse(text); if (res.statusCode === 200) resolve(value);
          else reject(new RuntimeError(/^[a-z_]+$/.test(value.error) ? value.error : 'operation_failed', value)); }
        catch (error) { reject(error instanceof RuntimeError ? error : new RuntimeError('control_result_invalid')); }
      });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => reject(new RuntimeError('session_unreachable'))); req.end(body);
  });
}
async function leaseAlive(lease) {
  if (!lease.guardPid) return Date.now() < lease.startedAt + 30000;
  requireThat(Number.isInteger(lease.guardPid) && lease.guardPid > 1, 'lease_invalid');
  try { process.kill(lease.guardPid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
async function verifyBrowserUnmounted(directory, lease) {
  if (lease.transport !== 'browser' || lease.browserStorage === 'local_profile') return;
  const parent = path.join(directory, 'browser');
  const mount = path.join(parent, `mount-${lease.leaseId}`);
  try {
    const [volume, container] = await Promise.all([fs.lstat(mount), fs.lstat(parent)]);
    // A dead owner proves process shutdown, not successful volume detach.
    // Do not report closed, delete records, start or forget while the old
    // decrypted filesystem is still mounted after an OS cleanup failure.
    requireThat(!volume.isSymbolicLink() && volume.dev === container.dev, 'browser_profile_still_mounted');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function doctor(directory, helper, root, mode = 'protocol') {
  const lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  let configured = false, runtimeReady = false;
  const browser = mode === 'browser';
  const supported = browser || process.platform === 'darwin';
  try {
    await verifyPrivate(browser ? browserStorage(directory).profile : path.join(directory, 'session.json'), helper, browser);
    configured = true;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await loadPlaywright(root); runtimeReady = true; } catch {}
  // A regular browser profile does not need a credential-store preflight.
  // In particular, a locked/unavailable Keychain must not block browser login.
  const keychain = browser ? { status: 'not_applicable' } : await keychainStatus(helper);
  return { platform: process.platform, mode, supported, runtimeReady, storedVault: !browser && configured,
    ...(browser ? { storedProfile: configured } : {}), keychain,
    encryption: browser ? 'none' : process.platform === 'win32' ? 'AES-256-GCM + DPAPI CurrentUser' : 'AES-256-GCM + login Keychain',
    runtimeOwnerConfirmation: false,
    leaseActive: Boolean(lease && await leaseAlive(lease)), maxSessionMinutes: 30,
    requiredAction: !supported ? 'На Windows используйте браузерный режим: doctor --mode browser, затем start --mode browser.'
      : keychain.status === 'action_required'
      ? 'Восстановите доступ к связке login средствами macOS; повторный Touch ID не исправляет отказ Keychain.'
      : !runtimeReady ? 'bootstrap' : !configured ? 'start: QR-вход в локальном окне' : 'start: повторное использование сохранённой сессии WhatsApp' };
}
export async function run(args, statusTimeoutMs = 30000) {
  if (args.length === 1 && args[0] === "__trelio_accounts_import") return importExistingAccounts();
  const { command, options } = parseArguments(args);
  if (command === 'wait') return waitForSessionChange(remaining =>
    run(['status', '--session', options['--session']], remaining), options);
  // The signed package includes its request schema reference; catalog agents
  // need no private source checkout to discover command arguments.
  if (command === 'help') return { instructions: await fs.readFile(path.join(SOURCE, '../references/commands.md'), 'utf8') };
  const identity = identityFromEnv(), root = configRoot();
  let connection;
  try { connection = JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON || ''); } catch { throw new RuntimeError('host_connection_config_required'); }
  // Current manifests have no configurable sending permission. Accept the
  // deprecated boolean only for old normalized host snapshots; it has no
  // runtime authority, including when its saved value is true.
  requireThat(connection && typeof connection === 'object' && !Array.isArray(connection) &&
    Object.keys(connection).every(key => key === 'allowAutonomous') &&
    (connection.allowAutonomous === undefined || typeof connection.allowAutonomous === 'boolean'), 'host_connection_config_required');
  const helper = await nativeHelper(root), directory = storageDirectory(root, identity);
  await ensurePrivateDirectory(directory, helper);
  if (command === 'bootstrap') { await bootstrapBrowser(root); return doctor(directory, helper, root, options['--mode']); }
  if (command === 'doctor') return doctor(directory, helper, root, options['--mode']);
  let lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  const control = await optionalJson(path.join(directory, 'control.json'), helper);
  // An unlocked worker belongs to the company that started it. Reusing the
  // account in another company requires a new worker after normal shutdown;
  // a catalogue binding never transfers an existing operation's authority.
  if (lease && await leaseAlive(lease) && identity.account) {
    const oldOwner = identity.account.providerRef ? JSON.parse(identity.account.providerRef) : null;
    const sameLegacyScope = !lease.companyBinding && oldOwner?.company === identity.company && oldOwner?.member === identity.member;
    requireThat(lease.companyBinding === identity.account.companyBinding || sameLegacyScope, 'account_in_use_in_another_company');
  }
  if (['start', 'forget'].includes(command)) {
    const transport=options['--mode']||'protocol';
    requireThat(transport === 'browser' || process.platform === 'darwin', 'protocol_not_supported_on_windows');
    if (lease && await leaseAlive(lease)) {
      requireThat(command === 'start', 'stop_existing_session_first');
      requireThat(lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
      requireThat((lease.transport||'protocol')===transport, 'stop_other_transport_first');
      requireThat(Boolean(lease.headless)===Boolean(options['--headless']),'stop_other_browser_mode_first');
      requireThat(lease.expiresAt > Date.now(), 'expired_guard_still_running');
      if (control && control.leaseId === lease.leaseId) return withSessionContinuation(await requestControl(control, { command: 'status', sessionId: lease.leaseId }));
      return withSessionContinuation({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt });
    }
    // A dead supervisor permits recovery of only these exact disposable control
    // records. Ciphertext and native OS keys are never removed as crash cleanup.
    if (lease) {
      await verifyBrowserUnmounted(directory, lease);
      await fs.rm(path.join(directory, 'lease.json'));
      if (control && control.leaseId === lease.leaseId) await fs.rm(path.join(directory, 'control.json'));
    }
    // Verify OS secret-store availability without an extra runtime confirmation.
    // The OS itself still controls locked-store and application trust prompts.
    if (command !== 'forget') {
      if (transport === 'protocol') await verifyKeychain(helper);
      await loadPlaywright(root);
    }
    // Browser and protocol credentials remain independent. They share one
    // control lease so a fallback cannot silently run two sending devices at
    // once or reuse the other mode's mutation journal.
    const now = Date.now(); lease = { companyBinding: identity.account?.companyBinding ?? null, leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, transport,
      ...(transport === 'browser' ? { browserStorage: 'local_profile' } : {}),
      headless:options['--headless']===true, startedAt: now, expiresAt: now + LEASE_MS, guardPid: null };
    const file = path.join(directory, 'lease.json');
    await createPrivateFile(file, JSON.stringify(lease), helper);
    // Storage and process ownership are independent. Both modes retain the
    // existing native deadline/cleanup, but browser mode never requests a key
    // or mounts an encrypted volume. The old credential helper stays unchanged.
    const child = spawn(helper, ['guard', process.execPath, path.join(SOURCE, 'worker.mjs'), String(LEASE_MS)], {
      detached: true, windowsHide: true, shell: false, env: { ...childEnvironment(), TRELIO_BROWSER_SESSION_MODULE_URL: process.env.TRELIO_BROWSER_SESSION_MODULE_URL }, stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('guardian_start_failed'))); });
      lease.guardPid = child.pid; await atomicWrite(file, JSON.stringify(lease), helper);
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({ ...lease, identity, root, directory, helper, mode: command, channel: options['--channel'] })}\n`);
      child.unref();
    } catch (error) { child.stdin.destroy(); throw error; }
    return withSessionContinuation({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt, requiredAction: options['--headless'] ? 'Дождитесь ready; состояние загрузки не означает потерю привязки.' : 'При первой настройке отсканируйте QR-код в локальном окне WhatsApp.' });
  }
  if (['status', 'stop'].includes(command) && lease && !await leaseAlive(lease)) {
    requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
    await verifyBrowserUnmounted(directory, lease);
    // Native cleanup can terminate the worker before it removes disposable
    // records. A proven-dead supervisor is closed regardless of stale status;
    // its loopback port may already belong to another process. Never send the
    // old control bearer there, and never remove ciphertext as crash cleanup.
    const last = await optionalJson(path.join(directory, 'status.json'), helper);
    return { sessionId: lease.leaseId, phase: command === 'status' ? finishedReceiptPhase(last, lease.leaseId) : 'closed', expiresAt: lease.expiresAt, requiredAction: null,
      ...(last?.sessionId === lease.leaseId && last.error ? { error: last.error, ...serviceHttpFailure(last) } : {}) };
  }
  if (command === 'status' && (!lease || !control)) {
    const last = await optionalJson(path.join(directory, 'status.json'), helper);
    if (lease && !control && options['--session'] === lease.leaseId &&
      last?.sessionId !== lease.leaseId && await leaseAlive(lease))
      return { phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt };
    requireThat(last && options['--session'] === last.sessionId, 'no_active_session');
    return { ...last, phase: finishedReceiptPhase(last, last.sessionId), requiredAction: null };
  }
  requireThat(lease && control && lease.leaseId === control.leaseId, 'no_active_session');
  requireThat(['status', 'stop'].includes(command) || lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
  requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
  let extra = {};
  if (command === 'request') {
    // Bodies travel in a bounded local file, never in process arguments. The
    // request contains chat operations only, never QR/session credentials.
    requireThat(options['--input'] && path.isAbsolute(options['--input']), 'absolute_input_required');
    const stat = await fs.lstat(options['--input']);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536, 'input_file_invalid');
    await verifyPrivate(options['--input'], helper);
    try { extra = JSON.parse(await fs.readFile(options['--input'], 'utf8')); } catch { throw new RuntimeError('request_invalid'); }
    validateRequest(extra);
  }
  const result = await requestControl(control, { ...extra, command: command === 'request' ? extra.command : command, sessionId: lease.leaseId }, statusTimeoutMs);
  if (command === 'stop') {
    // Confirm actual process shutdown, not merely acceptance of the stop request.
    for (let attempt = 0; attempt < (lease.transport==='browser'?150:30); attempt++) {
      if (!await leaseAlive(lease)) {
        await verifyBrowserUnmounted(directory, lease);
        return { phase: 'closed', sessionId: lease.leaseId };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new RuntimeError('shutdown_not_confirmed');
  }
  return result;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error instanceof RuntimeError ? error.code : 'runtime_failed', ...serviceHttpFailure(error) })}\n`); process.exitCode = 1; }
}
