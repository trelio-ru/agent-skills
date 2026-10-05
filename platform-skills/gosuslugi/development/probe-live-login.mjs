import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Portal } from '../scripts/browser.mjs';
import { authOrigin, officialUrl, requireThat, privateStat } from '../scripts/core.mjs';
import { authEvidence } from './live-login-observations.mjs';

const file = process.env.TRELIO_GOSUSLUGI_DIAGNOSTIC_RESULT;
requireThat(file && path.isAbsolute(file), 'diagnostic_output_required');
await privateStat(file);
const observations = []; let lastSurface = '', writing = Promise.resolve();
async function record(value) {
  // This is an owner-only, bounded file of fixed metadata. There are no auth
  // labels, field values, page text, cookies, query strings or raw exceptions.
  if (observations.length >= 80) return;
  observations.push({ at: new Date().toISOString(), ...value });
  const output = JSON.stringify(observations);
  requireThat(Buffer.byteLength(output) <= 65536, 'diagnostic_output_limit');
  writing = writing.then(() => fs.writeFile(file, output, { mode: 0o600 }));
  await writing;
}

let currentMethods = Portal.prototype;
Portal.prototype.authenticate = async function (credentials, requestedRole = 'personal') {
  // A maintainer resume loads only this fixed, reviewed repository source.
  // The same Portal, context, native deadline and one-shot submission flags
  // survive. Nothing accepts a caller-selected script or resets sent secrets.
  const sourceUrl = new URL('../scripts/browser.mjs', import.meta.url);
  const sourceHash = crypto.createHash('sha256').update(await fs.readFile(sourceUrl)).digest('hex');
  const candidate = await import(`${sourceUrl.href}?liveSource=${sourceHash}`);
  currentMethods = candidate.Portal.prototype;
  await record({ event: 'source', browserSourceSha256: sourceHash });
  await record({ event: 'stored_configuration', totpConfigured: Boolean(credentials.totp) });
  const originalPhase = this.onPhase;
  this.onPhase = phase => { originalPhase(phase); void record({ event: 'phase', phase }); };
  try { return await currentMethods.authenticate.call(this, credentials, requestedRole); }
  finally { this.onPhase = originalPhase; }
};

Portal.prototype.inspectAuth = async function () {
  const result = await currentMethods.inspectAuth.call(this);
  const url = new URL(this.page.url());
  const surface = { event: 'surface', page: authOrigin(url.href) ? 'esia' :
    officialUrl(url.href) ? (/^\/404\/?$/.test(url.pathname) ? 'portal_not_found' : 'portal') : 'other',
    portalHost: url.hostname === 'lk.gosuslugi.ru' ? 'account' :
      ['gosuslugi.ru', 'www.gosuslugi.ru'].includes(url.hostname) ? 'main' : 'other',
    portalPath: /^\/(lk|profile|settings)(\/|$)/.test(url.pathname) ? 'account' : url.pathname === '/' ? 'home' : 'other',
    portalControls: Object.fromEntries(await Promise.all([
      ['login', /^Войти$/i], ['logout', /^Выйти$/i], ['userMenu', /^Меню пользователя$/i], ['profile', /^(Профиль|Личный кабинет)$/i],
      ['documents', /^(Документы|Мои документы|Личные документы|Данные и документы)$/i],
      ['requests', /^(Заявления|Мои заявления)$/i],
    ].map(async ([name, pattern]) => [name, Math.min(3, await this.page.getByRole('button', { name: pattern })
      .or(this.page.getByRole('link', { name: pattern })).filter({ visible: true }).count())]))),
    fields: { login: Math.min(2, await result.login.count()), password: Math.min(2, await result.password.count()),
      code: Math.min(7, await result.code.count()) },
    codeFields: authOrigin(url.href) ? await result.code.evaluateAll(elements => elements.slice(0, 6).map(input => ({
      type: ['text', 'tel', 'password', 'number'].includes(input.type) ? input.type : 'other',
      inputMode: ['numeric', 'decimal', 'tel', 'text'].includes(input.inputMode) ? input.inputMode : 'other',
      oneTimeCode: input.autocomplete === 'one-time-code',
      maxLength: input.getAttribute('maxlength') === '1' ? 1 : input.getAttribute('maxlength') === null ? null : 'other',
      readOnly: input.readOnly, disabled: input.disabled,
    }))) : [],
    passwordChoice: Math.min(2, await this.page.getByRole('button', { name: 'Логин и пароль', exact: true }).filter({ visible: true }).count()),
    challenge: result.challenge, evidence: authEvidence(result.text),
    browserContexts: this.browser.contexts().length, portalPages: this.context.pages().length,
    loginEntryClicked: Boolean(this.loginEntryClicked), loginSubmitted: this.loginSent,
    passwordSubmitted: this.passwordSent, codeSubmitted: this.codeSent,
    roleChoiceClicked: Boolean(this.roleChoiceClicked), selectedPersonalRole: this.selectedRoleKind === 'personal' };
  const fingerprint = JSON.stringify(surface);
  if (fingerprint !== lastSurface) { lastSurface = fingerprint; await record(surface); }
  return result;
};

// Delegate internal calls to the same source generation as authenticate;
// never serialize arguments (some are credentials) or replace the Portal.
for (const method of ['enterLogin', 'typeSecret', 'authSubmit']) {
  Portal.prototype[method] = function (...args) { return currentMethods[method].apply(this, args); };
}

// The normal worker exclusively owns unlock, key/vault access, browser,
// credential submission, session persistence and native-supervised cleanup.
await import('../scripts/worker.mjs');
