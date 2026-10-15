import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reportInstructionBudget } from './report-instruction-budget.mjs';

test('audit reports all instruction sources, exact UTF-8 overflow and no source text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-size-audit-'));
  try {
    for (const [name, text] of [['exact', 'я'.repeat(8192)], ['large', '😀'.repeat(4097)]]) {
      await fs.mkdir(path.join(root, name));
      await fs.writeFile(path.join(root, name, 'SKILL.md'), ` ${text}\n`);
    }
    await fs.mkdir(path.join(root, 'tools'));
    const result = await reportInstructionBudget(root);
    assert.deepEqual(result.map(row => [row.skillId, row.instructionBytes, row.exceedsLimit]),
      [['exact', 16384, false], ['large', 16388, true]]);
    assert.doesNotMatch(JSON.stringify(result), /😀|яяя/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
