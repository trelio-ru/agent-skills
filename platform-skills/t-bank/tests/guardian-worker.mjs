import readline from 'node:readline';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { guardianConfig } from '../scripts/core.mjs';
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
// Exercise a cold start longer than the old 1.4-second fixture budget on every
// OS. The native lease is already running; this wait must never renew it.
if (config.slowStart) await new Promise(resolve => setTimeout(resolve, 2000));
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
const ack = new Promise(resolve => lines.once('line', resolve));
process.stdout.write(`${JSON.stringify({ id: 1, op: 'own', pid: child.pid })}\n`);
await ack;
// Publish completion atomically: an existence check must never observe the
// short interval between file creation and the first write of PID metadata.
await fs.writeFile(`${config.file}.partial`, JSON.stringify({ worker: process.pid, child: child.pid }), { mode: 0o600 });
await fs.rename(`${config.file}.partial`, config.file);
if (config.mode === 'crash') process.exit(1);
// Freeze the JS thread without monopolizing the Windows CI machine's only CPU.
// The process still cannot run cleanup code, so only the independent native
// guardian can reap it.
if (config.mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
lines.on('close', () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} process.exit(0); });
setInterval(() => {}, 1000);
