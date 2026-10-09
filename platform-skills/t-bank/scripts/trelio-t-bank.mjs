#!/usr/bin/env node
import { validateWaitOptions, waitForSessionChange, withSessionContinuation, finishedReceiptPhase } from './session-wait.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, configRoot, identityFromEnv, LEASE_MS, requireThat, RUNTIME_VERSION, RuntimeError, serviceHttpFailure, storageDirectory } from './core.mjs';
import { atomicWrite, createPrivateFile, ensurePrivateDirectory, nativeHelper, nativeKeyHelper,
  nativeRequestTitleInput, SOURCE, verifyPrivate, keychainStatus, verifyKeychain } from './native.mjs';
import { bootstrapBrowser, loadPlaywright } from './browser.mjs';
import { validatedPagePacket } from './page-actions.mjs';
import { compileScenario, MAX_SCRIPT_BYTES } from './scenario.mjs';
import { readAuthorization } from './transport.mjs';
import { resolveRequestTitle } from './chat-title.mjs';

const COMMANDS = ['client', 'doctor', 'bootstrap', 'authorize', 'start', 'wait', 'status', 'resume', 'snapshot', 'page', 'script', 'show', 'stop', 'configure', 'forget'];
export function parseArguments(args) {
  const [command = 'doctor', ...rest] = args;
  requireThat(COMMANDS.includes(command), 'unknown_command');
  const options = {};
  while (rest.length) {
    const flag = rest.shift();
    requireThat(['--after-phase', '--timeout-seconds', '--session', '--channel', '--confirm', '--dry-run', '--browser-session', '--request', '--origin', '--navigate', '--click', '--input-file', '--request-title'].includes(flag) && !Object.hasOwn(options, flag), 'unsupported_option');
    options[flag] = ['--confirm', '--dry-run'].includes(flag) ? true : rest.shift();
    requireThat(options[flag] !== undefined, 'option_value_required');
  }
  const allowed = command === 'wait' ? ['--session', '--after-phase', '--timeout-seconds'] : ['status', 'resume', 'snapshot', 'show', 'stop'].includes(command) ? ['--session']
    : command === 'page' ? ['--session', '--confirm', '--dry-run', '--navigate', '--click', '--input-file']
    : command === 'script' ? ['--session', '--input-file']
    : command === 'authorize' ? ['--browser-session', '--request', '--origin', '--confirm', '--request-title']
    : ['configure', 'forget'].includes(command) ? ['--confirm', '--channel', '--request-title']
    : command === 'start' ? ['--channel', '--request-title'] : [];
  requireThat(Object.keys(options).every(key => allowed.includes(key)), 'unsupported_option');
  if (options['--channel']) requireThat(['chrome', 'msedge'].includes(options['--channel']), 'unsupported_browser');
  if (options['--request-title'] !== undefined) nativeRequestTitleInput(options['--request-title']);
  if (options['--session']) requireThat(/^[a-f0-9-]{36}$/.test(options['--session']), 'session_invalid');
  if (command === 'authorize') {
    requireThat(options['--confirm'] === true, 'authorization_permission_required');
    requireThat(/^[a-f0-9-]{36}$/.test(options['--browser-session'] || '') &&
      /^[a-f0-9-]{36}$/.test(options['--request'] || ''), 'authorization_request_invalid');
    let origin;
    try { origin = new URL(options['--origin']); }
    catch { throw new RuntimeError('authorization_origin_invalid'); }
    requireThat(origin.protocol === 'https:' && origin.origin === options['--origin'] &&
      !origin.username && !origin.password && !origin.port, 'authorization_origin_invalid');
  }
  requireThat(['--navigate', '--click', '--input-file'].filter(key => Object.hasOwn(options, key)).length <= 1, 'page_input_ambiguous');
  if (Object.hasOwn(options, '--input-file')) requireThat(path.isAbsolute(options['--input-file']), 'page_input_file_absolute_required');
  if (command === 'script') requireThat(options['--input-file'], 'script_file_required');
  if (Object.hasOwn(options, '--navigate')) {
    validatedPagePacket({ action: 'navigate', url: options['--navigate'] });
    const url = new URL(options['--navigate']);
    // Command-line URLs must not turn a link's private query into process args.
    requireThat(!url.hash && ![...url.searchParams.keys()].some(key => /code|state|token|password|secret|authorization|credential|otp|session/i.test(key)), 'private_url_requires_input_file');
  }
  if (['configure', 'forget'].includes(command)) requireThat(options['--confirm'], 'explicit_confirmation_required');
  if (command === 'wait') validateWaitOptions(options);
  return { command, options };
}
export async function readPagePacket(input = process.stdin, timeoutMs = 5000) {
  requireThat(!input.isTTY, 'page_input_required');
  // Some typed MCP hosts cannot supply stdin. Fail promptly, while the
  // owner-only --input-file transport remains available in the same runtime.
  const text = await new Promise((resolve, reject) => {
    let value = '', finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(timer); input.off('data', data); input.off('end', end); input.off('error', failed); input.pause();
      if (error) { input.destroy(); reject(error); } else resolve(value);
    };
    const data = chunk => { value += chunk; if (Buffer.byteLength(value) > 16384) finish(new RuntimeError('input_too_large')); };
    const end = () => finish(), failed = () => finish(new RuntimeError('page_input_invalid'));
    const timer = setTimeout(() => finish(new RuntimeError('page_input_required')), timeoutMs);
    input.setEncoding('utf8'); input.on('data', data); input.once('end', end); input.once('error', failed);
    if (input.readableEnded) finish();
  });
  let packet;
  try { packet = JSON.parse(text); } catch { throw new RuntimeError(text.trim() ? 'page_input_invalid' : 'page_input_required'); }
  return validatedPagePacket(packet);
}
export async function readPrivateJson(file, helper) {
  await verifyPrivate(file, helper); const stat = await fs.stat(file);
  requireThat(stat.size <= 16384, 'local_state_invalid'); return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function readPrivateScript(file, helper) {
  await verifyPrivate(file, helper);
  requireThat((await fs.stat(file)).size <= MAX_SCRIPT_BYTES, 'script_input_invalid');
  const source = await fs.readFile(file, 'utf8');
  // Check syntax without execution. The worker receives these exact bytes,
  // never a path that could be replaced between validation and import.
  compileScenario(source);
  return source;
}
async function optionalJson(file, helper) {
  try { return await readPrivateJson(file, helper); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function requestControl(control, packet, timeoutMs = 30000) {
  requireThat(Number.isInteger(control.port) && control.port > 0 && control.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(control.token) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LEASE_MS, 'local_control_invalid');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(packet);
    const req = http.request({ hostname: '127.0.0.1', port: control.port, path: '/', method: 'POST', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(); });
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
async function doctor(directory, helper, root) {
  const lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  let configured = false, runtimeReady = false;
  try { await verifyPrivate(path.join(directory, 'vault.json'), helper); configured = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await loadPlaywright(root); runtimeReady = true; } catch {}
  const keychain = await keychainStatus(helper);
  return { platform: process.platform, runtimeReady, storedVault: configured, keychain,
    encryption: process.platform === 'win32' ? 'AES-256-GCM + DPAPI CurrentUser' : 'AES-256-GCM + login Keychain',
    unlock: process.platform === 'win32' ? 'Пароль текущей учётной записи Windows; Windows Hello не заявлен.' : 'Touch ID или пароль macOS',
    leaseActive: Boolean(lease && await leaseAlive(lease)), maxSessionMinutes: 30, runtimeVersion: RUNTIME_VERSION,
    actionPolicy: { default: 'read-only', userDirected: 'agent-instructions', persistentWriteMode: false,
      playwrightContext: 'full-after-protected-login', scriptedAuthorizationEnforcement: false },
    requiredAction: keychain.status === 'action_required'
      ? 'Восстановите доступ к связке login средствами macOS; повторный Touch ID не исправляет отказ Keychain.'
      : !runtimeReady ? 'bootstrap' : !configured ? 'start: первичная локальная настройка' : 'start: системная разблокировка без повторного ввода Т‑Банка' };
}
export async function run(args, statusTimeoutMs = 30000) {
  const { command, options } = parseArguments(args);
  if (command === 'wait') return waitForSessionChange(remaining =>
    run(['status', '--session', options['--session']], remaining), options);
  const identity = identityFromEnv(), root = configRoot();
  if (command === 'client') return {
    modulePath: path.join(SOURCE, 'playwright-client.mjs'),
    guidePath: path.join(SOURCE, '..', 'references', 'playwright-client.md'),
    options: { company: identity.company, member: identity.member },
    configHome: root,
    ownership: 'caller',
    browserAccess: 'full_playwright_context',
  };
  const helper = await nativeHelper(root), keyHelper = await nativeKeyHelper(root, helper),
    directory = storageDirectory(root, identity);
  await ensurePrivateDirectory(directory, helper);
  if (command === 'bootstrap') { await bootstrapBrowser(root); return doctor(directory, helper, root); }
  if (command === 'doctor') return doctor(directory, helper, root);
  let lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  const control = await optionalJson(path.join(directory, 'control.json'), helper);
  const authorization = command === 'authorize'
    ? await readAuthorization(root, identity, options['--browser-session'], options['--request'], options['--origin'], helper)
    : null;
  if (['start', 'authorize', 'configure', 'forget'].includes(command)) {
    if (lease && await leaseAlive(lease)) {
      requireThat(['start', 'authorize'].includes(command), 'stop_existing_session_first');
      requireThat(lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
      requireThat(lease.expiresAt > Date.now(), 'expired_guard_still_running');
      // A personal-bank session and a delegated T‑ID authorizer share one
      // encrypted vault. They cannot overlap or silently change the relying
      // party/request attached to a running native guardian.
      requireThat((lease.authorizationRequest || null) === (authorization?.requestId || null),
        'stop_existing_authorization_first');
      if (control && control.leaseId === lease.leaseId) return withSessionContinuation(await requestControl(control, { command: 'status', sessionId: lease.leaseId }));
      return withSessionContinuation({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt });
    }
    // A dead supervisor permits recovery of only these exact disposable control
    // records. Ciphertext and native OS keys are never removed as crash cleanup.
    if (lease) {
      await fs.rm(path.join(directory, 'lease.json'));
      if (control && control.leaseId === lease.leaseId) await fs.rm(path.join(directory, 'control.json'));
    }
    // Check the login Keychain before requesting another Touch ID or creating
    // a lease. Reusing an active session above still requires neither step.
    if (command !== 'forget') {
      await verifyKeychain(helper);
      // The caller owns the browser in delegated mode. Loading Playwright here
      // would neither bind that context nor strengthen the native credential
      // boundary, and would make an auth-only helper depend on a second copy.
      if (!authorization) await loadPlaywright(root);
    }
    // Resolve the current Codex chat from its host-owned ID before the OS
    // unlock. Caller wording is retained only as a fallback when exact local
    // metadata cannot be read; neither value is written to the lease.
    const requestTitle = await resolveRequestTitle(options['--request-title']);
    const now = Date.now();
    lease = {
      leaseId: crypto.randomUUID(),
      runtimeVersion: RUNTIME_VERSION,
      startedAt: authorization?.startedAt || now,
      expiresAt: authorization?.expiresAt || now + LEASE_MS,
      guardPid: null,
      authorizationRequest: authorization?.requestId || null,
    };
    const file = path.join(directory, 'lease.json');
    await createPrivateFile(file, JSON.stringify(lease), helper);
    const child = spawn(helper, ['guard', process.execPath, path.join(SOURCE, 'worker.mjs'),
      String(Math.max(1, lease.expiresAt - now))], {
      detached: true, windowsHide: true, shell: false, env: { ...childEnvironment(), TRELIO_BROWSER_SESSION_MODULE_URL: process.env.TRELIO_BROWSER_SESSION_MODULE_URL }, stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('guardian_start_failed'))); });
      lease.guardPid = child.pid; await atomicWrite(file, JSON.stringify(lease), helper);
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({ ...lease, identity, root, directory, helper, keyHelper,
        mode: command, channel: options['--channel'], authorization,
        requestTitle: requestTitle || null })}\n`);
      child.unref();
    } catch (error) { child.stdin.destroy(); throw error; }
    return withSessionContinuation({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt, requiredAction: 'Подтвердите системную разблокировку; при первой настройке введите данные на локальной странице.' });
  }
  if (['status', 'stop'].includes(command) && lease && !await leaseAlive(lease)) {
    requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
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
  if (command === 'page') {
    // Page text belongs to the requested workflow; stdin keeps it out of argv.
    // This command never accepts a password, seed, current OTP, or script.
    extra = options['--navigate'] !== undefined ? validatedPagePacket({ action: 'navigate', url: options['--navigate'] })
      : options['--click'] !== undefined ? validatedPagePacket({ action: 'click', ref: options['--click'] })
      : options['--input-file'] !== undefined ? validatedPagePacket(await readPrivateJson(options['--input-file'], helper))
      : await readPagePacket();
    // CLI flags only apply to this packet; neither lease nor vault is changed.
    if (options['--confirm']) extra.confirm = true;
    if (options['--dry-run']) extra.dryRun = true;
  }
  if (command === 'script') extra.source = await readPrivateScript(options['--input-file'], helper);
  // A scenario may await a download or a human verification. Its original
  // native lease remains the upper bound; a CLI invocation adds no new TTL.
  const result = await requestControl(control, { ...extra, command, sessionId: lease.leaseId },
    command === 'script' ? Math.max(1, Math.min(LEASE_MS, lease.expiresAt - Date.now())) : statusTimeoutMs);
  if (command === 'stop') {
    // Confirm actual process shutdown, not merely acceptance of the stop request.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!await leaseAlive(lease)) return { phase: 'closed', sessionId: lease.leaseId };
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
