import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

import {
  decryptRecord,
  encryptRecord,
  guardianConfig,
  identityKey,
  LEASE_MS,
  requireThat,
  RuntimeError,
  serviceHttpFailure,
} from './core.mjs';
import { CourtPortal, launchOwnedBrowser, loadPlaywright } from './browser.mjs';
import { atomicWrite, vaultKey, verifyPrivate } from './native.mjs';
import { compileScenario, executeScenario } from './scenario.mjs';
import { AUTHORIZATION_FAILURE_ACTION, prepareCourtSignIn, resumeCourtSignIn } from './sign-in.mjs';

// The native guardian owns this detached worker and the exact Chromium child.
// Only this process ever sees decrypted court storage or the Playwright
// endpoint; the CLI and the model exchange bounded action/results instead.
const lines = readline.createInterface({ input: process.stdin });
const first = new Promise(resolve => lines.once('line', resolve));
let sequence = 0;
const pending = new Map();
lines.on('line', line => {
  try {
    const packet = JSON.parse(line);
    if (packet.ok === true && Number.isInteger(packet.id)) {
      pending.get(packet.id)?.resolve();
      pending.delete(packet.id);
    }
  } catch {}
});

let stopping = false;
let stopStarted = false;
let busy = false;
let config;
let server;
let owned;
let portal;
let key;
let record;
let phase = 'starting';
let finalError = null;
let authorizationError = null;
let authorizationHttpFailure = {};
let finalHttpFailure = {};
const token = crypto.randomBytes(32).toString('hex');

async function permit(op = 'permit', extra = {}) {
  requireThat(!stopping, 'session_closed');
  requireThat(!config || Date.now() < config.expiresAt, 'session_expired');
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new RuntimeError('guardian_unavailable'));
      void stop();
    }, 2000);
    pending.set(id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject,
    });
    process.stdout.write(`${JSON.stringify({ op, id, ...extra })}\n`);
  });
}

const state = () => ({
  sessionId: config.leaseId,
  phase,
  expiresAt: config.expiresAt,
  browser: { headed: true, startsInactive: true, backgroundActionsDoNotFocus: true },
  requiredAction: ({
    starting: 'Локальная сессия ГАС запускается в фоне.',
    opening_portal: 'Открываем ГАС «Правосудие» в фоне.',
    authorization_required: 'Выполните защищённый вызов Госуслуг с возвращёнными arguments.',
    authorization_pending: 'Продолжите обязательный шаг ЕСИА в уже открытом окне, затем повторите resume.',
    authorization_failed: AUTHORIZATION_FAILURE_ACTION,
    failed: 'Сессия остановлена. Проверьте безопасный код ошибки; неизвестную отправку не повторяйте автоматически.',
  })[phase] || null,
  ...(finalError || authorizationError ? { error: finalError || authorizationError,
    ...serviceHttpFailure({ code: finalError || authorizationError,
      ...(finalError ? finalHttpFailure : authorizationHttpFailure) }) } : {}),
});

async function setPhase(next, error = null, httpFailure = {}) {
  phase = next;
  authorizationError = next === 'authorization_failed' ? error : null;
  authorizationHttpFailure = next === 'authorization_failed' ? httpFailure : {};
  await atomicWrite(path.join(config.directory, 'status.json'), JSON.stringify(state()), config.helper);
}

async function readVault() {
  const vault = path.join(config.directory, 'vault.json');
  let exists = false;
  try {
    await verifyPrivate(vault, config.helper);
    requireThat((await fs.stat(vault)).size < 6 * 1024 * 1024, 'vault_too_large');
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  key = await vaultKey(config.helper, config.directory, identityKey(config.identity), !exists);
  await permit();
  if (!exists) {
    record = { schema: 1, storage: null };
    // Create the encrypted empty record before Chromium starts. A crash can
    // never leave a reusable plaintext profile or a key with ambiguous state.
    await atomicWrite(vault, encryptRecord(key, config.identity, record), config.helper);
    return;
  }
  record = decryptRecord(key, config.identity, await fs.readFile(vault, 'utf8'));
  requireThat(record?.schema === 1 && (record.storage === null || typeof record.storage === 'object'),
    'vault_schema_invalid');
}

async function save(storage = record.storage) {
  await permit();
  const next = { schema: 1, storage };
  await atomicWrite(
    path.join(config.directory, 'vault.json'),
    encryptRecord(key, config.identity, next),
    config.helper,
  );
  record = next;
}

async function initialize() {
  await permit();
  await readVault();
  const playwright = await loadPlaywright(config.browserSessionModuleUrl);
  owned = await launchOwnedBrowser({ playwright, permit, channel: config.channel });
  owned.server.on('close', () => { if (!stopping) void stop(); });
  portal = new CourtPortal(owned.browser, permit);
  await setPhase('opening_portal');
  await portal.open(record.storage);
  // An official court flow may replace the initial tab with a popup. The
  // context remains the security boundary, so closing one page must not tear
  // down a valid surviving court page or force a foreground restart.
  portal.context.on('close', () => { if (!stopping) void stop(); });
  await setPhase('ready');
}

async function boundedJson(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    request.on('data', chunk => {
      length += chunk.length;
      if (length > limit) {
        request.destroy();
        reject(new RuntimeError('input_too_large'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RuntimeError('control_input_invalid')); }
    });
    request.on('error', () => reject(new RuntimeError('control_input_invalid')));
  });
}

// Scenario output may contain application data requested by the user, but it
// must not become a path for auth artifacts. This catches common serialized
// cookie/token shapes in addition to the skill's instruction-level ban.
function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt-redacted]')
    .replace(/([?&](?:code|state|token|session|authorization|credential|otp)Id?=)[^&#\s]*/gi, '$1[redacted]');
}

async function stop() {
  if (stopStarted) return;
  stopStarted = true;
  // The guardian remains the hard deadline if storage or Chromium shutdown
  // hangs. Persist only a normal court state; an in-flight ESIA transaction
  // must never be mistaken for a reusable authenticated snapshot.
  const hardExit = setTimeout(() => process.exit(1), 2000);
  hardExit.unref();
  if (portal && !portal.authorization && record && key) {
    await save(await portal.storage()).catch(() => {});
  }
  stopping = true;
  server?.close();
  server?.closeAllConnections();
  await portal?.close().catch(() => {});
  await owned?.browser.close().catch(() => {});
  await owned?.server.close().catch(() => {});
  key?.fill(0);
  key = null;
  record = null;
  if (config) {
    for (const name of ['control.json', 'lease.json']) {
      const file = path.join(config.directory, name);
      try {
        if (JSON.parse(await fs.readFile(file, 'utf8')).leaseId === config.leaseId) await fs.rm(file);
      } catch {}
    }
    if (phase !== 'failed') {
      phase = 'closed';
      await setPhase('closed').catch(() => {});
    }
  }
  process.exit(0);
}

lines.on('close', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('uncaughtException', () => { finalError = 'worker_uncaught_exception'; void stop(); });
process.on('unhandledRejection', () => { finalError = 'worker_unhandled_rejection'; void stop(); });

try {
  config = guardianConfig(await first);
  requireThat(config.expiresAt > Date.now() && config.expiresAt - config.startedAt === LEASE_MS &&
    config.expiresAt - Date.now() <= LEASE_MS && path.isAbsolute(config.directory) &&
    typeof config.browserSessionModuleUrl === 'string' && config.browserSessionModuleUrl.startsWith('file:'),
  'guardian_config_invalid');
  await permit();
  server = http.createServer(async (request, response) => {
    let callerBoundOperation = false;
    let authorizationOperation = false;
    response.on('close', () => {
      // Cancellation must not leave a caller-authored scenario mutating the
      // portal or an unseen ЕСИА handoff running. The native guardian will
      // also reap a blocked loop.
      if (callerBoundOperation && !response.writableEnded) void stop();
    });
    const respond = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      requireThat(request.socket.remoteAddress === '127.0.0.1' && request.socket.localAddress === '127.0.0.1' &&
        request.headers.host === `127.0.0.1:${server.address().port}` && !request.headers.origin &&
        request.headers.authorization === `Bearer ${token}` && request.method === 'POST' && request.url === '/',
      'control_rejected');
      await permit();
      const packet = await boundedJson(request);
      requireThat(packet.sessionId === config.leaseId, 'session_mismatch');
      if (packet.command === 'status') { respond(200, state()); return; }
      if (packet.command === 'stop') {
        respond(200, { ...state(), phase: 'closing' });
        setImmediate(() => { void stop(); });
        return;
      }
      if (packet.command === 'show') {
        requireThat(portal, 'session_not_ready');
        respond(200, await portal.show());
        return;
      }
      requireThat(!busy && portal && record && !stopStarted, 'session_busy');
      busy = true;
      try {
        if (packet.command === 'prepare-sign-in') {
          requireThat(Object.keys(packet).every(name =>
            ['client', 'command', 'requestTitle', 'sessionId'].includes(name)), 'session_not_ready');
          callerBoundOperation = true;
          authorizationOperation = true;
          const result = await prepareCourtSignIn(portal, {
            phase, client: packet.client, requestTitle: packet.requestTitle, setPhase,
          });
          respond(200, result);
        } else if (packet.command === 'resume') {
          authorizationOperation = true;
          const result = await resumeCourtSignIn(portal, { phase, setPhase, save });
          respond(200, { ...result, sessionId: config.leaseId, expiresAt: config.expiresAt });
        } else {
          requireThat(phase === 'ready', 'session_not_ready');
          if (packet.command === 'snapshot') {
            respond(200, await portal.snapshot(redact));
          } else if (packet.command === 'page') {
            const { command: _command, sessionId: _sessionId, ...action } = packet;
            const result = await portal.action(action);
            // Never rewrite the encrypted snapshot for a dry run. After a real
            // action, a storage failure does not make the provider action safe
            // to retry automatically.
            if (!action.dryRun) await save(await portal.storage());
            respond(200, result);
          } else if (packet.command === 'script') {
            requireThat(Object.keys(packet).every(name => ['command', 'sessionId', 'source'].includes(name)),
              'script_input_invalid');
            const compiled = compileScenario(packet.source);
            requireThat(!response.destroyed && !request.socket.destroyed, 'script_caller_closed');
            callerBoundOperation = true;
            request.socket.setTimeout(0);
            const handles = await portal.playwrightContext();
            await permit();
            requireThat(!response.destroyed && !request.socket.destroyed, 'script_caller_closed');
            const result = await executeScenario(compiled, handles, redact);
            await save(await portal.storage());
            respond(200, result);
          } else throw new RuntimeError('unknown_command');
        }
      } finally {
        busy = false;
      }
    } catch (error) {
      respond(400, {
        ...(authorizationOperation && phase === 'authorization_failed' ? state() : {}),
        error: error instanceof RuntimeError ? error.code : 'operation_result_unknown',
        ...serviceHttpFailure(error),
      });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', socket => socket.setTimeout(15000, () => socket.destroy()));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await atomicWrite(
    path.join(config.directory, 'control.json'),
    JSON.stringify({ leaseId: config.leaseId, port: server.address().port, token }),
    config.helper,
  );
  await setPhase('starting');
  void initialize().catch(async error => {
    finalError = error instanceof RuntimeError ? error.code : 'initialization_failed';
    finalHttpFailure = serviceHttpFailure(error);
    await setPhase('failed').catch(() => {});
    await stop();
  });
} catch {
  await stop();
}
