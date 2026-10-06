import { backgroundBrowser, isOwnedPage } from './windows.mjs';
import { collectOriginStorage, restoreOriginStorage } from './storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { authOrigin, challengeKind, childEnvironment, officialUrl, providerRequestAllowed, qrPasswordChoice, requireThat, RuntimeError, totpCode } from './core.mjs';
import { runPrivate } from './native.mjs';
import { accountBlock, credentialsRejected } from './auth-safety.mjs';

export const PLAYWRIGHT_VERSION = '1.60.0';
export function dependenciesDirectory(root) { return path.join(root, 'runtimes', 'gosuslugi', `playwright-${PLAYWRIGHT_VERSION}`); }
export async function loadPlaywright(root) {
  const base = dependenciesDirectory(root), require = createRequire(path.join(base, 'entry.cjs'));
  try {
    requireThat(require('playwright-core/package.json').version === PLAYWRIGHT_VERSION, 'bootstrap_required');
    return require('playwright-core');
  } catch { throw new RuntimeError('bootstrap_required'); }
}
export async function bootstrapBrowser(root) {
  try { await loadPlaywright(root); return; } catch {}
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
    '--prefer-offline', '--fetch-retries=3', '--fetch-timeout=15000', '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=3000', '--save-exact', `playwright-core@${PLAYWRIGHT_VERSION}`], { timeout: 120000, limit: 262144 });
  await loadPlaywright(root);
}

export function validatedStorage(state) {
  if (!state) return { cookies: [], origins: [] };
  requireThat(Array.isArray(state.cookies) && Array.isArray(state.origins) && state.cookies.length <= 2000 && state.origins.length <= 100, 'storage_state_invalid');
  for (const cookie of state.cookies) {
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '') : '';
    requireThat(domain === 'gosuslugi.ru' || domain.endsWith('.gosuslugi.ru'), 'storage_state_origin_rejected');
  }
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
    await backgroundBrowser(browser);
    return { server, browser };
  } catch { await server.kill().catch(() => {}); throw new RuntimeError('browser_ownership_failed'); }
}

// Runs inside the owned page for both snapshot and dispatch. Options are a
// bounded extension of the existing click API, never arbitrary clickable divs.
// The legacy POS widget has no ARIA roles: its stable React Select structure
// must bind the option to exactly one open input on the official form origin.
function pageControl(node, expected = null) {
  const visible = element => Boolean(element?.isConnected && element.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[inert],[aria-hidden="true"]'));
  const enabled = element => !element.closest('[disabled],[aria-disabled="true"],.select__option--is-disabled,.select__control--is-disabled');
  const meta = { tag: node.tagName.toLowerCase(), type: node.getAttribute('type') || '',
    label: (node.getAttribute('aria-label') || node.labels?.[0]?.textContent ||
      (node.tagName === 'INPUT' ? '' : node.textContent) || '').trim().slice(0, 160) };
  if (!node.matches('[role="option"],.select__option[id^="react-select-"]')) return meta;
  if (!visible(node) || !enabled(node) || node.closest('a,button,input,textarea,select,[role="button"]')) return null;
  let owner, list, kind;
  if (node.getAttribute('role') === 'option') {
    list = node.closest('[role="listbox"]');
    if (!list?.id || !visible(list) || !enabled(list)) return null;
    const owners = [...document.querySelectorAll('[role="combobox"][aria-expanded="true"]')].filter(element =>
      visible(element) && enabled(element) &&
      `${element.getAttribute('aria-controls') || ''} ${element.getAttribute('aria-owns') || ''}`.split(/\s+/).includes(list.id));
    if (owners.length !== 1 || !owners[0].id) return null;
    owner = owners[0]; kind = 'aria';
  } else {
    if (location.origin !== 'https://pos.gosuslugi.ru' || !location.pathname.startsWith('/form/')) return null;
    const match = /^react-select-(\d+)-option-\d+(?:-\d+)*$/.exec(node.id);
    list = node.closest('.select__menu');
    const root = list?.parentElement;
    if (meta.tag !== 'div' || !match || !root?.matches('.basic-multi-select.form-control') ||
      !node.closest('.select__menu-list') || !visible(list) || !enabled(root)) return null;
    const owners = [...root.querySelectorAll('.select__control--menu-is-open input')].filter(element =>
      element.id === `react-select-${match[1]}-input` && visible(element) && enabled(element));
    if (owners.length !== 1) return null;
    owner = owners[0]; kind = 'pos-react-select';
  }
  if (expected === 'binding') return { owner, list };
  if (expected && (expected.owner !== owner || expected.list !== list)) return null;
  return { ...meta, role: 'option', binding: { kind, ownerId: owner.id, listId: list.id, optionId: node.id } };
}

export async function installPopupGuard(context) {
  await context.addInitScript(() => {
    // Chromium activates a popup before Playwright emits the new page event.
    // This context never adopts provider-created pages, so prevent their
    // creation in the page itself, including deferred window.open handlers.
    // A browser-level page listener remains a backup for other paths.
    let blocked = 0;
    const rejectPopup = () => { blocked++; return null; };
    // Keep assignment harmless for site bundles that wrap window.open. A
    // non-writable value would throw in strict-mode bundles during bootstrap.
    Object.defineProperty(window, 'open', { get: () => rejectPopup, set: () => {}, configurable: false });
    Object.defineProperty(window, '__trelioPopupGuard', { value: () => blocked, configurable: false });
    document.addEventListener('click', event => {
      const link = event.target instanceof Element ? event.target.closest('a[href],area[href]') : null;
      if (link?.target?.toLowerCase() === '_blank') { event.preventDefault(); blocked++; }
    }, true);
  });
}

export class Portal {
  constructor(browser, permit, { onPhase, askCode, persist, onAuthRefused = async () => {}, getCredentialGate = () => null }) {
    this.browser = browser; this.permit = permit; this.onPhase = onPhase; this.askCode = askCode; this.persist = persist;
    this.onAuthRefused = onAuthRefused; this.getCredentialGate = getCredentialGate; this.manualReason = null;
    this.controls = new Map(); this.snapshotId = 0; this.loginSent = false; this.passwordSent = false; this.codeSent = false;
    this.qrSent = false;
    this.loginEntryClicked = false;
    this.roleChoiceClicked = false;
    this.roleChoiceRequired = false;
    this.selectedRoleKind = null;
    this.storageOrigins = new Set();
  }
  async open(state) {
    await this.permit();
    // Never launchPersistentContext and never storageState({path}). Chrome's
    // empty launcher profile is not used for browsing or credential entry.
    const seed = validatedStorage(state);
    this.storageOrigins = new Set(seed.origins.map(item => item.origin));
    // Cookies do not require a temporary page. Restore origin storage only
    // after our inactive window exists, through the private background tab.
    this.context = await this.browser.newContext({ storageState: { cookies: seed.cookies, origins: [] }, viewport: null,
      acceptDownloads: false, serviceWorkers: 'block' });
    await installPopupGuard(this.context);
    await this.context.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame().page() !== this.page)
        return route.abort('blockedbyclient');
      // Evaluate the actual browser request: static CDN access must never widen
      // officialUrl/authOrigin, persisted state, navigation or credential input.
      const requestInfo = { url: request.url(), navigation: request.isNavigationRequest(),
        method: request.method(), resourceType: request.resourceType() };
      if (!providerRequestAllowed(requestInfo)) return route.abort('blockedbyclient');
      return route.continue();
    });
    this.context.on('page', page => { void isOwnedPage(page).then(owned => {
      if (!owned) return page.close().catch(() => {});
    }); });
    this.page = await this.context.newPage();
    this.page.on('framenavigated', frame => {
      if (officialUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
    });
    await restoreOriginStorage(this.context, seed, this.permit);
    this.page.setDefaultTimeout(10000);
    // The legacy /lk path currently resolves to the portal's rendered /404.
    // Begin at the public entrypoint and let its own sign-in control construct
    // the ESIA handoff instead of inventing an OAuth/redirect URL.
    await this.page.goto('https://www.gosuslugi.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  async enterLogin() {
    await this.permit();
    const url = new URL(this.page.url());
    // This is a one-shot public navigation, never a reusable generic click.
    // Limit it to the home/error shell, require one exact visible control and
    // recheck the origin before the click. Credentials still go only to ESIA.
    requireThat(officialUrl(url.href) && ['gosuslugi.ru', 'www.gosuslugi.ru'].includes(url.hostname) &&
      ['/', '/404', '/404/'].includes(url.pathname), 'login_entry_page_rejected');
    if (this.loginEntryClicked) return false;
    const control = this.page.getByRole('button', { name: 'Войти', exact: true })
      .or(this.page.getByRole('link', { name: 'Войти', exact: true })).filter({ visible: true });
    const count = await control.count();
    if (count === 0) return false;
    requireThat(count === 1, 'login_entry_ambiguous');
    const href = await control.getAttribute('href');
    requireThat(href === null || officialUrl(new URL(href, url).href), 'login_entry_url_rejected');
    requireThat(this.page.url() === url.href, 'login_entry_page_changed');
    // Mark before dispatch: a navigation timeout is ambiguous and must never
    // cause another click, even when authenticate is resumed by the user.
    this.loginEntryClicked = true;
    await control.click();
    return true;
  }
  async inspectAuth() {
    await this.permit();
    requireThat(officialUrl(this.page.url()), 'unexpected_provider_origin');
    const text = await this.page.locator('body').innerText({ timeout: 10000 });
    const login = this.page.locator('input#login:visible');
    let password = this.page.locator('input[type="password"]:visible, input#password:visible, input[autocomplete="current-password"]:visible');
    if (authOrigin(this.page.url()) && this.loginSent && !this.passwordSent && await login.count() === 0 && await password.count() === 0) {
      const onlyInput = this.page.locator('input:visible:not(#login):not([autocomplete="one-time-code"])');
      // ESIA also uses a text-type password component. Accept it only after
      // our login step, with a visible exact password label and one input.
      // Never infer a password from the only phone/OTP field on a fresh page.
      if (await onlyInput.count() === 1 && await this.page.getByText(/^(Введите пароль|Пароль)$/i).filter({ visible: true }).count() > 0)
        password = onlyInput;
    }
    const code = this.page.locator('input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible:not(#login), input[type="tel"]:visible:not(#login)').filter({ visible: true });
    // The login screen can advertise "вход по коду" while its only numeric
    // input is the phone number. That is not an actual second-factor request.
    const hasCode = await login.count() === 0 && await password.count() === 0 && await code.count() > 0;
    const qrButton = this.page.getByRole('button', { name: /^Логин и пароль$/i }).filter({ visible: true });
    const qrChoice = qrPasswordChoice(text, {
      choiceCount: await qrButton.count(),
      loginCount: await login.count(),
      passwordCount: await password.count(),
      codeCount: await code.count(),
      checkboxCount: await this.page.locator('input[type="checkbox"]:visible').count(),
    });
    return { text, login, password, code, qrChoice, challenge: challengeKind(text, hasCode) };
  }
  async typeSecret(locator, value, delay) {
    await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
    requireThat(await locator.count() === 1, 'auth_input_ambiguous');
    await locator.fill('');
    // ESIA observes individual keyboard events; filling the complete value
    // can leave its internal form model empty despite the visible password.
    await locator.pressSequentially(value, { delay });
  }
  async authSubmit(pattern) {
    await this.permit(); requireThat(authOrigin(this.page.url()), 'secret_origin_rejected');
    const button = this.page.getByRole('button', { name: pattern }).filter({ visible: true });
    requireThat(await button.count() === 1, 'auth_submit_ambiguous');
    // Exactly one submission. A timeout after click is ambiguous, not grounds
    // to click another matching button or press Enter as a blind retry.
    await button.click();
  }
  async roles() { return roleSnapshot(this); }
  async selectRole(ref) { return chooseRole(this, ref); }
  async authenticate(credentials, requestedRole = 'personal') {
    loginRole(requestedRole);
    this.manualReason = null;
    this.roleChoiceRequired = false;
    this.onPhase('authenticating'); let end = Date.now() + 90000;
    let publicReviewCandidate = null, publicReviewSince = 0;
    while (Date.now() < end) {
      const current = await this.inspectAuth();
      const blocked = accountBlock(current.text);
      if (blocked) {
        await this.onAuthRefused(blocked.reason, blocked.retryAfterHours);
        this.manualReason = blocked.reason;
        this.onPhase('user_required'); return false;
      }
      if (credentialsRejected(current.text)) {
        await this.onAuthRefused('credentials_rejected'); this.manualReason = 'credentials_rejected';
        this.onPhase('user_required'); return false;
      }
      if (!authOrigin(this.page.url())) {
        const url = new URL(this.page.url());
        const notFound = /^\/404\/?$/.test(url.pathname) || /ничего не нашлось|страница не найдена|страницу не найд|нет такой страницы/i.test(current.text);
        const login = this.page.getByRole('button', { name: 'Войти', exact: true })
          .or(this.page.getByRole('link', { name: 'Войти', exact: true })).filter({ visible: true });
        // A rendered public shell, its footer or a styled 404 never proves a
        // successful login. Prefer the portal's actual visible sign-in action.
        if (['gosuslugi.ru', 'www.gosuslugi.ru'].includes(url.hostname) && ['/', '/404', '/404/'].includes(url.pathname) && await login.count()) {
          const gate = this.getCredentialGate();
          if (gate) { this.manualReason = gate.reason; this.onPhase('user_required'); return false; }
          await this.enterLogin();
        } else if (!notFound && !await login.count() && !await current.password.count() &&
            !await current.login.count() && !await current.code.count() && await authenticatedPortalHeader(this.page)) {
          await this.persist(await this.storage()); this.onPhase('ready'); return true;
        } else if (!await current.password.count() && !await current.login.count() && !await current.code.count()) {
          // Seasonal campaigns and other intermediate public pages are valid
          // provider UI but their meaning cannot be encoded permanently in
          // the runtime. Once the same page is stable for a short bounded
          // interval, hand its redacted snapshot to the model instead of
          // waiting 90 seconds or claiming that a person must intervene.
          const candidate = `${url.origin}${url.pathname}`;
          if (candidate !== publicReviewCandidate) {
            publicReviewCandidate = candidate;
            publicReviewSince = Date.now();
          } else if (Date.now() - publicReviewSince >= 1500) {
            this.onPhase('review_required'); return false;
          }
        }
      } else {
        publicReviewCandidate = null;
        // Re-entering ESIA invalidates the role proof attached to old cookies.
        // Only a new observed role choice can bind the next saved state; an
        // expired session must not inherit a previous account's role marker.
        if (!this.roleChoiceClicked) this.selectedRoleKind = null;
        const gate = this.getCredentialGate();
        if (gate) { this.manualReason = gate.reason; this.onPhase('user_required'); return false; }
        if (current.qrChoice) {
          // A failed/slow navigation leaves the QR page in place. The button
          // is clicked once per login attempt; a second click after an
          // ambiguous result would be an unverified retry.
          if (!this.qrSent) {
            this.qrSent = true;
            await this.authSubmit(/^Логин и пароль$/i);
          }
          await this.page.waitForTimeout(500); continue;
        }
        if (current.challenge === 'manual') {
          this.roleChoiceRequired = roleChallenge(current.text,
            await current.login.count() + await current.password.count() + await current.code.count() > 0);
          if (requestedRole === 'personal' && await choosePersonalRole(this, current)) {
            this.roleChoiceRequired = false;
            await this.page.waitForTimeout(500); continue;
          }
          this.onPhase('user_required'); return false;
        }
        if (current.challenge === 'totp' || current.challenge === 'user_code') {
          if (this.codeSent) { await this.page.waitForTimeout(500); continue; }
          const count = await current.code.count();
          requireThat(count === 1 || count === 6, 'auth_input_ambiguous');
          let code;
          if (current.challenge === 'totp' && credentials.totp) {
            const left = 30000 - Date.now() % 30000;
            if (left < 8000) await this.page.waitForTimeout(left + 250);
            await this.permit(); code = totpCode(credentials.totp);
          } else {
            this.onPhase('code_required'); code = await this.askCode(); this.onPhase('authenticating');
            // This only resets the short provider-redirect wait. The independent
            // native 30-minute lease (including this human wait) never changes.
            end = Date.now() + 90000;
          }
          // Human input may take minutes: recheck origin AND challenge before
          // typing. Never send a code into a changed login/password page.
          const fresh = await this.inspectAuth();
          requireThat(authOrigin(this.page.url()) && fresh.challenge === current.challenge &&
            await fresh.code.count() === count, 'auth_challenge_changed');
          let providerSubmitted = false;
          const observeSubmission = request => {
            // Observe only that dispatch occurred, never headers/body/values.
            // An auto-submit may still be in flight while the OTP form remains
            // visible; its presence alone must not cause a second submission.
            if (officialUrl(request.url()) && (request.isNavigationRequest() || !['GET', 'HEAD'].includes(request.method()))) providerSubmitted = true;
          };
          this.context.on('request', observeSubmission);
          try {
            requireThat(typeof code === 'string' && /^\d{6}$/.test(code), 'auth_code_length_mismatch');
            if (count === 6) {
              // ESIA uses either native one-character inputs or its observed
              // controlled widget: six enabled tel/one-time-code inputs with
              // no maxlength/inputmode. Validate the complete layout before
              // consuming the guard; arbitrary fields never become an OTP form.
              const fields = await fresh.code.evaluateAll(elements => elements.map(input => ({
                maxLength: input.getAttribute('maxlength'), readOnly: input.readOnly,
                type: input.type, inputMode: input.inputMode, autocomplete: input.autocomplete, disabled: input.disabled,
              })));
              const nativeSegments = fields.every(input => input.maxLength === '1' && !input.readOnly);
              const controlledSegments = fields.every(input => input.maxLength === null && input.type === 'tel' &&
                input.inputMode === '' && input.autocomplete === 'one-time-code' && !input.disabled && !input.readOnly);
              requireThat(fields.length === 6 && (nativeSegments || controlledSegments),
                'auth_segmented_code_ambiguous');
            }
            this.codeSent = true;
            if (count === 1) await this.typeSecret(fresh.code, code, 60);
            else for (let index = 0; index < count; index++) await this.typeSecret(fresh.code.nth(index), code[index], 60);
            code = null;
            await this.page.waitForTimeout(1200);
            const after = await this.inspectAuth();
            if (!providerSubmitted && authOrigin(this.page.url()) && after.challenge === current.challenge) {
              const button = this.page.getByRole('button', { name: /^(Продолжить|Подтвердить|Войти)$/i }).filter({ visible: true });
              requireThat(await button.count() <= 1, 'auth_submit_ambiguous');
              if (await button.count() === 1 && await button.isEnabled()) await this.authSubmit(/^(Продолжить|Подтвердить|Войти)$/i);
            }
          } finally { code = null; this.context.off('request', observeSubmission); }
        } else if (!this.loginSent && await current.login.count() === 1) {
          this.loginSent = true; await this.typeSecret(current.login, credentials.login, 35);
          if (!await current.password.count()) await this.authSubmit(/^(Продолжить|Далее|Войти)$/i);
        } else if (!this.passwordSent && await current.password.count() === 1) {
          this.passwordSent = true; await this.typeSecret(current.password, credentials.password, 60);
          await this.authSubmit(/^Войти$/i);
        }
      }
      await this.page.waitForTimeout(500);
    }
    // A timeout only means that the bounded automatic recognizers did not
    // prove the next state. It is not evidence that a person must act. Keep
    // the owned browser in the background and let the agent inspect the
    // redacted public-page snapshot before deciding whether to act or ask.
    this.onPhase('review_required'); return false;
  }
  async storage() {
    await this.permit();
    for (const frame of this.page.frames())
      if (officialUrl(frame.url())) this.storageOrigins.add(new URL(frame.url()).origin);
    const state = await collectOriginStorage(this.context, [...this.storageOrigins], this.permit);
    return validatedStorage(state);
  }
  async actionSafe() {
    await this.permit();
    requireThat(officialUrl(this.page.url()) && !authOrigin(this.page.url()), 'authentication_is_private');
    requireThat(await this.page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count() === 0, 'authentication_is_private');
  }
  reviewContext() {
    // Expose only the origin classification needed for model routing. Paths,
    // queries, fragments and page text can contain OAuth state or private data
    // and therefore never enter status/error payloads.
    try {
      const url = new URL(this.page?.url());
      if (url.protocol !== 'https:' || url.username || url.password)
        return { pageKind: 'browser_internal', origin: null };
      if (authOrigin(url.href)) return { pageKind: 'official_auth', origin: url.origin };
      if (officialUrl(url.href)) return { pageKind: 'official_public', origin: url.origin };
      return { pageKind: 'external_https', origin: url.origin };
    } catch {
      return { pageKind: 'browser_internal', origin: null };
    }
  }
  async snapshot(redact) {
    await this.actionSafe();
    const pageUrl = this.page.url();
    const redactOutput = value => redact(value);
    for (const control of this.controls.values()) { await control.element.dispose(); await control.bindingHandle?.dispose(); }
    this.controls.clear(); this.snapshotId++;
    const text = await this.page.locator('body').evaluate(body => {
      const copy = body.cloneNode(true);
      copy.querySelectorAll('script,style,input,textarea,select,[contenteditable],noscript').forEach(node => node.remove());
      return (copy.textContent || '').replace(/\s+/g, ' ').slice(0, 16000);
    });
    const elements = await this.page.locator('button,a,input,textarea,select,[role="button"],[role="option"],.select__option[id^="react-select-"]').elementHandles();
    const controls = [];
    for (const element of elements.slice(0, 400)) {
      if (!await element.isVisible()) { await element.dispose(); continue; }
      const meta = await element.evaluate(pageControl);
      if (!meta) { await element.dispose(); continue; }
      if (/password|hidden|file/.test(meta.type) || /парол|одноразов|TOTP|SMS|смс/i.test(meta.label)) { await element.dispose(); continue; }
      const ref = `${this.snapshotId}:${controls.length + 1}`;
      // Binding details remain in process memory; only the option role and
      // redacted display label are useful to the agent choosing a field value.
      const { binding, ...publicMeta } = meta;
      // Retain actual owner/list identity as well as metadata, so reparenting an
      // existing option into a replacement widget with identical IDs is stale.
      const bindingHandle = binding ? await element.evaluateHandle(pageControl, 'binding') : null;
      this.controls.set(ref, { element, meta, bindingHandle, url: this.page.url() }); controls.push({ ref, ...publicMeta, label: redactOutput(meta.label) });
    }
    await this.actionSafe(); requireThat(this.page.url() === pageUrl, 'fresh_snapshot_required');
    return { origin: new URL(pageUrl).origin, text: redactOutput(text), controls, truncated: true };
  }
  async action(packet) {
    await this.actionSafe();
    if (packet.action === 'navigate') {
      requireThat(officialUrl(packet.url) && !authOrigin(packet.url), 'provider_url_rejected');
      await this.page.goto(packet.url, { waitUntil: 'domcontentloaded' }); this.controls.clear(); return;
    }
    const target = this.controls.get(packet.ref);
    requireThat(target && target.url === this.page.url(), 'fresh_snapshot_required');
    requireThat(await target.element.evaluate(node => node.isConnected), 'fresh_snapshot_required');
    const fresh = await target.element.evaluate(pageControl, target.bindingHandle);
    requireThat(fresh && JSON.stringify(fresh) === JSON.stringify(target.meta), 'fresh_snapshot_required');
    if (fresh.role === 'option') requireThat(await target.element.isVisible() && await target.element.isEnabled(), 'fresh_snapshot_required');
    const label = fresh.label;
    if (packet.action === 'click') {
      requireThat(!/отправ|подпис|оплат|подат|заказ|удал|подтверд|соглас|войти|парол|восстанов/i.test(label) &&
        !['submit', 'image'].includes(target.meta.type), 'manual_confirmation_required');
      // target=_blank opens a native tab before Playwright can observe it.
      // The existing ownership policy rejects that tab, so reject the click
      // itself while the owned browser is still in the background.
      requireThat(!await target.element.evaluate(node => {
        const link = node.closest('a[href],area[href]');
        return link?.target?.toLowerCase() === '_blank';
      }), 'popup_requires_manual');
      // Consume references before dispatch, including ambiguous click failures.
      // No keyboard fallback may turn choosing a region into form submission.
      this.controls.clear(); await this.permit();
      const before = await this.page.evaluate(() => window.__trelioPopupGuard?.());
      requireThat(Number.isInteger(before), 'browser_background_required');
      let clickError = null;
      try { await target.element.click(); } catch (error) { clickError = error; }
      const after = await this.page.evaluate(() => window.__trelioPopupGuard?.()).catch(() => before);
      if (after > before) throw new RuntimeError('popup_requires_manual');
      if (clickError) throw clickError;
    } else if (packet.action === 'fill') {
      requireThat(['input', 'textarea'].includes(target.meta.tag) && !/password|file|hidden|submit|button/.test(target.meta.type) &&
        typeof packet.text === 'string' && packet.text.length <= 10000, 'input_not_allowed');
      this.controls.clear(); await this.permit();
      await target.element.fill(packet.text);
    } else throw new RuntimeError('unknown_page_action');
    this.controls.clear();
  }
  async close() { await this.context?.close(); }
}

export function loginRole(value = 'personal') {
  requireThat(['personal', 'manual'].includes(value), 'login_role_invalid');
  return value;
}

export function reusableRoleStorage(record, requestedRole = 'personal') {
  return loginRole(requestedRole) === 'personal' && record?.storageRole === 'personal' && record.storage
    ? record.storage : null;
}

export async function authenticatedPortalHeader(page) {
  // The current public portal component lib-header-auth renders this exact
  // button only in its user.authorized branch (the alternate branch renders
  // .login-button). The accessible name is static; no account name/avatar or
  // app state is read. Footer words about documents never prove login.
  const menu = page.locator('lib-header-auth button.authorized-user[aria-label="Меню пользователя"]').filter({ visible: true });
  if (await menu.count() === 1 && await menu.isEnabled()) return true;
  // Other official account pages may expose a direct logout control. Match
  // its complete accessible name, not a phrase in generic page text.
  const logout = page.getByRole('button', { name: 'Выйти', exact: true })
    .or(page.getByRole('link', { name: 'Выйти', exact: true })).filter({ visible: true });
  return await logout.count() === 1 && await logout.isEnabled();
}

export function roleChallenge(text, hasAuthFields) {
  // The default only covers a role chooser. Authentication, recovery and
  // legally meaningful confirmations never become role-selection controls.
  return !hasAuthFields && /выбор.*роли|войти как|выберите организацию|выбор организации/i.test(text) &&
    !/captcha|капч|робот|восстановлен|смен[аи] пароля|заблокирован|push|подтвердите.*(телефон|приложени)|биометри|смс|sms|одноразов|оплат|плат[её]ж|подпис[аы]/i.test(text);
}

async function requireChooser(portal) {
  await portal.permit();
  const current = await portal.inspectAuth();
  requireThat(authOrigin(portal.page.url()) && roleChallenge(current.text,
    await current.login.count() + await current.password.count() + await current.code.count() > 0), 'role_chooser_required');
  return portal.page.url();
}

export async function choosePersonalRole(portal, current) {
  if (portal.roleChoiceClicked) return false;
  const url = portal.page.url();
  if (!authOrigin(url) || !roleChallenge(current.text,
    await current.login.count() + await current.password.count() + await current.code.count() > 0)) return false;
  // ESIA can combine the fixed personal-role label with a sign-in action and
  // the account name in one element. Accept only one bounded visible match;
  // never choose by a person's name, position or organisation title.
  const target = portal.page.getByText(/(?:Физическое|Частное)\s+лицо/i).filter({ visible: true });
  if (await target.count() !== 1 || !await target.isEnabled()) return false;
  const meta = await target.evaluate(node => ({ tag: node.tagName.toLowerCase(), length: (node.textContent || '').trim().length }));
  if (['html', 'body', 'main', 'section', 'h1', 'h2', 'h3'].includes(meta.tag) || meta.length > 240) return false;
  const href = await target.getAttribute('href');
  if (href !== null && !officialUrl(new URL(href, url).href)) return false;
  if (await requireChooser(portal) !== url || await target.count() !== 1 || !await target.isEnabled()) return false;
  await portal.permit();
  if (portal.page.url() !== url) return false;
  // Consume before dispatch: resume cannot repeat an ambiguous identity click.
  portal.roleChoiceClicked = true;
  await target.click();
  portal.selectedRoleKind = 'personal';
  return true;
}

export async function roleSnapshot(portal) {
  const url = await requireChooser(portal);
  for (const entry of portal.roleControls?.values() || []) await entry.element.dispose();
  portal.roleControls = new Map();
  portal.roleSnapshotId = (portal.roleSnapshotId || 0) + 1;
  // Dedicated role output is deliberately smaller than a page snapshot: only
  // visible choices, no body text, form inputs, URLs or authentication state.
  // The exact static labels cover provider cards without button semantics.
  const candidates = portal.page.locator('button,a,[role="button"]')
    .or(portal.page.getByText(/^(Физическое лицо|Частное лицо|Юридическое лицо|Индивидуальный предприниматель)$/i, { exact: true }))
    .filter({ visible: true });
  const elements = await candidates.elementHandles();
  requireThat(elements.length <= 40, 'role_choices_ambiguous');
  const choices = [];
  for (const element of elements) {
    const label = (await element.innerText()).replace(/\s+/g, ' ').trim();
    const href = await element.getAttribute('href');
    // Navigation/help/login alternatives are not identities. A changed or
    // unknown chooser yields no usable refs rather than generic page access.
    if (!label || label.length > 240 || /^(Назад|Отмена|Выйти|Войти|Помощь|Поддержка|Регистрация|Логин и пароль)$/i.test(label) ||
      /принять|соглас|разреш|подтверд|далее|получить|создать|добавить|изменить|удалить|отправить|подпис|оплат|accept|consent|confirm|submit|pay|delete/i.test(label) ||
      !await element.isEnabled() || (href !== null && !officialUrl(new URL(href, url).href))) {
      await element.dispose(); continue;
    }
    const ref = `role:${portal.roleSnapshotId}:${choices.length + 1}`;
    portal.roleControls.set(ref, { element, label, url, href });
    choices.push({ ref, label });
  }
  requireThat(portal.page.url() === url, 'role_chooser_changed');
  return { choices, defaultRole: 'personal' };
}

export async function chooseRole(portal, ref) {
  const entry = portal.roleControls?.get(ref);
  requireThat(entry, 'fresh_role_reference_required');
  requireThat(await requireChooser(portal) === entry.url && await entry.element.isVisible() && await entry.element.isEnabled() &&
    (await entry.element.innerText()).replace(/\s+/g, ' ').trim() === entry.label &&
    await entry.element.getAttribute('href') === entry.href, 'role_chooser_changed');
  // References are one-use and bound to the current chooser. A following
  // organisation list requires a new roles call; an uncertain click is never
  // repeated using this snapshot. This permission does not authorise forms.
  const attempt = JSON.stringify([entry.url, entry.label]);
  portal.roleAttempts ||= new Set();
  requireThat(!portal.roleAttempts.has(attempt), 'role_choice_already_attempted');
  await portal.permit();
  requireThat(portal.page.url() === entry.url, 'role_chooser_changed');
  portal.roleAttempts.add(attempt);
  const consumed = [...portal.roleControls.values()]; portal.roleControls.clear();
  portal.roleChoiceClicked = true;
  try { await entry.element.click(); }
  finally { await Promise.all(consumed.map(value => value.element.dispose().catch(() => {}))); }
  portal.selectedRoleKind = /(?:Физическое|Частное)\s+лицо/i.test(entry.label) ? 'personal' : 'other';
  portal.roleChoiceRequired = false;
}
