import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Read only instruction sizes; never copy provider text into the report. */
export const reportInstructionBudget = async (root) => {
  const rows = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let text;
    try { text = await fs.readFile(path.join(root, entry.name, 'SKILL.md'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const bytes = Buffer.byteLength(text.trim(), 'utf8');
    rows.push({ skillId: entry.name, instructionBytes: bytes,
      maximumBytes: INSTRUCTIONS_MAX_BYTES, exceedsLimit: bytes > INSTRUCTIONS_MAX_BYTES });
  }
  return rows.sort((a, b) => a.skillId.localeCompare(b.skillId, 'en'));
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rows = await reportInstructionBudget(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(JSON.stringify({ inspected: rows.length, oversized: rows.filter(row => row.exceedsLimit).length, rows }, null, 2) + '\n');
  if (process.argv.includes('--strict') && rows.some(row => row.exceedsLimit)) process.exitCode = 1;
}
