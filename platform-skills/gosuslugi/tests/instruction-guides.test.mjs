import { stripAgentSkillCatalogMetadata } from "../../tools/skill-source-metadata.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getInstructionGuides } from '../scripts/instruction-guides.mjs';
import { parseArguments, run } from '../scripts/trelio-gosuslugi.mjs';

const root = new URL('../', import.meta.url);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('short main instructions fit publication budget and the complete current contract matches its pinned map', async () => {
  // Catalog-only fields were never part of the pinned operational contract.
  // Reconstruct the same instruction projection used by publication, without
  // changing historical hashes or removing any original safety text.
  const main = stripAgentSkillCatalogMetadata(await fs.readFile(new URL('SKILL.md', root), 'utf8'));
  assert.ok(Buffer.byteLength(main.trim()) <= 16384);
  const map = JSON.parse(await fs.readFile(new URL('references/instruction-map.json', root), 'utf8'));
  const recovered = [];
  for (const section of map.sections) {
    const body = (await fs.readFile(new URL(section.file, root), 'utf8')).replace(/\r\n?/g, '\n');
    let exact = section.file === 'SKILL.md' ? stripAgentSkillCatalogMetadata(body).split(/^## /m)[0] : body;
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

test('all login guides reuse user authority for standard disclosure while preserving independent decisions', async () => {
  const guides = (await getInstructionGuides()).guides;
  for (const name of ['safety', 'runtime', 'esia']) {
    const text = (await fs.readFile(guides[name].path, 'utf8')).replace(/\s+/gu, ' ');
    assert.match(text, /[Сс]тандартное (?:разрешение|согласие) ЕСИА/u, name);
    assert.match(text, /(?:без повторного вопроса|повторного подтверждения|без повторного вопроса или ручного клика)/u, name);
    assert.match(text, /(?:[Дд]ругие согласия|неподдерживаемое|Неизвестные права)/u, name);
  }
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
    // Manifest paths are POSIX; the guide intentionally returns a native OS
    // path. Resolve the signed path before exact comparison on Windows/macOS.
    assert.ok(manifest.runtime.files.some(file => guide.path === fileURLToPath(new URL(file.path, root))), name);
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
