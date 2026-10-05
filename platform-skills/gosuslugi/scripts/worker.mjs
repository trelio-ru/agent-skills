import { showOwnedPage } from './windows.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { decryptRecord, encryptRecord, guardianConfig, identityKey, LEASE_MS, normalizeCredentials, requireThat, RuntimeError, serviceHttpFailure } from './core.mjs';
import { atomicWrite, deleteVaultKey, vaultKey, verifyPrivate } from './native.mjs';
import { loadPlaywright, launchOwnedBrowser, Portal, loginRole, reusableRoleStorage } from './browser.mjs';
import { boundedJson, createPrompt } from './prompt.mjs';
import { EsiaAuthorizer } from './esia-authorizer.mjs';
import { validatedAuthorizationRequest } from './transport.mjs';

// Only this native-supervised process opens the encrypted record/key. During
// delegated login, bounded input values also pass through the private browser
// broker's RAM; CLI, agent and business skills never receive those values.
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
let delegatedAuthorization = null, delegatedPortal = null, delegatedLoginRole = 'personal';
let busy = false, finalError = null, finalHttpFailure = {}, reviewContext = null;
const activeAuthorization = () => config.authorization || delegatedAuthorization;
const activeAuthorizer = () => config.authorization ? portal : delegatedPortal;
const sameAuthorization = (left, right) => ['schema', 'sessionId', 'requestId', 'origin', 'company', 'member',
  'startedAt', 'expiresAt', 'brokerPid', 'port', 'token'].every(field => left?.[field] === right?.[field]);
function redactAuthSecrets(value) {
  return [record.credentials.login, record.credentials.password, record.credentials.totp].filter(Boolean)
    .reduce((text, secret) => text.split(secret).join('[redacted]'), value);
}
const token = crypto.randomBytes(32).toString('hex');
const state = () => ({ sessionId: config.leaseId, phase, expiresAt: config.expiresAt,
  loginRole: delegatedAuthorization ? delegatedLoginRole : loginRole(config.loginRole),
  roleChoiceRequired: Boolean(activeAuthorizer()?.roleChoiceRequired),
  ...(activeAuthorization() ? { authorization: { origin: activeAuthorization().origin,
    browserSessionId: activeAuthorization().sessionId } } : {}),
  ...(phase === 'user_required' && activeAuthorizer()?.manualReason
    ? { manualReason: activeAuthorizer().manualReason } : {}),
  ...(phase === 'review_required' && reviewContext ? { review: reviewContext } : {}),
  requiredAction: ({ unlock_required: 'Подтвердите разблокировку в системном окне.', credentials_required: 'Введите данные на локальной странице.',
    code_required: 'Введите запрошенный Госуслугами код на локальной странице.',
    review_required: 'Получите snapshot этой же сессии и определите следующий шаг по безопасному содержимому страницы. Не запрашивайте действие пользователя без конкретного распознанного challenge.',
    user_required: portal?.roleChoiceRequired && !activeAuthorization()
      ? 'Получите roles; выбирайте вариант только по указанию оператора. После выбора выполните resume.'
      : 'Продолжите ручную проверку в том же окне сервиса или Госуслуг, затем вызовите resume.',
    failed: 'Операция остановлена. Проверьте безопасный код ошибки, не повторяйте отправку автоматически.' })[phase] || null,
  ...(finalError ? { error: finalError, ...serviceHttpFailure({ ...finalHttpFailure, code: finalError }) } : {}) });
async function setPhase(next) {
  const changed = phase !== next;
  phase = next;
  // A human challenge may reveal the same owned window once. Repeated status,
  // and polling never pull it back over the user's current app.
  if (changed && portal && !finalError) {
    if (next === 'user_required' && !portal.roleChoiceRequired && !activeAuthorization()) { await permit(); await showOwnedPage(portal.page); }
  }
  await atomicWrite(path.join(config.directory, 'status.json'), JSON.stringify(state()), config.helper);
}
async function save(storage = record.storage) {
  await permit();
  // Preserve unknown encrypted legacy fields, but only the Gosuslugi storage
  // is read or updated here. External-site sessions are no longer our data.
  const next = { ...record, schema: 1, credentials: record.credentials, storage,
    storageRole: portal?.selectedRoleKind === 'personal' ? 'personal' : null };
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
    localContext = await owned.browser.newContext({ viewport: null, acceptDownloads: false, serviceWorkers: 'block' });
    localPage = await localContext.newPage();
    prompt = await createPrompt({ open: url => localPage.goto(url, { waitUntil: 'domcontentloaded' }),
      timeoutMs: Math.min(300000, config.expiresAt - Date.now()), onCancel: () => { void stop(); } });
    localPage.on('close', () => { if (prompt) void stop(); });
  }
  // Focus happens only for an actual request for human input. Merely checking
  // status, thinking, snapshotting or issuing the next action never focuses it.
  const answer = prompt.ask(kind); await showOwnedPage(localPage);
  return answer;
}
async function authenticate() {
  requireThat(!busy && portal && record, 'session_busy'); busy = true;
  try {
    reviewContext = null;
    const ready = await portal.authenticate(record.credentials, loginRole(config.loginRole));
    if (ready) { await closePrompt(); if (config.authorization) await stop(); }
    else if (phase === 'review_required') {
      reviewContext = portal.reviewContext();
      await setPhase('review_required');
    }
  } catch (error) {
    finalError = error instanceof RuntimeError ? error.code : 'provider_result_unknown';
    finalHttpFailure = serviceHttpFailure(error);
    reviewContext = portal.reviewContext();
    await setPhase('review_required'); await closePrompt();
  } finally { busy = false; }
}
async function closeDelegatedAuthorization({ cancel = true } = {}) {
  const current = delegatedPortal;
  delegatedPortal = null; delegatedAuthorization = null; delegatedLoginRole = 'personal';
  if (cancel) await current?.close().catch(() => {});
}
async function authenticateDelegated() {
  requireThat(!busy && delegatedPortal && delegatedAuthorization && record?.credentials, 'session_busy');
  busy = true;
  try {
    const ready = await delegatedPortal.authenticate(record.credentials, delegatedLoginRole);
    if (ready) {
      // EsiaAuthorizer.finish already consumed the exact caller capability.
      // Clear only this temporary authorizer and restore the normal ready
      // session; its browser, cookies and unsaved page state remain untouched.
      await closeDelegatedAuthorization({ cancel: false });
      finalError = null; finalHttpFailure = {};
      await setPhase('ready');
    }
  } catch (error) {
    finalError = error instanceof RuntimeError ? error.code : 'provider_result_unknown';
    finalHttpFailure = serviceHttpFailure(error);
    await setPhase('user_required');
  } finally { busy = false; }
}
async function beginDelegatedAuthorization(authorization, requestedRole) {
  // The control handler acquires `busy` before crossing any async boundary;
  // this helper therefore validates the session state without trying to
  // acquire the same lock a second time.
  requireThat(!config.authorization && phase === 'ready' && !delegatedPortal && record?.credentials,
    delegatedPortal ? 'authorization_already_started' : 'session_not_ready');
  validatedAuthorizationRequest(authorization, config.identity);
  delegatedAuthorization = authorization;
  delegatedLoginRole = loginRole(requestedRole);
  delegatedPortal = new EsiaAuthorizer({ ...config, authorization,
    authorizerControl: { leaseId: config.leaseId, port: server.address().port, token } },
  { permit, onPhase: setPhase });
  finalError = null; finalHttpFailure = {};
  try {
    await setPhase('authorization_check');
    await delegatedPortal.claim();
    if (delegatedPortal.completed) {
      await closeDelegatedAuthorization({ cancel: false });
      await setPhase('ready');
      return false;
    }
    delegatedPortal.watchPeer({ isBusy: () => busy || stopping,
      onReturned: async () => { if (record && delegatedPortal) await authenticateDelegated(); },
      onProgress: async () => {
        // The user can finish CAPTCHA or a code in the owned browser while the
        // agent is paused. Continue that same transaction after its POST.
        if (record && delegatedPortal && !busy && !stopping) await authenticateDelegated();
      },
      onLost: async () => {
        if (!delegatedPortal || busy || stopping) return;
        finalError = 'authorization_session_lost'; finalHttpFailure = {};
        await closeDelegatedAuthorization();
        await setPhase('ready');
      } });
    await setPhase('authenticating');
    return true;
  } catch (error) {
    await closeDelegatedAuthorization();
    finalError = null; finalHttpFailure = {};
    await setPhase('ready');
    throw error;
  }
}
async function initialize() {
  if (config.authorization) validatedAuthorizationRequest(config.authorization, config.identity);
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
    config.authorizerControl = { leaseId: config.leaseId, port: server.address().port, token };
    portal = new EsiaAuthorizer(config, { permit, onPhase: setPhase });
    await portal.claim();
    if (portal.completed) return stop();
    requireThat(exists, 'credentials_required');
    await setPhase('unlock_required');
    portal.watchPeer({ isBusy: () => busy || stopping,
      onReturned: async () => { if (record) await authenticate(); }, onLost: stop });
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
    await authenticate(); return;
  }
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit, channel: config.channel });
  owned.server.on('close', () => { void stop(); });
  if (!record || config.mode === 'configure') {
    await setPhase('credentials_required'); const credentials = await input('credentials');
    record = { schema: 1, credentials, storage: null }; await save();
    if (config.mode === 'configure') { await closePrompt(); await setPhase('configured'); return stop(); }
  }
  portal = new Portal(owned.browser, permit, { onPhase: value => { void setPhase(value).catch(() => stop()); },
    askCode: () => input('code'), persist: storage => save(storage) });
  await setPhase('opening_portal');
  // Reuse is safe only with positive evidence that this is the requested
  // personal role. Older cookies have no role binding. An explicit alternative
  // starts the normal ESIA flow using saved credentials, without asking for
  // setup again or inheriting a prior organisation identity.
  const storage = reusableRoleStorage(record, loginRole(config.loginRole));
  portal.selectedRoleKind = storage ? 'personal' : null;
  await portal.open(storage);
  portal.page.on('close', () => { void stop(); });
  await authenticate();
}
async function stop() {
  if (stopping) return; stopping = true;
  if (config?.authorization) await portal?.close().catch(() => {});
  await closeDelegatedAuthorization().catch(() => {});
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
    const respond = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      // Browser JS cannot invoke the command plane: no CORS, no Origin and an
      // owner-only random bearer required. The bearer is never a provider token.
      requireThat(req.socket.remoteAddress === '127.0.0.1' && req.socket.localAddress === '127.0.0.1' &&
        req.headers.host === `127.0.0.1:${server.address().port}` && !req.headers.origin &&
        req.headers.authorization === `Bearer ${token}` && req.method === 'POST' && req.url === '/', 'control_rejected');
      await permit(); const packet = await boundedJson(req, 16384);
      requireThat(packet.sessionId === config.leaseId, 'session_mismatch');
      if (packet.command === 'authorization-permit') {
        // The private caller-side input adapter must cross the native deadline
        // for every character/action, even while authenticate awaits its RPC.
        // This narrow callback never grants process ownership or starts login.
        requireThat(activeAuthorization() && Object.keys(packet).sort().join() === 'command,sessionId', 'control_rejected');
        respond(200, { permitted: true }); return;
      }
      if (packet.command === 'status') { respond(200, state()); return; }
      if (packet.command === 'stop') { respond(200, { ...state(), phase: 'closing' }); setImmediate(() => { void stop(); }); return; }
      if (packet.command === 'authorize') {
        requireThat(Object.keys(packet).sort().join() === 'authorization,command,loginRole,sessionId', 'control_rejected');
        // A caller may retry after losing the first local response. Return the
        // state only for the byte-equivalent capability; a different request
        // cannot replace or join the in-flight transaction.
        if (delegatedAuthorization) {
          validatedAuthorizationRequest(packet.authorization, config.identity);
          requireThat(sameAuthorization(packet.authorization, delegatedAuthorization), 'authorization_already_started');
          respond(200, state()); return;
        }
        requireThat(!busy, 'session_busy'); busy = true;
        let shouldAuthenticate = false;
        try {
          shouldAuthenticate = await beginDelegatedAuthorization(packet.authorization, packet.loginRole);
          respond(200, state());
        } finally { busy = false; }
        if (shouldAuthenticate) setImmediate(() => { void authenticateDelegated(); });
        return;
      }
      if (packet.command === 'resume') {
        requireThat(!busy && (delegatedPortal || portal) && record, 'session_busy'); finalError = null; finalHttpFailure = {}; reviewContext = null;
        respond(200, { ...state(), phase: 'authenticating' });
        if (delegatedPortal) void authenticateDelegated(); else void authenticate();
        return;
      }
      if (['roles', 'choose-role', 'snapshot', 'page'].includes(packet.command)) requireThat(!activeAuthorization(), 'external_browser_owned_by_caller');
      if (['roles', 'choose-role'].includes(packet.command)) {
        requireThat(!busy && portal && record && phase === 'user_required', 'role_chooser_required');
        busy = true;
        try {
          if (packet.command === 'roles') {
            const result = await portal.roles();
            respond(200, { ...result, choices: result.choices.map(choice => ({ ...choice, label: redactAuthSecrets(choice.label) })) });
          }
          else {
            requireThat(packet.confirmed === true && Object.keys(packet).sort().join() === 'command,confirmed,ref,sessionId', 'explicit_role_choice_required');
            await portal.selectRole(packet.ref);
            // Every subsequent role step belongs to this explicit operator
            // choice, so automatic personal selection is disabled for the
            // remainder of this lease only. Nothing persists that override.
            config.loginRole = 'manual';
            respond(200, { ...state(), selected: true, requiredAction: 'Проверьте результат через resume этой же сессии.' });
          }
        } finally { busy = false; }
        return;
      }
      // An unclassified public page is sent to the model as redacted text and
      // bounded controls. That state never steals focus or becomes a generic
      // request for user intervention. The same safe page-action surface may
      // be used before resume when the model identifies an exact next step.
      requireThat(!busy && ['ready', 'review_required'].includes(phase), 'session_not_ready'); busy = true;
      try {
        if (packet.command === 'snapshot') {
          respond(200, await portal.snapshot(redactAuthSecrets));
        } else if (packet.command === 'page') { await portal.action(packet); await save(await portal.storage()); respond(200, { ok: true }); }
        else throw new RuntimeError('unknown_command');
      } finally { busy = false; }
    } catch (error) { respond(400, { error: error instanceof RuntimeError ? error.code : 'operation_result_unknown',
      ...serviceHttpFailure(error) }); }
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
