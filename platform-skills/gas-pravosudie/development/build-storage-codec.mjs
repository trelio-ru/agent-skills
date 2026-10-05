import fs from 'node:fs/promises';

// ГАС uses the same reviewed Playwright 1.60 serializer as Госуслуги and
// Т-Банк. Build the canonical source first, then derive a byte-stable provider
// copy; the release package still contains every runtime file it needs.
await import('../../gosuslugi/development/build-storage-codec.mjs');
for (const name of ['storage-codec.mjs', 'playwright-storage-LICENSE.txt']) {
  let expected = (await fs.readFile(new URL(`../../gosuslugi/scripts/${name}`, import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  if (name === 'storage-codec.mjs') {
    expected = expected.replace(
      'and development/vendor/playwright.',
      'and ../../gosuslugi/development/vendor/playwright.',
    );
  }
  const target = new URL(`../scripts/${name}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if ((await fs.readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== expected) {
      throw new Error('storage_codec_rebuild_required');
    }
  } else await fs.writeFile(target, expected);
}
