import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  MaxRuntimeError, canRecoverAssistPreparation, chatReferencesPath,
  contextChatReference, inspectOpenedChatReference, knownChatReferences,
  loadChatReferences, normalizeChatContextRef, normalizeChatUrl, openChat,
  parseArguments, prepareAssistAuthorization, rememberChatReference,
  rememberOpenedChat, selectExactDialogResult, validateCommandOptions,
} from "../scripts/trelio-max.mjs";

const identity = {
  companyId: "11111111-1111-4111-8111-111111111111",
  memberId: "22222222-2222-4222-8222-222222222222",
  connectionId: "33333333-3333-4333-8333-333333333333",
};
const task = "https://trelio.ru/example/finance/tasks/92/";
const options = { ...identity, command: "read", chat: "Виктория", contextRef: task, limit: 20 };

// Every journal fixture uses an isolated host directory, including failures.
// No test is allowed to discover or modify the owner's actual MAX profile.
const withJournal = async (action) => {
  const previous = process.env.TRELIO_CONFIG_HOME;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "max-chat-references-"));
  process.env.TRELIO_CONFIG_HOME = temporary;
  try { await action(); } finally {
    if (previous === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

const chatPage = (html, initialUrl = "https://web.max.ru/123") => {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.style.display === "none" ? 0 : 300, height: 60 };
  };
  let currentUrl = initialUrl;
  const browserWindow = { getComputedStyle: () => ({ display: "block", visibility: "visible" }), get location() { return new URL(currentUrl); } };
  const context = vm.createContext({ document, window: browserWindow, HTMLElement: window.HTMLElement });
  return {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; },
    waitForFunction: async () => {},
    getByText: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 0 }),
    evaluate: async (callback) => JSON.parse(JSON.stringify(vm.runInContext(`(${callback.toString()})()`, context))),
  };
};
const surface = '<main><button aria-label="Открыть профиль Виктория"></button><div class="messageWrapper">Private message body</div><div contenteditable="true"></div></main>';

test("MAX ambiguity returns candidates and immediate read-only recovery without invented IDs", () => {
  const rows = [0, 1].map((index) => ({ index, title: "Виктория", identity: "виктория", url: null, stableId: null }));
  assert.throws(() => selectExactDialogResult(rows, "Виктория"), (error) => {
    assert.equal(error.code, "MAX_CHAT_AMBIGUOUS");
    assert.deepEqual(error.details.candidates, rows.map(() => ({ title: "Виктория", url: null, stableId: null })));
    assert.deepEqual(error.details.recoveryArguments, ["assist-start", "--fallback-for", "dialogs", "--query", "Виктория", "--limit", "20"]);
    assert.equal(error.details.finalMutationActionStarted, false);
    assert.equal(canRecoverAssistPreparation(error, "read-only"), true);
    assert.equal(canRecoverAssistPreparation(error, "manual-control"), false);
    return true;
  });
  assert.equal(canRecoverAssistPreparation(new Error("network timeout"), "read-only"), false);
});

test("MAX stores distinct provider URLs across invocations and does not bind discovery to a task", async () => withJournal(async () => {
  const first = rememberChatReference(options, { url: "https://max.ru/123/", title: "Виктория", messages: ["Private message body"] }, true);
  rememberChatReference(options, { url: "https://web.max.ru/456", title: "Виктория" });
  assert.equal(first.url, "https://web.max.ru/123");
  assert.equal(first.stableId, "123");
  assert.equal(first.contextMatched, true);
  assert.equal(loadChatReferences({ ...options }).chats.length, 2);
  assert.equal(contextChatReference({ ...options }), first.url);
  assert.equal(contextChatReference({ ...options, contextRef: "" }), null);
  assert.equal(contextChatReference({ ...options, contextRef: task.replace("92", "93") }), null);
  assert.equal(knownChatReferences({ ...options, command: "dialogs", query: "Виктория" }).length, 1);
  assert.equal(knownChatReferences({ ...options, contextRef: "", query: "Виктория" }).length, 2);
  for (const key of ["companyId", "memberId", "connectionId"]) {
    assert.equal(loadChatReferences({ ...options, [key]: "99999999-9999-4999-8999-999999999999" }).chats.length, 0);
  }
  const journal = fs.readFileSync(chatReferencesPath(options), "utf8");
  assert.doesNotMatch(journal, /Private message body|messages|identity/u);
  if (process.platform !== "win32") assert.equal(fs.statSync(chatReferencesPath(options)).mode & 0o777, 0o600);
}));

test("MAX task-bound read opens the original URL when another chat has the same title", async () => withJournal(async () => {
  rememberChatReference(options, { url: "https://web.max.ru/123", title: "Виктория" }, true);
  rememberChatReference(options, { url: "https://web.max.ru/456", title: "Виктория" });
  const page = chatPage(surface);
  const opened = await openChat(page, { ...options, timeoutMs: 50 });
  assert.equal(opened.method, "task-context");
  assert.equal(opened.url, "https://web.max.ru/123");
  assert.equal(page.url(), opened.url);
  // Reading two candidates with the same task context never silently replaces
  // the first choice: later use of that title must require an exact URL.
  rememberChatReference(options, { url: "https://web.max.ru/456", title: "Виктория" }, true);
  assert.throws(() => contextChatReference(options), (error) => error.code === "MAX_CHAT_AMBIGUOUS" && error.details.candidates.length === 2);
}));

test("MAX mutation cannot automatically use a task binding", async () => withJournal(async () => {
  rememberChatReference(options, { url: "https://web.max.ru/123", title: "Виктория" }, true);
  const mutation = { ...options, command: "send", members: [], message: "Test", confirm: true };
  assert.equal(contextChatReference(mutation), null);
  assert.throws(() => validateCommandOptions(mutation), /never select a mutation recipient/u);
  assert.throws(() => prepareAssistAuthorization({ ...mutation, command: "assist-start", fallbackFor: "send" }), /does not accept --context-ref/u);
}));

test("MAX journal fails closed for corrupt or symlinked metadata without replacing it", async () => withJournal(async () => {
  rememberChatReference(options, { url: "https://web.max.ru/123", title: "Виктория" }, true);
  const file = chatReferencesPath(options);
  fs.writeFileSync(file, '{"schemaVersion":1,"chats":[],"messages":"SECRET"}');
  assert.throws(() => loadChatReferences(options), (error) => error.code === "MAX_CHAT_REFERENCE_STORE_INVALID" && !error.message.includes("SECRET"));
  assert.match(fs.readFileSync(file, "utf8"), /SECRET/u);
  fs.unlinkSync(file);
  // Windows developer mode is not available on every hosted runner. Regular
  // metadata validation above remains mandatory on Windows; symlinks on Unix.
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(path.dirname(file), "missing-target.json"), file);
    assert.throws(() => rememberChatReference(options, { url: "https://web.max.ru/456" }), (error) => error.code === "MAX_CHAT_REFERENCE_STORE_INVALID");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  }
}));

test("MAX only records an opened ready chat and verifies its actual route", async () => withJournal(async () => {
  const page = chatPage(surface);
  assert.deepEqual(await inspectOpenedChatReference(page), { url: "https://web.max.ru/123", title: "Виктория" });
  assert.equal(await rememberOpenedChat(page, options, { url: "https://web.max.ru/456" }, true), null);
  assert.equal(loadChatReferences(options).chats.length, 0);
  const ref = await rememberOpenedChat(page, options, { url: "https://web.max.ru/123" }, true);
  assert.equal(ref.contextMatched, true);
  assert.equal(await inspectOpenedChatReference(chatPage('<aside><h3>Виктория</h3></aside>')), null);
  assert.equal(await inspectOpenedChatReference(chatPage(surface, "https://web.max.ru/")), null);
  assert.equal(await inspectOpenedChatReference(chatPage(surface, "https://example.com/123")), null);
  const changingPage = chatPage(surface);
  const evaluate = changingPage.evaluate;
  changingPage.evaluate = async (callback) => { const result = await evaluate(callback); await changingPage.goto("https://web.max.ru/456"); return result; };
  assert.equal(await inspectOpenedChatReference(changingPage), null);
}));

test("MAX journal evicts oldest records within its byte limit and keeps a refreshed chat", async () => withJournal(async () => {
  rememberChatReference(options, { url: "https://web.max.ru/123", title: "Виктория" }, true);
  const journal = loadChatReferences(options);
  const contexts = Array.from({ length: 32 }, (_, index) => `https://trelio.ru/${"c".repeat(440)}/finance/tasks/${index}/`);
  for (let index = 0; index < 67; index++) journal.chats.push({ url: `https://web.max.ru/${index + 500}`, titles: ["Test"], contextRefs: contexts, verifiedAt: new Date().toISOString() });
  fs.writeFileSync(chatReferencesPath(options), JSON.stringify(journal));
  assert.ok(fs.statSync(chatReferencesPath(options)).size < 1024 * 1024);
  rememberChatReference(options, { url: "https://web.max.ru/123", title: "Виктория" }, true);
  for (let index = 0; index < 32; index++) {
    rememberChatReference({ ...options, contextRef: contexts[index] }, { url: "https://web.max.ru/999", title: "New" }, true);
  }
  assert.ok(fs.statSync(chatReferencesPath(options)).size <= 1024 * 1024);
  const loaded = loadChatReferences(options);
  assert.ok(loaded.chats.some((chat) => chat.url === "https://web.max.ru/123"));
  assert.equal(loaded.chats.at(-1).url, "https://web.max.ru/999");
  assert.equal(loaded.chats.some((chat) => chat.url === "https://web.max.ru/500"), false);
}));

test("MAX task locator is canonical and cannot carry query, credentials or another origin", () => {
  assert.equal(normalizeChatContextRef(task.slice(0, -1)), task);
  assert.equal(normalizeChatUrl("https://max.ru/-123/"), "https://web.max.ru/-123");
  for (const value of ["https://example.com/example/finance/tasks/92/", `${task}?token=secret`, `${task}#private`, "https://user:secret@trelio.ru/example/finance/tasks/92/", "https://trelio.ru/example/finance/", `https://trelio.ru/${"c".repeat(600)}/finance/tasks/92/`]) {
    assert.throws(() => normalizeChatContextRef(value), (error) => error.code === "MAX_CHAT_CONTEXT_INVALID" && !error.message.includes("secret"));
  }
  const environment = { TRELIO_SKILL_ID: "max-web", TRELIO_SKILL_RUNTIME_VERSION: "2.8.11", TRELIO_SKILL_COMPANY_ID: identity.companyId, TRELIO_SKILL_MEMBER_ID: identity.memberId, TRELIO_SKILL_CONNECTION_ID: identity.connectionId };
  assert.equal(parseArguments(["read", "--chat", "123", "--context-ref", task], environment).contextRef, task);
});

test("MAX instructions require immediate ambiguity inspection and stable task-scoped reuse", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  for (const expected of ["MAX_CHAT_AMBIGUOUS", "chatReference", "knownChats", "--context-ref", "не повторяй", "assist-stop"]) assert.ok(skill.includes(expected), expected);
});
