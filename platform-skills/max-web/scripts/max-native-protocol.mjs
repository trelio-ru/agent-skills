/**
 * Bounded observation of the SAME browser's public MAX wire protocol.
 *
 * This is not a second client: it never opens a socket, creates a request,
 * reads authentication storage, or returns raw packets. The provider's public
 * web client currently uses a ten-byte v10 header, an optional LZ4 block and
 * MessagePack. Only already selected history/receipt traffic is interpreted.
 * Unknown versions/shapes cannot establish sender identity or ACK authority.
 */
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';

const MAX_FRAME = 2 * 1024 * 1024;
const MAX_DECODED = 4 * 1024 * 1024;
const MAX_ROWS = 1000;
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => typeof value === 'bigint' ? value.toString()
  : Number.isSafeInteger(value) ? String(value) : null;
const nativeId = value => {
  const text = integer(value);
  return text && /^-?(?:0|[1-9]\d{0,38})$/u.test(text) ? text : null;
};
// MessagePack may use uint64 even for safely representable millisecond time.
// Keep IDs as decimal bigint strings, but compare time/ranges only after this
// exact bounded conversion; unsafe integers never gain rounded ACK authority.
const nativeTime = value => {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const failure = () => { throw new Error('MAX_NATIVE_PROTOCOL_UNAVAILABLE'); };
const canonical = value => {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!ownObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};

/** Standard LZ4 block decoding; every copy/allocation is bounded first. */
const decodeBlock = (input, capacity) => {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_DECODED) failure();
  const output = Buffer.alloc(capacity);
  let source = 0, target = 0;
  const length = initial => {
    let count = initial;
    if (initial === 15) {
      let byte;
      do {
        if (source >= input.length) failure();
        byte = input[source++]; count += byte;
        if (count > capacity) failure();
      } while (byte === 255);
    }
    return count;
  };
  while (source < input.length) {
    const token = input[source++], literals = length(token >>> 4);
    if (source + literals > input.length || target + literals > capacity) failure();
    input.copy(output, target, source, source + literals);
    source += literals; target += literals;
    if (source === input.length) return output.subarray(0, target);
    if (source + 2 > input.length) failure();
    const distance = input.readUInt16LE(source); source += 2;
    if (distance === 0 || distance > target) failure();
    const count = length(token & 15) + 4;
    if (target + count > capacity) failure();
    // LZ4 matches may overlap their own newly decoded bytes.
    for (let index = 0; index < count; index += 1) output[target + index] = output[target + index - distance];
    target += count;
  }
  failure();
};

/** Minimal standard MessagePack reader, with no eval/prototype assignment. */
const decodeMessagePack = input => {
  let offset = 0, items = 0;
  const bytes = count => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > input.length) failure();
    const result = input.subarray(offset, offset + count); offset += count; return result;
  };
  const unsigned = count => {
    const value = bytes(count);
    return count === 1 ? value[0] : count === 2 ? value.readUInt16BE() : value.readUInt32BE();
  };
  const text = count => {
    if (count > 256 * 1024) failure();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes(count));
  };
  const read = depth => {
    if (depth > 32 || ++items > 50_000) failure();
    const tag = unsigned(1);
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if ((tag & 0xe0) === 0xa0) return text(tag & 31);
    const array = count => {
      if (count > 10_000 || items + count > 50_000) failure();
      return Array.from({ length: count }, () => read(depth + 1));
    };
    const map = count => {
      if (count > 10_000 || items + count * 2 > 50_000) failure();
      const result = Object.create(null);
      for (let index = 0; index < count; index += 1) {
        const rawKey = read(depth + 1);
        const key = typeof rawKey === 'string' ? rawKey : integer(rawKey);
        if (key === null || Object.hasOwn(result, key)) failure();
        Object.defineProperty(result, key, { value: read(depth + 1), enumerable: true });
      }
      return result;
    };
    const extension = count => {
      if (unsigned(1) !== 1 || count < 1 || count > 32) failure();
      const value = decodeMessagePack(bytes(count));
      if (!['number', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value)) failure();
      return value;
    };
    if ((tag & 0xf0) === 0x90) return array(tag & 15);
    if ((tag & 0xf0) === 0x80) return map(tag & 15);
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: case 0xc5: case 0xc6: {
        const count = unsigned(2 ** (tag - 0xc4));
        if (count > MAX_FRAME) failure();
        return bytes(count);
      }
      case 0xca: { const value = bytes(4).readFloatBE(); if (!Number.isFinite(value)) failure(); return value; }
      case 0xcb: { const value = bytes(8).readDoubleBE(); if (!Number.isFinite(value)) failure(); return value; }
      case 0xcc: return unsigned(1);
      case 0xcd: return unsigned(2);
      case 0xce: return unsigned(4);
      case 0xcf: return bytes(8).readBigUInt64BE();
      case 0xd0: return bytes(1).readInt8();
      case 0xd1: return bytes(2).readInt16BE();
      case 0xd2: return bytes(4).readInt32BE();
      case 0xd3: return bytes(8).readBigInt64BE();
      case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: return extension(2 ** (tag - 0xd4));
      case 0xc7: return extension(unsigned(1));
      case 0xc8: return extension(unsigned(2));
      case 0xc9: return extension(unsigned(4));
      case 0xd9: return text(unsigned(1));
      case 0xda: return text(unsigned(2));
      case 0xdb: return text(unsigned(4));
      case 0xdc: return array(unsigned(2));
      case 0xdd: return array(unsigned(4));
      case 0xde: return map(unsigned(2));
      case 0xdf: return map(unsigned(4));
      default: failure();
    }
  };
  const result = read(0);
  if (offset !== input.length) failure();
  return result;
};

export const inspectMaxFrameHeader = frame => {
  if (!Buffer.isBuffer(frame) || frame.length < 10 || frame.length > MAX_FRAME || frame[0] !== 10) return null;
  const size = frame.readUIntBE(7, 3);
  if (size !== frame.length - 10 || frame[1] > 3) return null;
  return { cmd: frame[1], seq: frame.readInt16BE(2), opcode: frame.readInt16BE(4), compression: frame[6], size };
};

export const decodeMaxNativeFrame = frame => {
  const header = inspectMaxFrameHeader(frame);
  if (!header) failure();
  let input = frame.subarray(10);
  if (header.compression > 0) input = decodeBlock(input, header.size * header.compression);
  return { ...header, payload: input.length ? decodeMessagePack(input) : null };
};

/**
 * Only browser-originated requests are correlated with server responses. No
 * label, forwarded author or link target can populate a native sender slot.
 * The observer retains bounded structural/body hashes in invocation memory,
 * never tokens, authentication envelopes or packet archives.
 */
export const createMaxNativeObserver = () => {
  let viewerId = null, available = false, failed = false;
  const pending = new Map(), histories = new Map();
  const reset = () => { pending.clear(); histories.clear(); viewerId = null; available = false; };
  const observeOutbound = (frame, socket) => {
    const header = inspectMaxFrameHeader(frame);
    if (!header || header.cmd !== 0 || header.opcode !== 49) return;
    try {
      const { payload } = decodeMaxNativeFrame(frame), chatId = nativeId(payload?.chatId);
      if (!chatId || !Number.isInteger(payload.backward) || payload.backward < 1 || payload.backward > MAX_ROWS
        || payload.postId !== undefined || payload.getMessages === false || pending.size >= 100) return;
      pending.set(`${socket}:${header.seq}`, { chatId, backward: payload.backward, from: payload.from === -1n ? -1 : nativeTime(payload.from) ?? payload.from });
    } catch { failed = true; }
  };
  const observeInbound = (frame, socket) => {
    const header = inspectMaxFrameHeader(frame);
    if (!header || ![19, 49].includes(header.opcode) || header.cmd !== 1) return;
    try {
      const { payload } = decodeMaxNativeFrame(frame);
      if (header.opcode === 19) {
        const next = nativeId(payload?.profile?.contact?.id);
        if (!next || next.startsWith('-') || next === '0') return;
        if (viewerId !== null && viewerId !== next) { reset(); failed = true; return; }
        viewerId = next; return;
      }
      const request = pending.get(`${socket}:${header.seq}`);
      pending.delete(`${socket}:${header.seq}`);
      if (!request || !viewerId || !ownObject(payload) || !Array.isArray(payload.messages)
        || payload.messages.length > request.backward || payload.messages.length > MAX_ROWS) return;
      const seen = new Set(), messages = [];
      for (const message of payload.messages) {
        const messageId = nativeId(message?.id), sender = nativeId(message?.sender), time = nativeTime(message?.time);
        if (!messageId || seen.has(messageId) || time === null || typeof message.text !== 'string' && message.text !== undefined
          || message.text?.length > 65536 || message.status === 'REMOVED'
          || message.link?.message?.text !== undefined && (typeof message.link.message.text !== 'string' || message.link.message.text.length > 65536)
          || message.attaches !== undefined && (!Array.isArray(message.attaches) || message.attaches.length > 20)) { failed = true; return; }
        seen.add(messageId);
        const content = { id: messageId, sender, time, type: message.type ?? 'USER', text: message.text ?? '',
          updateTime: message.updateTime ?? null, status: message.status ?? null,
          attaches: message.attaches ?? [], link: message.link ?? null, elements: message.elements ?? [] };
        messages.push({ messageId, time, senderUserId: sender && sender !== '0' && !sender.startsWith('-')
          && (message.type === undefined || message.type === 'USER') ? sender : null,
          outgoing: sender === viewerId,
          forwarded: message.link !== undefined && message.link?.type !== 'REPLY',
          textHash: createHash('sha256').update((message.text ?? '').replace(/\s+/gu, ' ').trim()).digest('hex'),
          // This invocation-only equality hash covers native attachments,
          // links/entities/status too. A changed hidden field may conservatively
          // refuse ACK; unchanged rendered text alone cannot permit one.
          nativeHash: createHash('sha256').update(serialize(canonical(message))).digest('hex'),
          revision: createHash('sha256').update(serialize(canonical(content))).digest('hex'),
          nativeText: message.text ?? '', nativeReplyText: message.link?.message?.text ?? null });
      }
      let readMark = null, unread = null, totalMessages = null;
      if (ownObject(payload.chat) && nativeId(payload.chat.id) === request.chatId && ownObject(payload.chat.participants)) {
        readMark = nativeTime(payload.chat.participants[viewerId]);
        unread = Number.isSafeInteger(payload.chat.newMessages) && payload.chat.newMessages >= 0 ? payload.chat.newMessages : null;
        totalMessages = Number.isSafeInteger(payload.chat.messagesCount) && payload.chat.messagesCount >= 0 ? payload.chat.messagesCount : null;
      }
      // Replacing, not appending, preserves the single authoritative history
      // response used for range coverage. Two partial pages are not a snapshot.
      histories.set(request.chatId, { viewerId, readMark, unread, totalMessages, messages, socket, request });
      if (histories.size > 8) histories.delete(histories.keys().next().value);
      available = true;
    } catch { failed = true; }
  };
  return Object.freeze({ observeOutbound, observeInbound,
    snapshot: chatId => available && !failed ? histories.get(chatId) ?? null : null,
    state: () => ({ available: available && !failed, failed }), reset });
};

const rowIdentity = row => JSON.stringify([row.messageId, row.time, row.senderUserId, row.nativeHash]);

/** The native read mark is a TIME RANGE, not a single message mutation. Prove
 * the complete native unread interval before permitting its covered prefix.
 * A bounded recent DOM window or last-message ID alone cannot prove coverage.
 * This intentionally refuses history responses without their own authoritative
 * chat/participant/unread counters and full unread messages in the SAME frame.
 */
export const inspectMaxReadCoverage = ({ history, messageId, coveredMessageIds }) => {
  if (!history || !Array.isArray(coveredMessageIds) || !coveredMessageIds.length
    || coveredMessageIds.length > 100 || new Set(coveredMessageIds).size !== coveredMessageIds.length) failure();
  const target = history.messages.find(row => row.messageId === messageId);
  if (!target || history.readMark === null) failure();
  if (history.readMark >= target.time) return { alreadyRead: true, target, interval: [] };
  const unread = history.messages.filter(row => row.time > history.readMark);
  if (history.unread === null || history.unread !== unread.length || unread.length === 0
    || history.request.from !== -1 || history.request.backward < unread.length) failure();
  const interval = unread.filter(row => row.time <= target.time);
  if (!interval.length || interval.some(row => !coveredMessageIds.includes(row.messageId))) failure();
  return { alreadyRead: false, target, interval };
};

/** One native browser-emitted READ_MESSAGE, spent BEFORE forwarding. The
 * caller supplies independently committed exact refs; this gate does not mint
 * that authority. Reload must supply a fresh SAME history/identity first.
 * Reconnection/unknown replies cannot resend this operation.
 */
export const createMaxExactReadGate = ({ observer, chatId, messageId, coveredMessageIds }) => {
  const original = observer.snapshot(chatId);
  const coverage = inspectMaxReadCoverage({ history: original, messageId, coveredMessageIds });
  let sent = null, acknowledged = false, denied = false;
  const consume = (frame, socket) => {
    if (sent || coverage.alreadyRead) return false;
    try {
      const decoded = decodeMaxNativeFrame(frame), payload = decoded.payload;
      if (decoded.cmd !== 0 || decoded.opcode !== 50 || !ownObject(payload)
        || Object.keys(payload).sort().join(',') !== 'chatId,mark,messageId,type'
        || payload.type !== 'READ_MESSAGE' || nativeId(payload.chatId) !== chatId
        || nativeId(payload.messageId) !== messageId || nativeTime(payload.mark) !== coverage.target.time) return false;
      const fresh = observer.snapshot(chatId);
      if (fresh === original || fresh?.socket !== socket || fresh?.viewerId !== original.viewerId) return false;
      const current = inspectMaxReadCoverage({ history: fresh, messageId, coveredMessageIds });
      if (current.alreadyRead || current.interval.length > coverage.interval.length
        || current.interval.some(row => !coverage.interval.some(previous => rowIdentity(previous) === rowIdentity(row)))) return false;
      sent = { socket, seq: decoded.seq }; // Irreversible even if send/response fails.
      return true;
    } catch { denied = true; return false; }
  };
  const observeInbound = (frame, socket) => {
    if (!sent || socket !== sent.socket) return;
    const header = inspectMaxFrameHeader(frame);
    if (!header || header.seq !== sent.seq || header.opcode !== 50 || header.cmd !== 1) return;
    try {
      const { payload } = decodeMaxNativeFrame(frame);
      if (!ownObject(payload) || nativeTime(payload.mark) === null || payload.mark < coverage.target.time
        || !Number.isSafeInteger(payload.unread) || payload.unread < 0) { denied = true; return; }
      acknowledged = true;
    } catch { denied = true; }
  };
  const confirmedByHistory = () => {
    const current = observer.snapshot(chatId);
    const target = current?.messages.find(row => row.messageId === messageId);
    return current && current !== original && current.viewerId === original.viewerId
      && current.readMark !== null && current.readMark >= coverage.target.time
      && target && rowIdentity(target) === rowIdentity(coverage.target);
  };
  return Object.freeze({ consume, observeInbound,
    status: () => ({ attempted: sent !== null, acknowledged: coverage.alreadyRead || acknowledged || Boolean(confirmedByHistory()),
      alreadyRead: coverage.alreadyRead, denied }) });
};
