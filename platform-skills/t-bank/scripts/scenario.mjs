import { requireThat, RuntimeError } from './core.mjs';

export const MAX_SCRIPT_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_LOG_BYTES = 8 * 1024;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * The file is an ordinary async JavaScript body, not a browser-action DSL.
 * Its arguments are the actual Playwright objects. This is deliberately NOT
 * a sandbox or a read-only proxy: the agent must follow the user's authority.
 * Compile before handing over the context so a syntax error has no browser
 * effect. Do not include source or an engine's error text in public errors.
 */
export function compileScenario(source) {
  requireThat(typeof source === 'string' && source.trim().length > 0 &&
    Buffer.byteLength(source) <= MAX_SCRIPT_BYTES && !source.includes('\0'), 'script_input_invalid');
  try { return new AsyncFunction('context', 'page', 'console', `"use strict";\n${source}`); }
  catch { throw new RuntimeError('script_syntax_invalid'); }
}

/**
 * Console output must never enter stdout: that pipe belongs to the native
 * guardian protocol. Return bounded, redacted JSON instead. There is no
 * arbitrary object inspector and no automatic dump of a Playwright error,
 * which can contain a private URL, selector, request or form value.
 */
export async function executeScenario(compiled, { context, page }, redact = value => value) {
  const logs = []; let logBytes = 0, logsTruncated = false;
  const record = (...values) => {
    for (const value of values) {
      let text;
      try { text = typeof value === 'string' ? value : JSON.stringify(value); }
      catch { text = '[non-JSON value]'; }
      text = redact(String(text ?? 'undefined'));
      const remaining = MAX_LOG_BYTES - logBytes;
      if (logs.length >= 200 || Buffer.byteLength(text) > remaining) { logsTruncated = true; continue; }
      logs.push(text); logBytes += Buffer.byteLength(text);
    }
  };
  const output = Object.freeze({ log: record, info: record, warn: record, error: record, debug: record });
  let value;
  try { value = await compiled(context, page, output); }
  catch { throw new RuntimeError('script_result_unknown'); }
  let serialized;
  try { serialized = JSON.stringify({ ok: true, result: value ?? null, logs, logsTruncated }); }
  catch { throw new RuntimeError('script_result_not_json'); }
  requireThat(Buffer.byteLength(serialized) <= MAX_RESULT_BYTES, 'script_result_too_large');
  // Redact strings and object keys rather than the encoded JSON, so quotes
  // and escapes in a saved password cannot defeat exact-value removal.
  const clean = item => typeof item === 'string' ? redact(item)
    : Array.isArray(item) ? item.map(clean)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([name, value]) => [redact(name), clean(value)]))
    : item;
  let result;
  try {
    const parsed = JSON.parse(serialized);
    result = { ok: true, result: clean(parsed.result), logs: parsed.logs, logsTruncated: parsed.logsTruncated };
  }
  catch { throw new RuntimeError('script_result_not_json'); }
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES, 'script_result_too_large');
  return result;
}
