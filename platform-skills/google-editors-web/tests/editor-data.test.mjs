import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRange, readTextExport, sliceCsv } from '../scripts/editor-data.mjs';

test('only one bounded, physical A1 range is admitted', () => {
  assert.deepEqual(parseRange('$aa$2:$AB$3'), { startColumn: 27, startRow: 2, endColumn: 28, endRow: 3 });
  for (const range of ['A0', 'A:A', 'A1:B', 'A2:A1', 'B1:A1', 'Data!A1', 'Ａ1', 'K1', 'A1,C2', 'A1:ZZZ1']) {
    assert.throws(() => parseRange(range), /EDITORS_RANGE_INVALID/u);
  }
});

test('CSV keeps sheet coordinates, empties, displayed strings and multiline cells', () => {
  const exported = 'A,B,C,D\r\n001,"line 1\r\nline 2, ""quoted""",,0\r\n\r\nFALSE,only two';
  assert.deepEqual(sliceCsv(exported, 'B2:E4'), [
    ['line 1\r\nline 2, "quoted"', '', '0', ''],
    ['', '', '', ''],
    ['only two', '', '', ''],
  ]);
  assert.deepEqual(sliceCsv(exported, 'A2'), [['001']]);
  for (const input of ['"unclosed', '"bad"literal', 'bare"quote', 'a\0b']) {
    assert.throws(() => sliceCsv(input, 'A1'), /EDITORS_CSV_INVALID/u);
  }
  // Validation applies to all exported input, even beyond the requested range.
  assert.throws(() => sliceCsv('ok\n"unclosed', 'A1'), /EDITORS_CSV_INVALID/u);
});

test('the original receipt is bound to the session, media and exact bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'editors-artifact-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.csv');
  const bytes = Buffer.from('first,second\nzero,0');
  await writeFile(path, bytes);
  const receipt = {
    kind: 'trelio.browser-file/v1', state: 'ready', mimeType: 'text/csv', sessionId: 'fixture',
    filePath: path, expiresAt: Date.now() + 60_000, sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assert.equal(await readTextExport(receipt, 'text/csv', 'fixture'), bytes.toString());
  await assert.rejects(readTextExport(receipt, 'text/plain', 'fixture'), /EDITORS_EXPORT_UNVERIFIED/u);
  await assert.rejects(readTextExport(receipt, 'text/csv', 'other'), /EDITORS_EXPORT_UNVERIFIED/u);
  await assert.rejects(readTextExport({ ...receipt, expiresAt: Date.now() - 1 }, 'text/csv', 'fixture'), /EDITORS_EXPORT_UNVERIFIED/u);
  await writeFile(path, Buffer.alloc(bytes.length, 0x61));
  await assert.rejects(readTextExport(receipt, 'text/csv', 'fixture'), /EDITORS_EXPORT_UNVERIFIED/u);
});
