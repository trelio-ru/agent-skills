export const readBrowserSessionBinding = ({ environment, expectedSessionClass }) => {
  const policy = JSON.parse(environment.TRELIO_BROWSER_SESSION_POLICY_JSON);
  if (policy.sessionClass !== expectedSessionClass) throw new Error('browser_session_class_mismatch');
  const startedAt = Number(environment.TRELIO_BROWSER_SESSION_STARTED_AT);
  const deadlineAt = Number(environment.TRELIO_BROWSER_SESSION_DEADLINE_AT);
  if (deadlineAt !== startedAt + policy.leaseMs || deadlineAt <= Date.now()) {
    throw new Error('browser_session_deadline_invalid');
  }
  return { ...policy, startedAt, deadlineAt, remainingMs: deadlineAt - Date.now() };
};
// Synthetic host seam only; common host tests exercise the real private
// controller. Provider discovery must call it without native/browser/vault I/O.
export const prepareBrowserController = ({ environment }) => {
  if (environment.TRELIO_BROWSER_CONTROLLER_ENABLED !== '1') throw new Error('synthetic_host_refused');
  return { apiVersion: 1, sessionId: '33333333-3333-4333-8333-333333333333',
    deadlineAt: Number(environment.TRELIO_BROWSER_SESSION_DEADLINE_AT), moduleUrl: import.meta.url,
    ownerFile: '/synthetic/owner.json' };
};
