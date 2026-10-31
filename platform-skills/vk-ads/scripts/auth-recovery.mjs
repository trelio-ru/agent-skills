import crypto from 'node:crypto';
import { check, Fault, credentials, hash, stable, scope, UUID } from './core.mjs';
import { Api, safeApiErrorDetails } from './api.mjs';

const TERMINAL = new Set(['verified', 'revoke_rejected']);
const PHASES = new Set([...TERMINAL, 'revoke_unknown', 'revoked', 'mint_unknown', 'grant_saved']);
const OPERATION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set(['authorization_required', 'permission_denied', 'network_unavailable',
  'api_rejected', 'api_method_unsupported', 'response_invalid', 'response_too_large',
  'oauth_response_invalid', 'oauth_refresh_invalid', 'oauth_revoke_rejected', 'oauth_revoke_unknown', 'oauth_revoke_pending']);
const records = state => Object.values(state.authRecoveryOperations || {});
const fingerprint = value => hash(stable(value));
const noSetup = state => check(!state.setup || !['starting', 'waiting_input', 'checking'].includes(state.setup.phase), 'setup_already_pending');

// A token deletion or issuance with an unknown outcome must survive process
// restart, reset and reconfiguration. Never let an ordinary read silently mint
// another grant while the recovery journal is unresolved. Advertising receipts
// are independent evidence and are neither accepted nor removed by this flow.
export function assertAuthRecoveryIdle(state) {
  check(!records(state).some(r => !TERMINAL.has(r.phase)), 'auth_recovery_unresolved');
}

function describe(record) {
  check(PHASES.has(record.phase) && OPERATION.test(record.operation) && UUID.test(record.planId), 'auth_recovery_receipt_invalid');
  return { operation: record.operation, planId: record.planId, phase: record.phase,
    createdAt: new Date(record.createdAt).toISOString(),
    ...(record.verifiedAt ? { verifiedAt: new Date(record.verifiedAt).toISOString() } : {}),
    ...(record.errorCode ? { error: ERROR_CODES.has(record.errorCode) ? record.errorCode : 'auth_recovery_failed' } : {}),
    ...(record.errorDetails ? { errorDetails: safeApiErrorDetails(record.errorDetails) } : {}),
    replayed: false, verified: record.phase === 'verified',
    ...(record.phase === 'grant_saved' ? { nextAction: 'auth-recovery-check with this operation; no revoke or initial issuance' } : {}) };
}
function failure(record, error) {
  record.errorCode = error instanceof Fault && ERROR_CODES.has(error.code) ? error.code : 'auth_recovery_failed';
  // Keep only closed diagnostics; no response text, client identity or token
  // value belongs in a receipt, including when a remote error echoes them.
  record.errorDetails = safeApiErrorDetails({ httpStatus: error?.details?.httpStatus,
    requestStage: error?.details?.requestStage, oauthReason: error?.details?.oauthReason });
}

export class AuthRecovery {
  constructor(store, apiOptions = {}) { this.store = store; this.apiOptions = apiOptions; }
  async plan() {
    return this.store.lock(async () => {
      const state = await this.store.read(); noSetup(state); assertAuthRecoveryIdle(state);
      check(state.credentials, 'credentials_required'); credentials(state.credentials);
      // If the cache can still read the account, deleting every grant is not
      // the minimum recovery. Return to the ordinary read path instead.
      check(!new Api(state.credentials, this.apiOptions).access, 'auth_recovery_not_needed');
      state.authRecoveryPlans ||= {};
      check(Object.keys(state.authRecoveryPlans).length < 100, 'auth_recovery_history_full');
      const planId = crypto.randomUUID(), plan = { planId, scope: scope(this.store.owner),
        beforeHash: fingerprint(state.credentials), expiresAt: Date.now() + 30 * 60 * 1000,
        mode: state.credentials.mode, target: state.credentials.mode === 'agency' ? 'configured_agency_user' : 'api_access_owner',
        effect: 'revoke_all_grants_of_selected_user',
        actions: ['revoke_once', 'issue_one_access_refresh_pair', 'save_encrypted_pair', 'check_campaign_and_group_reads'] };
      const planHash = hash(stable(plan)); state.authRecoveryPlans[planId] = { ...plan, planHash };
      await this.store.write(state);
      return { planId, planHash, account: this.store.owner.account, mode: plan.mode, target: plan.target,
        effect: plan.effect, actions: plan.actions, expiresAt: new Date(plan.expiresAt).toISOString(),
        hasRefresh: Object.hasOwn(state.credentials, 'refresh_token'),
        warning: 'This is all-user revocation, not deletion of one token or device. Other consumers may lose API access. Requires the operator decision on this exact plan.' };
    });
  }
  async status(operation) {
    check(OPERATION.test(operation || ''), 'operation_invalid');
    const state = await this.store.read(), record = state.authRecoveryOperations?.[operation];
    check(record?.scope === scope(this.store.owner), 'operation_not_found'); return describe(record);
  }
  async apply(planId, planHash, operation, confirmation) {
    check(UUID.test(planId || '') && DIGEST.test(planHash || '') && OPERATION.test(operation || ''), 'auth_recovery_plan_invalid');
    check(confirmation === 'revoke-all-user-grants', 'confirmation_required');
    return this.store.lock(async () => {
      const state = await this.store.read(); state.authRecoveryOperations ||= {};
      const existing = state.authRecoveryOperations[operation];
      if (existing) {
        check(existing.scope === scope(this.store.owner) && existing.planId === planId && existing.planHash === planHash, 'auth_recovery_operation_conflict');
        return describe(existing); // Observing the same invocation never dispatches it again.
      }
      noSetup(state); assertAuthRecoveryIdle(state);
      check(!records(state).some(r => r.planId === planId), 'auth_recovery_plan_already_used');
      check(records(state).length < 1000, 'auth_recovery_history_full');
      const plan = state.authRecoveryPlans?.[planId];
      check(plan?.scope === scope(this.store.owner) && plan.planHash === planHash && plan.expiresAt > Date.now(), 'auth_recovery_plan_invalid');
      const { planHash: savedHash, ...material } = plan;
      check(hash(stable(material)) === savedHash && fingerprint(state.credentials) === plan.beforeHash, 'credentials_changed');
      const record = { operation, planId, planHash, scope: plan.scope, phase: 'revoke_unknown', createdAt: Date.now() };
      state.authRecoveryOperations[operation] = record;
      // This save is BEFORE the first HTTP dispatch. A timeout or crash leaves
      // a durable fence, not permission to delete or issue again under a new ID.
      await this.store.write(state);
      try { await new Api(state.credentials, this.apiOptions).revokeAllUserGrants(); }
      catch (error) {
        if (error instanceof Fault && error.code === 'oauth_revoke_rejected') record.phase = 'revoke_rejected';
        failure(record, error); await this.store.write(state); return describe(record);
      }
      record.phase = 'revoked'; await this.store.write(state);
      record.phase = 'mint_unknown'; await this.store.write(state);
      // The reviewed operation intentionally replaces revoked credentials with
      // ONE new grant. Do not try the now-revoked refresh value, or retain an old
      // access value as a fallback. Preserve the client configuration and all
      // advertising receipts; values remain inside the encrypted account store.
      const api = new Api(credentials(state.credentials), this.apiOptions);
      try { await api.login(); }
      catch (error) { failure(record, error); await this.store.write(state); return describe(record); }
      state.credentials = api.auth; record.phase = 'grant_saved';
      record.afterHash = fingerprint(state.credentials); await this.store.write(state);
      return this.checkLocked(state, record);
    });
  }
  async check(operation) {
    check(OPERATION.test(operation || ''), 'operation_invalid');
    return this.store.lock(async () => {
      const state = await this.store.read(), record = state.authRecoveryOperations?.[operation];
      check(record?.scope === scope(this.store.owner), 'operation_not_found');
      if (record.phase === 'verified') return describe(record);
      check(record.phase === 'grant_saved', 'auth_recovery_outcome_unknown');
      return this.checkLocked(state, record);
    });
  }
  async checkLocked(state, record) {
    noSetup(state); check(fingerprint(state.credentials) === record.afterHash, 'credentials_changed');
    const api = new Api(state.credentials, this.apiOptions);
    // Rechecking an unverified result is strictly GET-only. An expired cache
    // cannot silently turn a verification into another OAuth request.
    check(api.access, 'auth_recovery_access_expired');
    try {
      await api.list('plans', {}, 1); await api.list('groups', {}, 1);
      record.phase = 'verified'; record.verifiedAt = Date.now(); delete record.errorCode; delete record.errorDetails;
    } catch (error) { failure(record, error); }
    await this.store.write(state); return describe(record);
  }
}
