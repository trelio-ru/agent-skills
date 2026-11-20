import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const operations = new Set(['status', 'setup', 'open', 'ready', 'view', 'read', 'follow', 'close', 'navigate', 'screenshot', 'click', 'type', 'key', 'scroll']);
const maxConfigBytes = 16_384;
const startupWaitMs = 15_000;
// Python escapes Unicode in the private request pipe. Keep enough transport
// space for the host's normal 32 KiB input command, not just small settings.
const maxRequestBytes = 128 * 1024;
// Match exact known mailbox domains or explicitly configured protocol hosts.
// Similar names, MX guesses and custom domains alone do not choose a login site.
const standardWebmail = [
  { domains: ['gmail.com', 'googlemail.com'], hosts: ['imap.gmail.com', 'smtp.gmail.com'],
    url: 'https://mail.google.com/mail/' },
  { domains: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.com.tr'],
    hosts: ['imap.yandex.ru', 'imap.ya.ru', 'smtp.yandex.ru'], url: 'https://mail.yandex.ru/' },
  { domains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru'],
    hosts: ['imap.mail.ru', 'smtp.mail.ru'], url: 'https://e.mail.ru/inbox/' },
];
const result = (state, code) => ({ ok: state !== 'error', webmail: true, state, ...(code ? { code } : {}) });
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function stableHttpsAddress(value) {
  // This is a persistent entry URL entered by the account owner. OAuth
  // callback URLs, userinfo, one-time links and arbitrary origins from mail
  // content are never used as persistent routing settings.
  if (typeof value !== 'string' || !/^https:\/\//iu.test(value) || value.length > 2048
      || /[\x00-\x20\x7f\\]/u.test(value)) {
    fail('EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS');
  }
  let url;
  try { url = new URL(value); }
  catch { fail('EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    fail('EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS');
  }
  return url;
}

const mailboxAddress = value => {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
    fail('EMAIL_WEBMAIL_INVALID_MAILBOX');
  }
  return value.trim().toLowerCase();
};

export function standardWebmailAddress(mailbox, { imapHost = '', smtpHost = '' } = {}) {
  const domain = mailboxAddress(mailbox).split('@')[1];
  const known = standardWebmail.find(provider => provider.domains.includes(domain));
  if (known) return known.url;
  const hosts = [imapHost, smtpHost].map(host => typeof host === 'string' ? host.trim().toLowerCase() : '');
  const candidates = standardWebmail.filter(provider => hosts.some(host => provider.hosts.includes(host)));
  return candidates.length === 1 ? candidates[0].url : null;
}

export function resolveWebmailSettings(fields, mailbox, previous = null) {
  const url = stableHttpsAddress(fields.url.trim());
  // The selected host account owns this whole profile. A new webmail entry
  // address can keep its existing login; old origin lists/account labels are
  // ignored during migration rather than becoming another setup requirement.
  if (previous && previous.mailbox !== mailbox) fail('EMAIL_WEBMAIL_PROFILE_MISMATCH');
  return { schemaVersion: 2, mailbox, url: url.href };
}

function storedSettings(value, mailbox) {
  if (!value || !Object.keys(value).length) return null;
  if (![1, 2].includes(value.schemaVersion) || value.mailbox !== mailbox || typeof value.url !== 'string') {
    fail('EMAIL_WEBMAIL_PROFILE_MISMATCH');
  }
  return resolveWebmailSettings({ url: value.url }, mailbox);
}

const controlsOptions = (query, offset = 0) => ({
  includeControls: true, ...(query ? { controlQuery: query } : {}), ...(offset ? { offset } : {}),
});
const textReady = value => value?.kind === 'trelio.browser-text/v1' && value.state === 'ready'
  && Array.isArray(value.controls);

async function followMailboxLink(command, label) {
  // Resolve a fresh visible link. Host navigation supports the webmail's own
  // cross-domain routes just as it supports the browser's SSO redirects.
  const links = await command('read-text', controlsOptions(label));
  if (!textReady(links)) return links;
  const matches = links.controls.filter(control => control.role === 'link'
    && control.label === label && typeof control.url === 'string');
  if (matches.length !== 1) return result('error', 'EMAIL_WEBMAIL_LINK_UNVERIFIED');
  return command('navigate', { url: matches[0].url });
}

export async function runWebmail(request, host) {
  if (!request || !operations.has(request.operation)) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
  const mailbox = mailboxAddress(request.mailbox);
  if (request.operation === 'read' && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 106_000)
      || request.operation === 'follow' && (typeof request.label !== 'string' || !request.label.trim()
        || request.label.length > 120 || /[\x00-\x1f\x7f]/u.test(request.label))) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
  const readSettings = async () => storedSettings(await host.readSettings(), mailbox);
  let settings = await readSettings();
  const command = async (operation, args = {}) => {
    const options = { origins: [new URL(settings.url).origin], externalNavigation: true,
      profileAuthentication: true, presentation: 'windowed', observationMode: 'text', semanticControls: true };
    const value = await host.visual({ ...options, operation, args });
    if (operation !== 'setup' || value.reason !== 'observation_mode_mismatch') return value;
    // An open window from the previous release still owns its old allowlist.
    // Save and close only that selected account's window, then reopen its saved
    // login once with the new profile policy. No credential input or mail action
    // is replayed, and no snapshot is deleted.
    const closed = await host.visual({ ...options, operation: 'close', args: {} });
    if (closed.state === 'error') return closed;
    for (let index = 0; index < 40; index++) {
      const status = await host.visual({ ...options, operation: 'status', args: {} });
      if (['saved_unverified', 'not_configured'].includes(status.state)) {
        return host.visual({ ...options, operation, args });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return value;
  };
  const openForSignIn = async () => {
    let state = await command('setup', { url: settings.url });
    if (state.state !== 'preparing') return state;
    const startingSessionId = state.sessionId;

    // A cold start acknowledges the worker claim before Chromium can take
    // input. Poll its existing session, then show that window through the
    // already-supported handoff command. That command cannot launch a new
    // browser if the user closed the original one while we were waiting.
    const until = Math.min(Date.now() + startupWaitMs, host.deadlineAt ?? Infinity);
    while (state.state === 'preparing' && Date.now() + 250 < until) {
      await new Promise(resolve => setTimeout(resolve, 250));
      state = await command('status');
      if (startingSessionId && state.sessionId && state.sessionId !== startingSessionId) {
        return result('error', 'EMAIL_WEBMAIL_SESSION_CHANGED');
      }
    }
    if (state.state !== 'manual_input_required') return state;
    const shown = await command('show-login');
    if (shown.state === 'manual_input_required' && shown.sessionId !== state.sessionId) {
      return result('error', 'EMAIL_WEBMAIL_SESSION_CHANGED');
    }
    return shown;
  };
  if (request.operation === 'setup') {
    const initial = settings;
    if (request.edit !== undefined && typeof request.edit !== 'boolean'
        || request.url !== undefined && typeof request.url !== 'string'
        || request.edit && request.url !== undefined) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
    const persist = async candidate => {
      await host.withSettingsLock(async () => {
        if (JSON.stringify(await readSettings()) !== JSON.stringify(initial)) fail('EMAIL_WEBMAIL_SETTINGS_CHANGED');
        await host.writeSettings(candidate);
      });
    };
    if (request.edit) {
      settings = await host.collectSettings({
        mailbox, previous: initial,
        validate: fields => resolveWebmailSettings(fields, mailbox, initial), persist,
      });
    } else {
      // The ordinary setup opens the known or already saved mail site directly.
      // For another provider the agent can supply its verified official URL.
      // Only unresolved discovery calls for more information, not another form.
      const address = request.url ?? initial?.url ?? standardWebmailAddress(mailbox, request);
      if (!address) return result('not_configured', 'EMAIL_WEBMAIL_ADDRESS_DISCOVERY_REQUIRED');
      const candidate = resolveWebmailSettings({ url: address }, mailbox, initial);
      if (JSON.stringify(candidate) !== JSON.stringify(initial)) await persist(candidate);
      settings = candidate;
    }
    return openForSignIn();
  }
  if (!settings) return result('not_configured', 'EMAIL_WEBMAIL_SETUP_AVAILABLE');
  switch (request.operation) {
    case 'status': case 'ready': case 'close':
      return command(request.operation);
    case 'open':
      // The existing windowed session hands control to the human in place.
      // Human auth, drafts and sending remain in the provider's own UI.
      return openForSignIn();
    case 'read':
      return command('read-text', controlsOptions(null, request.offset));
    case 'follow':
      return followMailboxLink(command, request.label);
    case 'navigate': return command('navigate', { url: stableHttpsAddress(request.url).href });
    case 'screenshot': return command('screenshot');
    case 'click': case 'type': case 'key': case 'scroll':
      return command(request.operation === 'type' ? 'type-text' : request.operation, request.input);
    case 'view': {
      const status = await command('status');
      // A missing stopped snapshot says nothing about an active worker,
      // manual browser gate or startup error. Preserve its observed status
      // and never navigate while one of those states still owns the browser.
      if (!['ready', 'saved_unverified', 'not_configured', 'closed'].includes(status.state)) return status;
      if (!status.hasStoredSession && status.state !== 'ready') return result('not_configured', 'EMAIL_WEBMAIL_SIGN_IN_REQUIRED');
      return command('navigate', { url: settings.url });
    }
  }
  fail('EMAIL_WEBMAIL_COMMAND_INVALID');
}

function hostModule(raw, expected) {
  const url = new URL(raw);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash || !url.pathname.endsWith('/' + expected)) {
    fail('EMAIL_WEBMAIL_HOST_UNAVAILABLE');
  }
  return url;
}

async function trustedHost(env) {
  const moduleUrl = hostModule(env.TRELIO_VISUAL_SESSION_MODULE_URL, 'trelio-visual-session.mjs');
  const workspaceUrl = hostModule(env.TRELIO_LOCAL_FORM_MODULE_URL, 'trelio-workspace.mjs');
  if (new URL('.', workspaceUrl).href !== new URL('.', moduleUrl).href) fail('EMAIL_WEBMAIL_HOST_UNAVAILABLE');
  const [visual, workspace, bootstrap, browser, forms] = await Promise.all([
    import(moduleUrl), import(workspaceUrl), import(new URL('trelio-visual-bootstrap.mjs', moduleUrl)),
    import(new URL('trelio-browser-session.mjs', moduleUrl)), import(new URL('trelio-remote-mcp.mjs', moduleUrl)),
  ]);
  if (visual.VISUAL_PROFILE_AUTH_API !== 'trelio.visual-profile-auth/v1'
      || visual.VISUAL_SEMANTIC_CONTROLS_API !== 'trelio.visual-semantic-controls/v1'
      || workspace.LOCAL_FORM_API !== 'trelio.local-form/v1') fail('EMAIL_WEBMAIL_HOST_UNAVAILABLE');
  const binding = visual.visualSessionBinding(env);
  if (binding.skillId !== 'email-imap-smtp') fail('EMAIL_WEBMAIL_INVALID_BINDING');
  const directory = path.join(workspace.resolveWorkspaceBridgeConfigDirectory(), 'visual-browser', binding.scope);
  const file = path.join(directory, 'webmail.json');
  return {
    deadlineAt: binding.deadlineAt,
    visual: options => visual.runVisualSession({ ...options, env }),
    readSettings: async () => {
      await bootstrap.prepareVisualPrivateDirectory(directory);
      return workspace.readPrivateJsonFile(file, { maximumBytes: maxConfigBytes, fatalUtf8: true });
    },
    writeSettings: value => workspace.writePrivateJsonFile(file, value),
    withSettingsLock: operation => browser.withBrowserAccountState(directory, operation),
    collectSettings: async ({ mailbox, previous, validate, persist }) => {
      let saved;
      const remaining = Math.min(120_000, binding.deadlineAt - Date.now());
      if (remaining <= 0) fail('EMAIL_WEBMAIL_LEASE_EXPIRED');
      await forms.collectCredentialThroughLoopback(binding.origin, {}, {
        signal: AbortSignal.timeout(remaining), allowCancel: true, terminalPersistenceFailure: true,
        renderForm: ({ nonce, errorMessage }) => workspace.renderLocalFormPage({
          title: 'Подключить веб-почту',
          description: 'Войдите в тот же ящик на сайте почтового сервиса. Вход сохраняется в отдельном браузерном профиле на этом устройстве.',
          sections: [
            { rows: [{ label: 'Почтовый ящик', value: mailbox },
              ...(previous ? [{ label: 'Текущий адрес веб-почты', value: previous.url }] : [])] },
            { ...(errorMessage ? { notice: { tone: 'error', text: 'Проверьте адрес веб-почты. Настройки не сохранены.' } } : {}),
              fields: [
                { name: 'url', type: 'url', label: 'Адрес веб-почты', required: !previous, maxLength: 2048,
                  ...(errorMessage === 'EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS'
                    ? { error: 'Введите постоянный HTTPS-адрес веб-почты.' } : {}),
                  ...(errorMessage === 'EMAIL_WEBMAIL_PROFILE_MISMATCH'
                    ? { error: 'У этого ящика уже есть сессия на другом сайте. Используйте его сохранённый адрес.' } : {}) },
              ] },
          ],
          form: { action: '/credential', nonce, actions: [
            { label: 'Сохранить и открыть веб-почту', name: 'decision', value: 'save' },
            { label: 'Отмена', name: 'decision', value: 'cancel', variant: 'secondary', formNoValidate: true },
          ] },
        }),
        parseSubmission: form => {
          const fields = ['nonce', 'decision', 'url'];
          if (form.get('decision') !== 'save'
            || [...form.keys()].some(key => !fields.includes(key) || form.getAll(key).length !== 1)) {
            fail('EMAIL_WEBMAIL_INVALID_FORM');
          }
          return validate({ url: form.get('url')?.trim() || previous?.url || '' });
        },
        doctorCredential: async () => {},
        persistCredential: async (_origin, _resolved, candidate, { signal }) => {
          signal.throwIfAborted();
          await persist(candidate);
          saved = candidate;
        },
        successTitle: 'Адрес сохранён',
        successMessage: 'Почтовый сервис откроется в отдельном окне. Войдите в нужный ящик и закройте окно после входа.',
      });
      return saved;
    },
  };
}

async function main() {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const value = await runWebmail(request, await trustedHost(process.env));
    process.stdout.write(JSON.stringify(value));
  } catch (error) {
    // Host paths, provider HTML, form contents and exceptions never become
    // diagnostics. The host handles cookies and snapshots without model I/O.
    const code = /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? '') && error.code.startsWith('EMAIL_WEBMAIL_')
      ? error.code : error?.code === 'PROTECTED_FORM_CANCELLED' ? 'EMAIL_WEBMAIL_SETUP_CANCELLED'
        : 'EMAIL_WEBMAIL_UNAVAILABLE';
    process.stdout.write(JSON.stringify(result('error', code)));
  }
}

// Resolve filesystem aliases before CLI detection, including macOS /var and
// Windows spelling differences. Imports remain side-effect free for tests.
if (process.argv[1] && path.isAbsolute(process.argv[1])
    && path.relative(realpathSync.native(process.argv[1]), realpathSync.native(fileURLToPath(import.meta.url))) === '') {
  await main();
}
