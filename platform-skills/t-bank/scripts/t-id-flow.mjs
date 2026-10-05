import crypto from 'node:crypto';
import { digest, requireThat, tIdAuthUrl } from './core.mjs';

// Only the observed T‑ID OAuth transaction is validated here. The caller owns
// arbitrary navigation, business actions, downloads and the Playwright context.
export function serviceUrl(value, service) {
  if (!service) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === service.origin &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
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
export class ServiceFlow {
  constructor(service, { reused = false } = {}) {
    this.service = service;
    this.reused = reused;
    this.binding = null;
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
    const authorizationRequest = tIdAuthUrl(url.href) && /^\/auth\/authorize\/?$/.test(url.pathname) &&
      url.searchParams.has('redirect_uri');
    if (authorizationRequest) {
      requireThat(!this.callbackSeen, 'service_callback_already_used');
      // Capture the browser's real authorization request, never manufacture one.
      // The callback must return to this exact service, and a second transaction
      // cannot replace an already-bound request during the same native lease.
      const redirect = uniqueParameter(url, 'redirect_uri');
      const state = uniqueParameter(url, 'state');
      const client = uniqueParameter(url, 'client_id');
      const responseMode = uniqueParameter(url, 'response_mode', false);
      requireThat(
        method === 'GET' &&
          uniqueParameter(url, 'response_type') === 'code' &&
          (!responseMode || responseMode === 'query') &&
          serviceUrl(redirect, this.service),
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
    } else if (
      serviceUrl(url.href, this.service) &&
      // `state` correlates an OAuth result but is not a result by itself. Some
      // relying parties keep it on an intermediate same-origin route before
      // opening T-ID or returning to their exact callback. Treating that route
      // as the callback rejects a valid transaction before the user can sign in.
      ['code', 'error', 'access_token', 'id_token'].some((name) => url.searchParams.has(name))
    ) {
      requireThat(
        this.binding && url.pathname === this.binding.callback.pathname,
        'service_callback_rejected',
      );
      for (const name of ['code', 'state', 'session_state', 'error_description', 'access_token', 'id_token'])
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
    // T‑ID errors and an unsuccessful callback still fail closed below.
    if (status === 401 && serviceUrl(value, this.service) && !this.binding && !this.callbackSeen) {
      this.reused = false;
      return;
    }
    // A valid code request followed by an HTTP error is not a successful
    // relying-party return, even if an error template contains a logout link.
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      if (!this.error && (serviceUrl(value, this.service) || tIdAuthUrl(value))) {
        this.httpFailure = { httpStatus: status, httpOrigin: url.origin };
      }
      this.error ||= 'service_http_error';
      return;
    }
    if (
      this.callbackSeen &&
      serviceUrl(value, this.service) &&
      url.pathname === this.binding.callback.pathname &&
      url.searchParams.has('code') &&
      status >= 200 &&
      status < 400
    )
      this.callbackAccepted = true;
  }
  allowSecret() {
    requireThat(this.binding && !this.error && !this.callbackSeen, 'service_authorization_request_required');
  }
  get hasAuthenticatedReturn() {
    return !this.error && (this.reused || this.callbackAccepted);
  }
}
