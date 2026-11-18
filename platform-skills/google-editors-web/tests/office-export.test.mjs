import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { selectExportedFormulas, selectExportedHeadings } from '../scripts/office-export.mjs';

// Assemble minimal synthetic directory/local records with real raw Deflate.
// They contain only supplied XML and no identifiers, accounts or archive files.
function fixtureArchive(files) {
  const originals = [], central = [];
  let offset = 0;
  for (const [name, source] of Object.entries(files)) {
    const path = Buffer.from(name), xml = Buffer.from(source), compressed = deflateRawSync(xml);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(path.length, 26);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(xml.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    originals.push(local, path, compressed);
    central.push(entry, path);
    offset += local.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...originals, directory, end]);
}

test('exact workbook sheet relationship and physical range preserve exported formulas', () => {
  const files = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Parts &amp; stock" r:id="sheet1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="sheet1" Type="ooxml/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="A1"><f>1&lt;2</f></c><c r="A2"><f t="shared" si="2"/></c><c r="B2"><f>SUM(A1,A2)</f><v>3</v></c></row></sheetData></worksheet>',
  };
  assert.deepEqual(selectExportedFormulas(fixtureArchive(files), 'Parts & stock', 'A2:B2'), {
    cells: [{ cell: 'A2', formula: null }, { cell: 'B2', formula: '=SUM(A1,A2)' }],
    complete: false,
    representation: 'xlsx_formulas',
  });
  assert.throws(() => selectExportedFormulas(fixtureArchive(files), 'Other', 'A1'), /EDITORS_OFFICE_EXPORT_INVALID/u);
  files['xl/_rels/workbook.xml.rels'] = '<Relationships><Relationship Id="sheet1" Type="ooxml/worksheet" Target="../outside.xml"/></Relationships>';
  assert.throws(() => selectExportedFormulas(fixtureArchive(files), 'Parts & stock', 'A1'), /EDITORS_OFFICE_EXPORT_INVALID/u);
});

test('exported heading style joins styled runs without including ordinary paragraphs', () => {
  const archive = fixtureArchive({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Ordinary</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Stock &amp; </w:t></w:r><w:r><w:t>Prices</w:t></w:r></w:p></w:body></w:document>' });
  assert.deepEqual(selectExportedHeadings(archive), {
    headings: [{ level: 2, text: 'Stock & Prices', paragraph: 2 }], complete: true, representation: 'docx_heading_styles',
  });
  assert.throws(() => selectExportedHeadings(archive.subarray(0, -1)), /EDITORS_OFFICE_EXPORT_INVALID/u);
});
