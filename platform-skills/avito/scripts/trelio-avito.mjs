#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const commands = {
  doctor: {}, setup: {}, 'show-login': {}, status: {}, wait: {}, ready: {}, screenshot: {}, close: {}, disconnect: {},
  'read-text': { query: 'string?', offset: 'number?', includeControls: 'boolean?' },
  'submit-search': { frameId: 'string', x: 'number?', y: 'number?' }, 'search-ready': { frameId: 'string' },
  navigate: { url: 'string' }, click: { frameId: 'string', x: 'number', y: 'number' },
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
    // Text projection and the worker-owned pacing/tab budget require the new
    // signed host before any browser I/O. An older live worker is finished
    // through close; auth storage is reused without reset or re-login.
    accountSelected: Boolean(env.TRELIO_SKILL_ACCOUNT_JSON), minimumHostVersion: '3.10.0',
  };
  const url = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank');
  if (url.protocol !== 'file:' || env.TRELIO_SKILL_ID !== 'avito') throw new Error('AVITO_HOST_REQUIRED');
  const { runVisualSession } = await import(url.href);
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
  return runVisualSession({ observationMode: 'text', origins: ['https://www.avito.ru', 'https://avito.ru'], domains: ['avito.ru'],
    operation: hostOperation, args: operation === 'setup' ? { url: 'https://www.avito.ru/' } : hostArgs, env });
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  try { process.stdout.write(`${JSON.stringify(await runAvito(process.argv.slice(2)))}\n`); }
  catch (error) {
    // Runtime/browser errors may contain URLs, input text or local storage.
    // Never echo a native message/stack or fall back to another implementation.
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, state: 'error', code: ['AVITO_COMMAND_INVALID', 'AVITO_HOST_REQUIRED'].includes(error.message) ? error.message : 'AVITO_RUNTIME_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
