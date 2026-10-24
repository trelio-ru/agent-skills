import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import * as sdk from '@whiskeysockets/baileys';
import pino from 'pino';
import { WhatsAppClient } from '../scripts/client.mjs';
import { RuntimeError } from '../scripts/core.mjs';
import { requestControl } from '../scripts/trelio-whatsapp.mjs';
import { waitForSessionChange, withSessionContinuation } from '../scripts/session-wait.mjs';
import { ConnectionDiagnostics, disconnectEvidence, connectionDiagnosticsFields, connectionRequiredAction } from '../scripts/connection-diagnostics.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const sockets = [], phases = [], fatals = [];
  const client = new WhatsAppClient({ sdk: { ...sdk, default: () => {
    const socket = { ev: new EventEmitter(), ws: new EventEmitter(), end: () => {} };
    sockets.push(socket); return socket;
  } }, pino, permit: async () => {}, persist: async () => {}, onQr: async () => {},
  onPhase: phase => phases.push(phase), onFatal: code => fatals.push(code) });
  const close = (code, extra = {}, socket = sockets.at(-1)) => socket.ev.emit('connection.update', {
    connection: 'close', lastDisconnect: { error: { output: { statusCode: code }, ...extra } },
  });
  return { client, sockets, phases, fatals, close };
}

test('diagnostics classify only numeric disconnect reasons and known transport codes', () => {
  const cases = [[401, 'logged_out'], [403, 'forbidden'], [408, 'connection_lost_or_timed_out'],
    [411, 'multidevice_mismatch'], [428, 'connection_closed'], [440, 'connection_replaced'],
    [500, 'bad_session'], [503, 'service_unavailable'], [515, 'restart_required'], [405, 'unknown']];
  for (const [code, reason] of cases) assert.equal(disconnectEvidence({ output: { statusCode: code } }).reason, reason);
  assert.equal(disconnectEvidence({ output: { statusCode: '401' }, message: 'loggedOut' }).statusCode, null);
  assert.deepEqual(disconnectEvidence({ output: { statusCode: 500 }, data: { code: 'ENOTFOUND', host: 'PRIVATE' } }), {
    statusCode: 500, reason: 'transport_error', category: 'transport', transportCode: 'ENOTFOUND', nextAction: 'check_network_then_retry',
  });
  assert.equal(disconnectEvidence({ code: 'PRIVATE_TOKEN' }).transportCode, null);
});

test('real connection events retain the final reason after exactly three retries without duplicate sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sockets, phases, close } = fixture();
  t.after(() => client.close());
  await client.connect();
  for (let index = 0; index < 4; index++) {
    const socket = sockets.at(-1);
    close(408, { data: { code: 'ECONNRESET', token: 'PRIVATE_TOKEN' } }, socket);
    close(401, {}, socket); // Late duplicate must not override evidence or schedule another connection.
    await tick();
    let diagnostic = client.diagnostics.snapshot();
    assert.equal(diagnostic.lastFailure.statusCode, 408);
    assert.equal(diagnostic.reconnectAttempts, Math.min(index + 1, 3));
    assert.equal(diagnostic.lastFailure.willRetry, index < 3);
    t.mock.timers.tick(5000); await tick();
    assert.equal(sockets.length, Math.min(index + 2, 4));
  }
  const diagnostic = client.diagnostics.snapshot();
  assert.equal(phases.at(-1), 'disconnected'); assert.equal(diagnostic.attempts, 4);
  assert.equal(diagnostic.lastFailure.retryDelayMs, 0); assert.equal(diagnostic.recentFailures.length, 4);
  assert.ok(connectionRequiredAction(diagnostic));
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
});

test('pairing restart has its own one-shot budget and terminal codes never reset credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sockets, phases, close } = fixture(); t.after(() => client.close());
  await client.connect(); const creds = client.data.creds;
  close(515); await tick(); t.mock.timers.tick(1000); await tick();
  assert.equal(sockets.length, 2); assert.equal(client.diagnostics.snapshot().reconnectAttempts, 0);
  close(515); await tick(); t.mock.timers.tick(60000); await tick();
  assert.equal(sockets.length, 2); assert.equal(phases.at(-1), 'disconnected');
  assert.equal(client.diagnostics.snapshot().pairingRestartUsed, true); assert.equal(client.data.creds, creds);
  assert.deepEqual(client.data.attempts, {});
  for (const code of [401, 403, 411, 440, 500, 405, undefined]) {
    await client.connect(); close(code); await tick();
    assert.equal(phases.at(-1), code === 401 ? 'relink_required' : 'disconnected');
    assert.equal(client.diagnostics.snapshot().lastFailure.statusCode, code ?? null);
    assert.equal(client.data.creds, creds);
  }
});

test('recovery keeps previous failure evidence and reports readiness independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sockets, close } = fixture(); t.after(() => client.close());
  await client.connect(); close(428); await tick(); t.mock.timers.tick(1500); await tick();
  sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await tick();
  const diagnostic = client.diagnostics.snapshot();
  assert.equal(diagnostic.stage, 'ready'); assert.equal(diagnostic.everConnected, true);
  assert.ok(diagnostic.lastConnectedAt); assert.equal(diagnostic.lastFailure.statusCode, 428);
  assert.equal(connectionRequiredAction(diagnostic), null);
});

test('receipt, exception and HTTP boundaries reproject only bounded safe evidence', async () => {
  const diagnostics = new ConnectionDiagnostics(); diagnostics.connecting();
  for (let index = 0; index < 9; index++) diagnostics.disconnected({ output: { statusCode: 440 }, message: 'PRIVATE_ERROR',
    data: { token: 'PRIVATE_TOKEN', packet: { body: 'PRIVATE_BODY' } } }, {
    willRetry: false, retryDelayMs: 0, reconnectAttempts: 0, pairingRestartUsed: false,
  });
  diagnostics.phase('disconnected');
  const raw = { ...diagnostics.snapshot(), message: 'PRIVATE_MESSAGE', recentFailures: diagnostics.snapshot().recentFailures.map(failure => ({
    ...failure, reason: 'PRIVATE_REASON', nextAction: 'PRIVATE_ACTION', raw: 'PRIVATE_RAW',
  })) };
  const safe = connectionDiagnosticsFields({ connectionDiagnostics: raw });
  assert.equal(safe.connectionDiagnostics.recentFailures.length, 5);
  assert.equal(safe.connectionDiagnostics.lastFailure.reason, 'connection_replaced');
  assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
  assert.deepEqual(connectionDiagnosticsFields({ connectionDiagnostics: { ...raw, attempts: Infinity } }), {});
  const error = new RuntimeError('session_not_ready', { connectionDiagnostics: raw });
  assert.deepEqual(connectionDiagnosticsFields(error), safe);
  const server = http.createServer((_req, response) => { response.writeHead(400); response.end(JSON.stringify({ error: 'session_not_ready', connectionDiagnostics: raw })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(requestControl({ port: server.address().port, token: 'a'.repeat(64) }, { command: 'status' }), error => {
      assert.deepEqual(connectionDiagnosticsFields(error), safe); return true;
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('terminal connection failures finish wait with diagnostics instead of another pending loop', async () => {
  for (const phase of ['disconnected', 'relink_required']) {
    const sessionId = '10000000-0000-4000-8000-000000000001';
    const diagnostics = new ConnectionDiagnostics(); diagnostics.connecting();
    diagnostics.disconnected({ output: { statusCode: 401 } }, { willRetry: false,
      retryDelayMs: 0, reconnectAttempts: 0, pairingRestartUsed: false }); diagnostics.phase(phase);
    const state = { sessionId, phase, connectionDiagnostics: diagnostics.snapshot() };
    const result = await waitForSessionChange(async () => state, { '--session': sessionId, '--after-phase': phase });
    assert.equal(result.continuation, undefined); assert.equal(result.connectionDiagnostics.lastFailure.statusCode, 401);
    assert.equal(withSessionContinuation(state).continuation, undefined);
  }
});

test('async provider exceptions retain a safe source without returning exception text', async () => {
  const { client, sockets, fatals } = fixture();
  await client.connect();
  client.save = async () => { throw Object.assign(new Error('PRIVATE_PACKET'), { output: { statusCode: 503 }, data: { token: 'PRIVATE_TOKEN' } }); };
  sockets.at(-1).ev.emit('creds.update', {}); await tick();
  const diagnostic = client.diagnostics.snapshot();
  assert.equal(diagnostic.stage, 'failed'); assert.equal(diagnostic.lastFailure.source, 'operation');
  assert.equal(diagnostic.lastFailure.statusCode, 503); assert.equal(diagnostic.lastFailure.willRetry, false);
  assert.deepEqual(fatals, ['provider_operation_failed']); assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
  client.close();
});
