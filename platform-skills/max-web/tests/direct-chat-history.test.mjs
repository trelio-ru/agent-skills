import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  inspectDirectChatHistorySurface, waitForDirectChatHistory, readChatMessages,
} from "../scripts/trelio-max.mjs";

// These fixtures model the public provider's structural empty-dialog marker;
// no owner's browser/profile or actual contact/message is read by a test.
const emptyHistory = '<div class="emptyHistory"><div class="wrapper"><span>Сообщений пока нет</span><span>Напишите сообщение</span></div></div>';
const shell = (history = emptyHistory, editor = "") => '<main><button aria-label="Открыть профиль Test Contact"></button>'
  + `<div class="history">${history}<div class="composer" data-testid="composer"><div role="textbox" contenteditable="${editor}"></div></div></div></main>`;
const opened = { method: "url", url: "https://web.max.ru/123" };
const options = { chat: opened.url, command: "read", timeoutMs: 0, limit: 20, pages: 1 };
const pageFor = (html, route = opened.url) => {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.style.display === "none" ? 0 : 300, height: 60 };
  };
  let url = route;
  const browserWindow = { get location() { return new URL(url); },
    getComputedStyle: (node) => ({ display: node.style.display || "block", visibility: node.style.visibility || "visible" }) };
  const context = vm.createContext({ document, window: browserWindow, HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement });
  const page = {
    url: () => url,
    setUrl: (value) => { url = value; },
    setHtml: (value) => { document.body.innerHTML = value; },
    goto: async (value) => { url = value; },
    waitForFunction: async () => {},
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getByText: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 0 }),
    evaluate: async (callback, argument) => {
      context.argument = argument;
      return JSON.parse(JSON.stringify(vm.runInContext(`(${callback.toString()})(argument)`, context)));
    },
  };
  return page;
};

test("MAX recognizes provider empty direct history and returns a normal exact read", async () => {
  for (const editor of ["", "true", "plaintext-only"]) {
    for (const placeholder of [emptyHistory, emptyHistory.replace("Сообщений пока нет", "No messages yet")]) {
      const page = pageFor(shell(placeholder, editor));
      assert.equal((await inspectDirectChatHistorySurface(page)).emptyPlaceholderVisible, true);
      const result = await readChatMessages(page, options);
      assert.equal(result.emptyState, "direct-chat-empty");
      assert.deepEqual(result.messages, []);
      assert.equal(result.chatReference.url, opened.url);
      assert.equal(result.chatReference.stableId, "123");
    }
  }
});

test("MAX waits the bounded empty window and prefers messages hydrated during it", async () => {
  const page = pageFor(shell());
  let waits = 0;
  page.waitForTimeout = async () => {
    waits += 1;
    page.setHtml(shell('<div class="messageWrapper" data-message-id="m1">Loaded test message</div>'));
  };
  const result = await readChatMessages(page, { ...options, timeoutMs: 50 });
  assert.equal(waits, 1);
  assert.equal(result.emptyState, undefined);
  assert.equal(result.messages[0].providerMessageId, "m1");

  const empty = pageFor(shell());
  const start = Date.now();
  assert.equal(await waitForDirectChatHistory(empty, opened, { timeoutMs: 30 }), "direct-chat-empty");
  assert.ok(Date.now() - start >= 30);
});

test("MAX recognizes one nested openedChat history but rejects independent histories and busy shells", async () => {
  // The public provider wraps the history component in openedChat > .history;
  // model both containers rather than flattening the real routed surface.
  const nested = shell().replace('<div class="history">', '<div class="openedChat"><div class="history"><div class="history">')
    .replace('</main>', '</div></div></main>');
  const result = await readChatMessages(pageFor(nested), options);
  assert.equal(result.emptyState, "direct-chat-empty");
  assert.deepEqual(result.messages, []);
  assert.equal(result.chatReference.url, opened.url);

  for (const html of [
    nested.replace('class="openedChat"><div class="history"', 'class="openedChat"><div class="history" aria-busy="true"'),
    nested.replace('</main>', '<div class="history">' + emptyHistory + '<textarea></textarea></div></main>'),
    nested.replace('<div class="openedChat"><div class="history">', '<div class="openedChat"><div class="history"><div class="loader"></div>'),
  ]) {
    await assert.rejects(() => waitForDirectChatHistory(pageFor(html), opened, options),
      (error) => error.code === "MAX_UI_UNSUPPORTED" && error.details.finalMutationActionStarted === false);
  }
});

test("MAX fails closed for shells, loading, blocked state and conflicting message nodes", async () => {
  const fixtures = [
    shell(""),
    shell(emptyHistory + '<div class="loader"></div>'),
    shell(emptyHistory + '<div aria-busy="true"></div>'),
    shell(emptyHistory + '<div role="progressbar"></div>'),
    shell().replace('class="history"', 'class="history" aria-busy="true"'),
    shell(emptyHistory.replace("Сообщений пока нет", "Профиль заблокирован")),
    shell(emptyHistory, "false"),
    shell(emptyHistory + '<div class="messageWrapper"></div>'),
    shell(emptyHistory + '<div data-message-id="unparsed"></div>'),
    shell(emptyHistory + '<div class="message"></div>'),
    shell(emptyHistory.replace('class="emptyHistory"', 'class="emptyHistory" style="display:none"')),
    shell(emptyHistory.replace('class="emptyHistory"', 'class="emptyHistory" style="visibility:hidden"')),
    shell(emptyHistory.replace('<span>Сообщений пока нет', '<span style="display:none">Сообщений пока нет')),
    shell().replace('aria-label="Открыть профиль Test Contact"', 'aria-label="Другое действие"'),
    shell().replace('class="history"', 'class="unknownHistory"'),
    shell().replace('</main>', '<div class="history"></div></main>'),
    `<aside>${emptyHistory}</aside>${shell("")}`,
  ];
  for (const html of fixtures) {
    await assert.rejects(() => waitForDirectChatHistory(pageFor(html), opened, options),
      (error) => error.code === "MAX_UI_UNSUPPORTED"
        && error.details.reason === "history-empty-unverified"
        && error.details.finalMutationActionStarted === false
        && !JSON.stringify(error.details).includes("Test Contact"));
  }
  const quoted = await readChatMessages(pageFor(shell('<div class="messageWrapper"><span>Сообщений пока нет</span></div>')), options);
  assert.equal(quoted.messages.length, 1);
  assert.equal(quoted.emptyState, undefined);
});

test("MAX does not reuse personal empty markers for Favorites, groups, bots or other routes", async () => {
  for (const route of ["0", "-123", "goskey_bot"]) {
    const url = `https://web.max.ru/${route}`;
    await assert.rejects(() => waitForDirectChatHistory(pageFor(shell(), url), { url }, options),
      (error) => error.code === "MAX_UI_UNSUPPORTED");
  }
  assert.equal(await waitForDirectChatHistory(pageFor(shell(), "https://web.max.ru/u/test"),
    { url: "https://web.max.ru/u/test" }, options), "direct-chat-empty");
  for (const route of ["https://web.max.ru/456", "https://web.max.ru/"]) {
    await assert.rejects(() => waitForDirectChatHistory(pageFor(shell(), route), opened, options),
      (error) => error.code === "MAX_CHAT_IDENTITY_UNVERIFIED");
  }
});

test("MAX detects route changes during hydration and during the final DOM inspection", async () => {
  const page = pageFor(shell());
  page.waitForTimeout = async () => page.setUrl("https://web.max.ru/456");
  await assert.rejects(() => waitForDirectChatHistory(page, opened, { timeoutMs: 50 }),
    (error) => error.code === "MAX_CHAT_IDENTITY_UNVERIFIED");
  const changed = pageFor(shell());
  const evaluate = changed.evaluate;
  changed.evaluate = async (...args) => {
    const state = await evaluate(...args);
    changed.setUrl("https://web.max.ru/456");
    return state;
  };
  await assert.rejects(() => waitForDirectChatHistory(changed, opened, options),
    (error) => error.code === "MAX_CHAT_IDENTITY_UNVERIFIED");
});
