import crypto from 'node:crypto';
import { authOrigin, digest, requireThat } from './core.mjs';

// These are observed relying-party handoffs, not a caller-supplied wildcard.
// The user authorizes the entry site; only this signed runtime can extend its
// callback to an exact second origin. Unknown services keep same-origin OAuth.
export function serviceForOrigin(origin) {
  const postalOrigins = ['https://zakaznoe.pochta.ru', 'https://passport.pochta.ru'];
  const tracking = origin === 'https://www.pochta.ru';
  const postal = postalOrigins.includes(origin) || tracking;
  return {
    origin,
    // The public site may move from letters to Passport before its ESIA click.
    // Starting directly at Passport does not authorize a different pre-login
    // site merely because both services share the Почта России brand.
    entryOrigins: tracking ? [origin, 'https://passport.pochta.ru']
      : origin === 'https://zakaznoe.pochta.ru' ? postalOrigins : [origin],
    // A Passport-first login may finish in either Postal cabinet. This list
    // controls only the verified document return, not the OAuth redirect URI.
    // The general account is a return surface, not proof that letters are ready.
    serviceOrigins: postal ? [...postalOrigins, 'https://pochta.ru', 'https://www.pochta.ru'] : [origin],
    callbackOrigins: tracking ? ['https://passport.pochta.ru'] : origin === 'https://zakaznoe.pochta.ru'
      ? postalOrigins
      : [origin],
  };
}

// Only the observed ESIA OAuth transaction is validated here. The caller owns
// arbitrary navigation, business actions, downloads and the Playwright context.
function approvedUrl(value, origins) {
  if (!origins) return false;
  try {
    const url = new URL(value);
    return (
      origins.includes(url.origin) &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}
export function serviceUrl(value, service) {
  return approvedUrl(value, service?.serviceOrigins ?? (service ? [service.origin] : null));
}
export function entryUrl(value, service) {
  return approvedUrl(value, service?.entryOrigins ?? (service ? [service.origin] : null));
}
function callbackUrl(value, service) {
  return approvedUrl(value, service?.callbackOrigins ?? (service ? [service.origin] : null));
}
function uniqueParameter(url, key, required = true) {
  const values = url.searchParams.getAll(key);
  requireThat(
    values.length <= 1 && (!required || (values.length === 1 && values[0].length > 0)),
    'service_oauth_parameters_invalid',
  );
  if (values.length) requireThat(values[0].length <= 4096, 'service_oauth_parameters_invalid');
  return values[0] ?? null;
}
const POST_OIDC_AUTHORIZATION = 'https://passport.pochta.ru/oauth2/authorize';
// Each relying party has its own observed outer callback. A tracking login
// must be attached on www.pochta.ru before its login click: starting later on
// Passport loses the outer state, which cannot safely be reconstructed.
const POST_OIDC_CALLBACKS = new Map([
  ['https://zakaznoe.pochta.ru', 'https://zakaznoe.pochta.ru/oauth2/cb'],
  ['https://passport.pochta.ru', 'https://zakaznoe.pochta.ru/oauth2/cb'],
  ['https://www.pochta.ru', 'https://www.pochta.ru/api/auth/callback'],
]);

export class ServiceFlow {
  constructor(service, { reused = false } = {}) {
    this.service = service;
    this.reused = reused;
    this.binding = null;
    this.postBinding = null;
    this.postCallbackSeen = false;
    this.postCallbackAccepted = false;
    this.callbackSeen = false;
    this.callbackAccepted = false;
    this.error = null;
    this.httpFailure = null;
    this.secrets = new Set();
    this.entryAttempts = new Set();
  }
  remember(value) {
    if (value && this.secrets.size < 32) this.secrets.add(value);
  }
  redact(text) {
    return [...this.secrets].reduce((value, secret) => value.split(secret).join('[redacted]'), text);
  }
  observeNavigation(value, method = 'GET') {
    const url = new URL(value);
    if (POST_OIDC_CALLBACKS.has(this.service.origin) &&
      url.origin + url.pathname === POST_OIDC_AUTHORIZATION) {
      // Postal first authorizes its letters cabinet against Post ID. Its state
      // belongs to that transaction, not to ESIA. Bind the exact Post callback
      // now so a later code on zakaznoe cannot masquerade as an ESIA return.
      const redirect = uniqueParameter(url, 'redirect_uri');
      const state = uniqueParameter(url, 'state');
      const client = uniqueParameter(url, 'client_id');
      requireThat(method === 'GET' && uniqueParameter(url, 'response_type') === 'code' &&
        redirect === POST_OIDC_CALLBACKS.get(this.service.origin) && !this.binding && !this.callbackSeen && !this.postCallbackSeen,
      'service_redirect_rejected');
      const identity = digest(JSON.stringify([redirect, state, client]));
      requireThat(!this.postBinding || this.postBinding.identity === identity,
        'service_transaction_changed');
      this.postBinding = { identity, stateHash: digest(state), callback: redirect };
      this.reused = false;
      this.remember(state);
    } else if (authOrigin(url.href) && url.searchParams.has('redirect_uri')) {
      requireThat(!this.callbackSeen, 'service_callback_already_used');
      // Capture the browser's real authorization request, never manufacture one.
      // The callback must return to this exact service, and a second transaction
      // cannot replace an already-bound request during the same native lease.
      const redirect = uniqueParameter(url, 'redirect_uri');
      const state = uniqueParameter(url, 'state');
      const client = uniqueParameter(url, 'client_id');
      requireThat(
        method === 'GET' &&
          uniqueParameter(url, 'response_type') === 'code' &&
          callbackUrl(redirect, this.service),
        'service_redirect_rejected',
      );
      const callback = new URL(redirect);
      requireThat(
        !callback.hash &&
          !['code', 'state', 'access_token', 'id_token', 'error'].some((name) =>
            callback.searchParams.has(name),
          ),
        'service_redirect_rejected',
      );
      const identity = digest(JSON.stringify([redirect, state, client]));
      requireThat(!this.binding || this.binding.identity === identity, 'service_transaction_changed');
      this.binding = { identity, callback, stateHash: digest(state) };
      this.reused = false;
      this.remember(state);
    } else if (this.postBinding && url.origin + url.pathname === this.postBinding.callback &&
      ['code', 'state', 'error', 'access_token', 'id_token'].some(name => url.searchParams.has(name))) {
      // This is the outer Post ID callback. It is useful only after the inner
      // ESIA callback has succeeded and must carry its own bound Post state.
      for (const name of ['code', 'state', 'error_description', 'access_token', 'id_token'])
        this.remember(uniqueParameter(url, name, false));
      const state = uniqueParameter(url, 'state');
      requireThat(method === 'GET' && !url.hash && this.callbackAccepted &&
        crypto.timingSafeEqual(Buffer.from(digest(state)), Buffer.from(this.postBinding.stateHash)) &&
        !url.searchParams.has('error') && uniqueParameter(url, 'code') &&
        !url.searchParams.has('access_token') && !url.searchParams.has('id_token') &&
        !this.postCallbackSeen,
      'service_callback_rejected');
      this.postCallbackSeen = true;
    } else if (
      serviceUrl(url.href, this.service) &&
      ['code', 'state', 'error', 'access_token', 'id_token'].some((name) => url.searchParams.has(name))
    ) {
      requireThat(
        this.binding && url.origin === this.binding.callback.origin &&
          url.pathname === this.binding.callback.pathname,
        'service_callback_rejected',
      );
      for (const name of ['code', 'state', 'error_description', 'access_token', 'id_token'])
        this.remember(uniqueParameter(url, name, false));
      const state = uniqueParameter(url, 'state');
      const stateMatches = crypto.timingSafeEqual(
        Buffer.from(digest(state)),
        Buffer.from(this.binding.stateHash),
      );
      requireThat(
        method === 'GET' &&
          !url.hash &&
          stateMatches &&
          [...this.binding.callback.searchParams].every(
            ([name, content]) =>
              url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === content,
          ),
        'service_callback_rejected',
      );
      requireThat(
        !url.searchParams.has('error') &&
          uniqueParameter(url, 'code') &&
          !url.searchParams.has('access_token') &&
          !url.searchParams.has('id_token'),
        'service_authorization_failed',
      );
      requireThat(!this.callbackSeen, 'service_callback_already_used');
      this.callbackSeen = true;
    }
  }
  observeResponse(value, status) {
    const url = new URL(value);
    // A relying party may serve its unauthenticated document with HTTP 401.
    // Before an OAuth transaction this means "start sign-in", not failure of
    // credentials we have never sent. It must revoke any cached login proof.
    // ESIA errors and an unsuccessful callback still fail closed below.
    if (status === 401 && entryUrl(value, this.service) && !this.binding && !this.callbackSeen) {
      this.reused = false;
      return;
    }
    // A valid code request followed by an HTTP error is not a successful
    // relying-party return, even if an error template contains a logout link.
    if (status >= 400) {
      // Preserve the first observed document failure, never the raw callback
      // URL (which may carry code/state) or later noise from another request.
      if (!this.error) {
        this.error = 'service_http_error';
        if (Number.isInteger(status) && status <= 599 &&
            (serviceUrl(value, this.service) || entryUrl(value, this.service) || authOrigin(value))) {
          this.httpFailure = { httpStatus: status, httpOrigin: url.origin };
        }
      }
      return;
    }
    if (
      this.callbackSeen &&
      serviceUrl(value, this.service) &&
      url.origin === this.binding.callback.origin &&
      url.pathname === this.binding.callback.pathname &&
      url.searchParams.has('code') &&
      status >= 200 &&
      status < 400
    )
      this.callbackAccepted = true;
    if (this.postCallbackSeen && url.origin + url.pathname === this.postBinding.callback &&
      url.searchParams.has('code') && status >= 200 && status < 400)
      this.postCallbackAccepted = true;
  }
  allowSecret() {
    requireThat(this.binding && !this.error && !this.callbackSeen, 'service_authorization_request_required');
  }
  get hasAuthenticatedReturn() {
    return !this.error && (this.reused || this.callbackAccepted &&
      (!this.postBinding || this.postCallbackAccepted));
  }
}
