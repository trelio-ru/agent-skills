import { performance } from 'node:perf_hooks';
import { requireThat } from './core.mjs';

const COMPLETE = new Set(['ready', 'configured', 'forgotten', 'authorized', 'closed', 'failed', 'authorization_failed']);

export function validateWaitOptions(options) {
  requireThat(/^[a-f0-9-]{36}$/.test(options['--session'] || ''), 'exact_session_required');
  requireThat(/^[a-z][a-z_]{0,63}$/.test(options['--after-phase'] || ''), 'wait_phase_required');
  const seconds = options['--timeout-seconds'] ?? '30';
  requireThat(/^(?:[1-9]|[12][0-9]|30)$/.test(seconds), 'wait_timeout_invalid');
  return Number(seconds) * 1000;
}

/**
 * Observe one already-started procedure. The injected reader is the provider's
 * ordinary authenticated status path: waiting never calls resume/start, reads
 * input fields, renews a lease or retries a mutation. A monotonic call budget is
 * separate from the original native deadline, which remains authoritative.
 */
export async function waitForSessionChange(readStatus, options, {
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const timeoutMs = validateWaitOptions(options), deadline = now() + timeoutMs;
  const sessionId = options['--session'], afterPhase = options['--after-phase'];
  let failures = 0;
  while (true) {
    let state;
    try {
      state = await readStatus(Math.max(1, Math.ceil(Math.min(1000, deadline - now()))));
      failures = 0;
    } catch (error) {
      // A dropped status response is safe to reread. Identity, permissions,
      // cancellation and provider refusals are never treated as transient.
      if (error.code !== 'session_unreachable' || ++failures > 3 || now() >= deadline) throw error;
      await sleep(Math.min(250 * failures, Math.max(0, deadline - now())));
      continue;
    }
    requireThat(state?.sessionId === sessionId, 'exact_session_required');
    requireThat(/^[a-z][a-z_]{0,63}$/.test(state.phase || ''), 'local_state_invalid');
    const changed = state.phase !== afterPhase;
    const complete = COMPLETE.has(state.phase);
    const timedOut = !changed && !complete && now() >= deadline;
    if (changed || complete || timedOut) {
      return { ...state, wait: { changed, timedOut },
        // These are provider arguments, not a new host route. The caller keeps
        // the same signed localAction and any selected --local-account UUID.
        ...(!complete ? { continuation: { arguments: ['wait', '--session', sessionId,
          '--after-phase', state.phase, '--timeout-seconds', '30'] } } : {}) };
    }
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
}

export function withSessionContinuation(state) {
  // Reusing a live start can return an input phase as well as "starting".
  // Completed operations need no more observation; a fresh wait is only a
  // continuation of the same exact procedure, never permission to restart it.
  requireThat(state?.sessionId && /^[a-z][a-z_]{0,63}$/.test(state.phase || ''), 'local_state_invalid');
  if (COMPLETE.has(state.phase)) return state;
  return { ...state, continuation: { arguments: ['wait', '--session', state.sessionId,
    '--after-phase', state.phase, '--timeout-seconds', '30'] } };
}

// A configured/forgotten receipt describes a completed operation, not a live
// browser. Cleanup must retain that result. Former active phases remain closed
// after guardian exit; an error always takes precedence over a success label.
export function finishedReceiptPhase(receipt, sessionId) {
  return receipt?.sessionId === sessionId && !receipt.error &&
    ['configured', 'forgotten', 'authorized'].includes(receipt.phase) ? receipt.phase : 'closed';
}
