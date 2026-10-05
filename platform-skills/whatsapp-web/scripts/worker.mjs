import { guardianRequest } from './worker-stdio.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { decryptRecord, encryptRecord, guardianConfig, identityKey, LEASE_MS, requireThat, RuntimeError, serviceHttpFailure } from './core.mjs';
import { atomicWrite, deleteVaultKey, vaultKey, verifyPrivate } from './native.mjs';
import { dependencies, launchOwnedBrowser } from './dependencies.mjs';
import { WhatsAppClient } from './client.mjs';
import { WhatsAppBrowser } from './browser.mjs';
import { browserProfile, browserStorage, forgetBrowserState, launchProfileBrowser, readBrowserState, writeBrowserState } from './profile.mjs';
import { boundedJson, createHandoff } from './handoff.mjs';

// This detached process owns either the protocol vault or the ordinary browser
// profile. The native supervisor controls lifetime in both cases; CLI invocations
// never receive protocol keys, Playwright endpoints, or login values.
const lines = readline.createInterface({ input: process.stdin });
const first = new Promise(resolve => lines.once('line', resolve));
let sequence = 0; const pending = new Map();
lines.on('line', line => {
  try { const packet = JSON.parse(line); if (packet.ok === true && Number.isInteger(packet.id)) {
    pending.get(packet.id)?.resolve(); pending.delete(packet.id);
  } } catch {}
});
async function permit(op = 'permit', extra = {}) {
  requireThat(!stopping, 'session_closed');
  requireThat(!config || Date.now() < config.expiresAt, 'session_expired');
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new RuntimeError('guardian_unavailable')); void stop(); }, 2000);
    pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject });
    guardianRequest(op, id, extra.pid);
  });
}
let stopping = false, stopStarted = false, config, server, owned, handoff, handoffContext, client, key, phase = 'starting';
let busy = false, finalError = null, finalHttpFailure = {}, writes = Promise.resolve();
const token = crypto.randomBytes(32).toString('hex');
const state = () => ({ sessionId: config.leaseId, phase, mode:config.transport||'protocol', expiresAt: config.expiresAt,
  ...(config.transport==='browser'?{headless:config.headless===true}:{}),
  requiredAction: ({ opening_secure_store: 'Открываем сохранённое подключение.',
    opening_browser_profile: 'Открываем локальный профиль браузера.',
    qr_required: 'Отсканируйте QR-код в открытом локальном окне через WhatsApp → Связанные устройства.',
    qr_refreshing: 'Запрашиваем новый QR-код в том же окне.',
    browser_login_required: 'В открытом WhatsApp Web привяжите браузер через QR на телефоне. Агент не читает экран входа. Браузер имеет отдельную сессию; открытие чатов может помечать их прочитанными.',
    browser_headed_login_required: 'WhatsApp требует входа. Остановите эту headless-сессию и запустите browser без --headless для ручной привязки в видимом окне.',
    relink_required: 'WhatsApp отозвал привязку. Нужна новая явная настройка.',
    disconnected: 'Связь не восстановлена после ограниченных повторов; сессия не удалена.' })[phase] || null,
  ...(finalError ? { error: finalError, ...serviceHttpFailure({ ...finalHttpFailure, code: finalError }) } : {}),
  ...(client?.persistenceStatus ? {browserStorage:client.persistenceStatus()} : {}) });
async function setPhase(next) {
  phase = next;
  await atomicWrite(path.join(config.directory, 'status.json'), JSON.stringify(state()), config.helper);
  if (next === 'ready') handoff?.ready();
}
async function save(serialized) {
  // Browser claims are a plain local journal; protocol keys remain encrypted.
  // Capture the snapshot before queueing so concurrent events cannot replace a
  // newer durable state with a late older snapshot in either storage mode.
  const browser = config.transport === 'browser';
  const encrypted = browser ? null : encryptRecord(key, config.vaultIdentity, { schema: 1, serialized });
  const allowed = permit();
  // Reserve order synchronously, before awaiting native IPC. Even an earlier
  // snapshot whose permit arrives late cannot overwrite a newer snapshot.
  allowed.catch(() => {});
  const writing = writes.then(async () => {
    await allowed;
    if (browser) await writeBrowserState(config, serialized);
    else await atomicWrite(path.join(config.vaultDirectory, 'session.json'), encrypted, config.helper);
  });
  writes = writing; return writing;
}
async function showQr(value, isCurrent = () => true) {
  await permit();
  if (!isCurrent()) return;
  if (!owned) {
    const libs = await dependencies(config.root);
    owned = await launchOwnedBrowser({ playwright: libs.playwright, permit, channel: config.channel });
    owned.server.on('close', () => { if (!stopping && !client?.connected) void stop(); });
    handoffContext = await owned.browser.newContext({ viewport: null, acceptDownloads: false, serviceWorkers: 'block' });
    const page = await handoffContext.newPage();
    handoff = await createHandoff({ qrcode: libs.qrcode, remainingMs: config.expiresAt-Date.now(),
      open: url => page.goto(url, {waitUntil:'domcontentloaded'}),
      onRefresh: () => client.refreshQr(),
      onCancel: code => { finalError=code; void stop(); } });
    page.on('close', () => { if (!client?.connected) void stop(); });
    await page.bringToFront();
  }
  if (isCurrent()) handoff.update(value);
}
async function initialize() {
  if (config.transport === 'browser') {
    await permit(); await setPhase('opening_browser_profile');
    if (config.mode === 'forget') {
      await forgetBrowserState(config); await setPhase('forgotten'); return stop();
    }
    // Version 2 starts with a fresh browser binding. It deliberately never
    // decrypts, copies, or removes the previous encrypted browser store.
    const saved = await readBrowserState(config);
    const browserData = saved ? JSON.parse(saved) : null;
    requireThat(!browserData || browserData.schema === 2 && browserData.transport === 'browser', 'browser_state_invalid');
    requireThat(!config.headless || browserData?.wasAuthenticated === true, 'headed_login_required');
    if (config.headless) await verifyPrivate(browserStorage(config.directory).profile, config.helper, true);
    const libs = await dependencies(config.root);
    const profile = await browserProfile({ config });
    owned = await launchProfileBrowser({ playwright: libs.playwright, profile, permit, channel: config.channel, headless: config.headless === true });
    owned.server.on('close', () => { if (!stopping) void stop(); });
    client = new WhatsAppBrowser({ context: owned.context, permit, persist: save, helper: config.helper, saved: browserData,
      onPhase: value => { void setPhase(value === 'browser_login_required' && config.headless ? 'browser_headed_login_required' : value).catch(() => stop()); },
      onFatal: error => { finalError = error instanceof RuntimeError ? error.code : error; finalHttpFailure = serviceHttpFailure(error); void stop(); } });
    await setPhase('connecting'); await client.connect(); return;
  }
  await permit(); await setPhase('opening_secure_store');
  const vault = path.join(config.vaultDirectory, 'session.json'); let exists=false, saved=null;
  try { await verifyPrivate(vault,config.helper); requireThat((await fs.stat(vault)).size<48*1024*1024,'vault_too_large'); exists=true; }
  catch(e) { if(e.code!=='ENOENT')throw e; }
  if(config.mode==='forget') {
    await deleteVaultKey(config.helper,config.vaultDirectory,identityKey(config.vaultIdentity));
    await fs.rm(vault,{force:true}); await setPhase('forgotten'); return stop();
  }
  key=await vaultKey(config.helper,config.vaultDirectory,identityKey(config.vaultIdentity),!exists); await permit();
  if(exists) { const record=decryptRecord(key,config.vaultIdentity,await fs.readFile(vault,'utf8'));
    requireThat(record.schema===1 && (record.serialized===null || typeof record.serialized==='string'),'vault_schema_invalid'); saved=record.serialized; }
  else await save(null);
  const libs=await dependencies(config.root);
  client=new WhatsAppClient({ ...libs, saved, permit, persist:save, onQr:showQr,
    onPhase:value=>{void setPhase(value).catch(()=>stop());},
    onFatal:code=>{ finalError=code; void stop(); } });
  await setPhase('connecting'); await client.connect();
}
async function stop() {
  if (stopStarted) return; stopStarted = true;
  // Flush the journal and Chromium's persistent profile before ending the
  // worker. The original native deadline still bounds this cleanup.
  const hardExit=setTimeout(()=>process.exit(1),config?.transport==='browser'?15000:2000);hardExit.unref();
  await client?.beforeClose?.().catch(()=>{});
  stopping = true;
  // Native guardian is the hard fallback; a hung browser close cannot prolong
  // shutdown. Killing the worker closes its pipe and makes the guardian reap
  // its owned browser group / Windows Job.
  server?.close(); server?.closeAllConnections();
  handoff?.close(); client?.close();
  // Drain queued Signal/browser journal writes before clean exit. The native
  // deadline still bounds this wait if storage is stalled.
  await writes.catch(() => {});
  key?.fill(0); key = null;
  await owned?.server.close().catch(() => {});
  await owned?.browser.close().catch(() => {});
  if (config) {
    // Only disposable control records are removed. Browser data and its action
    // journal remain in their ordinary directory for the next session.
    for (const name of ['control.json', 'lease.json']) {
      const file = path.join(config.directory, name);
      try { if (JSON.parse(await fs.readFile(file, 'utf8')).leaseId === config.leaseId) await fs.rm(file); } catch {}
    }
    if (phase !== 'forgotten') { phase = 'closed'; await setPhase(phase).catch(() => {}); }
  }
  process.exit(0);
}
lines.on('close', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
process.on('uncaughtException', () => { finalError='worker_uncaught_exception'; void stop(); }); process.on('unhandledRejection', () => { finalError='worker_unhandled_rejection'; void stop(); });

try {
  config = guardianConfig(await first);
  requireThat(config.expiresAt > Date.now() && config.expiresAt - config.startedAt === LEASE_MS &&
    config.expiresAt - Date.now() <= LEASE_MS && path.isAbsolute(config.directory), 'guardian_config_invalid');
  requireThat(!config.transport||['protocol','browser'].includes(config.transport),'guardian_config_invalid');
  config.vaultDirectory = config.directory;
  config.vaultIdentity = config.identity;
  await permit();
  server = http.createServer(async (req, res) => {
    const respond = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      // Browser JS cannot invoke the command plane: no CORS, no Origin and an
      // owner-only random bearer required. The bearer is never a provider token.
      requireThat(req.socket.remoteAddress === '127.0.0.1' && req.socket.localAddress === '127.0.0.1' &&
        req.headers.host === `127.0.0.1:${server.address().port}` && !req.headers.origin &&
        req.headers.authorization === `Bearer ${token}` && req.method === 'POST' && req.url === '/', 'control_rejected');
      await permit(); const packet = await boundedJson(req, 65536);
      requireThat(packet.sessionId === config.leaseId, 'session_mismatch');
      if (packet.command === 'status') { respond(200, state()); return; }
      if (packet.command === 'stop') { respond(200, { ...state(), phase: 'closing' }); setImmediate(() => { void stop(); }); return; }
      requireThat(!busy && !stopStarted && client && (phase === 'ready' || ['policy','result','history-status'].includes(packet.command)), 'session_not_ready'); busy=true;
      try { respond(200, await client.execute(packet)); }
      finally { busy=false; }
    } catch (error) { respond(400, { error: error instanceof RuntimeError ? error.code : 'operation_result_unknown', ...serviceHttpFailure(error) }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on('connection', socket => socket.setTimeout(45000, () => socket.destroy()));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await atomicWrite(path.join(config.directory, 'control.json'), JSON.stringify({ leaseId: config.leaseId, port: server.address().port, token }), config.helper);
  await setPhase('starting');
  void initialize().catch(async error => {
    finalError = error instanceof RuntimeError ? error.code : 'initialization_failed';
    finalHttpFailure = serviceHttpFailure(error);
    await setPhase('failed').catch(() => {}); await stop();
  });
} catch { await stop(); }
