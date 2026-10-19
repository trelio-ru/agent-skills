#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const commands = {
  doctor: {}, setup: {}, status: {}, wait: {}, ready: {}, screenshot: {}, close: {}, disconnect: {},
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
    args[field] = type === 'number' ? Number(flags[i + 1]) : flags[i + 1];
    if (type === 'number' && !Number.isSafeInteger(args[field])) fail();
  }
  for (const [name, type] of Object.entries(commands[operation])) if (!type.endsWith('?') && args[name] === undefined) fail();
  return { operation, args };
}

export async function runAvito(argv, env = process.env) {
  // These value-free commands run before account/native/browser I/O. The skill
  // loader can read all instructions without a configured account or session.
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
    accountSelected: Boolean(env.TRELIO_SKILL_ACCOUNT_JSON), minimumHostVersion: '3.9.0',
  };
  const url = new URL(env.TRELIO_VISUAL_SESSION_MODULE_URL || 'about:blank');
  if (url.protocol !== 'file:' || env.TRELIO_SKILL_ID !== 'avito') throw new Error('AVITO_HOST_REQUIRED');
  const { runVisualSession } = await import(url.href);
  // Domain policy and initial URL belong to this signed provider. The common
  // host owns storage, Chromium, images, frame guards and process lifecycle.
  // There is no alternate transport, local executable override or site script.
  return runVisualSession({ origins: ['https://www.avito.ru', 'https://avito.ru'], domains: ['avito.ru'],
    operation, args: operation === 'setup' ? { url: 'https://www.avito.ru/' } : args, env });
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
