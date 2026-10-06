import { requireThat, RuntimeError, serviceHttpFailure, UUID } from './core.mjs';

// These recognizers consume private ESIA text, but return only fixed reasons
// and a bounded duration. Neither the provider message nor account data is
// copied into the vault, status endpoint, diagnostic error or agent prompt.
export function accountBlock(text) {
  const normalized = String(text).slice(0, 16000).replace(/\s+/g, ' ');
  if (!/доступ\s+временно\s+заблокирован|уч[её]тная\s+запись\s+(?:временно\s+)?заблокирована/i.test(normalized)) return null;
  const match = /(?:доступ|уч[её]тная\s+запись)\s+будет\s+разблокирован[ао]?\s+в\s+течени[её]\s+(\d{1,3})\s+час/i.exec(normalized);
  const hours = match ? Number(match[1]) : null;
  return { reason: 'account_temporarily_blocked',
    retryAfterHours: Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : null };
}

export function credentialsRejected(text) {
  return /неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(String(text).slice(0, 16000));
}

export function credentialGate(reason, retryAfterHours = null, now = Date.now()) {
  requireThat(['account_temporarily_blocked', 'credentials_rejected'].includes(reason), 'auth_gate_invalid');
  requireThat(Number.isSafeInteger(now) && now > 0, 'auth_gate_invalid');
  requireThat(retryAfterHours === null || reason === 'account_temporarily_blocked' &&
    Number.isInteger(retryAfterHours) && retryAfterHours >= 1 && retryAfterHours <= 168, 'auth_gate_invalid');
  return { schema: 1, reason, observedAt: now,
    retryAt: retryAfterHours === null ? null : now + retryAfterHours * 3600000 };
}

export function activeCredentialGate(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  requireThat(value.schema === 1 && ['account_temporarily_blocked', 'credentials_rejected'].includes(value.reason) &&
    Number.isSafeInteger(value.observedAt) && value.observedAt > 0 &&
    (value.retryAt === null || value.reason === 'account_temporarily_blocked' && Number.isSafeInteger(value.retryAt) &&
      value.retryAt > value.observedAt && value.retryAt - value.observedAt <= 168 * 3600000), 'auth_gate_invalid');
  if (value.retryAt !== null && now >= value.retryAt) return null;
  return { reason: value.reason, retryAt: value.retryAt };
}

export function recoveredCredentialGate(value, userReportedRecovery) {
  requireThat(userReportedRecovery === true, 'account_recovery_confirmation_required');
  activeCredentialGate(value);
  // This is an explicit report from the operator, never a timeout/network
  // inference. It releases only the account-block latch; rejected credentials
  // still require their own correction or a verified manual login.
  return value?.reason === 'account_temporarily_blocked' ? undefined : value;
}

// The ordinary Gosuslugi portal and one caller-owned OAuth transaction are
// independent results. Retain the exact attempt after its broker disappears:
// restoring the ordinary portal must never erase a failed external login.
export class AuthorizationAttempt {
  constructor(request) {
    this.request = request;
    this.status = 'pending';
  }
  observePhase(phase, manualReason = null) {
    if (this.status === 'failed' || this.status === 'callback_verified') return;
    if (phase === 'authorized') this.status = 'callback_verified';
    else if (phase === 'user_required') { this.status = 'user_required'; this.manualReason = manualReason; }
    else if (['authorization_check', 'unlock_required', 'authenticating'].includes(phase)) {
      this.status = 'pending'; this.manualReason = null;
    }
  }
  fail(error) {
    if (this.status === 'callback_verified') return;
    this.status = 'failed'; this.manualReason = null;
    this.error = error instanceof RuntimeError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'authorization_result_unknown';
    this.httpFailure = serviceHttpFailure({ ...error, code: this.error });
  }
  requireResume() {
    requireThat(this.status !== 'failed', 'authorization_retry_required');
    requireThat(this.status !== 'callback_verified', 'authorization_already_completed');
  }
  publicState() {
    return { origin: this.request.origin, browserSessionId: this.request.sessionId,
      requestId: this.request.requestId, status: this.status,
      ...(this.status === 'failed' ? { error: this.error, ...this.httpFailure } : {}),
      ...(this.status === 'user_required' && this.manualReason ? { manualReason: this.manualReason } : {}) };
  }
}

// A lost local transport has no evidence about the upstream response. Preserve
// a precise safe peer error when available, otherwise report only the loss.
export function authorizationFailure(error) {
  if (!(error instanceof RuntimeError)) return new RuntimeError('authorization_result_unknown');
  if (['session_unreachable', 'authorization_closed'].includes(error.code)) return new RuntimeError('authorization_session_lost');
  return error;
}

// status.json outlives its process. Project only the bounded public receipt,
// never a former control capability, arbitrary field or exception message.
export function closedDiagnostics(value) {
  const result = {};
  if (/^[a-z_]{1,80}$/.test(value?.error ?? '')) {
    result.error = value.error; Object.assign(result, serviceHttpFailure(value));
    if (['authorization_validation', 'vault_validation', 'authorization_claim', 'vault_unlock', 'vault_read',
      'browser_launch', 'credential_setup', 'portal_open', 'portal_authentication', 'authorization', 'vault_write'].includes(value.failureStage))
      result.failureStage = value.failureStage;
  }
  const auth = value?.authorization;
  try {
    const origin = new URL(auth?.origin);
    if (origin.protocol === 'https:' && origin.origin === auth.origin && !origin.username && !origin.password && !origin.port &&
      UUID.test(auth.browserSessionId) && UUID.test(auth.requestId) &&
      ['pending', 'user_required', 'failed', 'callback_verified'].includes(auth.status)) {
      result.authorization = { origin: auth.origin, browserSessionId: auth.browserSessionId,
        requestId: auth.requestId, status: auth.status };
      if (auth.status === 'failed' && /^[a-z_]{1,80}$/.test(auth.error ?? ''))
        Object.assign(result.authorization, { error: auth.error }, serviceHttpFailure(auth));
      if (auth.status === 'user_required' && ['account_temporarily_blocked', 'credentials_rejected', 'consent_required',
        'role_choice_required', 'challenge_required', 'code_required', 'auth_timeout'].includes(auth.manualReason))
        result.authorization.manualReason = auth.manualReason;
    }
  } catch {}
  const gate = value?.credentialGate;
  if (['account_temporarily_blocked', 'credentials_rejected'].includes(gate?.reason) &&
    (gate.retryAt === null || gate.reason === 'account_temporarily_blocked' && Number.isSafeInteger(gate.retryAt) && gate.retryAt > 0))
    result.credentialGate = { reason: gate.reason, retryAt: gate.retryAt };
  return result;
}
