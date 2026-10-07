import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { authOrigin, configRoot, LEASE_MS, requireThat, RuntimeError, serviceHttpFailure, UUID } from './core.mjs';
import { nativeHelper, nativeRequestTitleInput, ensurePrivateDirectory } from './native.mjs';
import { boundedJson } from './prompt.mjs';
import { browserSessionDirectory, requestLocal } from './transport.mjs';
import { ServiceFlow, serviceForOrigin } from './esia-flow.mjs';
import { createAuthorizationBroker } from './authorization.mjs';
import { PlaywrightAuthorizationFlow } from './playwright-flow.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The two stages can settle before the caller begins awaiting the second.
  // Keep failures observable through that promise without an unhandled event.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// Callers need the exact safe rejection to assess a failed OAuth attempt.
// Exporting a projection avoids the common catch(() => "not completed")
// pattern without encouraging messages, stacks or private browser data.
export function safeAuthorizationFailure(error) {
  const safe = error instanceof RuntimeError && /^[a-z_]{1,80}$/.test(error.code)
    ? error : new RuntimeError('authorization_result_unknown');
  return { error: safe.code, ...serviceHttpFailure(safe) };
}

/**
 * Attach ESIA authorization to an ordinary, caller-owned Playwright Page.
 * No browser, profile or context is created, imported, restricted or closed.
 * The returned context/page are exactly the original objects. The caller is
 * trusted: raw Playwright can inspect cookies, network and auth fields. This
 * API avoids returning credentials; it is not a sandbox against caller code.
 *
 * Create before clicking the site's normal login button. `request` resolves
 * with only opaque IDs and origin after the actual ESIA transaction is seen.
 * Invoke the verified Gosuslugi `authorize` CLI with these public arguments;
 * `authenticated` then resolves to { context, page } on a verified callback.
 */
export async function createEsiaAuthorization(page, options = {}) {
  // Explicit permission is checked before native bootstrap or browser reads.
  requireThat(options.confirm === true, 'authorization_permission_required');
  if (options.requestTitle !== undefined && options.requestTitle !== null) nativeRequestTitleInput(options.requestTitle);
  const { company, member, origin } = options;
  requireThat(UUID.test(company || '') && UUID.test(member || ''), 'host_identity_required');
  let target;
  try { target = new URL(origin); } catch { throw new RuntimeError('authorization_origin_invalid'); }
  requireThat(target.protocol === 'https:' && target.origin === origin && !target.username && !target.password &&
    !target.port && !authOrigin(origin), 'authorization_origin_invalid');
  requireThat(page && typeof page.context === 'function' && !page.isClosed() &&
    new URL(page.url()).origin === origin, 'authorization_target_mismatch');
  const root = options.configHome ?? configRoot();
  requireThat(typeof root === 'string' && path.isAbsolute(root), 'config_home_absolute_required');
  const helper = await nativeHelper(root);
  const sessionId = crypto.randomUUID(), identity = { company, member };
  const directory = browserSessionDirectory(root, identity, sessionId);
  await ensurePrivateDirectory(directory, helper);
  const startedAt = Date.now(), expiresAt = startedAt + LEASE_MS, startedClock = performance.now();
  const config = { root, helper, directory, identity, leaseId: sessionId, startedAt, expiresAt };
  const service = serviceForOrigin(origin);
  const flow = new ServiceFlow(service);
  // Auth operations follow the one bound ESIA page; the public return value
  // always keeps the original page, including when a site owns an auth popup.
  let observation;
  const portal = { get page() { return observation?.page ?? page; }, service, serviceFlow: flow };
  const ready = deferred(), done = deferred();
  let broker, closed = false, busy = false, timer, publishing = Promise.resolve();
  let nativeControl = null;
  async function permit() {
    requireThat(!closed, 'authorization_closed');
    requireThat(Date.now() < expiresAt && performance.now() - startedClock < LEASE_MS, 'session_expired');
    if (nativeControl) {
      // Each secret character/action also crosses the actual native guardian.
      // A paused JS caller, changed wall clock or a still-alive stale PID cannot
      // extend its authority. This callback never grants process ownership.
      const permission = await requestLocal(nativeControl, { command: 'authorization-permit', sessionId: nativeControl.leaseId },
        { timeout: 3000, limit: 4096 });
      requireThat(permission?.permitted === true, 'native_permit_required');
    }
  }
  async function cleanup(error = null) {
    if (closed) return;
    closed = true; clearTimeout(timer);
    observation?.close();
    server.close(); server.closeAllConnections();
    await publishing.catch(() => {});
    await fs.rm(path.join(directory, 'authorization.json'), { force: true });
    await fs.rmdir(directory).catch(() => {});
    if (error) { ready.reject(error); done.reject(error); }
    // Browser ownership never transfers. In particular, cancellation or a
    // failed login must not destroy the caller's draft or unrelated tabs.
  }
  function fail(error) {
    const safe = error instanceof RuntimeError ? error : new RuntimeError('authorization_result_unknown');
    flow.error ||= safe.code;
    void cleanup(safe);
  }
  function publish() {
    publishing = publishing.then(async () => {
      if (closed) return;
      await broker.refresh();
      const value = broker.authorization;
      if (value) ready.resolve({ sessionId, requestId: value.requestId, origin, expiresAt,
        arguments: ['authorize', '--browser-session', sessionId, '--request', value.requestId,
          '--origin', origin, '--confirm', ...(options.requestTitle ? ['--request-title', options.requestTitle] : [])] });
    });
    publishing.catch(fail);
  }
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    let acquired = false;
    try {
      requireThat(req.socket.remoteAddress === '127.0.0.1' && req.socket.localAddress === '127.0.0.1' &&
        req.headers.host === `127.0.0.1:${server.address().port}` && !req.headers.origin &&
        req.headers.authorization === `Bearer ${broker.token}` && req.method === 'POST' && req.url === '/', 'control_rejected');
      requireThat(!busy, 'session_busy'); busy = true; acquired = true;
      const packet = await boundedJson(req, 16384);
      if (packet.command === 'claim') {
        requireThat(packet.nativeControl?.leaseId === packet.authorizationLease, 'native_permit_required');
        // Validate the bounded callback through its native permit before claim.
        const permission = await requestLocal(packet.nativeControl, { command: 'authorization-permit', sessionId: packet.authorizationLease },
          { timeout: 3000, limit: 4096 });
        requireThat(permission?.permitted === true, 'native_permit_required');
      }
      const result = await broker.handle(packet);
      if (packet.command === 'claim') nativeControl = packet.nativeControl;
      respond(200, result);
      if (packet.command === 'complete' || packet.command === 'claim' && result.returned === true) {
        // ESIA has returned the bound response; whether the external site
        // exchanged it successfully or rendered its cabinet belongs to the
        // caller. Provide only the committed document's safe HTTP metadata.
        done.resolve({ context: page.context(), page,
          ...(observation.serviceResponse ? { serviceResponse: { ...observation.serviceResponse } } : {}) });
        // Allow the completion reply to flush before closing the listener.
        setImmediate(() => { void cleanup(); });
      }
    } catch (error) {
      respond(400, { error: error instanceof RuntimeError ? error.code : 'authorization_result_unknown',
        ...serviceHttpFailure(error) });
    } finally { if (acquired) busy = false; }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on('connection', socket => socket.setTimeout(15000, () => socket.destroy()));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  broker = createAuthorizationBroker({ config, portal, permit, port: server.address().port,
    onCancel: async () => { setImmediate(() => fail(new RuntimeError('authorization_cancelled'))); },
    show: async () => { await portal.page.bringToFront(); }, getPostCount: () => observation.postCount,
    onPersonalRoleChoice: () => observation.markPersonalRoleChoice(),
    hasReturned: () => observation.returned });
  observation = new PlaywrightAuthorizationFlow(page, flow, { onBinding: publish, onError: fail });
  timer = setTimeout(() => fail(new RuntimeError('session_expired')), LEASE_MS);
  return { request: ready.promise, authenticated: done.promise, page, context: page.context(),
    close: () => cleanup(new RuntimeError('authorization_cancelled')) };
}
