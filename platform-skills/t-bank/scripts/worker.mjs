import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { decryptRecord, encryptRecord, guardianConfig, identityKey, LEASE_MS, normalizeCredentials, requireThat, RuntimeError, serviceHttpFailure } from './core.mjs';
import { atomicWrite, deleteVaultKey, vaultKey, verifyPrivate } from './native.mjs';
import { loadPlaywright, launchOwnedBrowser, Portal } from './browser.mjs';
import { boundedJson, createPrompt } from './prompt.mjs';
import { compileScenario, executeScenario } from './scenario.mjs';
import { newBackgroundContext } from './windows.mjs';
import { TIdAuthorizer } from './t-id-authorizer.mjs';

const SAFE_AUTH_PHASE_REASONS = new Set([
  'provider_rejected_credentials',
  'consent_required',
  'security_challenge',
  'manual_code_required',
  'totp_not_configured',
  'totp_result_unresolved',
  'unknown_auth_screen',
  'auth_timeout',
]);

// Only this detached, native-supervised process opens the encrypted record.
// In delegated T‑ID mode, bounded credential values also cross the private
// caller broker in RAM; CLI/MCP and the agent never receive them.
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
    process.stdout.write(`${JSON.stringify({ op, id, ...extra })}\n`);
  });
}
let stopping = false, config, server, owned, portal, localPage, localContext, prompt, key, record, phase = 'starting';
let phaseReason = null;
let busy = false, finalError = null, finalHttpFailure = {};
const token = crypto.randomBytes(32).toString('hex');
const state = () => ({ sessionId: config.leaseId, phase, expiresAt: config.expiresAt,
  ...(config.authorization ? {
    authorization: {
      origin: config.authorization.origin,
      browserSessionId: config.authorization.sessionId,
    },
  } : {}),
  ...(phaseReason ? { reason: phaseReason } : {}),
  requiredAction: ({ unlock_required: 'Подтвердите разблокировку в системном окне.', credentials_required: 'Переключитесь на локальную страницу Т-Банка и введите данные. Окно открыто в фоне.',
    code_required: 'Переключитесь на уже открытое окно Т‑Банка и подтвердите код. Вход продолжится автоматически.',
    user_required: config.authorization
      ? 'Продолжите код, проверку или выбор передаваемых данных в уже открытом окне T‑ID, затем вызовите resume.'
      : 'Продолжите ручную проверку в том же окне Т‑Банка, затем вызовите resume.',
    failed: 'Операция остановлена. Проверьте безопасный код ошибки, не повторяйте отправку автоматически.' })[phase] || null,
  ...(finalError ? { error: finalError, ...serviceHttpFailure({ ...finalHttpFailure, code: finalError }) } : {}) });
async function setPhase(next, reason = null) {
  phase = next;
  // Only fixed control-flow reasons may leave the private worker. They explain
  // why T-ID stopped without exposing headings, DOM, credentials or OTP data.
  phaseReason = next === 'user_required' && SAFE_AUTH_PHASE_REASONS.has(reason) ? reason : null;
  await atomicWrite(path.join(config.directory, 'status.json'), JSON.stringify(state()), config.helper);
}
async function save(storage = record.storage) {
  await permit();
  const next = { schema: 1, credentials: record.credentials, storage };
  const encrypted = encryptRecord(key, config.identity, next);
  await atomicWrite(path.join(config.directory, 'vault.json'), encrypted, config.helper); record = next;
}
async function closePrompt() {
  prompt?.close(); prompt = null;
  await localContext?.close().catch(() => {}); localPage = null; localContext = null;
}
async function input(kind) {
  await permit();
  if (!prompt) {
    localContext = await newBackgroundContext(owned.browser, { viewport: null, acceptDownloads: false, serviceWorkers: 'block' });
    localPage = await localContext.newPage();
    prompt = await createPrompt({ open: url => localPage.goto(url, { waitUntil: 'domcontentloaded' }),
      timeoutMs: Math.min(300000, config.expiresAt - Date.now()), deadlineMs: config.expiresAt - Date.now(),
      onCancel: code => { finalError = code; void stop(); } });
    localPage.on('close', () => { if (prompt) void stop(); });
  }
  // Human input is reported in status; it does not authorize activation.
  // Only an explicit show request may bring this existing window forward.
  return prompt.ask(kind);
}
async function authenticate() {
  requireThat(!busy && portal && record, 'session_busy'); busy = true;
  try {
    const ready = await portal.authenticate(record.credentials);
    if (ready) {
      await closePrompt();
      if (config.authorization) await stop();
    }
  } catch (error) {
    // Closing the browser after local cancel/expiry rejects in-flight
    // Playwright operations. Preserve the original safe cause instead of
    // replacing it with a misleading unknown provider failure during cleanup.
    if (stopping) return;
    finalError = error instanceof RuntimeError ? error.code : 'provider_result_unknown';
    finalHttpFailure = serviceHttpFailure(error);
    await setPhase(finalError === 'service_http_error' ? 'failed' : 'user_required'); await closePrompt();
    if (finalError === 'service_http_error') await stop();
  } finally { busy = false; }
}
async function initialize() {
  await permit(); await setPhase(config.authorization ? 'authorization_check' : 'unlock_required');
  const vault = path.join(config.directory, 'vault.json');
  let exists = false;
  try {
    await verifyPrivate(vault, config.helper);
    requireThat((await fs.stat(vault)).size < 6 * 1024 * 1024, 'vault_too_large'); exists = true;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (config.mode === 'forget') {
    // Deleting the exact local key is crypto-erasure, not a provider logout.
    // No browser or source/legacy credential file is opened for this operation.
    await deleteVaultKey(config.helper, config.keyHelper, config.directory,
      identityKey(config.identity), config.requestTitle);
    await fs.rm(vault, { force: true }); await setPhase('forgotten'); return stop();
  }
  if (config.authorization) {
    // Claim the exact observed OAuth request and prove its native callback
    // before opening the bank vault. Fast SSO can therefore finish without a
    // Keychain/DPAPI read, and an unrelated page can never trigger unlock.
    config.authorizerControl = { leaseId: config.leaseId, port: server.address().port, token };
    portal = new TIdAuthorizer(config, { permit, onPhase: setPhase });
    await portal.claim();
    if (portal.completed) return stop();
    requireThat(exists, 'credentials_required');
    await setPhase('unlock_required');
    portal.watchPeer({
      isBusy: () => busy || stopping,
      onReturned: async () => { if (record) await authenticate(); },
      onLost: stop,
    });
  }
  key = await vaultKey(config.helper, config.keyHelper, config.directory,
    identityKey(config.identity), !exists, config.requestTitle);
  await permit();
  if (exists) {
    record = decryptRecord(key, config.identity, await fs.readFile(vault, 'utf8'));
    requireThat(record.schema === 1 && (record.credentials === null || typeof record.credentials?.password === 'string'), 'vault_schema_invalid');
    if (!record.credentials) record = null;
    else record.credentials = normalizeCredentials({ ...record.credentials, totp: record.credentials.totp ?? '' });
  } else {
    // Persist an encrypted empty record before opening the form. Cancelling
    // setup can then reuse the already-created OS key on the next attempt.
    // An OS key is never silently overwritten to recover an ambiguous failure.
    await atomicWrite(vault, encryptRecord(key, config.identity, { schema: 1, credentials: null, storage: null }), config.helper);
  }
  if (config.authorization) {
    requireThat(record?.credentials, 'credentials_required');
    await authenticate();
    return;
  }
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit, channel: config.channel });
  owned.server.on('close', () => { void stop(); });
  if (!record || config.mode === 'configure') {
    await setPhase('credentials_required'); const credentials = await input('credentials');
    record = { schema: 1, credentials, storage: null }; await save();
    // Setup is complete before bank authentication starts. Its isolated page
    // and listener must not stay above the bank or be reopened for login codes.
    await closePrompt();
    if (config.mode === 'configure') { await setPhase('configured'); return stop(); }
  }
  portal = new Portal(owned.browser, permit, { onPhase: value => { void setPhase(value).catch(() => stop()); },
    persist: storage => save(storage) });
  await setPhase('opening_portal');
  await portal.open(record.storage);
  portal.page.on('close', () => { if (!portal.handedOff) void stop(); });
  portal.context.on('close', () => { void stop(); });
  await authenticate();
}
async function stop() {
  if (stopping) return; stopping = true;
  if (config?.authorization) await portal?.close().catch(() => {});
  // Native guardian is the hard fallback; a hung browser close cannot prolong
  // shutdown. Killing the worker closes its pipe and makes the guardian reap
  // its owned browser group / Windows Job.
  setTimeout(() => process.exit(1), 2000).unref();
  server?.close(); server?.closeAllConnections();
  prompt?.close(); prompt = null;
  key?.fill(0); key = null; record = null;
  await owned?.browser.close().catch(() => {});
  await owned?.server.close().catch(() => {});
  if (config) {
    for (const name of ['control.json', 'lease.json']) {
      const file = path.join(config.directory, name);
      try { if (JSON.parse(await fs.readFile(file, 'utf8')).leaseId === config.leaseId) await fs.rm(file); } catch {}
    }
    if (!['configured', 'forgotten', 'authorized'].includes(phase)) { phase = 'closed'; await setPhase(phase).catch(() => {}); }
  }
  process.exit(0);
}
lines.on('close', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
process.on('uncaughtException', () => { void stop(); }); process.on('unhandledRejection', () => { void stop(); });

try {
  config = guardianConfig(await first);
  requireThat(config.expiresAt > Date.now() && config.expiresAt - config.startedAt === LEASE_MS &&
    config.expiresAt - Date.now() <= LEASE_MS && path.isAbsolute(config.directory), 'guardian_config_invalid');
  await permit();
  server = http.createServer(async (req, res) => {
    let runningScript = false;
    // A killed/cancelled caller cannot leave an async bank scenario acting in
    // the background. A synchronous JS hang still has the independent native
    // guardian as its hard deadline, including when the event loop is blocked.
    res.on('close', () => { if (runningScript && !res.writableEnded) void stop(); });
    const respond = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      // Browser JS cannot invoke the command plane: no CORS, no Origin and an
      // owner-only random bearer required. The bearer is never a provider token.
      requireThat(req.socket.remoteAddress === '127.0.0.1' && req.socket.localAddress === '127.0.0.1' &&
        req.headers.host === `127.0.0.1:${server.address().port}` && !req.headers.origin &&
        req.headers.authorization === `Bearer ${token}` && req.method === 'POST' && req.url === '/', 'control_rejected');
      await permit(); const packet = await boundedJson(req, 1024 * 1024);
      requireThat(packet.sessionId === config.leaseId, 'session_mismatch');
      if (packet.command === 'authorization-permit') {
        // Each secret character/click in the caller-owned page must cross the
        // same native guardian. This command neither exposes credentials nor
        // grants ownership of the external browser.
        requireThat(config.authorization &&
          Object.keys(packet).sort().join() === 'command,sessionId', 'control_rejected');
        respond(200, { permitted: true });
        return;
      }
      if (packet.command === 'status') { respond(200, state()); return; }
      if (packet.command === 'stop') { respond(200, { ...state(), phase: 'closing' }); setImmediate(() => { void stop(); }); return; }
      if (packet.command === 'show') {
        // Showing an existing window is also available while the protected
        // login loop waits for a human. It reads/submits no credential fields
        // and cannot mutate or reset the active authentication procedure.
        if (localPage && !localPage.isClosed()) {
          await localPage.bringToFront(); respond(200, { ok: true, requiredAction: state().requiredAction });
        } else {
          requireThat(portal?.page && !portal.page.isClosed(), 'session_not_ready');
          respond(200, await portal.show());
        }
        return;
      }
      if (packet.command === 'resume') {
        requireThat(!busy && portal && record, 'session_busy'); finalError = null; finalHttpFailure = {};
        requireThat(!portal.handedOff, 'new_session_required_after_handoff');
        respond(200, { ...state(), phase: 'authenticating' }); void authenticate(); return;
      }
      if (['snapshot', 'page', 'script'].includes(packet.command))
        requireThat(!config.authorization, 'external_browser_owned_by_caller');
      requireThat(!busy && phase === 'ready', 'session_not_ready'); busy = true;
      try {
        const secrets = [record.credentials.login, record.credentials.password, record.credentials.totp,
          record.credentials.username].filter(Boolean);
        const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
          .replace(/\b(?:\d[ -]?){12,19}\d\b/g, '[bank-number-redacted]');
        if (packet.command === 'snapshot') {
          respond(200, await portal.snapshot(redact));
        } else if (packet.command === 'page') {
          const { command: _command, sessionId: _sessionId, ...action } = packet;
          const result = await portal.action(action);
          // A dry-run cannot update either the bank or the encrypted session.
          // Store after an actual call only; a late storage failure must never
          // turn an already dispatched action into a safe automatic retry.
          if (!action.dryRun) await save(await portal.storage());
          respond(200, result);
        } else if (packet.command === 'script') {
          requireThat(Object.keys(packet).every(key => ['command', 'sessionId', 'source'].includes(key)), 'script_input_invalid');
          const compiled = compileScenario(packet.source);
          requireThat(!res.destroyed && !req.socket.destroyed, 'script_caller_closed');
          runningScript = true; req.socket.setTimeout(0);
          const handles = await portal.playwrightContext();
          // The caller may have cancelled while handoff awaited Playwright.
          // Acquire the native permit again before any agent source executes.
          await permit(); requireThat(!res.destroyed && !req.socket.destroyed, 'script_caller_closed');
          const result = await executeScenario(compiled, handles, redact);
          await save(await portal.storage());
          respond(200, result);
        } else throw new RuntimeError('unknown_command');
      } finally { busy = false; }
    } catch (error) { respond(400, { error: error instanceof RuntimeError ? error.code : 'operation_result_unknown', ...serviceHttpFailure(error) }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on('connection', socket => socket.setTimeout(15000, () => socket.destroy()));
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
