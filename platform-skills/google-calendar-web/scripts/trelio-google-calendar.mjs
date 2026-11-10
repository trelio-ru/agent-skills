#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { executeWorkflow, parseWorkflowSpec, workflowCommands, workflowWrites, WorkflowError, fieldCheckPolicy } from './calendar-workflows.mjs';

export const SKILL_VERSION = '0.1.1';
export const MINIMUM_HOST_VERSION = '3.32.0';
// Use Google's Calendar sign-in entry directly in the already guarded tab.
// The public landing page's Sign in opens a new, initially unguarded tab; its
// headerless redirect is deliberately rejected by the host's file/MIME fence.
// No flow tokens, account hints or credentials are copied into this static URL.
const setupUrl = 'https://accounts.google.com/ServiceLogin?service=cl&continue=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fr';
// A fresh Google session redirects Calendar to its public Workspace landing
// page. Its Sign in link returns to accounts.google.com and then Calendar.
// Admit that observed route explicitly; never broaden this to *.google.com.
// Google may finish sign-in via regional Google and YouTube account hosts
// (documented in its official authentication host list). Explicit parent
// origins admit the corresponding domain-wide session cookies to the private
// Cookie API overlay: exact child origins alone must NOT grant parent cookies.
// These are exact HTTPS origins, never wildcard navigation or a YouTube task.
const origins = ['https://calendar.google.com', 'https://accounts.google.com', 'https://workspace.google.com',
  'https://accounts.youtube.com', 'https://accounts.google.ru',
  'https://google.com', 'https://google.ru', 'https://youtube.com'];
// Read-only success conditions belong to this signed provider, not model argv.
// Calendar's own account link plus working calendar navigation distinguish the
// authenticated app from the public landing page, account chooser and MFA.
// The host requires two stable observations and performs the existing stopped
// profile save before it releases the manual gate; no business input is sent.
export const manualCompletion = { success: [{ origin: 'https://calendar.google.com', pathPrefix: '/calendar/',
  selectors: [
    'a[aria-label^="Аккаунт Google:"],a[aria-label^="Google Account:"]',
    '[aria-label^="Сегодня,"],[aria-label^="Today,"]',
    '[aria-label="Настройки"],[aria-label="Settings"]',
  ], blocked: ['[role="dialog"]', 'input[type="password"]', 'input[autocomplete="one-time-code" i]'] }] };
const commands = Object.freeze({
  commands: {}, guides: {}, doctor: {}, setup: {}, 'show-login': {}, ready: {}, status: {}, wait: {}, close: {}, disconnect: {},
  ...workflowCommands,
  navigate: { url: 'string' }, screenshot: {},
  'read-text': { query: 'string?', offset: 'number?', includeControls: 'boolean?', controlQuery: 'string?', controlOffset: 'number?' },
  click: { frameId: 'string', x: 'number', y: 'number' },
  'type-text': { frameId: 'string', text: 'string' }, key: { frameId: 'string', key: 'string' },
  scroll: { frameId: 'string', x: 'number', y: 'number', deltaY: 'number', deltaX: 'number?' },
});
const inputs = new Set(['click', 'type-text', 'key', 'scroll']);
const cleanup = new Set(['close', 'status', 'wait', 'ready', 'disconnect']);
const states = new Set(['not_configured', 'preparing', 'manual_input_required', 'saved_unverified', 'ready', 'closed', 'error']);
// Only known pre-dispatch refusals establish absence of an input. A failed
// observation after a successful click can look like any other browser error;
// never infer non-delivery from timeout, document failure or generic prose.
const notDispatched = new Set(['invalid_input', 'stale_frame']);
const safeReasons = new Set([...notDispatched, 'manual_control_active', 'lease_expired', 'session_closed',
  'session_busy', 'observation_mode_mismatch', 'navigation_blocked', 'operation_failed', 'bootstrap_failed', 'storage_unavailable',
  'storage_corrupt', 'browser_process_lost', 'http_document_failure', 'document_blocked',
  'authentication_required', 'authentication_setup_required', 'authentication_unknown', 'tab_limit_reached']);
class CalendarError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const invalid = () => { throw new CalendarError('CALENDAR_COMMAND_INVALID'); };

export function parseCalendarCommand(argv) {
  const [operation, ...flags] = argv;
  if (!Object.hasOwn(commands, operation) || flags.length % 2) invalid();
  const args = {};
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i].startsWith('--') ? flags[i].slice(2) : '';
    const type = commands[operation][name];
    const value = flags[i + 1];
    if (!type || Object.hasOwn(args, name) || typeof value !== 'string' || value.length > 16384) invalid();
    if (type.startsWith('number')) {
      // Empty strings and whitespace must not silently become coordinate zero.
      if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) invalid();
      args[name] = Number(value);
    } else if (type.startsWith('boolean')) {
      if (!['true', 'false'].includes(value)) invalid();
      args[name] = value === 'true';
    } else args[name] = value;
  }
  for (const [name, type] of Object.entries(commands[operation])) {
    if (!type.endsWith('?') && !Object.hasOwn(args, name)) invalid();
  }
  if (operation === 'read-text' && (['query', 'controlQuery'].some(key => args[key]?.length > 120)
    || args.controlOffset !== undefined && (args.controlOffset < 0 || args.controlOffset > 1200))) invalid();
  return { operation, args, ...(Object.hasOwn(workflowCommands, operation) ? { workflowSpec: parseWorkflowSpec(operation, args.spec) } : {}) };
}

/** Build only the public, value-free diagnostic vocabulary. The actual
 * serializer must also pass the backend contract at the cross-component gate;
 * exceptions, source URLs, page text and input never have a field here. */
export function calendarFailure({ code, operation = 'unknown', write = false, stage = 'preflight',
  outcome = 'not_dispatched', category = 'runtime', host = null, checks = [], httpStatus, reason }) {
  return { schemaVersion: 1, state: 'error', code,
    ...(safeReasons.has(reason) ? { browserReason: reason } : {}),
    diagnostic: { contract: 'trelio.skill-diagnostic/v1', code, category,
      operationKind: write ? 'write' : 'read', operation, stage, outcome, checks,
      evidence: Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {},
      versions: { skill: SKILL_VERSION, host: /^\d+\.\d+\.\d+$/u.test(host || '') ? host : null,
        platform: ['darwin', 'win32', 'linux'].includes(process.platform) ? process.platform : 'unknown' },
      recovery: { action: code === 'CALENDAR_HOST_UPGRADE_REQUIRED' ? 'update'
        : code === 'CALENDAR_HOST_REQUIRED' ? 'configure'
        : code === 'CALENDAR_COMMAND_INVALID' ? 'none' : 'read_status',
      retry: 'forbidden', diagnosticComplete: code === 'CALENDAR_COMMAND_INVALID' } } };
}

export async function runCalendar(argv, env = process.env) {
  // The common account catalogue asks this before selecting/creating an account.
  // This skill has no legacy store. Return an empty inventory without touching
  // env, credentials, native keyring, browser or another provider's profiles.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  let operation = 'unknown', write = false, dispatched = false, host = null;
  const checks = [];
  try {
    const parsed = parseCalendarCommand(argv); operation = parsed.operation;
    if (operation === 'commands') return { schemaVersion: 1, commands };
    if (operation === 'guides') {
      const guides = [];
      for (const name of ['part-01.md', 'part-02.md']) {
        const path = await fs.realpath(fileURLToPath(new URL(`instruction-guides/${name}`, import.meta.url)));
        const bytes = await fs.readFile(path);
        guides.push({ path, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      return { schemaVersion: 1, requiredBeforeWork: 'all_in_order', guides };
    }
    if (operation === 'doctor') return { schemaVersion: 1, skillVersion: SKILL_VERSION,
      minimumHostVersion: MINIMUM_HOST_VERSION, hostModuleAvailable: Boolean(env.TRELIO_VISUAL_SESSION_MODULE_URL),
      browser: 'not_checked', connection: 'not_checked', network: 'not_checked' };
    write = inputs.has(operation) || workflowWrites.has(operation);
    checks.push({ check: 'COMMAND_VALIDATION', result: 'passed' });
    host = env.TRELIO_HOST_RUNTIME_VERSION;
    let url;
    try { url = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank'); } catch {}
    if (url?.protocol !== 'file:' || env.TRELIO_SKILL_ID !== 'google-calendar-web') throw new CalendarError('CALENDAR_HOST_REQUIRED');
    const runtime = await import(url.href);
    const supported = runtime.VISUAL_PRESENTATION_API === 'trelio.visual-presentation/v1'
      && runtime.VISUAL_SEMANTIC_CONTROLS_API === 'trelio.visual-semantic-controls/v1'
      && runtime.VISUAL_FORM_CHECKS_API === 'trelio.visual-form-checks/v1'
      && runtime.VISUAL_MANUAL_COMPLETION_API === 'trelio.visual-manual-completion/v1'
      && typeof runtime.runVisualSession === 'function';
    checks.push({ check: 'HOST_INTERFACE', result: supported ? 'passed' : 'failed' });
    // An old live worker may still be inspected and closed, but it must never
    // open a visible calendar while pretending to honour the hidden contract.
    if (!supported && !cleanup.has(operation)) throw new CalendarError('CALENDAR_HOST_UPGRADE_REQUIRED');
    if (typeof runtime.runVisualSession !== 'function') throw new CalendarError('CALENDAR_HOST_REQUIRED');
    dispatched = true;
    if (Object.hasOwn(workflowCommands, operation)) return await executeWorkflow(operation, parsed.workflowSpec,
      (operation, args) => runtime.runVisualSession({ origins, presentation: 'hidden', semanticControls: true, fieldCheckPolicy, manualCompletion,
        observationMode: 'text', operation, args, env }));
    const value = await runtime.runVisualSession({ origins, presentation: 'hidden', semanticControls: true, fieldCheckPolicy, manualCompletion, observationMode: 'text',
      operation, args: operation === 'setup' ? { url: setupUrl } : parsed.args, env });
    if (!value || !states.has(value.state) || !['trelio.visual-browser/v1', 'trelio.browser-text/v1'].includes(value.kind)) {
      return calendarFailure({ code: 'CALENDAR_RESULT_INVALID', operation, write, host, checks,
        stage: 'response', outcome: write ? 'unknown' : 'not_dispatched' });
    }
    if (value.state !== 'error') return value;
    const uncertain = write && !notDispatched.has(value.reason);
    return calendarFailure({ code: uncertain ? 'CALENDAR_ACTION_UNKNOWN' : 'CALENDAR_BROWSER_REFUSED',
      operation, write, host, checks, reason: value.reason, httpStatus: value.httpStatus,
      outcome: uncertain ? 'unknown' : 'not_dispatched', stage: value.diagnostic ? 'startup' : 'response',
      category: value.httpStatus === 401 || value.httpStatus === 403 ? 'access' : 'runtime' });
  } catch (error) {
    if (error instanceof WorkflowError) return calendarFailure({ code: error.code, operation, write, host, checks,
      stage: error.stage, outcome: error.outcome, reason: error.reason,
      category: error.code === 'CALENDAR_COMMAND_INVALID' ? 'validation' : 'runtime' });
    const code = error instanceof CalendarError ? error.code : 'CALENDAR_RUNTIME_FAILED';
    return calendarFailure({ code, operation, write, host, checks,
      stage: dispatched ? 'request' : 'preflight', outcome: dispatched && write ? 'unknown' : 'not_dispatched',
      category: code === 'CALENDAR_COMMAND_INVALID' ? 'validation' : code === 'CALENDAR_HOST_UPGRADE_REQUIRED' ? 'setup' : 'runtime' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  const result = await runCalendar(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state === 'error') process.exitCode = 1;
}
