import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { accountBlock, accountRecoveryHelp, ACCOUNT_RECOVERY_URL, activeCredentialGate, AuthorizationAttempt, authorizationFailure, closedDiagnostics,
  credentialGate, recoveredCredentialGate } from '../scripts/auth-safety.mjs';
import { decryptRecord, encryptRecord, RuntimeError } from '../scripts/core.mjs';
import { EsiaAuthorizer } from '../scripts/esia-authorizer.mjs';
import { Portal } from '../scripts/browser.mjs';
import { safeAuthorizationFailure } from '../scripts/playwright-client.mjs';
import { parseArguments } from '../scripts/trelio-gosuslugi.mjs';

const blockedText = 'Доступ временно заблокирован\nВыявлена подозрительная активность с вашей учётной записью на Госуслугах.\n' +
  'Доступ будет разблокирован в течение 72\nчасов. Подтвердите личность с помощью биометрии.';
const credentials = { login: '+70000000000', password: 'synthetic-password', totp: 'JBSWY3DPEHPK3PXP' };
const request = { origin: 'https://service.example.org', sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(),
  token: 'synthetic-private-bearer', callback: 'https://service.example.org/callback?code=synthetic-private-code' };

test('account recovery is a fixed human flow and never applies to other login failures', () => {
  const help = accountRecoveryHelp('account_temporarily_blocked');
  assert.equal(help.url, 'https://www.gosuslugi.ru/679557/1/form');
  assert.equal(help.requiresUserAction, true);
  assert.ok(help.instruction.includes(help.url));
  assert.match(help.instruction, /самостоятельно.*проверку/);
  assert.match(help.instruction, /сообщите.*снятии/);
  assert.match(help.instruction, /Автоматический повтор.*остановлен/);
  assert.doesNotMatch(help.instruction, /72|биометрия обязательна/);
  help.url = 'https://untrusted.example.org/';
  assert.equal(accountRecoveryHelp('account_temporarily_blocked').url, ACCOUNT_RECOVERY_URL);
  for (const reason of [null, undefined, 'credentials_rejected', 'auth_timeout', 'challenge_required',
    'https://untrusted.example.org/?code=synthetic-private-code']) assert.equal(accountRecoveryHelp(reason), null);
});

test('closed blocked receipts rebuild trusted recovery guidance without copying private or injected links', () => {
  const gate = { reason: 'account_temporarily_blocked', retryAt: null };
  const receipt = closedDiagnostics({ credentialGate: gate,
    accountRecovery: { url: request.callback, instruction: 'synthetic-private-value' } });
  assert.deepEqual(receipt.credentialGate, gate);
  assert.deepEqual(receipt.accountRecovery, accountRecoveryHelp(gate.reason));
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-private|service\.example|code=/);
  assert.deepEqual(closedDiagnostics({ credentialGate: { reason: 'credentials_rejected', retryAt: null },
    accountRecovery: { url: ACCOUNT_RECOVERY_URL } }), { credentialGate: { reason: 'credentials_rejected', retryAt: null } });
  assert.deepEqual(closedDiagnostics({ credentialGate: { reason: 'account_temporarily_blocked', retryAt: 'invalid' },
    accountRecovery: { url: ACCOUNT_RECOVERY_URL } }), {});
  const manual = closedDiagnostics({ authorization: { origin: request.origin, browserSessionId: request.sessionId,
    requestId: request.requestId, status: 'user_required', manualReason: 'account_temporarily_blocked' } });
  assert.equal(manual.accountRecovery.url, ACCOUNT_RECOVERY_URL);
});

test('account block takes a bounded duration only from the observed unblock promise', () => {
  assert.deepEqual(accountBlock(blockedText), { reason: 'account_temporarily_blocked', retryAfterHours: 72 });
  assert.deepEqual(accountBlock('Учётная запись временно заблокирована'), {
    reason: 'account_temporarily_blocked', retryAfterHours: null });
  for (const text of ['Доступ временно заблокирован. 72 часа назад вы вошли',
    'Доступ временно заблокирован. Доступ будет разблокирован в течение 999 часов',
    'Доступ временно заблокирован. Доступ будет разблокирован в течение 0 часов'])
    assert.equal(accountBlock(text).retryAfterHours, null, 'unrelated or invalid numbers cannot authorize retry');
  assert.equal(accountBlock('Если доступ заблокирован, обратитесь в поддержку. Введите пароль'), null);
});

test('a refusal survives an encrypted round-trip, retains legacy state and expires only at its observed deadline', () => {
  const identity = { company: crypto.randomUUID(), member: crypto.randomUUID() }, key = crypto.randomBytes(32);
  const observedAt = 1_790_000_000_000;
  const original = { schema: 1, credentials, storageRole: 'personal', storage: { cookies: [], origins: [] },
    legacyServiceData: { synthetic: true }, authGate: credentialGate('account_temporarily_blocked', 72, observedAt) };
  const ciphertext = encryptRecord(key, identity, original);
  assert.doesNotMatch(ciphertext, /synthetic-password|account_temporarily_blocked|observedAt/);
  const reopened = decryptRecord(key, identity, ciphertext);
  assert.deepEqual(reopened, original);
  assert.deepEqual(activeCredentialGate(reopened.authGate, observedAt + 71 * 3600000), {
    reason: 'account_temporarily_blocked', retryAt: observedAt + 72 * 3600000 });
  assert.equal(activeCredentialGate(reopened.authGate, observedAt + 72 * 3600000), null);
  const refused = credentialGate('credentials_rejected', null, observedAt);
  assert.equal(activeCredentialGate(refused, observedAt + 365 * 86400000).reason, 'credentials_rejected');
  for (const invalid of [{ ...refused, reason: 'private account text' }, { ...refused, retryAt: observedAt + 1 },
    { ...original.authGate, retryAt: observedAt + 169 * 3600000 }, { ...refused, schema: 2 }])
    assert.throws(() => activeCredentialGate(invalid), /auth_gate_invalid/);
  assert.throws(() => decryptRecord(key, { ...identity, member: crypto.randomUUID() }, ciphertext), /vault_corrupt/);
  key.fill(0);
});

function authorizerFixture(gate = null) {
  let retained = gate, observed = blockedText, returned = false;
  const packets = [], phases = [], refusals = [];
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async phase => phases.push(phase),
    getCredentialGate: () => activeCredentialGate(retained),
    onAuthRefused: async (reason, hours = null) => {
      refusals.push(reason);
      retained ??= credentialGate(reason, hours);
    } });
  authorizer.call = async (command, extra = {}) => {
    packets.push({ command, ...extra });
    if (command === 'auth-state') return { atAuth: !returned, returned, postCount: 0 };
    if (command === 'auth-operation' && extra.operation === 'observe') return { text: observed, queries: {} };
    if (['show', 'complete'].includes(command)) return {};
    throw Error('credential or other action dispatched after a refusal');
  };
  return { authorizer, packets, phases, refusals, gate: () => retained,
    text: value => { observed = value; }, returnCallback: () => { returned = true; } };
}

test('blocked ESIA cannot type login, password, TOTP or click again on resume or a fresh authorizer', async () => {
  const first = authorizerFixture();
  assert.equal(await first.authorizer.authenticate(credentials), false);
  assert.equal(first.authorizer.manualReason, 'account_temporarily_blocked');
  assert.equal(await first.authorizer.authenticate(credentials), false);
  assert.equal(first.packets.filter(packet => packet.command === 'show').length, 1, 'same blocker never steals focus again');
  const next = authorizerFixture(first.gate());
  next.text('Введите пароль');
  assert.equal(await next.authorizer.authenticate(credentials), false, 'new sent flags cannot bypass the saved gate');
  assert.equal(next.authorizer.manualReason, 'account_temporarily_blocked');
  assert.equal(next.packets.some(packet => packet.operation === 'type' || packet.operation === 'click'), false);
  next.returnCallback();
  assert.equal(await next.authorizer.authenticate(credentials), true, 'human completion can return the same transaction');
  assert.equal(next.authorizer.completed, true);
});

test('a rejected credential blocks a fresh authorizer without treating it as a timed account block', async () => {
  const first = authorizerFixture(); first.text('Неверный пароль');
  assert.equal(await first.authorizer.authenticate(credentials), false);
  assert.equal(first.authorizer.manualReason, 'credentials_rejected');
  assert.equal(first.gate().retryAt, null);
  const next = authorizerFixture(first.gate()); next.text('Вход по QR-коду. Логин и пароль');
  assert.equal(await next.authorizer.authenticate(credentials), false);
  assert.equal(next.authorizer.manualReason, 'credentials_rejected');
});

test('an explicit account recovery releases only its exact gate and needs a confirmed command', () => {
  const blocked = credentialGate('account_temporarily_blocked', 72), refused = credentialGate('credentials_rejected');
  assert.throws(() => recoveredCredentialGate(blocked, false), /account_recovery_confirmation_required/);
  assert.equal(recoveredCredentialGate(blocked, true), undefined);
  assert.equal(recoveredCredentialGate(refused, true), refused);
  const session = crypto.randomUUID();
  assert.throws(() => parseArguments(['resume', '--session', session, '--account-recovered']), /account_recovery_confirmation_required/);
  assert.equal(parseArguments(['resume', '--session', session, '--account-recovered', '--confirm']).options['--account-recovered'], true);
  assert.throws(() => parseArguments(['status', '--session', session, '--account-recovered', '--confirm']), /unsupported_option/);
  assert.equal(parseArguments(['start', '--confirm', '--account-recovered']).options['--account-recovered'], true);
});

test('ordinary portal stops at an account block before inspecting or entering any form field', async () => {
  const phases = [], refusals = [];
  const portal = new Portal(null, async () => {}, { onPhase: phase => phases.push(phase),
    persist: async () => { throw Error('blocked portal cannot save authenticated state'); },
    askCode: async () => { throw Error('blocked portal cannot ask for OTP'); },
    onAuthRefused: async (reason, hours) => refusals.push({ reason, hours }) });
  portal.inspectAuth = async () => ({ text: blockedText });
  assert.equal(await portal.authenticate(credentials), false);
  assert.deepEqual(refusals, [{ reason: 'account_temporarily_blocked', hours: 72 }]);
  assert.deepEqual(phases, ['authenticating', 'user_required']);
  assert.equal(portal.manualReason, 'account_temporarily_blocked');
});

test('ordinary portal cannot select another login method when a previous process saved a refusal', async () => {
  const gate = credentialGate('account_temporarily_blocked', 72);
  const portal = new Portal(null, async () => {}, { onPhase: () => {}, getCredentialGate: () => activeCredentialGate(gate) });
  portal.page = { url: () => 'https://esia.gosuslugi.ru/login' };
  portal.inspectAuth = async () => ({ text: 'Логин и пароль', qrChoice: true });
  portal.authSubmit = async () => { throw Error('saved refusal must precede the QR click'); };
  assert.equal(await portal.authenticate(credentials), false);
  assert.equal(portal.manualReason, 'account_temporarily_blocked');
});

test('restoring ready portal state cannot turn a lost external login into success or authorize resume', () => {
  const attempt = new AuthorizationAttempt(request);
  attempt.observePhase('authenticating');
  attempt.fail(authorizationFailure(new RuntimeError('session_unreachable')));
  attempt.observePhase('ready');
  attempt.observePhase('authorized');
  assert.throws(() => attempt.requireResume(), /authorization_retry_required/);
  assert.deepEqual(attempt.publicState(), { origin: request.origin, browserSessionId: request.sessionId,
    requestId: request.requestId, status: 'failed', error: 'authorization_session_lost' });
  assert.doesNotMatch(JSON.stringify(attempt.publicState()), /bearer|callback|private-code/);
  const completed = new AuthorizationAttempt(request);
  completed.observePhase('user_required', 'challenge_required');
  completed.requireResume();
  completed.observePhase('authorized');
  completed.fail(new RuntimeError('guardian_unavailable'));
  assert.equal(completed.publicState().status, 'callback_verified');
  assert.throws(() => completed.requireResume(), /authorization_already_completed/);
});

test('exact peer failure and closed diagnostics retain only safe target and stage evidence', () => {
  const failure = new RuntimeError('service_http_error', { httpStatus: 503, httpOrigin: request.origin });
  assert.equal(authorizationFailure(failure), failure);
  const attempt = new AuthorizationAttempt(request); attempt.fail(failure);
  const receipt = closedDiagnostics({ error: failure.code, ...failure, failureStage: 'authorization_claim',
    authorization: { ...attempt.publicState(), token: request.token, callback: request.callback }, raw: 'synthetic-private-value' });
  assert.equal(receipt.failureStage, 'authorization_claim');
  assert.equal(receipt.authorization.httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(receipt), /private|callback\?/);
  assert.deepEqual(closedDiagnostics({ error: 'private error /path', failureStage: 'raw private message',
    authorization: { ...attempt.publicState(), origin: request.callback } }), {});
  assert.deepEqual(safeAuthorizationFailure(Error('password=synthetic-private-value')), { error: 'authorization_result_unknown' });
  assert.deepEqual(safeAuthorizationFailure(failure), { error: 'service_http_error', httpStatus: 503, httpOrigin: request.origin });
});

test('idle peer failure preserves an observed HTTP rejection instead of converting it to portal ready', { timeout: 5000 }, async t => {
  const authorizer = new EsiaAuthorizer({}, { permit: async () => {}, onPhase: async () => {} });
  t.after(() => clearInterval(authorizer.peerTimer));
  authorizer.call = async () => ({ failed: 'service_http_error', httpStatus: 503, httpOrigin: request.origin });
  const error = await new Promise(resolve => {
    authorizer.watchPeer({ isBusy: () => false,
      onReturned: () => { throw Error('failed callback is not a return'); }, onLost: resolve });
    // The real worker has an IPC server/native guardian keeping its loop alive.
    // This isolated test has neither: retain the production-unref'ed timer only
    // here so a fast runner cannot exit before the first peer observation.
    authorizer.peerTimer.ref();
  });
  assert.equal(error.code, 'service_http_error');
  assert.equal(error.httpStatus, 503);
});
