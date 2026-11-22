#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'yandex-search';
const MINIMUM_HOST_VERSION = '3.34.21';
const targets = {"search": "https://yandex.ru/search/", "chat": "https://alice.yandex.ru/"};
const origins = ["https://yandex.ru", "https://alice.yandex.ru", "https://ya.ru"];
const referenceRoutes = [{ origin: 'https://alice.yandex.ru', prefix: '/chat/', suffix: '', selector: 'none' }];

// Lifecycle and paced submissions belong to the host. This adapter pins the
// site and presentation, and exposes only the arguments needed by this skill.
const commands = {
  doctor: {}, status: {}, wait: {}, ready: {}, 'show-login': {}, close: {},
  open: { target: 'string?' }, setup: { target: 'string?', inputFile: 'string?' },
  'open-source': { url: 'string' }, 'return-to-chat': { url: 'string' },
  'read-text': { query: 'string?', offset: 'number?', controlQuery: 'string?', controlOffset: 'number?' },
  screenshot: {}, click: { frameId: 'string', x: 'number', y: 'number' },
  scroll: { frameId: 'string', x: 'number', y: 'number', deltaY: 'number' },
  'type-text': { frameId: 'string', inputFile: 'string' },
  key: { frameId: 'string', key: 'string' },
  submit: { frameId: 'string', x: 'number?', y: 'number?' },
  'answer-ready': { frameId: 'string' },
  search: { inputFile: 'string' }, 'resume-search': { inputFile: 'string' },
};
const fail = () => { throw new Error('MANAGED_SEARCH_INVALID_INPUT'); };

function parse(argv) {
  const [operation, ...flags] = argv;
  if (!Object.hasOwn(commands, operation) || flags.length % 2) fail();
  const spec = commands[operation], args = {};
  for (let index = 0; index < flags.length; index += 2) {
    const field = flags[index].slice(2), value = flags[index + 1];
    if (!flags[index].startsWith('--') || !Object.hasOwn(spec, field) || Object.hasOwn(args, field) || !value) fail();
    const number = spec[field].startsWith('number');
    if (number && (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))) fail();
    args[field] = number ? Number(value) : value;
  }
  for (const [field, type] of Object.entries(spec)) if (!type.endsWith('?') && !Object.hasOwn(args, field)) fail();
  if (operation === 'submit' && Object.hasOwn(args, 'x') !== Object.hasOwn(args, 'y')) fail();
  if (args.target && !Object.hasOwn(targets, args.target)) fail();
  // Enter always uses the host's paced submission, even for a follow-up.
  if (operation === 'key' && !['Tab','Shift+Tab','Escape','Backspace','Delete','Home','End','PageUp','PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Control+A','Meta+A'].includes(args.key)) fail();
  return { operation, args };
}

async function queryFromFile(file, hostUrl) {
  if (!path.isAbsolute(file)) fail();
  // Read a private regular JSON file through the host's own path/ACL checks.
  // Only its path is sent in argv. The question never appears in diagnostics.
  const { readPrivateJsonFile } = await import(new URL('trelio-workspace.mjs', hostUrl));
  const input = await readPrivateJsonFile(file, { maximumBytes: 24_576, fatalUtf8: true }).catch(fail);
  if (!input || Object.keys(input).length !== 1 || typeof input.text !== 'string'
    || !input.text.trim() || input.text.length > 4000) fail();
  return input.text;
}

export async function run(argv, env = process.env) {
  // First-time account discovery is structural. It cannot open Chromium or
  // inspect a native profile, including when another client already has one.
  if (argv.length === 1 && argv[0] === '__trelio_accounts_import') return { schemaVersion: 1, accounts: [] };
  if (argv.length === 1 && argv[0] === 'commands') return { schemaVersion: 1, commands };
  let { operation, args } = parse(argv);
  if (operation === 'doctor') return { schemaVersion: 1,
    hostVisualAvailable: Boolean(env.TRELIO_VISUAL_SESSION_MODULE_URL), minimumHostVersion: MINIMUM_HOST_VERSION };
  const hostUrl = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank');
  if (hostUrl.protocol !== 'file:' || env.TRELIO_SKILL_ID !== SKILL_ID) throw new Error('MANAGED_SEARCH_HOST_REQUIRED');
  const host = await import(hostUrl);
  if (host.VISUAL_PRESENTATION_API !== 'trelio.visual-presentation/v1'
    || host.VISUAL_EXTERNAL_NAVIGATION_API !== 'trelio.visual-external-navigation/v1'
    || host.VISUAL_SEMANTIC_CONTROLS_API !== 'trelio.visual-semantic-controls/v1'
    || typeof host.runVisualSession !== 'function') throw new Error('MANAGED_SEARCH_HOST_UPGRADE_REQUIRED');
  if (operation === 'open' || operation === 'setup') {
    const target = args.target || 'chat';
    const url = new URL(targets[target]);
    if (args.inputFile) {
      if (target !== 'search') fail();
      url.searchParams.set('text', await queryFromFile(args.inputFile, hostUrl));
    }
    args = { url: url.href };
    if (operation === 'open') operation = 'navigate';
  } else if (operation === 'open-source' || operation === 'return-to-chat') {
    const url = new URL(args.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048) fail();
    if (operation === 'return-to-chat' && !origins.includes(url.origin)) fail();
    operation = 'navigate';
    args = { url: url.href };
  } else if (operation === 'type-text') {
    args = { frameId: args.frameId, text: await queryFromFile(args.inputFile, hostUrl) };
  } else if (operation === 'submit') {
    args = Object.hasOwn(args, 'x') ? { action: 'click', ...args } : { action: 'key', key: 'Enter', ...args };
  } else if (operation === 'answer-ready') {
    operation = 'request-ready';
  } else if (operation === 'search' || operation === 'resume-search') {
    const url = new URL(targets.search);
    url.searchParams.set('text', await queryFromFile(args.inputFile, hostUrl));
    const restore = operation === 'resume-search';
    args = restore ? { url: url.href } : { action: 'navigate', url: url.href };
    operation = restore ? 'navigate' : 'submit';
  }
  // The signed opt-in projects actual visible source links and allows the
  // provider's redirects. Cookies still belong to the listed site origins.
  return host.runVisualSession({ origins, externalNavigation: true, observationMode: 'text',
    presentation: 'hidden', semanticControls: true, referenceRoutes, operation, args, env });
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(JSON.stringify(await run(process.argv.slice(2))) + '\n'); }
  catch (error) {
    // Unknown native failures may contain private page data. Keep a closed
    // diagnostic vocabulary and never retry an input from the CLI.
    const safe = ['MANAGED_SEARCH_INVALID_INPUT', 'MANAGED_SEARCH_HOST_REQUIRED', 'MANAGED_SEARCH_HOST_UPGRADE_REQUIRED'];
    process.stdout.write(JSON.stringify({ schemaVersion: 1, state: 'error',
      code: safe.includes(error.message) ? error.message : 'MANAGED_SEARCH_RUNTIME_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
