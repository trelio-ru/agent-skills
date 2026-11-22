#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorFailure, editorLink, executeWorkflow, fieldCheckPolicy, parseWorkflow, workflowCommands } from './editor-workflows.mjs';

export const SKILL_ID = 'google-editors-web';
export const SKILL_VERSION = '0.1.5';
// This is the first host that opens ordinary web links by default alongside
// editor references, attachment redirects and the embedded picker.
export const MINIMUM_HOST_VERSION = '3.34.32';
const origins = [
  'https://docs.google.com', 'https://drive.google.com', 'https://accounts.google.com',
  'https://workspace.google.com', 'https://accounts.google.ru', 'https://accounts.youtube.com',
  'https://google.com', 'https://google.ru', 'https://youtube.com',
];
const referenceRoutes = [
  { origin: 'https://docs.google.com', prefix: '/document/d/', suffix: '/edit', selector: 'tab' },
  { origin: 'https://docs.google.com', prefix: '/spreadsheets/d/', suffix: '/edit', selector: 'gid' },
];
const startPages = {
  document: 'https://docs.google.com/document/u/0/',
  spreadsheet: 'https://docs.google.com/spreadsheets/u/0/',
  drive: 'https://drive.google.com/drive/my-drive',
};
const signIn = new URL('https://accounts.google.com/ServiceLogin');
signIn.searchParams.set('service', 'wise');
signIn.searchParams.set('continue', startPages.spreadsheet);

const commands = Object.freeze({
  commands: {}, guides: {}, doctor: {}, setup: {}, 'show-login': {}, ready: {}, status: {}, wait: {}, close: {}, disconnect: {},
  'open-home': { editor: 'string' }, navigate: { url: 'string' }, screenshot: {},
  'read-text': { query: 'string?', offset: 'integer?', controlQuery: 'string?', controlOffset: 'integer?' },
  click: { frameId: 'string', x: 'integer', y: 'integer' }, 'type-text': { frameId: 'string', text: 'string' },
  key: { frameId: 'string', key: 'string' }, scroll: { frameId: 'string', x: 'integer', y: 'integer', deltaY: 'integer', deltaX: 'integer?' },
  'download-attachment': { frameId: 'string', x: 'integer', y: 'integer' },
  'upload-file': { frameId: 'string', x: 'integer', y: 'integer', file: 'string' },
  ...Object.fromEntries(workflowCommands.map(name => [name, { spec: 'string' }])),
});

const noInput = new Set(['commands', 'guides', 'doctor', 'show-login', 'ready', 'status', 'wait', 'close', 'disconnect',
  'open-home', 'navigate', 'screenshot', 'read-text', 'scroll', 'inspect-file', 'find-document-text', 'read-sheet-range', 'find-sheet-rows',
  'read-document', 'export-file', 'download-attachment', 'select-sheet', 'read-document-outline', 'read-document-section', 'read-sheet-formulas',
  'open-sheet-import', 'show-document-tabs']);
const fixedErrors = new Set([
  'EDITORS_COMMAND_INVALID', 'EDITORS_TARGET_INVALID', 'EDITORS_TARGET_UNVERIFIED', 'EDITORS_TARGET_AMBIGUOUS',
  'EDITORS_SPEC_INVALID', 'EDITORS_RANGE_INVALID', 'EDITORS_CSV_INVALID', 'EDITORS_EXPORT_UNVERIFIED',
  'EDITORS_HOST_REQUIRED', 'EDITORS_HOST_UPGRADE_REQUIRED', 'EDITORS_RUNTIME_FAILED', 'EDITORS_DOCUMENT_BLOCKED',
  'EDITORS_BROWSER_UNAVAILABLE', 'EDITORS_SESSION_CHANGED', 'EDITORS_UI_UNSUPPORTED', 'EDITORS_FIND_UNVERIFIED',
  'EDITORS_FIND_MODE_UNVERIFIED', 'EDITORS_REPLACEMENT_ALREADY_PRESENT', 'EDITORS_ACTION_UNKNOWN', 'EDITORS_RESULT_TOO_LARGE',
  'EDITORS_OFFICE_EXPORT_INVALID',
  'EDITORS_MANUAL_INPUT_REQUIRED',
]);
const failure = (code, outcome = 'not_dispatched', stage = 'preflight') => ({
  schemaVersion: 1, state: 'error', code, outcome, stage,
});

export function parseCommand(argv) {
  const [operation, ...tokens] = argv;
  if (!Object.hasOwn(commands, operation) || tokens.length % 2) throw new EditorFailure('EDITORS_COMMAND_INVALID');
  const allowed = commands[operation];
  const args = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i].startsWith('--') ? tokens[i].slice(2) : '';
    const raw = tokens[i + 1];
    if (!Object.hasOwn(allowed, key) || Object.hasOwn(args, key) || typeof raw !== 'string'
        || Buffer.byteLength(raw) > 16_384 || raw.includes('\0')) throw new EditorFailure('EDITORS_COMMAND_INVALID');
    const fieldKind = allowed[key];
    if (fieldKind.startsWith('integer')) {
      if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new EditorFailure('EDITORS_COMMAND_INVALID');
      args[key] = Number(raw);
    } else args[key] = raw;
  }
  if (Object.entries(allowed).some(([key, type]) => !type.endsWith('?') && !Object.hasOwn(args, key))) {
    throw new EditorFailure('EDITORS_COMMAND_INVALID');
  }
  if (operation === 'read-text' && (['query', 'controlQuery'].some(key => args[key]?.length > 120)
      || args.offset !== undefined && (args.offset < 0 || args.offset > 100_000)
      || args.controlOffset !== undefined && (args.controlOffset < 0 || args.controlOffset > 1200))) {
    throw new EditorFailure('EDITORS_COMMAND_INVALID');
  }
  if (operation === 'open-home') {
    if (!Object.hasOwn(startPages, args.editor)) throw new EditorFailure('EDITORS_COMMAND_INVALID');
    return { operation, browserOperation: 'navigate', args: { url: startPages[args.editor] } };
  }
  if (operation === 'navigate') {
    // Keep canonical links for supported Docs and Sheets, and pass other
    // page URLs to Chromium. Editor workflows still resolve exact files.
    let url = args.url;
    try { url = editorLink(url).url; }
    catch (error) {
      if (!(error instanceof EditorFailure) || error.code !== 'EDITORS_TARGET_INVALID') throw error;
    }
    return { operation, browserOperation: operation, args: { url } };
  }
  if (operation === 'setup') return { operation, browserOperation: operation, args: { url: signIn.href } };
  if (operation === 'upload-file') {
    const { file, ...control } = args;
    if (!isAbsolute(file) || file.length > 4096) throw new EditorFailure('EDITORS_COMMAND_INVALID');
    return { operation, browserOperation: 'upload-files', args: { ...control, files: [file] } };
  }
  if (workflowCommands.includes(operation)) return { operation, spec: parseWorkflow(operation, args.spec) };
  return { operation, browserOperation: operation, args };
}

export async function runEditors(argv, env = process.env) {
  // New skill / new namespace: never search other providers' profiles.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  let operation, dispatched = false;
  try {
    const parsed = parseCommand(argv);
    operation = parsed.operation;
    if (operation === 'commands') return { schemaVersion: 1, commands };
    if (operation === 'doctor') return { schemaVersion: 1, skillVersion: SKILL_VERSION,
      minimumHostVersion: MINIMUM_HOST_VERSION, connection: 'not_checked', browser: 'not_checked' };
    if (operation === 'guides') {
      const file = await realpath(fileURLToPath(new URL('./instruction-guides/workflow.md', import.meta.url)));
      const source = await readFile(file);
      return { schemaVersion: 1, requiredBeforeWork: 'all_in_order', guides: [
        { path: file, sizeBytes: source.length, sha256: createHash('sha256').update(source).digest('hex') },
      ] };
    }
    let adapter;
    try { adapter = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL); } catch { throw new EditorFailure('EDITORS_HOST_REQUIRED'); }
    if (env.TRELIO_SKILL_ID !== SKILL_ID || adapter.protocol !== 'file:') throw new EditorFailure('EDITORS_HOST_REQUIRED');
    const host = await import(adapter.href);
    if (host.VISUAL_PRESENTATION_API !== 'trelio.visual-presentation/v1'
        || host.VISUAL_SEMANTIC_CONTROLS_API !== 'trelio.visual-semantic-controls/v1'
        || host.VISUAL_FORM_CHECKS_API !== 'trelio.visual-form-checks/v1'
        || host.VISUAL_ATTACHMENT_REDIRECT_API !== 'trelio.visual-attachment-redirect/v1'
        || host.VISUAL_EMBEDDED_PICKER_API !== 'trelio.visual-embedded-picker/v1'
        || host.VISUAL_DOCUMENT_REFERENCE_API !== 'trelio.visual-document-reference/v1' || typeof host.runVisualSession !== 'function') {
      throw new EditorFailure('EDITORS_HOST_UPGRADE_REQUIRED');
    }
    const perform = (op, args) => host.runVisualSession({ origins, presentation: 'hidden', observationMode: 'text',
      semanticControls: true, fieldCheckPolicy, referenceRoutes, attachmentDownloads: true,
      attachmentRedirectDomains: ['googleusercontent.com'], fileUploads: true, fileUploadPickerPaths: ['/picker'], operation: op, args, env });
    dispatched = true;
    if (parsed.spec) {
      const result = await executeWorkflow(operation, parsed.spec, perform);
      if (result.kind === 'trelio.browser-file/v1') return result;
      return { schemaVersion: 1, state: 'ready', ...result };
    }
    const result = await perform(parsed.browserOperation, parsed.args);
    if (result?.state === 'error' && !noInput.has(operation) && !['invalid_input', 'stale_frame'].includes(result.reason)) {
      return failure('EDITORS_ACTION_UNKNOWN', 'unknown', 'request');
    }
    return result;
  } catch (error) {
    const code = fixedErrors.has(error?.message) ? error.message : 'EDITORS_RUNTIME_FAILED';
    // Workflow failures keep their explicit dispatch boundary. Unexpected
    // errors never expose a URL, cell contents, file paths or provider stack.
    if (error instanceof EditorFailure) return failure(code, error.outcome, error.stage);
    return failure(code, dispatched && !noInput.has(operation) ? 'unknown' : 'not_dispatched', dispatched ? 'request' : 'preflight');
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const result = await runEditors(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.state === 'error') process.exitCode = 1;
}
