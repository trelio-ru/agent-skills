// Synthetic acceptance worker, excluded from the signed package. The complete
// browser stays on a fulfilled fixture origin; no account, QR, or user profile
// is opened. Its process ownership and storage are the production components.
import { guardianRequest } from '../scripts/worker-stdio.mjs';
import './http-host-fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { guardianConfig, RuntimeError } from '../scripts/core.mjs';
import { browserProfile, launchProfileBrowser, readBrowserState, writeBrowserState } from '../scripts/profile.mjs';
import { atomicWrite } from '../scripts/native.mjs';
import { WhatsAppBrowser } from '../scripts/browser.mjs';

const lines = readline.createInterface({ input: process.stdin });
const first = new Promise(resolve => lines.once('line', line => resolve(guardianConfig(line))));
const pending = new Map();
let sequence = 0, config, owned, client, closing = false, stage = 'profile';
async function advance(next) {
  stage = next;
  // The synthetic fixture exposes only a fixed stage name. This lets the
  // native Windows acceptance identify a stuck step without browser output.
  await fs.writeFile(path.join(config.directory, 'stage.txt'), next, { mode: 0o600 });
}
lines.on('line', line => { try { const packet = JSON.parse(line); if (packet.ok) pending.get(packet.id)?.(); } catch {} });
async function permit(op = 'permit', extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new RuntimeError('guardian_unavailable')); }, 2000);
    pending.set(id, () => { pending.delete(id); clearTimeout(timer); resolve(); });
    guardianRequest(op, id, extra.pid);
  });
}
async function close() {
  if (closing) return;
  closing = true;
  client?.close(); await owned?.server.close(); process.exit(0);
}
lines.on('close', () => { void close(); });
try {
  config = await first;
  await advance('profile');
  const profile = await browserProfile({ config });
  await advance('browser');
  owned = await launchProfileBrowser({ playwright: { chromium }, profile, permit, headless: config.testMode !== 'write' });
  await owned.context.route('https://web.whatsapp.com/**', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><aside id="pane-side">Synthetic chats</aside><main><input aria-label="Message"></main>' }));
  const saved = await readBrowserState(config);
  client = new WhatsAppBrowser({ context: owned.context, helper: config.helper, permit,
    persist: text => writeBrowserState(config, text), saved: saved ? JSON.parse(saved) : null,
    onPhase: () => {}, onFatal: () => { void close(); } });
  await client.connect();
  await advance('key');
  const result = await client.page.evaluate(async mode => {
    const request = indexedDB.open('synthetic-profile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('private-fixture');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('open failed')); });
    if (mode === 'write') {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const transaction = db.transaction('private-fixture', 'readwrite'); transaction.objectStore('private-fixture').put(key, 'key');
      await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(Error('write failed')); });
    }
    const read = db.transaction('private-fixture').objectStore('private-fixture').get('key');
    const key = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(Error('read failed')); });
    const iv = new Uint8Array(12), plain = new TextEncoder().encode('SYNTHETIC_ONLY');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    db.close();
    return { keyPreserved: key instanceof CryptoKey, extractable: key.extractable, usable: new TextDecoder().decode(decoded) === 'SYNTHETIC_ONLY' };
  }, config.testMode);
  await advance('journal');
  const snapshot = await client.execute({ command: 'browser-snapshot', output: path.join(config.directory, 'snapshot.png') });
  if (config.testMode === 'write') {
    const input = snapshot.controls.find(row => row.label === 'Message');
    const packet = { command: 'browser-type', snapshotId: snapshot.snapshotId, ref: input.ref, text: 'SYNTHETIC_ONLY', requestId: randomUUID() };
    const preview = await client.execute({ ...packet, dryRun: true });
    await client.execute({ ...packet, confirm: true, approvalHash: preview.approvalHash });
    await client.execute({ command: 'policy', mode: 'read-only', confirm: true });
  }
  await client.beforeClose();
  await atomicWrite(path.join(config.directory, 'result.json'), JSON.stringify({ ...result, controls: snapshot.controls.length,
    workerPid: process.pid, browserPid: owned.server.process().pid, profile: profile.path,
    policy: client.data.policy, claimCount: Object.keys(client.data.attempts).length, storage: client.persistenceStatus() }), config.helper);
  await advance('ready');
  if (config.testMode === 'stall') { while (true) {} }
  else if (config.testMode === 'hold') setInterval(() => {}, 1000);
  else await close();
} catch (error) {
  if (config) await fs.writeFile(path.join(config.directory, 'error.json'), JSON.stringify({ failed: true, stage,
    code: error.code || null, launchStage: error.launchStage, systemCode: error.systemCode }), { mode: 0o600 });
  await close();
}
