import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { check, Fault, credentials, timezone, childEnvironment } from './core.mjs';
import { CalDAV } from './caldav.mjs';

function openBrowser(url) {
  const command = process.platform === 'darwin' ? '/usr/bin/open'
    : path.join(process.env.SystemRoot || process.env.SYSTEMROOT || '', 'System32', 'rundll32.exe');
  check(process.platform === 'darwin' || process.platform === 'win32', 'secure_storage_unsupported');
  return new Promise((resolve, reject) => {
    const child = spawn(command, process.platform === 'darwin' ? [url] : ['url.dll,FileProtocolHandler', url],
      { shell: false, windowsHide: true, env: childEnvironment(), stdio: 'ignore' });
    child.on('error', () => reject(new Fault('setup_browser_unavailable')));
    child.on('close', status => status === 0 ? resolve() : reject(new Fault('setup_browser_unavailable')));
  });
}

export async function configure(store, { makeClient = value => new CalDAV(value), open = openBrowser,
  timeout = 300000, formModule = process.env.TRELIO_LOCAL_FORM_MODULE_URL,
  detectTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const original = await store.read();
  const pending = Object.values(original.operations).some(operation => operation.state === 'unknown');
  // Reauthentication must never widen a saved scope or silently reinterpret
  // existing floating events. On first connection, take one snapshot of the
  // device zone before asking for credentials. An invalid zone stops setup.
  const savedScope = original.preferences?.calendars?.length > 0;
  let zone;
  try { zone = timezone(savedScope ? original.preferences.timezone : detectTimezone()); }
  catch { throw new Fault('setup_timezone_unavailable'); }
  check(typeof formModule === 'string' && formModule.startsWith('file:'), 'host_local_form_required');
  const ui = await import(formModule);
  check(ui.LOCAL_FORM_API === 'trelio.local-form/v1', 'host_local_form_required');
  const route = `/connect/${crypto.randomBytes(32).toString('hex')}`;
  const nonce = crypto.randomBytes(24).toString('base64');
  let origin, loaded = false, posting = false, finished = false;
  let complete, fail;
  const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  result.catch(() => {});
  function page(error) {
    return ui.renderLocalFormPage({ title: 'Подключить Apple Calendar',
      description: 'Введите Apple Account и пароль приложения. Данные сохраняются зашифрованно на этом компьютере.',
      ...(error ? { notice: { tone: 'error', text: error } } : {}),
      sections: [
        { paragraphs: [savedScope ? 'Сохранятся прежние календари и часовой пояс.'
          : 'Подключатся все доступные календари iCloud. Часовой пояс берётся из настроек компьютера.'] },
        // Go straight to account management: a support article is not the
        // credential entry point and its availability must not block setup.
        // Apple sign-in and password creation stay entirely with the human.
        { heading: 'Как получить пароль приложения',
          links: [{ label: 'Открыть Apple Account', url: 'https://account.apple.com/' }],
          items: ['Войдите в Apple Account и откройте «Вход в учётную запись и безопасность» → «Пароли приложений».',
            'Создайте пароль с названием Trelio Calendar.',
            'Вернитесь в эту форму и вставьте созданный пароль в поле «Пароль приложения».'],
          paragraphs: ['Нужна двухфакторная аутентификация Apple. Пароль вводите только в эту форму, в чат его не присылайте.',
            'Форма действует 5 минут. Если она закроется, подготовьте пароль и попросите агента открыть новую форму.'] },
        { fields: [{ name: 'username', label: 'Apple Account', type: 'email', required: true, maxLength: 254 },
          { name: 'password', label: 'Пароль приложения', type: 'password', required: true, maxLength: 64 }] }
      ],
      form: { action: route, nonce, actions: [{ label: 'Подключить',
        name: 'decision', value: 'save' }, { label: 'Отмена', name: 'decision', value: 'cancel',
        variant: 'secondary', formNoValidate: true }] } });
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const html = (status, body) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
    // Browser asset requests, navigation probes, and duplicate requests must
    // not close the user's form or release a submit already being processed.
    // Deny them before they can touch the form's nonce, credentials or state.
    if (finished || posting || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== new URL(origin).host ||
      request.url !== route || request.headers['x-forwarded-host']) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const navigation = request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    try {
      if (request.method === 'GET') {
        if (loaded || !navigation || !['none','same-origin'].includes(request.headers['sec-fetch-site'])) {
          response.writeHead(403).end();
          return;
        }
        loaded = true;
        html(200, page());
        return;
      }
      // Chromium's native form may send Origin:null under no-referrer. Accept
      // that ONLY with its exact same-origin document-navigation tuple, the
      // unguessable route, exact Host/socket and the one-use nonce below. An
      // opaque cross-site/sandbox origin must never acquire this exception.
      const nativeForm = navigation && request.headers['sec-fetch-site'] === 'same-origin';
      if (!(loaded && nativeForm &&
        (request.headers.origin === origin || request.headers.origin === 'null') &&
        request.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded' &&
        !request.headers['content-encoding'])) {
        throw new Fault('setup_request_denied', { stage: 'form_transport' });
      }
      posting = true;
      const chunks = [];
      let bytes = 0, form;
      try {
        for await (const chunk of request) { bytes += chunk.length; check(bytes <= 16000, 'setup_request_denied'); chunks.push(chunk); }
        form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      } finally { chunks.forEach(chunk => chunk.fill(0)); }
      check(!finished, 'setup_expired');
      const fields = ['username','password','nonce','decision'];
      if (![...form.keys()].every(key => fields.includes(key) && form.getAll(key).length === 1) ||
        form.get('nonce') !== nonce || !['cancel','save'].includes(form.get('decision'))) {
        throw new Fault('setup_request_denied', { stage: 'form_fields' });
      }
      if (form.get('decision') === 'cancel') {
        finished = true;
        html(200, ui.renderLocalFormMessage('Apple Calendar', 'Подключение отменено'));
        fail(new Fault('user_cancelled'));
        return;
      }
      let candidate, calendars;
      try {
        candidate = credentials({ username: form.get('username'), password: form.get('password') });
        // An unresolved write can only be reconciled with the same identity,
        // calendars and time zone. Preserve its journal and references below.
        check(!pending || (savedScope && candidate.username.toLowerCase() === original.credentials?.username.toLowerCase()), 'unknown_write_pending');
        calendars = await makeClient(candidate).calendars();
        check(!finished, 'setup_expired');
        check(calendars.length > 0 && calendars.length <= 50, 'calendar_selection_limit');
      } catch (error) {
        if (finished || error.code === 'unknown_write_pending') throw error;
        html(422, page(error.code === 'needs_reconnect' ? 'Apple отклонила вход. Проверьте Apple Account и пароль приложения.'
          : 'Подключение не подтверждено. Проверьте данные и доступность iCloud.'));
        return;
      }
      const available = new Set(calendars.map(calendar => calendar.id));
      check(available.size === calendars.length, 'calendar_discovery_ambiguous');
      // First-time consent covers the calendars discovered at this submit.
      // Reconnect keeps the exact saved set and refuses missing calendars.
      const selected = savedScope ? [...original.preferences.calendars] : [...available];
      check(selected.every(id => available.has(id)), 'calendar_selection_unavailable');
      const state = await store.read();
      check(!finished, 'setup_expired');
      // The account lock owns the entire form. Once the atomic save starts,
      // expiry must not report failure while the encrypted write completes.
      finished = true;
      clearTimeout(timer);
      state.credentials = candidate;
      state.preferences = { calendars: selected, timezone: zone };
      if (!pending) { state.references = {}; state.plans = {}; }
      await store.write(state);
      html(200, ui.renderLocalFormMessage('Apple Calendar подключён', 'Календари доступны. Можно вернуться в чат.'));
      complete({ configured: true, calendarCount: selected.length, timezone: zone });
    } catch (error) {
      finished = true;
      if (!response.headersSent) html(403, ui.renderLocalFormMessage('Подключение не завершено', 'Повторно проверьте состояние подключения.'));
      fail(error instanceof Fault ? error : new Fault('setup_failed'));
    } finally { posting = false; }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => { finished = true; fail(new Fault('setup_expired')); }, timeout);
  try { await open(`${origin}${route}`); return await result; }
  finally {
    finished = true;
    clearTimeout(timer);
    server.close(); server.closeAllConnections();
  }
}
