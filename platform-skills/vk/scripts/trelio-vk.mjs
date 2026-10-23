#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MINIMUM_HOST_VERSION = '3.17.0';
// The user chooses the VK workflow. A section moving onto a VK subdomain must
// not become a provider-authored product ban. Keep the network boundary at the
// actual VK hostnames, with label-aware matching, HTTPS and no userinfo/ports.
// The host applies the same signed scope to clicks, redirects and snapshots;
// its HTML-only observation and separate mutation authority still apply.
const DOMAINS = Object.freeze(['vk.ru', 'vk.com']);
const ORIGINS = Object.freeze([
  'https://vk.ru', 'https://www.vk.ru', 'https://m.vk.ru',
  'https://vk.com', 'https://www.vk.com', 'https://m.vk.com',
  'https://id.vk.ru', 'https://id.vk.com',
  'https://login.vk.ru', 'https://login.vk.com',
  'https://connect.vk.com',
  'https://vk.me',
]);
const commands = {
  doctor: {}, setup: {}, 'show-login': {}, status: {}, wait: {}, ready: {},
  screenshot: {}, close: {}, disconnect: {},
  'read-text': { query: 'string?', offset: 'number?', includeControls: 'boolean?' },
  'submit-search': { frameId: 'string', x: 'number?', y: 'number?' },
  'search-ready': { frameId: 'string' },
  navigate: { url: 'string' },
  click: { frameId: 'string', x: 'number', y: 'number' },
  'download-attachment': { frameId: 'string', x: 'number', y: 'number' },
  'upload-files': { frameId: 'string', x: 'number', y: 'number', files: 'string[]' },
  scroll: { frameId: 'string', x: 'number', y: 'number', deltaY: 'number', deltaX: 'number?' },
  'type-text': { frameId: 'string', text: 'string' },
  key: { frameId: 'string', key: 'string' },
};
const fail = () => { throw new Error('VK_COMMAND_INVALID'); };

export function parseVkCommand(argv) {
  const [operation, ...flags] = argv;
  if (!Object.hasOwn(commands, operation) || flags.length % 2) fail();
  const args = {};
  for (let index = 0; index < flags.length; index += 2) {
    if (!flags[index].startsWith('--')) fail();
    const field = flags[index].slice(2);
    if (!Object.hasOwn(commands[operation], field) || Object.hasOwn(args, field)) fail();
    const type = commands[operation][field].replace('?', '');
    const value = flags[index + 1];
    if (type === 'string[]') {
      // CLI transports only explicit local paths. The host freezes the files
      // before browser input; the provider never reads their bytes or changes
      // their permissions, and has no alternate HTTP/clipboard upload path.
      let files;
      try { files = JSON.parse(value); } catch { fail(); }
      if (!Array.isArray(files) || !files.length || files.length > 32
        || files.some(file => typeof file !== 'string' || !path.isAbsolute(file)
          || file.length > 4096 || /[\u0000-\u001f]/u.test(file))) fail();
      args[field] = files;
      continue;
    }
    if (type === 'boolean' && !['true', 'false'].includes(value)) fail();
    if (type === 'number' && !/^-?\d+$/u.test(value)) fail();
    args[field] = type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' : value;
    if (type === 'number' && !Number.isSafeInteger(args[field])) fail();
  }
  for (const [name, type] of Object.entries(commands[operation])) {
    if (!type.endsWith('?') && args[name] === undefined) fail();
  }
  if (operation === 'submit-search' && (Object.hasOwn(args, 'x') !== Object.hasOwn(args, 'y'))) fail();
  return { operation, args };
}

function validateNavigation(raw) {
  // Reject an unrelated website before loading the host. This is provider
  // scope validation; the host still owns document/MIME/frame and redirect
  // checks, including clicks that do not pass through this CLI URL argument.
  try {
    const url = new URL(raw);
    const inScope = ORIGINS.includes(url.origin)
      || DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    if (!inScope || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error();
  } catch { throw new Error('VK_NAVIGATION_BLOCKED'); }
}

async function readGuides() {
  return {
    schemaVersion: 1,
    requiredBeforeWork: 'all_in_order',
    guides: await Promise.all(['workflow', 'security', 'uploads'].map(async name => {
      const packaged = new URL(`./references/${name}.md`, import.meta.url);
      // The signed package puts the entrypoint at its root; the checkout uses
      // scripts/. Neither candidate is influenced by caller flags or env.
      const file = fileURLToPath(await fs.access(packaged).then(
        () => packaged, () => new URL(`../references/${name}.md`, import.meta.url),
      ));
      const bytes = await fs.readFile(file);
      return { path: file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    })),
  };
}

export async function runVk(argv, env = process.env) {
  // The first account-list handshake precedes account selection. This new
  // provider has no legacy store: do not inspect profiles, start Chromium or
  // reset an existing host-owned account just to discover an empty catalogue.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  if (argv.length === 1 && argv[0] === 'commands') return { schemaVersion: 1, commands };
  if (argv.length === 1 && argv[0] === 'guides') return readGuides();

  const { operation, args } = parseVkCommand(argv);
  if (operation === 'doctor') return {
    schemaVersion: 1,
    hostVisualAvailable: Boolean(env.TRELIO_VISUAL_SESSION_MODULE_URL),
    accountSelected: Boolean(env.TRELIO_SKILL_ACCOUNT_JSON),
    minimumHostVersion: MINIMUM_HOST_VERSION,
  };
  if (operation === 'navigate') validateNavigation(args.url);
  let moduleUrl;
  try { moduleUrl = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank'); }
  catch { throw new Error('VK_HOST_REQUIRED'); }
  if (moduleUrl.protocol !== 'file:' || env.TRELIO_SKILL_ID !== 'vk') throw new Error('VK_HOST_REQUIRED');
  const { runVisualSession, VISUAL_FILE_UPLOAD_API } = await import(moduleUrl.href);
  // Never advertise successful selection through an older visual interface
  // that lacks native chooser delivery. Signed minimum admission normally
  // upgrades it first; cleanup/metadata keep their existing recovery route.
  if (operation === 'upload-files' && VISUAL_FILE_UPLOAD_API !== 'trelio.visual-file-upload/v1') throw new Error('VK_HOST_UPGRADE_REQUIRED');

  // Search submission uses the same worker-owned completion/pacing state as
  // Avito. Ordinary reads, source navigation and message sending never mark a
  // new search complete. A fresh CLI invocation cannot reset the controller.
  let hostOperation = operation, hostArgs = args;
  if (operation === 'submit-search') {
    hostOperation = 'submit';
    hostArgs = Object.hasOwn(args, 'x')
      ? { action: 'click', ...args }
      : { action: 'key', key: 'Enter', ...args };
  } else if (operation === 'search-ready') hostOperation = 'request-ready';

  // Observation, attachment opt-in and origin policy are signed provider
  // constants. The verified host supplies account identity and owns browser,
  // protected snapshot, lease and one-use input frames; no alternate transport
  // or caller-selected browser implementation is available here.
  const policy = {
    observationMode: 'text', attachmentDownloads: true, fileUploads: true,
    origins: [...ORIGINS], domains: [...DOMAINS], env,
  };
  if (operation === 'navigate') {
    // Unlike Avito, VK has no guest work mode. A first navigation without a
    // stored session must enter the host's manual gate instead of opening the
    // requested content. Never interpret a stored attempt or worker readiness
    // as authenticated VK: after restore the agent still reviews the page.
    // Preserve busy/error/manual states; they do not authorize another setup
    // or a retry that could replace a pending attempt.
    const status = await runVisualSession({ ...policy, operation: 'status', args: {} });
    if (status.state === 'not_configured') return runVisualSession({
      ...policy, operation: 'setup', args: { url: 'https://vk.ru/' },
    });
    if (!['saved_unverified', 'ready'].includes(status.state)) return status;
  }
  return runVisualSession({ ...policy, operation: hostOperation,
    args: operation === 'setup' ? { url: 'https://vk.ru/' } : hostArgs });
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await runVk(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Host/native errors can contain private URLs, input or filesystem paths.
    // Only static provider codes cross stdout; never print the raw exception.
    const safeCodes = ['VK_COMMAND_INVALID', 'VK_HOST_REQUIRED', 'VK_HOST_UPGRADE_REQUIRED', 'VK_NAVIGATION_BLOCKED'];
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, state: 'error',
      code: safeCodes.includes(error?.message) ? error.message : 'VK_RUNTIME_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
