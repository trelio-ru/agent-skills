#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserSessionBinding, childEnvironment, configRoot, identityFromEnv, LEASE_MS, requireThat, RUNTIME_VERSION, RuntimeError, serviceHttpFailure, storageDirectory } from './core.mjs';
import { closedDiagnostics } from './auth-safety.mjs';
import { atomicWrite, createPrivateFile, ensurePrivateDirectory, nativeHelper, nativeKeyHelper,
  nativeRequestTitleInput, SOURCE, verifyPrivate, keychainStatus, verifyKeychain } from './native.mjs';
import { bootstrapBrowser, loadPlaywright, loginRole } from './browser.mjs';
import { readAuthorization } from './transport.mjs';
import { resolveRequestTitle } from './chat-title.mjs';

const COMMANDS = ['client', 'doctor', 'bootstrap', 'authorize', 'start', 'status', 'resume', 'roles', 'choose-role', 'snapshot', 'page', 'stop', 'configure', 'forget'];
export function parseArguments(args) {
  const [command = 'doctor', ...rest] = args;
  requireThat(COMMANDS.includes(command), 'unknown_command');
  const options = {};
  while (rest.length) {
    const flag = rest.shift();
    requireThat(['--session', '--channel', '--confirm', '--account-recovered', '--role', '--ref', '--browser-session', '--request', '--origin', '--navigate', '--click', '--input-file', '--request-title'].includes(flag) && !Object.hasOwn(options, flag), 'unsupported_option');
    options[flag] = ['--confirm', '--account-recovered'].includes(flag) ? true : rest.shift();
    requireThat(options[flag] !== undefined, 'option_value_required');
  }
  const allowed = ['status', 'roles', 'snapshot', 'stop'].includes(command) ? ['--session']
    : command === 'resume' ? ['--session', '--account-recovered', '--confirm']
    : command === 'page' ? ['--session', '--navigate', '--click', '--input-file']
    : command === 'choose-role' ? ['--session', '--ref', '--confirm']
    : command === 'authorize' ? ['--browser-session', '--request', '--origin', '--confirm', '--account-recovered', '--role', '--request-title']
    : ['configure', 'forget'].includes(command) ? ['--confirm', '--channel', '--request-title']
      : command === 'start' ? ['--channel', '--role', '--confirm', '--account-recovered', '--request-title'] : [];
  requireThat(Object.keys(options).every(key => allowed.includes(key)), 'unsupported_option');
  if (options['--channel']) requireThat(['chrome', 'msedge'].includes(options['--channel']), 'unsupported_browser');
  if (options['--session']) requireThat(/^[a-f0-9-]{36}$/.test(options['--session']), 'session_invalid');
  if (Object.hasOwn(options, '--request-title')) nativeRequestTitleInput(options['--request-title']);
  if (Object.hasOwn(options, '--role')) loginRole(options['--role']);
  if (['start', 'authorize'].includes(command)) requireThat(options['--confirm'] === true, 'authorization_permission_required');
  if (options['--account-recovered']) requireThat(options['--confirm'] === true, 'account_recovery_confirmation_required');
  if (command === 'resume' && options['--confirm']) requireThat(options['--account-recovered'], 'unsupported_option');
  if (command === 'authorize') {
    requireThat(/^[a-f0-9-]{36}$/.test(options['--browser-session'] || '') && /^[a-f0-9-]{36}$/.test(options['--request'] || ''), 'authorization_request_invalid');
    let origin; try { origin = new URL(options['--origin']); } catch { throw new RuntimeError('authorization_origin_invalid'); }
    requireThat(origin.protocol === 'https:' && origin.origin === options['--origin'] && !origin.username && !origin.password && !origin.port, 'authorization_origin_invalid');
  }
  requireThat(['--navigate', '--click', '--input-file'].filter(key => Object.hasOwn(options, key)).length <= 1, 'page_input_ambiguous');
  if (Object.hasOwn(options, '--input-file')) requireThat(path.isAbsolute(options['--input-file']), 'page_input_file_absolute_required');
  if (Object.hasOwn(options, '--click')) requireThat(/^\d+:\d+$/.test(options['--click']), 'page_input_invalid');
  if (Object.hasOwn(options, '--navigate')) {
    let url; try { url = new URL(options['--navigate']); } catch { throw new RuntimeError('page_input_invalid'); }
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      ![...url.searchParams.keys()].some(name => /^(?:code|state|.*token|password|secret|authorization|credential|otp|totp|session)$/i.test(name)), 'page_input_invalid');
  }
  if (command === 'choose-role') requireThat(options['--confirm'] === true && /^role:\d+:\d+$/.test(options['--ref'] || ''), 'explicit_role_choice_required');
  if (['configure', 'forget'].includes(command)) requireThat(options['--confirm'], 'explicit_confirmation_required');
  return { command, options };
}
// An MCP transport that cannot supply stdin must receive a bounded, explicit
// error instead of leaving a subprocess waiting until the browser lease ends.
// The actual verified host CLI inherits stdin and supports all three actions.
export async function readPagePacket(input = process.stdin, timeoutMs = 5000) {
  requireThat(!input.isTTY, 'page_input_required');
  const text = await new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      clearTimeout(timer); input.off('data', data); input.off('end', end); input.off('error', failed);
      input.pause();
      if (error) { input.destroy(); reject(error); } else resolve(value);
    };
    const data = chunk => { value += chunk.toString('utf8'); if (Buffer.byteLength(value) > 16384) finish(new RuntimeError('input_too_large')); };
    const end = () => finish(null), failed = () => finish(new RuntimeError('page_input_invalid'));
    const timer = setTimeout(() => finish(new RuntimeError('page_input_required')), timeoutMs);
    input.setEncoding('utf8'); input.on('data', data); input.once('end', end); input.once('error', failed);
  });
  let packet; try { packet = JSON.parse(text); } catch { throw new RuntimeError(text.trim() ? 'page_input_invalid' : 'page_input_required'); }
  return validatedPagePacket(packet);
}
export function validatedPagePacket(packet) {
  const keys = { navigate: ['action', 'url'], click: ['action', 'ref'], fill: ['action', 'ref', 'text'] }[packet?.action];
  requireThat(packet && ['navigate', 'click', 'fill'].includes(packet.action) &&
    Object.keys(packet).every(key => keys.includes(key)) &&
    (packet.action === 'navigate' ? typeof packet.url === 'string' : typeof packet.ref === 'string') &&
    (packet.action !== 'fill' || typeof packet.text === 'string'), 'page_input_invalid');
  return packet;
}
export async function readPrivateJson(file, helper) {
  await verifyPrivate(file, helper); const stat = await fs.stat(file);
  requireThat(stat.size <= 16384, 'local_state_invalid'); return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function optionalJson(file, helper) {
  try { return await readPrivateJson(file, helper); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function requestControl(control, packet) {
  requireThat(Number.isInteger(control.port) && control.port > 0 && control.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(control.token), 'local_control_invalid');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(packet);
    const req = http.request({ hostname: '127.0.0.1', port: control.port, path: '/', method: 'POST', timeout: 30000,
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
    leaseActive: Boolean(lease && await leaseAlive(lease)), maxSessionMinutes: 30,
    requiredAction: keychain.status === 'action_required'
      ? 'Восстановите доступ к связке login средствами macOS; повторный Touch ID не исправляет отказ Keychain.'
      : !runtimeReady ? 'bootstrap' : !configured ? 'start: первичная локальная настройка' : 'start: системная разблокировка без повторного ввода Госуслуг' };
}
export async function run(args) {
  const { command, options } = parseArguments(args);
  // Parse and authorization-shape errors stay side-effect free and are
  // reported before host access. Every valid command then binds itself to the
  // signed protected-snapshot policy and its absolute outer deadline.
  await browserSessionBinding();
  const identity = identityFromEnv(), root = configRoot();
  if (command === 'client') return { modulePath: path.join(SOURCE, 'playwright-client.mjs'),
    guidePath: path.join(SOURCE, '..', 'references', 'playwright-client.md'),
    options: { company: identity.company, member: identity.member }, configHome: root,
    ownership: 'caller', browserAccess: 'full_playwright_context' };
  const helper = await nativeHelper(root), keyHelper = await nativeKeyHelper(root, helper), directory = storageDirectory(root, identity);
  await ensurePrivateDirectory(directory, helper);
  if (command === 'bootstrap') { await bootstrapBrowser(root); return doctor(directory, helper, root); }
  if (command === 'doctor') return doctor(directory, helper, root);
  let lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  const control = await optionalJson(path.join(directory, 'control.json'), helper);
  const authorization = command === 'authorize' ? await readAuthorization(root, identity, options['--browser-session'], options['--request'], options['--origin'], helper) : null;
  if (['start', 'authorize', 'configure', 'forget'].includes(command)) {
    if (lease && await leaseAlive(lease)) {
      requireThat(['start', 'authorize'].includes(command), 'stop_existing_session_first');
      requireThat(lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
      requireThat(lease.expiresAt > Date.now(), 'expired_guard_still_running');
      const sameAuthorization = (lease.authorizationRequest || null) === (authorization?.requestId || null);
      // A normal ready Госуслуги worker already holds the decrypted vault key
      // and may service one verified ESIA handoff for another browser context.
      // Dispatching through its owner-only command plane avoids a second OS
      // unlock and preserves the user's ordinary Госуслуги page and form state.
      if (command === 'authorize' && authorization && !lease.authorizationRequest) {
        requireThat(control && control.leaseId === lease.leaseId, 'session_unreachable');
        return requestControl(control, { command: 'authorize', sessionId: lease.leaseId,
          authorization, loginRole: loginRole(options['--role']),
          ...(options['--account-recovered'] ? { accountRecovered: true } : {}) });
      }
      requireThat(sameAuthorization, 'stop_existing_authorization_first');
      requireThat(!options['--account-recovered'], 'account_recovery_requires_resume');
      // A new start cannot silently change an existing identity or the intent
      // of its procedure. The operator must finish that session first.
      if (control && control.leaseId === lease.leaseId) {
        const current = await requestControl(control, { command: 'status', sessionId: lease.leaseId });
        if (options['--role']) requireThat(current.loginRole === options['--role'], 'stop_existing_role_session_first');
        return current;
      }
      return { phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt };
    }
    // A dead supervisor permits recovery of only these exact disposable control
    // records. Ciphertext and native OS keys are never removed as crash cleanup.
    if (lease) {
      await fs.rm(path.join(directory, 'lease.json'));
      if (control && control.leaseId === lease.leaseId) await fs.rm(path.join(directory, 'control.json'));
    }
    // Check the login Keychain before requesting another Touch ID or creating
    // a lease. Reusing an active session above still requires neither step.
    if (command !== 'forget') { await verifyKeychain(helper); if (!authorization) await loadPlaywright(root); }
    // Resolve the current Codex chat from its host-owned ID before asking the
    // OS to unlock the vault. The caller's optional wording is only a fallback
    // in clients without that ID; the title is never persisted with the lease.
    const requestTitle = await resolveRequestTitle(options['--request-title']);
    const now = Date.now(); lease = { leaseId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, startedAt: authorization?.startedAt || now, expiresAt: authorization?.expiresAt || now + LEASE_MS, guardPid: null, authorizationRequest: authorization?.requestId || null };
    const file = path.join(directory, 'lease.json');
    await createPrivateFile(file, JSON.stringify(lease), helper);
    const child = spawn(helper, ['guard', process.execPath, path.join(SOURCE, 'worker.mjs'), String(Math.max(1, lease.expiresAt - now))], {
      detached: true, windowsHide: true, shell: false, env: childEnvironment(), stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('guardian_start_failed'))); });
      lease.guardPid = child.pid; await atomicWrite(file, JSON.stringify(lease), helper);
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({ ...lease, identity, root, directory, helper, keyHelper, mode: command,
        channel: options['--channel'], loginRole: loginRole(options['--role']), authorization,
        accountRecovered: options['--account-recovered'] === true,
        // Explanatory UI context is kept only in the guardian/worker pipe. It
        // never enters the lease, encrypted record or Keychain metadata.
        requestTitle: requestTitle || null })}\n`);
      child.unref();
    } catch (error) { child.stdin.destroy(); throw error; }
    return { phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt, requiredAction: 'Подтвердите системную разблокировку; при первой настройке введите данные на локальной странице.' };
  }
  if (['status', 'stop'].includes(command) && lease && !await leaseAlive(lease)) {
    requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
    // The hard native deadline can terminate JS before it removes control
    // files. Never send a stale bearer to a port that may have been reused by
    // another process. Proven guardian exit means this lease is closed; its
    // encrypted vault remains untouched.
    const last = await optionalJson(path.join(directory, 'status.json'), helper);
    return { sessionId: lease.leaseId, phase: 'closed', expiresAt: lease.expiresAt, requiredAction: null,
      ...(last?.sessionId === lease.leaseId ? closedDiagnostics(last) : {}) };
  }
  if (command === 'status' && (!lease || !control)) {
    const last = await optionalJson(path.join(directory, 'status.json'), helper);
    requireThat(last && options['--session'] === last.sessionId, 'no_active_session');
    return last;
  }
  requireThat(lease && control && lease.leaseId === control.leaseId, 'no_active_session');
  requireThat(['status', 'stop'].includes(command) || lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
  requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
  let extra = {};
  if (command === 'choose-role') extra = { ref: options['--ref'], confirmed: true };
  if (command === 'resume' && options['--account-recovered']) extra = { accountRecovered: true };
  if (command === 'page') {
    // Only a public navigation URL or an opaque snapshot reference goes in
    // argv. Private form text uses bounded stdin or an explicit owner-only
    // JSON file; the latter also works through typed MCP actions without stdin.
    // The file is never deleted implicitly and cannot import vault credentials.
    extra = options['--navigate'] !== undefined ? { action: 'navigate', url: options['--navigate'] }
      : options['--click'] !== undefined ? { action: 'click', ref: options['--click'] }
      : options['--input-file'] !== undefined ? validatedPagePacket(await readPrivateJson(options['--input-file'], helper))
      : await readPagePacket();
  }
  const result = await requestControl(control, { ...extra, command, sessionId: lease.leaseId });
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
