import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export function stateDirectory() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Trelio', 'audio-transcription');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Trelio', 'audio-transcription');
  const base = process.env.XDG_DATA_HOME;
  return path.join(base && path.isAbsolute(base) ? base : path.join(os.homedir(), '.local', 'share'), 'trelio', 'audio-transcription');
}

export function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  // Refuse link redirection at each existing ancestor; checking only the leaf
  // would let a writable parent redirect private transcript storage elsewhere.
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor, {throwIfNoEntry: false});
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error('AUDIO_PRIVATE_STORAGE_DENIED');
  }
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = fileURLToPath(new URL('private-storage.ps1', import.meta.url));
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Directory', resolved], {shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000});
    if (result.status !== 0 || !result.stdout?.includes('"privateStorage":true')) throw Error('AUDIO_PRIVATE_STORAGE_DENIED');
  } else {
    fs.mkdirSync(resolved, {recursive: true, mode: 0o700});
    const stat = fs.lstatSync(resolved);
    if (stat.uid !== process.getuid()) throw Error('AUDIO_PRIVATE_STORAGE_DENIED');
    fs.chmodSync(resolved, 0o700);
  }
  return resolved;
}

export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, {force: true}); }
}

export function readJson(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error('AUDIO_STATE_INVALID');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
