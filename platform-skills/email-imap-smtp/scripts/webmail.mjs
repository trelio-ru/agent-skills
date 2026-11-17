import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const operations = new Set(['status', 'setup', 'open', 'ready', 'view', 'read', 'follow', 'close']);
const active = new Set(['preparing', 'ready', 'manual_input_required']);
const maxConfigBytes = 16_384;
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
// Public login and parent-cookie origins apply equally to a known default or
// an explicitly supplied webmail address. Custom SSO remains additive.
const standardAuthOrigins = new Map([
  ['https://mail.google.com', ['https://accounts.google.com', 'https://google.com']],
  ['https://mail.yandex.ru', ['https://passport.yandex.ru', 'https://yandex.ru']],
  // Mail's official login guidance includes VK ID even for an ordinary mail
  // account. Retain its login hosts and parent cookie origin on first setup.
  ['https://e.mail.ru', ['https://account.mail.ru', 'https://mail.ru',
    'https://id.vk.com', 'https://login.vk.com', 'https://vk.com']],
]);
const result = (state, code) => ({ ok: state !== 'error', webmail: true, state, ...(code ? { code } : {}) });
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function stableHttpsAddress(value) {
  // This is a persistent entry URL entered by the account owner. OAuth
  // callback URLs, userinfo, one-time links and arbitrary origins from mail
  // content are never used as persistent routing settings.
  if (typeof value !== 'string' || !/^https:\/\//iu.test(value) || value.length > 2048
      || /[\x00-\x20\x7f\\?#]/u.test(value)) {
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

const includesMailbox = (label, mailbox) => label.toLowerCase().split(/[\s<>()\[\],;:«»]+/u).includes(mailbox);

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
  // Retain the same profile when approving a supplementary SSO or cookie
  // origin. Rebinding an existing protected profile to a different mailbox
  // or starting site requires a separate account instead of moving cookies.
  if (previous && (previous.mailbox !== mailbox || new URL(previous.url).origin !== url.origin)) {
    fail('EMAIL_WEBMAIL_PROFILE_MISMATCH');
  }
  const origins = new Set([url.origin, ...(previous?.origins ?? []), ...(standardAuthOrigins.get(url.origin) ?? [])]);
  for (const line of fields.authOrigins.split(/\s+/u).filter(Boolean)) {
    let auth;
    try { auth = stableHttpsAddress(line); }
    catch { fail('EMAIL_WEBMAIL_INVALID_AUTH_ORIGIN'); }
    if (auth.pathname !== '/') fail('EMAIL_WEBMAIL_INVALID_AUTH_ORIGIN');
    origins.add(auth.origin);
  }
  if (origins.size > 16) fail('EMAIL_WEBMAIL_TOO_MANY_ORIGINS');
  const accountControl = fields.accountControl.trim() || previous?.accountControl || '';
  // With an arbitrary provider no stable selector can certify identity.
  // The operator may identify the account control, but its exact label must
  // contain the mailbox address. Never use message bodies or senders as proof.
  if (accountControl && (accountControl.length > 120 || /[\x00-\x1f\x7f]/u.test(accountControl)
      || !includesMailbox(accountControl, mailbox))) fail('EMAIL_WEBMAIL_INVALID_ACCOUNT_CONTROL');
  return { schemaVersion: 1, mailbox, url: url.href, origins: [...origins], accountControl };
}

function storedSettings(value, mailbox) {
  if (!value || !Object.keys(value).length) return null;
  if (value.schemaVersion !== 1 || value.mailbox !== mailbox || typeof value.url !== 'string'
      || !Array.isArray(value.origins) || value.origins.some(item => typeof item !== 'string')
      || typeof value.accountControl !== 'string') fail('EMAIL_WEBMAIL_PROFILE_MISMATCH');
  return resolveWebmailSettings({ url: value.url, authOrigins: value.origins.join('\n'),
    accountControl: value.accountControl }, mailbox);
}

const controlsOptions = (query, offset = 0) => ({
  includeControls: true, ...(query ? { controlQuery: query } : {}), ...(offset ? { offset } : {}),
});
const textReady = value => value?.kind === 'trelio.browser-text/v1' && value.state === 'ready'
  && Array.isArray(value.controls);

async function readBoundMailbox(settings, command, offset = 0) {
  if (!settings.accountControl) return result('error', 'EMAIL_WEBMAIL_ACCOUNT_CONTROL_REQUIRED');
  // Pass the exact account control label as a filter; page body and unknown
  // account details stay in this process when the expected control is absent.
  const view = await command('read-text', controlsOptions(settings.accountControl, offset));
  if (!textReady(view)) return view;
  const bound = view.controls.filter(control => ['button', 'link'].includes(control.role)
    && control.label === settings.accountControl);
  return bound.length === 1 ? view : result('error', 'EMAIL_WEBMAIL_MAILBOX_UNVERIFIED');
}

async function followMailboxLink(settings, command, label) {
  const verified = await readBoundMailbox(settings, command);
  if (!textReady(verified)) return verified;
  const links = await command('read-text', controlsOptions(label));
  if (!textReady(links) || links.sessionId !== verified.sessionId) {
    return result('error', 'EMAIL_WEBMAIL_LINK_UNVERIFIED');
  }
  const matches = links.controls.filter(control => control.role === 'link'
    && control.label === label && typeof control.url === 'string');
  if (matches.length !== 1) return result('error', 'EMAIL_WEBMAIL_LINK_UNVERIFIED');
  // Link targets come from the host's filtered, fresh visible controls. Mail
  // apps can use queries or fragments for message IDs; these transient links
  // are never saved as webmail/SSO configuration or taken from command argv.
  const target = new URL(matches[0].url);
  if (target.origin !== new URL(settings.url).origin || target.username || target.password) {
    return result('error', 'EMAIL_WEBMAIL_LINK_UNVERIFIED');
  }
  const opened = await command('navigate', { url: target.href });
  return textReady(opened) ? readBoundMailbox(settings, command) : opened;
}

export async function runWebmail(request, host) {
  if (!request || !operations.has(request.operation)) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
  const mailbox = mailboxAddress(request.mailbox);
  if (request.operation === 'read' && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 106_000)
      || request.operation === 'follow' && (typeof request.label !== 'string' || !request.label.trim()
        || request.label.length > 120 || /[\x00-\x1f\x7f]/u.test(request.label))) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
  const readSettings = async () => storedSettings(await host.readSettings(), mailbox);
  let settings = await readSettings();
  const command = (operation, args = {}) => host.visual({ origins: settings.origins,
    presentation: 'windowed', observationMode: 'text', semanticControls: true, operation, args });
  if (request.operation === 'setup') {
    const initial = settings;
    if (request.edit !== undefined && typeof request.edit !== 'boolean'
        || request.url !== undefined && typeof request.url !== 'string'
        || request.authOrigins !== undefined && (!Array.isArray(request.authOrigins)
          || request.authOrigins.length > 15 || request.authOrigins.some(origin => typeof origin !== 'string'))
        || request.edit && (request.url !== undefined || request.authOrigins?.length)) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
    const persist = async candidate => {
      if (initial && JSON.stringify(candidate) !== JSON.stringify(initial)
          && active.has((await command('status')).state)) fail('EMAIL_WEBMAIL_CLOSE_BEFORE_SETUP');
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
      const candidate = resolveWebmailSettings({ url: address,
        authOrigins: (request.authOrigins ?? []).join('\n'), accountControl: initial?.accountControl ?? '' }, mailbox, initial);
      if (JSON.stringify(candidate) !== JSON.stringify(initial)) await persist(candidate);
      settings = candidate;
    }
    return command('setup', { url: settings.url });
  }
  if (!settings) return result('not_configured', 'EMAIL_WEBMAIL_SETUP_AVAILABLE');
  switch (request.operation) {
    case 'status': case 'ready': case 'close':
      return command(request.operation);
    case 'open':
      // The existing windowed session hands control to the human in place.
      // Human auth, drafts and sending remain in the provider's own UI.
      return command('setup', { url: settings.url });
    case 'read':
      return readBoundMailbox(settings, command, request.offset);
    case 'follow':
      return followMailboxLink(settings, command, request.label);
    case 'view': {
      if (!settings.accountControl) return result('error', 'EMAIL_WEBMAIL_ACCOUNT_CONTROL_REQUIRED');
      const status = await command('status');
      if (!status.hasStoredSession && status.state !== 'ready') return result('not_configured', 'EMAIL_WEBMAIL_SIGN_IN_REQUIRED');
      const opened = await command('navigate', { url: settings.url });
      return textReady(opened) ? readBoundMailbox(settings, command) : opened;
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
  if (visual.VISUAL_SEMANTIC_CONTROLS_API !== 'trelio.visual-semantic-controls/v1'
      || workspace.LOCAL_FORM_API !== 'trelio.local-form/v1') fail('EMAIL_WEBMAIL_HOST_UNAVAILABLE');
  const binding = visual.visualSessionBinding(env);
  if (binding.skillId !== 'email-imap-smtp') fail('EMAIL_WEBMAIL_INVALID_BINDING');
  const directory = path.join(workspace.resolveWorkspaceBridgeConfigDirectory(), 'visual-browser', binding.scope);
  const file = path.join(directory, 'webmail.json');
  return {
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
              ...(previous ? [{ label: 'Текущий адрес веб-почты', value: previous.url },
                { label: 'Сохранённые сайты входа', value: previous.origins.join('\n') }] : [])] },
            { ...(errorMessage ? { notice: { tone: 'error', text: 'Проверьте HTTPS-адреса и подпись элемента аккаунта. Настройки не сохранены.' } } : {}),
              fields: [
                { name: 'url', type: 'url', label: 'Адрес веб-почты', required: !previous, maxLength: 2048,
                  ...(errorMessage === 'EMAIL_WEBMAIL_INVALID_HTTPS_ADDRESS'
                    ? { error: 'Введите постоянный HTTPS-адрес веб-почты.' } : {}),
                  ...(errorMessage === 'EMAIL_WEBMAIL_PROFILE_MISMATCH'
                    ? { error: 'У этого ящика уже есть сессия на другом сайте. Используйте его сохранённый адрес.' } : {}) },
                { name: 'auth_origins', type: 'textarea', label: 'Дополнительные адреса входа (необязательно)', maxLength: 4096,
                  ...(['EMAIL_WEBMAIL_INVALID_AUTH_ORIGIN', 'EMAIL_WEBMAIL_TOO_MANY_ORIGINS'].includes(errorMessage)
                    ? { error: 'Укажите HTTPS-адреса сайтов входа без пути, по одному на строку. Всего до 16 сайтов.' } : {}),
                  help: 'Основные сайты входа Google, Яндекса и Mail добавятся автоматически. Для других схем входа укажите HTTPS-адрес каждого сайта с новой строки.' },
                { name: 'account_control', type: 'text', label: 'Подпись кнопки аккаунта (необязательно)', maxLength: 120,
                  ...(errorMessage === 'EMAIL_WEBMAIL_INVALID_ACCOUNT_CONTROL'
                    ? { error: 'В подписи должен быть полный адрес этого почтового ящика.' } : {}),
                  help: 'Укажите точную подпись кнопки профиля вместе с адресом ящика, если хотите дать агенту возможность читать веб-почту после проверки аккаунта.' },
              ] },
          ],
          form: { action: '/credential', nonce, actions: [
            { label: 'Сохранить и открыть веб-почту', name: 'decision', value: 'save' },
            { label: 'Отмена', name: 'decision', value: 'cancel', variant: 'secondary', formNoValidate: true },
          ] },
        }),
        parseSubmission: form => {
          const fields = ['nonce', 'decision', 'url', 'auth_origins', 'account_control'];
          if (form.get('decision') !== 'save'
            || [...form.keys()].some(key => !fields.includes(key) || form.getAll(key).length !== 1)) {
            fail('EMAIL_WEBMAIL_INVALID_FORM');
          }
          return validate({ url: form.get('url')?.trim() || previous?.url || '',
            authOrigins: form.get('auth_origins') || '', accountControl: form.get('account_control') || '' });
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
      if (bytes > maxConfigBytes) fail('EMAIL_WEBMAIL_COMMAND_INVALID');
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
