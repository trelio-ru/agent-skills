import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { projectMaxMonitorSnapshot, parseMaxMonitorCursor, readMaxMonitor,
  parseArguments, validateCommandOptions, runtimeErrorPayload, installDocumentHttpObserver, maxConversationReference, outgoingMaxConversationReference,
} from '../scripts/trelio-max.mjs';

// Fixed synthetic identities only. Production obtains these from the signed
// host account, not a displayed author, a chat title or an incoming command.
const identity = {
  companyId: '11111111-1111-4111-8111-111111111111',
  memberId: '22222222-2222-4222-8222-222222222222',
  connectionId: '33333333-3333-4333-8333-333333333333',
};
const options = { ...identity, chat: 'https://web.max.ru/123', limit: 20,
  account: { id: '44444444-4444-4444-8444-444444444444', companyBinding: 'a'.repeat(64), providerRef: null } };
const environment = { TRELIO_SKILL_ID: 'max-web', TRELIO_SKILL_RUNTIME_VERSION: '2.10.0',
  TRELIO_SKILL_COMPANY_ID: identity.companyId, TRELIO_SKILL_MEMBER_ID: identity.memberId,
  TRELIO_SKILL_CONNECTION_ID: identity.connectionId };
const message = (id, text = `Synthetic ${id}`, extra = {}) => ({ providerMessageId: id,
  text, replyText: null, attachments: [], ...extra });
const snapshot = messages => ({ chatReference: { url: options.chat, stableId: '123' }, messages });
const monitor = (messages, overrides = {}) => projectMaxMonitorSnapshot(snapshot(messages), { ...options, ...overrides });
const cursor = messages => monitor(messages).nextCursor;
const hasCode = code => error => { assert.equal(error.code, code); return true; };

test('MAX monitor baseline is an explicit position, not unread backfill or owner proof', () => {
  const result = monitor([message('m1'), message('m2')]);
  assert.equal(result.baselineOnly, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.hasMore, false);
  assert.equal(parseMaxMonitorCursor(result.nextCursor).anchorId, 'm2');
  assert.deepEqual(result.coverage, { historicalBackfill: false, earlierEditsIncluded: false,
    otherChatsIncluded: false, ownerIdentityAvailable: false });
  assert.deepEqual(result.readState, { readReceiptsSent: false });
  assert.deepEqual(monitor([message('m1'), message('m2')], { cursor: result.nextCursor }).events, []);
});

test('MAX monitor pages from a real overlapping ID without dropping pending messages', () => {
  const rows = ['m1', 'm2', 'm3', 'm4'].map(id => message(id));
  let position = cursor(rows.slice(0, 1));
  for (const id of ['m2', 'm3', 'm4']) {
    const page = monitor(rows, { cursor: position, limit: 1 });
    assert.deepEqual(page.events.map(row => row.messageId), [id]);
    assert.equal(page.hasMore, id !== 'm4');
    assert.equal(page.baselineOnly, false);
    assert.notEqual(page.nextCursor, position);
    position = page.nextCursor;
  }
  assert.deepEqual(monitor(rows, { cursor: position }).events, []);
});

test('MAX edited anchor consumes a page before new messages; earlier edits remain outside coverage', () => {
  const previous = cursor([message('m0'), message('m1')]);
  const rows = [message('m0', 'Earlier edit'), message('m1', 'Changed anchor'), message('m2')];
  const edit = monitor(rows, { cursor: previous, limit: 1 });
  assert.deepEqual(edit.events.map(row => [row.messageId, row.kind]), [['m1', 'edit']]);
  assert.equal(edit.hasMore, true);
  const next = monitor(rows, { cursor: edit.nextCursor });
  assert.deepEqual(next.events.map(row => [row.messageId, row.kind]), [['m2', 'new']]);
});

test('MAX queue references never contain content, author identity guesses or signed file URLs', () => {
  const base = cursor([message('m1')]);
  const privateRow = message('m2', 'PRIVATE_MESSAGE_+12025550123', { author: '@owner_alias',
    timestamp: 'PRIVATE_TIME', replyText: 'PRIVATE_QUOTED_OWNER',
    attachments: [{ kind: 'document', name: 'PRIVATE_FILE', href: 'https://web.max.ru/file?token=PRIVATE_TOKEN' }] });
  const result = monitor([message('m1'), privateRow], { cursor: base });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|owner_alias|12025550123/u);
  assert.equal(result.events[0].senderUserId, null);
  assert.equal(result.events[0].senderNamespace, null);
  assert.equal(result.events[0].id, 'message:m2');
  const churn = monitor([message('m1'), { ...privateRow, author: 'Changed display name', timestamp: 'Tomorrow',
    attachments: [{ ...privateRow.attachments[0], href: 'https://web.max.ru/other?token=ROTATED' }] }],
  { cursor: result.nextCursor });
  assert.deepEqual(churn.events, []);
});

test('MAX scope binds company, member, connection, selected account and company binding', () => {
  const previous = cursor([message('m1')]);
  for (const key of ['companyId', 'memberId', 'connectionId']) {
    assert.throws(() => monitor([message('m1')], { cursor: previous, [key]: '55555555-5555-4555-8555-555555555555' }), hasCode('MAX_MONITOR_SCOPE_CHANGED'));
  }
  for (const account of [null, { ...options.account, id: identity.companyId },
    { ...options.account, companyBinding: 'b'.repeat(64) }, { id: 'invalid', companyBinding: 'a'.repeat(64) }]) {
    assert.throws(() => monitor([message('m1')], { cursor: previous, account }), hasCode('MAX_MONITOR_SCOPE_CHANGED'));
  }
  for (const reference of [{ url: options.chat, stableId: '456' },
    { url: 'https://web.max.ru/456', stableId: '456' }, { url: 'https://example.org/123', stableId: '123' }]) {
    assert.throws(() => projectMaxMonitorSnapshot({ ...snapshot([message('m1')]), chatReference: reference }, options), hasCode('MAX_MONITOR_SCOPE_CHANGED'));
  }
  assert.throws(() => monitor([message('m1')], { memberId: undefined }), hasCode('MAX_MONITOR_SCOPE_CHANGED'));
});

test('MAX gap or unverified empty history cannot reset the previous checkpoint', () => {
  const previous = cursor([message('m1')]);
  for (const rows of [[], [message('m2')], Array.from({ length: 501 }, (_, i) => message(`m${i}`))]) {
    assert.throws(() => monitor(rows, { cursor: previous }), hasCode('MAX_MONITOR_GAP'));
  }
  assert.throws(() => monitor([]), hasCode('MAX_MONITOR_GAP'));
  const empty = projectMaxMonitorSnapshot({ ...snapshot([]), emptyState: 'direct-chat-empty' }, options);
  assert.equal(parseMaxMonitorCursor(empty.nextCursor).anchorId, null);
  assert.equal(projectMaxMonitorSnapshot({ ...snapshot([]), emptyState: 'direct-chat-empty' },
    { ...options, cursor: empty.nextCursor }).nextCursor, empty.nextCursor);
  assert.throws(() => monitor([message('m1')], { cursor: empty.nextCursor }), hasCode('MAX_MONITOR_GAP'));
});

test('MAX rejects unstable IDs, malformed payload shapes and oversized bounds before projection', () => {
  const invalid = [message(null), message(''), message('has space'), message('a\u00a0b'),
    { ...message(null), messageKey: 'local-text-hash' }, message('x'.repeat(257)),
    message('m1', 'x'.repeat(65537)), message('m1', 'x', { replyText: {} }),
    message('m1', 'x', { attachments: [{ kind: {}, name: 'file' }] }),
    message('m1', 'x', { attachments: [null] }), message('m1', 'x', { attachments: Array(21).fill({}) })];
  for (const row of invalid) assert.throws(() => monitor([row]), hasCode('MAX_MONITOR_REFERENCE_UNAVAILABLE'));
  assert.throws(() => monitor([message('m1'), message('m1')]), hasCode('MAX_MONITOR_REFERENCE_UNAVAILABLE'));
  for (const limit of [0, 101, 1.1]) assert.throws(() => monitor([message('m1')], { limit }), hasCode('MAX_MONITOR_GAP'));
});

test('MAX validates cursor syntax and exact read arguments before browser or local file IO', () => {
  for (const value of ['!', 'x'.repeat(2049), Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ ...parseMaxMonitorCursor(cursor([message('m1')])), extra: true })).toString('base64url')]) {
    assert.throws(() => parseMaxMonitorCursor(value), hasCode('MAX_MONITOR_INVALID_CURSOR'));
    const parsed = parseArguments(['monitor', '--chat', options.chat, '--cursor', value], environment);
    assert.throws(() => validateCommandOptions(parsed), hasCode('MAX_MONITOR_INVALID_CURSOR'));
  }
  for (const chat of ['', '123', 'Name', 'https://max.ru/123', 'https://web.max.ru/123/']) {
    const parsed = parseArguments(['monitor', ...(chat ? ['--chat', chat] : [])], environment);
    assert.throws(() => validateCommandOptions(parsed));
  }
  for (const extra of [['--confirm'], ['--query', 'Owner'], ['--reaction', 'like'], ['--contact', options.chat],
    ['--message-file', '/not-a-real-input'], ['--file', '/not-a-real-file'], ['--output', '/not-a-real-output'],
    ['--context-ref', 'https://trelio.ru/example/project/tasks/30/']]) {
    assert.throws(() => validateCommandOptions(parseArguments(['monitor', '--chat', options.chat, ...extra], environment)));
  }
  assert.throws(() => validateCommandOptions(parseArguments(['read', '--chat', options.chat, '--cursor', cursor([message('m1')])], environment)), hasCode('MAX_MONITOR_INVALID_CURSOR'));
  validateCommandOptions(parseArguments(['monitor', '--chat', options.chat, '--cursor', cursor([message('m1')])], environment));
});

test('MAX monitor preserves only safe main-document HTTP evidence', async () => {
  const runtime = await import(pathToFileURL(path.resolve('_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs')).href);
  for (const status of [401, 429, 503]) {
    const context = new EventEmitter();
    const frame = { page: () => page };
    const page = { context: () => context, mainFrame: () => frame, isClosed: () => false,
      url: () => options.chat, goto: async () => {
        const request = { isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame };
        context.emit('request', request);
        context.emit('response', { request: () => request, url: () => `${options.chat}?private=PRIVATE`, status: () => status });
        page.url = () => `${options.chat}?private=PRIVATE`;
      }, waitForFunction: async () => assert.fail('HTTP failure must precede UI/login') };
    installDocumentHttpObserver(context, runtime);
    await assert.rejects(readMaxMonitor(page, { ...options, command: 'monitor' }), error => {
      const payload = runtimeErrorPayload(error);
      assert.equal(payload.code, 'MAX_SERVICE_HTTP_ERROR');
      assert.deepEqual(payload.details, { httpStatus: status, origin: 'https://web.max.ru' });
      assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|token|\?/u);
      return true;
    });
  }
});

test('MAX monitor exercises the ordinary DOM reader without returning bodies or marking read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-dom-'));
  const previousHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = root;
  try {
    const { window, document } = parseHTML('<html><body><main><button aria-label="Открыть профиль Synthetic"></button>'
      + '<div class="history"><div class="messageWrapper" data-message-id="m1">PRIVATE_DOM_BODY</div>'
      + '<div contenteditable="true"></div></div></main></body></html>');
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 60 });
    const browserWindow = { location: new URL(options.chat),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    const context = vm.createContext({ document, window: browserWindow, HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement });
    const page = { url: () => options.chat, goto: async () => {}, waitForFunction: async () => {},
      waitForTimeout: async () => {}, getByText: () => ({ count: async () => 0 }),
      getByRole: () => ({ count: async () => 0 }), evaluate: async (callback, argument) => {
        context.argument = argument;
        return JSON.parse(JSON.stringify(vm.runInContext(`(${callback.toString()})(argument)`, context)));
      } };
    const baseline = await readMaxMonitor(page, { ...options, command: 'monitor', pages: 1, timeoutMs: 0 });
    document.querySelector('.history').insertAdjacentHTML('beforeend', '<div class="messageWrapper" data-message-id="m2">PRIVATE_NEW_BODY</div>');
    const result = await readMaxMonitor(page, { ...options, command: 'monitor', pages: 1, timeoutMs: 0, cursor: baseline.nextCursor });
    assert.deepEqual(result.events.map(row => row.messageId), ['m2']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
    assert.equal(result.readState.readReceiptsSent, false);
    // No page/browser protocol exposes a send, receipt, file download or
    // mutation method in this fixture; accidental effects fail the test.
  } finally {
    if (previousHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('MAX first-send hint and future native monitor event reuse one scope without granting identity or replay',async()=>{
  const native=rows=>({...snapshot(rows),nativeIdentityVerified:true});
  const row=(id)=>message(id,'synthetic',{senderUserId:'9',nativeRevision:'a'.repeat(64),nativeOutgoing:false,nativeForwarded:false});
  const selected={...options,conversationReferences:true};
  const outgoing=maxConversationReference(snapshot([]).chatReference,selected,true);
  const baseline=projectMaxMonitorSnapshot(native([row('1')]),selected);
  assert.equal(parseMaxMonitorCursor(baseline.nextCursor).scope,outgoing.scope);
  const reply=projectMaxMonitorSnapshot(native([row('1'),row('2')]),{...selected,cursor:baseline.nextCursor});
  assert.equal(reply.events[0].conversationKey,outgoing.conversationKey);
  assert.deepEqual(reply.readState,{readReceiptsSent:false});
  assert.notEqual(maxConversationReference(snapshot([]).chatReference,{...selected,account:{...selected.account,companyBinding:'b'.repeat(64)}},true).conversationKey,outgoing.conversationKey);
  assert.throws(()=>maxConversationReference({...snapshot([]).chatReference,stableId:'456'},selected,true));
  const page={url:()=>options.chat,evaluate:async()=>({ready:true,title:'PRIVATE_TITLE'}),context:()=>({})};
  assert.deepEqual(await outgoingMaxConversationReference(page,selected,{url:options.chat}),
    {available:false,code:'MAX_CONVERSATION_REFERENCE_UNAVAILABLE'},'no native observation is not a successful routing hint');
  const parsed=parseArguments(['send','--chat',options.chat,'--message','synthetic','--confirm','--conversation-reference'],environment);
  assert.equal(parsed.conversationReference,true);validateCommandOptions(parsed);
  assert.throws(()=>validateCommandOptions({...parsed,command:'read'}));
});
