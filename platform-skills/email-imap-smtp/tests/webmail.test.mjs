import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveWebmailSettings, runWebmail, stableHttpsAddress, standardWebmailAddress } from '../scripts/webmail.mjs';

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
  assert.equal((await runWebmail({ mailbox, operation: 'setup', edit: true }, host)).state, 'manual_input_required');
  assert.deepEqual(await host.readSettings(), configured);
  assert.deepEqual(host.calls, [{ origins: ['https://mail.example.test', 'https://auth.example.org', 'https://example.org'],
    presentation: 'windowed', observationMode: 'text', semanticControls: true,
    operation: 'setup', args: { url } }]);
  const amended = resolveWebmailSettings({ ...fields, authOrigins: 'https://sso.new.example' }, mailbox, configured);
  assert.deepEqual(amended.origins, [...configured.origins, 'https://sso.new.example']);
  assert.throws(() => resolveWebmailSettings({ ...fields, url: 'https://other.example.test/' }, mailbox, configured),
    { code: 'EMAIL_WEBMAIL_PROFILE_MISMATCH' });
});

test('ordinary setup opens known providers directly without a routing form', async () => {
  for (const [address, expected] of [
    ['reader@mail.ru', 'https://e.mail.ru/inbox/'],
    ['reader@bk.ru', 'https://e.mail.ru/inbox/'],
    ['reader@gmail.com', 'https://mail.google.com/mail/'],
    ['reader@googlemail.com', 'https://mail.google.com/mail/'],
    ['reader@ya.ru', 'https://mail.yandex.ru/'],
  ]) {
    const host = fixture(null, [{ state: 'manual_input_required' }]);
    host.collectSettings = () => assert.fail('known provider must not ask for a URL');
    assert.equal((await runWebmail({ mailbox: address, operation: 'setup' }, host)).state, 'manual_input_required');
    assert.equal(host.calls[0].args.url, expected);
    assert.equal((await host.readSettings()).url, expected);
    assert.equal((await host.readSettings()).mailbox, address);
    assert.ok((await host.readSettings()).origins.length > 1);
  }
});

test('custom-domain routing uses exact saved protocol hosts without guessing from the domain', () => {
  assert.equal(standardWebmailAddress(mailbox, { imapHost: 'IMAP.GMAIL.COM' }), 'https://mail.google.com/mail/');
  assert.equal(standardWebmailAddress(mailbox, { smtpHost: 'smtp.mail.ru' }), 'https://e.mail.ru/inbox/');
  assert.equal(standardWebmailAddress(mailbox, { imapHost: 'imap.gmail.com', smtpHost: 'smtp.mail.ru' }), null);
  for (const unknown of ['reader@corp.test', 'reader@sub.mail.ru', 'reader@mail.ru.example', 'reader@notgmail.com']) {
    assert.equal(standardWebmailAddress(unknown), null);
  }
  assert.equal(standardWebmailAddress(mailbox, { imapHost: 'imap.gmail.com.example' }), null);
});

test('an officially discovered custom URL and SSO origins can be configured without a form', async () => {
  const host = fixture(null, [{ state: 'manual_input_required' }]);
  host.collectSettings = () => assert.fail('verified public routing needs no form');
  await runWebmail({ mailbox, operation: 'setup', url, authOrigins: authOrigins.split('\n') }, host);
  assert.equal(host.calls[0].args.url, url);
  assert.deepEqual((await host.readSettings()).origins, configured.origins);
});

test('unresolved providers request discovery before any browser or configuration form', async () => {
  const host = fixture(null);
  host.collectSettings = () => assert.fail('agent should search first');
  assert.equal((await runWebmail({ mailbox, operation: 'setup' }, host)).code, 'EMAIL_WEBMAIL_ADDRESS_DISCOVERY_REQUIRED');
  assert.deepEqual(host.calls, []);
  assert.equal(await host.readSettings(), null);
});

test('the real CLI opens known and discovered sites without invoking the routing form', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-routing-cli-'));
  try {
    // This is a synthetic host module set with no browser, private account or
    // credential access. The actual signed sibling entrypoint and private
    // stdin protocol execute in a separate Node process on every OS.
    fs.writeFileSync(path.join(root, 'trelio-workspace.mjs'), `
      import fs from 'node:fs';
      import path from 'node:path';
      export const LOCAL_FORM_API = 'trelio.local-form/v1';
      export const resolveWorkspaceBridgeConfigDirectory = () => process.env.SYNTHETIC_WEBMAIL_ROOT;
      export const readPrivateJsonFile = async file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
      export const writePrivateJsonFile = async (file, value) => {
        fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value));
      };
    `);
    fs.writeFileSync(path.join(root, 'trelio-visual-session.mjs'), `
      export const VISUAL_SEMANTIC_CONTROLS_API = 'trelio.visual-semantic-controls/v1';
      export const visualSessionBinding = () => ({skillId:'email-imap-smtp', scope:'synthetic-account'});
      export const runVisualSession = async options => ({state:'manual_input_required', opened:options.args.url});
    `);
    fs.writeFileSync(path.join(root, 'trelio-visual-bootstrap.mjs'), `
      import fs from 'node:fs';
      export const prepareVisualPrivateDirectory = async dir => fs.mkdirSync(dir, {recursive:true});
    `);
    fs.writeFileSync(path.join(root, 'trelio-browser-session.mjs'),
      'export const withBrowserAccountState = async (_dir, action) => action();');
    fs.writeFileSync(path.join(root, 'trelio-remote-mcp.mjs'),
      'export const collectCredentialThroughLoopback = () => { throw new Error("UNEXPECTED_FORM"); };');
    const requests = [
      { mailbox: 'reader@list.ru', operation: 'setup' },
      { mailbox, operation: 'setup', url, authOrigins: ['https://sso.identity.test'] },
    ];
    for (const [index, request] of requests.entries()) {
      const storage = path.join(root, String(index));
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/webmail.mjs', import.meta.url))], {
        input: JSON.stringify(request), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, SYNTHETIC_WEBMAIL_ROOT: storage,
          TRELIO_VISUAL_SESSION_MODULE_URL: pathToFileURL(path.join(root, 'trelio-visual-session.mjs')).href,
          TRELIO_LOCAL_FORM_MODULE_URL: pathToFileURL(path.join(root, 'trelio-workspace.mjs')).href },
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stderr, '');
      const output = JSON.parse(cli.stdout);
      assert.equal(output.state, 'manual_input_required');
      assert.equal(output.opened, request.url ?? 'https://e.mail.ru/inbox/');
      const saved = JSON.parse(fs.readFileSync(path.join(storage, 'visual-browser', 'synthetic-account', 'webmail.json')));
      assert.equal(saved.mailbox, request.mailbox);
      assert.equal(saved.url, output.opened);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup reuses the saved custom route for a known email domain', async () => {
  const address = 'reader@mail.ru';
  const settings = resolveWebmailSettings({ ...fields, accountControl: `Почтовый аккаунт (${address})` }, address);
  const host = fixture(settings, [{ state: 'manual_input_required' }]);
  host.collectSettings = () => assert.fail('saved routing must be reused');
  host.writeSettings = () => assert.fail('unchanged settings need no write');
  await runWebmail({ mailbox: address, operation: 'setup' }, host);
  assert.equal(host.calls[0].args.url, url);
});

test('automatic settings refuse a concurrent replacement and a live route change', async () => {
  const host = fixture(null);
  host.withSettingsLock = async action => {
    await host.writeSettings(configured);
    return action();
  };
  await assert.rejects(() => runWebmail({ mailbox, operation: 'setup', url }, host),
    { code: 'EMAIL_WEBMAIL_SETTINGS_CHANGED' });
  assert.deepEqual(host.calls, []);
  const live = fixture(configured, [{ state: 'manual_input_required' }]);
  await assert.rejects(() => runWebmail({ mailbox, operation: 'setup', authOrigins: ['https://new-sso.example'] }, live),
    { code: 'EMAIL_WEBMAIL_CLOSE_BEFORE_SETUP' });
  assert.deepEqual(await live.readSettings(), configured);
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
  for (const [url, origins] of [
    ['https://mail.google.com/mail/', ['https://accounts.google.com', 'https://google.com']],
    ['https://mail.yandex.ru/', ['https://passport.yandex.ru', 'https://yandex.ru']],
    ['https://e.mail.ru/inbox/', ['https://account.mail.ru', 'https://mail.ru',
      'https://id.vk.com', 'https://login.vk.com', 'https://vk.com']],
  ]) {
    assert.deepEqual(resolveWebmailSettings({ url, authOrigins: '', accountControl: '' }, mailbox).origins,
      [new URL(url).origin, ...origins]);
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
