#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MINIMUM_HOST_VERSION = '3.28.3';

const commands = {
  doctor: {}, setup: {}, 'show-login': {}, status: {}, wait: {}, ready: {}, screenshot: {}, close: {}, disconnect: {},
  'read-text': { query: 'string?', offset: 'number?', includeControls: 'boolean?' },
  'submit-search': { frameId: 'string', x: 'number?', y: 'number?' }, 'search-ready': { frameId: 'string' },
  navigate: { url: 'string' }, click: { frameId: 'string', x: 'number', y: 'number' },
  'download-attachment': { frameId: 'string', x: 'number', y: 'number' },
  'download-audio': { frameId: 'string', x: 'number', y: 'number' },
  'upload-files': { frameId: 'string', x: 'number', y: 'number', files: 'string[]' },
  scroll: { frameId: 'string', x: 'number', y: 'number', deltaY: 'number', deltaX: 'number?' },
  'type-text': { frameId: 'string', text: 'string' }, key: { frameId: 'string', key: 'string' },
};
const fail = () => { throw new Error('AVITO_COMMAND_INVALID'); };

export function parseAvitoCommand(argv) {
  const [operation, ...flags] = argv;
  if (!Object.hasOwn(commands, operation) || flags.length % 2) fail();
  const args = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i].startsWith('--')) fail();
    const field = flags[i].slice(2);
    if (!Object.hasOwn(commands[operation], field) || Object.hasOwn(args, field)) fail();
    const type = commands[operation][field].replace('?', '');
    if (type === 'string[]') {
      // Only explicit local originals cross this CLI boundary. The common
      // host checks private-file ancestry and freezes their bytes before the
      // native chooser receives them; this provider neither reads source bytes
      // nor changes their ACL. A URL, selector or page-authored path cannot
      // become a separate upload transport. Format acceptance belongs to Avito.
      let files;
      try { files = JSON.parse(flags[i + 1]); } catch { fail(); }
      if (!Array.isArray(files) || !files.length || files.length > 32
        || files.some(file => typeof file !== 'string' || !path.isAbsolute(file)
          || file.length > 4096 || /[\u0000-\u001f]/u.test(file))) fail();
      args[field] = files;
      continue;
    }
    if (type === 'boolean' && !['true', 'false'].includes(flags[i + 1])) fail();
    args[field] = type === 'number' ? Number(flags[i + 1]) : type === 'boolean' ? flags[i + 1] === 'true' : flags[i + 1];
    if (type === 'number' && !Number.isSafeInteger(args[field])) fail();
  }
  for (const [name, type] of Object.entries(commands[operation])) if (!type.endsWith('?') && args[name] === undefined) fail();
  if (operation === 'submit-search' && (Object.hasOwn(args, 'x') !== Object.hasOwn(args, 'y'))) fail();
  return { operation, args };
}

export async function runAvito(argv, env = process.env) {
  // local-accounts-v1 makes the host call this exact discovery entry before
  // account selection, including on a brand-new installation. Avito has never
  // had a pre-catalogue provider store: return the bounded empty discovery
  // envelope rather than opening Chromium, inspecting profiles or inferring an
  // account from cookies. Existing host accounts and their saved sessions stay
  // under host ownership; an empty discovery does not delete or reset them.
  // Accept only the exact internal command, so appended flags cannot turn this
  // bootstrap path into a caller-controlled storage or browser operation.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  // These value-free provider commands need no credentials, native storage or
  // browser I/O. The host has already selected a catalogue record before this
  // entry, but the record does not need a configured provider session.
  if (argv.length === 1 && argv[0] === 'commands') return { schemaVersion: 1, commands };
  if (argv.length === 1 && argv[0] === 'guides') return {
    schemaVersion: 1,
    requiredBeforeWork: 'all_in_order',
    guides: await Promise.all(['workflow', 'security'].map(async name => {
      const packaged = new URL(`./references/${name}.md`, import.meta.url);
      // Source checkout keeps scripts/ separate; signed packages put this
      // entrypoint at their root. Neither path is supplied by the caller.
      const file = fileURLToPath(await fs.access(packaged).then(() => packaged, () => new URL(`../references/${name}.md`, import.meta.url)));
      const bytes = await fs.readFile(file);
      const { createHash } = await import('node:crypto');
      return { path: file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    })),
  };
  const { operation, args } = parseAvitoCommand(argv);
  if (operation === 'doctor') return {
    schemaVersion: 1, hostVisualAvailable: Boolean(env.TRELIO_VISUAL_SESSION_MODULE_URL),
    // The audio API marker is unchanged, but codec-labelled M4A requires the
    // corrected container/MIME compatibility. Signed admission upgrades to
    // this exact floor before browser I/O; close preserves an older worker's
    // authorisation instead of resetting the account or importing its profile.
    accountSelected: Boolean(env.TRELIO_SKILL_ACCOUNT_JSON), minimumHostVersion: MINIMUM_HOST_VERSION,
  };
  const url = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank');
  if (url.protocol !== 'file:' || env.TRELIO_SKILL_ID !== 'avito') throw new Error('AVITO_HOST_REQUIRED');
  const { runVisualSession, VISUAL_FILE_UPLOAD_API, VISUAL_AUDIO_DOWNLOAD_API } = await import(url.href);
  // A stale host must fail before any chooser click, not silently accept a
  // command it cannot deliver. Keep close/status usable for normal recovery;
  // the API marker never authorises sending or bypasses first-contact review.
  if (operation === 'upload-files' && VISUAL_FILE_UPLOAD_API !== 'trelio.visual-file-upload/v1') throw new Error('AVITO_HOST_UPGRADE_REQUIRED');
  // A voice control is not a document link. Only the separately opted-in
  // audio API may observe its native player/blob; an old host must refuse
  // before clicking instead of trying attachment download or ordinary play.
  if (operation === 'download-audio' && VISUAL_AUDIO_DOWNLOAD_API !== 'trelio.visual-audio-download/v1') throw new Error('AVITO_HOST_UPGRADE_REQUIRED');
  // Domain policy and initial URL belong to this signed provider. The common
  // host owns storage, Chromium, bounded observations, guards and lifecycle.
  // There is no alternate transport, local executable override or site script.
  // The literal opt-in is part of this signed implementation. It cannot be
  // changed by a model flag, browser page or an inherited mode environment.
  let hostOperation = operation, hostArgs = args;
  if (operation === 'submit-search') {
    hostOperation = 'submit';
    hostArgs = Object.hasOwn(args, 'x') ? { action: 'click', ...args } : { action: 'key', key: 'Enter', ...args };
  } else if (operation === 'search-ready') hostOperation = 'request-ready';
  return runVisualSession({ observationMode: 'text', attachmentDownloads: true, audioDownloads: true, fileUploads: true, origins: ['https://www.avito.ru', 'https://avito.ru'], domains: ['avito.ru'],
    operation: hostOperation, args: operation === 'setup' ? { url: 'https://www.avito.ru/' } : hostArgs, env });
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await runAvito(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Runtime/browser errors may contain URLs, input text or local storage.
    // Never echo a native message/stack or fall back to another implementation.
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, state: 'error', code: ['AVITO_COMMAND_INVALID', 'AVITO_HOST_REQUIRED', 'AVITO_HOST_UPGRADE_REQUIRED'].includes(error.message) ? error.message : 'AVITO_RUNTIME_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
