import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { projectMaxMonitorSnapshot, parseMaxMonitorCursor, projectMaxMessageReference,
  readMaxMessageReference, parseArguments, validateCommandOptions, runtimeErrorPayload,
} from '../scripts/trelio-max.mjs';

const identity = { companyId: '11111111-1111-4111-8111-111111111111',
  memberId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333' };
const account = { id: '44444444-4444-4444-8444-444444444444', companyBinding: 'a'.repeat(64), providerRef: null };
const chat = 'https://web.max.ru/123';
const environment = { TRELIO_SKILL_ID: 'max-web', TRELIO_SKILL_RUNTIME_VERSION: '2.10.1',
  TRELIO_SKILL_COMPANY_ID: identity.companyId, TRELIO_SKILL_MEMBER_ID: identity.memberId,
  TRELIO_SKILL_CONNECTION_ID: identity.connectionId };
const row = (id = 'm1', text = 'Synthetic text', extra = {}) => ({ providerMessageId: id, text,
  replyText: null, attachments: [], ...extra });
const snapshot = messages => ({ chatReference: { url: chat, stableId: '123' }, messages });
const monitorOptions = { ...identity, account, chat, limit: 20 };
const digest = message => createHash('sha256').update(JSON.stringify([message.providerMessageId, message.text,
  message.replyText ?? null, message.attachments.map(item => [item.kind ?? null, item.name ?? null])])).digest('hex');
const options = (message = row()) => ({ ...parseArguments(['read-reference', '--chat', chat,
  '--message-id', message.providerMessageId, '--expected-revision', digest(message), '--expected-scope',
  parseMaxMonitorCursor(projectMaxMonitorSnapshot(snapshot([message]), monitorOptions).nextCursor).scope], environment), account });
const hasCode = code => error => { assert.equal(error.code, code); return true; };

test('exact MAX read shares monitor digest and returns only selected rendered content', () => {
  const target = row('m1', 'Точный текст 👋🏽', { author: '@not_an_owner', timestamp: 'PRIVATE_TIME',
    attachments: [{ kind: 'a', name: 'file.pdf', href: 'https://web.max.ru/file?PRIVATE_TOKEN' }] });
  const value = projectMaxMessageReference(snapshot([row('other', 'PRIVATE_OTHER_BODY'), target]), options(target));
  assert.equal(value.protocol, 'max-message-read/v1');
  assert.equal(value.reference.revision, digest(target));
  assert.equal(value.reference.messageId, 'm1');
  assert.equal(value.reference.senderUserId, null);
  assert.equal(value.reference.senderNamespace, null);
  assert.equal(Object.hasOwn(value.reference, 'kind'), false);
  assert.deepEqual(value.message, { id: 'm1', text: 'Точный текст 👋🏽', replyText: null,
    attachments: [{ kind: 'a', name: 'file.pdf' }] });
  assert.deepEqual(value.coverage, { renderedTextComplete: true, hiddenContentIncluded: false,
    attachmentsContentRead: false, otherMessagesIncluded: false, ownerIdentityAvailable: false });
  assert.deepEqual(value.readState, { marksRead: false, readReceiptsSent: false });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|not_an_owner|href/u);
});

test('changed message or source binding cannot be read as the original queued event', () => {
  const expected = options();
  for (const changed of [row('m1', 'New body'), row('m1', 'Synthetic text', { replyText: 'New quote' }),
    row('m1', 'Synthetic text', { attachments: [{ kind: 'img', name: 'new' }] })]) {
    assert.throws(() => projectMaxMessageReference(snapshot([changed]), expected), hasCode('MAX_REFERENCE_CHANGED'));
  }
  for (const change of [{ companyId: account.id }, { memberId: account.id }, { connectionId: account.id },
    { account: { ...account, id: identity.memberId } }, { account: { ...account, companyBinding: 'b'.repeat(64) } }]) {
    assert.throws(() => projectMaxMessageReference(snapshot([row()]), { ...expected, ...change }), hasCode('MAX_REFERENCE_CHANGED'));
  }
  assert.throws(() => projectMaxMessageReference(snapshot([row('m2')]), expected), hasCode('MAX_REFERENCE_UNAVAILABLE'));
  assert.throws(() => projectMaxMessageReference({ ...snapshot([]), emptyState: 'direct-chat-empty' }, expected), hasCode('MAX_REFERENCE_UNAVAILABLE'));
});

test('oversized full projection refuses instead of silently truncating text or media', () => {
  const target = row('m1', '字'.repeat(65536), { replyText: '字'.repeat(65536) });
  assert.throws(() => projectMaxMessageReference(snapshot([target]), options(target)), hasCode('MAX_REFERENCE_INCOMPLETE'));
  assert.throws(() => projectMaxMessageReference(snapshot([row('m1', 'Synthetic text', { attachmentsTruncated: true })]), options()),
    hasCode('MAX_MONITOR_REFERENCE_UNAVAILABLE'));
});

test('reference argument validation precedes browser, local file and mutation I/O', async () => {
  const valid = options();
  validateCommandOptions(valid);
  for (const patch of [{ messageId: 'name with spaces' }, { expectedRevision: 'A'.repeat(64) },
    { expectedScope: 'bad' }, { confirm: true }, { pages: 2 }, { limit: 100 }, { cursor: 'x' },
    { messageFile: '/never-read' }, { files: ['/never-read'] }, { output: '/never-write' },
    { query: 'Name' }, { targetText: 'Text' }, { contextRef: 'https://trelio.ru/example/project/tasks/30/' }]) {
    await assert.rejects(readMaxMessageReference(new Proxy({}, { get: () => assert.fail('No browser access') }), { ...valid, ...patch }));
  }
  for (const command of ['read', 'monitor', 'send']) {
    assert.throws(() => validateCommandOptions({ ...valid, command }), hasCode('MAX_REFERENCE_INPUT_INVALID'));
  }
});

test('real common DOM extraction returns the exact target without receipt or quote fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-reference-dom-'));
  const previous = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = root;
  try {
    const { window, document } = parseHTML('<html><body><main><button aria-label="Открыть профиль Synthetic"></button>'
      + '<div class="history"><div class="messageWrapper" data-message-id="m1">Точный текст</div>'
      + '<div class="messageWrapper" data-message-id="m2">PRIVATE_OTHER_DOM</div>'
      + '<div contenteditable="true"></div></div></main></body></html>');
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 60 });
    const context = vm.createContext({ document, window: { location: new URL(chat),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
      HTMLElement: window.HTMLElement, HTMLAnchorElement: window.HTMLAnchorElement });
    const page = { url: () => chat, goto: async () => {}, waitForFunction: async () => {},
      waitForTimeout: async () => {}, getByText: () => ({ count: async () => 0 }), getByRole: () => ({ count: async () => 0 }),
      evaluate: async (callback, argument) => {
        context.argument = argument;
        return JSON.parse(JSON.stringify(vm.runInContext(`(${callback.toString()})(argument)`, context)));
      } };
    const expected = options(row('m1', 'Точный текст'));
    const value = await readMaxMessageReference(page, expected);
    assert.equal(value.message.text, 'Точный текст');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_OTHER_DOM/u);
    assert.equal(value.readState.readReceiptsSent, false);
    // A real DOM duplicate must not disappear in the human reader's dedup
    // before the native reference validator can detect ambiguity.
    document.querySelector('.history').insertAdjacentHTML('beforeend', '<div class="messageWrapper" data-message-id="m1">DIFFERENT_PRIVATE_BODY</div>');
    await assert.rejects(readMaxMessageReference(page, expected), error => {
      assert.equal(error.code, 'MAX_REFERENCE_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(runtimeErrorPayload(error)), /PRIVATE|DIFFERENT/u);
      return true;
    });
    document.querySelector('.history').lastElementChild.remove();
    document.querySelector('[data-message-id="m1"]').insertAdjacentHTML('beforeend', '<img alt="image">'.repeat(21));
    await assert.rejects(readMaxMessageReference(page, expected), hasCode('MAX_REFERENCE_UNAVAILABLE'));
  } finally {
    if (previous === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
