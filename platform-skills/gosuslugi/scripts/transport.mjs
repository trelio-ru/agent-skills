import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { UUID, requireThat, RuntimeError } from './core.mjs';
import { verifyPrivate } from './native.mjs';

// This descriptor is a local control capability, not a provider credential.
// Only its opaque IDs/origin cross the model boundary. Tokens stay inside the
// signed authorizer and the trusted caller process and are read through native owner/ACL checks.
export function browserSessionDirectory(root, identity, session) {
  requireThat(UUID.test(session), 'session_invalid');
  requireThat(UUID.test(identity.company || '') && UUID.test(identity.member || ''), 'host_identity_required');
  // Three nested UUIDs plus an atomic-write suffix exceed the legacy Windows
  // native path limit in an ordinary user profile. A full SHA-256 of the exact
  // tenant/member/session tuple keeps that boundary compact without truncating
  // identity or sharing capabilities between tenants. The descriptor below
  // independently checks all original IDs before returning its private token.
  const namespace = crypto.createHash('sha256')
    .update(JSON.stringify([identity.company, identity.member, session])).digest('hex');
  return path.join(root, 'integrations', 'gosuslugi-handoffs', namespace);
}
// The CLI verifies the owner-only descriptor before contacting an existing
// worker, and the worker verifies it again before admitting a delegated login.
// That second check is deliberate: the local bearer authenticates the caller,
// but it must not be enough to inject a different company/member/origin or an
// expired browser capability into an already-unlocked session.
export function validatedAuthorizationRequest(request, identity, now = Date.now()) {
  let origin;
  try { origin = new URL(request?.origin); } catch { throw new RuntimeError('authorization_request_mismatch'); }
  requireThat(
    request?.schema === 1 &&
      UUID.test(request.sessionId || '') &&
      UUID.test(request.requestId || '') &&
      origin.protocol === 'https:' &&
      origin.origin === request.origin &&
      !origin.username &&
      !origin.password &&
      !origin.port &&
      request.company === identity.company &&
      request.member === identity.member &&
      (request.accountId ?? null) === (identity.account?.id ?? identity.accountId ?? null) &&
      Number.isInteger(request.startedAt) &&
      Number.isInteger(request.expiresAt) &&
      request.startedAt <= now &&
      request.expiresAt > now &&
      request.expiresAt > request.startedAt &&
      request.expiresAt - request.startedAt <= 30 * 60 * 1000 &&
      Number.isInteger(request.brokerPid) &&
      request.brokerPid > 1 &&
      Number.isInteger(request.port) &&
      request.port > 0 &&
      request.port <= 65535 &&
      /^[a-f0-9]{64}$/.test(request.token || ''),
    'authorization_request_mismatch',
  );
  return request;
}
export async function readAuthorization(root, identity, session, requestId, origin, helper) {
  requireThat(UUID.test(requestId), 'authorization_request_invalid');
  const directory = browserSessionDirectory(root, identity, session);
  await verifyPrivate(directory, helper, true);
  const file = path.join(directory, 'authorization.json');
  await verifyPrivate(file, helper);
  requireThat((await fs.stat(file)).size < 4096, 'authorization_request_invalid');
  let request;
  try {
    request = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new RuntimeError('authorization_request_invalid');
  }
  validatedAuthorizationRequest(request, identity);
  requireThat(request.sessionId === session && request.requestId === requestId && request.origin === origin,
    'authorization_request_mismatch');
  return request;
}
export function requestLocal(control, packet, { timeout = 30000, limit = 65536 } = {}) {
  requireThat(
    Number.isInteger(control.port) &&
      control.port > 0 &&
      control.port <= 65535 &&
      /^[a-f0-9]{64}$/.test(control.token),
    'local_control_invalid',
  );
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(packet);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: control.port,
        path: '/',
        method: 'POST',
        timeout,
        headers: {
          Host: `127.0.0.1:${control.port}`,
          Authorization: `Bearer ${control.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let result = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          result += chunk;
          if (Buffer.byteLength(result) > limit) req.destroy();
        });
        res.on('end', () => {
          try {
            const value = JSON.parse(result);
            if (res.statusCode === 200) resolve(value);
            else reject(new RuntimeError(/^[a-z_]+$/.test(value.error) ? value.error : 'operation_failed', value));
          } catch (error) {
            reject(error instanceof RuntimeError ? error : new RuntimeError('control_result_invalid'));
          }
        });
      },
    );
    // No retries: a lost response to a credential input or click is ambiguous.
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new RuntimeError('session_unreachable')));
    req.end(body);
  });
}
