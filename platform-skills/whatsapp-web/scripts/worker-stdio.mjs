// This module must be the worker's first import, before loading any provider
// dependency. stdout is a native guardian protocol, not a diagnostic stream:
// libsignal's console.log can otherwise terminate the lease and print keys.
// Keep the original writer private and discard diagnostics without formatting
// their arguments. Do not redirect them to stderr or a persistent log.
const writeProtocol = process.stdout.write.bind(process.stdout);
// SDK media preparation may create short-lived files for encryption or
// thumbnailing. POSIX children inherit this restrictive mode from the worker;
// no provider-created temporary file should use the caller's broader umask.
if (process.platform !== 'win32') process.umask(0o077);
const discard = (_chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') queueMicrotask(done);
  return true;
};
process.stdout.write = discard;
process.stderr.write = discard;
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert']) {
  console[method] = () => {};
}

// Only fixed, value-free permit/ownership fields may use the saved writer.
// A dependency cannot accidentally serialize its own object onto the pipe.
export function guardianRequest(op, id, pid) {
  if (!Number.isSafeInteger(id) || id < 1 || !['permit', 'own', 'own-profile'].includes(op) ||
      (op !== 'permit' && (!Number.isSafeInteger(pid) || pid < 1))) {
    throw new Error('guardian_request_invalid');
  }
  writeProtocol(`${JSON.stringify(op !== 'permit' ? { op, id, pid } : { op, id })}\n`);
}
