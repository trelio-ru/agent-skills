import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, Fault, childEnvironment, hash, storagePath } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function privateProcess(executable, args, input = '', timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, ended = false;
    const fail = () => { if (ended) return; ended = true; child.kill(); reject(new Fault('native_storage_unavailable')); };
    const timer = setTimeout(fail, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) fail(); else chunks.push(chunk); });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => {}); child.on('error', fail);
    child.on('close', status => { clearTimeout(timer); if (ended) return; ended = true;
      if (status !== 0) reject(new Fault('native_storage_unavailable')); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(input);
  });
}
function powershell() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  check(root && path.isAbsolute(root), 'native_storage_unavailable');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
async function windows(packet) {
  return privateProcess(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'vault-windows.ps1')], JSON.stringify(packet));
}
export async function privateFile(file, directory = false) {
  const stat = await fs.lstat(file); check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'unsafe_storage');
  if (process.platform === 'win32') await windows({ mode: 'check', path: file });
  else check(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'unsafe_permissions');
  return stat;
}
export async function directory(file) {
  if (process.platform === 'win32') { await windows({ mode: 'directory', path: file }); return; }
  // Check ancestors before mkdir: recursive mkdir alone follows a hostile link.
  let cursor = file; const missing = [];
  for (;;) {
    try { const stat = await fs.lstat(cursor); check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_storage'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(cursor); }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  for (const item of missing.reverse()) await fs.mkdir(item, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateFile(file, true);
}
async function atomic(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    if (process.platform === 'win32') await windows({ mode: 'write', path: temporary, data: Buffer.from(text).toString('base64') });
    else { const handle = await fs.open(temporary, 'wx', 0o600); try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); } }
    // The Windows write helper already verifies the newly created explicit
    // DACL before returning. POSIX creation still needs its mode/owner guard.
    if (process.platform !== 'win32') await privateFile(temporary);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
export class Store {
  constructor(root, owner, { codec } = {}) { this.root = root; this.owner = owner; this.dir = storagePath(root, owner); this.codec = codec; this.key = null; }
  async init(observe = () => {}) {
    // Optional in-process observation exposes only fixed stage numbers. The CLI
    // never supplies it; all native guards still run, including every ancestor.
    const dirs = [this.root, path.join(this.root, 'integrations'), path.join(this.root, 'integrations', 'vk-ads'), path.dirname(this.dir), this.dir];
    if (process.platform === 'win32') {
      // One native invocation checks/creates every level with the same owner,
      // inheritance and reparse guards; no validation result is cached.
      observe('directories-start'); await windows({ mode: 'directories', paths: dirs }); observe('directories-ready'); return;
    }
    for (let index = 0; index < dirs.length; index++) {
      observe(`directory-${index}-start`); await directory(dirs[index]); observe(`directory-${index}-ready`);
    }
  }
  async macKey() {
    if (this.key) return this.key;
    const source = await fs.readFile(path.join(here, 'vault-key.swift'));
    const cache = path.join(this.root, 'native', 'vk-ads'); await directory(cache);
    const binary = path.join(cache, `vault-${hash(source).slice(0, 24)}`);
    try { const stat = await privateFile(binary); check(stat.mode & 0o100, 'unsafe_permissions'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = `${binary}.${crypto.randomUUID()}.tmp`;
      try { await privateProcess('/usr/bin/swiftc', [path.join(here, 'vault-key.swift'), '-o', temporary], '', 120000);
        await fs.chmod(temporary, 0o700); await privateFile(temporary); await fs.rename(temporary, binary); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    this.key = await privateProcess(binary, [], JSON.stringify({ account: this.owner.account }));
    check(this.key.length === 32, 'native_storage_unavailable'); return this.key;
  }
  async seal(value) {
    const plain = Buffer.from(JSON.stringify(value));
    try {
      if (this.codec) return await this.codec.seal(plain);
      if (process.platform === 'win32') return JSON.stringify({ version: 1, dpapi: (await windows({ mode: 'seal', account: this.owner.account, data: plain.toString('base64') })).toString() });
      check(process.platform === 'darwin', 'secure_storage_unsupported');
      const key = await this.macKey(), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`trelio/vk-ads/v1/${this.owner.account}`));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    } finally { plain.fill(0); }
  }
  async open(text) {
    let plain;
    try {
      if (this.codec) plain = await this.codec.open(text);
      else {
        const envelope = JSON.parse(text); check(envelope.version === 1, 'vault_invalid');
        if (process.platform === 'win32') plain = Buffer.from((await windows({ mode: 'open', account: this.owner.account, data: envelope.dpapi })).toString(), 'base64');
        else { check(process.platform === 'darwin', 'secure_storage_unsupported');
          const decipher = crypto.createDecipheriv('aes-256-gcm', await this.macKey(), Buffer.from(envelope.iv, 'base64'));
          decipher.setAAD(Buffer.from(`trelio/vk-ads/v1/${this.owner.account}`)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
          plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]); }
      }
      return JSON.parse(plain.toString('utf8'));
    } catch (error) { throw error instanceof Fault ? error : new Fault('vault_corrupt_or_wrong_identity'); }
    finally { plain?.fill(0); }
  }
  async read() {
    const file = path.join(this.dir, 'state.enc');
    try { const stat = await privateFile(file); check(stat.size <= 4 * 1024 * 1024, 'vault_too_large'); return await this.open(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, credentials: null, plans: {}, operations: {}, setup: null }; throw error; }
  }
  async write(value) { const text = await this.seal(value); check(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'vault_too_large'); await atomic(path.join(this.dir, 'state.enc'), text); }
  async lock(action) {
    await this.init(); const file = path.join(this.dir, 'lock'); let handle;
    // Crashed locks are intentionally not auto-deleted: the protected operation
    // may already be in flight. An explicit recovery checks the receipt first.
    try {
      if (process.platform === 'win32') await windows({ mode: 'write', path: file, data: Buffer.from(JSON.stringify({ pid: process.pid })).toString('base64') });
      else { handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
    } catch (error) {
      if (await fs.lstat(file).then(() => true, () => false)) throw new Fault('account_busy_or_recovery_required');
      throw error;
    }
    try { return await action(); }
    finally { await handle?.close(); await fs.rm(file, { force: true }); }
  }
  async recoverLock() {
    const file = path.join(this.dir, 'lock'); await privateFile(file);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    check(Number.isInteger(record.pid) && record.pid > 0, 'lock_invalid');
    try { process.kill(record.pid, 0); throw new Fault('account_process_alive'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // Preserve all receipts before clearing a dead process lock. Recovery is
    // cleanup only and never retries an unknown advertising mutation.
    await this.read(); await fs.rm(file); return { recovered: true, replayed: false };
  }
  close() { this.key?.fill(0); this.key = null; }
}
