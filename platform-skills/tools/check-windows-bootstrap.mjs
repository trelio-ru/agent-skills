#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Audit explicit argv in every provider, including Python wrappers. Inspect
 * only literal switches: never evaluate the script/path expression following
 * -File or -Command. This regression guard is not a code sandbox; native tests
 * still establish owner/DACL behavior on Windows.
 */
export const inspectPowerShellSource = source => {
  const failures = new Set();
  let invocations = 0;
  for (const match of source.matchAll(/['"]-NoProfile['"]/giu)) {
    const opening = source.lastIndexOf('[', match.index);
    if (opening < 0) { failures.add('unreviewed_powershell_argv'); continue; }
    let prefix = source.slice(opening + 1);
    const options = [];
    while (true) {
      const token = /^\s*(['"])([^'"\r\n]*)\1\s*(?:,|\])/u.exec(prefix);
      if (!token) break;
      options.push(token[2].toLowerCase());
      prefix = prefix.slice(token[0].length);
      if (['-file', '-command', '-encodedcommand'].includes(options.at(-1))) break;
    }
    const mode = options.findIndex(value => ['-file', '-command', '-encodedcommand'].includes(value));
    const policy = options.indexOf('-executionpolicy');
    if (mode < 0 || !options.includes('-noprofile') || !options.includes('-noninteractive')) {
      failures.add('unreviewed_powershell_argv');
    } else {
      invocations++;
      if (policy < 0 || policy >= mode || options[policy + 1] !== 'bypass') failures.add('missing_process_execution_policy');
      if (options[mode] === '-encodedcommand') failures.add('unreviewed_encoded_command');
    }
  }
  // New entrypoints must expose a reviewable argument prefix, not silently
  // disappear from the inventory by moving options into dynamic input.
  if ((/\b(?:powershell|pwsh)\.exe\b/iu.test(source)
    || /(?:spawn|execFile)(?:Sync|Async)?\(\s*(?:powershell|pwsh)\b/iu.test(source))
    && !invocations) failures.add('unreviewed_powershell_entrypoint');
  if (/\bSet-ExecutionPolicy\b/iu.test(source)) failures.add('persistent_policy_mutation');
  if (/(?:execFile(?:Sync|Async)?|spawn(?:Sync)?|execSync)\(\s*['"](?:powershell|pwsh)(?:\.exe)?['"]/iu.test(source)) failures.add('untrusted_powershell_executable');
  return { invocations, failures: [...failures] };
};

export const auditWindowsBootstrap = skillsDirectory => {
  const results = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['tools', 'tests', 'node_modules', '__pycache__'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:mjs|js|py|ps1|cs)$/iu.test(entry.name) && !/\.test\./u.test(entry.name)) {
        const result = inspectPowerShellSource(fs.readFileSync(file, 'utf8'));
        if (result.invocations || result.failures.length) results.push({ path: path.relative(skillsDirectory, file).replaceAll('\\', '/'), ...result });
      }
    }
  };
  walk(skillsDirectory);
  return results;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const results = auditWindowsBootstrap(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
  const passed = results.every(result => !result.failures.length);
  process.stdout.write(`${JSON.stringify({ results, passed })}\n`);
  if (!passed) process.exitCode = 1;
}
