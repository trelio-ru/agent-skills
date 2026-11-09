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

// Synthetic provider seam: the host suite tests real owner hashing and locks.
// This locator lets the CLI regression prove that it uses the host-selected
// live root rather than falling back to its reusable account vault directory.
export const BROWSER_EXECUTION_SESSIONS_API = 'trelio.browser-execution-sessions/v1';
export const browserExecutionDirectory = (directory, environment = process.env) =>
  environment.TRELIO_TEST_SESSION_DIRECTORY || directory;

export { withBrowserAccountState, browserExecutionDirectories } from '../../../_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs';
