import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { childEnvironment, digest, requireThat, RuntimeError } from './core.mjs';
import { runPrivate, SOURCE } from './native.mjs';

// The signed package carries the complete lockfile. Bootstrap installs that
// exact graph with lifecycle scripts disabled; it never resolves a new latest.
export async function dependencyRoot(root) {
  const lock = await fs.readFile(path.join(SOURCE, '../package-lock.json'));
  return path.join(root, 'runtimes', 'whatsapp-web', digest(lock));
}
export async function dependencies(root) {
  const base = await dependencyRoot(root), require = createRequire(path.join(base, 'entry.cjs'));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(SOURCE, '../package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const file = path.join(base, 'node_modules', ...name.split('/'), 'package.json');
      requireThat(JSON.parse(await fs.readFile(file, 'utf8')).version === version, 'bootstrap_required');
    }
    return { sdk: await import(pathToFileURL(require.resolve('@whiskeysockets/baileys')).href),
      qrcode: require('qrcode'), pino: require('pino'), playwright: require('playwright-core') };
  } catch { throw new RuntimeError('bootstrap_required'); }
}
export async function bootstrap(root) {
  const base = await dependencyRoot(root);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(SOURCE, '..', name), path.join(base, name));
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'npm'))];
  let npm;
  for (const candidate of candidates) {
    try { const resolved = await fs.realpath(candidate); if (path.basename(resolved) === 'npm-cli.js') { npm = resolved; break; } } catch {}
  }
  requireThat(npm, 'standalone_node_npm_required');
  await runPrivate(process.execPath, [npm, 'ci', '--prefix', base, '--ignore-scripts', '--no-audit', '--no-fund'], { timeout: 120000, limit: 262144 });
  await dependencies(root);
}
export async function launchOwnedBrowser({ playwright, permit, channel = process.platform === 'win32' ? 'msedge' : 'chrome' }) {
  const server = await playwright.chromium.launchServer({ channel, headless: false, timeout: 30000,
    env: childEnvironment(), args: ['--disable-breakpad', '--disable-crash-reporter'] });
  try {
    await permit('own', { pid: server.process().pid });
    return { server, browser: await playwright.chromium.connect(server.wsEndpoint()) };
  } catch { await server.kill().catch(() => {}); throw new RuntimeError('browser_ownership_failed'); }
}
