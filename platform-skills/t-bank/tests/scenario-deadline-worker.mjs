import fs from 'node:fs/promises';
import readline from 'node:readline';
import { loadPlaywright, launchOwnedBrowser } from '../scripts/browser.mjs';
import { guardianConfig } from '../scripts/core.mjs';
import { compileScenario, executeScenario } from '../scripts/scenario.mjs';

// No vault, provider URL or credentials: only a native-owned blank browser.
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
const waiting = new Map(); let sequence = 0;
lines.on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(); waiting.delete(packet.id); });
const permit = async (op = 'permit', extra = {}) => {
  const id = ++sequence, ack = new Promise(resolve => waiting.set(id, resolve));
  process.stdout.write(`${JSON.stringify({ id, op, ...extra })}\n`); await ack;
};
const owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit });
const context = await owned.browser.newContext(), page = await context.newPage();
await permit();
await fs.writeFile(config.file, JSON.stringify({ browser: owned.server.process().pid, worker: process.pid }), { mode: 0o600 });
// A JS timeout cannot stop this program. The production native guardian must
// close both the executing worker and the actual browser at its own deadline.
await executeScenario(compileScenario('while (true) {}'), { context, page });
