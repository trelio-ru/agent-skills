import { authOrigin, officialUrl, challengeKind, qrPasswordChoice, totpCode, requireThat, RuntimeError } from './core.mjs';
import { roleChallenge } from './browser.mjs';
import { requestLocal } from './transport.mjs';
import { accountBlock, credentialsRejected } from './auth-safety.mjs';

const css = (value) => ({ css: value, visible: true });
const name = (pattern) => ({ role: 'button', name: { pattern, flags: 'i' }, visible: true });
const login = css('input#login'),
  password = css('input[type="password"],input#password,input[autocomplete="current-password"]');
const code = css(
  'input[autocomplete="one-time-code"]:not(#login),input[inputmode="numeric"]:not(#login),input[type="tel"]:not(#login)',
);
const personal = { text: { pattern: '(?:Физическое|Частное)\\s+лицо', flags: 'i' }, visible: true };
const submit = name('^(Продолжить|Подтвердить|Войти)$');

// Only ESIA UI knowledge belongs here. The authorizer neither opens a relying
// party nor inspects its DOM, form, readiness or persisted session. The neutral
// browser transports private inputs in memory and returns control at callback.
export class EsiaAuthorizer {
  constructor(config, { permit, onPhase, onAuthRefused = async () => {}, getCredentialGate = () => null }) {
    this.config = config;
    this.permit = permit;
    this.onPhase = onPhase;
    this.onAuthRefused = onAuthRefused;
    this.getCredentialGate = getCredentialGate;
    this.loginSent = false;
    this.passwordSent = false;
    this.codeSent = false;
    this.roleSent = false;
    this.roleChoiceRequired = false;
    this.completed = false;
    this.qrSent = false;
    this.manualReason = null;
    this.manualPostCount = null;
  }
  async call(command, extra = {}) {
    await this.permit();
    return requestLocal(this.config.authorization, {
      command,
      sessionId: this.config.authorization.sessionId,
      requestId: this.config.authorization.requestId,
      authorizationLease: this.config.leaseId,
      ...extra,
    });
  }
  async claim() {
    const result = await this.call('claim', {
      confirmed: true,
      origin: this.config.authorization.origin,
      company: this.config.identity.company,
      member: this.config.identity.member,
      guardPid: this.config.guardPid,
      nativeControl: this.config.authorizerControl,
    });
    if (result.returned === true) {
      this.completed = true;
      await this.onPhase('authorized');
    }
    return result;
  }
  watchPeer({ isBusy, onReturned, onProgress, onLost }) {
    // During a human challenge or OS prompt, no authenticate loop is running.
    // Keep the local peer's lifetime coupled without polling a remote site or
    // retrying any credential operation. The native deadline remains primary.
    let checking = false;
    this.peerTimer = setInterval(async () => {
      if (checking || this.completed || isBusy()) return;
      checking = true;
      try {
        const state = await this.call('auth-state');
        if (state.failed) throw new RuntimeError(state.failed, state);
        if (!isBusy() && state.returned) await onReturned();
        else if (!isBusy() && this.manualPostCount !== null && state.atAuth &&
          state.postCount > this.manualPostCount && !this.getCredentialGate()) {
          // A manual challenge can submit inside the same ESIA page without
          // completing the relying-party callback yet. Resume the existing
          // authorizer once for that observed POST; no login click is repeated.
          this.manualPostCount = null;
          await onProgress?.();
        }
      } catch (error) {
        if (error.code !== 'session_busy' && !this.completed && !isBusy()) await onLost(error);
      } finally { checking = false; }
    }, 2000);
    this.peerTimer.unref();
  }
  async observe() {
    return this.call('auth-operation', {
      operation: 'observe',
      queries: {
        login,
        password,
        code,
        personal,
        submit,
        checkboxes: css('input[type="checkbox"]'),
        onlyinput: css('input:not(#login):not([autocomplete="one-time-code"])'),
        passwordlabel: { text: { pattern: '^(Введите пароль|Пароль)$', flags: 'i' }, visible: true },
        qrpassword: name('^Логин и пароль$'),
      },
    });
  }
  async type(query, text) {
    return this.call('auth-operation', { operation: 'type', query, text });
  }
  async click(query, expectedLabel) {
    return this.call('auth-operation', {
      operation: 'click',
      query,
      ...(expectedLabel ? { expectedLabel } : {}),
    });
  }
  async manual(reason, postCount = null) {
    requireThat(['credentials_rejected', 'consent_required', 'role_choice_required',
      'challenge_required', 'code_required', 'auth_timeout', 'account_temporarily_blocked'].includes(reason), 'auth_manual_reason_invalid');
    const changed = this.manualReason !== reason;
    this.manualReason = reason;
    this.manualPostCount = Number.isInteger(postCount) ? postCount : null;
    await this.onPhase('user_required');
    if (changed) await this.call('show');
    return false;
  }
  async finish() {
    await this.call('complete');
    this.completed = true;
    await this.onPhase('authorized');
    return true;
  }
  async authenticate(credentials, requestedRole = 'personal') {
    await this.onPhase('authenticating');
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const state = await this.call('auth-state');
      if (state.failed) throw new RuntimeError(state.failed, state);
      if (state.returned) return this.finish();
      if (state.personalRolePending) {
        this.roleChoiceRequired = true;
        if (requestedRole !== 'personal') return this.manual('role_choice_required', state.postCount);
        if (!this.roleSent) {
          // The verified callback has already revoked all credential access.
          // This separate broker action can only select the one personal card
          // on the official identity chooser and cannot type or accept consent.
          this.roleSent = true;
          const choice = await this.call('choose-personal-role');
          if (!choice.selected) return this.manual('role_choice_required', state.postCount);
          this.roleChoiceRequired = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!state.atAuth) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      try {
        let current;
        try {
          current = await this.observe();
        } catch (error) {
          if (error.code === 'auth_page_changed' || error.code === 'secret_origin_rejected') continue;
          if (error.code === 'service_authorization_request_required') {
            // Navigation may begin between auth-state and the read-only observe.
            // Retry only that observation after proving a bound callback is now
            // pending; never repeat a credential operation or suppress an actual
            // rejected/missing transaction. The native deadline still applies.
            const latest = await this.call('auth-state');
            if (latest.returning && !latest.failed) continue;
          }
          throw error;
        }
        const q = current.queries;
        const blocked = accountBlock(current.text);
        if (blocked) {
          await this.onAuthRefused(blocked.reason, blocked.retryAfterHours);
          return this.manual(blocked.reason, state.postCount);
        }
        if (credentialsRejected(current.text)) {
          await this.onAuthRefused('credentials_rejected');
          return this.manual('credentials_rejected', state.postCount);
        }
        // A new request/process does not reset a previous provider refusal.
        // Only a verified return, explicit credential replacement or an
        // observed block's expiry can release the encrypted credential gate.
        const gate = this.getCredentialGate();
        if (gate) return this.manual(gate.reason, state.postCount);
        const hasPassword =
          q.password.count > 0 ||
          (this.loginSent &&
            !this.passwordSent &&
            q.login.count === 0 &&
            q.password.count === 0 &&
            q.onlyinput.count === 1 &&
            q.passwordlabel.count > 0);
        const passwordQuery = q.password.count
          ? password
          : css('input:not(#login):not([autocomplete="one-time-code"])');
        const hasCode = !q.login.count && !hasPassword && q.code.count > 0;
        const consent =
          (q.checkboxes.fields || []).some(
            (field) =>
              !field.checked &&
              /согласи|согласен|персональн.{0,30}данн|пользовательск.{0,30}соглашени/i.test(field.label),
          ) ||
          (!q.login.count &&
            !hasPassword &&
            !q.code.count &&
            /предостав.{0,120}(доступ|сведен|данн)|разреш.{0,80}(доступ|сведен|данн)|соглас.{0,80}(передач|обработ)/i.test(
              current.text,
            ));
        if (consent) return this.manual('consent_required', state.postCount);
        // A page-wide text classifier cannot tell a QR instruction from an
        // alternative method advertised below the fold. Bind the transition
        // to the one visible password-choice button before classifying a
        // genuine second-factor or account challenge. Never replay its click
        // after an ambiguous navigation result.
        const qrChoice = qrPasswordChoice(current.text, {
          choiceCount: q.qrpassword?.count ?? 0,
          loginCount: q.login.count,
          passwordCount: q.password.count,
          codeCount: q.code.count,
          checkboxCount: q.checkboxes?.count ?? 0,
        });
        if (qrChoice) {
          if (!this.qrSent) {
            this.qrSent = true;
            await this.click(name('^Логин и пароль$'));
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const challenge = challengeKind(current.text, hasCode);
        if (challenge === 'manual') {
          this.roleChoiceRequired = roleChallenge(current.text, q.login.count > 0 || hasPassword || hasCode);
          const item = q.personal.fields?.[0];
          if (
            requestedRole === 'personal' &&
            this.roleChoiceRequired &&
            !this.roleSent &&
            q.personal.count === 1 &&
            item &&
            !item.disabled &&
            !['html', 'body', 'main', 'section', 'h1', 'h2', 'h3'].includes(item.tag) &&
            item.length <= 240 &&
            (!item.href || officialUrl(item.href))
          ) {
            this.roleSent = true;
            await this.click(personal, item.label);
            this.roleChoiceRequired = false;
          } else return this.manual(this.roleChoiceRequired ? 'role_choice_required' : 'challenge_required', state.postCount);
        } else if (challenge === 'totp' || challenge === 'user_code') {
          if (this.codeSent) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          // An SMS/push or missing TOTP seed stays on the original ESIA page for the
          // human. It is never requested in the agent conversation or a new browser.
          if (challenge !== 'totp' || !credentials.totp) return this.manual('code_required', state.postCount);
          requireThat(q.code.count === 1 || q.code.count === 6, 'auth_input_ambiguous');
          const left = 30000 - (Date.now() % 30000);
          if (left < 8000) await new Promise((resolve) => setTimeout(resolve, left + 250));
          const fresh = await this.observe();
          requireThat(
            challengeKind(
              fresh.text,
              !fresh.queries.login.count && !fresh.queries.password.count && fresh.queries.code.count > 0,
            ) === 'totp' && fresh.queries.code.count === q.code.count,
            'auth_challenge_changed',
          );
          if (q.code.count === 6) {
            const fields = fresh.queries.code.fields;
            const native = fields?.every((field) => field.maxLength === '1' && !field.readOnly);
            const controlled = fields?.every(
              (field) =>
                field.maxLength === null &&
                field.type === 'tel' &&
                field.inputMode === '' &&
                field.autocomplete === 'one-time-code' &&
                !field.disabled &&
                !field.readOnly,
            );
            requireThat(fields?.length === 6 && (native || controlled), 'auth_segmented_code_ambiguous');
          }
          this.codeSent = true;
          let value = totpCode(credentials.totp);
          try {
            await this.call('protect-input', { text: value });
            if (q.code.count === 1) await this.type(code, value);
            else for (let index = 0; index < 6; index++) await this.type({ ...code, nth: index }, value[index]);
          } finally {
            value = null;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const after = await this.call('auth-state');
          if (after.returned) return this.finish();
          if (after.atAuth && after.postCount === state.postCount) {
            const observed = await this.observe();
            if (
              observed.queries.submit.count === 1 &&
              challengeKind(
                observed.text,
                !observed.queries.login.count &&
                  !observed.queries.password.count &&
                  observed.queries.code.count > 0,
              ) === 'totp'
            )
              await this.click(submit);
          }
        } else if (!this.loginSent && q.login.count === 1) {
          this.loginSent = true;
          await this.type(login, credentials.login);
          if (!hasPassword) {
            const buttons = name('^(Продолжить|Далее|Войти)$');
            const found = await this.call('auth-operation', {
              operation: 'observe',
              queries: { submit: buttons },
            });
            requireThat(found.queries.submit.count === 1, 'auth_submit_ambiguous');
            await this.click(buttons);
          }
        } else if (!this.passwordSent && hasPassword) {
          this.passwordSent = true;
          await this.type(passwordQuery, credentials.password);
          await this.click(name('^Войти$'));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        if (error.code === 'authorization_return_in_progress') {
          const latest = await this.call('auth-state');
          // Sent flags remain set. A callback-started operation is never
          // replayed; subsequent iterations can only wait, finish or fail.
          if (latest.returning && !latest.failed) continue;
        }
        throw error;
      }
    }
    return this.manual('auth_timeout');
  }
  async close() {
    clearInterval(this.peerTimer);
    if (!this.completed)
      await requestLocal(
        this.config.authorization,
        {
          command: 'cancel',
          sessionId: this.config.authorization.sessionId,
          requestId: this.config.authorization.requestId,
          authorizationLease: this.config.leaseId,
        },
        { timeout: 1500 },
      ).catch(() => {});
  }
}
