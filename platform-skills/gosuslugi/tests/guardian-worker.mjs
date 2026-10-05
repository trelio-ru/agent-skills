import readline from 'node:readline';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { guardianConfig } from '../scripts/core.mjs';
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
// The native lease has already started. This deliberate cold-start margin
// proves that worker initialization cannot renew the original deadline.
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
// Freeze the JS thread without burning the VM's only runnable CPU. The worker
// still cannot run cleanup code, so only the independent native guardian can
// reap it, while the guardian and the parent test retain enough CPU to observe
// the deadline reliably on the small ARM64 Windows CI machine.
if (config.mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
lines.on('close', () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} process.exit(0); });
setInterval(() => {}, 1000);
