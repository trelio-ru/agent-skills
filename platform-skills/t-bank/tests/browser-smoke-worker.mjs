import './http-host-fixture.mjs';
import readline from 'node:readline';
import { newBackgroundContext } from '../scripts/windows.mjs';
import { assertBackground, testBackgroundStorage } from './background-fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadPlaywright, launchOwnedBrowser, Portal } from '../scripts/browser.mjs';
import { createPrompt } from '../scripts/prompt.mjs';
import { guardianConfig, totpCode } from '../scripts/core.mjs';
import { testBankActions } from './page-actions-fixture.mjs';
import { testPlaywrightScenarios } from './playwright-scenario-fixture.mjs';

// Explicit synthetic GUI regression. Every provider request is intercepted;
// this file neither opens a real account nor touches an existing browser profile.
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
const waiting = new Map(); let sequence = 0;
lines.on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(); waiting.delete(packet.id); });
const permit = async (op = 'permit', extra = {}) => {
  const id = ++sequence, ack = new Promise(resolve => waiting.set(id, resolve));
  process.stdout.write(`${JSON.stringify({ id, op, ...extra })}\n`); await ack;
};
let owned, prompt;
let progress = 'opening';
const checkpoint = async value => { progress = value; await fs.writeFile(`${config.file}.progress`, value, { mode: 0o600 }); };
// This test actor represents the human at the provider page, independently of
// the runtime. No local listener accepts the code. The runtime must wait for
// this actor to submit it and then recognize the authenticated bank page.
async function authenticateWithHuman(bank, credentials, code) {
  const onPhase = bank.onPhase;
  let manualInputs = 0, actor, timer, rejectActor;
  const actorFailure = new Promise((_resolve, reject) => { rejectActor = reject; });
  bank.onPhase = next => {
    onPhase(next);
    if (next !== 'code_required') return;
    manualInputs++;
    actor = (async () => {
      assert.equal(manualInputs, 1, 'one human challenge must not refocus or repeat');
      assert.equal(owned.browser.contexts().length, 1, 'setup context must already be closed');
      assert.equal(bank.context.pages().length, 1, 'the bank owns the only active page');
      assert.ok(code, 'saved TOTP must not require manual input');
      // Let the runtime enter its passive wait before the synthetic human acts.
      await bank.page.waitForTimeout(650);
      const fields = bank.page.locator('#otp,input[autocomplete="one-time-code"]');
      const count = await fields.count();
      for (let index = 0; index < count; index++) assert.equal(await fields.nth(index).inputValue(), '');
      if (count === 6) {
        // A real human types into the active cell; the provider enables and
        // focuses the next cell, then submits automatically after the sixth.
        await fields.first().pressSequentially(code, { delay: 60 });
      } else {
        await fields.fill(code);
        await bank.page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
      }
    })();
    actor.catch(rejectActor);
  };
  try {
    const ready = await Promise.race([bank.authenticate(credentials), actorFailure,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('synthetic authentication timeout')), 20000); })]);
    await actor;
    return { ready, manualInputs };
  } finally { clearTimeout(timer); bank.onPhase = onPhase; }
}
try {
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit });
  const browserPid = owned.server.process().pid;
  assertBackground(browserPid, 'launch');
  await checkpoint('background-storage');
  await testBackgroundStorage(owned.browser, permit, browserPid);
  const local = await newBackgroundContext(owned.browser, { viewport: null, serviceWorkers: 'block' });
  const form = await local.newPage(); let openings = 0;
  const layout = await local.newCDPSession(form);
  const viewport = (width, height) => layout.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, dontSetVisibleSize: true });
  await viewport(375, 1000);
  assertBackground(browserPid, 'local credential form');
  prompt = await createPrompt({ open: async url => { openings++; await form.goto(url); }, timeoutMs: 75000 });
  const credentialInput = prompt.ask('credentials'); await checkpoint('credentials');
  // The enclosing form also exists in the waiting phase. Capture the actual
  // empty credential fields only after the stage poll has rendered them.
  await form.locator('#credentials').waitFor({ state: 'visible' });
  await form.screenshot({ path: path.join(config.root, 'empty-form-mobile.png'), fullPage: true });
  assert.equal(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await viewport(1200, 1100);
  await form.screenshot({ path: path.join(config.root, 'empty-form-desktop.png'), fullPage: true });
  await form.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await viewport(667, 375);
  await form.locator('main').evaluate(node => { node.style.fontSize = '24px'; });
  assert.equal(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await form.screenshot({ path: path.join(config.root, 'empty-form-dark-landscape.png'), fullPage: true });
  await form.locator('#login').fill('+70000000000');
  await form.locator('#password').fill('synthetic-password-only');
  await form.locator('#submit').click();
  const credentials = await credentialInput; assert.equal(credentials.totp, null); await checkpoint('initial-bank-login');
  const setupUrl = form.url();
  prompt.close(); prompt = null;
  await local.close();
  assert.equal(form.isClosed(), true);
  await assert.rejects(fetch(`${setupUrl}/state`), 'the completed setup listener must be closed');
  let phase, saved;
  const portal = new Portal(owned.browser, permit, { onPhase: next => { phase = next; },
    persist: async value => { saved = value; } });
  portal.context = await newBackgroundContext(owned.browser, { viewport: null, serviceWorkers: 'block' });
  await portal.context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.tbank.ru') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Мои счета</h1><button>Выйти</button><button>Документы</button><script>localStorage.setItem("test-session","synthetic-session-only")</script>' });
    } else if (url.origin === 'https://id.tbank.ru') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ru"><body><h1>Синтетический Т-Банк</h1>
<form id="f"><p>Можно выбрать вход по одноразовому коду</p><input id="login" type="tel"><button>Продолжить</button></form>
<script>let step=0;const f=document.getElementById('f');f.onsubmit=e=>{e.preventDefault();
if(step===0){if(document.getElementById('login').value!=='0000000000')throw Error('synthetic login');f.innerHTML='<label>Пароль<input id="new-password-component" name="password" type="password" readonly onfocus="this.readOnly=false"></label><button>Войти</button>';step=1}
else if(step===1){if(document.getElementById('new-password-component').value!=='synthetic-password-only')throw Error('synthetic password');f.innerHTML='<p>Введите код из SMS</p><input id="otp" type="tel" autocomplete="one-time-code"><button>Подтвердить</button>';step=2}
else{if(document.getElementById('otp').value!=='654321')throw Error('synthetic code');location.href='https://www.tbank.ru/mybank/'}};</script></body></html>` });
    } else await route.abort();
  });
  portal.page = await portal.context.newPage(); await portal.page.goto('https://id.tbank.ru/auth/step');
  assert.equal((await portal.inspectAuth()).challenge, 'none', 'phone input is not an OTP request');
  assert.deepEqual(await authenticateWithHuman(portal, credentials, '654321'), { ready: true, manualInputs: 1 });
  assert.equal(phase, 'ready');
  assert.equal(openings, 1); assert.equal(owned.server.process().pid, browserPid);
  assert.equal(saved.origins[0].localStorage[0].value, 'synthetic-session-only');
  const snapshot = await portal.snapshot(value => value); assert.ok(!snapshot.text.includes('synthetic-session-only'));
  const logout = snapshot.controls.find(control => control.label === 'Выйти');
  // Sign-out is not needed to lock the local vault; the browser is closed instead.
  assert.ok(logout);
  await assert.rejects(portal.action({ action: 'click', ref: logout.ref }), /explicit_user_instruction_required/);
  await portal.close();

  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  let scenarios = 0;
  for (const scenario of ['totp-segmented', 'totp-generator-single', 'totp-generator-segmented',
    'totp-authentication-app-segmented', 'totp-authentication-app-without-seed',
    'sms-with-seed', 'totp-without-seed', 'totp-generator-without-seed', 'password-anonymous-button']) {
    await checkpoint(scenario);
    let submitted = 0, checked = false, pageError = false, pinSkips = 0;
    const expectedCode = scenario === 'sms-with-seed' ? '4321' : '654321';
    const useTotp = scenario.startsWith('totp-');
    const manualCode = scenario === 'sms-with-seed' || scenario.endsWith('without-seed');
    const bank = new Portal(owned.browser, permit, { onPhase: next => { phase = next; }, persist: async () => {} });
    if (manualCode) {
      // A saved seed must not turn SMS into an automatic factor; an absent
      // seed must leave the provider's TOTP field entirely to the human.
      bank.typeSecret = async () => { assert.fail('runtime must not type a manual code'); };
      bank.authSubmit = async () => { assert.fail('runtime must not submit a manual code'); };
    }
    bank.context = await newBackgroundContext(owned.browser, { viewport: null, serviceWorkers: 'block' });
    await bank.context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://www.tbank.ru' && url.pathname === '/mybank/') {
        // The live account shell hides logout in its profile menu. Recognition
        // must use the two exact official navigation links in this scenario.
        const navigation = scenario === 'totp-authentication-app-segmented'
          ? '<a href="/mybank/operations/">Операции</a><a href="/mybank/loyalty/">Кэшбэк и бонусы</a>' : '<button>Выйти</button>';
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Счета и операции</h1>${navigation}` }); return;
      }
      if (url.origin !== 'https://id.tbank.ru') { await route.abort(); return; }
      if (url.pathname === '/auth/quick-pin') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<h1>Придумайте код</h1>
          <p>Для быстрого входа в личный кабинет. Работает только в том браузере, где был установлен</p>
          ${'<input inputmode="numeric">'.repeat(4)}
          <a href="/auth/skip-quick-pin">Не сейчас</a><button onclick="throw Error('PIN must not be installed')">Установить</button>` }); return;
      }
      if (url.pathname === '/auth/skip-quick-pin') {
        // A fresh client navigation is routed again by Playwright; following
        // an HTTP redirect can bypass this fixture's interception chain.
        pinSkips++; await route.fulfill({ contentType: 'text/html; charset=utf-8',
          body: '<script>location.href="https://www.tbank.ru/mybank/"</script>' }); return;
      }
      if (url.pathname === '/auth/check') {
        submitted++;
        const value = route.request().postData();
        if (useTotp && !manualCode) assert.ok([Date.now() - 30000, Date.now(), Date.now() + 30000].some(now => value === totpCode(seed, now)), 'synthetic TOTP value did not match');
        else if (scenario === 'password-anonymous-button') assert.equal(value, credentials.password);
        else assert.equal(value, expectedCode);
        checked = true; await route.fulfill({ contentType: 'application/json', body: '{}' }); return;
      }
      const controlled = scenario.startsWith('totp-authentication-app');
      const segmented = controlled || scenario.endsWith('segmented');
      const password = scenario === 'password-anonymous-button';
      // Exercise the actual reported wording without either "TOTP" or
      // "аутентификатор", including a heading split across rendered lines.
      const heading = password ? 'Введите пароль' : scenario.startsWith('totp-generator') ? 'Код из генератора<br>одноразовых паролей'
        : controlled ? 'Введите код из приложения<br>для аутентификации'
        : useTotp ? 'Введите код из приложения-аутентификатора (TOTP)' : 'Введите код из SMS';
      const inputs = password ? '<input name="password" type="password" readonly onfocus="this.readOnly=false">' : segmented
        // Match current T-ID: `text` is the HTML default and the browser OTP
        // hint belongs only to the initially enabled cell.
        ? controlled ? Array.from({ length: 6 }, (_, index) => `<input ${index ? 'disabled' : 'autocomplete="one-time-code" inputmode="numeric"'}>`).join('')
          : '<input inputmode="numeric" autocomplete="one-time-code" maxlength="1">'.repeat(6)
        : '<input type="tel" autocomplete="one-time-code">';
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ru"><body>
        <h1>${heading}</h1>
        <form>${inputs}<button>${password ? '' : 'Подтвердить'}</button></form><script>
        const form=document.querySelector('form'); let sent=false;
        async function send(){if(sent)throw Error('duplicate synthetic submission');sent=true;
          await fetch('/auth/check',{method:'POST',body:[...form.querySelectorAll('input')].map(x=>x.value).join('')});location.href='${scenario === 'totp-authentication-app-segmented' ? '/auth/quick-pin' : 'https://www.tbank.ru/mybank/'}'}
        form.onsubmit=e=>{e.preventDefault();send()};
        ${segmented ? `form.oninput=e=>{const fields=[...form.querySelectorAll('input')];
          ${controlled ? "if(e.target.value.length===1){const next=fields[fields.indexOf(e.target)+1];if(next){next.disabled=false;next.focus()}}" : ''}
          if(fields.every(x=>x.value.length===1))send()}` : ''}
        </script></body></html>` });
    });
    bank.page = await bank.context.newPage(); bank.page.on('pageerror', () => { pageError = true; });
    await bank.page.goto('https://id.tbank.ru/auth/step');
    let result;
    try {
      result = await authenticateWithHuman(bank,
        { ...credentials, totp: scenario.endsWith('without-seed') ? null : seed }, manualCode ? expectedCode : null);
    } catch (error) {
      // Entirely synthetic fixture facts, without field values, make a failing
      // form transition distinguishable from a timeout in a later scenario.
      await checkpoint(`${scenario}: ${JSON.stringify({ submitted, checked, pinSkips, phase,
        path: new URL(bank.page.url()).pathname, codeSubmitted: bank.codesSent.has('totp') })}`);
      throw error;
    }
    assert.equal(result.ready, true); assert.equal(checked, true); assert.equal(pageError, false);
    assert.equal(submitted, 1); assert.equal(result.manualInputs, manualCode ? 1 : 0);
    assert.equal(pinSkips, scenario === 'totp-authentication-app-segmented' ? 1 : 0);
    assert.equal(phase, 'ready'); assert.equal(owned.server.process().pid, browserPid);
    await bank.close(); scenarios++;
  }
  assert.equal(openings, 1, 'the local form opened only for initial credentials, never for codes');
  await checkpoint('authorized-bank-actions');
  await testBankActions(owned.browser, permit);
  await checkpoint('full-playwright-scenarios');
  await testPlaywrightScenarios(owned.browser, permit, config.root);
  await owned.browser.close(); await owned.server.close();
  await fs.writeFile(config.file, JSON.stringify({ ok: true, openings, browserPid, phase, scenarios }), { mode: 0o600 });
  process.exit(0);
} catch (error) {
  // This diagnostic exists only in a test whose complete network is synthetic.
  // Still redact the fixture inputs so it cannot normalize secret-bearing logs.
  const diagnostic = ['synthetic-password-only', '+70000000000', '654321']
    .reduce((text, value) => text.split(value).join('[synthetic]'), String(error.stack || error)).slice(0, 2500);
  await fs.writeFile(config.file, JSON.stringify({ ok: false, phase: 'synthetic_smoke_failed', progress, diagnostic }), { mode: 0o600 });
  prompt?.close(); await owned?.server.kill().catch(() => {});
  process.exit(1);
}
