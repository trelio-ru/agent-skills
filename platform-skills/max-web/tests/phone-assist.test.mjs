import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { assistInteractionAllowed, canRecoverAssistPreparation, installMaxAssistGate,
  lookupContactByPhone, MaxRuntimeError, openChat } from "../scripts/trelio-max.mjs";

const action = { kind: "click", tag: "button", label: "Найти по номеру",
  pathname: "/", fallbackFor: "read", box: { x: 20, y: 160, width: 320, height: 52 } };

test("MAX permits only the exact home phone search action in read-only assist", () => {
  for (const fallbackFor of ["read", "profile", "contacts", "dialogs", "unread", "watch"]) {
    for (const label of ["Найти по номеру", "Find by phone", "Найти по номеру +12025550123"]) {
      assert.equal(assistInteractionAllowed({ ...action, fallbackFor, label }), true);
    }
  }
  for (const patch of [{ pathname: "/123" }, { fallbackFor: "send" }, { kind: "fill" },
    { tag: "div" }, { label: "Продолжить" }, { label: "Найти по номеру и отправить" },
    { href: "https://example.test/" }, { box: { x: 900, y: 80, width: 120, height: 40 } }]) {
    assert.equal(assistInteractionAllowed({ ...action, ...patch }), false);
  }
  assert.equal(canRecoverAssistPreparation(new Error("network timeout"), "read-only"), false);
  assert.equal(canRecoverAssistPreparation(new MaxRuntimeError("MAX_HTTP_ERROR", "HTTP 503"), "read-only"), false);
});

test("MAX cold contact lookup survives the actual read-only browser event fence", async () => {
  const previous = process.env.TRELIO_CONFIG_HOME;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "max-phone-assist-"));
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const home = '<aside><input id="search" type="search" placeholder="Поиск">'
      + '<button id="lookup">Найти по номеру</button></aside>';
    const chat = '<main><header><button aria-label="Открыть профиль Test Contact"></button></header>'
      + '<div class="history"><div class="emptyHistory">Сообщений пока нет</div>'
      + '<div id="composer" role="textbox" contenteditable=""></div></div></main>';
    const { window, document } = parseHTML(`<html><body>${home}</body></html>`);
    let route = "https://web.max.ru/";
    // linkedom's Window proxy stores arbitrary properties in a shared global.
    // Keep the immutable gate and route on a private browser facade so this
    // imported regression cannot contaminate another test's native gate.
    const browserWindow = { location: new URL(route), innerWidth: 1280,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      addEventListener: (...args) => window.addEventListener(...args) };
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.id === "composer" ? { x: 700, y: 820, width: 400, height: 48 }
        : { x: 20, y: this.id === "search" ? 40 : 160, width: 320, height: 52 };
    };
    const context = vm.createContext({ window: browserWindow, document, URL, Element: window.Element,
      HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement, MutationObserver: window.MutationObserver });
    vm.runInContext(`(${installMaxAssistGate.toString()})({mode:"read-only",fallbackFor:"read"})`, context);
    const setSurface = (url, html) => { route = url; browserWindow.location = new URL(url); document.body.innerHTML = html; };
    const search = { first() { return this; }, count: async () => 1, isVisible: async () => true,
      click: async () => {}, fill: async () => {} };
    let openContact = true;
    let successfulClicks = 0;
    const page = { url: () => route, goto: async () => setSurface("https://web.max.ru/", home),
      waitForFunction: async () => {}, waitForTimeout: async () => {},
      getByPlaceholder: () => search, getByText: () => ({ count: async () => 0 }),
      locator: () => ({ first() { return this; }, count: async () => 0 }),
      getByRole: (_role, { name }) => String(name).includes("найти по номеру")
        ? { count: async () => 1, isVisible: async () => true, click: async () => {
          // Model a provider handler after the real capture fence. Before the
          // fix this event was cancelled, so no contact route could appear.
          const event = new window.Event("click", { bubbles: true, cancelable: true });
          document.querySelector("#lookup").dispatchEvent(event);
          if (!event.defaultPrevented) {
            successfulClicks += 1;
            if (openContact) setSurface("https://web.max.ru/123", chat);
          }
        } } : { first() { return this; }, count: async () => 0 },
      evaluate: async (callback, arg) => JSON.parse(JSON.stringify(vm.runInContext(
        `(${callback.toString()})(${JSON.stringify(arg) ?? "undefined"})`, context))),
    };
    const options = { command: "read", companyId: "11111111-1111-4111-8111-111111111111",
      memberId: "22222222-2222-4222-8222-222222222222", connectionId: "33333333-3333-4333-8333-333333333333",
      chat: "https://web.max.ru/123", timeoutMs: 0 };
    await lookupContactByPhone(page, options, "+12025550123");
    const opened = await openChat(page, options);
    assert.equal(opened.method, "url-with-phone-lookup");
    assert.equal(opened.url, options.chat);
    assert.equal(successfulClicks, 2);
    assert.equal(browserWindow.__trelioMaxAssistState.blockedActions, 0);

    const input = new window.Event("beforeinput", { bubbles: true, cancelable: true });
    document.querySelector("#composer").dispatchEvent(input);
    assert.equal(input.defaultPrevented, true, "contact navigation must not enable composing");
    setSurface("https://web.max.ru/", home + '<button id="send">Отправить</button><button id="continue">Продолжить</button>');
    for (const id of ["send", "continue"]) {
      const event = new window.Event("click", { bubbles: true, cancelable: true });
      document.querySelector(`#${id}`).dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    openContact = false;
    await assert.rejects(() => lookupContactByPhone(page, options, "+12025550123"), (error) => {
      assert.equal(error.code, "MAX_UI_UNSUPPORTED");
      assert.equal(error.details.reason, "phone-lookup-outcome-unverified");
      assert.equal(error.details.finalMutationActionStarted, false);
      assert.equal(canRecoverAssistPreparation(error, "read-only"), true);
      assert.doesNotMatch(JSON.stringify(error.details), /12025550123/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
