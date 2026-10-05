import test from 'node:test';
import assert from 'node:assert/strict';
test('MCP navigation/click require no stdin; form text uses bounded UTF-8 stdin', async () => {
  const { parseArguments, readPagePacket } = await import('../scripts/trelio-gosuslugi.mjs');
  const { PassThrough, Readable } = await import('node:stream');
  const target = 'https://pos.gosuslugi.ru/form/?opaId=223643&fz59=false';
  assert.equal(parseArguments(['page', '--navigate', target]).options['--navigate'], target);
  assert.equal(parseArguments(['page', '--click', '1:2']).options['--click'], '1:2');
  assert.throws(() => parseArguments(['page', '--navigate', target, '--click', '1:2']), /page_input_ambiguous/);
  assert.throws(() => parseArguments(['page', '--navigate', 'https://example.org/?code=secret']), /page_input_invalid/);
  const packet = { action: 'fill', ref: '1:2', text: 'Текст заявления' };
  // A multibyte character split between chunks must survive decoding.
  const bytes = Buffer.from(JSON.stringify(packet));
  assert.deepEqual(await readPagePacket(Readable.from([bytes.subarray(0,44), bytes.subarray(44)])), packet);
  await assert.rejects(readPagePacket(Readable.from([])), /page_input_required/);
  await assert.rejects(readPagePacket(new PassThrough(), 20), /page_input_required/);
  await assert.rejects(readPagePacket(Readable.from(['a'.repeat(16385)])), /input_too_large/);
});
