#!/usr/bin/env node
import { validateWaitOptions, waitForSessionChange, withSessionContinuation, finishedReceiptPhase } from './session-wait.mjs';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  browserSessionRuntime,
  childEnvironment,
  configRoot,
  identityFromEnv,
  identityKey,
  LEASE_MS,
  requireThat,
  RUNTIME_VERSION,
  RuntimeError,
  serviceHttpFailure,
  storageDirectory,
} from './core.mjs';
import { bootstrapBrowser, loadPlaywright } from './browser.mjs';
import {
  atomicWrite,
  createPrivateFile,
  deleteVaultKey,
  ensurePrivateDirectory,
  keychainStatus,
  nativeHelper,
  SOURCE,
  verifyKeychain,
  verifyPrivate,
} from './native.mjs';
import { validatedPagePacket } from './page-actions.mjs';
import { compileScenario, MAX_SCRIPT_BYTES } from './scenario.mjs';
import { AUTHORIZATION_FAILURE_ACTION } from './sign-in.mjs';

const COMMANDS = [
  'bootstrap', 'doctor', 'forget', 'page', 'prepare-sign-in', 'resume',
  'script', 'show', 'snapshot', 'start', 'wait', 'status', 'stop',
];

export function parseArguments(args) {
  const [command = 'doctor', ...rest] = args;
  requireThat(COMMANDS.includes(command), 'unknown_command');
  const options = {};
  while (rest.length) {
    const flag = rest.shift();
    requireThat([
      '--channel', '--click', '--confirm', '--dry-run', '--input-file', '--navigate',
      '--request-title', '--after-phase', '--timeout-seconds', '--session',
    ].includes(flag) && !Object.hasOwn(options, flag), 'unsupported_option');
    options[flag] = ['--confirm', '--dry-run'].includes(flag) ? true : rest.shift();
    requireThat(options[flag] !== undefined, 'option_value_required');
  }
  const allowed = command === 'wait' ? ['--session', '--after-phase', '--timeout-seconds'] : ['status', 'resume', 'snapshot', 'show', 'stop'].includes(command)
    ? ['--session']
    : command === 'page'
      ? ['--session', '--confirm', '--dry-run', '--navigate', '--click', '--input-file']
      : command === 'script'
        ? ['--session', '--input-file']
        : command === 'prepare-sign-in'
          ? ['--session', '--input-file', '--confirm', '--request-title']
          : command === 'start'
            ? ['--channel']
            : command === 'forget'
              ? ['--confirm']
              : [];
  requireThat(Object.keys(options).every(key => allowed.includes(key)), 'unsupported_option');
  if (options['--channel']) requireThat(['chrome', 'msedge'].includes(options['--channel']), 'unsupported_browser');
  if (options['--session']) requireThat(/^[a-f0-9-]{36}$/.test(options['--session']), 'session_invalid');
  if (options['--request-title'] !== undefined) {
    requireThat(typeof options['--request-title'] === 'string' && options['--request-title'].trim() === options['--request-title'] &&
      Buffer.byteLength(options['--request-title']) <= 160 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(options['--request-title']),
    'request_title_invalid');
  }
  if (['page', 'script', 'prepare-sign-in'].includes(command) && options['--input-file'] !== undefined) {
    requireThat(path.isAbsolute(options['--input-file']), 'input_file_absolute_required');
  }
  if (command === 'script') requireThat(options['--input-file'], 'script_file_required');
  if (command === 'prepare-sign-in') {
    requireThat(options['--input-file'] && options['--confirm'] === true, 'authorization_permission_required');
  }
  if (command === 'forget') requireThat(options['--confirm'] === true, 'explicit_confirmation_required');
  requireThat(['--navigate', '--click', '--input-file'].filter(key => Object.hasOwn(options, key)).length <= 1 ||
    !['page'].includes(command), 'page_input_ambiguous');
  if (Object.hasOwn(options, '--navigate')) {
    validatedPagePacket({ action: 'navigate', url: options['--navigate'] });
    const url = new URL(options['--navigate']);
    requireThat(!url.hash && ![...url.searchParams.keys()].some(key =>
      /code|state|token|password|secret|authorization|credential|otp|session/i.test(key)),
    'private_url_requires_input_file');
  }
  if (command === 'wait') validateWaitOptions(options);
  return { command, options };
}

export async function readPagePacket(input = process.stdin, timeoutMs = 5000) {
  requireThat(!input.isTTY, 'page_input_required');
  const text = await new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', failed);
      input.pause();
      if (error) { input.destroy(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      value += chunk;
      if (Buffer.byteLength(value) > 16384) finish(new RuntimeError('input_too_large'));
    };
    const end = () => finish();
    const failed = () => finish(new RuntimeError('page_input_invalid'));
    const timer = setTimeout(() => finish(new RuntimeError('page_input_required')), timeoutMs);
    input.setEncoding('utf8');
    input.on('data', data);
    input.once('end', end);
    input.once('error', failed);
    if (input.readableEnded) finish();
  });
  try { return validatedPagePacket(JSON.parse(text)); }
  catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(text.trim() ? 'page_input_invalid' : 'page_input_required');
  }
}

export async function readPrivateJson(file, helper, limit = 64 * 1024) {
  await verifyPrivate(file, helper);
  const stat = await fs.stat(file);
  requireThat(stat.size > 0 && stat.size <= limit, 'local_input_invalid');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new RuntimeError('local_input_invalid'); }
}

export async function readPrivateScript(file, helper) {
  await verifyPrivate(file, helper);
  requireThat((await fs.stat(file)).size <= MAX_SCRIPT_BYTES, 'script_input_invalid');
  const source = await fs.readFile(file, 'utf8');
  compileScenario(source);
  return source;
}

async function optionalJson(file, helper) {
  try { return await readPrivateJson(file, helper); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function requestControl(control, packet, timeoutMs = 30000) {
  requireThat(Number.isInteger(control.port) && control.port > 0 && control.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(control.token) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LEASE_MS,
  'local_control_invalid');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(packet);
    const request = http.request({
      hostname: '127.0.0.1',
      port: control.port,
      path: '/',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${control.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 65536) request.destroy();
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (response.statusCode === 200) resolve(value);
          else {
            const error = new RuntimeError(/^[a-z_]{1,80}$/.test(value.error) ? value.error : 'operation_failed', value);
            // Keep the original safe failure code and the recoverable phase
            // across the local HTTP/CLI boundary. Copy only fixed, validated
            // metadata; never forward raw messages or arbitrary worker fields.
            if (value.phase === 'authorization_failed' && value.sessionId === packet.sessionId &&
              Number.isSafeInteger(value.expiresAt) && value.requiredAction === AUTHORIZATION_FAILURE_ACTION) {
              error.recovery = {
                phase: value.phase, sessionId: value.sessionId,
                expiresAt: value.expiresAt, requiredAction: AUTHORIZATION_FAILURE_ACTION,
              };
            }
            reject(error);
          }
        } catch (error) {
          reject(error instanceof RuntimeError ? error : new RuntimeError('control_result_invalid'));
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => reject(new RuntimeError('session_unreachable')));
    request.end(body);
  });
}

async function leaseAlive(lease) {
  if (!lease.guardPid) return Date.now() < lease.startedAt + 30000;
  requireThat(Number.isInteger(lease.guardPid) && lease.guardPid > 1, 'lease_invalid');
  try { process.kill(lease.guardPid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function doctor(directory, helper) {
  const lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  let storedSession = false;
  try { await verifyPrivate(path.join(directory, 'vault.json'), helper); storedSession = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { runtime, binding } = await browserSessionRuntime();
  const browser = runtime.inspectBrowserRuntime();
  const keychain = await keychainStatus(helper);
  return {
    platform: process.platform,
    runtimeReady: browser.runtimeReady,
    playwrightVersion: browser.playwrightVersion,
    storedSession,
    keychain,
    encryption: process.platform === 'win32'
      ? 'AES-256-GCM + DPAPI CurrentUser'
      : 'AES-256-GCM + login Keychain',
    osPrompt: false,
    leaseActive: Boolean(lease && await leaseAlive(lease)),
    maxSessionMinutes: binding.leaseMs / 60000,
    runtimeVersion: RUNTIME_VERSION,
    browser: { headed: true, startsInactive: true, stealsFocusForBackgroundWork: false },
    requiredAction: keychain.status === 'action_required'
      ? 'Восстановите доступ к login Keychain средствами macOS; runtime не открывает системное окно сам.'
      : !browser.runtimeReady ? 'bootstrap' : 'start',
  };
}

export async function run(args, statusTimeoutMs = 30000) {
  const { command, options } = parseArguments(args);
  if (command === 'wait') return waitForSessionChange(remaining =>
    run(['status', '--session', options['--session']], remaining), options);
  await browserSessionRuntime();
  const browserSessionModuleUrl = String(process.env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
  const identity = identityFromEnv();
  const root = configRoot();
  const helper = await nativeHelper(root);
  const directory = storageDirectory(root, identity);
  await ensurePrivateDirectory(directory, helper);

  if (command === 'bootstrap') {
    await bootstrapBrowser();
    return doctor(directory, helper);
  }
  if (command === 'doctor') return doctor(directory, helper);

  let lease = await optionalJson(path.join(directory, 'lease.json'), helper);
  const control = await optionalJson(path.join(directory, 'control.json'), helper);

  if (command === 'forget') {
    requireThat(!lease || !await leaseAlive(lease), 'stop_existing_session_first');
    await deleteVaultKey(helper, directory, identityKey(identity));
    await fs.rm(path.join(directory, 'vault.json'), { force: true });
    return { phase: 'forgotten', localSessionRemoved: true };
  }

  if (command === 'start') {
    if (lease && await leaseAlive(lease)) {
      requireThat(lease.runtimeVersion === RUNTIME_VERSION, 'stop_previous_runtime_session_first');
      requireThat(lease.expiresAt > Date.now(), 'expired_guard_still_running');
      if (control && control.leaseId === lease.leaseId) {
        return withSessionContinuation(await requestControl(control, { command: 'status', sessionId: lease.leaseId }));
      }
      return withSessionContinuation({ phase: 'starting', sessionId: lease.leaseId, expiresAt: lease.expiresAt });
    }
    if (lease) {
      await fs.rm(path.join(directory, 'lease.json'), { force: true });
      if (control && control.leaseId === lease.leaseId) {
        await fs.rm(path.join(directory, 'control.json'), { force: true });
      }
    }
    // Keychain access is explicitly non-interactive for this non-financial
    // skill. Any locked/unavailable store fails before a browser can start.
    await verifyKeychain(helper);
    await loadPlaywright();
    const now = Date.now();
    lease = {
      leaseId: crypto.randomUUID(),
      runtimeVersion: RUNTIME_VERSION,
      startedAt: now,
      expiresAt: now + LEASE_MS,
      guardPid: null,
    };
    const leaseFile = path.join(directory, 'lease.json');
    await createPrivateFile(leaseFile, JSON.stringify(lease), helper);
    const child = spawn(helper, [
      'guard', process.execPath, path.join(SOURCE, 'worker.mjs'), String(LEASE_MS),
    ], {
      detached: true,
      windowsHide: true,
      shell: false,
      env: childEnvironment(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(new RuntimeError('guardian_start_failed')));
      });
      lease.guardPid = child.pid;
      await atomicWrite(leaseFile, JSON.stringify(lease), helper);
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({
        ...lease,
        identity,
        root,
        directory,
        helper,
        channel: options['--channel'],
        // The detached worker receives no ambient host bindings. Passing the
        // already-validated immutable module URL keeps the child on this exact
        // admitted browser runtime without leaking unrelated host variables.
        browserSessionModuleUrl,
      })}\n`);
      child.unref();
    } catch (error) {
      child.stdin.destroy();
      throw error;
    }
    return withSessionContinuation({
      phase: 'starting',
      sessionId: lease.leaseId,
      expiresAt: lease.expiresAt,
      requiredAction: 'Дождитесь ready; браузер откроется без активации окна.',
    });
  }

  if (['status', 'stop'].includes(command) && lease && !await leaseAlive(lease)) {
    requireThat(options['--session'] === lease.leaseId, 'exact_session_required');
    const last = await optionalJson(path.join(directory, 'status.json'), helper);
    return {
      sessionId: lease.leaseId,
      phase: 'closed',
      expiresAt: lease.expiresAt,
      requiredAction: null,
      ...(last?.sessionId === lease.leaseId && last.error ? { error: last.error, ...serviceHttpFailure(last) } : {}),
    };
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
  requireThat(['status', 'stop'].includes(command) || lease.runtimeVersion === RUNTIME_VERSION,
    'stop_previous_runtime_session_first');
  requireThat(options['--session'] === lease.leaseId, 'exact_session_required');

  let extra = {};
  if (command === 'page') {
    extra = options['--navigate'] !== undefined
      ? validatedPagePacket({ action: 'navigate', url: options['--navigate'] })
      : options['--click'] !== undefined
        ? validatedPagePacket({ action: 'click', ref: options['--click'] })
        : options['--input-file'] !== undefined
          ? validatedPagePacket(await readPrivateJson(options['--input-file'], helper, 16384))
          : await readPagePacket();
    if (options['--confirm']) extra.confirm = true;
    if (options['--dry-run']) extra.dryRun = true;
  } else if (command === 'script') {
    extra.source = await readPrivateScript(options['--input-file'], helper);
  } else if (command === 'prepare-sign-in') {
    extra.client = await readPrivateJson(options['--input-file'], helper, 128 * 1024);
    extra.requestTitle = options['--request-title'] || null;
  }

  const result = await requestControl(
    control,
    { ...extra, command, sessionId: lease.leaseId },
    command === 'script' ? Math.max(1, Math.min(LEASE_MS, lease.expiresAt - Date.now())) : statusTimeoutMs,
  );
  if (command === 'stop') {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!await leaseAlive(lease)) return { phase: 'closed', sessionId: lease.leaseId };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new RuntimeError('shutdown_not_confirmed');
  }
  return result;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ...(error instanceof RuntimeError ? error.recovery : {}),
      error: error instanceof RuntimeError ? error.code : 'runtime_failed',
      ...serviceHttpFailure(error),
    })}\n`);
    process.exitCode = 1;
  }
}
