import { stripAgentSkillCatalogMetadata } from "./skill-source-metadata.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACKAGE_FORMAT, validateBrowserSessionDefinition } from './build-runtime-package.mjs';

export const INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Descriptor-only fixture: inventory hashes have fixed width and a conservative
 * nine-digit file size. No source/build output, release input or credential is
 * needed. This deliberately includes text-compatible JSON duplication plus a
 * 4 KiB context allowance; it does not replace the live final-envelope guard.
 */
export const instructionEnvelopeFixtureBytes = (instructions, definition = null) => {
  instructions = stripAgentSkillCatalogMetadata(instructions);
  const descriptor = definition?.runtime;
  const runtime = descriptor ? {
    format: PACKAGE_FORMAT,
    skill: { id: definition.release.skillId, runtimeVersion: descriptor.version },
    entrypoint: descriptor.entrypoint, capabilities: descriptor.capabilities,
    ...(descriptor.browserSession ? { browserSession: validateBrowserSessionDefinition(
      descriptor.browserSession, descriptor.capabilities) } : {}),
    files: descriptor.files.map(file => ({ path: file.path, mode: file.mode,
      sha256: '0'.repeat(64), sizeBytes: 268435456 })),
  } : undefined;
  const data = { instructions, runtime, context: 'x'.repeat(4096) };
  return Buffer.byteLength(JSON.stringify({ structuredContent: data,
    content: [{ type: 'text', text: JSON.stringify(data) }] }));
};

/** Read only instruction sizes; never copy provider text into the report. */
export const reportInstructionBudget = async (root, { skillIds } = {}) => {
  const rows = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (skillIds && !skillIds.includes(entry.name)) continue;
    let text;
    try { text = await fs.readFile(path.join(root, entry.name, 'SKILL.md'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const bytes = Buffer.byteLength(stripAgentSkillCatalogMetadata(text).trim(), 'utf8');
    let definition = null;
    try { definition = JSON.parse(await fs.readFile(path.join(root, entry.name, 'release.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const envelopeFixtureBytes = instructionEnvelopeFixtureBytes(text, definition);
    rows.push({ skillId: entry.name, instructionBytes: bytes,
      maximumBytes: INSTRUCTIONS_MAX_BYTES, exceedsLimit: bytes > INSTRUCTIONS_MAX_BYTES,
      envelopeFixtureBytes, envelopeFixtureExceedsLimit: envelopeFixtureBytes > 40000 });
  }
  return rows.sort((a, b) => a.skillId.localeCompare(b.skillId, 'en'));
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rows = await reportInstructionBudget(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(JSON.stringify({ inspected: rows.length, oversized: rows.filter(row => row.exceedsLimit).length,
    envelopeFixtureOverflows: rows.filter(row => row.envelopeFixtureExceedsLimit).length, rows }, null, 2) + '\n');
  if (process.argv.includes('--strict') && rows.some(row => row.exceedsLimit || row.envelopeFixtureExceedsLimit)) process.exitCode = 1;
}
