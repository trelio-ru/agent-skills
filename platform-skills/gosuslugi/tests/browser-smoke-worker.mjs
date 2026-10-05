import { execFileSync } from 'node:child_process';
import { ownedPageWindowState } from '../scripts/windows.mjs';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadPlaywright, launchOwnedBrowser, installPopupGuard, Portal } from '../scripts/browser.mjs';
import { createPrompt } from '../scripts/prompt.mjs';
import { guardianConfig } from '../scripts/core.mjs';
import { staticAssetsSmoke } from './static-assets-fixture.mjs';
import { optionBrowserSmoke } from './option-browser-fixture.mjs';

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
// The native guardian intentionally kills a hung worker without a JS finally.
// Save fixed, value-free checkpoints so such a failure reports its stage
// instead of an unrelated ENOENT while reading the final result.
const checkpoint = phase => fs.writeFile(config.file,
  JSON.stringify({ ok: false, phase, diagnostic: `Synthetic browser stopped before completing ${phase}` }), { mode: 0o600 });
// Read-only OS evidence: no window titles, document contents or UI actions.
// Checking the owned PID tolerates the user switching between unrelated apps.
function assertBrowserInBackground(browserPid, phase = "automatic operations") {
  if (process.platform !== 'darwin') return;
  const front = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
  assert.match(front, /^ASN:[a-f0-9x-]+:$/i);
  const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', front], { encoding: 'utf8' });
  const match = info.match(/"pid"=(\d+)/); assert.ok(match, 'foreground PID is readable');
  assert.notEqual(Number(match[1]), browserPid, `automatic browser operations must not take OS focus: ${phase}`);
}
try {
  await checkpoint('browser_launch');
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit });
  const browserPid = owned.server.process().pid;
  assertBrowserInBackground(browserPid);
  await checkpoint('inactive_window_creation');
  const focusContext = await owned.browser.newContext({ viewport: null });
  await focusContext.newPage();
  assertBrowserInBackground(browserPid);
  await focusContext.close();
  await checkpoint('static_assets');
  await staticAssetsSmoke(owned.browser, permit);
  assertBrowserInBackground(browserPid);
  await checkpoint('external_esia_service');
  assertBrowserInBackground(browserPid);
  await checkpoint('local_form');
  const local = await owned.browser.newContext({ viewport: null, serviceWorkers: 'block' });
  const form = await local.newPage(); let openings = 0;
  assert.equal(await ownedPageWindowState(form), 'normal');
  assertBrowserInBackground(browserPid);
  // Emulate the document viewport without resizing the native macOS window.
  // Browser.setWindowBounds used by Playwright setViewportSize can activate it.
  const layoutSession = await local.newCDPSession(form);
  const viewport = (width, height) => layoutSession.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, dontSetVisibleSize: true });
  await viewport(375, 1000);
  prompt = await createPrompt({ open: async url => { openings++; await form.goto(url); }, timeoutMs: 20000 });
  const credentialInput = prompt.ask('credentials');
  await form.locator('#form').waitFor({ state: 'visible' });
  await form.screenshot({ path: path.join(config.root, 'empty-form-mobile.png'), fullPage: true });
  assert.equal(await form.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await viewport(1200, 1100);
  await form.screenshot({ path: path.join(config.root, 'empty-form-desktop.png'), fullPage: true });
  await form.locator('#login').fill('+70000000000');
  await form.locator('#password').fill('synthetic-password-only');
  await form.locator('#submit').click();
  const credentials = await credentialInput; assert.equal(credentials.totp, null);
  let phase, saved, loginEntries = 0;
  const portal = new Portal(owned.browser, permit, { onPhase: next => { phase = next; },
    persist: async value => { saved = value; },
    askCode: async () => {
      const answer = prompt.ask('code');
      await form.locator('#code-fields').waitFor({ state: 'visible' });
      await form.locator('#code').fill('654321'); await form.locator('#submit').click(); return answer;
    } });
  portal.context = await owned.browser.newContext({ viewport: null, serviceWorkers: 'block' });
  await installPopupGuard(portal.context);
  await portal.context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.gosuslugi.ru' && url.pathname === '/404') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <h1>Похоже, ничего не нашлось</h1><footer>Мои документы</footer>
        <button onclick="location.href='https://esia.gosuslugi.ru/login/'">Войти</button>` });
    } else if (url.origin === 'https://www.gosuslugi.ru') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<lib-header-auth><button class="authorized-user" aria-label="Меню пользователя">Меню пользователя</button></lib-header-auth><h1>Услуги</h1><button>Документы</button><p>Подтвердите личность с помощью биометрии</p><script>localStorage.setItem("test-session","synthetic-session-only")</script>' });
    } else if (url.origin === 'https://roles.gosuslugi.ru') {
      const body = url.pathname === '/organisations'
        ? `<h1>Выберите организацию</h1><button onclick="location.href='https://www.gosuslugi.ru/lk'">ООО Синтетическая организация</button><button>Отмена</button>`
        : `<h1>Войти как</h1><button onclick="location.href='https://www.gosuslugi.ru/lk'">Войти как частное лицо – Синтетический Пользователь</button>
          <button onclick="location.href='https://roles.gosuslugi.ru/organisations'">Юридическое лицо</button><button>Принять согласие</button>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    } else if (url.origin === 'https://esia.gosuslugi.ru') {
      loginEntries++;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ru"><body><h1>Синтетическая ЕСИА</h1>
<form id="f"><p>Можно выбрать вход по одноразовому коду</p><input id="login" type="tel"><button>Продолжить</button></form>
<script>let step=0;const f=document.getElementById('f');f.onsubmit=e=>{e.preventDefault();
if(step===0){if(document.getElementById('login').value!=='+70000000000')throw Error('synthetic login');f.innerHTML='<label>Пароль<input id="new-password-component" type="text"></label><button>Войти</button>';step=1}
else if(step===1){if(document.getElementById('new-password-component').value!=='synthetic-password-only')throw Error('synthetic password');
f.innerHTML='<p>Введите код из SMS</p>'+Array.from({length:6},()=>'<input type="tel" autocomplete="one-time-code">').join('')+'<button>Подтвердить</button>';
f.oninput=()=>{const fields=[...f.querySelectorAll('input')];for(const field of fields)field.value=field.value.slice(-1);
if(fields.every(field=>field.value.length===1)){if(fields.map(field=>field.value).join('')!=='654321')throw Error('synthetic code');location.href='https://roles.gosuslugi.ru/roles'}};step=2}
else{throw Error('must not double-submit segmented code')}};</script></body></html>` });
    } else await route.abort();
  });
  // Reproduce the reported rendered error page, including misleading footer
  // text. The runtime must use its one public sign-in control and enter ESIA
  // in the same tab before it can classify the session as authenticated.
  portal.page = await portal.context.newPage(); await portal.page.goto('https://www.gosuslugi.ru/404');
  assert.equal((await portal.inspectAuth()).challenge, 'none', 'phone input is not an OTP request');
  await checkpoint('public_entry_and_authentication');
  assert.equal(await portal.authenticate(credentials), true); assert.equal(phase, 'ready');
  assert.equal(loginEntries, 1); assert.equal(portal.loginEntryClicked, true);
  assert.equal(portal.roleChoiceClicked, true); assert.equal(portal.selectedRoleKind, 'personal');
  assert.equal(portal.roleChoiceRequired, false);
  assert.equal(openings, 1); assert.equal(owned.server.process().pid, browserPid);
  assertBrowserInBackground(browserPid);
  assert.equal(await ownedPageWindowState(portal.page), 'normal', 'automatic authentication must not minimize or restore the window');
  assert.equal(saved.origins[0].localStorage[0].value, 'synthetic-session-only');
  const snapshot = await portal.snapshot(value => value); assert.ok(!snapshot.text.includes('synthetic-session-only'));
  assert.ok(snapshot.controls.some(control => control.label === 'Меню пользователя'));
  await checkpoint('form_option_selection');
  await optionBrowserSmoke(portal);
  assertBrowserInBackground(browserPid, 'form option selection');
  await checkpoint('explicit_role_choice');
  await portal.page.goto('https://roles.gosuslugi.ru/roles');
  assert.equal(await portal.authenticate(credentials, 'manual'), false);
  assert.equal(portal.roleChoiceRequired, true);
  const roles = await portal.roles();
  assert.equal(roles.choices.some(value => /согласие/.test(value.label)), false);
  const organisation = roles.choices.find(value => value.label === 'Юридическое лицо');
  assert.ok(organisation);
  // Re-reading the chooser invalidates the prior reference even if it still
  // looks identical. Operator selection uses only the current bounded list.
  const freshRoles = await portal.roles();
  await assert.rejects(portal.selectRole(organisation.ref), /fresh_role_reference_required/);
  await portal.selectRole(freshRoles.choices.find(value => value.label === 'Юридическое лицо').ref);
  assert.equal(await portal.authenticate(credentials, 'manual'), false);
  const companies = await portal.roles();
  assert.deepEqual(companies.choices.map(value => value.label), ['ООО Синтетическая организация']);
  const company = companies.choices[0];
  await portal.selectRole(company.ref);
  await assert.rejects(portal.selectRole(company.ref), /fresh_role_reference_required/);
  assert.equal(await portal.authenticate(credentials, 'manual'), true);
  assert.equal(portal.selectedRoleKind, 'other');
  // A new snapshot cannot authorise repeating a previously dispatched choice
  // after an ambiguous provider result in this same lease.
  await portal.page.goto('https://roles.gosuslugi.ru/organisations');
  const repeated = await portal.roles();
  await assert.rejects(portal.selectRole(repeated.choices[0].ref), /role_choice_already_attempted/);
  await portal.page.goto('https://www.gosuslugi.ru/lk');
  await checkpoint('browser_cleanup');
  const completed = cleanup => fs.writeFile(config.file, JSON.stringify({ ok: true, openings, browserPid, phase, cleanup }), { mode: 0o600 });
  // A connected Chrome close can hang on hosted macOS even after all browser
  // assertions passed. Match the production worker's two-second shutdown
  // fallback: exiting closes the native pipe and the guardian reaps its owned
  // browser. The parent independently verifies that PID is gone before it
  // accepts this result; merely writing ok here is not sufficient proof.
  const cleanupFallback = setTimeout(async () => { await completed('native_fallback'); process.exit(0); }, 2000);
  prompt.close(); prompt = null;
  await local.close(); await portal.close(); await owned.browser.close(); await owned.server.close();
  clearTimeout(cleanupFallback);
  await completed('graceful');
  process.exit(0);
} catch (error) {
  prompt?.close(); await owned?.server.kill().catch(() => {});
  // This diagnostic exists only in a test whose complete network is synthetic.
  // Still redact the fixture inputs so it cannot normalize secret-bearing logs.
  const diagnostic = ['synthetic-password-only', '+70000000000', '654321']
    .reduce((text, value) => text.split(value).join('[synthetic]'), String(error.stack || error)).slice(0, 2500);
  await fs.writeFile(config.file, JSON.stringify({ ok: false, phase: 'synthetic_smoke_failed', diagnostic }), { mode: 0o600 });
  process.exit(1);
}
