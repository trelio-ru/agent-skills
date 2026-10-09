import './http-errors.test.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ADAPTER_VERSION,
  assistInteractionAllowed,
  assertAssistActionAllowed,
  inspectAssistPoint,
  assertMutationAllowed,
  assertSendAllowed,
  buildGlobalSearchCoverage,
  buildMutationPreview,
  connectionRoot,
  createReadState,
  decodeGlobalSearchCursor,
  encodeGlobalSearchCursor,
  loadPolicy,
  normalizeContactReference,
  normalizeDialogTitle,
  normalizeGlobalSearchQuery,
  normalizeGlobalSearchRows,
  openHome,
  parseArguments,
  policyPath,
  prepareAssistAuthorization,
  requestAssistControl,
  validateAssistControlPacket,
  selectContextWindow,
  selectExactContactResult,
  selectExactDialogResult,
  usage,
  waitForLoginHandoff,
  writePrivateJson,
} from "../scripts/trelio-telegram-web.mjs";

const identityArguments = [
  "--company-id",
  "11111111-1111-4111-8111-111111111111",
  "--member-id",
  "22222222-2222-4222-8222-222222222222",
  "--connection-id",
  "33333333-3333-4333-8333-333333333333",
];
Object.assign(process.env, {
  TRELIO_SKILL_ID: "telegram-web",
  TRELIO_SKILL_RUNTIME_VERSION: "3.4.0",
  TRELIO_SKILL_COMPANY_ID: identityArguments[1],
  TRELIO_SKILL_MEMBER_ID: identityArguments[3],
  TRELIO_SKILL_CONNECTION_ID: identityArguments[5],
});

test("Telegram Web local policy defaults to confirm and keeps state outside workspace", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([...identityArguments, "doctor"]);
    assert.deepEqual(loadPolicy(options), { sendMode: "confirm" });
    assert.equal(
      connectionRoot(options).includes(
        path.join("integrations", "telegram-web"),
      ),
      true,
    );
    assert.doesNotMatch(connectionRoot(options), /\.trelio/u);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Telegram Web exposes a versioned, content-free live probe command", () => {
  const options = parseArguments([...identityArguments, "probe"]);
  assert.equal(options.command, "probe");
  assert.equal(ADAPTER_VERSION, "7");
  assert.equal(parseArguments(["probe"]).companyId, identityArguments[1]);
  assert.throws(() => parseArguments([
    "probe", "--company-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]), /cannot override the signed runtime identity/u);
  assert.throws(() => parseArguments(["probe"], {}), /Trusted Telegram Web runtime identity/u);
});

test("Telegram Web assisted recovery binds one operation to ordinary approval", () => {
  const normal = parseArguments([
    ...identityArguments, "member-add", "--chat", "Точная группа", "--member", "@exact_bot", "--dry-run",
  ]);
  const hash = buildMutationPreview(normal).approvalHash;
  const assisted = parseArguments([
    ...identityArguments, "assist-start", "--fallback-for", "member-add", "--chat", "Точная группа",
    "--member", "@exact_bot", "--confirm", "--approval-hash", hash,
  ]);
  assert.equal(assisted.headed, true);
  assert.equal(assisted.holdMs, 1_800_000);
  const authorized = prepareAssistAuthorization(assisted);
  assert.equal(authorized.mutationAuthorized, true);
  assert.equal(authorized.interactionMode, "manual-control");
  assert.match(authorized.authorizationHash, /^[0-9a-f]{64}$/u);

  const unapproved = { ...assisted, approvalHash: "" };
  assert.throws(() => prepareAssistAuthorization(unapproved), /approval-hash/u);
  assert.throws(() => parseArguments([...identityArguments, "assist-start", "--fallback-for", "send", "--headless"]),
    /requires a visible browser/u);
});

test("Telegram Web assisted reads cannot use composer or external links", () => {
  const options = parseArguments([
    ...identityArguments, "assist-start", "--fallback-for", "read", "--chat", "Точная группа",
  ]);
  assert.equal(prepareAssistAuthorization(options).interactionMode, "read-only");
  const box = { x: 20, y: 80, width: 280, height: 48 };
  assert.equal(assistInteractionAllowed({ kind: "fill", tag: "input", label: "Поиск", box, pathname: "/k/" }), true);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "div", label: "Служебная группа", chatRow: true, box }), true);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "button", label: "Отправить", box }), false);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "a", label: "Справка", href: "https://example.org", box }), false);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "a", label: "Чат", href: "https://example.org", chatRow: true, box }), false);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "a", label: "Чат", href: "https://web.telegram.org/k/#-10042", box }), true);
  assert.equal(assistInteractionAllowed({ kind: "click", tag: "a", label: "Чат", href: "https://web.telegram.org/k/#settings", box }), false);
});

test("Telegram Web assisted control reads a bounded loopback status", async () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const token = "b".repeat(64);
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), { command: "status", sessionId });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, phase: "active" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await requestAssistControl({
      sessionId, token, port: server.address().port,
    }, "status");
    assert.deepEqual(result, { ok: true, phase: "active" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telegram Web visual command uses the same authenticated loopback session", async () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshotId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const token = "c".repeat(64);
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), { command: "click", sessionId, snapshotId, ref: "r1" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, action: "click" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.deepEqual(await requestAssistControl({ sessionId, token, port: server.address().port },
      "click", { snapshotId, ref: "r1" }), { ok: true, action: "click" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Telegram Web visual controls require exact session, screenshot and bounded arguments", () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshotId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal(parseArguments(["assist-snapshot", "--session", sessionId]).command, "assist-snapshot");
  assert.equal(parseArguments(["assist-click", "--session", sessionId,
    "--snapshot", snapshotId, "--ref", "r1"]).assistRef, "r1");
  assert.equal(parseArguments(["assist-contextmenu", "--session", sessionId,
    "--snapshot", snapshotId, "--ref", "r1"]).command, "assist-contextmenu");
  assert.equal(parseArguments(["assist-fill", "--session", sessionId,
    "--snapshot", snapshotId, "--ref", "r1", "--text", "поиск"]).assistText, "поиск");
  assert.equal(parseArguments(["assist-point-scroll", "--session", sessionId,
    "--snapshot", snapshotId, "--x", "850", "--y", "700", "--delta-y", "600"]).assistDeltaY, 600);
  assert.throws(() => parseArguments(["assist-point-click", "--session", sessionId,
    "--snapshot", snapshotId, "--x", "-1", "--y", "700"]), /screenshot coordinates/u);
  assert.equal(validateAssistControlPacket({ command: "click", sessionId, snapshotId, ref: "r1" }, sessionId).ref, "r1");
  assert.equal(validateAssistControlPacket({ command: "point-contextmenu", sessionId, snapshotId,
    x: 700, y: 450 }, sessionId).x, 700);
  for (const invalid of [
    { command: "click", sessionId, snapshotId, ref: "r101" },
    { command: "click", sessionId, snapshotId, ref: "r1", url: "https://example.test" },
    { command: "fill", sessionId, snapshotId, ref: "r1", text: "" },
    { command: "key", sessionId, snapshotId, key: "ControlOrMeta+L" },
    { command: "point-click", sessionId, snapshotId, x: -1, y: 700 },
    { command: "point-scroll", sessionId, snapshotId, x: 850, y: 700, deltaY: 2000 },
  ]) {
    assert.throws(() => validateAssistControlPacket(invalid, sessionId),
      (error) => error.code === "TELEGRAM_ASSIST_CONTROL_REJECTED");
  }
});

test("Telegram Web visual actions stay inside one authorized operation and fresh screenshot", () => {
  const snapshot = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", at: 1000,
    fingerprint: "current", refs: new Set(["r1"]) };
  const packet = { command: "click", snapshotId: snapshot.id, ref: "r1" };
  const basis = { config: { fallbackFor: "send", mutationAuthorized: true, interactionMode: "manual-control" },
    snapshot, packet, fingerprint: "current", now: 2000 };
  assert.equal(assertAssistActionAllowed(basis), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    packet: { command: "point-contextmenu", snapshotId: snapshot.id } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "members", mutationAuthorized: false, interactionMode: "manual-control" } }), snapshot);
  for (const [change, code] of [
    [{ config: { fallbackFor: "send", mutationAuthorized: false, interactionMode: "manual-control" } },
      "TELEGRAM_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" },
      packet: { command: "point-contextmenu", snapshotId: snapshot.id } },
      "TELEGRAM_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ fingerprint: "changed" }, "TELEGRAM_ASSIST_SNAPSHOT_STALE"],
    [{ now: 121001 }, "TELEGRAM_ASSIST_SNAPSHOT_STALE"],
    [{ packet: { ...packet, snapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
      "TELEGRAM_ASSIST_SNAPSHOT_STALE"],
    [{ packet: { ...packet, ref: "r2" } }, "TELEGRAM_ASSIST_TARGET_INVALID"],
    [{ config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" },
      packet: { command: "key", snapshotId: snapshot.id, key: "Enter" } }, "TELEGRAM_ASSIST_TARGET_INVALID"],
  ]) {
    assert.throws(() => assertAssistActionAllowed({ ...basis, ...change }),
      (error) => error.code === code);
  }
});

test("Telegram Web visual points cannot bypass read-only chat/search guard", async () => {
  const box = { x: 20, y: 80, width: 280, height: 48 };
  const chat = { tag: "div", type: "", label: "Служебная группа", href: "",
    chatRow: true, box, viewportWidth: 1280, pathname: "/k/" };
  const page = { evaluate: async () => chat };
  assert.equal(await inspectAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "read-only"), true);
  page.evaluate = async () => ({ ...chat, label: "Отправить", chatRow: false });
  assert.equal(await inspectAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "read-only"), false);
  page.evaluate = async () => ({ ...chat, href: "https://example.org" });
  assert.equal(await inspectAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "manual-control"), false);
});

test("Telegram Web contacts fallback can open only the contact navigation entry", async () => {
  const contactTab = { tag: "button", type: "", label: "Контакты", href: "",
    chatRow: false, box: { x: 12, y: 440, width: 60, height: 45 },
    viewportWidth: 1280, pathname: "/k/" };
  const page = { evaluate: async () => contactTab };
  const point = { command: "point-click", x: 40, y: 460 };
  assert.equal(await inspectAssistPoint(page, point, "read-only", "contacts"), true);
  assert.equal(await inspectAssistPoint(page, point, "read-only", "read"), false);
  page.evaluate = async () => ({ ...contactTab, label: "Добавить контакт" });
  assert.equal(await inspectAssistPoint(page, point, "read-only", "contacts"), false);
  page.evaluate = async () => ({ ...contactTab, box: { ...contactTab.box, x: 600 } });
  assert.equal(await inspectAssistPoint(page, point, "read-only", "contacts"), false);
});

test("Telegram Web global message search requires explicit bounded scope", () => {
  const options = parseArguments([
    ...identityArguments,
    "search",
    "--global",
    "--query",
    "  Ａльфа   план  ",
    "--limit",
    "25",
    "--pages",
    "3",
  ]);

  assert.equal(options.command, "search");
  assert.equal(options.globalSearch, true);
  assert.equal(options.limit, 25);
  assert.equal(options.pages, 3);
  assert.equal(options.context, 0);
  assert.equal(normalizeGlobalSearchQuery(options.query), "Aльфа план");
  assert.throws(
    () => parseArguments([...identityArguments, "search", "--query", "план"]),
    /requires explicit --global scope/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "dialogs", "--global", "--query", "план"]),
    /--global is supported only/u,
  );
  assert.throws(() => normalizeGlobalSearchQuery("   "), /requires --query/u);
  assert.throws(() => normalizeGlobalSearchQuery("я".repeat(257)), /cannot exceed 256/u);
  const contextual = parseArguments([
    ...identityArguments,
    "search",
    "--global",
    "--query",
    "план",
    "--limit",
    "10",
    "--context",
    "10",
  ]);
  assert.equal(contextual.context, 10);
  assert.throws(
    () => parseArguments([
      ...identityArguments,
      "search",
      "--global",
      "--query",
      "план",
      "--limit",
      "11",
      "--context",
      "1",
    ]),
    /requires --limit 1\.\.10/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "read", "--chat", "Команда", "--context", "1"]),
    /supported only by the Telegram Web search/u,
  );
  const cursor = encodeGlobalSearchCursor("план", 25);
  const paginated = parseArguments([
    ...identityArguments,
    "search",
    "--global",
    "--query",
    "план",
    "--cursor",
    cursor,
    "--pages",
    "100",
  ]);
  assert.equal(paginated.cursor, cursor);
  assert.equal(paginated.pages, 100);
  assert.throws(
    () => parseArguments([
      ...identityArguments,
      "search",
      "--global",
      "--query",
      "план",
      "--pages",
      "101",
    ]),
    /--pages must be an integer from 1 to 100/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "read", "--chat", "Команда", "--cursor", cursor]),
    /--cursor is supported only/u,
  );
  assert.match(
    usage(),
    /search --global --query "Текст" --limit 10 --pages 2 --context 10/u,
  );
});

test("Telegram Web global search rows are bounded, deduplicated and allowlisted", () => {
  const rows = normalizeGlobalSearchRows([
    {
      peerId: "-10042",
      messageId: "17",
      threadId: "3",
      title: "  Финансы  ",
      sender: "Анна",
      timestamp: "12:30",
      messageText: `План ${"я".repeat(4_100)}`,
      accessHash: "must-not-leak",
    },
    {
      peerId: "-10042",
      messageId: "17",
      threadId: "3",
      title: "Дубль",
      messageText: "Дубль",
    },
    {
      peerId: "javascript:alert(1)",
      messageId: "18",
      title: "Небезопасная строка",
      messageText: "Не должна попасть в output",
    },
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].chat, {
    peerId: "-10042",
    title: "Финансы",
    url: "https://web.telegram.org/k/#-10042",
  });
  assert.equal(rows[0].messageId, "17");
  assert.equal(rows[0].threadId, "3");
  assert.equal(rows[0].text.length, 4_000);
  assert.equal(rows[0].textTruncated, true);
  assert.match(rows[0].messageKey, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(rows), /accessHash|must-not-leak/u);

  const longPrefix = normalizeGlobalSearchRows(
    Array.from({ length: 150 }, (_, index) => ({
      peerId: "-10042",
      messageId: String(index + 1),
      title: "Рабочая группа",
      sender: "Анна",
      timestamp: "12:30",
      messageText: `Строка ${index + 1}`,
    })),
    150,
  );
  assert.equal(longPrefix.length, 150);
  assert.equal(longPrefix[149].messageId, "150");
});

test("Telegram Web global search coverage never presents a bounded page as exhaustive", () => {
  assert.deepEqual(
    buildGlobalSearchCoverage({
      returned: 20,
      limit: 20,
      pagesLoaded: 2,
      empty: false,
      hasExtraResult: true,
      scrollExhausted: false,
      pageLimitReached: false,
    }),
    {
      scope: "all_accessible_cloud_chats",
      providerSurface: "telegram_web_global_message_search",
      returned: 20,
      limit: 20,
      seenBefore: 0,
      seenThrough: 20,
      pagesLoaded: 2,
      hasMore: true,
      nextCursor: null,
      cursorLimitReached: false,
      limitReached: true,
      pageComplete: true,
      complete: false,
      incompleteReason: "result_limit_reached",
      snapshotStable: false,
      unrecognizedRows: false,
      excludedChatTypes: ["secret"],
    },
  );
  const exhausted = buildGlobalSearchCoverage({
    returned: 4,
    limit: 20,
    pagesLoaded: 1,
    empty: false,
    hasExtraResult: false,
    scrollExhausted: true,
    pageLimitReached: false,
  });
  assert.equal(exhausted.complete, true);
  assert.equal(exhausted.hasMore, false);
  assert.equal(exhausted.incompleteReason, null);

  const finalPage = buildGlobalSearchCoverage({
    returned: 4,
    limit: 20,
    offset: 20,
    nextCursor: null,
    pagesLoaded: 3,
    empty: false,
    hasExtraResult: false,
    scrollExhausted: true,
    pageLimitReached: false,
  });
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.pageComplete, true);
  assert.equal(finalPage.complete, false);
  assert.equal(finalPage.incompleteReason, "paginated_window");
  assert.equal(finalPage.seenBefore, 20);
  assert.equal(finalPage.seenThrough, 24);
});

test("Telegram Web pagination cursor is opaque, bounded and query-specific", () => {
  const cursor = encodeGlobalSearchCursor("план", 100);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/u);
  assert.equal(decodeGlobalSearchCursor("план", cursor), 100);
  assert.throws(
    () => decodeGlobalSearchCursor("другая тема", cursor),
    /does not belong to this query/u,
  );
  assert.throws(
    () => encodeGlobalSearchCursor("план", 5_001),
    /offset is invalid/u,
  );
  assert.throws(
    () => decodeGlobalSearchCursor("план", "not-a-json-token"),
    /cursor is invalid/u,
  );
});

test("Telegram Web selects and bounds chronological context around an exact result", () => {
  const message = (providerMessageId, overrides = {}) => ({
    providerMessageId,
    author: "Анна",
    timestamp: "12:30",
    text: `Сообщение ${providerMessageId}`,
    isOutgoing: false,
    replyText: null,
    attachments: [],
    messageKey: `key-${providerMessageId}`,
    ...overrides,
  });
  const context = selectContextWindow([
    message("9007199254740995"),
    message("9007199254740991"),
    message("9007199254740993", {
      text: "я".repeat(4_100),
      replyText: "ответ",
      attachments: [{ name: "plan.pdf", kind: "a", href: "javascript:secret" }],
    }),
    message("9007199254740994"),
    message("9007199254740992"),
  ], "9007199254740993", 2);

  assert.equal(context.available, true);
  assert.deepEqual(
    context.messages.map((item) => item.providerMessageId),
    [
      "9007199254740991",
      "9007199254740992",
      "9007199254740993",
      "9007199254740994",
      "9007199254740995",
    ],
  );
  assert.equal(context.matchIndex, 2);
  assert.deepEqual(
    context.messages.map((item) => item.isMatch),
    [false, false, true, false, false],
  );
  assert.equal(context.messages[2].text.length, 4_000);
  assert.equal(context.messages[2].textTruncated, true);
  assert.deepEqual(context.messages[2].attachments, [
    { index: 1, name: "plan.pdf", kind: "a" },
  ]);
  assert.doesNotMatch(JSON.stringify(context), /javascript:secret/u);
  assert.deepEqual(context.coverage, {
    requestedBefore: 2,
    returnedBefore: 2,
    requestedAfter: 2,
    returnedAfter: 2,
    historyStartReached: false,
    historyEndReached: false,
    complete: true,
    incompleteReasons: [],
  });
});

test("Telegram Web context distinguishes history edges from an incomplete UI window", () => {
  const rows = ["8", "9", "10", "11"].map((providerMessageId) => ({
    providerMessageId,
    author: null,
    timestamp: null,
    text: providerMessageId,
    isOutgoing: false,
    replyText: null,
    attachments: [],
    messageKey: `key-${providerMessageId}`,
  }));
  const atHistoryEdges = selectContextWindow(rows, "10", 3, {
    beforeExhausted: true,
    afterExhausted: true,
  });
  assert.equal(atHistoryEdges.coverage.complete, true);
  assert.equal(atHistoryEdges.coverage.historyStartReached, true);
  assert.equal(atHistoryEdges.coverage.historyEndReached, true);

  const boundedUi = selectContextWindow(rows, "10", 3);
  assert.equal(boundedUi.coverage.complete, false);
  assert.deepEqual(boundedUi.coverage.incompleteReasons, [
    "before_provider_ui_window",
    "after_provider_ui_window",
  ]);
  const missing = selectContextWindow(rows, "12", 3);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.coverage.incompleteReasons, ["target_message_not_found"]);
});

test("Telegram Web release manifest and instructions publish the global search contract", () => {
  const release = JSON.parse(fs.readFileSync(
    new URL("../release.json", import.meta.url),
    "utf8",
  ));
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const docs = fs.readFileSync(
    new URL("../../../docs/telegram-web-agent-skill.md", import.meta.url),
    "utf8",
  );

  assert.equal(release.release.version, "2.5.0");
  assert.equal(release.runtime.version, "2.5.0");
  assert.equal(release.runtime.minimumHostVersion, "3.7.0");
  assert.deepEqual(release.runtime.browserSession, {
    apiVersion: 1,
    sessionClass: "messenger-profile",
    manualAssist: true,
  });
  assert.equal(Object.hasOwn(release.release, "state"), false);
  for (const source of [skill, docs]) {
    assert.match(source, /assist-start/u);
    assert.match(source, /трёх несетевых|трёх фактических несетевых/u);
    assert.match(source, /search --global/u);
    assert.match(source, /nextCursor|--cursor/u);
    assert.match(source, /--context|contextCoverage/u);
    assert.match(source, /coverage/u);
    assert.match(source, /secret chats/iu);
    assert.match(
      source,
      /не\s+(?:создаёт|создавай)\s+(?:свой\s+)?(?:локальный|постоянный)\s+индекс/iu,
    );
  }
});

test("Telegram Web login handoff finishes as soon as the owner closes the visible window", async () => {
  let closed = false;
  let closeWindow = null;
  const page = {
    isClosed: () => closed,
    waitForEvent: (event, options) => {
      assert.equal(event, "close");
      assert.deepEqual(options, { timeout: 0 });
      return new Promise((resolve) => {
        closeWindow = () => {
          closed = true;
          resolve();
        };
      });
    },
  };

  const handoff = waitForLoginHandoff(page, 1_000);
  assert.equal(typeof closeWindow, "function");
  closeWindow();
  assert.equal(await handoff, "window_closed");
});

test("Telegram Web login handoff keeps a bounded timeout when the window is not closed", async () => {
  const page = {
    isClosed: () => false,
    waitForEvent: () => new Promise(() => undefined),
  };

  assert.equal(await waitForLoginHandoff(page, 5), "hold_expired");
  assert.throws(
    () => parseArguments([...identityArguments, "login", "--hold-ms", "4999"]),
    /--hold-ms must be from 5000 to 600000/u,
  );
});

test("Telegram Web login always resolves to a visible mode before browser launch", () => {
  const implicit = parseArguments([...identityArguments, "login"]);
  const explicit = parseArguments([...identityArguments, "login", "--headed"]);
  const probe = parseArguments([...identityArguments, "probe"]);

  assert.equal(implicit.headed, true);
  assert.equal(explicit.headed, true);
  assert.equal(probe.headed, false);
  assert.throws(
    () => parseArguments([...identityArguments, "login", "--headless"]),
    /login cannot run with --headless/u,
  );
  assert.match(usage(), /trelio-telegram-web\.mjs login --headed/u);
});

test("Telegram Web skill tells the owner to close the login window and requires a fresh probe", () => {
  const skillSource = fs.readFileSync(
    new URL("../SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skillSource, /После входа в Telegram Web закройте окно\./u);
  assert.match(skillSource, /exact `login --headed`/u);
  assert.match(skillSource, /сразу\s+выполни один (?:свежий|fresh) `probe`/u);
  assert.doesNotMatch(skillSource, /не закрывайте (?:его|окно)/iu);
});

test("Telegram Web parses bounded history, repeated files and exact member references", () => {
  const options = parseArguments([
    ...identityArguments,
    "create-group",
    "--title",
    "Проект Альфа",
    "--member",
    "@one",
    "--member",
    "https://t.me/two",
    "--file",
    "/tmp/one.txt",
    "--file",
    "/tmp/two.txt",
    "--pages",
    "3",
  ]);
  assert.equal(options.title, "Проект Альфа");
  assert.deepEqual(options.members, ["@one", "https://t.me/two"]);
  // `parseArguments` intentionally resolves local files with the host path
  // implementation. Keep the assertion portable instead of hard-coding a
  // POSIX spelling that becomes `D:\\tmp\\...` on GitHub's Windows runner.
  assert.deepEqual(options.files, [
    path.resolve("/tmp/one.txt"),
    path.resolve("/tmp/two.txt"),
  ]);
  assert.equal(options.pages, 3);
  assert.throws(
    () => parseArguments([...identityArguments, "read", "--pages", "21"]),
    /--pages must be an integer/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "admin-add", "--chat", "Команда", "--member", "@one"]),
    /Unsupported Telegram Web browser command/u,
  );
  assert.throws(
    () => parseArguments([...identityArguments, "invite-link", "--chat", "Команда"]),
    /Unsupported Telegram Web browser command/u,
  );
});

test("Telegram Web retries one blank SPA shell before probing the authenticated UI", async () => {
  let readinessChecks = 0;
  let reloads = 0;
  const page = {
    goto: async () => undefined,
    reload: async () => {
      reloads += 1;
    },
    waitForFunction: async () => {
      readinessChecks += 1;
      if (readinessChecks === 1) throw new Error("blank shell");
    },
    evaluate: async () => ({ authVisible: false, appVisible: true }),
  };

  const result = await openHome(page, { timeoutMs: 60_000 });
  assert.deepEqual(result, { uiReady: true });
  assert.equal(readinessChecks, 2);
  assert.equal(reloads, 1);
});

test("Telegram Web fails closed when the SPA stays blank after one controlled reload", async () => {
  let reloads = 0;
  const page = {
    goto: async () => undefined,
    reload: async () => {
      reloads += 1;
    },
    waitForFunction: async () => {
      throw new Error("blank shell");
    },
  };

  await assert.rejects(
    () => openHome(page, { timeoutMs: 60_000 }),
    /Telegram Web home rendered no visible interactive UI/u,
  );
  assert.equal(reloads, 1);
});

test("Telegram Web action selection requires one exact normalized dialog title", () => {
  const results = [
    { index: 0, title: "ООО Вкус моря" },
    { index: 1, title: "  ООО   ВКУС  " },
  ];

  assert.equal(normalizeDialogTitle(" ООО  Вкус "), "ооо вкус");
  assert.equal(selectExactDialogResult(results, "ООО Вкус").index, 1);
  assert.throws(
    () => selectExactDialogResult([results[0]], "ООО Вкус"),
    /No exact visible Telegram Web dialog matched/u,
  );
  assert.throws(
    () => selectExactDialogResult(
      [
        { index: 0, title: "ООО Вкус" },
        { index: 1, title: "ооо вкус" },
      ],
      "ООО Вкус",
    ),
    /Ambiguous exact Telegram Web dialog title/u,
  );
});

test("Telegram Web preserves read-only but never reuses legacy autonomous authorization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([...identityArguments, "send", "--chat", "test", "--message", "hello"]);
    writePrivateJson(policyPath(options), { sendMode: "read-only" });
    assert.throws(() => assertSendAllowed(options), /read-only/u);

    writePrivateJson(policyPath(options), { sendMode: "autonomous" });
    const previous = fs.readFileSync(policyPath(options), "utf8");
    assert.throws(() => assertSendAllowed(options), /--confirm/u);
    assert.equal(assertSendAllowed({ ...options, confirm: true }), "confirm");
    assert.throws(() => assertSendAllowed(options), /--confirm/u);
    assert.equal(fs.readFileSync(policyPath(options), "utf8"), previous);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Telegram Web reports ordinary provider read semantics without a protocol interception claim", () => {
  assert.deepEqual(createReadState(), {
    mode: "ordinary-telegram-web",
    mayMarkVisibleMessagesRead: true,
    note: "Opening a Telegram Web dialog may mark its visible messages as read.",
  });
});

test("Telegram Web exact contact resolver accepts t.me identity and rejects ambiguity", () => {
  const results = [
    { stableId: "ivan", title: "Иван", text: "Иван @ivan" },
    { stableId: "ivan-work", title: "Иван", text: "Иван @ivan-work" },
  ];
  assert.equal(normalizeContactReference("https://t.me/Ivan/"), "ivan");
  assert.equal(selectExactContactResult(results, "@ivan").stableId, "ivan");
  assert.throws(
    () => selectExactContactResult(results, "Иван"),
    /Several exact Telegram Web contacts/u,
  );
});

test("Telegram Web structural mutations bind confirmation to the exact dry-run payload", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-telegram-web-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseArguments([
      ...identityArguments,
      "create-group",
      "--title",
      "Проект Альфа",
      "--member",
      "@one",
      "--dry-run",
    ]);
    const preview = buildMutationPreview(options);
    assert.equal(preview.operation.command, "create-group");
    assert.equal(preview.confirmationRequired, true);

    options.dryRun = false;
    options.confirm = true;
    options.approvalHash = preview.approvalHash;
    assert.equal(assertMutationAllowed(options), "confirm");

    options.title = "Другой чат";
    assert.throws(
      () => assertMutationAllowed(options),
      /exact --approval-hash/u,
    );
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
