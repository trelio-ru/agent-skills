import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseRange } from './editor-data.mjs';

const MAX_PART_BYTES = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = () => { throw new Error('EDITORS_OFFICE_EXPORT_INVALID'); };

/** Read a few fixed OOXML parts in memory. The host has already checked
 * the archive and the caller checked the original receipt, digest and type.
 * Do not materialize entries on disk or follow relationships outside OOXML. */
function parts(archive) {
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65_557); end -= 1) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  if (end < Math.max(0, archive.length - 65_557) || archive.readUInt32LE(end + 4) !== 0) fail();
  const count = archive.readUInt16LE(end + 10);
  const start = archive.readUInt32LE(end + 16);
  if (count > 5000 || archive.readUInt16LE(end + 8) !== count || start + archive.readUInt32LE(end + 12) !== end) fail();
  const entries = new Map();
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) fail();
    const nameLength = archive.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
    if (!nameLength || next > end) fail();
    const name = utf8.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    if (entries.has(name)) fail();
    entries.set(name, {
      flags: archive.readUInt16LE(cursor + 8),
      method: archive.readUInt16LE(cursor + 10),
      compressed: archive.readUInt32LE(cursor + 20),
      bytes: archive.readUInt32LE(cursor + 24),
      at: archive.readUInt32LE(cursor + 42),
    });
    cursor = next;
  }
  if (cursor !== end) fail();
  return function read(name) {
    const entry = entries.get(name);
    if (!entry || (entry.flags & 1) || ![0, 8].includes(entry.method) || entry.bytes > MAX_PART_BYTES
        || entry.at + 30 > start || archive.readUInt32LE(entry.at) !== 0x04034b50) fail();
    const pathLength = archive.readUInt16LE(entry.at + 26);
    const pathEnd = entry.at + 30 + pathLength;
    const data = pathEnd + archive.readUInt16LE(entry.at + 28);
    if (data + entry.compressed > start || utf8.decode(archive.subarray(entry.at + 30, pathEnd)) !== name) fail();
    const compressed = archive.subarray(data, data + entry.compressed);
    const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_PART_BYTES });
    if (bytes.length !== entry.bytes) fail();
    const xml = utf8.decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/u.test(xml) || xml.includes('\0')) fail();
    return xml;
  };
}

function decodeXml(text) {
  const entities = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
  return text.replace(/&([^;]{1,16});/gu, (_, code) => {
    if (Object.hasOwn(entities, code)) return entities[code];
    const decimal = /^#(\d{1,8})$/u.exec(code);
    const hex = /^#x([\da-f]{1,6})$/iu.exec(code);
    const value = decimal ? Number(decimal[1]) : hex ? parseInt(hex[1], 16) : 0;
    if (value < 1 || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) fail();
    return String.fromCodePoint(value);
  });
}

function attributes(tag) {
  const values = Object.create(null);
  for (const [, name, quoted] of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/gu)) {
    if (Object.hasOwn(values, name)) fail();
    values[name] = decodeXml(quoted.slice(1, -1));
  }
  return values;
}

export function selectExportedFormulas(archive, sheetName, range) {
  const read = parts(archive);
  const bounds = parseRange(range);
  const sheets = [...read('xl/workbook.xml').matchAll(/<sheet(?:\s+([^<>]+))?\/?>/gu)].map(match => attributes(match[1] || ''));
  const matching = sheets.filter(sheet => sheet.name === sheetName && sheet['r:id']);
  if (matching.length !== 1) fail();
  const links = [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s+([^<>]+)\/?>/gu)]
    .map(match => attributes(match[1])).filter(link => link.Id === matching[0]['r:id'] && link.Type?.endsWith('/worksheet') && !link.TargetMode);
  if (links.length !== 1 || !/^\/?(?:xl\/)?worksheets\/sheet[1-9]\d*\.xml$/u.test(links[0].Target)) fail();
  const target = links[0].Target.replace(/^\//u, '');
  const xml = read(target.startsWith('xl/') ? target : posix.join('xl', target));

  const cells = [];
  const seen = new Set();
  for (const [, attr, content] of xml.matchAll(/<c(?=\s|>)([^<>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
    const { r: address } = attributes(attr);
    if (!/^[A-Z]{1,3}[1-9]\d{0,7}$/u.test(address || '')) fail();
    const { startColumn: column, startRow: row } = parseRange(address);
    if (row < bounds.startRow || row > bounds.endRow || column < bounds.startColumn || column > bounds.endColumn) continue;
    if (seen.has(address)) fail();
    seen.add(address);
    const formulas = [...(content || '').matchAll(/<f(?=\s|>)([^<>]*?)(?:\/>|>([^<>]*)<\/f>)/gu)];
    if (formulas.length > 1) fail();
    if (!formulas.length) continue;
    // Excel can leave a shared follower without its own formula text. Its
    // presence is evidence of a formula; only actual exported text is shown.
    const text = formulas[0][2];
    cells.push({ cell: address, formula: text ? '=' + decodeXml(text) : null });
  }
  if (Buffer.byteLength(JSON.stringify(cells)) > 14_000) throw new Error('EDITORS_RESULT_TOO_LARGE');
  return { cells, complete: cells.every(cell => cell.formula !== null), representation: 'xlsx_formulas' };
}

export function selectExportedHeadings(archive) {
  const xml = parts(archive)('word/document.xml');
  const headings = [];
  let paragraph = 0;
  let bytes = 2;
  for (const [, body] of xml.matchAll(/<w:p(?=\s|>)[^<>]*>([\s\S]*?)<\/w:p>/gu)) {
    paragraph += 1;
    const style = /<w:pStyle\s+([^<>]+)\/?>/u.exec(body);
    const level = style && /^Heading([1-9])$/u.exec(attributes(style[1])['w:val'] || '');
    if (!level) continue;
    const text = [...body.matchAll(/<w:t(?=\s|>)[^<>]*>([^<>]*)<\/w:t>/gu)].map(match => decodeXml(match[1])).join('');
    const entry = { level: Number(level[1]), text, paragraph };
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (headings.length >= 200 || bytes > 12_000) return { headings, complete: false, representation: 'docx_heading_styles' };
    headings.push(entry);
  }
  return { headings, complete: true, representation: 'docx_heading_styles' };
}
