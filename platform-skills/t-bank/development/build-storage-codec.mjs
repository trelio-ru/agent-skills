import fs from 'node:fs/promises';

// Both providers deliberately use one reviewed Playwright 1.60 source. Build
// the canonical artifact first, then derive the bank copy deterministically;
// release packages contain all runtime files and need no sibling provider.
await import('../../gosuslugi/development/build-storage-codec.mjs');
for (const name of ['storage-codec.mjs', 'playwright-storage-LICENSE.txt']) {
  let expected = (await fs.readFile(new URL(`../../gosuslugi/scripts/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  if (name === 'storage-codec.mjs') expected = expected.replace('and development/vendor/playwright.', 'and ../../gosuslugi/development/vendor/playwright.');
  const target = new URL(`../scripts/${name}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if ((await fs.readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== expected) throw Error('storage_codec_rebuild_required');
  } else await fs.writeFile(target, expected);
}
