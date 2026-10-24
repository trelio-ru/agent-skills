// Only protocol enums and bounded counters cross the worker/CLI boundary.
// Never stringify an SDK exception: Boom.data can contain packets, auth data,
// URLs and account identifiers. A missing observation stays unknown.
const REASONS = new Map([
  [401, ['logged_out', 'authentication', 'relink_after_confirmation']],
  [403, ['forbidden', 'provider', 'inspect_provider_access']],
  [408, ['connection_lost_or_timed_out', 'transport', 'check_network_then_retry']],
  [411, ['multidevice_mismatch', 'protocol', 'inspect_client_compatibility']],
  [428, ['connection_closed', 'transport', 'check_network_then_retry']],
  [440, ['connection_replaced', 'conflict', 'stop_duplicate_connection']],
  [500, ['bad_session', 'session', 'inspect_session_without_reset']],
  [503, ['service_unavailable', 'provider', 'wait_for_provider']],
  [515, ['restart_required', 'protocol', 'inspect_client_compatibility']],
]);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
const STAGES = new Set(['connecting', 'qr_required', 'qr_refreshing', 'ready', 'reconnecting',
  'disconnected', 'relink_required', 'failed', 'closed']);
const boundedInt = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

export function disconnectEvidence(error) {
  const raw = error?.output?.statusCode;
  const statusCode = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  // Inspect only the SDK's known error wrappers, to a fixed depth. No recursive
  // packet walking, provider message matching or arbitrary errno projection.
  const transportCode = [error?.code, error?.cause?.code, error?.data?.code, error?.data?.cause?.code]
    .find(code => typeof code === 'string' && NETWORK_CODES.has(code)) ?? null;
  const [reason, category, nextAction] = transportCode ? ['transport_error', 'transport', 'check_network_then_retry']
    : REASONS.get(statusCode) || ['unknown', 'unknown', 'inspect_client_diagnostics'];
  return { statusCode, reason, category, transportCode, nextAction };
}

function failureView(value) {
  if (!value || !timestamp(value.observedAt) || !boundedInt(value.attempt, 10000) ||
      !boundedInt(value.retryDelayMs, 60000) || typeof value.willRetry !== 'boolean' ||
      !['connection', 'initialization', 'operation'].includes(value.source)) return null;
  const expected = disconnectEvidence({ output: { statusCode: value.statusCode }, code: value.transportCode });
  // Recompute meaning and advice from trusted enums even for a local receipt.
  // Caller-supplied reason/action/message fields are deliberately ignored.
  return { ...expected, source: value.source, observedAt: value.observedAt, attempt: value.attempt,
    willRetry: value.willRetry, retryDelayMs: value.willRetry ? value.retryDelayMs : 0 };
}

export function connectionDiagnosticsView(value) {
  if (value?.schemaVersion !== 1 || !STAGES.has(value.stage) ||
      !boundedInt(value.attempts, 10000) || !boundedInt(value.reconnectAttempts, 3) ||
      typeof value.pairingRestartUsed !== 'boolean') return null;
  const failures = Array.isArray(value.recentFailures) ? value.recentFailures.slice(-5).map(failureView).filter(Boolean) : [];
  return { schemaVersion: 1, stage: value.stage, attempts: value.attempts,
    reconnectAttempts: value.reconnectAttempts, maxReconnectAttempts: 3,
    pairingRestartUsed: value.pairingRestartUsed, everConnected: value.everConnected === true,
    lastConnectedAt: timestamp(value.lastConnectedAt) ? value.lastConnectedAt : null,
    lastFailure: failures.at(-1) ?? null, recentFailures: failures };
}

export function connectionDiagnosticsFields(value) {
  const diagnostic = connectionDiagnosticsView(value?.connectionDiagnostics);
  return diagnostic ? { connectionDiagnostics: diagnostic } : {};
}

export function connectionRequiredAction(value) {
  if (!['disconnected', 'relink_required'].includes(value?.stage)) return null;
  const action = value.lastFailure?.nextAction;
  return ({
    relink_after_confirmation: 'WhatsApp отозвал привязку (401). Новый вход – только после явного решения владельца.',
    inspect_provider_access: 'WhatsApp запретил соединение (403). Проверьте доступ у провайдера; сброс привязки не выполняйте.',
    check_network_then_retry: 'Проверьте сеть и доступность WhatsApp. Ограниченное восстановление завершено; привязка сохранена.',
    inspect_client_compatibility: 'Проверьте совместимость клиента с протоколом WhatsApp. Привязка сохранена.',
    stop_duplicate_connection: 'WhatsApp заменил соединение другим клиентом (440). Сначала остановите дублирующее подключение.',
    inspect_session_without_reset: 'WhatsApp вернул bad_session (500). Нужна проверка клиента и сессии без удаления привязки.',
    wait_for_provider: 'WhatsApp временно недоступен (503). Повторите подключение позже; привязка сохранена.',
    inspect_client_diagnostics: 'Причина разрыва не распознана. Сохраните connectionDiagnostics для проверки клиента; привязка сохранена.',
  })[action] || null;
}

export class ConnectionDiagnostics {
  constructor() {
    this.value = { schemaVersion: 1, stage: 'connecting', attempts: 0, reconnectAttempts: 0,
      pairingRestartUsed: false, everConnected: false, lastConnectedAt: null, recentFailures: [] };
  }
  connecting() { this.value.attempts++; this.value.stage = 'connecting'; }
  phase(stage) {
    if (STAGES.has(stage)) this.value.stage = stage;
    if (stage === 'ready') { this.value.everConnected = true; this.value.lastConnectedAt = new Date().toISOString(); }
  }
  disconnected(error, { willRetry, retryDelayMs, reconnectAttempts, pairingRestartUsed }, source = 'connection') {
    const evidence = { ...disconnectEvidence(error), source, observedAt: new Date().toISOString(),
      attempt: this.value.attempts, willRetry, retryDelayMs };
    this.value.reconnectAttempts = reconnectAttempts;
    this.value.pairingRestartUsed = pairingRestartUsed;
    this.value.recentFailures = [...this.value.recentFailures, evidence].slice(-5);
    return evidence;
  }
  failed(error, source = 'operation') {
    this.disconnected(error, { willRetry: false, retryDelayMs: 0,
      reconnectAttempts: this.value.reconnectAttempts, pairingRestartUsed: this.value.pairingRestartUsed }, source);
    this.phase('failed');
  }
  snapshot() { return connectionDiagnosticsView(this.value); }
}
