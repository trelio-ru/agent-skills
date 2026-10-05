import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnvironment, digest, privateStat, requireThat, RuntimeError } from './core.mjs';

export const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const SAFE_NATIVE_ERRORS = new Set(['native_owner_mismatch', 'native_acl_not_private', 'native_reparse_point',
  'native_job_create_failed', 'native_job_limits_failed', 'native_job_assignment_failed', 'native_browser_not_owned',
  'native_unlock_unavailable', 'native_unlock_cancelled', 'native_unlock_rejected', 'native_unlock_interaction_required',
  'native_unlock_timeout', 'native_unlock_failed', 'native_keychain_auth_failed', 'native_keychain_interaction_required',
  'native_keychain_key_exists', 'native_keychain_key_missing', 'native_keychain_unavailable', 'native_keychain_entitlement_missing',
  'native_keychain_probe_failed', 'native_keychain_acl_failed', 'native_keychain_write_failed', 'native_keychain_read_failed',
  'native_keychain_delete_failed']);
export function runPrivate(executable, args, { input, timeout = 120000, limit = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let chunks = [], length = 0, settled = false, diagnostic = '';
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const fail = () => { child.kill(); finish(new RuntimeError('native_operation_failed')); };
    const timer = setTimeout(fail, timeout);
    child.on('error', fail); child.stdin.on('error', fail);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > limit) fail(); else chunks.push(chunk); });
    // Only a fixed native error vocabulary may cross this pipe. Compiler errors,
    // OS exception messages, paths and any unexpected credential data are dropped.
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(0, 512); });
    child.on('close', code => {
      const result = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0); chunks = [];
      if (code === 0) finish(null, result); else { result.fill(0);
        finish(new RuntimeError(SAFE_NATIVE_ERRORS.has(diagnostic.trim()) ? diagnostic.trim() : 'native_operation_failed')); }
    });
    child.stdin.end(input);
  });
}
async function present(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

export async function nativeHelper(root) {
  requireThat(['darwin', 'win32'].includes(process.platform), 'unsupported_platform');
  const source = path.join(SOURCE, process.platform === 'darwin' ? 'native-macos.swift' : 'native-windows.cs');
  const hash = digest(Buffer.concat([await fs.readFile(source), Buffer.from(process.arch)]));
  const cacheParent = path.join(root, 'runtimes', 'gosuslugi', 'native');
  await fs.mkdir(cacheParent, { recursive: true, mode: 0o700 });
  const cache = path.join(cacheParent, hash);
  if (!await present(cache)) {
    if (process.platform === 'win32') {
      const windows = process.env.SystemRoot || process.env.SYSTEMROOT;
      requireThat(windows && path.isAbsolute(windows), 'windows_system_root_required');
      // A fresh Windows installation defaults to Restricted. This one script
      // is part of the host-verified package and accepts only a directory path;
      // scope execution to this process instead of changing user/machine policy
      // or relying on a hosted CI image's permissive setting. Group Policy
      // still takes precedence and native owner/DACL verification remains.
      await runPrivate(path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SOURCE, 'private-directory.ps1'), cache]);
    } else await fs.mkdir(cache, { mode: 0o700 });
  }
  await privateStat(cache, true);
  // LocalAuthentication identifies this standalone macOS caller by its actual
  // executable name. Keep the system prompt attributable to Trelio; changing
  // only localizedReason would still display the ambiguous name "native".
  const executable = path.join(cache, process.platform === 'win32' ? 'native.exe' : 'Trelio');
  if (!await present(executable)) {
    const candidate = `${executable}.${process.pid}.build`;
    try {
      if (process.platform === 'darwin') {
        await runPrivate('/usr/bin/swiftc', ['-O', '-o', candidate, source], { timeout: 120000 });
      } else {
        const windows = process.env.SystemRoot || process.env.SYSTEMROOT;
        const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
        await runPrivate(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', '/codepage:65001',
          '/r:System.Security.dll', '/r:System.Web.Extensions.dll', `/out:${candidate}`, source]);
      }
      await fs.chmod(candidate, 0o700); await fs.rename(candidate, executable);
    } finally { await fs.rm(candidate, { force: true }); }
  }
  await privateStat(executable);
  if (process.platform === 'win32') await runPrivate(executable, ['verify-directory', cache]);
  await runPrivate(executable, ['probe']);
  return executable;
}

export async function nativeKeyHelper(root, legacyHelper) {
  if (process.platform !== 'darwin') return legacyHelper;
  const source = path.join(SOURCE, 'native-key-macos.swift');
  const hash = digest(Buffer.concat([await fs.readFile(source), Buffer.from(process.arch)]));
  const cache = path.join(root, 'runtimes', 'gosuslugi', 'native-key-v2', hash);
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  await privateStat(cache, true);
  // This helper owns only the v2 Keychain record. Keeping it separate from the
  // frozen guardian/v1 helper prevents ordinary JS/browser updates from
  // changing the executable identity trusted by either Keychain item.
  const executable = path.join(cache, 'Trelio');
  if (!await present(executable)) {
    const candidate = `${executable}.${process.pid}.build`;
    try {
      await runPrivate('/usr/bin/swiftc', ['-O', '-o', candidate, source], { timeout: 120000 });
      await fs.chmod(candidate, 0o700);
      await fs.rename(candidate, executable);
    } finally { await fs.rm(candidate, { force: true }); }
  }
  await privateStat(executable);
  const result = await runPrivate(executable, ['probe']);
  requireThat(result.toString().trim() === 'macos-keychain-la-title-key-v2', 'native_operation_failed');
  return executable;
}

export async function verifyKeychain(helper) {
  if (process.platform !== 'darwin') return;
  const result = await runPrivate(helper, ['keychain-probe']);
  requireThat(result.toString().trim() === 'ready', 'native_keychain_probe_failed');
}
export async function keychainStatus(helper) {
  if (process.platform !== 'darwin') return { status: 'not_applicable' };
  try { await verifyKeychain(helper); return { status: 'ready' }; }
  catch (error) {
    // A failed value-free preflight must not be reported as a missing bank or
    // portal login. No fallback, credential read, or global lock/unlock occurs.
    return { status: 'action_required', error: error instanceof RuntimeError ? error.code : 'native_keychain_probe_failed' };
  }
}

export async function ensurePrivateDirectory(directory, helper) {
  if (process.platform === 'win32') { await runPrivate(helper, ['private-directory', directory]); return; }
  // Reject existing symlinks instead of following them while creating private
  // children. System /tmp aliases are normalized by the caller in tests.
  let cursor = path.parse(directory).root;
  for (const component of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { await fs.mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(cursor);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_storage');
  }
  await privateStat(directory, true);
}
export async function verifyPrivate(file, helper, directory = false) {
  await privateStat(file, directory);
  if (process.platform === 'win32') await runPrivate(helper, [directory ? 'verify-directory' : 'verify-file', file]);
}
export async function createPrivateFile(file, value, helper) {
  if (process.platform === 'win32') {
    requireThat(helper, 'native_helper_required');
    await runPrivate(helper, ['write-private', file], { input: value, limit: 128 });
  } else {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  }
}
export async function atomicWrite(file, value, helper) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    // On Windows an elevated token can give new files the Administrators owner
    // even in an owner-only directory. Apply the exact SID and DACL at creation,
    // not by repairing existing files or temporarily weakening verification.
    await createPrivateFile(temp, value, helper);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
export function nativeRequestTitleInput(requestTitle) {
  if (requestTitle === undefined || requestTitle === null) return undefined;
  requireThat(typeof requestTitle === 'string' && requestTitle === requestTitle.trim() &&
    Buffer.byteLength(requestTitle, 'utf8') > 0 && Buffer.byteLength(requestTitle, 'utf8') <= 160 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(requestTitle), 'request_title_invalid');
  // The title is explanatory UI, never authority. It is sent only through the
  // private stdin pipe and is not persisted in the lease, vault or Keychain.
  return JSON.stringify({ schema: 1, requestTitle });
}
function decodedNativeKey(encoded) {
  try {
    requireThat(/^[A-Za-z0-9+/]{43}=\r?\n$/.test(encoded.toString()), 'native_key_invalid');
    const key = Buffer.from(encoded.toString().trim(), 'base64'); requireThat(key.length === 32, 'native_key_invalid');
    return key;
  } finally { encoded.fill(0); }
}
async function macKeyStatus(keyHelper, operation, account) {
  const result = await runPrivate(keyHelper, [operation, account]);
  const status = result.toString().trim();
  requireThat(['present', 'missing'].includes(status), 'native_operation_failed');
  return status;
}
export async function vaultKey(helper, keyHelper, directory, account, create = false, requestTitle = null) {
  if (process.platform !== 'darwin') {
    return decodedNativeKey(await runPrivate(helper,
      [create ? 'key-create' : 'key-read', path.join(directory, 'key.dpapi'), account],
      { input: nativeRequestTitleInput(requestTitle) }));
  }
  const status = await macKeyStatus(keyHelper, 'key-status', account);
  if (status === 'present') {
    return decodedNativeKey(await runPrivate(keyHelper, ['key-read', account], {
      input: nativeRequestTitleInput(requestTitle),
    }));
  }
  if (create) {
    return decodedNativeKey(await runPrivate(keyHelper, ['key-create', account], {
      input: nativeRequestTitleInput(requestTitle),
    }));
  }

  // Existing ciphertext with no v2 item can only be opened by the byte-stable
  // v1 helper already trusted by Keychain. That one generic owner confirmation
  // reads the exact old key. The new helper imports it through stdin and never
  // asks Keychain to trust a changed binary for the legacy item.
  const legacyEncoded = await runPrivate(helper, ['key-read', account]);
  const key = decodedNativeKey(legacyEncoded);
  try {
    const input = JSON.stringify({ schema: 1, key: key.toString('base64') });
    await runPrivate(keyHelper, ['key-import', account], { input, limit: 128 });
    return Buffer.from(key);
  } finally { key.fill(0); }
}
export async function deleteVaultKey(helper, keyHelper, directory, account, requestTitle = null) {
  if (process.platform !== 'darwin') {
    await runPrivate(helper, ['key-delete', path.join(directory, 'key.dpapi'), account], {
      input: nativeRequestTitleInput(requestTitle),
    });
    return;
  }
  // Probe both records before mutating either. A migrated installation may
  // require two explicit owner confirmations on the rare `forget` path; normal
  // start/reuse uses only v2 and never touches the legacy item again.
  const [current, legacy] = await Promise.all([
    macKeyStatus(keyHelper, 'key-status', account),
    macKeyStatus(keyHelper, 'legacy-status', account),
  ]);
  if (current === 'present') await runPrivate(keyHelper, ['key-delete', account], {
    input: nativeRequestTitleInput(requestTitle),
  });
  if (legacy === 'present') await runPrivate(helper, ['key-delete', account]);
}
