import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditWindowsBootstrap, inspectPowerShellSource } from './check-windows-bootstrap.mjs';

const invocation = flags => `runPrivate(trustedExecutable, ['-NoProfile', '-NonInteractive', ${flags}'-File', packagedSource, directory]);`;
test('Restricted parent requires an explicit child Process override', () => {
  assert.deepEqual(inspectPowerShellSource(invocation("'-ExecutionPolicy', 'Bypass', ")), { invocations: 1, failures: [] });
  assert.ok(inspectPowerShellSource(invocation('')).failures.includes('missing_process_execution_policy'));
  assert.ok(inspectPowerShellSource(invocation("'-ExecutionPolicy', 'RemoteSigned', ")).failures.includes('missing_process_execution_policy'));
});
test('process override never authorizes persistent policy or PATH execution', () => {
  assert.deepEqual(inspectPowerShellSource('// No PowerShell credential serialization.'), { invocations: 0, failures: [] });
  assert.ok(inspectPowerShellSource('Set-ExecutionPolicy Bypass -Scope LocalMachine').failures.includes('persistent_policy_mutation'));
  assert.ok(inspectPowerShellSource(`spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fixedSource])`).failures.includes('untrusted_powershell_executable'));
  assert.ok(inspectPowerShellSource(`spawn(trusted, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', value])`).failures.includes('unreviewed_encoded_command'));
  assert.ok(inspectPowerShellSource('spawn(powershell, dynamicArgs)').failures.includes('unreviewed_powershell_entrypoint'));
});
test('every provider has a reviewable process-only Windows bootstrap', () => {
  const results = auditWindowsBootstrap(fileURLToPath(new URL('../', import.meta.url)));
  assert.ok(results.length > 0);
  assert.deepEqual(results.filter(result => result.failures.length), []);
});
