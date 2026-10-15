import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRuntimePackage } from './build-runtime-package.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Exercise the materialized artifact, not just source-relative documentation.
 * No real credentials, catalog identity, browser/OS helper or network is needed.
 * Python runs isolated, matching the signed host's module-discovery constraints.
 */
export function registerInstructionGuideContract(skillUrl) {
  const skill = fileURLToPath(skillUrl);
  test('signed instruction guides preserve the complete original and load before protected IO', () => {
    const main = fs.readFileSync(new URL('SKILL.md', skillUrl), 'utf8');
    assert.ok(Buffer.byteLength(main.trim()) <= 16384);
    assert.match(main, /полностью прочитай все части/u);
    assert.match(main, /недоступна, обрезана/u);
    const map = JSON.parse(fs.readFileSync(new URL('scripts/instruction-guides/map.json', skillUrl), 'utf8'));
    const original = map.sections.map(section => {
      let text = fs.readFileSync(new URL(`scripts/instruction-guides/${section.file}`, skillUrl), 'utf8').replace(/\r\n?/g, '\n');
      for (const rewrite of section.relocatedLinks) text = text.replaceAll(`](${rewrite.to})`, `](${rewrite.from})`);
      text += section.sourceSuffix ?? "";
      assert.equal(hash(text), section.sha256, section.file);
      assert.equal(Buffer.byteLength(text), section.bytes);
      return text;
    }).join('');
    assert.equal(hash(original), map.originalSha256);
    const options = { environment: { TRELIO_TELEGRAM_APP_CREDENTIAL_JSON:
      JSON.stringify({ api_id: '12345', api_hash: 'a'.repeat(32) }) } };
    const built = buildRuntimePackage(skill, options);
    assert.deepEqual(buildRuntimePackage(skill, options).packageBytes, built.packageBytes);
    const artifact = JSON.parse(built.packageBytes);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-guide-contract-'));
    try {
      const packageRoot = path.join(fs.realpathSync(temporary), 'package');
      for (const item of artifact.files) {
        const location = path.join(packageRoot, item.path);
        fs.mkdirSync(path.dirname(location), { recursive: true });
        fs.writeFileSync(location, Buffer.from(item.contentBase64, 'base64'));
      }
      const manifest = JSON.parse(fs.readFileSync(new URL('release.json', skillUrl), 'utf8'));
      const entry = manifest.runtime.entrypoint;
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const executable = entry.interpreter === 'python' ? python : process.execPath;
      const prefix = entry.interpreter === 'python' ? ['-I', '-B'] : [];
      const run = args => spawnSync(executable, [...prefix, path.join(packageRoot, entry.path), ...args], {
        cwd: temporary, encoding: 'utf8', timeout: 15000,
        // No inherited TRELIO/PYTHONPATH/credential/session environment. PATH
        // locates Actions Python; SystemRoot is necessary for Windows startup.
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: temporary,
          USERPROFILE: temporary, PYTHONIOENCODING: 'ascii' },
      });
      const result = run(['guides']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const metadata = JSON.parse(result.stdout);
      assert.equal(metadata.requiredBeforeWork, 'all_in_order');
      assert.equal(metadata.guides.length, map.sections.length);
      for (const guide of metadata.guides) {
        assert.ok(guide.path.startsWith(packageRoot + path.sep));
        const bytes = fs.readFileSync(guide.path);
        assert.equal(hash(bytes), guide.sha256);
        assert.equal(bytes.length, guide.sizeBytes);
        assert.ok(bytes.length <= 16384);
      }
      assert.notEqual(run(['guides', '--input-file', path.join(temporary, 'forbidden')]).status, 0);
      assert.deepEqual(fs.readdirSync(temporary), ['package']);
      // Reproduce the actual double-serialization hazard with the candidate's
      // signed manifest inventory and an explicit 4 KiB context allowance.
      // This is a bounded offline fixture, not a live personal-layer audit.
      const data = { instructions: main, runtime: built.manifest, context: 'x'.repeat(4096) };
      const envelope = { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 40000);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}
