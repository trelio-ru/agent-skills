import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  childEnvironment,
  officialCourtOrigin,
  officialCourtUrl,
  officialEsiaUrl,
  requireThat,
  RuntimeError,
  serviceHttpFailure,
  staticEsiaResourceAllowed,
  UUID,
} from './core.mjs';
import {
  describeControl,
  needsAuthorization,
  protectedControl,
  readOnlyNavigation,
  validatedPagePacket,
  workingPageUrl,
} from './page-actions.mjs';
import { collectOriginStorage, restoreOriginStorage } from './storage.mjs';
import { newBackgroundContext } from './windows.mjs';

export async function browserRuntime(explicitModuleUrl = null) {
  const moduleUrl = String(explicitModuleUrl || process.env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
  requireThat(moduleUrl.startsWith('file:'), 'browser_session_host_required');
  return import(moduleUrl);
}

export async function loadPlaywright(explicitModuleUrl = null) {
  const runtime = await browserRuntime(explicitModuleUrl);
  return runtime.loadPlaywright();
}

export async function bootstrapBrowser() {
  const runtime = await browserRuntime();
  return runtime.bootstrapPlaywright();
}

export function validatedStorage(state) {
  if (!state) return { cookies: [], origins: [] };
  requireThat(Array.isArray(state.cookies) && Array.isArray(state.origins) &&
    state.cookies.length <= 2000 && state.origins.length <= 100, 'storage_state_invalid');
  for (const cookie of state.cookies) {
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '') : '';
    requireThat(domain === 'sudrf.ru' || domain.endsWith('.sudrf.ru'), 'storage_state_origin_rejected');
  }
  for (const origin of state.origins) {
    requireThat(officialCourtOrigin(origin.origin), 'storage_state_origin_rejected');
  }
  return state;
}

export async function launchOwnedBrowser({ playwright, permit, channel = process.platform === 'win32' ? 'msedge' : 'chrome' }) {
  // launchServer gives the native guardian the exact child PID before any
  // session state enters Chromium. Its endpoint stays in private process RAM.
  const server = await playwright.chromium.launchServer({
    channel,
    headless: false,
    timeout: 30000,
    env: childEnvironment(),
    args: ['--disable-breakpad', '--disable-crash-reporter'],
  });
  try {
    await permit('own', { pid: server.process().pid });
    const browser = await playwright.chromium.connect(server.wsEndpoint());
    return { server, browser };
  } catch {
    await server.kill().catch(() => {});
    throw new RuntimeError('browser_ownership_failed');
  }
}

function exactClientDescriptor(value) {
  requireThat(value && !Array.isArray(value) && typeof value === 'object', 'gosuslugi_client_invalid');
  requireThat(Object.keys(value).sort().join() ===
    'browserAccess,configHome,guidePath,modulePath,options,ownership', 'gosuslugi_client_invalid');
  requireThat(typeof value.modulePath === 'string' && path.isAbsolute(value.modulePath) &&
    path.basename(value.modulePath) === 'playwright-client.mjs' && fs.existsSync(value.modulePath),
  'gosuslugi_client_invalid');
  requireThat(typeof value.guidePath === 'string' && path.isAbsolute(value.guidePath) &&
    path.basename(value.guidePath) === 'playwright-client.md' && fs.existsSync(value.guidePath) &&
    path.dirname(path.dirname(value.guidePath)) === path.dirname(path.dirname(value.modulePath)) &&
    value.ownership === 'caller' && value.browserAccess === 'full_playwright_context',
  'gosuslugi_client_invalid');
  requireThat(typeof value.configHome === 'string' && path.isAbsolute(value.configHome),
    'gosuslugi_client_invalid');
  requireThat(value.options && Object.keys(value.options).sort().join() === 'company,member' &&
    UUID.test(value.options.company || '') && UUID.test(value.options.member || ''), 'gosuslugi_client_invalid');
  return value;
}

const safeAuthorizationError = error => {
  const code = error && typeof error === 'object' ? error.code : null;
  return new RuntimeError(typeof code === 'string' && /^[a-z_]{1,80}$/.test(code)
    ? code : 'esia_authorization_result_unknown', serviceHttpFailure(error));
};

export class CourtPortal {
  constructor(browser, permit) {
    this.browser = browser;
    this.permit = permit;
    this.controls = new Map();
    this.snapshotId = 0;
    this.observedUrl = null;
    this.storageOrigins = new Set();
    this.authorization = null;
    this.documentResponses = new WeakMap();
  }

  async open(state) {
    await this.permit();
    const seed = validatedStorage(state);
    this.storageOrigins = new Set(seed.origins.map(item => item.origin));
    this.context = await newBackgroundContext(this.browser, {
      storageState: { cookies: seed.cookies, origins: [] },
      viewport: null,
      acceptDownloads: true,
      serviceWorkers: 'block',
    });
    await this.context.route('**/*', route => {
      const request = route.request();
      const info = {
        url: request.url(),
        navigation: request.isNavigationRequest(),
        method: request.method(),
        resourceType: request.resourceType(),
      };
      if (officialCourtUrl(info.url)) return route.continue();
      // ЕСИА is admitted only while a request created from this exact court
      // page is active. Its static CDN remains a resource host, never a second
      // navigation or persistent session origin.
      if (this.authorization && (officialEsiaUrl(info.url) || staticEsiaResourceAllowed(info))) {
        return route.continue();
      }
      return route.abort('blockedbyclient');
    });
    this.context.on('response', response => {
      // Observe only documents in their exact Page. Asset/XHR errors, a sibling
      // tab or a response from the previous navigation must not mask this page.
      // The complete URL stays transiently in RAM for identity comparison;
      // only a numeric status and origin can cross the public error boundary.
      try {
        const request = response.request();
        const frame = request.frame();
        if (request.isNavigationRequest() && frame === frame.page().mainFrame()) {
          this.documentResponses.set(frame.page(), { url: response.url(), status: response.status() });
        }
      } catch { /* A detached frame is not evidence for the current document. */ }
    });
    const remember = frame => {
      if (officialCourtUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
    };
    this.context.on('page', page => {
      page.on('framenavigated', remember);
      for (const frame of page.frames()) remember(frame);
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10000);
    await restoreOriginStorage(this.context, seed, this.permit);
    const response = await this.page.goto('https://ej.sudrf.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.assertAuthorizationDocumentAvailable(response);
  }

  assertDocumentAvailable(response = null) {
    const observed = response ? { url: response.url(), status: response.status() }
      : this.documentResponses.get(this.page);
    if (!observed || observed.url !== this.page.url() || !Number.isInteger(observed.status) ||
        observed.status < 400 || observed.status > 599) return;
    if (!officialCourtUrl(observed.url) && !officialEsiaUrl(observed.url)) return;
    throw new RuntimeError('service_http_error', {
      httpStatus: observed.status, httpOrigin: new URL(observed.url).origin,
    });
  }

  async assertAuthorizationDocumentAvailable(response = null) {
    const page = this.page;
    const url = page.url();
    try {
      this.assertDocumentAvailable(response);
    } catch (error) {
      // The public ГАС login document returns 401 while still rendering
      // the normal agreement/ЕСИА form. Only pre-login navigation may accept
      // that challenge, and only after the same complete consent check used
      // before the login click. A bare 401, another origin, changed agreement,
      // callback or working cabinet document must remain a real HTTP failure.
      if (!(error instanceof RuntimeError) || error.code !== 'service_http_error' ||
          error.httpStatus !== 401 || error.httpOrigin !== 'https://ej.sudrf.ru' ||
          this.authorization) throw error;
      const form = await this.standardAuthorizationForm().catch(() => null);
      // Form inspection awaits DOM reads. Do not carry its exception across a
      // navigation, a replaced page or an authorization started in the meantime.
      if (!form?.standardAgreement || this.page !== page || page.url() !== url ||
          this.authorization) throw error;
    }
  }

  async ensureAuthorizationPage() {
    await this.permit();
    requireThat(officialCourtUrl(this.page.url()), 'unexpected_provider_origin');
    await this.assertAuthorizationDocumentAvailable();
    const checkbox = this.page.locator('#iAgree[type="checkbox"]:visible');
    if (await checkbox.count() === 1) return;
    const entry = this.page.locator('a[title="Вход"]');
    requireThat(await entry.count() === 1, 'court_login_entry_unavailable');
    if (!await entry.isVisible()) {
      // The native background target starts with a compact window. On the live
      // portal Bootstrap therefore moves the exact login link into a collapsed
      // navigation menu. Expanding that known menu is an ordinary background
      // page action: it neither brings the tab to front nor weakens the exact
      // login selector and origin checks below.
      const menu = this.page.locator('button.navbar-toggle:visible')
        .filter({ hasText: /^\s*Показать меню\s*$/ });
      requireThat(await menu.count() === 1, 'court_login_entry_unavailable');
      await menu.click();
    }
    requireThat(await entry.isVisible(), 'court_login_entry_unavailable');
    await entry.click();
    await this.page.waitForLoadState('domcontentloaded');
    requireThat(new URL(this.page.url()).origin === 'https://ej.sudrf.ru', 'unexpected_provider_origin');
    await this.assertAuthorizationDocumentAvailable();
  }

  async standardAuthorizationForm() {
    const checkbox = this.page.locator('#iAgree[type="checkbox"]:visible');
    const agreement = this.page.locator('a[href="/info/useragreement"]:visible');
    const agreementLabel = this.page.locator('label[for="iAgree"]:visible');
    const loginButton = this.page.locator('button.esiaLogin:visible,button.esia-login:visible')
      .filter({ hasText: /^\s*Войти\s*$/ });
    const visibleCheckboxes = this.page.locator('input[type="checkbox"]:visible');
    const labelText = await agreementLabel.count() === 1
      ? (await agreementLabel.first().innerText()).replace(/\s+/g, ' ').trim()
      : '';
    const standardAgreement = await agreement.count() === 1 &&
      /Пользовательское соглашение/i.test(await agreement.first().innerText()) &&
      labelText === 'Я ознакомился(ась) с «Пользовательским соглашением» и согласен(на) на обработку персональных данных.' &&
      await checkbox.count() === 1 && await loginButton.count() === 1 &&
      await visibleCheckboxes.count() === 1;
    return { checkbox, loginButton, standardAgreement };
  }

  async prepareSignIn(clientValue, requestTitle = null) {
    requireThat(!this.authorization, 'authorization_already_started');
    const client = exactClientDescriptor(clientValue);
    await this.ensureAuthorizationPage();
    // Recheck immediately before consent/helper creation; recognizing a 401
    // login document never grants authority to a later, changed consent form.
    const { checkbox, loginButton, standardAgreement } = await this.standardAuthorizationForm();
    requireThat(standardAgreement, 'court_consent_changed');

    // The operator explicitly allows the standard ГАС agreement as an ordinary
    // prerequisite of requested cabinet work. This background check must not
    // focus the window or become authority for a new/extra consent surface.
    if (!await checkbox.isChecked()) await checkbox.check();
    requireThat(await checkbox.isChecked(), 'court_standard_consent_failed');

    const imported = await import(pathToFileURL(client.modulePath).href);
    requireThat(typeof imported.createEsiaAuthorization === 'function', 'gosuslugi_client_invalid');
    const login = await imported.createEsiaAuthorization(this.page, {
      ...client.options,
      configHome: client.configHome,
      origin: 'https://ej.sudrf.ru',
      confirm: true,
      requestTitle,
    });
    const state = { login, result: null, error: null };
    this.authorization = state;
    login.authenticated.then(result => { state.result = result; }).catch(error => {
      state.error = safeAuthorizationError(error);
    });
    try {
      await loginButton.click();
      const request = await login.request;
      return { phase: 'authorization_required', ...request };
    } catch (error) {
      await login.close().catch(() => {});
      this.authorization = null;
      throw safeAuthorizationError(error);
    }
  }

  async resumeSignIn() {
    const state = this.authorization;
    requireThat(state, 'authorization_not_started');
    if (!state.error && !state.result) return { phase: 'authorization_pending' };
    try {
      if (state.error) throw state.error;
      requireThat(state.result.context === this.context && state.result.page === this.page,
        'authorization_context_changed');
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      requireThat(officialCourtUrl(this.page.url()), 'authorization_return_invalid');
      this.assertDocumentAvailable();
      return { phase: 'ready', origin: new URL(this.page.url()).origin };
    } finally {
      // Failure, a mismatched callback and a verified return all consume this
      // attempt. Closing only the helper preserves the caller's page/context;
      // the worker can then report a terminal phase instead of stale pending.
      await state.login.close().catch(() => {});
      this.authorization = null;
    }
  }

  async recoverSignInPage() {
    await this.permit();
    requireThat(!this.authorization, 'authorization_in_progress');
    requireThat(this.page && !this.page.isClosed() && this.page.context() === this.context,
      'authorization_context_changed');
    // A failed ESIA attempt may leave this very tab on an auth document. Only
    // a separate confirmed prepare-sign-in can return it to the fixed public
    // court entrypoint. Do not expose that DOM, reuse OAuth URLs, create a tab
    // or focus the window while recovering; the existing native lease stays.
    await this.clearControls();
    const response = await this.page.goto('https://ej.sudrf.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.assertAuthorizationDocumentAvailable(response);
    requireThat(new URL(this.page.url()).origin === 'https://ej.sudrf.ru', 'unexpected_provider_origin');
  }

  async storage() {
    await this.permit();
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        if (officialCourtUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
      }
    }
    const state = await collectOriginStorage(this.context, [...this.storageOrigins], this.permit);
    return validatedStorage({
      cookies: state.cookies.filter(cookie => {
        const domain = cookie.domain.replace(/^\./, '');
        return domain === 'sudrf.ru' || domain.endsWith('.sudrf.ru');
      }),
      origins: state.origins.filter(origin => officialCourtOrigin(origin.origin)),
    });
  }

  async playwrightContext() {
    await this.permit();
    requireThat(!this.authorization, 'authorization_in_progress');
    await this.actionSafe();
    await this.clearControls();
    return { context: this.context, page: this.page };
  }

  async actionSafe({ readOnlyRecoveryNavigation = false } = {}) {
    await this.permit();
    requireThat(!this.authorization, 'authorization_in_progress');
    // Popup-based provider flows may legitimately replace the original page.
    // Rebind only to a surviving official court page; creating or focusing a
    // replacement here would hide the actual state and could steal focus.
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find(page => !page.isClosed() && officialCourtUrl(page.url()));
    }
    requireThat(this.page && !this.page.isClosed() && workingPageUrl(this.page.url()), 'unexpected_provider_origin');
    // HTTP failure closes reads/actions on this document, not the browser's
    // ability to leave it. Only an explicit validated read-only navigation
    // may skip this preflight. Auth origin, active ESIA, native lease and
    // password/OTP guards remain mandatory; the destination is checked anew.
    if (!readOnlyRecoveryNavigation) this.assertDocumentAvailable();
    requireThat(await this.page.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count() === 0,
      'authentication_is_private');
  }

  async snapshot(redact = value => value) {
    await this.actionSafe();
    await this.clearControls();
    this.snapshotId += 1;
    const text = await this.page.locator('body').evaluate(body => {
      const copy = body.cloneNode(true);
      copy.querySelectorAll('script,style,input,textarea,select,[contenteditable],noscript').forEach(node => node.remove());
      return (copy.textContent || '').replace(/\s+/g, ' ').slice(0, 16000);
    });
    const elements = await this.page.locator(
      'button,a,input,textarea,select,[role="button"],[role="checkbox"],[role="radio"],[role="option"],[contenteditable="true"],[contenteditable="plaintext-only"]',
    ).elementHandles();
    const controls = [];
    for (const element of elements.slice(0, 400)) {
      if (!await element.isVisible()) { await element.dispose(); continue; }
      const meta = await element.evaluate(describeControl);
      if (protectedControl(meta)) { await element.dispose(); continue; }
      const ref = `${this.snapshotId}:${controls.length + 1}`;
      this.controls.set(ref, { element, meta, url: this.page.url() });
      controls.push({
        ref,
        tag: meta.tag,
        type: meta.type,
        role: meta.role,
        editable: meta.editable,
        label: redact(meta.label),
        authorizationRequired: needsAuthorization({ action: 'click' }, meta),
        ...(meta.options ? {
          options: meta.options.map(option => ({
            ...option,
            value: redact(option.value),
            label: redact(option.label),
          })),
        } : {}),
      });
    }
    this.observedUrl = this.page.url();
    return { origin: new URL(this.observedUrl).origin, text: redact(text), controls, truncated: true };
  }

  async action(packet) {
    validatedPagePacket(packet);
    const readOnlyRecoveryNavigation = packet.action === 'navigate' && readOnlyNavigation(packet.url);
    await this.actionSafe({ readOnlyRecoveryNavigation });
    if (packet.action === 'navigate') {
      // A fixed read-only URL needs no DOM control snapshot. Requiring one
      // after a 404 would deadlock recovery because snapshot is correctly
      // forbidden on the failed document. Writable routes keep both gates.
      requireThat(readOnlyRecoveryNavigation || this.observedUrl === this.page.url(), 'fresh_snapshot_required');
      const authorizationRequired = needsAuthorization(packet);
      if (packet.dryRun) return { dryRun: true, action: packet.action, authorizationRequired };
      requireThat(!authorizationRequired || packet.confirm === true, 'explicit_user_instruction_required');
      await this.clearControls();
      await this.permit();
      await this.page.goto(packet.url, { waitUntil: 'domcontentloaded' });
      await this.actionSafe();
      return { ok: true };
    }
    const target = this.controls.get(packet.ref);
    requireThat(target && target.url === this.page.url(), 'fresh_snapshot_required');
    requireThat(await target.element.evaluate(node => node.isConnected), 'fresh_snapshot_required');
    const meta = await target.element.evaluate(describeControl);
    requireThat(JSON.stringify(meta) === JSON.stringify(target.meta), 'fresh_snapshot_required');
    requireThat(!protectedControl(meta) && await target.element.isVisible() && await target.element.isEnabled(),
      'control_not_available');
    if (packet.action === 'fill') {
      requireThat((['input', 'textarea'].includes(meta.tag) || meta.editable) &&
        !/password|file|hidden|submit|button|checkbox|radio/.test(meta.type), 'input_not_allowed');
    }
    if (packet.action === 'select') {
      requireThat(meta.tag === 'select' && meta.options.some(option => option.value === packet.value && !option.disabled),
        'input_not_allowed');
    }
    if (packet.action === 'check') {
      requireThat(['checkbox', 'radio'].includes(meta.type) || ['checkbox', 'radio'].includes(meta.role),
        'input_not_allowed');
    }
    const authorizationRequired = needsAuthorization(packet, meta);
    if (packet.dryRun) {
      return { dryRun: true, action: packet.action, ref: packet.ref, authorizationRequired };
    }
    requireThat(!authorizationRequired || packet.confirm === true, 'explicit_user_instruction_required');
    await this.permit();
    const handles = [...this.controls.values()];
    this.controls.clear();
    this.observedUrl = null;
    try {
      if (packet.action === 'click') await target.element.click();
      else if (packet.action === 'fill') await target.element.fill(packet.text);
      else if (packet.action === 'select') await target.element.selectOption(packet.value);
      else if (packet.action === 'check') await target.element.setChecked(packet.checked);
      else if (packet.action === 'press') await target.element.press(packet.key);
      return { ok: true };
    } finally {
      for (const control of handles) await control.element.dispose().catch(() => {});
    }
  }

  async clearControls() {
    const handles = [...this.controls.values()];
    this.controls.clear();
    this.observedUrl = null;
    for (const control of handles) await control.element.dispose().catch(() => {});
  }

  async show() {
    await this.permit();
    requireThat(this.page && !this.page.isClosed(), 'session_not_ready');
    await this.clearControls();
    await this.page.bringToFront();
    return {
      ok: true,
      requiredAction: 'Выполните нестандартный ручной шаг в текущем окне ГАС, затем продолжите эту же сессию.',
    };
  }

  async close() {
    await this.authorization?.login.close().catch(() => {});
    this.authorization = null;
    await this.context?.close().catch(() => {});
  }
}
