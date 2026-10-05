import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Portal } from '../scripts/browser.mjs';
import { authOrigin, bankPageUrl, requireThat, privateStat } from '../scripts/core.mjs';
import { safeAuthLabels, authEvidence } from './live-login-observations.mjs';

const file = process.env.TRELIO_TBANK_DIAGNOSTIC_RESULT;
requireThat(file && path.isAbsolute(file), 'diagnostic_output_required');
await privateStat(file);
const observations = []; let lastSurface = '', secrets = [], writing = Promise.resolve();
async function record(value) {
  // The file is pre-created owner-only by the launcher. Hard caps prevent a
  // long wait or changing DOM from turning this into a general browser log.
  if (observations.length >= 80) return;
  observations.push({ at: new Date().toISOString(), ...value });
  const output = JSON.stringify(observations);
  requireThat(Buffer.byteLength(output) <= 65536, 'diagnostic_output_limit');
  writing = writing.then(() => fs.writeFile(file, output, { mode: 0o600 }));
  await writing;
}

let currentMethods = Portal.prototype;
Portal.prototype.authenticate = async function (credentials) {
  // An explicit maintainer resume can load a reviewed source fix without
  // opening another browser or bypassing OS unlock. Existing per-session
  // submission guards remain on this same Portal instance; no state is reset.
  // Only this fixed repository file is loadable, never a caller-supplied URL.
  const sourceUrl = new URL('../scripts/browser.mjs', import.meta.url);
  const sourceHash = crypto.createHash('sha256').update(await fs.readFile(sourceUrl)).digest('hex');
  const candidate = await import(`${sourceUrl.href}?liveSource=${sourceHash}`);
  currentMethods = candidate.Portal.prototype;
  await record({ event: 'source', browserSourceSha256: sourceHash });
  secrets = [credentials.login, credentials.username, credentials.password, credentials.totp];
  await record({ event: 'stored_configuration', totpConfigured: Boolean(credentials.totp),
    usernameConfigured: Boolean(credentials.username) });
  const originalPhase = this.onPhase;
  this.onPhase = phase => { originalPhase(phase); void record({ event: 'phase', phase }); };
  try { return await currentMethods.authenticate.call(this, credentials); }
  finally { this.onPhase = originalPhase; secrets = []; }
};

Portal.prototype.inspectAuth = async function () {
  const result = await currentMethods.inspectAuth.call(this);
  const isAuth = authOrigin(this.page.url());
  const labels = isAuth ? await this.page.locator('h1:visible,h2:visible,h3:visible,[role="heading"]:visible,label:visible')
    .allTextContents() : [];
  const counts = { phone: await this.page.locator('input[autocomplete="tel"]:visible,input[name="phone"]:visible,input[name="phoneNumber"]:visible').count(),
    password: await result.password.count(), username: await result.username.count(), code: await result.code.count() };
  const codeFields = isAuth ? await result.code.evaluateAll(elements => elements.slice(0, 6).map(input => ({
    type: ['text', 'tel', 'password', 'number'].includes(input.type) ? input.type : 'other',
    inputMode: ['numeric', 'decimal', 'tel', 'text'].includes(input.inputMode) ? input.inputMode : 'other',
    oneTimeCode: input.autocomplete === 'one-time-code',
    maxLength: Number.isInteger(input.maxLength) && input.maxLength >= -1 && input.maxLength <= 64 ? input.maxLength : null,
    readOnly: input.readOnly, disabled: input.disabled,
  }))) : [];
  const surface = { event: 'surface', page: isAuth ? 'bank_auth' : bankPageUrl(this.page.url()) ? 'bank_account' : 'other',
    origin: new URL(this.page.url()).origin, labels: safeAuthLabels(labels, secrets), counts,
    challenge: result.challenge, evidence: authEvidence(result.text), codeFields,
    browserContexts: this.browser.contexts().length, bankPages: this.context.pages().length,
    loginSubmitted: this.loginSent, passwordSubmitted: this.passwordSent, totpSubmitted: this.codesSent.has('totp') };
  const fingerprint = JSON.stringify(surface);
  if (fingerprint !== lastSurface) { lastSurface = fingerprint; await record(surface); }
  return result;
};

// Calls inside the reloaded authenticate method must use the same reviewed
// source generation as its decision logic. These delegates preserve the
// existing Portal instance and never serialize their secret arguments.
for (const method of ['typeSecret', 'authSubmit', 'waitForLoginCode']) {
  Portal.prototype[method] = function (...args) { return currentMethods[method].apply(this, args); };
}

// Production owns the native permit pipe, key unlock, vault decryption, one
// headed browser, exact-origin secret delivery, single-submit guards and stop.
// These hooks do not receive controls or change any authentication decision.
await import('../scripts/worker.mjs');
