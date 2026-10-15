import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import test from 'node:test';
import { getInstructionGuides } from '../scripts/instruction-guides.mjs';
import { parseArguments, run } from '../scripts/trelio-gosuslugi.mjs';

const root = new URL('../', import.meta.url);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('short main instructions fit publication budget and all original safety sections survive verbatim', async () => {
  const main = await fs.readFile(new URL('SKILL.md', root), 'utf8');
  assert.ok(Buffer.byteLength(main.trim()) <= 16384);
  const map = JSON.parse(await fs.readFile(new URL('references/instruction-map.json', root), 'utf8'));
  const recovered = [];
  for (const section of map.sections) {
    const body = (await fs.readFile(new URL(section.file, root), 'utf8')).replace(/\r\n?/g, '\n');
    let exact = section.file === 'SKILL.md' ? body.split(/^## /m)[0] : body;
    for (const rewrite of section.relocatedLinks ?? []) exact = exact.replaceAll(rewrite.to, rewrite.from);
    exact += section.sourceSuffix ?? '';
    assert.equal(hash(exact), section.sha256, section.heading);
    assert.equal(Buffer.byteLength(exact), section.bytes, section.heading);
    recovered.push(exact);
  }
  assert.equal(hash(recovered.join('')), map.originalSha256);
  assert.match(main, /полностью прочитай документы/u);
  assert.match(main, /недоступен, обрезан/u);
});

test('guides work before identity, browser binding or native credential access', async () => {
  assert.deepEqual(parseArguments(['guides']), { command: 'guides', options: {} });
  assert.throws(() => parseArguments(['guides', '--input-file', '/private/file']));
  const result = await run(['guides']);
  assert.deepEqual(result, await getInstructionGuides());
  const manifest = JSON.parse(await fs.readFile(new URL('release.json', root), 'utf8'));
  for (const [name, guide] of Object.entries(result.guides)) {
    const bytes = await fs.readFile(guide.path);
    assert.equal(hash(bytes), guide.sha256, name);
    assert.equal(bytes.length, guide.sizeBytes, name);
    assert.ok(manifest.runtime.files.some(file => guide.path.endsWith('/' + file.path)), name);
  }
  assert.doesNotMatch(JSON.stringify(result), /token|password|cookie|authorization_code/iu);
});

test('ESIA, POS and Goskey remain separately gated scenarios with the original guards', async () => {
  const guides = (await getInstructionGuides()).guides;
  const read = name => fs.readFile(guides[name].path, 'utf8');
  const esia = await read('esia'), pos = await read('pos'), runtime = await read('runtime');
  assert.match(esia, /createEsiaAuthorization/u);
  assert.match(esia, /\*\*до\*\* нажатия штатной кнопки входа/u);
  assert.match(esia, /login\.authenticated/u);
  assert.match(pos, /автоматически создаёт обращение/u);
  assert.match(pos, /при неизвестном результате не повторяй/u);
  assert.match(runtime, /account_temporarily_blocked/u);
  assert.match(runtime, /https:\/\/www\.gosuslugi\.ru\/679557\/1\/form/u);
  assert.match(await read('goskey'), /настроенным ГОСТ-совместимым/u);
});
