import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { buildRuntimePackage } from './build-runtime-package.mjs';
import { fileURLToPath } from 'node:url';

const sessionId = '11111111-1111-4111-8111-111111111111';
const providers = { gosuslugi: 'trelio-gosuslugi', 't-bank': 'trelio-t-bank',
  'whatsapp-web': 'trelio-whatsapp', 'gas-pravosudie': 'trelio-gas-pravosudie' };
const options = { '--session': sessionId, '--after-phase': 'credentials_required', '--timeout-seconds': '1' };

for (const [skill, cli] of Object.entries(providers)) {
  const runtime = await import(`../${skill}/scripts/session-wait.mjs`);
  const parser = await import(`../${skill}/scripts/${cli}.mjs`);
  test(`${skill}: submit completion is observable without a chat message or replay`, async () => {
    let clock = 0, reads = 0;
    const result = await runtime.waitForSessionChange(async budget => {
      assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 1000);
      return { sessionId, phase: ++reads === 1 ? 'credentials_required' : 'configured', expiresAt: 12345 };
    }, options, { now: () => clock, sleep: async ms => { clock += ms; } });
    assert.equal(reads, 2);
    assert.equal(result.phase, 'configured');
    assert.equal(result.expiresAt, 12345, 'wait must not renew the procedure');
    assert.deepEqual(result.wait, { changed: true, timedOut: false });
    assert.equal(result.continuation, undefined);
  });
  test(`${skill}: pending returns a bounded exact continuation; another step returns immediately`, async () => {
    let clock = 0;
    const state = { sessionId, phase: 'credentials_required', expiresAt: 12345 };
    const pending = await runtime.waitForSessionChange(async () => state, options,
      { now: () => clock, sleep: async ms => { clock += ms; } });
    assert.equal(clock, 1000);
    assert.deepEqual(pending.wait, { changed: false, timedOut: true });
    const parsed = parser.parseArguments(pending.continuation.arguments);
    assert.equal(parsed.command, 'wait');
    assert.equal(parsed.options['--session'], sessionId);
    const challenge = await runtime.waitForSessionChange(async () => ({ ...state, phase: 'code_required' }), options);
    assert.equal(challenge.phase, 'code_required');
    assert.equal(challenge.wait.timedOut, false);
    assert.equal(challenge.continuation.arguments[4], 'code_required');
    assert.equal(runtime.withSessionContinuation(state).continuation.arguments[4], 'credentials_required');
    const ready = { sessionId, phase: 'ready' };
    assert.equal(runtime.withSessionContinuation(ready), ready, 'reused ready session needs no continuation');
    for (const seconds of ['0', '31', '1.5', '01', '-1']) assert.throws(() =>
      parser.parseArguments(['wait', '--session', sessionId, '--after-phase', 'starting', '--timeout-seconds', seconds]));
    assert.throws(() => parser.parseArguments(['wait', '--session', sessionId]));
    assert.throws(() => parser.parseArguments([...pending.continuation.arguments, '--confirm']));
  });
  test(`${skill}: terminal failure, expiry and session mismatch never become successful input`, async () => {
    for (const phase of ['closed', 'failed', 'authorization_failed']) {
      const failure = await runtime.waitForSessionChange(async () => ({ sessionId, phase, error: 'session_expired' }), options);
      assert.equal(failure.error, 'session_expired');
      assert.equal(failure.continuation, undefined);
    }
    await assert.rejects(runtime.waitForSessionChange(async () => ({ sessionId: 'other', phase: 'ready' }), options),
      /exact_session_required/);
    const denied = Object.assign(new Error('scope_denied'), { code: 'scope_denied' });
    let calls = 0;
    await assert.rejects(runtime.waitForSessionChange(async () => { calls++; throw denied; }, options), /scope_denied/);
    assert.equal(calls, 1, 'authority errors must not be retried');
    assert.equal(runtime.finishedReceiptPhase({ sessionId, phase: 'configured' }, sessionId), 'configured');
    assert.equal(runtime.finishedReceiptPhase({ sessionId, phase: 'configured', error: 'storage_failed' }, sessionId), 'closed');
    assert.equal(runtime.finishedReceiptPhase({ sessionId, phase: 'ready' }, sessionId), 'closed');
    assert.equal(runtime.finishedReceiptPhase({ sessionId: 'other', phase: 'configured' }, sessionId), 'closed');
  });
  test(`${skill}: waiting code is delivered in the signed package`, async () => {
    const built = buildRuntimePackage(fileURLToPath(new URL(`../${skill}/`, import.meta.url)));
    const pkg = JSON.parse(built.packageBytes.toString('utf8'));
    const source = await fs.readFile(new URL(`../${skill}/scripts/session-wait.mjs`, import.meta.url));
    const packaged = pkg.files.find(file => file.path === 'scripts/session-wait.mjs');
    assert.ok(packaged);
    assert.deepEqual(Buffer.from(packaged.contentBase64, 'base64'), source);
  });
}

test('safe status retries are bounded and never replay a different command', async () => {
  const { waitForSessionChange } = await import('../gosuslugi/scripts/session-wait.mjs');
  let clock = 0, calls = 0;
  const result = await waitForSessionChange(async () => {
    if (++calls <= 3) throw Object.assign(new Error('session_unreachable'), { code: 'session_unreachable' });
    return { sessionId, phase: 'ready' };
  }, { ...options, '--timeout-seconds': '30' }, { now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(calls, 4); assert.equal(result.phase, 'ready'); assert.equal(clock, 1500);
});
