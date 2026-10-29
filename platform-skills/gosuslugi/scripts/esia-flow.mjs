import crypto from 'node:crypto';
import { authOrigin, digest, requireThat } from './core.mjs';

// ESIA owns the authorization protocol; relying-party navigation belongs to
// the caller. A callback is learned from the actual request in the bound Page,
// not from a provider-specific hostname/path map or caller-supplied allowlist.
export function serviceForOrigin(origin) { return { origin }; }

export function externalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.port && !authOrigin(value);
  } catch { return false; }
}
export function entryUrl(value, service) {
  return externalUrl(value) && new URL(value).origin === service?.origin;
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

/** Read only the browser-observed authorization transport, without rewriting it.
 * Some relying parties submit OAuth as an HTML form: the URL alone then has no
 * redirect_uri. Merge query/body entries rather than using set(), so duplicate
 * security parameters across the two transports still fail uniqueParameter().
 * Bodies/values remain in caller RAM and never enter a descriptor or diagnostic.
 */
export function authorizationParameters(value, method = 'GET', form = null) {
  const url = new URL(value);
  if (!authOrigin(url.href)) return null;
  const formEncoded = method === 'POST' && form && typeof form.contentType === 'string' &&
    form.contentType.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
  const searchParams = new URLSearchParams(url.searchParams);
  if (formEncoded) {
    requireThat(typeof form.body === 'string' && Buffer.byteLength(form.body, 'utf8') <= 65536,
      'service_oauth_parameters_invalid');
    // URLSearchParams silently repairs malformed percent/UTF-8 bytes. Do not
    // let that repair change the state/callback identity we claim to observe.
    try { decodeURIComponent(form.body.replaceAll('+', ' ')); }
    catch { requireThat(false, 'service_oauth_parameters_invalid'); }
    for (const [key, content] of new URLSearchParams(form.body)) searchParams.append(key, content);
  }
  if (!searchParams.has('redirect_uri')) return null;
  requireThat(method === 'GET' || formEncoded, 'service_redirect_rejected');
  return { searchParams };
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
  observeNavigation(value, method = 'GET', form = null) {
    const url = new URL(value);
    const parameters = authorizationParameters(value, method, form);
    if (parameters) {
      requireThat(!this.callbackSeen, 'service_callback_already_used');
      // Capture the browser's real authorization request, never manufacture one.
      // Bind the exact observed callback even when it belongs to an external
      // broker. A second transaction cannot replace it during the native lease.
      const redirect = uniqueParameter(parameters, 'redirect_uri');
      const state = uniqueParameter(parameters, 'state');
      const client = uniqueParameter(parameters, 'client_id');
      const responseType = uniqueParameter(parameters, 'response_type');
      requireThat(
          // Recognize only ASCII case variants of authorization-code mode.
          // Do not trim, decode twice, accept token/hybrid modes or rewrite the
          // request. Duplicate parameters and callback/state guards remain
          // independent checks before a credential capability can be issued.
          responseType.length === 4 && /^[cC][oO][dD][eE]$/.test(responseType) &&
          externalUrl(redirect),
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
      this.binding && externalUrl(url.href) &&
      ['code', 'state', 'error', 'access_token', 'id_token'].some(name => url.searchParams.has(name))
    ) {
      requireThat(
        this.binding && url.origin === this.binding.callback.origin &&
          url.pathname === this.binding.callback.pathname,
        'service_callback_rejected_target',
      );
      for (const name of ['code', 'state', 'error_description', 'access_token', 'id_token'])
        this.remember(uniqueParameter(url, name, false));
      const state = uniqueParameter(url, 'state');
      const stateMatches = crypto.timingSafeEqual(
        Buffer.from(digest(state)),
        Buffer.from(this.binding.stateHash),
      );
      // Fixed rejection codes identify the failed invariant without exposing
      // the callback URL, OAuth values or comparison operands. Diagnostics do
      // not relax any condition or turn a partial return into authenticated.
      requireThat(method === 'GET', 'service_callback_rejected_method');
      requireThat(!url.hash, 'service_callback_rejected_fragment');
      requireThat(stateMatches, 'service_callback_rejected_state');
      requireThat([...this.binding.callback.searchParams].every(
        ([name, content]) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === content),
      'service_callback_rejected_query');
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
    // External HTTP failures describe the caller's site, not ESIA. They cannot
    // revoke an already verified ESIA response or trigger another credential
    // attempt. The browser observer separately returns the committed document's
    // bounded HTTP evidence to the caller. An ESIA/role response error remains
    // a provider failure and retains the first safe status/origin only.
    if (authOrigin(value) && status >= 400) {
      if (!this.error) {
        this.error = 'service_http_error';
        if (Number.isInteger(status) && status <= 599)
          this.httpFailure = { httpStatus: status, httpOrigin: url.origin };
      }
      return;
    }
    if (!this.binding) this.reused = false;
    if (this.callbackSeen && externalUrl(value) &&
      url.origin === this.binding.callback.origin &&
      url.pathname === this.binding.callback.pathname &&
      url.searchParams.has('code') && Number.isInteger(status) && status >= 200 && status <= 599)
      this.callbackAccepted = true;
  }
  allowSecret() {
    requireThat(this.binding && !this.error && !this.callbackSeen, 'service_authorization_request_required');
  }
  get hasAuthenticatedReturn() {
    return !this.error && (this.reused || this.callbackAccepted);
  }
}
