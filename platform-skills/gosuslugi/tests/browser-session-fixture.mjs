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
