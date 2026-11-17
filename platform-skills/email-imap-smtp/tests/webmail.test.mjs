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

test('custom mailbox URL opens without a site or account-label restriction', async () => {
  const host = fixture(null, [{ state: 'manual_input_required' }]);
  assert.equal((await runWebmail({ mailbox, operation: 'setup', edit: true }, host)).state, 'manual_input_required');
  assert.deepEqual(await host.readSettings(), configured);
  assert.deepEqual(host.calls, [{ origins: ['https://mail.example.test'], externalNavigation: true, profileAuthentication: true,
    presentation: 'windowed', observationMode: 'text', semanticControls: true,
    operation: 'setup', args: { url } }]);
  const changed = resolveWebmailSettings({ url: 'https://other.example.test/' }, mailbox, configured);
  assert.equal(changed.url, 'https://other.example.test/');
  assert.equal(changed.schemaVersion, 2);
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
    assert.equal(host.calls[0].externalNavigation, true);
    assert.equal(host.calls[0].profileAuthentication, true);
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

test('an officially discovered custom URL opens without a form', async () => {
  const host = fixture(null, [{ state: 'manual_input_required' }]);
  host.collectSettings = () => assert.fail('verified public routing needs no form');
  await runWebmail({ mailbox, operation: 'setup', url, authOrigins: authOrigins.split('\n') }, host);
  assert.equal(host.calls[0].args.url, url);
  assert.deepEqual(await host.readSettings(), configured);
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
      export const VISUAL_PROFILE_AUTH_API = 'trelio.visual-profile-auth/v1';
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

test('automatic settings preserve a concurrent replacement', async () => {
  const host = fixture(null);
  host.withSettingsLock = async action => {
    await host.writeSettings(configured);
    return action();
  };
  await assert.rejects(() => runWebmail({ mailbox, operation: 'setup', url }, host),
    { code: 'EMAIL_WEBMAIL_SETTINGS_CHANGED' });
  assert.deepEqual(host.calls, []);

});

test('setup accepts ordinary query/hash routes and rejects credential-bearing addresses', () => {
  for (const input of ['http://mail.example.test/', 'https:example.test',
    'https://user:pass@mail.example.test/', 'https://mail.example.test/\n']) {
    assert.throws(() => stableHttpsAddress(input), { code: 'EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS' });
  }
  assert.equal(stableHttpsAddress('https://mail.example.test/?view=inbox#folder').hash, '#folder');
});

test('legacy origin lists and account controls migrate without retaining their restrictions', async () => {
  const legacy = { schemaVersion: 1, mailbox, url, origins: ['https://mail.example.test'], accountControl: 'outdated control' };
  const host = fixture(legacy, [status, text([])]);
  assert.equal((await runWebmail({ mailbox, operation: 'view' }, host)).state, 'ready');
  assert.equal(host.calls[1].externalNavigation, true);
  assert.equal(host.calls[1].profileAuthentication, true);
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
  assert.ok(host.calls.every(item => item.profileAuthentication && item.externalNavigation));
});

test('read and view use the live mail interface without an account-label form', async () => {
  const page = text([]);
  const host = fixture(configured, [status, page, page]);
  assert.equal(await runWebmail({ mailbox, operation: 'view' }, host), page);
  assert.equal(await runWebmail({ mailbox, operation: 'read', offset: 12 }, host), page);
  assert.deepEqual(host.calls.at(-1).args, {includeControls:true, offset:12});
});

test('follow accepts a fresh cross-domain interface link', async () => {
  const link = { role:'link', label:'Inbox', url:'https://another-mail-host.test/inbox' };
  const page = text([]), host = fixture(configured, [text([link]), page]);
  assert.equal(await runWebmail({ mailbox, operation:'follow', label:'Inbox' }, host), page);
  assert.equal(host.calls[1].args.url, link.url);
});

test('normal browser controls reach the same profile without provider-specific input restrictions', async () => {
  for (const operation of ['click','type','key','scroll']) {
    const input={frameId:'frame',text:'Reviewed letter',key:'Enter',x:10,y:20};
    const page=text([]),host=fixture(configured,[page]);
    assert.equal(await runWebmail({mailbox,operation,input},host),page);
    assert.equal(host.calls[0].operation,operation==='type'?'type-text':operation);
    assert.deepEqual(host.calls[0].args,input);
  }
});

test('opening a previous-release window saves it and reopens once without its old allowlist', async () => {
  const host=fixture(configured,[{state:'error',reason:'observation_mode_mismatch'},
    {state:'closed'},status,{state:'manual_input_required'}]);
  assert.equal((await runWebmail({mailbox,operation:'open'},host)).state,'manual_input_required');
  assert.deepEqual(host.calls.map(value=>value.operation),['setup','close','status','setup']);
});
