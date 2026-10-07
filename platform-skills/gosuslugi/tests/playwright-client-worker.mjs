import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { childEnvironment, guardianConfig } from '../scripts/core.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';
import { createEsiaAuthorization } from '../scripts/playwright-client.mjs';
import { readAuthorization, requestLocal } from '../scripts/transport.mjs';
import { EsiaAuthorizer } from '../scripts/esia-authorizer.mjs';
import { activeCredentialGate, credentialGate, recoveredCredentialGate } from '../scripts/auth-safety.mjs';

// Every network response and credential below is synthetic. The browser,
// native guardian, private descriptor and per-character permit are real.
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
let sequence = 0, owned, current, callbackServer, stage = 'launch';
const waiting = new Map();
lines.on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(); waiting.delete(packet.id); });
async function permit(op = 'permit', extra = {}) {
  const id = ++sequence, ack = new Promise(resolve => waiting.set(id, resolve));
  process.stdout.write(JSON.stringify({ id, op, ...extra }) + '\n'); await ack;
}
const identity = { company: '11111111-1111-4111-8111-111111111111', member: '22222222-2222-4222-8222-222222222222' };
async function markStage(value) {
  stage = value;
  // Only a fixed synthetic stage leaves the guarded worker. If native cleanup
  // fires, the parent reports where progress stopped instead of ENOENT. This
  // remains a failed result until the entire suite explicitly writes ok=true.
  await fs.writeFile(config.file, JSON.stringify({ ok: false, stage,
    diagnostic: 'synthetic_worker_interrupted' }), { mode: 0o600 });
}
try {
  await markStage('launch');
  const helper = await nativeHelper(config.root);
  const playwright = await loadPlaywright(config.root);
  const server = await playwright.chromium.launchServer({ headless: false,
    channel: process.platform === 'darwin' ? 'chrome' : 'msedge', env: childEnvironment() });
  owned = { server, browser: null };
  await permit('own', { pid: server.process().pid });
  owned.browser = await playwright.chromium.connect(server.wsEndpoint());
  const browserPid = owned.server.process().pid;
  let nativePermits = 0;
  const token = crypto.randomBytes(32).toString('hex'), leaseId = crypto.randomUUID();
  callbackServer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { command: 'authorization-permit', sessionId: leaseId });
      await permit(); nativePermits++;
      res.end(JSON.stringify({ permitted: true }));
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'test_permit_failed' })); }
  });
  await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
  const authorizerControl = { leaseId, port: callbackServer.address().port, token };
  for (const [index, origin] of ['https://first.example.org', 'https://unlisted.example.org', 'https://sso.example.org',
    'https://popup.example.org', 'https://popup-totp.example.org', 'https://popup-sso.example.org',
    'https://zakaznoe.pochta.ru', 'https://zakaznoe.pochta.ru', 'https://passport.pochta.ru',
    'https://qr-choice.example.org', 'https://role-choice.example.org', 'https://www.pochta.ru',
    'https://unknown-relying-party.example.net'].entries()) {
    await markStage(`site_${index}`);
    const tracking = index === 11;
    const popupFlow = index >= 3 && index !== 6 && index !== 8 && index !== 12 && !tracking,
      sso = index !== 9 && index !== 10 && !tracking && index % 3 === 2,
      withTotp = index !== 10 && index % 3 === 1;
    // Exercise both same-page and popup entry from the public letter service.
    // Passport-first SSO also returns to the general account after
    // the exact callback, without making that portal an OAuth redirect URI.
    const callbackOrigin = index === 12 ? 'https://unlisted-login-broker.example.net'
      : tracking || index >= 6 && index <= 8 ? 'https://passport.pochta.ru' : origin,
      returnOrigin = index === 8 ? 'https://pochta.ru' : callbackOrigin;
    const context = await owned.browser.newContext({ viewport: null, acceptDownloads: true });
    const callback = `${callbackOrigin}/callback?state=synthetic-state&code=synthetic-code`;
    const auth = new URL('https://esia.gosuslugi.ru/aas/oauth2/ac');
    auth.search = new URLSearchParams({ redirect_uri: callbackOrigin + '/callback', state: 'synthetic-state', client_id: 'SYNTHETIC', response_type: 'code' });
    const postCallback = origin + '/api/auth/callback?state=synthetic-post-state&code=synthetic-post-code';
    const postAuth = new URL('https://passport.pochta.ru/oauth2/authorize');
    postAuth.search = new URLSearchParams({ redirect_uri: origin + '/api/auth/callback',
      state: 'synthetic-post-state', client_id: 'SYNTHETIC_POST', response_type: 'code' });
    let loginPosts = 0, personalRoleReturns = 0;
    const workingForm = '<form id="work"><input name="arbitrary"><input type="file"><button>Сохранить</button></form><a href="/download" download>Скачать</a><script>document.querySelector("#work").onsubmit=e=>{e.preventDefault();document.body.dataset.saved=document.querySelector("input").value}</script>';
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      let body, headers = {}, status = 200;
      if (url.origin === origin || url.origin === callbackOrigin || url.origin === returnOrigin) {
        if (url.pathname === '/download') return route.fulfill({ status: 200, headers: {
          'content-type': 'text/plain', 'content-disposition': 'attachment; filename=proof.txt' }, body: 'synthetic-download' });
        if (tracking && url.pathname === '/oauth2/authorize') {
          body = `<script>location.replace(${JSON.stringify(auth.href)})</script>`;
        } else if (tracking && url.pathname === '/api/auth/callback') {
          headers['set-cookie'] = 'synthetic_session=active; Secure; Path=/';
          body = '<h1>Кабинет</h1>' + workingForm;
        } else if (url.pathname === '/callback') {
          headers['set-cookie'] = 'synthetic_session=active; Secure; Path=/';
          if (index === 10) personalRoleReturns++;
          if (index === 12) status = 503;
          if (tracking) {
            // The ESIA return is a real intermediate document. Its delayed
            // site-owned continuation belongs to the caller after ESIA has
            // returned. The helper must detach before this new outer callback.
            body = `<p>Возврат в отслеживание</p><script>setTimeout(()=>location.replace(${JSON.stringify(postCallback)}),250)</script>`;
          } else if (index === 8) body = `<script>location.replace(${JSON.stringify(returnOrigin + '/account')})</script>`;
          else {
            // The popup runs the relying party's own callback and immediately
            // closes itself. The SDK must retain the verified document return,
            // keep the original form, and never synthesize this message/click.
            body = popupFlow ? `<script>opener.postMessage('synthetic-authorized', ${JSON.stringify(origin)});window.close()</script>`
              : (index === 12 ? '<h1>Ошибка внешнего сайта</h1>' : '<h1>Кабинет</h1>') + workingForm;
          }
        } else if (index === 8 && url.origin === returnOrigin && url.pathname === '/account') {
          body = '<h1>Кабинет</h1>' + workingForm;
        } else if (popupFlow) {
          body = workingForm + `<a href="#" id="login-popup">Вход через ЕСИА</a><script>
            document.querySelector('#login-popup').onclick=e=>{e.preventDefault();window.authPopup=window.open(${JSON.stringify(withTotp ? 'about:blank' : auth.href)}, 'esia-popup');
              ${withTotp ? `setTimeout(()=>window.authPopup.location.href=${JSON.stringify(auth.href)}, 100)` : ''}};
            addEventListener('message',e=>{if(e.source===window.authPopup&&e.origin===${JSON.stringify(callbackOrigin)}&&e.data==='synthetic-authorized')document.body.dataset.authorized='yes'});
            </script>`;
        } else body = `<a href="${(tracking ? postAuth : auth).href.replaceAll('&', '&amp;')}">Вход через ЕСИА</a>`;
      } else if (url.origin === 'https://roles.gosuslugi.ru' && index === 10) {
        body = `<h1>Войти как</h1><button onclick='location.href=${JSON.stringify(callback)}'><span>Частное лицо</span></button><button>Индивидуальный предприниматель</button>`;
      } else if (url.origin === 'https://esia.gosuslugi.ru') {
        // Some sites open an empty window before starting the OAuth request.
        // Its URL remains about:blank during the first network response; the
        // authorizer must wait for that document, not fail or read a key early.
        if (popupFlow && withTotp && url.pathname === '/aas/oauth2/ac') await new Promise(resolve => setTimeout(resolve, 1000));
        // Playwright routing does not fulfil every HTTP redirect hop. Use a
        // synthetic immediate page redirect so this fixture cannot accidentally
        // contact example.org and retry the callback. Transaction unit tests
        // separately cover a successful 302 response and callback replay.
        if (sso) return route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: `<script>location.replace(${JSON.stringify(callback)})</script>` });
        if (index === 3 && url.pathname === '/manual-post') {
          // The browser's human challenge submits inside the same bound ESIA
          // popup. The authorizer must notice this POST and resume itself.
          body = 'ok';
        } else if (url.pathname === '/login-post') {
          loginPosts++;
          // Assertions inspect only synthetic request data in the test worker.
          const values = new URLSearchParams(request.postData());
          assert.equal(values.get('login'), '+70000000000');
          assert.equal(values.get('password'), 'synthetic-password');
          body = 'ok';
        } else if (url.pathname === '/totp') {
          body = `<p>Введите код из приложения для аутентификации</p><input autocomplete="one-time-code" inputmode="numeric"><script>document.querySelector('input').oninput=e=>{if(e.target.value.length===6)location.href=${JSON.stringify(callback)}};</script>`;
        } else if (index === 3 && url.pathname === '/aas/oauth2/ac') {
          body = `<h1>CAPTCHA</h1><button>Продолжить</button><script>document.querySelector('button').onclick=async()=>{await fetch('/manual-post',{method:'POST'});location.href='/login'};</script>`;
        } else if (index === 9 && url.pathname === '/aas/oauth2/ac') {
          // The live landing page can advertise other sign-in methods below
          // the password button. Such labels are not active challenges, even
          // though the page-wide text classifier correctly flags biometrics.
          body = '<h1>Вход по QR-коду</h1><p>Наведите камеру и подтвердите вход в приложении «Госуслуги»</p><button onclick="location.href=\'/login\'">Логин и пароль</button><button>Биометрия</button>';
        } else body = `<form><label>Телефон<input id="login" name="login"></label><label>Пароль<input id="password" name="password" type="password"></label><button>Войти</button></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/login-post',{method:'POST',body:new URLSearchParams(new FormData(e.target))});location.href=${JSON.stringify(index === 10 ? 'https://roles.gosuslugi.ru/roles' : withTotp ? 'https://esia.gosuslugi.ru/totp' : callback)}};</script>`;
      } else if (url.origin === 'https://another-workflow.example.org') body = '<h1>Следующий шаг произвольного сценария</h1>';
      else return route.abort();
      await route.fulfill({ status, headers, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + body });
    });
    const page = await context.newPage(); await page.goto(origin);
    const navigationEvidence = [], seenRequests = new WeakSet();
    context.on('request', request => {
      if (!request.isNavigationRequest()) return;
      navigationEvidence.push({ callback: new URL(request.url()).pathname === '/callback',
        sameObject: seenRequests.has(request), redirected: Boolean(request.redirectedFrom()), method: request.method() });
      seenRequests.add(request);
    });
    await assert.rejects(createEsiaAuthorization(page, { ...identity, configHome: config.root, origin }), /authorization_permission_required/);
    current = await createEsiaAuthorization(page, { ...identity, configHome: config.root, origin, confirm: true });
    assert.equal(current.page, page); assert.equal(current.context, context);
    if (popupFlow) {
      // In-memory form text and selected File objects must survive OAuth; a
      // replacement Page, reload or storageState round-trip would lose these.
      await page.locator('input[name=arbitrary]').fill('Черновик до авторизации');
      await page.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic-draft') });
    }
    await page.getByRole('link', { name: 'Вход через ЕСИА' }).click();
    const info = await current.request;
    assert.equal(info.origin, origin); assert.ok(info.arguments.includes('--confirm'));
    // Match a serialized port field, not the legitimate "passport" hostname.
    assert.doesNotMatch(JSON.stringify(info), /token|"port"\s*:|password|synthetic-state|synthetic-code/);
    const authorization = await readAuthorization(config.root, identity, info.sessionId, info.requestId, origin, helper);
    const authorizer = new EsiaAuthorizer({ identity, leaseId, guardPid: process.pid, authorization, authorizerControl },
      { permit, onPhase: async () => {} });
    // A request without the native callback must fail before claim or input.
    await assert.rejects(requestLocal(authorization, { command: 'claim', sessionId: info.sessionId,
      requestId: info.requestId, authorizationLease: leaseId, origin, ...identity, confirmed: true, guardPid: process.pid }), /native_permit_required/);
    if (sso) {
      // This case models cookie SSO finishing before the separate authorizer
      // invocation. Wait for the site's own completed callback, not a guessed
      // delay: an immediate same-process claim can legitimately arrive while
      // the synthetic ESIA document is still starting its redirect. The SDK
      // must independently retain HTTP/commit proof, including a closed popup.
      if (popupFlow) await page.waitForFunction(() => document.body.dataset.authorized === 'yes');
      else {
        try { await page.getByRole('heading', { name: 'Кабинет', exact: true }).waitFor(); }
        catch (error) {
          const location = new URL(page.url());
          throw new Error(`SSO did not reach a cabinet: origin=${location.origin}; path=${location.pathname}; navigation=${JSON.stringify(navigationEvidence)}`, { cause: error });
        }
      }
    }
    await markStage(`auth_${index}`);
    try { await authorizer.claim(); }
    catch (error) {
      const clientState = await Promise.race([current.authenticated.then(() => 'completed', failure => failure.code),
        new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
      throw new Error(`claim=${error.code}; client=${clientState}; navigation=${JSON.stringify(navigationEvidence)}`);
    }
    if (sso) assert.equal(authorizer.completed, true, 'SSO skips credential access');
    else if (index === 3) {
      const credentials = { login: '+70000000000', password: 'synthetic-password', totp: null };
      assert.equal(await authorizer.authenticate(credentials), false);
      assert.equal(authorizer.manualReason, 'challenge_required');
      const resumed = new Promise((resolve, reject) => authorizer.watchPeer({ isBusy: () => false,
        onReturned: async () => reject(new Error('callback returned before manual progress')),
        onProgress: async () => {
          try { resolve(await authorizer.authenticate(credentials)); }
          catch (error) { reject(error); }
        },
        onLost: async () => reject(new Error('manual challenge lost its browser')) }));
      const popup = context.pages().find(candidate => candidate !== page);
      await popup.getByRole('button', { name: 'Продолжить' }).click();
      assert.equal(await resumed, true);
    } else {
      const authenticated = await authorizer.authenticate({ login: '+70000000000', password: 'synthetic-password',
        totp: withTotp ? 'JBSWY3DPEHPK3PXP' : null });
      assert.equal(authenticated, true, `manual=${authorizer.manualReason}`);
    }
    const result = await current.authenticated;
    assert.equal(result.page, page); assert.equal(result.context, context); assert.equal(loginPosts, sso ? 0 : 1);
    if (index === 12) assert.deepEqual(result.serviceResponse, { httpStatus: 503, httpOrigin: callbackOrigin },
      'an unknown broker callback error is caller-owned, not an ESIA refusal');
    if (index === 10) {
      assert.equal(authorizer.roleSent, true, 'the official personal card is selected once');
      assert.equal(personalRoleReturns, 1, 'the role choice returns to the service once');
    }
    await authorizer.close(); await current.close(); current = null;
    assert.equal(page.isClosed(), false);
    if (popupFlow) {
      await page.waitForFunction(() => document.body.dataset.authorized === 'yes');
      assert.equal(await page.locator('input[name=arbitrary]').inputValue(), 'Черновик до авторизации');
      assert.equal(await page.locator('input[type=file]').evaluate(element => element.files[0].name), 'draft.txt');
      assert.equal(context.pages().length, 1, 'only the site closes its completed popup');
    }
    await markStage(`scenario_${index}`);
    // These are ordinary Playwright operations, with no fixed command catalog.
    await page.locator('input[name=arbitrary]').fill('Свой сценарий');
    await page.locator('input[type=file]').setInputFiles({ name: 'attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic-upload') });
    assert.equal(await page.locator('input[type=file]').evaluate(element => element.files[0].name), 'attachment.txt');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    assert.equal(await page.evaluate(() => document.body.dataset.saved), 'Свой сценарий');
    // Chromium cancels some route.fulfill attachment navigations. A Blob
    // exercises the real download/save stream without a synthetic HTTP redirect
    // pretending to be a provider's file endpoint.
    await page.getByRole('link', { name: 'Скачать' }).evaluate(link => {
      link.href = URL.createObjectURL(new Blob(['synthetic-download'], { type: 'text/plain' })); link.download = 'proof.txt';
    });
    const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: 'Скачать' }).click();
    const download = await downloading; const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'synthetic-download'); await download.delete();
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'synthetic_session'), true);
    await page.goto('https://another-workflow.example.org');
    assert.match(await page.locator('h1').innerText(), /Следующий шаг/);
    await context.close();
  }
  // Exercise actual Playwright main-document HTTP status propagation, including
  // failure before any OAuth binding. No credentials, OS unlock or auth DOM
  // enter this synthetic check; the helper must retain the caller context.
  for (const failureAt of ['entry', 'esia', 'callback']) {
    await markStage(`http_503_${failureAt}`);
    const context = await owned.browser.newContext();
    const origin = 'https://ej.sudrf.ru';
    const callback = origin + '/callback?state=synthetic-state&code=synthetic-code';
    const auth = new URL('https://esia.gosuslugi.ru/aas/oauth2/ac');
    auth.search = new URLSearchParams({ redirect_uri: origin + '/callback', state: 'synthetic-state',
      client_id: 'SYNTHETIC', response_type: 'code' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const failed = failureAt === 'entry' && url.pathname === '/unavailable' ||
        failureAt === 'esia' && url.origin === 'https://esia.gosuslugi.ru' ||
        failureAt === 'callback' && url.pathname === '/callback';
      const next = url.origin === 'https://esia.gosuslugi.ru' ? callback : auth.href;
      return route.fulfill({ status: failed ? 503 : 200, contentType: 'text/html',
        body: failed ? '<h1>503 Service Unavailable</h1>' : url.pathname === '/'
          ? '<h1>Public entry</h1>' : `<script>location.replace(${JSON.stringify(next)})</script>` });
    });
    const page = await context.newPage(); await page.goto(origin);
    current = await createEsiaAuthorization(page, { ...identity, configHome: config.root, origin, confirm: true });
    await page.goto(failureAt === 'entry' ? origin + '/unavailable' : auth.href);
    await assert.rejects(current.authenticated, error => {
      assert.equal(error.code, 'service_http_error');
      assert.equal(error.httpStatus, 503);
      assert.equal(error.httpOrigin, failureAt === 'esia' ? 'https://esia.gosuslugi.ru' : origin);
      assert.ok(!JSON.stringify(error).includes('synthetic-state'));
      assert.ok(!JSON.stringify(error).includes('synthetic-code'));
      return true;
    });
    assert.equal(page.isClosed(), false); assert.equal(page.context(), context);
    await current.close(); current = null;
    await context.close();
  }
  await markStage('account_block_recovery');
  {
    const context = await owned.browser.newContext();
    const origin = 'https://blocked.example.org', callback = origin + '/callback?state=synthetic-state&code=synthetic-code';
    const auth = new URL('https://esia.gosuslugi.ru/aas/oauth2/ac');
    auth.search = new URLSearchParams({ redirect_uri: origin + '/callback', state: 'synthetic-state',
      client_id: 'SYNTHETIC', response_type: 'code' });
    let loginPosts = 0, blocked = true, retainedGate = null;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: url.pathname === '/callback'
          ? `<script>opener.postMessage('synthetic-authorized', ${JSON.stringify(origin)});window.close()</script>`
          : `<input name="draft"><a id="login">Вход через ЕСИА</a><script>document.querySelector('a').onclick=()=>window.open(${JSON.stringify(auth.href)})</script>` });
      if (url.origin !== 'https://esia.gosuslugi.ru') return route.abort();
      if (url.pathname === '/login-post') { loginPosts++; return route.fulfill({ body: 'ok' }); }
      const form = `<form><input id="login" name="login"><input type="password" id="password" name="password"><button>Войти</button></form>
        <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/login-post',{method:'POST'});location.href=${JSON.stringify(callback)}};</script>`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: blocked
        ? '<h1>Доступ временно заблокирован</h1><p>Доступ будет разблокирован в течение 72 часов</p>' + form : form });
    });
    const page = await context.newPage(); await page.goto(origin);
    await page.locator('input[name=draft]').fill('Черновик остаётся после блокировки');
    current = await createEsiaAuthorization(page, { ...identity, configHome: config.root, origin, confirm: true });
    await page.getByText('Вход через ЕСИА', { exact: true }).click();
    const info = await current.request;
    const authorization = await readAuthorization(config.root, identity, info.sessionId, info.requestId, origin, helper);
    const authorizer = new EsiaAuthorizer({ identity, leaseId, guardPid: process.pid, authorization, authorizerControl },
      { permit, onPhase: async () => {}, getCredentialGate: () => activeCredentialGate(retainedGate),
        onAuthRefused: async (reason, hours) => { retainedGate ??= credentialGate(reason, hours); } });
    await authorizer.claim();
    const credentials = { login: '+70000000000', password: 'synthetic-password', totp: null };
    assert.equal(await authorizer.authenticate(credentials), false);
    assert.equal(authorizer.manualReason, 'account_temporarily_blocked');
    assert.equal(loginPosts, 0);
    const popup = context.pages().find(candidate => candidate !== page);
    for (const input of await popup.locator('input').all()) assert.equal(await input.inputValue(), '', 'block precedes every secret field');
    assert.equal(await authorizer.authenticate(credentials), false);
    assert.equal(loginPosts, 0, 'resume cannot retry a blocked account');
    blocked = false; await popup.reload();
    assert.equal(await authorizer.authenticate(credentials), false, 'a clean form alone cannot reset the retained block');
    retainedGate = recoveredCredentialGate(retainedGate, true); // Synthetic operator reports recovery.
    assert.equal(await authorizer.authenticate(credentials), true);
    const result = await current.authenticated;
    assert.equal(result.context, context); assert.equal(result.page, page);
    assert.equal(loginPosts, 1, 'exactly one credential submission after explicit recovery');
    assert.equal(await page.locator('input[name=draft]').inputValue(), 'Черновик остаётся после блокировки');
    await authorizer.close(); await current.close(); current = null; await context.close();
  }
  assert.ok(nativePermits > 40, 'secret characters need actual native permits');
  await fs.writeFile(config.file, JSON.stringify({ ok: true, browserPid }), { mode: 0o600 });
} catch (error) {
  await fs.writeFile(config.file, JSON.stringify({ ok: false, stage, diagnostic: error.stack }), { mode: 0o600 });
} finally {
  await current?.close().catch(() => {});
  callbackServer?.close(); callbackServer?.closeAllConnections();
  const fallback = setTimeout(() => process.exit(1), 2000); fallback.unref();
  await owned?.browser?.close().catch(() => {}); await owned?.server.close().catch(() => {});
  process.exit(0);
}
