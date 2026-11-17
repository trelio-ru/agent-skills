import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWebmailSettings, runWebmail, stableHttpsAddress } from '../scripts/webmail.mjs';

const mailbox = 'reader@example.test';
const label = `Почтовый аккаунт (${mailbox})`;
const url = 'https://mail.example.test/roundcube/';
const authOrigins = 'https://auth.example.org\nhttps://example.org';
const fields = { url, authOrigins, accountControl: label };
const configured = resolveWebmailSettings(fields, mailbox);
const status = { state: 'saved_unverified', hasStoredSession: true };
const accountControl = { role: 'button', label };
const text = controls => ({ kind: 'trelio.browser-text/v1', state: 'ready',
  sessionId: 'synthetic-worker', controls, text: 'Synthetic visible mail' });

function fixture(initial, replies = []) {
  let settings = initial;
  const calls = [];
  return {
    calls,
    visual: async request => {
      calls.push(request);
      assert.ok(replies.length, 'unexpected browser command');
      return replies.shift();
    },
    readSettings: async () => settings,
    writeSettings: async candidate => { settings = candidate; },
    withSettingsLock: async callback => callback(),
    collectSettings: async ({ validate, persist }) => {
      const candidate = validate(fields);
      await persist(candidate);
      return candidate;
    },
  };
}

test('custom mailbox URL and explicit SSO origins stay bound to the same profile', async () => {
  const host = fixture(null, [{ state: 'manual_input_required' }]);
  assert.equal((await runWebmail({ mailbox, operation: 'setup' }, host)).state, 'manual_input_required');
  assert.deepEqual(await host.readSettings(), configured);
  assert.deepEqual(host.calls, [{ origins: ['https://mail.example.test', 'https://auth.example.org', 'https://example.org'],
    presentation: 'windowed', observationMode: 'text', semanticControls: true,
    operation: 'setup', args: { url } }]);
  const amended = resolveWebmailSettings({ ...fields, authOrigins: 'https://sso.new.example' }, mailbox, configured);
  assert.deepEqual(amended.origins, [...configured.origins, 'https://sso.new.example']);
  assert.throws(() => resolveWebmailSettings({ ...fields, url: 'https://other.example.test/' }, mailbox, configured),
    { code: 'EMAIL_WEBMAIL_PROFILE_MISMATCH' });
});

test('setup rejects callback, credential-bearing and non-HTTPS addresses', () => {
  for (const input of ['http://mail.example.test/', 'https:example.test',
    'https://user:pass@mail.example.test/', 'https://mail.example.test/?code=foo',
    'https://mail.example.test/#access_token=foo', 'https://mail.example.test/\n']) {
    assert.throws(() => stableHttpsAddress(input), { code: 'EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS' });
  }
  assert.throws(() => resolveWebmailSettings({ ...fields, authOrigins: 'https://sso.example.test/continue' }, mailbox),
    { code: 'EMAIL_WEBMAIL_INVALID_AUTH_ORIGIN' });
});

test('common webmail addresses retain their known SSO and parent cookie origins', () => {
  for (const [url, auth, parent] of [
    ['https://mail.google.com/mail/', 'https://accounts.google.com', 'https://google.com'],
    ['https://mail.yandex.ru/', 'https://passport.yandex.ru', 'https://yandex.ru'],
    ['https://e.mail.ru/inbox/', 'https://account.mail.ru', 'https://mail.ru'],
  ]) {
    assert.deepEqual(resolveWebmailSettings({ url, authOrigins: '', accountControl: '' }, mailbox).origins,
      [new URL(url).origin, auth, parent]);
  }
});

test('unconfigured status does not start a browser and another mailbox cannot reuse the route', async () => {
  const host = fixture(null);
  assert.equal((await runWebmail({ mailbox, operation: 'status' }, host)).code, 'EMAIL_WEBMAIL_SETUP_AVAILABLE');
  assert.deepEqual(host.calls, []);
  const foreign = fixture(configured);
  await assert.rejects(() => runWebmail({ mailbox: 'other@example.test', operation: 'view' }, foreign),
    { code: 'EMAIL_WEBMAIL_PROFILE_MISMATCH' });
  assert.deepEqual(foreign.calls, []);
});

test('authorization session can restore and hand off its existing owned window', async () => {
  const host = fixture(configured, [status, { state: 'manual_input_required' }, status]);
  assert.equal(await runWebmail({ mailbox, operation: 'status' }, host), status);
  assert.equal((await runWebmail({ mailbox, operation: 'open' }, host)).state, 'manual_input_required');
  assert.equal(await runWebmail({ mailbox, operation: 'ready' }, host), status);
  assert.deepEqual(host.calls.map(item => item.operation), ['status', 'setup', 'ready']);
  assert.ok(host.calls.every(item => JSON.stringify(item.origins) === JSON.stringify(configured.origins)));
});

test('a fresh view suppresses mailbox text until the unique exact account control is present', async () => {
  const wrong = text([{ role: 'link', label: mailbox }]);
  const invalid = fixture(configured, [status, wrong, wrong]);
  const refusal = await runWebmail({ mailbox, operation: 'view' }, invalid);
  assert.equal(refusal.code, 'EMAIL_WEBMAIL_MAILBOX_UNVERIFIED');
  assert.equal(refusal.text, undefined);
  const confirmed = text([accountControl]);
  const host = fixture(configured, [status, wrong, confirmed]);
  assert.equal(await runWebmail({ mailbox, operation: 'view' }, host), confirmed);
  assert.deepEqual(host.calls.at(-1).args, { includeControls: true, controlQuery: label });
  const ambiguous = fixture(configured, [text([accountControl, accountControl])]);
  assert.equal((await runWebmail({ mailbox, operation: 'read', offset: 1 }, ambiguous)).code,
    'EMAIL_WEBMAIL_MAILBOX_UNVERIFIED');
});

test('a webmail without a verifiable account control remains available to the human', async () => {
  const settings = resolveWebmailSettings({ ...fields, accountControl: '' }, mailbox);
  const host = fixture(settings, [{ state: 'manual_input_required' }]);
  assert.equal((await runWebmail({ mailbox, operation: 'view' }, host)).code, 'EMAIL_WEBMAIL_ACCOUNT_CONTROL_REQUIRED');
  assert.deepEqual(host.calls, []);
  assert.equal((await runWebmail({ mailbox, operation: 'open' }, host)).state, 'manual_input_required');
});

test('follow uses a fresh, unique, same-origin UI link and checks identity again', async () => {
  const link = { role: 'link', label: 'Входящие', url: 'https://mail.example.test/roundcube/?_task=mail#inbox' };
  const confirmed = text([accountControl]);
  const host = fixture(configured, [confirmed, text([link]), text([]), confirmed]);
  assert.equal(await runWebmail({ mailbox, operation: 'follow', label: link.label }, host), confirmed);
  assert.deepEqual(host.calls.map(item => item.operation), ['read-text', 'read-text', 'navigate', 'read-text']);
  assert.deepEqual(host.calls[2].args, { url: link.url });
  for (const links of [[link, link], [{ ...link, url: 'https://auth.example.org/' }], [{ ...link, role: 'button' }]]) {
    const denied = fixture(configured, [confirmed, text(links)]);
    assert.equal((await runWebmail({ mailbox, operation: 'follow', label: link.label }, denied)).code,
      'EMAIL_WEBMAIL_LINK_UNVERIFIED');
    assert.ok(denied.calls.every(call => call.operation === 'read-text'));
  }
});
