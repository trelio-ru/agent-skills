#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'instagram-web';
const RUNTIME_VERSION = '1.1.0';
const MINIMUM_HOST_VERSION = '3.35.11';
const ORIGIN = 'https://www.instagram.com';
// Start at the public homepage so Instagram presents its normal sign-in entry
// point. Opening the nested login URL directly returned HTTP 429 in live setup.
const SETUP_URL = `${ORIGIN}/`;
const VISUAL_STATUS_KIND = 'trelio.visual-browser/v1';
const RESERVED_ROUTES = new Set([
  'about', 'accounts', 'ads', 'api', 'challenge', 'checkpoint', 'developer',
  'direct', 'embed', 'explore', 'legal', 'oauth', 'p', 'privacy', 'reel',
  'reels', 'share', 'stories', 'terms', 'tv', 'web',
]);
const frame = { frameId: 'string' };
const point = { ...frame, x: 'number', y: 'number' };
const browserCommands = {
  doctor: {}, status: {}, setup: {}, 'show-login': {}, wait: {}, ready: {}, close: {},
  navigate: { url: 'string' },
  'read-text': { query: 'string?', offset: 'number?', includeControls: 'boolean?' },
  screenshot: {}, click: point, scroll: { ...point, deltaY: 'number', deltaX: 'number?' },
  'type-text': { ...frame, text: 'string' }, key: { ...frame, key: 'string' },
  'download-attachment': point, 'download-audio': point,
  'upload-files': { ...point, files: 'string[]' },
};
const commands = { ...browserCommands, read: { url: 'string', offset: 'non-negative integer?' } };
const commandInvalid = () => { throw new Error('INSTAGRAM_COMMAND_INVALID'); };

function instagramTarget(input) {
  // Match the raw URL before WHATWG normalization can collapse dot segments
  // or escapes. Use one canonical origin and omit all share/query/fragment
  // data from both navigation and evidence for the original exact-read CLI.
  // Ordinary navigation and Direct are served by the full browser commands.
  const match = input.length <= 768
    && /^https:\/\/(?:www\.)?instagram\.com\/(?:([a-zA-Z0-9_.]{1,30})|(p|reel)\/([a-zA-Z0-9_-]{1,64}))\/?(?:[?#][^\s\\\x00-\x1f\x7f]*)?$/u.exec(input);
  if (!match || match[0] !== input) commandInvalid();
  const [, profile, route, shortcode] = match;
  if (profile) {
    const handle = profile.toLowerCase();
    if (RESERVED_ROUTES.has(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) commandInvalid();
    return { targetKind: 'profile', url: `${ORIGIN}/${handle}/` };
  }
  // Shortcodes are case-sensitive, even though profile handles are not.
  return { targetKind: route === 'p' ? 'post' : 'reel', url: `${ORIGIN}/${route}/${shortcode}/` };
}

function parseBrowserArgs(operation, flags) {
  if (flags.length % 2) commandInvalid();
  const fields = browserCommands[operation];
  const args = {};
  // Translate CLI types only; the host owns URL policy, current frame and
  // session validation, and safe-file checks before opening the chooser.
  for (let index = 0; index < flags.length; index += 2) {
    const [flag, value] = [flags[index], flags[index + 1]];
    if (typeof flag !== 'string' || !flag.startsWith('--') || typeof value !== 'string') commandInvalid();
    const field = flag.slice(2);
    if (!Object.hasOwn(fields, field) || Object.hasOwn(args, field)) commandInvalid();
    switch (fields[field].replace('?', '')) {
      case 'number':
        if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) commandInvalid();
        args[field] = Number(value);
        break;
      case 'boolean':
        if (value !== 'true' && value !== 'false') commandInvalid();
        args[field] = value === 'true';
        break;
      case 'string[]': {
        let files;
        try { files = JSON.parse(value); } catch { commandInvalid(); }
        if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string')) commandInvalid();
        args[field] = files;
        break;
      }
      default: args[field] = value;
    }
  }
  for (const [field, type] of Object.entries(fields)) {
    if (!type.endsWith('?') && !Object.hasOwn(args, field)) commandInvalid();
  }
  return args;
}

function parseCommand(argv) {
  const [operation, flag, input, offsetFlag, offsetValue] = argv;
  if (!Object.hasOwn(commands, operation)) commandInvalid();
  if (operation !== 'read') return { operation, args: parseBrowserArgs(operation, argv.slice(1)) };
  if (![3, 5].includes(argv.length) || flag !== '--url' || typeof input !== 'string') commandInvalid();
  const target = instagramTarget(input);
  if (argv.length === 3) return { operation, target };
  if (offsetFlag !== '--offset' || !/^(?:0|[1-9][0-9]{0,5})$/u.test(offsetValue) || Number(offsetValue) > 100_000)
    commandInvalid();
  return { operation, target, offset: Number(offsetValue) };
}

async function visualHost(env, operation) {
  const url = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank');
  if (env.TRELIO_SKILL_ID !== SKILL_ID || url.protocol !== 'file:') throw new Error('INSTAGRAM_HOST_REQUIRED');
  const host = await import(url.href);
  if (host.VISUAL_PRESENTATION_API !== 'trelio.visual-presentation/v1'
    || host.VISUAL_EXACT_DOCUMENT_READ_API !== 'trelio.visual-exact-document-read/v1'
    || typeof host.runVisualSession !== 'function') throw new Error('INSTAGRAM_HOST_UPGRADE_REQUIRED');
  // An old host must fail before touching a file control. Session close and
  // manual completion remain available on the installed runtime.
  if ((operation === 'upload-files' && host.VISUAL_FILE_UPLOAD_API !== 'trelio.visual-file-upload/v1')
    || (operation === 'download-audio' && host.VISUAL_AUDIO_DOWNLOAD_API !== 'trelio.visual-audio-download/v1')
    || (operation === 'download-attachment' && host.VISUAL_ATTACHMENT_FILE_API !== 'trelio.visual-attachment-file/v1'))
    throw new Error('INSTAGRAM_HOST_UPGRADE_REQUIRED');
  return (operation, args = {}) => host.runVisualSession({
    // Use the host's full HTTP(S) navigation for browser links and login
    // redirects. The Instagram origin/domain still scope the saved cookies.
    origins: [ORIGIN], domains: ['instagram.com'],
    // These opt-ins are stable for the whole worker. Direct, public pages and
    // file controls share the selected account and its existing snapshot.
    attachmentDownloads: true, audioDownloads: true, fileUploads: true,
    observationMode: 'text', presentation: 'hidden', operation, args, env,
  });
}

async function readDocument(invoke, target, offset) {
  const expectedDocumentUrl = target.url;
  const readCurrent = () => invoke('read-text', { expectedDocumentUrl, offset: offset ?? 0 });
  let result = offset === undefined
    ? await invoke('navigate', { url: target.url, expectedDocumentUrl })
    : await readCurrent();
  if (offset === undefined && result?.state === 'preparing') {
    // The original navigation belongs to the cold worker. Check its existing
    // lease once and continue by reading the same frame, never by navigating again.
    const status = await invoke('wait');
    result = status?.state === 'ready' ? await readCurrent() : status;
  }

  // The host's closed status envelope carries safe diagnostic codes and may
  // report manual login or an HTTP failure without any content. A status or a
  // saved snapshot can never be used as evidence that a page was read.
  if (result?.kind === VISUAL_STATUS_KIND && result.state !== 'ready') return result;
  if (result?.kind !== 'trelio.browser-text/v1' || result.state !== 'ready'
    || result.verifiedDocumentUrl !== expectedDocumentUrl || typeof result.title !== 'string'
    || typeof result.text !== 'string' || typeof result.scanLimited !== 'boolean'
    || (result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset)
      || result.nextOffset <= (offset ?? 0) || result.nextOffset > 100_000))) {
    throw new Error('INSTAGRAM_DOCUMENT_UNVERIFIED');
  }
  // URL equality establishes the observed document, not its business meaning.
  // A login wall or an unavailable post can render at the same URL. The agent
  // receives only rendered evidence, with no input controls or private worker data.
  return { schemaVersion: 1, state: 'observed', ...target, title: result.title, text: result.text,
    nextOffset: result.nextOffset, scanLimited: result.scanLimited };
}

export async function runInstagram(argv, env = process.env) {
  // The cold account discovery command precedes account and Chromium I/O.
  // There is no legacy Instagram store to migrate or reset.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  if (argv.length === 1 && argv[0] === 'commands') return { schemaVersion: 1, commands };
  const { operation, args, target, offset } = parseCommand(argv);
  if (operation === 'doctor') return { schemaVersion: 1, runtimeVersion: RUNTIME_VERSION,
    minimumHostVersion: MINIMUM_HOST_VERSION, hostVisualAvailable: Boolean(env.TRELIO_VISUAL_SESSION_MODULE_URL) };
  // Guest and personal state are intentionally separate. A manual login can
  // only save to an explicitly selected account, never the guest namespace.
  if (['setup', 'show-login'].includes(operation) && (env.TRELIO_SKILL_VISUAL_GUEST_PROFILE === '1' || !env.TRELIO_SKILL_ACCOUNT_JSON))
    throw new Error('INSTAGRAM_PERSONAL_ACCOUNT_REQUIRED');
  const invoke = await visualHost(env, operation);
  if (operation === 'read') return readDocument(invoke, target, offset);
  if (operation === 'setup') return invoke('setup', { url: SETUP_URL });
  return invoke(operation, args);
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await runInstagram(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Native exception messages can include private URLs or platform state.
    // Only implementation-selected codes go to the model.
    const codes = ['INSTAGRAM_COMMAND_INVALID', 'INSTAGRAM_HOST_REQUIRED', 'INSTAGRAM_HOST_UPGRADE_REQUIRED',
      'INSTAGRAM_PERSONAL_ACCOUNT_REQUIRED', 'INSTAGRAM_DOCUMENT_UNVERIFIED'];
    const code = codes.includes(error?.message) ? error.message : 'INSTAGRAM_RUNTIME_FAILED';
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, state: 'error', code })}\n`);
    process.exitCode = 1;
  }
}
