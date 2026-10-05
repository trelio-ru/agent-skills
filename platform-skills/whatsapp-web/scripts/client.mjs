import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireThat, RuntimeError, digest } from './core.mjs';
import { prepareMedia } from './media.mjs';
import { BROWSER_COMMANDS, validateBrowserRequest } from './browser.mjs';

const MAX_MESSAGES = 10000, MAX_CHATS = 5000;
const MUTATIONS = new Set(['send', 'reply', 'react', 'edit', 'delete', 'forward', 'create-group', 'member-add', 'member-remove', 'member-promote', 'member-demote', 'chat-update', 'chat-settings', 'block', 'group-invite-revoke', 'group-join']);
export const COMMANDS = ['me', 'resolve', 'dialogs', 'contacts', 'read', 'unread', 'search', 'history-fetch', 'history-status', 'receipts', 'members', 'blocklist', 'group-invite', 'group-invite-info', 'download', 'result', 'policy', ...MUTATIONS];
export const isChatId = value => typeof value === 'string' && /^\d+(?:-\d+)?@(s\.whatsapp\.net|lid|g\.us)$/.test(value);
const normalized = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ru');
const stamp = value => Number(value?.toNumber?.() ?? value ?? 0);
const keyId = key => JSON.stringify([key.remoteJid, key.id, Boolean(key.fromMe), key.participant || '']);
const CONFIRMATION_WAIT_MS = 3000;

// Protobuf toJSON persists enum names (for example "PENDING"), while live
// Baileys events use numbers. Unknown values must never become an ACK through
// coercion; both forms use the same explicit enum before comparisons.
export function providerStatus(value, sdk) {
  const status = typeof value === 'string' ? sdk.proto.WebMessageInfo.Status[value] : value;
  return Number.isInteger(status) && status >= 0 && status <= 5 ? status : null;
}
function mergeStatus(previous, next, sdk) {
  const left = providerStatus(previous, sdk), right = providerStatus(next, sdk);
  if (left === 0 || right === 0) return 0;
  return left === null ? right : right === null ? left : Math.max(left, right);
}

function restrictedMedia(content) {
  // Baileys unwraps up to five future-proof envelopes. Inspect the original
  // chain first: normalizing an ephemeral(viewOnce(image)) message erases the
  // evidence needed to prohibit export and forwarding.
  for (let depth=0; content && depth<=5; depth++) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension ||
        ['imageMessage','videoMessage','audioMessage'].some(type=>content[type]?.viewOnce)) return true;
    const wrapper=['ephemeralMessage','documentWithCaptionMessage','editedMessage',
      'associatedChildMessage','groupStatusMessage','groupStatusMessageV2'].find(name=>content[name]);
    if (!wrapper) return false;
    content=content[wrapper].message;
  }
  return Boolean(content); // Excessive/unknown nesting never permits export.
}

// Page by encoded bytes as well as row count. A few long messages must not
// abort the local control connection or silently truncate their bodies.
function pageRows(rows, limit, { latest = false, bytes = 768 * 1024 } = {}) {
  const candidates = latest ? rows.slice(-limit).reverse() : rows.slice(0, limit);
  const items = []; let used = 2;
  for (const row of candidates) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (used + size > bytes) {
      requireThat(items.length > 0, 'single_item_exceeds_response_limit');
      break;
    }
    items.push(row); used += size;
  }
  if (latest) items.reverse();
  return { items, hasMore: rows.length > items.length };
}

export function validateRequest(packet) {
  if (BROWSER_COMMANDS.includes(packet?.command)) return validateBrowserRequest(packet);
  requireThat(packet && typeof packet === 'object' && !Array.isArray(packet) && COMMANDS.includes(packet.command), 'unknown_command');
  const allowed = new Set(['command', 'sessionId', 'chat', 'query', 'limit', 'before', 'messageId', 'text', 'mode',
    'dryRun', 'confirm', 'approvalHash', 'requestId', 'output', 'file', 'mimeType', 'fileName', 'target', 'participants', 'title', 'description',
    'phone', 'mediaType', 'archive', 'pin', 'muteUntil', 'blocked', 'invite', 'cursor', 'since', 'until', 'contact']);
  requireThat(Object.keys(packet).every(key => allowed.has(key)), 'unsupported_option');
  for (const name of ['chat', 'query', 'before', 'messageId', 'text', 'mode', 'approvalHash', 'requestId', 'output', 'file', 'mimeType', 'fileName', 'target', 'title', 'description'])
    if (packet[name] !== undefined) requireThat(typeof packet[name] === 'string' && packet[name].length <= (name === 'text' ? 20000 : 2048) && !packet[name].includes('\0'), 'invalid_input');
  for (const name of ['dryRun', 'confirm']) if (packet[name] !== undefined) requireThat(typeof packet[name] === 'boolean', 'invalid_input');
  for (const name of ['archive', 'pin', 'blocked']) if (packet[name] !== undefined) requireThat(typeof packet[name] === 'boolean', 'invalid_input');
  for (const name of ['phone', 'mediaType', 'invite', 'cursor', 'since', 'until'])
    if (packet[name] !== undefined) requireThat(typeof packet[name] === 'string' && packet[name].length <= 4096 && !packet[name].includes('\0'), 'invalid_input');
  if (packet.muteUntil !== undefined) requireThat(packet.muteUntil === null || Number.isSafeInteger(packet.muteUntil) && packet.muteUntil > 0, 'mute_until_invalid');
  if (packet.mediaType !== undefined) requireThat(['document','image','video','audio','voice','sticker','contact'].includes(packet.mediaType), 'media_type_invalid');
  if (packet.contact !== undefined) requireThat(packet.contact && typeof packet.contact === 'object' && !Array.isArray(packet.contact) &&
    Object.keys(packet.contact).sort().join() === 'name,phone' && typeof packet.contact.name === 'string' && packet.contact.name.trim() && packet.contact.name.length <= 200 &&
    !/[\r\n\0]/.test(packet.contact.name) && /^\+[1-9]\d{6,14}$/.test(packet.contact.phone), 'contact_invalid');
  if (packet.limit !== undefined) requireThat(Number.isInteger(packet.limit) && packet.limit >= 1 && packet.limit <= 100, 'limit_invalid');
  if (packet.participants !== undefined) requireThat(Array.isArray(packet.participants) && packet.participants.length > 0 && packet.participants.length <= 30 &&
    packet.participants.every(id => isChatId(id) && !id.endsWith('@g.us')), 'participants_invalid');
  if (MUTATIONS.has(packet.command) || ['result','history-status'].includes(packet.command)) requireThat(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(packet.requestId || ''), 'request_id_required');
  return packet;
}

// Only normalized chat content leaves the worker. Media URLs, Signal keys,
// device lists, raw protobuf objects and account credentials never do.
export function messageView(raw, sdk) {
  const value = sdk.normalizeMessageContent(raw.message) || {};
  const type = sdk.getContentType(value);
  const body = value[type] || {};
  const media = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
  return { id: raw.key.id, chatId: raw.key.remoteJid, author: raw.key.participant || (raw.key.fromMe ? 'self' : raw.key.remoteJid),
    direction: raw.key.fromMe ? 'outgoing' : 'incoming', timestamp: stamp(raw.messageTimestamp) || null,
    text: typeof value.conversation === 'string' ? value.conversation : body.text || body.caption || '',
    type: type || 'unknown', replyTo: body.contextInfo?.stanzaId || null,
    attachment: media ? { type, mimeType: body.mimetype || null, fileName: body.fileName || null, size: stamp(body.fileLength) || null } : null,
    status: providerStatus(raw.status, sdk) };
}

export class WhatsAppClient {
  constructor({ sdk, pino, permit, persist, onQr, onPhase, onFatal, saved }) {
    Object.assign(this, { sdk, permit, persist, onQr, onPhase, onFatal });
    this.logger = pino({ level: 'silent' });
    this.data = saved ? JSON.parse(saved, sdk.BufferJSON.reviver) : { schema: 1, creds: sdk.initAuthCreds(), keys: {}, chats: {}, contacts: {}, messages: {}, policy: 'confirm', attempts: {} };
    requireThat(this.data.schema === 1 && this.data.creds && this.data.keys && this.data.messages && ['confirm','read-only','autonomous'].includes(this.data.policy), 'vault_schema_invalid');
    // A saved device-wide allowance is never authorization in a new operator
    // conversation. Normalize only this legacy field; preserve credentials,
    // history and the durable mutation journal through the next encrypted save.
    if (this.data.policy === 'autonomous') this.data.policy = 'confirm';
    this.approvals = new Map(); this.closed = false; this.connected = false; this.retries = 0; this.restartUsed = false;
    this.confirmationWaiters = new Set();
    // Resolution is a bounded per-session proof from WhatsApp. It does not add
    // an address-book contact or invent a synced conversation after lookup.
    this.resolvedChats = new Map(); this.historyWaiters = new Set();
    this.data.historyRequests ||= {}; this.earlyHistory = new Map();
    this.historyReceived = false; this.syncAt = null;
  }
  serialize() {
    let value = JSON.stringify(this.data, this.sdk.BufferJSON.replacer);
    // Trim only oldest cached content, never Signal keys or mutation claims.
    // Oversized auth state still fails closed in the encrypted vault layer.
    while (Buffer.byteLength(value) > 20*1024*1024 && Object.keys(this.data.messages).length) {
      const oldest = Object.entries(this.data.messages).sort((a,b)=>stamp(a[1].messageTimestamp)-stamp(b[1].messageTimestamp));
      for (const [id] of oldest.slice(0,Math.max(1,Math.ceil(oldest.length/4)))) delete this.data.messages[id];
      value = JSON.stringify(this.data, this.sdk.BufferJSON.replacer);
    }
    return value;
  }
  async save() { await this.persist(this.serialize()); }
  fail(error) { if (!this.closed) this.onFatal(error instanceof RuntimeError ? error.code : 'provider_operation_failed'); }
  event(fn) { return (...args) => { Promise.resolve().then(() => { if (!this.closed) return fn(...args); }).catch(error => this.fail(error)); }; }
  upsert(collection, rows) {
    for (const row of rows) if (isChatId(row.id)) collection[row.id] = { ...collection[row.id], ...row };
    const ids = Object.keys(collection); for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CHATS))) delete collection[id];
  }
  ingest(messages) {
    for (const raw of messages) if (isChatId(raw.key?.remoteJid) && raw.key.id && raw.message) {
      const attempt = raw.key.fromMe && Object.values(this.data.attempts).find(row => row.chatId === raw.key.remoteJid && row.messageId === raw.key.id);
      const id = keyId(raw.key), status = mergeStatus(mergeStatus(this.data.messages[id]?.status, raw.status, this.sdk), attempt?.providerStatus, this.sdk);
      // emitOwnEvents can append the original PENDING snapshot after a receipt.
      // Keep the stronger observation when the exact message is ingested again.
      this.data.messages[id] = { ...raw, ...(status === null ? {} : { status }) };
      if (!this.data.chats[raw.key.remoteJid]) this.data.chats[raw.key.remoteJid] = { id: raw.key.remoteJid };
    }
    const ids = Object.keys(this.data.messages).sort((a,b) => stamp(this.data.messages[a].messageTimestamp) - stamp(this.data.messages[b].messageTimestamp));
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_MESSAGES))) delete this.data.messages[id];
  }
  async connect() {
    const generation = (this.generation || 0) + 1;
    this.generation = generation;
    await this.permit(); requireThat(!this.closed, 'session_closed');
    if (generation !== this.generation) return;
    const sdk = this.sdk;
    const auth = { creds: this.data.creds, keys: {
      get: async (type, ids) => {
        await this.permit(); requireThat(generation === this.generation, 'stale_provider_connection'); const result = {};
        for (const id of ids) { const value = this.data.keys[JSON.stringify([type,id])];
          result[id] = type === 'app-state-sync-key' && value ? sdk.proto.Message.AppStateSyncKeyData.fromObject(value) : value; }
        return result;
      },
      set: async update => {
        await this.permit();
        requireThat(generation === this.generation, 'stale_provider_connection');
        for (const [type, values] of Object.entries(update)) for (const [id, value] of Object.entries(values)) {
          const name = JSON.stringify([type,id]); if (value == null) delete this.data.keys[name]; else this.data.keys[name] = value;
        }
        // Signal ratchets must reach encrypted durable storage before the SDK
        // observes successful keys.set; an asynchronous best-effort cache loses
        // sessions after a crash and can cause duplicate message retransmission.
        await this.save();
      }
    } };
    const socket = sdk.default({ auth, logger: this.logger, browser: sdk.Browsers.macOS('Trelio'),
      markOnlineOnConnect: false, syncFullHistory: false, emitOwnEvents: true,
      connectTimeoutMs: 30000, defaultQueryTimeoutMs: 15000,
      maxMsgRetryCount: 0, enableAutoSessionRecreation: false, enableRecentMessageCache: false,
      generateHighQualityLinkPreview: false, appStateMacVerification: { patch: true, snapshot: true },
      shouldIgnoreJid: jid => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
      getMessage: async () => undefined });
    this.socket = socket;
    // A refreshed login retires its socket before closing it. Queued events
    // from that socket must never revive an old QR or overwrite paired state.
    const currentEvent = fn => this.event((...args) => { if (socket === this.socket) return fn(...args); });
    // Baileys' high-level handler processes negative message ACKs but omits
    // successful server ACKs. Observe the same authenticated socket event,
    // correlate its exact chat/message, and persist evidence before waking a
    // caller. Server acceptance alone never means recipient delivery/read.
    socket.ws?.on('CB:ack,class:message', currentEvent(async ({ attrs }) => {
      if (!attrs || attrs.class !== 'message') return;
      const status = attrs.error === undefined ? sdk.proto.WebMessageInfo.Status.SERVER_ACK : sdk.proto.WebMessageInfo.Status.ERROR;
      if (await this.recordConfirmation({ remoteJid: attrs.from, id: attrs.id, fromMe: true }, status, socket)) {
        await this.save(); this.wakeConfirmations();
      }
    }));
    socket.ev.on('creds.update', currentEvent(async update => { Object.assign(this.data.creds, update); await this.save(); }));
    socket.ev.on('connection.update', currentEvent(async update => {
      if (socket !== this.socket || this.closed) return;
      if (update.qr) {
        await this.onQr(update.qr, () => socket === this.socket && !this.closed);
        if (socket !== this.socket || this.closed) return;
        this.onPhase('qr_required');
      }
      if (update.connection === 'open') {
        // Mark the live transport before persistence yields, so a refresh click
        // racing with successful pairing cannot close the authenticated socket.
        this.connected = true;
        await this.save();
        if (socket !== this.socket || this.closed || !this.connected) return;
        this.onPhase('ready');
      }
      if (update.connection === 'close') {
        this.connected = false;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === sdk.DisconnectReason.loggedOut) { this.onPhase('relink_required'); return; }
        // Pairing has one documented socket restart. Transport recovery is
        // bounded and never resubmits an outgoing user mutation.
        if (code === sdk.DisconnectReason.restartRequired && !this.restartUsed) this.restartUsed = true;
        else if (![408, 428, 503].includes(code) || ++this.retries > 3) { this.onPhase('disconnected'); return; }
        this.onPhase('reconnecting');
        this.reconnectTimer = setTimeout(() => { if (!this.closed) this.connect().catch(e => this.fail(e)); }, Math.max(1000, this.retries * 1500));
      }
    }));
    socket.ev.on('messaging-history.set', currentEvent(async history => {
      this.acceptHistory(history);
      this.upsert(this.data.chats, history.chats); this.upsert(this.data.contacts, history.contacts); this.ingest(history.messages);
      this.historyReceived = true; this.syncAt = new Date().toISOString(); await this.save();
      for (const wake of this.historyWaiters) wake();
    }));
    for (const event of ['chats.upsert','chats.update']) socket.ev.on(event, currentEvent(async rows => { this.upsert(this.data.chats,rows); await this.save(); }));
    for (const event of ['contacts.upsert','contacts.update']) socket.ev.on(event, currentEvent(async rows => { this.upsert(this.data.contacts,rows); await this.save(); }));
    socket.ev.on('messages.upsert', currentEvent(async update => { this.ingest(update.messages); await this.save(); }));
    socket.ev.on('messages.update', currentEvent(async rows => {
      for (const {key, update} of rows) {
        const id = keyId(key), message = this.data.messages[id];
        if (message) {
          const status = mergeStatus(message.status, update.status, sdk);
          Object.assign(message, update, status === null ? {} : { status });
        }
        await this.recordConfirmation(key, update.status, socket);
      }
      await this.save();
      this.wakeConfirmations();
    }));
    socket.ev.on('message-receipt.update', currentEvent(async rows => {
      for (const { key, receipt } of rows) {
        if (key?.fromMe !== true || !key.remoteJid?.endsWith('@g.us')) continue;
        const attempt = Object.values(this.data.attempts).find(row => row.chatId === key.remoteJid && row.messageId === key.id);
        const raw = this.data.messages[keyId(key)];
        // Early group receipts are durable even before the own message echo.
        // They are participant observations, never a blanket group ACK.
        if (attempt) attempt.receipts = this.mergeReceipts(attempt.receipts, [receipt]);
        if (raw?.key.fromMe) raw.userReceipt = this.mergeReceipts(raw.userReceipt, [receipt]);
      }
      await this.save();
    }));
    socket.ev.on('messages.delete', currentEvent(async deletion => {
      if (deletion.all) for (const [id, raw] of Object.entries(this.data.messages)) { if (raw.key.remoteJid === deletion.jid) delete this.data.messages[id]; }
      else for (const key of deletion.keys || []) delete this.data.messages[keyId(key)];
      await this.save();
    }));
    socket.ev.on('chats.delete', currentEvent(async ids => { for (const id of ids) { delete this.data.chats[id]; for (const [key, raw] of Object.entries(this.data.messages)) if (raw.key.remoteJid === id) delete this.data.messages[key]; } await this.save(); }));
  }
  async refreshQr() {
    requireThat(!this.refreshingQr, 'qr_refresh_in_progress');
    this.refreshingQr = true;
    try {
      await this.permit();
      requireThat(!this.closed && !this.connected && !this.data.creds.registered, 'qr_refresh_unavailable');
      const previous = this.socket;
      // Reconnect only the unpaired transport, preserving auth keys, browser,
      // company identity and the original native deadline. Never log out a
      // linked account or reset its encrypted credentials to obtain a QR.
      this.socket = null;
      this.generation = (this.generation || 0) + 1;
      clearTimeout(this.reconnectTimer);
      previous?.end(undefined);
      this.retries = 0;
      this.onPhase('qr_refreshing');
      await this.connect();
    } finally { this.refreshingQr = false; }
  }
  coverage(extra = {}) { return { complete: false, scope: 'locally_synced_history', historyReceivedThisSession: this.historyReceived, syncedAt: this.syncAt, ...extra }; }
  listPage(rows, packet, property, identity = row => row.id || row.chatId) {
    const binding = digest(JSON.stringify([packet.command, normalized(packet.query), packet.chat || null, packet.messageId || null, packet.since || null, packet.until || null]));
    let after = null;
    if (packet.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(packet.cursor, 'base64url').toString()); } catch { throw new RuntimeError('cursor_invalid'); }
      requireThat(cursor?.binding === binding && typeof cursor.after === 'string', 'cursor_context_mismatch'); after = cursor.after;
    }
    // Stable identity ordering avoids offset skips on growing live lists. The
    // cursor binds the query, but cannot freeze WhatsApp's changing snapshot.
    const ordered = rows.sort((a,b) => identity(a).localeCompare(identity(b), 'en'));
    const remaining = after === null ? ordered : ordered.filter(row => identity(row).localeCompare(after, 'en') > 0);
    const page = pageRows(remaining, packet.limit || 20);
    return { [property]: page.items, coverage: this.coverage({ hasMore: page.hasMore, snapshotStable: false,
      nextCursor: page.hasMore ? Buffer.from(JSON.stringify({ binding, after: identity(page.items.at(-1)) })).toString('base64url') : null }) };
  }
  dialogs(query = '') {
    return Object.values(this.data.chats).map(chat => ({ id: chat.id,
      name: chat.name || this.data.contacts[chat.id]?.name || this.data.contacts[chat.id]?.notify || chat.id,
      isGroup: chat.id.endsWith('@g.us'), unreadCount: Number.isInteger(chat.unreadCount) && chat.unreadCount >= 0 ? chat.unreadCount : null,
      archived: chat.archived ?? null, pinned: chat.pinned === undefined ? null : Boolean(chat.pinned),
      muteUntil: Number.isFinite(Number(chat.muteEndTime)) ? Number(chat.muteEndTime) : null })).filter(chat => !query || normalized(`${chat.name} ${chat.id}`).includes(normalized(query)));
  }
  selfChatId() {
    // The authenticated socket owns this account identity. Project only the
    // normalized chat JID: never expose its device suffix or spread the SDK
    // user object, which can contain unrelated account/session metadata.
    const raw = this.socket?.user?.id;
    if (typeof raw !== 'string' || raw.length > 128 || !/^\d+(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(raw)) return null;
    const id = this.sdk.jidNormalizedUser(raw);
    return isChatId(id) && !id.endsWith('@g.us') ? id : null;
  }
  exactChat(target) {
    // A user's own chat can be absent from partial history (including before
    // the first self-message). Its authenticated exact ID is sufficient; all
    // other targets still require the existing synced-chat ambiguity guard.
    const self = this.selfChatId();
    if (self && target === self) return self;
    if ((this.resolvedChats.get(target) || 0) > Date.now()) return target;
    const chats = this.dialogs();
    const matches = chats.filter(chat => chat.id === target || normalized(chat.name) === normalized(target));
    requireThat(matches.length === 1, matches.length ? 'chat_ambiguous' : 'chat_not_in_synced_history'); return matches[0].id;
  }
  exactMessage(chat, id) {
    const matches = Object.values(this.data.messages).filter(raw => raw.key.remoteJid === chat && raw.key.id === id);
    requireThat(matches.length === 1, 'message_not_unique_or_not_synced'); return matches[0];
  }
  messages(chat) { return Object.values(this.data.messages).filter(raw => !chat || raw.key.remoteJid === chat).sort((a,b) => stamp(a.messageTimestamp) - stamp(b.messageTimestamp)); }
  view(raw) {
    const result = messageView(raw, this.sdk);
    if (raw.key.fromMe) {
      const attempt = Object.values(this.data.attempts).find(row => row.chatId === raw.key.remoteJid && row.messageId === raw.key.id);
      result.status = mergeStatus(result.status, attempt?.providerStatus, this.sdk);
    }
    return result;
  }
  async resolvePhone(phone) {
    requireThat(typeof phone === 'string' && /^\+[1-9]\d{6,14}$/.test(phone), 'international_phone_required');
    const expected = `${phone.slice(1)}@s.whatsapp.net`, socket = this.socket;
    const rows = await socket.onWhatsApp(phone); await this.permit();
    requireThat(socket === this.socket && this.connected, 'provider_not_connected');
    requireThat(Array.isArray(rows) && rows.length <= 1, 'phone_resolution_unknown');
    if (!rows.length || rows[0].exists === false) return { registered: false, chatId: null };
    const id = this.sdk.jidNormalizedUser(rows[0].jid || '');
    // An empty/foreign response is not permission to synthesize the address.
    // Keep the exact provider result only when it proves the requested number.
    requireThat(rows[0].exists === true && id === expected, 'phone_resolution_mismatch');
    if (this.resolvedChats.size >= 100) this.resolvedChats.delete(this.resolvedChats.keys().next().value);
    this.resolvedChats.set(id, Date.now() + 10 * 60 * 1000);
    return { registered: true, chatId: id, source: 'provider_phone_lookup', validForSeconds: 600 };
  }
  mergeReceipts(previous = [], incoming = []) {
    const result = new Map();
    for (const row of [...previous, ...incoming]) {
      const id = typeof row?.userJid === 'string' ? this.sdk.jidNormalizedUser(row.userJid) : '';
      if (!isChatId(id) || id.endsWith('@g.us')) continue;
      const value = result.get(id) || { userJid: id };
      for (const field of ['receiptTimestamp','readTimestamp','playedTimestamp']) {
        const time = stamp(row[field]);
        if (Number.isSafeInteger(time) && time > 0) value[field] = value[field] ? Math.min(value[field], time) : time;
      }
      result.set(id, value);
      if (result.size > 2048) throw new RuntimeError('group_receipts_too_large');
    }
    return [...result.values()];
  }
  async receipts(chat, messageId, packet) {
    requireThat(chat.endsWith('@g.us') && typeof messageId === 'string' && messageId, 'group_message_required');
    const attempt = Object.values(this.data.attempts).find(row => row.chatId === chat && row.messageId === messageId);
    const raw = this.messages(chat).find(row => row.key.id === messageId && row.key.fromMe);
    requireThat(attempt || raw, 'own_message_not_found');
    const canonical = async id => {
      const normalizedId=this.sdk.jidNormalizedUser(id);
      if(!normalizedId.endsWith('@lid'))return normalizedId;
      // Group metadata and receipts can describe one person using different
      // address forms. Only the provider's existing local mapping may join them.
      const mapped=await this.socket.signalRepository?.lidMapping?.getPNForLID(normalizedId);
      return isChatId(mapped)&&mapped.endsWith('@s.whatsapp.net')?mapped:normalizedId;
    };
    const collected=this.mergeReceipts(raw?.userReceipt, attempt?.receipts);
    const observed=this.mergeReceipts([],await Promise.all(collected.map(async row=>({...row,userJid:await canonical(row.userJid)}))));
    const submitted=new Set(await Promise.all((attempt?.recipientIds||[]).map(canonical)));
    const recipients = new Set([...submitted, ...observed.map(row => row.userJid)]);
    const rows = [...recipients].map(id => {
      const receipt = observed.find(row => row.userJid === id);
      return { chatId: id, recipientAtSubmission:Array.isArray(attempt?.recipientIds)?submitted.has(id):null,
        deliveredAt: receipt?.receiptTimestamp || null, readAt: receipt?.readTimestamp || null,
        playedAt: receipt?.playedTimestamp || null, delivered: Boolean(receipt?.receiptTimestamp || receipt?.readTimestamp || receipt?.playedTimestamp),
        read: Boolean(receipt?.readTimestamp || receipt?.playedTimestamp) };
    });
    const page=this.listPage(rows,packet,'participants');
    return { chatId: chat, messageId, participants: page.participants,
      counts: { observed: observed.length, recipientsAtSubmission: Array.isArray(attempt?.recipientIds)?submitted.size:null,
        delivered: rows.filter(row => row.delivered).length, read: rows.filter(row => row.read).length },
      coverage: { complete: false, recipientSetAtSubmissionKnown: Array.isArray(attempt?.recipientIds),
        hasMore: page.coverage.hasMore,nextCursor:page.coverage.nextCursor,total: rows.length, note: 'Missing receipts are unknown; membership can change after submission.' } };
  }
  inviteCode(value) {
    requireThat(typeof value === 'string', 'invite_required');
    const code = value.startsWith('https://chat.whatsapp.com/') ? value.slice('https://chat.whatsapp.com/'.length) : value;
    requireThat(/^[A-Za-z0-9_-]{16,64}$/.test(code), 'invite_invalid'); return code;
  }
  groupView(meta) {
    requireThat(isChatId(meta?.id) && meta.id.endsWith('@g.us'), 'group_metadata_invalid');
    return { chatId: meta.id, title: typeof meta.subject === 'string' ? meta.subject : null,
      description: typeof meta.desc === 'string' ? meta.desc : null,
      participantCount: Array.isArray(meta.participants) ? meta.participants.length : null };
  }
  acceptHistory(history) {
    const id = history.peerDataRequestSessionId;
    if (typeof id !== 'string' || !id || id.length > 256) return;
    // Correlate only the request session returned by the provider, never a
    // coincident unrelated history sync. Keep an early response until the RPC
    // returns its ID; SDK events can precede the awaiting caller's continuation.
    const request = Object.values(this.data.historyRequests).find(row => row.providerRequestId === id);
    if (!request) {
      if (this.earlyHistory.size >= 4) this.earlyHistory.delete(this.earlyHistory.keys().next().value);
      this.earlyHistory.set(id, history); return;
    }
    const messages = (history.messages || []).filter(row => row.key?.remoteJid === request.chatId && row.message && row.key.id);
    request.messages = [...(request.messages || []), ...messages].filter((row, index, all) => all.findIndex(other => keyId(other.key) === keyId(row.key)) === index).slice(-request.limit);
    request.state = 'received'; request.receivedAt = new Date().toISOString();
  }
  historyResult(requestId) {
    const row = this.data.historyRequests[requestId]; requireThat(row, 'history_request_not_found');
    const messages = (row.messages || []).sort((a,b) => stamp(a.messageTimestamp)-stamp(b.messageTimestamp));
    const page = pageRows(messages.map(raw => this.view(raw)), row.limit, { latest: true });
    return { requestId, chatId: row.chatId, state: row.state, messages: page.items,
      coverage: { complete: false, source: 'provider_on_demand', requested: row.limit,
        nextBeforeId: page.items[0]?.id || null, hasMoreInPage: page.hasMore, phoneMayNeedToBeOnline: row.state !== 'received',
        note: 'A short or empty response does not establish the beginning of the full account archive.' } };
  }
  async fetchHistory(chat, before, limit) {
    const priorMessages = Object.values(this.data.historyRequests).filter(row => row.chatId === chat).flatMap(row => row.messages || []);
    const candidates = [...this.messages(chat), ...priorMessages].sort((a,b) => stamp(a.messageTimestamp)-stamp(b.messageTimestamp));
    const oldest = before ? candidates.find(row => row.key.id === before) : candidates[0];
    requireThat(oldest && stamp(oldest.messageTimestamp) > 0, 'history_anchor_required');
    const previous = Object.entries(this.data.historyRequests).reverse().find(([,row]) => row.chatId === chat && row.before === oldest.key.id);
    if (previous && (previous[1].state==='received'||Date.now()-(previous[1].at||0)<60000)) return this.historyResult(previous[0]);
    // A phone that stayed offline must not block all subsequent history reads
    // forever, including after process restart. A new explicit read may retry
    // after a minute; it is not a replay of an outgoing chat message. Preserve
    // the old provider ID so a late response still has its exact correlation.
    for(const request of Object.values(this.data.historyRequests))
      if(['requesting','pending','unknown'].includes(request.state)&&Date.now()-(request.at||0)>=60000)request.state='timed_out';
    requireThat(!Object.values(this.data.historyRequests).some(row => ['requesting','pending','unknown'].includes(row.state)), 'history_request_pending');
    const requestId = randomUUID(), row = { chatId: chat, before: oldest.key.id, limit, state: 'requesting', at:Date.now(),messages: [] };
    // Bound cached pages separately from recent-message retention, so fetching
    // older history does not immediately evict the page the caller requested.
    const ids = Object.keys(this.data.historyRequests);
    if (ids.length >= 10) delete this.data.historyRequests[ids[0]];
    this.data.historyRequests[requestId] = row; await this.save();
    try {
      row.providerRequestId = await this.socket.fetchMessageHistory(limit, oldest.key, stamp(oldest.messageTimestamp) * 1000);
      requireThat(typeof row.providerRequestId === 'string' && row.providerRequestId, 'history_request_unknown');
      row.state = 'pending';
      const early = this.earlyHistory.get(row.providerRequestId);
      if (early) { this.earlyHistory.delete(row.providerRequestId); this.acceptHistory(early); }
      await this.save();
      if (row.state === 'pending') await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.historyWaiters.delete(wake); resolve(); };
        const wake = () => { if (row.state !== 'pending' || this.closed) finish(); };
        const timer = setTimeout(finish, 8000); this.historyWaiters.add(wake); wake();
      });
    } catch { row.state = 'unknown'; await this.save(); }
    return this.historyResult(requestId);
  }
  confirmation(requestId) {
    const attempt = this.data.attempts[requestId];
    const message = attempt?.messageId && Object.values(this.data.messages).find(raw =>
      raw.key.remoteJid === attempt.chatId && raw.key.id === attempt.messageId && raw.key.fromMe);
    const status = mergeStatus(attempt?.providerStatus, message?.status, this.sdk);
    return { serverAcknowledged: status !== null && status >= 2,
      delivered: status !== null && status >= 3, read: status !== null && status >= 4,
      providerRejected: status === 0, providerStatus: status };
  }
  async recordConfirmation(key, value, socket) {
    const status = providerStatus(value, this.sdk);
    if (status === null || key?.fromMe !== true || !key.id || !key.remoteJid) return false;
    // Only the exact generated outgoing ID is eligible. A receipt for another
    // chat or inbound message must not confirm this operation. Phone/LID aliases
    // require Baileys' stored reverse mapping, never names or a network lookup.
    const candidates = Object.values(this.data.attempts).filter(attempt => attempt.messageId === key.id);
    if (candidates.length !== 1) return false;
    const attempt = candidates[0], normalize = jid => typeof jid === 'string' ? this.sdk.jidNormalizedUser(jid) : null;
    const expected = normalize(attempt.chatId), actual = normalize(key.remoteJid);
    if (!expected || !actual) return false;
    if (expected !== actual) {
      const lid = actual.endsWith('@lid') ? actual : expected.endsWith('@lid') ? expected : null;
      const pn = actual.endsWith('@s.whatsapp.net') ? actual : expected.endsWith('@s.whatsapp.net') ? expected : null;
      if (!lid || !pn) return false;
      let mapped;
      try { mapped = await socket.signalRepository?.lidMapping?.getPNForLID(lid); }
      catch (error) {
        // A socket retired during its local key-store read is stale evidence,
        // not a reason to tear down the replacement transport.
        if (this.closed || socket !== this.socket) return false;
        throw error;
      }
      if (normalize(mapped) !== pn) return false;
    }
    if (this.closed || socket !== this.socket) return false;
    attempt.providerStatus = mergeStatus(attempt.providerStatus, status, this.sdk);
    for (const raw of Object.values(this.data.messages)) if (raw.key.fromMe && raw.key.id === key.id &&
      [expected, actual].includes(normalize(raw.key.remoteJid))) raw.status = mergeStatus(raw.status, status, this.sdk);
    return true;
  }
  wakeConfirmations(closing = false) { for (const wake of this.confirmationWaiters) wake(closing); }
  async waitForConfirmation(requestId) {
    const current = () => this.confirmation(requestId);
    const ready = () => { const value = current(); return value.serverAcknowledged || value.providerRejected; };
    // One bounded wait, no resubmission and no indefinite delivery monitor.
    // An offline recipient must not hold the worker open; the native session
    // deadline remains independent and a close wakes the waiter immediately.
    if (ready() || !this.data.attempts[requestId]?.messageId || this.closed || !this.connected) return current();
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.confirmationWaiters.delete(wake); resolve(); };
      const wake = closing => { if (closing || ready()) finish(); };
      const timer = setTimeout(finish, CONFIRMATION_WAIT_MS);
      this.confirmationWaiters.add(wake);
      wake(false);
    });
    return current();
  }
  async execute(packet) {
    validateRequest(packet); await this.permit();
    requireThat(!BROWSER_COMMANDS.includes(packet.command), 'browser_session_required');
    if (packet.command === 'result') {
      const attempt = this.data.attempts[packet.requestId]; requireThat(attempt,'request_not_found');
      return { requestId:packet.requestId,state:attempt.state,chatId:attempt.chatId||null,messageId:attempt.messageId||null,
        ...await this.waitForConfirmation(packet.requestId) };
    }
    if (packet.command === 'history-status') return this.historyResult(packet.requestId);
    if (packet.command === 'policy') {
      if (packet.mode) { requireThat(packet.confirm === true && ['confirm','read-only'].includes(packet.mode), 'policy_confirmation_required');
        this.data.policy = packet.mode; await this.save(); }
      return { policy: this.data.policy };
    }
    requireThat(this.connected, 'provider_not_connected');
    const limit = packet.limit || 20, command = packet.command;
    if (command === 'resolve') return this.resolvePhone(packet.phone);
    if (command === 'blocklist') {
      const rows = await this.socket.fetchBlocklist();
      return this.listPage(rows.filter(isChatId).map(id => ({ chatId: id })), packet, 'blocked');
    }
    if (command === 'group-invite-info') return this.groupView(await this.socket.groupGetInviteInfo(this.inviteCode(packet.invite)));
    if (command === 'group-join') return this.mutate(packet, null);
    if (command === 'me') {
      const chatId = this.selfChatId(); requireThat(chatId, 'self_identity_unavailable');
      return { chatId, isSelf: true };
    }
    if (command === 'dialogs') return this.listPage(this.dialogs(packet.query), packet, 'dialogs');
    if (command === 'contacts') {
      requireThat(packet.query?.trim(), 'query_required');
      const rows = Object.values(this.data.contacts).filter(c => normalized(`${c.name || ''} ${c.notify || ''} ${c.id}`).includes(normalized(packet.query)))
        .map(c => ({id:c.id, name:c.name || c.notify || null}));
      return this.listPage(rows, packet, 'contacts');
    }
    if (command === 'unread') {
      const all = this.dialogs(), chats = all.filter(c => c.unreadCount > 0);
      const rows = chats.slice(0,limit).map(c => {
        const messages = this.messages(c.id).map(m => this.view(m));
        const page = pageRows(messages,Math.min(c.unreadCount,20),{latest:true,bytes:256*1024});
        return {...c,messages:page.items,coverage:this.coverage({hasMore:page.hasMore,
          nextBeforeId:page.hasMore ? page.items[0]?.id ?? null : null})};
      });
      const page = pageRows(rows,limit);
      return {chats:page.items,coverage:this.coverage({hasMore:chats.length>page.items.length,
        unknownUnreadChats:all.filter(c=>c.unreadCount===null).length})};
    }
    if (command === 'search') {
      requireThat(packet.query?.trim(), 'query_required'); const chat = packet.chat ? this.exactChat(packet.chat) : null;
      const boundary = value => {
        if (value === undefined) return null;
        requireThat(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'search_date_invalid');
        return Date.parse(value) / 1000;
      };
      const since = boundary(packet.since), until = boundary(packet.until);
      requireThat(since === null || until === null || since <= until, 'search_date_range_invalid');
      const cache = Object.values(this.data.historyRequests).flatMap(row => row.messages || []);
      const all = new Map([...this.messages(chat), ...cache.filter(row => !chat || row.key.remoteJid === chat)].map(row => [keyId(row.key), row]));
      const rows = [...all.values()].map(m => this.view(m)).filter(m => normalized(m.text).includes(normalized(packet.query)) &&
        (since === null || m.timestamp >= since) && (until === null || m.timestamp <= until));
      return this.listPage(rows, packet, 'messages', row => JSON.stringify([row.timestamp, row.chatId, row.id]));
    }
    if (command === 'create-group') return this.mutate(packet, null);
    const chat = this.exactChat(packet.chat);
    if (command === 'history-fetch') return this.fetchHistory(chat, packet.before, limit);
    if (command === 'receipts') return this.receipts(chat, packet.messageId, packet);
    if (command === 'group-invite') {
      requireThat(chat.endsWith('@g.us'), 'group_required');
      const code = this.inviteCode(await this.socket.groupInviteCode(chat));
      return { chatId: chat, url: `https://chat.whatsapp.com/${code}` };
    }
    if (command === 'read') {
      let rows = this.messages(chat); if (packet.before) { const index = rows.indexOf(this.exactMessage(chat,packet.before)); rows = rows.slice(0,index); }
      const page=pageRows(rows.map(m=>this.view(m)),limit,{latest:true});
      return {chatId:chat,messages:page.items,coverage:this.coverage({hasMore:page.hasMore,nextBeforeId:page.hasMore?page.items[0].id:null})};
    }
    if (command === 'members') {
      requireThat(chat.endsWith('@g.us'), 'group_required'); const meta = await this.socket.groupMetadata(chat);
      return {chatId:chat,participants:meta.participants.slice(0,limit).map(p=>({id:p.id,role:p.admin || 'member'})),coverage:{complete:meta.participants.length<=limit,total:meta.participants.length}};
    }
    if (command === 'download') return this.download(packet,chat);
    return this.mutate(packet,chat);
  }
  async download(packet,chat) {
    const raw = this.exactMessage(chat,packet.messageId), view = messageView(raw,this.sdk);
    requireThat(view.attachment && view.attachment.size && view.attachment.size <= 32*1024*1024, 'attachment_unavailable_or_too_large');
    // view-once media is deliberately excluded: exporting it would defeat the
    // sender's limited-view semantics, even though the protocol can decode it.
    requireThat(!restrictedMedia(raw.message), 'view_once_not_exportable');
    requireThat(packet.output && path.isAbsolute(packet.output), 'absolute_output_required');
    // fs.open alone cannot guarantee the exact owner SID under elevation.
    requireThat(process.platform !== 'win32', 'attachment_export_not_supported_on_windows');
    const handle = await fs.open(packet.output,'wx',0o600);
    try {
      const stream = await this.sdk.downloadMediaMessage(raw,'stream',{}, {logger:this.logger,reuploadRequest:undefined}); let size=0;
      for await (const chunk of stream) { await this.permit(); size+=chunk.length; requireThat(size<=32*1024*1024,'attachment_too_large'); await handle.writeFile(chunk); }
      await handle.sync(); return {chatId:chat,messageId:raw.key.id,output:packet.output,size};
    } catch(error) { await handle.close(); await fs.rm(packet.output); throw error; }
    finally { await handle.close().catch(()=>{}); }
  }
  async mutate(packet,chat) {
    requireThat(this.data.policy !== 'read-only', 'read_only_policy');
    const command=packet.command, target=['reply','react','edit','delete','forward'].includes(command)?this.exactMessage(chat,packet.messageId):null;
    if (command==='forward') requireThat(!restrictedMedia(target.message),'view_once_not_exportable');
    if (['edit','delete'].includes(command)) requireThat(target.key.fromMe,'own_message_required');
    if (['send','reply','edit'].includes(command)) requireThat(packet.text?.length || (command==='send' && (packet.file || packet.contact)),'message_required');
    if (command==='react') requireThat(typeof packet.text==='string' && packet.text.length<=32,'reaction_invalid');
    if (['member-add','member-remove','member-promote','member-demote','chat-update','group-invite-revoke'].includes(command)) requireThat(chat.endsWith('@g.us'),'group_required');
    if (['member-add','member-remove','member-promote','member-demote','create-group'].includes(command)) requireThat(packet.participants?.length,'participants_required');
    if (command==='create-group') requireThat(packet.title?.trim() && packet.title.length<=100,'title_required');
    if (command==='chat-update') requireThat(Boolean(packet.title)!==Boolean(packet.description),'one_group_field_required');
    const forwardTo=command==='forward'?this.exactChat(packet.target):null;
    const media = await prepareMedia(packet), file = media?.bytes, fileHash = media?.hash;
    try {
    const settings = {};
    if (command === 'chat-settings') {
      const fields = ['archive','pin','muteUntil'].filter(name => packet[name] !== undefined);
      requireThat(fields.length === 1, 'one_chat_setting_required');
      if (packet.archive !== undefined) {
        const last = this.messages(chat).at(-1); requireThat(last, 'chat_history_required_for_archive');
        settings.archive = packet.archive; settings.lastMessages = [{ key: last.key, messageTimestamp: last.messageTimestamp }];
      }
      if (packet.pin !== undefined) settings.pin = packet.pin;
      if (packet.muteUntil !== undefined) {
        requireThat(packet.muteUntil === null || packet.muteUntil > Date.now() && packet.muteUntil <= Date.now() + 366 * 86400000, 'mute_until_invalid');
        settings.mute = packet.muteUntil;
      }
    }
    if (command === 'block') requireThat(!chat.endsWith('@g.us') && typeof packet.blocked === 'boolean' && chat !== this.selfChatId(), 'block_target_invalid');
    const invite = command === 'group-join' ? this.inviteCode(packet.invite) : null;
    const previousInvite = command === 'group-invite-revoke' ? this.inviteCode(await this.socket.groupInviteCode(chat)) : null;
    const inviteGroup = invite ? this.groupView(await this.socket.groupGetInviteInfo(invite)) : null;
    const payload={command,chatId:chat,target:target?messageView(target,this.sdk):null,forwardTo,
      text:packet.text??null,fileName:packet.fileName??null,mimeType:packet.mimeType??null,fileHash:fileHash??null,
      mediaType:media?.type??null,contact:packet.contact??null,settings,blocked:packet.blocked??null,inviteGroup,invite,previousInvite,
      participants:packet.participants??null,title:packet.title??null,description:packet.description??null,requestId:packet.requestId};
    const hash=digest(JSON.stringify(payload));
    if (packet.dryRun) { this.approvals.set(hash,{expires:Date.now()+300000}); return {dryRun:true,payload,approvalHash:hash}; }
    // Every call retains its exact payload/one-use preview guard. confirm is
    // the agent's attestation for this invocation, based on exact user approval
    // or an explicit current-conversation sending allowance. Such an allowance
    // is never stored in the vault or inferred from another request.
    const approval=this.approvals.get(packet.approvalHash);
    requireThat(packet.confirm && hash===packet.approvalHash && approval && approval.expires>Date.now(),'exact_approval_required');
    this.approvals.delete(hash);
    // Claim durably before touching WhatsApp. Even a crash after send cannot
    // turn the same logical request into another message on the next session.
    requireThat(!this.data.attempts[packet.requestId],'request_already_attempted');
    requireThat(Object.keys(this.data.attempts).length<5000,'request_journal_full');
    // Allocate the provider ID before submission and persist it with the claim.
    // If sendMessage throws (or the process dies), result can correlate a later
    // synced acknowledgement without resending. Legacy claims remain unknown.
    const messageMutation=['send','reply','react','edit','delete','forward'].includes(command);
    const outgoingId=messageMutation?this.sdk.generateMessageIDV2(this.data.creds.me?.id):null;
    let recipientIds;
    const destination = forwardTo || chat;
    if (['send','reply','forward'].includes(command) && destination?.endsWith('@g.us')) {
      const meta = await this.socket.groupMetadata(destination);
      requireThat(meta.id === destination && Array.isArray(meta.participants) && meta.participants.length <= 2048, 'group_metadata_invalid');
      const self = [this.selfChatId(), this.sdk.jidNormalizedUser(this.socket.user?.lid || '')];
      recipientIds = [...new Set(meta.participants.map(row => this.sdk.jidNormalizedUser(row.id)).filter(id => isChatId(id) && !id.endsWith('@g.us') && !self.includes(id)))];
    }
    const claim={hash,state:'attempted',at:Date.now(),chatId:forwardTo||chat||inviteGroup?.chatId||null,messageId:outgoingId,
      ...(recipientIds ? { recipientIds } : {})};
    this.data.attempts[packet.requestId]=claim; await this.save();
    await this.permit();
    try {
      let result;
      const options={messageId:outgoingId};
      if (command==='send' || command==='reply') result=await this.socket.sendMessage(chat,media?.content||{text:packet.text,linkPreview:null},{...options,...(target?{quoted:target}:{})});
      else if (command==='react') result=await this.socket.sendMessage(chat,{react:{text:packet.text,key:target.key}},options);
      else if (command==='edit') result=await this.socket.sendMessage(chat,{text:packet.text,edit:target.key,linkPreview:null},options);
      else if (command==='delete') result=await this.socket.sendMessage(chat,{delete:target.key},options);
      else if (command==='forward') result=await this.socket.sendMessage(forwardTo,{forward:target},options);
      else if (command==='create-group') { result=await this.socket.groupCreate(packet.title,packet.participants); this.upsert(this.data.chats,[{id:result.id,name:result.subject}]); }
      else if (['member-add','member-remove','member-promote','member-demote'].includes(command)) result=await this.socket.groupParticipantsUpdate(chat,packet.participants,command.slice('member-'.length));
      else if (command==='chat-update') result=packet.title?await this.socket.groupUpdateSubject(chat,packet.title):await this.socket.groupUpdateDescription(chat,packet.description);
      else if (command==='chat-settings') result=await this.socket.chatModify(settings,chat);
      else if (command==='block') result=await this.socket.updateBlockStatus(chat,packet.blocked?'block':'unblock');
      else if (command==='group-invite-revoke') result=await this.socket.groupRevokeInvite(chat);
      else if (command==='group-join') result=await this.socket.groupAcceptInvite(invite);
      else throw new RuntimeError('unsupported_mutation');
      if (result?.key && result.message) this.ingest([result]);
      const messageId=result?.key?.id||null;
      const outcome={requestId:packet.requestId,chatId:forwardTo||chat||inviteGroup?.chatId||result?.id||null,messageId,state:'submitted',verified:false};
      if (command==='group-join') {
        requireThat(result === inviteGroup.chatId, 'joined_group_mismatch');
        const current = this.groupView(await this.socket.groupMetadata(result)); this.upsert(this.data.chats,[{id:result,name:current.title}]);
        outcome.state='applied'; outcome.verified=true;
      }
      if (command==='group-invite-revoke') {
        const code=this.inviteCode(result), current=await this.socket.groupInviteCode(chat);
        requireThat(current===code && code!==previousInvite,'invite_readback_mismatch'); outcome.inviteUrl=`https://chat.whatsapp.com/${code}`; outcome.state='applied'; outcome.verified=true;
      }
      if (command==='block') {
        const ids=await this.socket.fetchBlocklist();
        // Either address form can be used by the blocklist. Resolve only
        // the matching local direction, never infer absence from a PN/LID mismatch.
        const mapping=this.socket.signalRepository?.lidMapping;
        const alternate=chat.endsWith('@lid')?await mapping?.getPNForLID(chat):await mapping?.getLIDForPN(chat);
        const aliases=[chat,alternate];
        const blocked=ids.some(id=>aliases.includes(this.sdk.jidNormalizedUser(id)));
        outcome.verified=blocked===packet.blocked; outcome.state=outcome.verified?'applied':'submitted';
      }
      if (command==='chat-settings') {
        const current=this.data.chats[chat];
        const matches=current && (packet.archive!==undefined ? current.archived===packet.archive
          : packet.pin!==undefined ? current.pinned!==undefined && Boolean(current.pinned)===packet.pin
          : current.muteEndTime!==undefined && (current.muteEndTime===null ? null : stamp(current.muteEndTime))===packet.muteUntil);
        outcome.verified=Boolean(matches); outcome.state=matches?'applied':'submitted';
      }
      if (['member-add','member-remove','member-promote','member-demote'].includes(command)) {
        outcome.participants=result.map(row=>({id:row.jid,status:String(row.status)}));
        outcome.state=result.every(row=>String(row.status)==='200')?'applied':'partial_or_rejected';
      }
      // Resolving sendMessage proves submission, not delivery/read. A later
      // status update can prove the server acknowledgement for the exact ID.
      // The server ACK may arrive while sendMessage is still resolving. Retain
      // confirmation already recorded against the durable pre-submission claim.
      this.data.attempts[packet.requestId]={...this.data.attempts[packet.requestId],hash,...outcome}; await this.save();
      if (!messageMutation) return outcome;
      const confirmation = await this.waitForConfirmation(packet.requestId);
      return { ...outcome, ...confirmation, verified: confirmation.serverAcknowledged };
    } catch(error) { this.data.attempts[packet.requestId]={...this.data.attempts[packet.requestId],...claim,state:'ambiguous'}; await this.save(); throw new RuntimeError('mutation_result_ambiguous'); }
    } finally { file?.fill(0); }
  }
  close() { this.closed=true; this.generation=(this.generation||0)+1; clearTimeout(this.reconnectTimer); this.socket?.end(undefined); this.connected=false; this.wakeConfirmations(true); for(const wake of this.historyWaiters) wake(); }
}
