import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_WORKSHEET_ROWS = 10_000_000;
const MAX_WORKSHEET_COLUMNS = 18_278;
const MAX_RETURNED_CELLS = 2_500;
const MAX_TEXT_EXPORT_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function columnNumber(letters) {
  return [...letters.toUpperCase()].reduce((column, letter) => column * 26 + letter.charCodeAt(0) - 64, 0);
}

/** A physical rectangle on one already verified sheet. Sheet names, open
 * ranges and unions would make the slice depend on UI state or implicit bounds. */
export function parseRange(value) {
  const match = typeof value === 'string' && /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7})(?::\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7}))?$/u.exec(value);
  if (!match || match[0] !== value) throw new Error('EDITORS_RANGE_INVALID');
  const startColumn = columnNumber(match[1]);
  const startRow = Number(match[2]);
  const endColumn = match[3] ? columnNumber(match[3]) : startColumn;
  const endRow = match[4] ? Number(match[4]) : startRow;
  if (endColumn < startColumn || endRow < startRow || endColumn > MAX_WORKSHEET_COLUMNS
      || endRow > MAX_WORKSHEET_ROWS || (endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_RETURNED_CELLS) {
    throw new Error('EDITORS_RANGE_INVALID');
  }
  return { startColumn, startRow, endColumn, endRow };
}

/** Consume only a fresh file receipt from the current host call. A local path
 * from a command argument never becomes an export. Check length and digest on
 * the same open regular file before interpreting any bytes. */
export async function readExportBytes(receipt, mimeType, sessionId, maximumBytes = MAX_TEXT_EXPORT_BYTES) {
  if (receipt?.kind !== 'trelio.browser-file/v1' || receipt.state !== 'ready'
      || typeof sessionId !== 'string' || receipt.sessionId !== sessionId || receipt.mimeType !== mimeType
      || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= Date.now()
      || !Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes < (mimeType === 'text/csv' ? 0 : 1) || receipt.sizeBytes > maximumBytes
      || !/^[a-f0-9]{64}$/u.test(receipt.sha256) || typeof receipt.filePath !== 'string' || !isAbsolute(receipt.filePath)) {
    throw new Error('EDITORS_EXPORT_UNVERIFIED');
  }
  const file = await open(receipt.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== receipt.sizeBytes) throw new Error('EDITORS_EXPORT_UNVERIFIED');
    const bytes = Buffer.alloc(receipt.sizeBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const original = bytes.subarray(0, offset);
    if (offset !== receipt.sizeBytes || createHash('sha256').update(original).digest('hex') !== receipt.sha256) {
      throw new Error('EDITORS_EXPORT_UNVERIFIED');
    }
    return original;
  } finally {
    await file.close();
  }
}

export async function readTextExport(receipt, mimeType, sessionId) {
  return utf8.decode(await readExportBytes(receipt, mimeType, sessionId));
}

/** Keep physical positions and cell text. In particular, embedded CR/LF,
 * quoted commas and leading zeroes must never move a subsequent cell. */
export function sliceCsv(text, range) {
  const { startColumn, startRow, endColumn, endRow } = parseRange(range);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_EXPORT_BYTES || text.includes('\0')) {
    throw new Error('EDITORS_CSV_INVALID');
  }
  const values = Array.from({ length: endRow - startRow + 1 }, () => Array(endColumn - startColumn + 1).fill(''));
  let row = 1;
  let column = 1;
  let cell = '';
  let mode = 'initial';

  function finishCell() {
    if (column > MAX_WORKSHEET_COLUMNS || row > MAX_WORKSHEET_ROWS) throw new Error('EDITORS_CSV_INVALID');
    if (row >= startRow && row <= endRow && column >= startColumn && column <= endColumn) {
      values[row - startRow][column - startColumn] = cell;
    }
    column += 1;
    cell = '';
    mode = 'initial';
  }

  for (let index = text.startsWith('\uFEFF') ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (mode === 'quoted') {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else mode = 'closed';
      continue;
    }
    if (character === ',') finishCell();
    else if (character === '\r' || character === '\n') {
      finishCell();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row += 1;
      column = 1;
    } else if (mode === 'initial' && character === '"') mode = 'quoted';
    else {
      if (character === '"' || mode === 'closed') throw new Error('EDITORS_CSV_INVALID');
      cell += character;
      mode = 'plain';
    }
  }
  if (mode === 'quoted') throw new Error('EDITORS_CSV_INVALID');
  if (mode !== 'initial' || column > 1) finishCell();
  return values;
}
