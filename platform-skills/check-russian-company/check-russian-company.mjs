#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { checks, kadInput, publicReviewUrls, RegistryReadError, requireCompanyInn, requireReady, sources }
  from './registry-workflows.mjs';

const ID = 'check-russian-company';
const VERSION = '1.0.1';
const MINIMUM_HOST = '3.34.36';
// All checks in this skill reuse one encrypted guest snapshot. The host
// validates its cookies before launch, so every process restoring that
// snapshot needs the same declared cookie scope as the process that saved it.
const registryOrigins = Object.freeze(Object.values(sources).map(({ url }) => new URL(url).origin));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const known = {
  check: 0, resume: 0, 'read-text': 0, screenshot: 0, click: 3, scroll: 4,
  'enter-inn': 1, key: 2, close: 0,
};
const keys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Control+A', 'Meta+A']);
const activePhases = new Set(['starting', 'checking', 'review', 'closing']);
const visualFailures = new Set([
  'expected_page_missing', 'layout_changed', 'control_missing_or_ambiguous',
  'participant_filter_not_confirmed', 'result_not_confirmed', 'stale_frame',
]);
const hostReasons = {
  lease_expired: ['BROWSER_LEASE_EXPIRED', 'runtime', 'connection'],
  session_closed: ['BROWSER_SESSION_CLOSED', 'runtime', 'connection'],
  session_busy: ['BROWSER_SESSION_BUSY', 'runtime', 'connection'],
  bootstrap_failed: ['BROWSER_BOOTSTRAP_FAILED', 'setup', 'startup'],
  storage_unavailable: ['BROWSER_STORAGE_UNAVAILABLE', 'setup', 'startup'],
  storage_corrupt: ['BROWSER_STORAGE_CORRUPT', 'setup', 'startup'],
  manual_control_active: ['BROWSER_HUMAN_INPUT_REQUIRED', 'access', 'request'],
  navigation_blocked: ['BROWSER_NAVIGATION_BLOCKED', 'access', 'request'],
  document_blocked: ['BROWSER_DOCUMENT_BLOCKED', 'access', 'response'],
  browser_process_lost: ['BROWSER_PROCESS_LOST', 'runtime', 'response'],
  observation_mode_mismatch: ['BROWSER_SESSION_POLICY_MISMATCH', 'runtime', 'connection'],
  invalid_input: ['BROWSER_INPUT_REJECTED', 'validation', 'request'],
};

function fail(code) {
  throw new Error(code);
}

function parse(argv) {
  const [operation, source, inn, frameId, ...input] = argv;
  if (argv.length === 1 && operation === 'doctor') return { operation };
  if (!Object.hasOwn(known, operation) || !Object.hasOwn(sources, source)
    || argv.length !== 3 + known[operation]) fail('INVALID_REGISTRY_COMMAND');
  requireCompanyInn(inn);
  if (!known[operation]) return { operation, source, inn, args: {} };
  if (!uuid.test(frameId)) fail('INVALID_REGISTRY_COMMAND');
  const args = { frameId };
  if (operation === 'enter-inn') args.text = inn;
  else if (operation === 'key') {
    if (!keys.has(input[0])) fail('INVALID_REGISTRY_COMMAND');
    args.key = input[0];
  } else {
    if (input.some(value => !/^-?\d{1,4}$/u.test(value))) fail('INVALID_REGISTRY_COMMAND');
    [args.x, args.y] = input.map(Number);
    if (args.x < 0 || args.x >= 1920 || args.y < 0 || args.y >= 1440) fail('INVALID_REGISTRY_COMMAND');
    if (operation === 'scroll') {
      args.deltaY = Number(input[2]);
      if (!args.deltaY || Math.abs(args.deltaY) > 1440) fail('INVALID_REGISTRY_COMMAND');
    }
  }
  return { operation, source, inn, args };
}

const emptyStatus = frame => ['not_configured', 'saved_unverified'].includes(frame.state) && !frame.sessionId;

const innDigest = inn => createHash('sha256').update(inn).digest('hex');

function checkBinding(state, { source, inn }) {
  if (!state || state.source !== source || state.innDigest !== innDigest(inn)) fail('REGISTRY_SESSION_MISMATCH');
}

function response(source, inn, result) {
  return { schemaVersion: 1, source, inn, url: publicReviewUrls[source], presentation: sources[source].presentation,
    checkedAt: new Date().toISOString(), ...result };
}

function diagnostic(operation, env, code, category, stage, extras = {}) {
  const { outcome = 'confirmed_failed', httpStatus, timedOut, action = 'none', complete = true,
    check = 'REGISTRY_FLOW' } = extras;
  const host = env.TRELIO_HOST_RUNTIME_VERSION;
  return { contract: 'trelio.skill-diagnostic/v1', code, category, operationKind: 'read', operation, stage, outcome,
    checks: [{ check, result: outcome === 'confirmed_succeeded' ? 'passed' : 'failed' }],
    evidence: { ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(timedOut ? { timedOut: true } : {}) },
    versions: { skill: VERSION, host: /^\d+\.\d+\.\d+$/u.test(host ?? '') ? host : null,
      platform: ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'unknown' },
    recovery: { action, retry: outcome === 'unknown' ? 'forbidden' : 'read_only', diagnosticComplete: complete } };
}

function failure(error, operation, env) {
  if (error instanceof RegistryReadError) {
    if (visualFailures.has(error.code)) {
      return diagnostic(operation, env, 'REGISTRY_VISUAL_REVIEW_REQUIRED', 'provider', 'verification',
        { outcome: 'unknown', action: 'read_status', complete: false });
    }
    if (error.httpStatus >= 400 && error.httpStatus <= 599) {
      const denied = [401, 403, 429].includes(error.httpStatus);
      return diagnostic(operation, env, denied ? 'REGISTRY_ACCESS_REFUSED' : 'REGISTRY_HTTP_ERROR',
        denied ? 'access' : 'provider', 'response', { httpStatus: error.httpStatus });
    }
    if (Object.hasOwn(hostReasons, error.code)) {
      const [code, category, stage] = hostReasons[error.code];
      return diagnostic(operation, env, code, category, stage);
    }
  }
  if (['INVALID_COMPANY_INN', 'INVALID_REGISTRY_COMMAND', 'REGISTRY_SESSION_MISMATCH'].includes(error.message)) {
    return diagnostic(operation, env, error.message, 'validation', 'preflight', { outcome: 'not_dispatched' });
  }
  if (error.message === 'REGISTRY_HOST_REQUIRED') {
    return diagnostic(operation, env, error.message, 'setup', 'preflight',
      { action: 'update', check: 'HOST_API_AVAILABLE', outcome: 'not_dispatched' });
  }
  if (error.message === 'REGISTRY_GUEST_REQUIRED') {
    return diagnostic(operation, env, error.message, 'setup', 'preflight',
      { action: 'configure', check: 'GUEST_PROFILE_SELECTED', outcome: 'not_dispatched' });
  }
  if (error.message === 'BROWSER_SESSION_STATE_BUSY') {
    return diagnostic(operation, env, error.message, 'runtime', 'preflight',
      { action: 'read_status', outcome: 'not_dispatched' });
  }
  if (error.name === 'TimeoutError') {
    return diagnostic(operation, env, 'BROWSER_REQUEST_TIMEOUT', 'runtime', 'response',
      { outcome: 'unknown', timedOut: true, action: 'read_status', complete: false });
  }
  return diagnostic(operation, env, 'REGISTRY_OPERATION_UNCONFIRMED', 'unknown', 'unknown',
    { outcome: 'unknown', action: 'read_status', complete: false });
}

async function loadHost(env) {
  if (env.TRELIO_SKILL_ID !== ID) fail('REGISTRY_HOST_REQUIRED');
  let visual, sessions, local;
  try {
    // These are the verified host's injected module URLs. This provider never
    // reaches into a checkout, launches a browser or selects a local profile.
    const urls = ['TRELIO_VISUAL_SESSION_MODULE_URL', 'TRELIO_EXECUTION_SESSION_MODULE_URL',
      'TRELIO_LOCAL_FORM_MODULE_URL'].map(name => new URL(env[name]));
    if (urls.some(url => url.protocol !== 'file:')) fail('REGISTRY_HOST_REQUIRED');
    [visual, sessions, local] = await Promise.all(urls.map(url => import(url.href)));
  } catch {
    fail('REGISTRY_HOST_REQUIRED');
  }
  if (visual.VISUAL_PRESENTATION_API !== 'trelio.visual-presentation/v1'
    || visual.VISUAL_SEMANTIC_CONTROLS_API !== 'trelio.visual-semantic-controls/v1'
    || visual.VISUAL_FORM_CHECKS_API !== 'trelio.visual-form-checks/v1'
    || sessions.BROWSER_EXECUTION_SESSIONS_API !== 'trelio.browser-execution-sessions/v1'
    || typeof visual.runVisualSession !== 'function' || typeof visual.visualSessionBinding !== 'function'
    || typeof sessions.browserExecutionDirectory !== 'function' || typeof sessions.browserExecutionOwner !== 'function'
    || typeof sessions.withBrowserAccountState !== 'function' || typeof local.readPrivateJsonFile !== 'function'
    || typeof local.writePrivateJsonFile !== 'function' || typeof local.resolveWorkspaceBridgeConfigDirectory !== 'function'
  ) fail('REGISTRY_HOST_REQUIRED');
  if (env.TRELIO_SKILL_VISUAL_GUEST_PROFILE !== '1' || env.TRELIO_SKILL_ACCOUNT_JSON) fail('REGISTRY_GUEST_REQUIRED');
  return { visual, sessions, local };
}

function hostBrowser({ visual }, source, env) {
  const { url, presentation } = sources[source];
  return { call: (operation, args = {}) => visual.runVisualSession({
    origins: registryOrigins, presentation, observationMode: 'text',
    // The common browser handles ordinary HTTP(S) navigation and redirects.
    // The provider still owns the initial URLs and only types the supplied INN.
    externalNavigation: true, semanticControls: true,
    ...(source === 'kad' ? { fieldCheckPolicy: { origins: [new URL(url).origin], labels: [kadInput] } } : {}),
    operation, args, env }) };
}

async function loadState(local, file, deadline) {
  const state = await local.readPrivateJsonFile(file, { maximumBytes: 512 });
  if (!state || !Object.keys(state).length) return null;
  if (Object.keys(state).sort().join() !== 'deadline,innDigest,phase,source' || !activePhases.has(state.phase)
    || !Object.hasOwn(sources, state.source) || !/^[a-f0-9]{64}$/u.test(state.innDigest)
    || !Number.isSafeInteger(state.deadline)) fail('REGISTRY_STATE_INVALID');
  return state.deadline > deadline ? null : state;
}

async function closeOwned(browser, state, save) {
  // Acknowledgement is not process exit. Keep the closing fence until the
  // host reports no owner so the next registry cannot reuse an older worker.
  await save({ ...state, phase: 'closing' });
  const frame = await browser.call('close');
  if (frame.state !== 'closed' && !emptyStatus(frame)) {
    throw new RegistryReadError(frame.reason ?? 'operation_failed', frame.httpStatus);
  }
  let status = frame;
  for (let poll = 0; poll < 6 && status.state === 'closed'; poll += 1) {
    await sleep(250);
    status = await browser.call('status');
  }
  if (emptyStatus(status)) await save({});
  return frame;
}

async function finishSearch(browser, command, state, save, env) {
  const { source, inn } = command;
  const review = error => response(source, inn, { status: 'visual_review',
    diagnostic: failure(error, command.operation, env) });
  if (state.phase === 'checking' || state.phase === 'review') {
    // A previous process could have stopped after a click. Resume by reading
    // the existing page, never by issuing its search or input again.
    await save({ ...state, phase: 'review' });
    return review(new RegistryReadError('result_not_confirmed'));
  }
  try {
    const settled = await browser.call('wait');
    if (settled.state === 'preparing') return response(source, inn, { status: 'pending', next: ['resume', source, inn] });
    requireReady(settled);
    const frame = requireReady(await browser.call('read-text'));
    await save({ ...state, phase: 'checking' });
    const result = await checks[source](browser, frame, inn);
    try { await closeOwned(browser, state, save); }
    catch (error) {
      return response(source, inn, { ...result, cleanup: 'unconfirmed',
        diagnostic: failure(error, command.operation, env) });
    }
    return response(source, inn, result);
  } catch (error) {
    if (error instanceof RegistryReadError && visualFailures.has(error.code)) {
      await save({ ...state, phase: 'review' });
      return review(error);
    }
    const knownTerminal = error instanceof RegistryReadError
      && (error.httpStatus !== undefined || Object.hasOwn(hostReasons, error.code))
      && !['manual_control_active', 'session_busy', 'observation_mode_mismatch'].includes(error.code);
    if (knownTerminal) {
      try { await closeOwned(browser, state, save); }
      catch { return response(source, inn, { status: 'unavailable', cleanup: 'unconfirmed',
        diagnostic: failure(error, command.operation, env) }); }
    }
    if (!knownTerminal && !['manual_control_active', 'session_busy', 'observation_mode_mismatch'].includes(error.code)) {
      const observed = await browser.call('status').catch(() => null);
      if (observed?.state === 'ready') {
        await save({ ...state, phase: 'review' });
        return review(error);
      }
    }
    return response(source, inn, { status: 'unavailable', diagnostic: failure(error, command.operation, env) });
  }
}

async function dispatch(command, browser, state, save, env, lease) {
  const { operation, source, inn, args } = command;
  const status = await browser.call('status');
  if (state && (state.deadline <= Date.now() || emptyStatus(status) && state.phase !== 'starting')) {
    if (operation === 'close' && emptyStatus(status)) {
      checkBinding(state, command);
      await save({});
      return status;
    }
    state = null;
    await save({});
  }
  if (operation === 'check') {
    if (state?.phase === 'closing' && status.state === 'closed') {
      return response(source, inn, { status: 'closing', next: ['check', source, inn] });
    }
    if (state || !emptyStatus(status)) fail('REGISTRY_SESSION_MISMATCH');
    const next = { source, innDigest: innDigest(inn), phase: 'starting', deadline: lease };
    await save(next);
    const opened = await browser.call('navigate', { url: sources[source].url });
    if (opened.state === 'preparing' || opened.state === 'ready') {
      return response(source, inn, { status: 'pending', next: ['resume', source, inn] });
    }
    if (emptyStatus(await browser.call('status'))) await save({});
    requireReady(opened);
  }
  checkBinding(state, command);
  if (operation === 'close') return closeOwned(browser, state, save);
  if (operation === 'resume') {
    if (state.phase === 'closing') fail('REGISTRY_SESSION_MISMATCH');
    if (emptyStatus(status)) {
      await save({});
      throw new RegistryReadError('session_closed');
    }
    return finishSearch(browser, command, state, save, env);
  }
  if (state.phase !== 'review') fail('REGISTRY_SESSION_MISMATCH');
  const frame = await browser.call(operation === 'enter-inn' ? 'type-text' : operation, args);
  return requireReady(frame);
}

export async function run(argv, env = process.env, bind = loadHost) {
  // The host can ask for account metadata without a browser/session binding.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  let command;
  try {
    command = parse(argv);
    const host = await bind(env);
    if (!host.sessions.browserExecutionOwner(env)) fail('REGISTRY_HOST_REQUIRED');
    if (command.operation === 'doctor') return { minimumHostVersion: MINIMUM_HOST,
      diagnostic: diagnostic('doctor', env, 'REGISTRY_HOST_API_AVAILABLE', 'runtime', 'preflight',
        { outcome: 'confirmed_succeeded', check: 'HOST_API_AVAILABLE', complete: false }) };
    const { visual, sessions, local } = host;
    const binding = visual.visualSessionBinding(env);
    // The host remains the owner of Chromium. This separate lock protects only
    // the provider's four value-free fields under the SAME observed chat scope.
    const directory = sessions.browserExecutionDirectory(
      join(local.resolveWorkspaceBridgeConfigDirectory(), 'public-company-registry-check', binding.scope), env);
    const file = join(directory, 'check.json');
    return await sessions.withBrowserAccountState(directory, async () => {
      const state = await loadState(local, file, binding.deadlineAt);
      return dispatch(command, hostBrowser(host, command.source, env), state,
        value => local.writePrivateJsonFile(file, value), env, binding.deadlineAt);
    }, { waitMs: 500 });
  } catch (error) {
    const operation = command?.operation ?? (Object.hasOwn(known, argv[0]) ? argv[0] : 'check');
    const result = { status: 'unavailable', diagnostic: failure(error, operation, env) };
    return command?.source ? response(command.source, command.inn, result) : result;
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  // Keep machine-readable diagnostics available to the generic runtime bridge.
  // A bounded refused operation is a valid protocol response.
}
