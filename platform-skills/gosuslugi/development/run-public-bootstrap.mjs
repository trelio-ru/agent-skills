import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configRoot, childEnvironment } from '../scripts/core.mjs';
import { nativeHelper } from '../scripts/native.mjs';

// Source-only maintainer probe of the fixed anonymous entrypoint. There are no
// identity, URL, credential or session overrides: this never opens the vault.
// The native guardian owns an empty headed browser and limits it to one minute.
const root = configRoot();
const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gosuslugi-public-probe-'));
const file = path.join(directory, 'result.json');
try {
  const helper = await nativeHelper(root);
  const child = spawn(helper, ['guard', process.execPath,
    fileURLToPath(new URL('probe-public-bootstrap.mjs', import.meta.url)), '60000'],
  { detached: true, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify({ root, file })}\n`);
  await exited;
  const result = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(result) > 65536) throw Error('public_probe_result_too_large');
  process.stdout.write(`${result}\n`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
