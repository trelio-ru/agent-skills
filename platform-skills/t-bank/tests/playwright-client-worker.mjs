import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { childEnvironment, guardianConfig } from '../scripts/core.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { nativeHelper } from '../scripts/native.mjs';
import { createTIdAuthorization } from '../scripts/playwright-client.mjs';
import { readAuthorization, requestLocal } from '../scripts/transport.mjs';
import { TIdAuthorizer } from '../scripts/t-id-authorizer.mjs';

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
try {
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
    'https://popup.example.org', 'https://popup-totp.example.org', 'https://popup-sso.example.org'].entries()) {
    stage = `site_${index}`;
    const popupFlow = index >= 3, sso = index % 3 === 2, withTotp = index % 3 === 1;
    const stateOnlyBootstrap = index === 0;
    const context = await owned.browser.newContext({ viewport: null, acceptDownloads: true });
    const callback = `${origin}/callback?state=synthetic-state&code=synthetic-code`;
    const auth = new URL('https://id.tbank.ru/auth/authorize');
    auth.search = new URLSearchParams({ redirect_uri: origin + '/callback', state: 'synthetic-state',
      client_id: 'SYNTHETIC', response_type: 'code', response_mode: 'query' });
    let loginPosts = 0;
    const workingForm = '<form id="work"><input name="arbitrary"><input type="file"><button>Сохранить</button></form><a href="/download" download>Скачать</a><script>document.querySelector("#work").onsubmit=e=>{e.preventDefault();document.body.dataset.saved=document.querySelector("input").value}</script>';
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      let body, headers = {};
      if (url.origin === origin) {
        if (url.pathname === '/download') return route.fulfill({ status: 200, headers: {
          'content-type': 'text/plain', 'content-disposition': 'attachment; filename=proof.txt' }, body: 'synthetic-download' });
        if (url.pathname === '/callback') {
          headers['set-cookie'] = 'synthetic_session=active; Secure; Path=/';
          // The popup runs the relying party's own callback and immediately
          // closes itself. The SDK must retain the verified document return,
          // keep the original form, and never synthesize this message/click.
          body = popupFlow ? `<script>opener.postMessage('synthetic-authorized', ${JSON.stringify(origin)});window.close()</script>`
            : '<h1>Кабинет</h1>' + workingForm;
        } else if (url.pathname === '/tid/bootstrap') {
          // T-BKI-style bootstrap retains state on the relying-party origin
          // before the real T-ID authorization request exists. This must stay
          // an ordinary navigation rather than a guessed OAuth callback.
          body = `<script>location.replace(${JSON.stringify(auth.href)})</script>`;
        } else if (popupFlow) {
          body = workingForm + `<a href="#" id="login-popup">Вход через T‑ID</a><script>
            document.querySelector('#login-popup').onclick=e=>{e.preventDefault();window.authPopup=window.open(${JSON.stringify(withTotp ? 'about:blank' : auth.href)}, 'tid-popup');
              ${withTotp ? `setTimeout(()=>window.authPopup.location.href=${JSON.stringify(auth.href)}, 100)` : ''}};
            addEventListener('message',e=>{if(e.source===window.authPopup&&e.origin===location.origin&&e.data==='synthetic-authorized')document.body.dataset.authorized='yes'});
            </script>`;
        } else {
          const loginTarget = stateOnlyBootstrap
            ? `${origin}/tid/bootstrap?state=synthetic-state`
            : auth.href;
          body = `<a href="${loginTarget.replaceAll('&', '&amp;')}">Вход через T‑ID</a>`;
        }
      } else if (url.origin === 'https://id.tbank.ru') {
        // Some sites open an empty window before starting the OAuth request.
        // Its URL remains about:blank during the first network response; the
        // authorizer must wait for that document, not fail or read a key early.
        if (popupFlow && withTotp && url.pathname === '/auth/authorize') await new Promise(resolve => setTimeout(resolve, 1000));
        // Playwright routing does not fulfil every HTTP redirect hop. Use a
        // synthetic immediate page redirect so this fixture cannot accidentally
        // contact example.org and retry the callback. Transaction unit tests
        // separately cover a successful 302 response and callback replay.
        if (sso) return route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: `<script>location.replace(${JSON.stringify(callback)})</script>` });
        if (url.pathname === '/auth/login-post') {
          loginPosts++;
          // Assertions inspect only synthetic request data in the test worker.
          const values = new URLSearchParams(request.postData());
          assert.equal(values.get('phone'), '+70000000000');
          assert.equal(values.get('password'), 'synthetic-password');
          body = 'ok';
        } else if (url.pathname === '/auth/totp') {
          // Match the live T-ID component: only the first of six inputs carries
          // OTP metadata; provider code enables and focuses each following cell.
          const cells = Array.from({ length: 6 }, (_, cell) =>
            `<input ${cell ? 'disabled' : 'autocomplete="one-time-code" inputmode="numeric"'}>`).join('');
          body = `<p>Введите код из приложения для аутентификации</p>${cells}<script>
            const fields=[...document.querySelectorAll('input')];
            for(const field of fields)field.oninput=e=>{if(e.target.value.length!==1)return;
              const next=fields[fields.indexOf(e.target)+1];if(next){next.disabled=false;next.focus()}
              else location.href=${JSON.stringify(callback)}};
          </script>`;
        } else body = stateOnlyBootstrap ? `<form id="phone-step"><label>Телефон<input id="phone" name="phone" autocomplete="tel" value="+7"></label><button type="submit"><span aria-hidden="true">›</span></button></form><form id="password-step" hidden><input name="phone" type="hidden"><label>Пароль<input id="password" name="password" type="password" autocomplete="current-password" readonly onfocus="this.readOnly=false"></label><button>Войти</button></form><script>
          const phone=document.querySelector('#phone');
          phone.oninput=()=>{const digits=phone.value.replace(/\\D/g,'');const national=(digits.startsWith('7')?digits.slice(1):digits).slice(0,10);phone.value='+7'+national};
          document.querySelector('#phone-step').onsubmit=e=>{e.preventDefault();document.querySelector('#phone-step').hidden=true;const passwordStep=document.querySelector('#password-step');passwordStep.hidden=false;passwordStep.querySelector('input[name=phone]').value=phone.value};
          document.querySelector('#password-step').onsubmit=async e=>{e.preventDefault();await fetch('/auth/login-post',{method:'POST',body:new URLSearchParams(new FormData(e.target))});location.href=${JSON.stringify(withTotp ? 'https://id.tbank.ru/auth/totp' : callback)}};
          </script>` : `<form><label>Телефон<input id="phone" name="phone" autocomplete="tel" value="+7"></label><label>Пароль<input id="password" name="password" type="password" autocomplete="current-password" readonly onfocus="this.readOnly=false"></label><button>Войти</button></form><script>
          const phone=document.querySelector('#phone');
          phone.oninput=()=>{const digits=phone.value.replace(/\\D/g,'');const national=(digits.startsWith('7')?digits.slice(1):digits).slice(0,10);phone.value='+7'+national};
          document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/auth/login-post',{method:'POST',body:new URLSearchParams(new FormData(e.target))});location.href=${JSON.stringify(withTotp ? 'https://id.tbank.ru/auth/totp' : callback)}};
          </script>`;
      } else if (url.origin === 'https://another-workflow.example.org') body = '<h1>Следующий шаг произвольного сценария</h1>';
      else return route.abort();
      await route.fulfill({ status: 200, headers, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8">' + body });
    });
    const page = await context.newPage(); await page.goto(origin);
    const navigationEvidence = [], seenRequests = new WeakSet();
    context.on('request', request => {
      if (!request.isNavigationRequest()) return;
      navigationEvidence.push({ callback: new URL(request.url()).pathname === '/callback',
        sameObject: seenRequests.has(request), redirected: Boolean(request.redirectedFrom()), method: request.method() });
      seenRequests.add(request);
    });
    await assert.rejects(createTIdAuthorization(page, { ...identity, configHome: config.root, origin }), /authorization_permission_required/);
    const requestTitle = 'Синтетический вход через T‑ID';
    current = await createTIdAuthorization(page, { ...identity, configHome: config.root, origin, confirm: true, requestTitle });
    assert.equal(current.page, page); assert.equal(current.context, context);
    if (popupFlow) {
      // In-memory form text and selected File objects must survive OAuth; a
      // replacement Page, reload or storageState round-trip would lose these.
      await page.locator('input[name=arbitrary]').fill('Черновик до авторизации');
      await page.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic-draft') });
    }
    await page.getByRole('link', { name: 'Вход через T‑ID' }).click();
    const info = await current.request;
    assert.equal(info.origin, origin); assert.ok(info.arguments.includes('--confirm'));
    assert.deepEqual(info.arguments.slice(-2), ['--request-title', requestTitle]);
    assert.doesNotMatch(JSON.stringify(info), /token|port|password|synthetic-state|synthetic-code/);
    const authorization = await readAuthorization(config.root, identity, info.sessionId, info.requestId, origin, helper);
    const authorizer = new TIdAuthorizer({ identity, leaseId, guardPid: process.pid, authorization, authorizerControl },
      { permit, onPhase: async () => {} });
    // A request without the native callback must fail before claim or input.
    await assert.rejects(requestLocal(authorization, { command: 'claim', sessionId: info.sessionId,
      requestId: info.requestId, authorizationLease: leaseId, origin, ...identity, confirmed: true, guardPid: process.pid }), /native_permit_required/);
    if (sso) {
      // This case models cookie SSO finishing before the separate authorizer
      // invocation. Wait for the site's own completed callback, not a guessed
      // delay: an immediate same-process claim can legitimately arrive while
      // the synthetic T‑ID document is still starting its redirect. The SDK
      // must independently retain HTTP/commit proof, including a closed popup.
      if (popupFlow) await page.waitForFunction(() => document.body.dataset.authorized === 'yes');
      else await page.getByRole('heading', { name: 'Кабинет', exact: true }).waitFor();
    }
    stage = `auth_${index}`;
    try { await authorizer.claim(); }
    catch (error) {
      const clientState = await Promise.race([current.authenticated.then(() => 'completed', failure => failure.code),
        new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
      throw new Error(`claim=${error.code}; client=${clientState}; navigation=${JSON.stringify(navigationEvidence)}`);
    }
    if (sso) assert.equal(authorizer.completed, true, 'SSO skips credential access');
    else assert.equal(await authorizer.authenticate({ login: '+70000000000', password: 'synthetic-password',
      totp: withTotp ? 'JBSWY3DPEHPK3PXP' : null }), true);
    const result = await current.authenticated;
    assert.equal(result.page, page); assert.equal(result.context, context); assert.equal(loginPosts, sso ? 0 : 1);
    await authorizer.close(); await current.close(); current = null;
    assert.equal(page.isClosed(), false);
    if (popupFlow) {
      await page.waitForFunction(() => document.body.dataset.authorized === 'yes');
      assert.equal(await page.locator('input[name=arbitrary]').inputValue(), 'Черновик до авторизации');
      assert.equal(await page.locator('input[type=file]').evaluate(element => element.files[0].name), 'draft.txt');
      assert.equal(context.pages().length, 1, 'only the site closes its completed popup');
    }
    stage = `scenario_${index}`;
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
