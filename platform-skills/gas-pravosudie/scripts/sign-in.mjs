import { requireThat, RuntimeError, serviceHttpFailure } from './core.mjs';

export const AUTHORIZATION_FAILURE_ACTION = 'Попытка входа завершена с ошибкой. Проверьте её код и фактический результат; новый вход запускайте отдельным prepare-sign-in --confirm в той же сессии. Не повторяйте вход автоматически.';

// The browser adapter owns the helper, while the worker owns the public phase.
// Keep their transitions together: a consumed helper must never leave status
// asking the caller to authorize an opaque request that no longer exists.
export async function prepareCourtSignIn(portal, { phase, client, requestTitle, setPhase }) {
  requireThat(['ready', 'authorization_failed'].includes(phase), 'session_not_ready');
  try {
    if (phase === 'authorization_failed') await portal.recoverSignInPage();
    const result = await portal.prepareSignIn(client, requestTitle);
    await setPhase('authorization_required');
    return result;
  } catch (error) {
    // A preparation failure can follow a dispatched login click. Record it,
    // but do not create another helper or navigate as part of error handling.
    if (!portal.authorization) await setPhase('authorization_failed', safeError(error), serviceHttpFailure(error));
    throw error;
  }
}

export async function resumeCourtSignIn(portal, { phase, setPhase, save }) {
  requireThat(['authorization_required', 'authorization_pending'].includes(phase), 'authorization_not_started');
  let result;
  try {
    result = await portal.resumeSignIn();
  } catch (error) {
    // Pending authorization retains its helper and native deadline. Only a
    // terminal attempt which actually released the helper becomes retryable;
    // raw exceptions are reduced to the same safe code as the worker response.
    if (!portal.authorization) await setPhase('authorization_failed', safeError(error), serviceHttpFailure(error));
    throw error;
  }
  if (result.phase === 'ready') {
    // The callback has already succeeded. A later encrypted-snapshot failure
    // must not pretend the old request is still waiting or suggest logging in
    // again: the existing court context remains available for a fresh read.
    await setPhase('ready');
    await save(await portal.storage());
  } else await setPhase('authorization_pending');
  return result;
}

const safeError = error => error instanceof RuntimeError ? error.code : 'operation_result_unknown';
