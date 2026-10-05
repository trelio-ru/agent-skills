import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, requireThat } from './core.mjs';

export const MEDIA_LIMITS = Object.freeze({ document: 64, image: 16, video: 64, audio: 16, voice: 16, sticker: 1 });
const starts = (bytes, signature) => bytes.subarray(0, signature.length).equals(Buffer.from(signature));

// This is a format check, not an encoder. Never relabel arbitrary data as a
// voice note or a sticker; callers convert it explicitly with an appropriate
// local tool before submitting the file. No URL fetch or shell is exposed.
export function checkMedia(bytes, type, mime) {
  if (type === 'document') return;
  const jpeg = starts(bytes, [0xff,0xd8,0xff]), png = starts(bytes, [137,80,78,71,13,10,26,10]);
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const mp4 = bytes.toString('ascii', 4, 8) === 'ftyp', ogg = bytes.toString('ascii', 0, 4) === 'OggS';
  const mp3 = bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  const wav = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  const valid = type === 'image' ? mime === 'image/jpeg' && jpeg || mime === 'image/png' && png || mime === 'image/webp' && webp
    : type === 'video' ? mime === 'video/mp4' && mp4
    : type === 'sticker' ? mime === 'image/webp' && webp
    : type === 'voice' ? /^audio\/ogg(?:;\s*codecs=opus)?$/.test(mime) && ogg && bytes.subarray(0, 256).includes(Buffer.from('OpusHead'))
    : type === 'audio' && (mime === 'audio/mpeg' && mp3 || mime === 'audio/mp4' && mp4 || /^audio\/ogg(?:;\s*codecs=opus)?$/.test(mime) && ogg || mime === 'audio/wav' && wav);
  requireThat(valid, 'media_format_mismatch');
}

export async function prepareMedia(packet) {
  const type = packet.mediaType || (packet.contact ? 'contact' : 'document');
  if (packet.contact || type === 'contact') {
    requireThat(packet.command === 'send' && packet.contact && !packet.file && !packet.text && type === 'contact', 'contact_payload_invalid');
    const escape = value => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
    const { name, phone } = packet.contact;
    const vcard = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${escape(name)}\r\nTEL;TYPE=CELL:${phone}\r\nEND:VCARD`;
    return { type, hash: digest(vcard), content: { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } } };
  }
  if (!packet.file) { requireThat(!packet.mediaType, 'media_file_required'); return null; }
  requireThat(packet.command === 'send' && path.isAbsolute(packet.file) && packet.mimeType && packet.fileName, 'file_metadata_required');
  requireThat(Object.hasOwn(MEDIA_LIMITS, type) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*codecs=opus)?$/.test(packet.mimeType), 'media_type_invalid');
  requireThat(!/[\/\\\r\n]/.test(packet.fileName), 'file_name_invalid');
  const handle = await fs.open(packet.file, 'r'); let bytes;
  try {
    const before = await fs.lstat(packet.file), stat = await handle.stat();
    requireThat(before.isFile() && !before.isSymbolicLink() && stat.ino === before.ino && stat.dev === before.dev &&
      stat.size > 0 && stat.size <= MEDIA_LIMITS[type] * 1024 * 1024, 'file_invalid');
    bytes = await handle.readFile();
    requireThat(bytes.length === stat.size && bytes.length <= MEDIA_LIMITS[type] * 1024 * 1024, 'file_changed_during_read');
    checkMedia(bytes, type, packet.mimeType);
    const key = ['voice','audio'].includes(type) ? 'audio' : type;
    const content = { [key]: bytes, mimetype: packet.mimeType };
    if (['document','image','video'].includes(type)) content.caption = packet.text || '';
    else requireThat(!packet.text, 'media_caption_not_supported');
    if (type === 'document') content.fileName = packet.fileName;
    if (type === 'voice') content.ptt = true;
    return { type, bytes, hash: digest(bytes), content };
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await handle.close(); }
}
