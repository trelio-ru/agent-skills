import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { instructionEnvelopeFixtureBytes, reportInstructionBudget } from './report-instruction-budget.mjs';

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

test('full envelope budget is independent of instruction bytes and never reads build outputs or release input', () => {
  const instructions = 'a'.repeat(15000);
  const definition = { release: { skillId: 'fixture' }, runtime: {
    version: '1.0.0', entrypoint: { path: 'runtime.mjs', interpreter: 'node' }, capabilities: [],
    files: Array.from({ length: 30 }, (_, i) => ({ sourceEnvironment: 'NOT_AVAILABLE', path: `part-${i}.mjs`, mode: 420 })),
  } };
  assert.ok(Buffer.byteLength(instructions) < 16384);
  assert.ok(instructionEnvelopeFixtureBytes(instructions, definition) > 40000);
  assert.ok(instructionEnvelopeFixtureBytes('small', definition) < 40000);
});


test('catalog presentation is excluded from the model envelope without changing instruction content', () => {
  const instruction = '---\nname: fixture\ndescription: Technical discovery\n---\n\n# Actual instructions';
  const source = instruction.replace('\n---\n', '\nmetadata:\n  catalog_title: Human title\n  catalog_description: Human description\n---\n');
  assert.equal(instructionEnvelopeFixtureBytes(source), instructionEnvelopeFixtureBytes(instruction));
});
