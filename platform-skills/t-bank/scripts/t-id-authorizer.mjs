import { challengeKind, requireThat, RuntimeError, segmentedTotpFields, totpCode } from './core.mjs';
import { requestLocal } from './transport.mjs';

const css = (value) => ({ css: value, visible: true });
const button = (pattern) => ({ role: 'button', name: { pattern, flags: 'i' }, visible: true });
const phone = css(
  'input[autocomplete="tel"],input[name="phone"],input[name="phoneNumber"]',
);
const fallbackPhone = css('input[type="tel"]');
const password = css(
  'input[type="password"]:not([autocomplete="one-time-code"]):not([inputmode="numeric"]),' +
    'input[autocomplete="current-password"],input[name="password"]',
);
const username = css(
  'input[autocomplete="username"],input[name="login"]:not([type="tel"]),input[aria-label="Логин"]',
);
const codeHint = css(
  'input[autocomplete="one-time-code"]:not([autocomplete="tel"]),' +
    'input[inputmode="numeric"]:not([autocomplete="tel"]),' +
    'input[type="tel"]:not([autocomplete="tel"]):not([name="phone"]):not([name="phoneNumber"]),' +
    'input[maxlength="1"]:not([type="password"]):not([name="phone"]):not([name="phoneNumber"])',
);
const codeFields = css(
  // T-ID currently marks only the first OTP cell. The exact challenge text and
  // segmentedTotpFields() validate this broader six-input group before a secret
  // is generated, so generic controls never become an unguarded OTP target.
  'input:not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"]):not([type="range"]):not([type="color"]):not([autocomplete="tel"]):not([autocomplete="username"]):not([name="phone"]):not([name="phoneNumber"]):not([name="password"])',
);
const submit = button('^(Продолжить|Подтвердить|Войти|Далее)$');
const declinePinButton = {
  role: 'button',
  name: { pattern: '^Не сейчас$', flags: 'i' },
  visible: true,
};
const declinePinLink = {
  role: 'link',
  name: { pattern: '^Не сейчас$', flags: 'i' },
  visible: true,
};
const TRANSITION_GRACE_MS = 15_000;

// The authorizer knows only T‑ID authentication UI. It never opens or
// interprets the relying party, and it deliberately leaves data-sharing
// consent, SMS/push, CAPTCHA and every unknown screen to the user.
export class TIdAuthorizer {
  constructor(config, { permit, onPhase }) {
    this.config = config;
    this.permit = permit;
    this.onPhase = onPhase;
    this.phoneSent = false;
    this.usernameSent = false;
    this.passwordSent = false;
    this.codeSent = false;
    this.optionalPinSkipped = false;
    this.transitionDeadline = 0;
    this.completed = false;
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

  watchPeer({ isBusy, onReturned, onLost }) {
    // Manual provider checks do not keep authenticate() running. This local
    // peer watch observes only a verified return or peer loss; it cannot type,
    // click, extend the native deadline or poll the external service itself.
    let checking = false;
    this.peerTimer = setInterval(async () => {
      if (checking || this.completed || isBusy()) return;
      checking = true;
      try {
        const state = await this.call('auth-state');
        if (!isBusy() && state.returned) await onReturned();
      } catch (error) {
        if (error.code !== 'session_busy' && !this.completed && !isBusy()) await onLost();
      } finally {
        checking = false;
      }
    }, 2000);
    this.peerTimer.unref();
  }

  async observe() {
    return this.call('auth-operation', {
      operation: 'observe',
      queries: {
        phone,
        fallbackphone: fallbackPhone,
        password,
        username,
        code: codeHint,
        codefields: codeFields,
        submit,
        declinepinbutton: declinePinButton,
        declinepinlink: declinePinLink,
        checkboxes: css('input[type="checkbox"]'),
        onlyinput: css(
          'input:not([type="checkbox"]):not([type="radio"]):not([type="tel"]):not([autocomplete="tel"]):not([autocomplete="one-time-code"]):not([inputmode="numeric"])',
        ),
        passwordlabel: {
          text: { pattern: '^(Введите пароль|Пароль)$', flags: 'i' },
          visible: true,
        },
      },
    });
  }

  async type(query, text, inputKind) {
    return this.call('auth-operation', {
      operation: 'type',
      query,
      text,
      ...(inputKind ? { inputKind } : {}),
    });
  }

  async submitPhone(query, text) {
    return this.call('auth-operation', {
      operation: 'submit-phone',
      query,
      text,
    });
  }

  async submitInput(query) {
    return this.call('auth-operation', {
      operation: 'submit-input',
      query,
    });
  }

  async click(query, expectedLabel) {
    return this.call('auth-operation', {
      operation: 'click',
      query,
      ...(expectedLabel ? { expectedLabel } : {}),
    });
  }

  async show() {
    return this.call('show');
  }

  async manual(reason = 'unknown_auth_screen') {
    await this.onPhase('user_required', reason);
    // T-Bank windows remain background surfaces even when the provider needs a
    // person. The public `show` command can reveal this exact bound page only
    // after an explicit request; an auth challenge alone is not focus consent.
    return false;
  }

  markTransition() {
    // Credential submit can replace the form with a short empty T-ID document
    // before either the next challenge or the verified callback commits. Keep
    // sent guards intact and wait briefly instead of reporting that transient
    // document as a manual user step.
    this.transitionDeadline = Date.now() + TRANSITION_GRACE_MS;
  }

  async finish() {
    await this.call('complete');
    this.completed = true;
    await this.onPhase('authorized');
    return true;
  }

  async authenticate(credentials) {
    await this.onPhase('authenticating');
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const state = await this.call('auth-state');
      if (state.failed) throw new RuntimeError(state.failed, state);
      if (state.returned) return this.finish();
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
            // A callback can begin between auth-state and the read-only
            // observation. From that point only wait/finish is allowed.
            const latest = await this.call('auth-state');
            if (latest.returning && !latest.failed) continue;
          }
          throw error;
        }

        const q = current.queries;
        if (/неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(current.text))
          return this.manual('provider_rejected_credentials');

        const hasPassword =
          q.password.count > 0 ||
          (this.phoneSent &&
            !this.passwordSent &&
            q.phone.count === 0 &&
            q.password.count === 0 &&
            q.onlyinput.count === 1 &&
            q.passwordlabel.count > 0);
        const passwordQuery = q.password.count
          ? password
          : css(
            'input:not([type="checkbox"]):not([type="radio"]):not([type="tel"]):not([autocomplete="tel"]):not([autocomplete="one-time-code"]):not([inputmode="numeric"])',
          );
        const broadCodeCount = [1, 6].includes(q.codefields.count) ? q.codefields.count : 0;
        const codeCount = broadCodeCount || q.code.count;
        const codeQuery = broadCodeCount ? codeFields : codeHint;
        const hasCode = !q.phone.count && !hasPassword && !q.username.count && codeCount > 0 &&
          /введите.{0,60}код|код.{0,60}(?:смс|sms|приложени|аутентификатор|TOTP|генератор)|подтвердите вход/i.test(current.text);
        const hasPhone = q.phone.count === 1 || !hasCode && q.phone.count === 0 && q.fallbackphone.count === 1;
        const phoneQuery = q.phone.count === 1 ? phone : fallbackPhone;

        // T‑ID explicitly asks the person to choose and approve data sharing.
        // A generic Continue button never converts that legal choice into an
        // authentication detail the runtime may accept on the user's behalf.
        const consent =
          (q.checkboxes.fields || []).some(
            (field) =>
              !field.checked &&
              /согласи|согласен|персональн.{0,30}данн|передач.{0,30}данн/i.test(field.label),
          ) ||
          (!hasPhone &&
            !hasPassword &&
            !q.username.count &&
            !codeCount &&
            /(?:предостав|переда|разреш).{0,120}(?:доступ|сведен|данн)|выбер.{0,80}(?:доступ|сведен|данн)|соглас.{0,80}(?:передач|обработ)/i.test(
              current.text,
            ));
        if (consent) return this.manual('consent_required');

        const challenge = challengeKind(current.text, hasCode);
        if (challenge === 'manual') {
          // Match the narrow personal-cabinet rule: only the optional local
          // quick-PIN enrollment can be declined automatically. Any concurrent
          // device/security/payment warning keeps the whole screen manual.
          const optionalPin =
            /придумайте\s+код/i.test(current.text) &&
            /для\s+быстрого\s+входа\s+в\s+личный\s+кабинет/i.test(current.text) &&
            /работает\s+только\s+в\s+том\s+браузере/i.test(current.text) &&
            challengeKind(current.text.replace(/придумайте\s+код|быстрого\s+входа/gi, ''), false) === 'none' &&
            q.password.count === 0 &&
            q.username.count === 0 &&
            q.code.count === 4 &&
            q.declinepinbutton.count + q.declinepinlink.count === 1;
          if (optionalPin && !this.optionalPinSkipped) {
            this.optionalPinSkipped = true;
            this.markTransition();
            await this.click(q.declinepinbutton.count ? declinePinButton : declinePinLink, 'Не сейчас');
          } else return this.manual('security_challenge');
        } else if (challenge === 'totp' || challenge === 'user_code') {
          if (this.codeSent) {
            if (this.transitionDeadline && Date.now() >= this.transitionDeadline)
              return this.manual('totp_result_unresolved');
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          // SMS, an app push or an absent TOTP seed stays in the bound T‑ID
          // page. The agent never receives the current code.
          if (challenge !== 'totp') return this.manual('manual_code_required');
          if (!credentials.totp) return this.manual('totp_not_configured');
          const count = codeCount;
          requireThat(count === 1 || count === 6, 'auth_input_ambiguous');
          const left = 30000 - (Date.now() % 30000);
          if (left < 8000) await new Promise((resolve) => setTimeout(resolve, left + 250));
          const fresh = await this.observe();
          requireThat(
            challengeKind(
              fresh.text,
              !fresh.queries.phone.count &&
                !fresh.queries.password.count &&
                !fresh.queries.username.count &&
                (broadCodeCount ? fresh.queries.codefields.count : fresh.queries.code.count) > 0,
            ) === 'totp' &&
              (broadCodeCount ? fresh.queries.codefields.count : fresh.queries.code.count) === count,
            'auth_challenge_changed',
          );
          if (count === 6) {
            const fields = fresh.queries.codefields.fields;
            requireThat(segmentedTotpFields(fields), 'auth_segmented_code_ambiguous');
          }
          this.codeSent = true;
          this.markTransition();
          let value = totpCode(credentials.totp);
          try {
            await this.call('protect-input', { text: value });
            if (count === 1) await this.type(codeQuery, value);
            else for (let index = 0; index < count; index++)
              await this.type({ ...codeQuery, nth: index }, value[index]);
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
                !observed.queries.phone.count &&
                  !observed.queries.password.count &&
                  !observed.queries.username.count &&
                  ([1, 6].includes(observed.queries.codefields.count)
                    ? observed.queries.codefields.count
                    : observed.queries.code.count) > 0,
              ) === 'totp'
            ) {
              this.markTransition();
              await this.click(submit);
            }
          }
        } else if (!this.phoneSent && hasPhone) {
          this.phoneSent = true;
          // T-ID owns the visible +7 prefix. The private adapter enters only
          // national digits and verifies the masked value before this flow can
          // submit, so a duplicated country code fails closed instead of
          // becoming a wrong phone followed by a misleading manual phase.
          await this.type(phoneQuery, credentials.login, 't-id-phone');
          if (!hasPassword) {
            const found = await this.call('auth-operation', {
              operation: 'observe',
              queries: { submit },
            });
            // T-BKI renders the first submit as an arrow-only button without
            // an accessible name. Prefer the exact labelled control when it
            // exists; otherwise submit from the already-bound and verified
            // phone input so we never guess between the arrow and clear icon.
            requireThat(found.queries.submit.count <= 1, 'auth_submit_ambiguous');
            this.markTransition();
            if (found.queries.submit.count === 1) await this.click(submit);
            else await this.submitPhone(phoneQuery, credentials.login);
          }
        } else if (!this.passwordSent && hasPassword) {
          if (q.username.count > 0) {
            requireThat(credentials.username && !this.usernameSent, 'username_required');
            this.usernameSent = true;
            await this.type(username, credentials.username);
          }
          this.passwordSent = true;
          await this.type(passwordQuery, credentials.password);
          const found = await this.call('auth-operation', {
            operation: 'observe',
            queries: { submit },
          });
          requireThat(found.queries.submit.count <= 1, 'auth_submit_ambiguous');
          this.markTransition();
          if (found.queries.submit.count === 1) await this.click(submit);
          else await this.submitInput(passwordQuery);
        } else {
          if (this.transitionDeadline > Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          // Unknown T‑ID pages are not inferred from a button label. Showing
          // the already-bound page is the only safe continuation.
          return this.manual('unknown_auth_screen');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        if (error.code === 'authorization_return_in_progress') {
          const latest = await this.call('auth-state');
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
