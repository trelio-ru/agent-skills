#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL, VERSION, UUID, identity, configRoot, check, Fault, hash } from './core.mjs';
import { Store } from './storage.mjs';
import { configure } from './setup.mjs';
import { CalendarOperations } from './operations.mjs';

const commands = {
  commands: [], guides: [], doctor: [], configure: [], calendars: [],
  list: ['from','to','calendar'], find: ['from','to','calendar','query'], free: ['from','to','calendar','minutes'],
  read: ['calendar','event'], plan: ['spec'], apply: ['plan','hash','confirm'], reconcile: ['operation'],
  disconnect: ['confirm'], 'recover-lock': ['confirm'], '__trelio_accounts_import': []
};
export function argumentsOf(argv) {
  const [command, ...rest] = argv;
  check(Object.hasOwn(commands, command) && rest.length % 2 === 0, 'command_invalid');
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].startsWith('--') ? rest[index].slice(2) : '';
    check(commands[command].includes(name) && !Object.hasOwn(flags, name) &&
      typeof rest[index+1] === 'string' && rest[index+1].length <= 16000, 'arguments_invalid');
    flags[name] = rest[index+1];
  }
  if (['list','find','free'].includes(command)) check(flags.from && flags.to, 'interval_required');
  if (command === 'find') check(flags.query && flags.query.length <= 500, 'query_required');
  if (command === 'free') check(/^\d{1,4}$/.test(flags.minutes || ''), 'duration_invalid');
  if (command === 'read') check(flags.calendar && flags.event, 'event_reference_required');
  if (command === 'plan') check(flags.spec, 'spec_required');
  if (command === 'reconcile') check(UUID.test(flags.operation || ''), 'operation_invalid');
  if (command === 'apply') check(UUID.test(flags.plan || '') && /^[0-9a-f]{64}$/.test(flags.hash || '') && flags.confirm === 'yes', 'exact_plan_confirmation_required');
  if (['disconnect','recover-lock'].includes(command)) check(flags.confirm === 'yes', 'confirmation_required');
  return { command, flags };
}

async function specFile(file) {
  // Specifications are ordinary event content, never credentials. Refuse links,
  // oversized files and file replacement during read before parsing any plan.
  check(path.isAbsolute(file), 'absolute_spec_path_required');
  check(path.resolve(file) === await fs.realpath(file), 'spec_path_link_denied');
  const handle = await fs.open(file, 'r');
  try {
    const before = await fs.lstat(file);
    const opened = await handle.stat();
    check(before.isFile() && !before.isSymbolicLink() && before.ino === opened.ino && before.dev === opened.dev && before.size <= 65536, 'spec_file_invalid');
    const bytes = await handle.readFile();
    check(bytes.length <= 65536, 'spec_file_invalid');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Fault('spec_json_invalid'); }
  } finally { await handle.close(); }
}
export async function execute(argv, { env = process.env, storeFactory = (root, owner) => new Store(root, owner), operationOptions } = {}) {
  const { command, flags } = argumentsOf(argv);
  if (command === 'commands') return { version: VERSION, commands };
  if (command === 'guides') {
    const file = fileURLToPath(new URL('../references/workflow.md', import.meta.url));
    const bytes = await fs.readFile(file);
    return { requiredFiles: [{ path: file, sizeBytes: bytes.length, sha256: hash(bytes) }], instruction: 'Read this complete native file before provider operations' };
  }
  if (command === '__trelio_accounts_import') {
    check(env.TRELIO_SKILL_ID === SKILL && UUID.test(env.TRELIO_SKILL_COMPANY_ID || '') &&
      UUID.test(env.TRELIO_SKILL_MEMBER_ID || '') && !env.TRELIO_SKILL_ACCOUNT_JSON, 'host_identity_required');
    return { schemaVersion: 1, accounts: [] };
  }
  const owner = identity(env);
  const store = storeFactory(configRoot(env), owner);
  try {
    if (command === 'recover-lock') return await store.recoverLock();
    return await store.lock(async () => {
      const operations = new CalendarOperations(store, operationOptions);
      if (command === 'configure') return configure(store);
      if (command === 'doctor') {
        const state = await store.read();
        if (!state.credentials) return { version: VERSION, availability: 'setup_required', requiredAction: 'configure' };
        const calendars = await operations.calendars();
        return { version: VERSION, availability: 'ready', calendarCount: calendars.length,
          pendingOperations: Object.entries(state.operations).filter(([,value]) => value.state === 'unknown').map(([id]) => id) };
      }
      if (command === 'calendars') return operations.calendars();
      if (['list','find','free'].includes(command)) return operations.list({ from: flags.from, to: flags.to,
        calendarId: flags.calendar, query: flags.query, minutes: flags.minutes });
      if (command === 'read') return operations.read({ calendarId: flags.calendar, eventId: flags.event });
      if (command === 'plan') return operations.plan(await specFile(flags.spec));
      if (command === 'apply') return operations.apply(flags.plan, flags.hash);
      if (command === 'reconcile') return operations.reconcile(flags.operation);
      if (command === 'disconnect') {
        const state = await store.read();
        check(!Object.values(state.operations).some(value => value.state === 'unknown'), 'unknown_write_pending');
        state.credentials = null; state.plans = {}; state.references = {};
        await store.write(state);
        return { disconnected: true };
      }
      throw new Fault('command_invalid');
    });
  } finally { store.close(); }
}
// Node resolves the module URL even if the invocation used a cache path alias.
// Match the physical entrypoint and keep imports free of CLI side effects.
const isDirectInvocation = () => {
  if (!process.argv[1]) return false;
  try {
    return path.relative(realpathSync.native(fileURLToPath(import.meta.url)),
      realpathSync.native(process.argv[1])) === '';
  } catch { return false; }
};
if (isDirectInvocation()) {
  try {
    const result = await execute(process.argv.slice(2));
    const output = JSON.stringify(result);
    check(Buffer.byteLength(output) <= 32000, 'result_too_large_narrow_query');
    process.stdout.write(`${output}\n`);
  } catch (error) {
    // Raw Node/native/HTTP errors may contain URLs, local paths or credentials.
    // Only package-owned closed codes leave this process.
    process.stdout.write(`${JSON.stringify({ state: 'error', code: error instanceof Fault ? error.code : 'calendar_runtime_failed',
      ...(error instanceof Fault && error.code === 'setup_request_denied' &&
        ['form_transport','form_fields'].includes(error.details.stage) ? { stage: error.details.stage } : {}),
      requiredAction: error.code === 'needs_reconnect' ? 'configure' : 'Inspect the exact operation without repeating a write' })}\n`);
    process.exitCode = 1;
  }
}
