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
  // existing floating events. A new account uses the device's actual IANA
  // zone, not the empty vault's historical Europe/Moscow placeholder.
  const savedScope = original.preferences?.calendars?.length > 0;
  let automaticZone;
  try { automaticZone = timezone(savedScope ? original.preferences.timezone : detectTimezone()); }
  catch { automaticZone = null; }
  check(typeof formModule === 'string' && formModule.startsWith('file:'), 'host_local_form_required');
  const ui = await import(formModule);
  check(ui.LOCAL_FORM_API === 'trelio.local-form/v1', 'host_local_form_required');
  const route = `/connect/${crypto.randomBytes(32).toString('hex')}`;
  const nonce = crypto.randomBytes(24).toString('base64');
  let origin, loaded = false, posting = false, finished = false, stage = 'credentials';
  let candidate, calendars;
  let complete, fail;
  const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  result.catch(() => {});
  function page(error) {
    return ui.renderLocalFormPage({ title: 'Подключить Apple Calendar',
      description: stage === 'credentials' ? 'Введите Apple Account и пароль приложения. Данные сохраняются зашифрованно на этом компьютере.'
        : 'Выберите календари, доступные этому подключению, и часовой пояс для событий без указанного пояса.',
      ...(error ? { notice: { tone: 'error', text: error } } : {}),
      sections: stage === 'credentials' ? [
        { paragraphs: [savedScope ? 'При повторном входе сохранится текущий набор календарей.'
          : 'Подключатся все календари этого Apple Account.',
          automaticZone ? `Часовой пояс: ${automaticZone}. ${savedScope ? 'Сохранён в подключении.' : 'Определён на этом компьютере.'}`
            : 'Не удалось определить часовой пояс. После входа укажите его в настройках.'] },
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
          { name: 'password', label: 'Пароль приложения', type: 'password', required: true, maxLength: 64 },
          { name: 'customize', label: 'Выбрать отдельные календари или изменить часовой пояс', type: 'checkbox' }] }
      ] : [{ fields: calendars.map(calendar => ({ name: `calendar_${calendar.id}`, label: calendar.name || calendar.id,
        type: 'checkbox' })) }, { fields: [{ name: 'timezone', label: 'Часовой пояс IANA',
        type: 'text', required: !automaticZone, help: automaticZone ? `Можно оставить пустым: ${automaticZone}`
          : 'Например, Europe/Moscow', maxLength: 128 }] }],
      form: { action: route, nonce, actions: [{ label: stage === 'credentials' ? 'Подключить' : 'Сохранить',
        name: 'decision', value: 'save' }, { label: 'Отмена', name: 'decision', value: 'cancel',
        variant: 'secondary', formNoValidate: true }] } });
  }
  async function save(selected, zone, respond) {
    // Both the one-step path and optional custom settings converge on this
    // SAME durable writer. Never save credentials after expiry, accept an
    // unavailable saved calendar, or alter an unresolved operation's scope.
    check(!finished, 'setup_expired');
    check(selected.length > 0 && selected.every(id => calendars.some(calendar => calendar.id === id)), 'calendar_selection_unavailable');
    const state = await store.read();
    check(!finished, 'setup_expired');
    if (pending) check(zone === original.preferences.timezone &&
      [...selected].sort().join() === [...original.preferences.calendars].sort().join(), 'pending_scope_must_be_preserved');
    // Once admitted, the one durable save owns completion: expiry cannot
    // report failure halfway through an already-started encrypted atomic write.
    finished = true;
    clearTimeout(timer);
    state.credentials = candidate;
    state.preferences = { calendars: selected, timezone: zone };
    if (!pending) { state.references = {}; state.plans = {}; }
    await store.write(state);
    respond(ui.renderLocalFormMessage('Apple Calendar подключён', 'Календари доступны. Можно вернуться в чат.'));
    complete({ configured: true, calendarCount: selected.length, timezone: zone });
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const html = (status, body) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
    try {
      check(!finished && request.socket.remoteAddress === '127.0.0.1' && request.headers.host === new URL(origin).host &&
        request.url === route && !request.headers['x-forwarded-host'], 'setup_request_denied');
      if (request.method === 'GET') {
        check(!loaded && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' &&
          ['none','same-origin'].includes(request.headers['sec-fetch-site']), 'setup_request_denied');
        loaded = true;
        html(200, page());
        return;
      }
      // Chromium's native form may send Origin:null under no-referrer. Accept
      // that ONLY with its exact same-origin document-navigation tuple, the
      // unguessable route, exact Host/socket and the one-use nonce below. An
      // opaque cross-site/sandbox origin must never acquire this exception.
      const nativeForm = request.headers['sec-fetch-site'] === 'same-origin' &&
        request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      check(loaded && !posting && request.method === 'POST' && nativeForm &&
        (request.headers.origin === origin || request.headers.origin === 'null') &&
        request.headers['content-type']?.split(';')[0] === 'application/x-www-form-urlencoded' &&
        !request.headers['content-encoding'], 'setup_request_denied');
      posting = true;
      const chunks = [];
      let bytes = 0, form;
      try {
        for await (const chunk of request) { bytes += chunk.length; check(bytes <= 16000, 'setup_request_denied'); chunks.push(chunk); }
        form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      } finally { chunks.forEach(chunk => chunk.fill(0)); }
      check([...form.keys()].every(key => form.getAll(key).length === 1) && form.get('nonce') === nonce, 'setup_request_denied');
      if (form.get('decision') === 'cancel') {
        finished = true;
        html(200, ui.renderLocalFormMessage('Apple Calendar', 'Подключение отменено'));
        fail(new Fault('user_cancelled'));
        return;
      }
      check(form.get('decision') === 'save', 'setup_request_denied');
      if (stage === 'credentials') {
        check([...form.keys()].every(key => ['username','password','customize','nonce','decision'].includes(key)) &&
          (!form.has('customize') || form.get('customize') === 'on'), 'setup_request_denied');
        try {
          candidate = credentials({ username: form.get('username'), password: form.get('password') });
          // Reauthentication can restore read-only reconciliation after Apple
          // revokes an app password, but cannot change the account or its scope.
          check(!pending || candidate.username.toLowerCase() === original.credentials?.username.toLowerCase(), 'unknown_write_pending');
          calendars = await makeClient(candidate).calendars();
          check(!finished, 'setup_expired');
          check(calendars.length > 0 && calendars.length <= 50, 'calendar_selection_limit');
        } catch (error) {
          candidate = null;
          html(422, page(error.code === 'needs_reconnect' ? 'Apple отклонил вход. Проверьте Apple Account и пароль приложения.'
            : 'Подключение не подтверждено. Проверьте данные и доступность iCloud.'));
          return;
        }
        if (form.has('customize') || !automaticZone) {
          stage = 'calendars';
          html(200, page());
        } else {
          // The credential page explicitly explains all-calendar access before
          // the human submits. Existing bindings keep their exact snapshot;
          // newly discovered calendars do not enlarge it during reconnect.
          const selected = savedScope ? [...original.preferences.calendars] : calendars.map(calendar => calendar.id);
          await save(selected, automaticZone, body => html(200, body));
        }
        return;
      }
      const allowed = ['nonce','decision','timezone',...calendars.map(calendar => `calendar_${calendar.id}`)];
      check([...form.keys()].every(key => allowed.includes(key)), 'setup_request_denied');
      let zone;
      try { zone = timezone(form.get('timezone') || automaticZone); }
      catch { html(422, page('Введите действующий часовой пояс IANA')); return; }
      const selected = calendars.filter(calendar => form.has(`calendar_${calendar.id}`)).map(calendar => calendar.id);
      if (!selected.length) { html(422, page('Выберите хотя бы один календарь')); return; }
      await save(selected, zone, body => html(200, body));
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
    clearTimeout(timer); candidate = null;
    server.close(); server.closeAllConnections();
  }
}
