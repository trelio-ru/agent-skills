import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { authOrigin, bankPageUrl, challengeKind, childEnvironment, officialUrl, providerRequestAllowed, requireThat, RuntimeError, segmentedTotpFields, tIdNationalPhone, totpCode } from './core.mjs';
import { runPrivate } from './native.mjs';
import { describeControl, needsAuthorization, protectedControl, validatedPagePacket, workingPageUrl } from './page-actions.mjs';
import { isOwnedPage, newBackgroundContext } from './windows.mjs';
import { collectOriginStorage, restoreOriginStorage } from './storage.mjs';

export const PLAYWRIGHT_VERSION = '1.60.0';
export function dependenciesDirectory(root) { return path.join(root, 'runtimes', 't-bank', `playwright-${PLAYWRIGHT_VERSION}`); }
export async function loadPlaywright(root) {
  const base = dependenciesDirectory(root), require = createRequire(path.join(base, 'entry.cjs'));
  try {
    requireThat(require('playwright-core/package.json').version === PLAYWRIGHT_VERSION, 'bootstrap_required');
    return require('playwright-core');
  } catch { throw new RuntimeError('bootstrap_required'); }
}
export async function bootstrapBrowser(root) {
  const base = dependenciesDirectory(root);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'npm'))];
  let npm;
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (path.basename(resolved) === 'npm-cli.js') { npm = resolved; break; }
    } catch {}
  }
  requireThat(npm, 'standalone_node_npm_required');
  await runPrivate(process.execPath, [npm, 'install', '--prefix', base, '--ignore-scripts', '--no-audit', '--no-fund',
    '--save-exact', `playwright-core@${PLAYWRIGHT_VERSION}`], { timeout: 120000, limit: 262144 });
  await loadPlaywright(root);
}

export function validatedStorage(state) {
  if (!state) return { cookies: [], origins: [] };
  requireThat(Array.isArray(state.cookies) && Array.isArray(state.origins), 'storage_state_invalid');
  requireThat(state.cookies.length <= 2000 && state.origins.length <= 100, 'storage_state_invalid');
  for (const cookie of state.cookies) requireThat(typeof cookie.domain === 'string' &&
    ['tbank.ru', 'www.tbank.ru', 'id.tbank.ru'].includes(cookie.domain.replace(/^\./, '')), 'storage_state_origin_rejected');
  for (const origin of state.origins) requireThat(officialUrl(origin.origin) && new URL(origin.origin).origin === origin.origin, 'storage_state_origin_rejected');
  return state;
}

export async function launchOwnedBrowser({ playwright, permit, channel = process.platform === 'win32' ? 'msedge' : 'chrome' }) {
  // launchServer exposes the exact child PID for native ownership registration.
  // Its endpoint is private process memory: no CLI/MCP/debug output contains it.
  const server = await playwright.chromium.launchServer({ channel, headless: false, timeout: 30000,
    env: childEnvironment(), args: ['--disable-breakpad', '--disable-crash-reporter'] });
  try {
    await permit('own', { pid: server.process().pid });
    const browser = await playwright.chromium.connect(server.wsEndpoint());
    return { server, browser };
  } catch { await server.kill().catch(() => {}); throw new RuntimeError('browser_ownership_failed'); }
}

export class Portal {
  constructor(browser, permit, { onPhase, persist }) {
    this.browser = browser; this.permit = permit; this.onPhase = onPhase; this.persist = persist;
    this.controls = new Map(); this.snapshotId = 0; this.loginSent = false; this.passwordSent = false; this.codesSent = new Set();
    this.usernameSent = false;
    this.optionalPinSkipped = false;
    this.observedUrl = null;
    this.authenticated = false;
    this.handedOff = false;
    this.storageOrigins = new Set();
  }
  async open(state) {
    await this.permit();
    // Never launchPersistentContext and never storageState({path}). Chrome's
    // empty launcher profile is not used for browsing or credential entry.
    const seed = validatedStorage(state);
    this.storageOrigins = new Set(seed.origins.map(item => item.origin));
    this.context = await newBackgroundContext(this.browser, { storageState: { cookies: seed.cookies, origins: [] }, viewport: null,
      acceptDownloads: true, serviceWorkers: 'block' });
    const moduleUrl = String(process.env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
    requireThat(moduleUrl.startsWith('file:'), 'browser_session_host_required');
    const httpRuntime = await import(moduleUrl);
    this.documentHttp = httpRuntime.createDocumentHttpObserver(this.context, {
      isAllowedUrl: officialUrl,
      // The unauthenticated cabinet may explicitly request ordinary sign-in.
      ignoreStatus: (status, url) => status === 401 && bankPageUrl(url) && !this.authenticated && !this.loginSent && !this.passwordSent,
    });
    this.authRoute = route => {
      const request = route.request();
      // The cabinet may bootstrap chat before the first agent script. Its
      // scripts, XHR and frames need the normal working-app network from that
      // first document, not only after handoff. Main-frame navigation and all
      // auth documents retain the credential-entry policy. Saved secrets are
      // still typed only at authOrigin, never into a cabinet/third-party frame.
      const frame = request.frame();
      const cabinetResource = this.page && frame.page() === this.page && bankPageUrl(this.page.url()) &&
        !(request.isNavigationRequest() && frame === this.page.mainFrame());
      if (cabinetResource) return route.fallback();
      if (!providerRequestAllowed({ url: request.url(), navigation: request.isNavigationRequest(), method: request.method(),
        resourceType: request.resourceType() })) return route.abort('blockedbyclient');
      return route.fallback();
    };
    await this.context.route('**/*', this.authRoute);
    this.cancelAuthDownload = download => { void download.cancel().catch(() => {}); };
    const rememberFrame = frame => {
      if (officialUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
    };
    this.context.on('page', page => {
      page.on('framenavigated', rememberFrame);
      for (const frame of page.frames()) rememberFrame(frame);
    });
    this.authPage = async page => {
      page.on('download', this.cancelAuthDownload);
      // Private storage tabs use exact owned targets; an unrelated popup may
      // not evade the pre-handoff guard by racing their creation event.
      if (this.page && page !== this.page && !await isOwnedPage(page)) await page.close().catch(() => {});
    };
    this.context.on('page', this.authPage);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10000);
    await restoreOriginStorage(this.context, seed, this.permit);
    await this.page.goto('https://www.tbank.ru/mybank/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.assertDocumentAvailable();
  }
  assertDocumentAvailable() {
    const failure = this.documentHttp?.failure(this.page);
    if (failure) throw new RuntimeError('service_http_error', { httpStatus: failure.httpStatus, httpOrigin: failure.origin });
  }
  async inspectAuth() {
    this.assertDocumentAvailable();
    await this.permit();
    requireThat(officialUrl(this.page.url()), 'unexpected_provider_origin');
    const text = (await this.page.locator('body').innerText({ timeout: 10000 })).replace(/\s+/g, ' ');
    const namedPhone = this.page.locator('input[autocomplete="tel"]:visible,input[name="phone"]:visible,input[name="phoneNumber"]:visible');
    const password = this.page.locator('input[type="password"]:not([autocomplete="one-time-code"]):not([inputmode="numeric"]):visible,input[autocomplete="current-password"]:visible,input[name="password"]:visible');
    const username = this.page.locator('input[autocomplete="username"]:visible,input[name="login"]:not([type="tel"]):visible,input[aria-label="Логин"]:visible');
    const hintedCode = this.page.locator('input[autocomplete="one-time-code"]:visible,input[inputmode="numeric"]:visible,input[type="tel"]:visible,input[maxlength="1"]:not([type="password"]):visible');
    // T-ID can expose the OTP hint on only the first of six cells. Prefer the
    // complete safe input group when it is exactly one/four/six controls; the
    // later challenge and segmented-structure checks remain fail-closed.
    const broadCode = this.page.locator('input:not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"]):not([type="range"]):not([type="color"]):not([autocomplete="tel"]):not([autocomplete="username"]):not([name="phone"]):not([name="phoneNumber"]):not([name="password"]):visible');
    const broadCount = await broadCode.count();
    const code = [1, 4, 6].includes(broadCount) ? broadCode : hintedCode;
    // A phone field and an advertisement for code login are not a challenge.
    // Split OTP fields are supported only after this explicit classification.
    const hasCode = await namedPhone.count() === 0 && await password.count() === 0 && await username.count() === 0 &&
      await code.count() > 0 && /введите.{0,60}код|код.{0,60}(смс|sms|приложени|аутентификатор|TOTP|генератор(?:а|е|ом)?\s+одноразовых\s+паролей)|подтвердите вход/i.test(text);
    const login = await namedPhone.count() ? namedPhone : this.page.locator('input[type="tel"]:visible');
    return { text, login, password, username, code, challenge: challengeKind(text, hasCode) };
  }
  async typeSecret(locator, value, delay) {
    await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
    requireThat(await locator.count() === 1, 'auth_input_ambiguous');
    // The bank can remove readonly only after focus. Click the already proven
    // exact field; never remove the attribute or change provider DOM/scripts.
    if (await locator.getAttribute('readonly') !== null) await locator.click();
    requireThat(await locator.isEditable(), 'auth_input_not_editable');
    await locator.fill('');
    await locator.pressSequentially(value, { delay });
  }
  async typePhone(locator, value) {
    const national = tIdNationalPhone(value);
    await this.typeSecret(locator, national, 35);
    await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
    const enteredDigits = await locator.evaluate(node => node.value.replace(/\D/g, ''));
    requireThat(enteredDigits === national || enteredDigits === `7${national}`, 'auth_phone_input_mismatch');
  }
  async authSubmit(pattern, field) {
    await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
    const button = this.page.getByRole('button', { name: pattern }).filter({ visible: true });
    const count = await button.count();
    requireThat(count <= 1, 'auth_submit_ambiguous');
    // Exactly one submission. A timeout after click is ambiguous, not grounds
    // to click another matching button or press Enter as a blind retry.
    if (count === 1) await button.click();
    else {
      // Some selected-profile screens have an anonymous primary button. Enter
      // is the first submit of the same unique form, never a click retry.
      requireThat(field && await field.count() === 1 && await field.isVisible() && await field.isEditable(), 'auth_submit_ambiguous');
      await field.press('Enter');
    }
  }
  async waitForLoginCode(challenge) {
    await this.permit();
    this.onPhase('code_required');
    // The user owns this input and its submission on the bank's existing page.
    // Report the pending input without activating the browser. The user can
    // select its existing window or explicitly request show. Observe only the
    // transition: never read the field or submit a second confirmation.
    for (;;) {
      // inspectAuth asks the native guardian for a fresh permit on every pass.
      // Human input may outlive the short automatic redirect wait, but neither
      // this loop nor resume can extend the original 30-minute session lease.
      const current = await this.inspectAuth();
      if (/неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(current.text)) {
        this.onPhase('user_required'); return false;
      }
      if (!authOrigin(this.page.url()) || current.challenge !== challenge) return true;
      await this.page.waitForTimeout(500);
    }
  }
  async authenticate(credentials) {
    // Never type a saved secret into a context that agent code has observed
    // or instrumented. A later login needs a new protected session, not a
    // resume with the old context's request listeners or init scripts.
    requireThat(!this.handedOff, 'new_session_required_after_handoff');
    this.authenticated = false;
    this.onPhase('authenticating'); let end = Date.now() + 90000;
    while (Date.now() < end) {
      const current = await this.inspectAuth();
      if (/неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(current.text)) {
        this.onPhase('user_required'); return false;
      }
      if (!authOrigin(this.page.url())) {
        if (bankPageUrl(this.page.url()) && !await current.password.count() && !await current.username.count() &&
          current.challenge === 'none' && /Сч[её]т|Карт|Операции|Баланс/i.test(current.text)) {
          // `inspectAuth` intentionally searches broadly for code controls on
          // provider auth documents, because some T-ID layouts mark only the
          // first OTP cell. The authenticated cabinet can also contain one
          // ordinary visible text/tel input (for example search or a product
          // widget), which must not keep a proven account shell in the login
          // loop. Outside the exact auth origins the classified challenge,
          // working URL and account-navigation witnesses are authoritative;
          // explicit password/username controls remain fail-closed above.
          // The current account shell keeps «Выйти» inside a closed menu. Two
          // exact visible account-navigation links prove this shell without
          // opening the profile or inspecting balances. Both destinations must
          // stay in the official /mybank area; an auth URL alone proves nothing.
          const visibleLogout = /Выйти/i.test(current.text);
          let accountNavigation = true;
          for (const name of visibleLogout ? [] : ['Операции', 'Кэшбэк и бонусы']) {
            const link = this.page.getByRole('link', { name, exact: true }).filter({ visible: true });
            if (await link.count() !== 1) { accountNavigation = false; break; }
            const href = await link.getAttribute('href');
            if (!href || !bankPageUrl(new URL(href, this.page.url()).href)) { accountNavigation = false; break; }
          }
          if (visibleLogout || accountNavigation) {
            await this.persist(await this.storage()); this.authenticated = true; this.onPhase('ready'); return true;
          }
        }
      } else {
        if (current.challenge === 'manual') {
          // The live post-password screen offers a browser-local quick PIN and
          // an explicit «Не сейчас». Declining this optional enrollment neither
          // creates a PIN nor satisfies a mandatory security challenge. Strip
          // only the known offer words and re-run the guard, so a concurrent
          // CAPTCHA/device/payment warning still requires the owner.
          const optionalPin = /придумайте\s+код/i.test(current.text) &&
            /для\s+быстрого\s+входа\s+в\s+личный\s+кабинет/i.test(current.text) &&
            /работает\s+только\s+в\s+том\s+браузере/i.test(current.text) &&
            challengeKind(current.text.replace(/придумайте\s+код|быстрого\s+входа/gi, ''), false) === 'none' &&
            await current.password.count() === 0 && await current.username.count() === 0 && await current.code.count() === 4;
          if (optionalPin && !this.optionalPinSkipped) {
            const decline = this.page.getByRole('button', { name: 'Не сейчас', exact: true })
              .or(this.page.getByRole('link', { name: 'Не сейчас', exact: true })).filter({ visible: true });
            if (await decline.count() === 1 && await decline.isEnabled()) {
              await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
              this.optionalPinSkipped = true;
              await decline.click(); await this.page.waitForTimeout(500); continue;
            }
          }
          this.onPhase('user_required'); return false;
        }
        if (current.challenge === 'totp' || current.challenge === 'user_code') {
          if (current.challenge === 'user_code' || !credentials.totp) {
            if (!await this.waitForLoginCode(current.challenge)) return false;
            this.onPhase('authenticating');
            // Only the provider-redirect budget restarts after human input.
            // The worker and native guardian retain the original hard deadline.
            end = Date.now() + 90000;
            continue;
          }
          // Only a saved TOTP is submitted automatically, once per procedure.
          // resume does not erase that guard or retry an ambiguous submission.
          if (this.codesSent.has(current.challenge)) { await this.page.waitForTimeout(500); continue; }
          const count = await current.code.count();
          requireThat(count === 1 || count === 6 || count === 4, 'auth_input_ambiguous');
          const left = 30000 - Date.now() % 30000;
          if (left < 8000) await this.page.waitForTimeout(left + 250);
          await this.permit(); let code = totpCode(credentials.totp);
          // The TOTP time-window wait can change the page: recheck origin AND
          // challenge before typing into an automatically handled factor.
          const fresh = await this.inspectAuth();
          requireThat(authOrigin(this.page.url()) && fresh.challenge === current.challenge && await fresh.code.count() === count, 'auth_challenge_changed');
          let providerSubmitted = false;
          const observeSubmission = request => {
            // Only existence of a request is observed, never headers/body. An
            // ambiguous auto-submit must not cause a second code submission.
            if (officialUrl(request.url()) && (request.isNavigationRequest() || !['GET', 'HEAD'].includes(request.method()))) providerSubmitted = true;
          };
          this.context.on('request', observeSubmission);
          try {
            requireThat(count === 1 || count === code.length, 'auth_code_length_mismatch');
            if (count > 1) {
              const fields = await fresh.code.evaluateAll(elements => elements.map(input => ({
                maxLength: input.getAttribute('maxlength'), type: input.type, inputMode: input.inputMode,
                autocomplete: input.autocomplete, disabled: input.disabled, readOnly: input.readOnly,
              })));
              requireThat(segmentedTotpFields(fields), 'auth_segmented_code_ambiguous');
            }
            // Validation has no provider-side effect. Consume the one-submit
            // guard immediately before the first keystroke, so a rejected field
            // layout is not falsely recorded as a potentially submitted code.
            this.codesSent.add(current.challenge);
            if (count === 1) await this.typeSecret(fresh.code, code, 60);
            else for (let index = 0; index < count; index++) {
              await this.typeSecret(fresh.code.nth(index), code[index], 60);
            }
            code = null;
            // T-Bank's segmented inputs may submit automatically. A visible,
            // explicitly named enabled button is the only additional submit
            // supported here. Never press Enter into an ambiguous OTP transition.
            await this.page.waitForTimeout(1200);
            const after = await this.inspectAuth();
            if (!providerSubmitted && count === 1 && authOrigin(this.page.url()) && after.challenge === current.challenge) {
              const button = this.page.getByRole('button', { name: /^(Продолжить|Подтвердить|Войти|Далее)$/i }).filter({ visible: true });
              requireThat(await button.count() <= 1, 'auth_submit_ambiguous');
              if (await button.count() === 1 && await button.isEnabled()) await this.authSubmit(/^(Продолжить|Подтвердить|Войти|Далее)$/i);
            }
          } finally { code = null; this.context.off('request', observeSubmission); }
        } else if (!this.loginSent && await current.login.count() === 1) {
          this.loginSent = true; await this.typePhone(current.login, credentials.login);
          if (!await current.password.count()) await this.authSubmit(/^(Продолжить|Далее|Войти)$/i, current.login);
        } else if (!this.passwordSent && await current.password.count() === 1) {
          if (await current.username.count() > 0) {
            requireThat(credentials.username && !this.usernameSent, 'username_required');
            this.usernameSent = true; await this.typeSecret(current.username, credentials.username, 35);
          }
          this.passwordSent = true; await this.typeSecret(current.password, credentials.password, 60);
          await this.authSubmit(/^(Войти|Продолжить|Далее)$/i, current.password);
        }
      }
      await this.page.waitForTimeout(500);
    }
    this.onPhase('user_required'); return false;
  }
  async storage() {
    await this.permit();
    for (const page of this.context.pages()) for (const frame of page.frames()) {
      if (officialUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
    }
    const state = await collectOriginStorage(this.context, [...this.storageOrigins], this.permit);
    // External tabs are allowed after handoff, but their credentials do not
    // become part of the bank's persistent vault. They expire with this one
    // browser. Preserve the original, exact bank-only encrypted namespace.
    return validatedStorage({
      cookies: state.cookies.filter(cookie => ['tbank.ru', 'www.tbank.ru', 'id.tbank.ru'].includes(cookie.domain.replace(/^\./, ''))),
      origins: state.origins.filter(origin => officialUrl(origin.origin)),
    });
  }
  async playwrightContext() {
    this.assertDocumentAvailable();
    await this.permit();
    requireThat(this.authenticated, 'session_not_ready');
    if (!this.handedOff) {
      // A fresh login proof alone may be stale by the time the first script
      // arrives. Do not expose a returned login/challenge screen as ready.
      requireThat(workingPageUrl(this.page.url()), 'authentication_is_private');
      requireThat(await this.page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count() === 0, 'authentication_is_private');
      // Do not reuse the snapshot helper's content filter here. A harmless
      // "Полные реквизиты" button on the account page must not prevent full
      // control; selecting safe reads after handoff is the agent's duty.
      await this.clearControls();
      // Set the irreversible boundary first. A partially failed handoff must
      // never make saved-password entry available to an instrumented context.
      this.handedOff = true;
      if (this.authRoute) await this.context.unroute('**/*', this.authRoute);
      if (this.authPage) this.context.off('page', this.authPage);
      if (this.cancelAuthDownload) for (const page of this.context.pages()) page.off('download', this.cancelAuthDownload);
    }
    if (!this.page || this.page.isClosed()) this.page = this.context.pages().at(-1) || await this.context.newPage();
    // These are the real objects, with their complete methods. No Proxy,
    // selector whitelist, page-count rule or business-action filter follows.
    return { context: this.context, page: this.page };
  }
  async actionSafe() {
    this.assertDocumentAvailable();
    await this.permit();
    requireThat(workingPageUrl(this.page.url()), 'authentication_is_private');
    requireThat(await this.page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count() === 0, 'authentication_is_private');
    const text = await this.page.locator('body').innerText();
    // A payment review is an ordinary working page. Actual secret/challenge
    // surfaces stay private even with confirm: it authorizes the requested
    // action, never disclosure or automatic entry of a bank security factor.
    requireThat(!/CVC|CVV|секретный код|полные реквизиты/i.test(text), 'private_bank_screen');
    const fields = this.page.locator('input[inputmode="numeric"]:visible,input[type="tel"]:visible,input[name="code"]:visible,input[name="otp"]:visible');
    requireThat(!(await fields.count() && /(?:введите|ввести|укажите).{0,50}код|код.{0,50}(SMS|смс|приложени)/i.test(text)), 'bank_verification_required');
  }
  async snapshot(redact) {
    await this.actionSafe();
    for (const control of this.controls.values()) await control.element.dispose();
    this.controls.clear(); this.snapshotId++;
    const text = await this.page.locator('body').evaluate(body => {
      const copy = body.cloneNode(true);
      copy.querySelectorAll('script,style,input,textarea,select,[contenteditable],noscript').forEach(node => node.remove());
      return (copy.textContent || '').replace(/\s+/g, ' ').slice(0, 16000);
    });
    const elements = await this.page.locator('button,a,input,textarea,select,[role="button"],[role="checkbox"],[role="radio"],[role="option"],[contenteditable="true"],[contenteditable="plaintext-only"]').elementHandles();
    const controls = [];
    for (const element of elements.slice(0, 400)) {
      if (!await element.isVisible()) { await element.dispose(); continue; }
      const meta = await element.evaluate(describeControl);
      if (protectedControl(meta)) { await element.dispose(); continue; }
      const ref = `${this.snapshotId}:${controls.length + 1}`;
      this.controls.set(ref, { element, meta, url: this.page.url() });
      // Keep raw targets inside the worker; href may carry a private token.
      controls.push({ ref, tag: meta.tag, type: meta.type, role: meta.role, editable: meta.editable, label: redact(meta.label),
        authorizationRequired: needsAuthorization({ action: 'click' }, meta),
        ...(meta.options ? { options: meta.options.map(option => ({ ...option, value: redact(option.value), label: redact(option.label) })) } : {}) });
    }
    this.observedUrl = this.page.url();
    return { origin: new URL(this.observedUrl).origin, text: redact(text), controls, truncated: true };
  }
  async action(packet) {
    validatedPagePacket(packet);
    await this.actionSafe();
    if (packet.action === 'navigate') {
      requireThat(this.observedUrl === this.page.url(), 'fresh_snapshot_required');
      const authorizationRequired = needsAuthorization(packet);
      if (packet.dryRun) return { dryRun: true, action: packet.action, authorizationRequired };
      requireThat(!authorizationRequired || packet.confirm === true, 'explicit_user_instruction_required');
      // Consume the observation before the browser can send a request. Failed
      // navigation/click is ambiguous and cannot leave an old reusable ref.
      await this.clearControls();
      await this.permit();
      await this.page.goto(packet.url, { waitUntil: 'domcontentloaded' }); return { ok: true };
    }
    const target = this.controls.get(packet.ref);
    requireThat(target && target.url === this.page.url(), 'fresh_snapshot_required');
    requireThat(await target.element.evaluate(node => node.isConnected), 'fresh_snapshot_required');
    const meta = await target.element.evaluate(describeControl);
    requireThat(JSON.stringify(meta) === JSON.stringify(target.meta), 'fresh_snapshot_required');
    requireThat(!protectedControl(meta), 'private_bank_screen');
    requireThat(await target.element.isVisible() && await target.element.isEnabled(), 'control_not_available');
    // Preview checks the same control/action compatibility as execution. It
    // must not promise that a checkbox can be filled or a div can be selected.
    if (packet.action === 'fill') requireThat((['input', 'textarea'].includes(meta.tag) || meta.editable) &&
      !/password|file|hidden|submit|button|checkbox|radio/.test(meta.type), 'input_not_allowed');
    if (packet.action === 'select') requireThat(meta.tag === 'select' && meta.options.some(option => option.value === packet.value && !option.disabled), 'input_not_allowed');
    if (packet.action === 'check') requireThat(['checkbox', 'radio'].includes(meta.type) || ['checkbox', 'radio'].includes(meta.role), 'input_not_allowed');
    const authorizationRequired = needsAuthorization(packet, meta);
    if (packet.dryRun) return { dryRun: true, action: packet.action, ref: packet.ref, authorizationRequired };
    requireThat(!authorizationRequired || packet.confirm === true, 'explicit_user_instruction_required');
    // No persistent write mode, and no replay after an unknown result. Keep
    // only the selected handle until its one invocation finishes; consume all
    // refs first, including when Playwright later reports a timeout.
    await this.permit();
    const handles = [...this.controls.values()]; this.controls.clear(); this.observedUrl = null;
    try {
      if (packet.action === 'click') {
        await target.element.click();
      } else if (packet.action === 'fill') {
        await target.element.fill(packet.text);
      } else if (packet.action === 'select') {
        await target.element.selectOption(packet.value);
      } else if (packet.action === 'check') {
        await target.element.setChecked(packet.checked);
      } else if (packet.action === 'press') {
        await target.element.press(packet.key);
      }
      return { ok: true };
    } finally { for (const control of handles) await control.element.dispose().catch(() => {}); }
  }
  async clearControls() {
    const handles = [...this.controls.values()]; this.controls.clear(); this.observedUrl = null;
    for (const control of handles) await control.element.dispose().catch(() => {});
  }
  async show() {
    await this.permit(); requireThat(officialUrl(this.page.url()), 'unexpected_provider_origin');
    // A manual bank check stays in the same protected browser. Showing it
    // does not inspect or submit its fields and does not extend the lease.
    await this.clearControls(); await this.page.bringToFront();
    return { ok: true, requiredAction: 'Выполните проверку в текущем окне Т-Банка, затем продолжите со свежего snapshot.' };
  }
  async close() { this.documentHttp?.dispose(); await this.context?.close(); }
}
