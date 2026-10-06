import './http-errors.test.mjs';
import './chat-references.test.mjs';
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";

import {
  ADAPTER_VERSION,
  MEMBER_REMOVE_ACTION,
  inspectMemberRemovalSurface,
  openSelectedMemberRowMore,
  clickRowMemberRemovalAction,
  MaxRuntimeError,
  assistAppName,
  assistInteractionAllowed,
  collectDialogResults,
  collectContactProfile,
  inspectPhoneLookupOutcome,
  lookupContactByPhone,
  collectPickerResults,
  collectAssistControls,
  assistPageDigest,
  captureStableAssistFrame,
  scrollAssistMemberSurface,
  inspectVisualMemberPoint,
  inspectGeneralAssistPoint,
  inspectAssistDownloadSurface,
  collectVisibleMembers,
  collectCompleteMembers,
  clickNewChatAction,
  clickCreateGroupMenuAction,
  collectHomeDialogs,
  runBrowserCommand,
  validateCommandOptions,
  assertMutationAllowed,
  assertSendAllowed,
  buildMutationPreview,
  connectionRoot,
  installPassiveReadGuard,
  installMaxAssistGate,
  inspectMaxSessionDocument,
  loadPolicy,
  normalizeContactReference,
  normalizePhoneLookupQuery,
  normalizeDialogTitle,
  normalizeChatUrl,
  normalizeMaxRuntimeError,
  visibleMessages,
  findMessageTarget,
  openChatDetails,
  openHome,
  openChat,
  parseArguments,
  passiveReadFrameMarker,
  policyPath,
  prepareAssistAuthorization,
  requireRuntimeIdentity,
  isFavoritesReference,
  inspectFavoritesSurface,
  selectExactContactResult,
  chooseExactPickerEntry,
  selectExactForwardDestination,
  findChatSettingsField,
  findVerifiedReactionStrip,
  reactionCounterAddedToMessage,
  selectExactDialogResult,
  selectFavoritesHomeDialog,
  shouldBlockPassiveReadFrame,
  waitForFavoritesHistory,
  waitForLoginHandoff,
  writePrivateJson,
  validateAssistControlPacket,
  assertAssistActionAllowed,
  assertAssistGateActionCompleted,
  assistTargetContext,
  uploadFiles,
  installAttachmentTransfer,
  attachmentResponseFilename,
  saveAttachmentAtomically,
  installMaxDownloadNavigation,
} from "../scripts/trelio-max.mjs";

const hostRuntimeEnvironment = {
  ...process.env,
  TRELIO_SKILL_ID: "max-web",
  TRELIO_SKILL_RUNTIME_VERSION: "2.8.11",
  TRELIO_SKILL_COMPANY_ID: "11111111-1111-4111-8111-111111111111",
  TRELIO_SKILL_MEMBER_ID: "22222222-2222-4222-8222-222222222222",
  TRELIO_SKILL_CONNECTION_ID: "33333333-3333-4333-8333-333333333333",
  TRELIO_BROWSER_SESSION_MODULE_URL: new URL(
    "../../tools/browser-session-runtime-fixture.mjs",
    import.meta.url,
  ).href,
};
const parseRuntimeArguments = (argv) => parseArguments(argv, hostRuntimeEnvironment);
const runtimeEntrypoint = fileURLToPath(
  new URL("../scripts/trelio-max.mjs", import.meta.url),
);

test("MAX release opts into the shared browser session with manual assist", () => {
  const release = JSON.parse(fs.readFileSync(new URL("../release.json", import.meta.url), "utf8"));
  assert.equal(release.release.version, "2.8.12");
  assert.equal(release.runtime.version, "2.8.12");
  assert.equal(release.runtime.minimumHostVersion, "3.4.0");
  assert.deepEqual(release.runtime.browserSession, {
    apiVersion: 1,
    sessionClass: "messenger-profile",
    manualAssist: true,
  });
});

test("MAX requests background launch for headed login and ordinary browser work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-background-host-"));
  const previous = process.env.TRELIO_BROWSER_SESSION_MODULE_URL;
  try {
    const fixture = path.join(root, "host.mjs");
    fs.writeFileSync(fixture, `export const withPersistentBrowserSession = async (options) => ({
      headed: options.headed, startInBackground: options.startInBackground,
      prepareContext: typeof options.prepareContext, preparePage: typeof options.preparePage,
    });\n`);
    process.env.TRELIO_BROWSER_SESSION_MODULE_URL = pathToFileURL(fixture).href;
    const isolated = await import(`../scripts/trelio-max.mjs?background=${Date.now()}`);
    for (const command of ["login", "probe", "download"]) {
      const result = await isolated.withBrowser(parseRuntimeArguments([command, "--headed"]), () => {});
      assert.equal(result.headed, true);
      assert.equal(result.startInBackground, true);
      assert.equal(result.prepareContext, "function");
    }
    // All fallback preparation and actions share this helper. A foreground
    // handoff in the detached worker would defeat the launch guarantee.
    const source = fs.readFileSync(runtimeEntrypoint, "utf8");
    assert.doesNotMatch(source, /await\s+page\.bringToFront\(/u);
  } finally {
    if (previous === undefined) delete process.env.TRELIO_BROWSER_SESSION_MODULE_URL;
    else process.env.TRELIO_BROWSER_SESSION_MODULE_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MAX accepts identity only from the signed runtime host environment", () => {
  const identity = requireRuntimeIdentity(hostRuntimeEnvironment);
  assert.deepEqual(identity, {
    skillId: "max-web",
    runtimeVersion: "2.8.11",
    companyId: hostRuntimeEnvironment.TRELIO_SKILL_COMPANY_ID,
    memberId: hostRuntimeEnvironment.TRELIO_SKILL_MEMBER_ID,
    connectionId: hostRuntimeEnvironment.TRELIO_SKILL_CONNECTION_ID,
  });

  const options = parseRuntimeArguments(["doctor"]);
  assert.equal(options.companyId, identity.companyId);
  assert.equal(options.memberId, identity.memberId);
  assert.equal(options.connectionId, identity.connectionId);
});

test("MAX rejects missing host identity and removed identity flags", () => {
  assert.throws(
    () => parseArguments(["doctor"], {}),
    (error) => error instanceof MaxRuntimeError && error.code === "MAX_INVALID_IDENTITY",
  );
  assert.throws(
    () => parseArguments(["doctor"], {
      ...hostRuntimeEnvironment,
      TRELIO_SKILL_ID: "another-skill",
    }),
    (error) => error instanceof MaxRuntimeError && error.code === "MAX_INVALID_IDENTITY",
  );
  for (const flag of ["--company-id", "--member-id", "--connection-id"]) {
    assert.throws(
      () => parseRuntimeArguments([
        flag,
        "11111111-1111-4111-8111-111111111111",
        "doctor",
      ]),
      new RegExp(`Unknown argument: ${flag}`, "u"),
    );
  }
});

test("MAX bridge-style env-only CLI invocation reaches the command", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "trelio-max-host-identity-test-"),
  );
  try {
    const result = spawnSync(process.execPath, [runtimeEntrypoint, "doctor"], {
      encoding: "utf8",
      env: {
        ...hostRuntimeEnvironment,
        TRELIO_CONFIG_HOME: path.join(temporary, "config"),
        TRELIO_CACHE_HOME: path.join(temporary, "cache"),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.securityBoundary, "chat-only");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("MAX local policy defaults to confirm and keeps state outside workspace", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseRuntimeArguments(["doctor"]);
    assert.deepEqual(loadPolicy(options), { sendMode: "confirm" });
    assert.equal(
      connectionRoot(options).includes(
        path.join("integrations", "max-web"),
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

test("MAX exposes a versioned, content-free live probe command", () => {
  const options = parseRuntimeArguments(["probe"]);
  assert.equal(options.command, "probe");
  assert.equal(ADAPTER_VERSION, "38");
});

test("MAX exposes bounded assisted recovery for reads and exact manual operations", () => {
  const start = parseRuntimeArguments([
    "assist-start",
    "--fallback-for",
    "read",
  ]);
  assert.equal(start.fallbackFor, "read");
  assert.equal(start.holdMs, 1_800_000);
  assert.equal(assistAppName("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"), "Microsoft Edge");
  assert.throws(
    () => parseRuntimeArguments([
      "assist-start",
      "--fallback-for",
      "read",
      "--hold-ms",
      "1800001",
    ]),
    /--hold-ms must be from 5000 to 1800000/u,
  );
  assert.throws(
    () => parseRuntimeArguments(["assist-start", "--fallback-for", "login"]),
    /supported MAX command/u,
  );
  assert.throws(
    () => parseRuntimeArguments(["assist-status", "--session", "not-a-uuid"]),
    /exact --session UUID/u,
  );
  const session = "11111111-1111-4111-8111-111111111111";
  const snapshot = "22222222-2222-4222-8222-222222222222";
  assert.equal(parseRuntimeArguments(["assist-snapshot", "--session", session]).command, "assist-snapshot");
  assert.equal(parseRuntimeArguments(["assist-contextmenu", "--session", session,
    "--snapshot", session, "--ref", "r1"]).command, "assist-contextmenu");
  assert.equal(parseRuntimeArguments(["assist-click", "--session", session,
    "--snapshot", snapshot, "--ref", "r1"]).assistRef, "r1");
  assert.throws(() => parseRuntimeArguments(["assist-click", "--session", session,
    "--snapshot", snapshot, "--ref", "r201"]), /exact --ref/u);
  assert.throws(() => parseRuntimeArguments(["assist-fill", "--session", session,
    "--snapshot", snapshot, "--ref", "r1", "--text", "x".repeat(257)]), /--text from 1 to 256/u);
  const visual = parseRuntimeArguments(["assist-point-scroll", "--session", session,
    "--snapshot", snapshot, "--x", "850", "--y", "700", "--delta-y", "600"]);
  assert.deepEqual([visual.assistX, visual.assistY, visual.assistDeltaY], [850, 700, 600]);
  assert.throws(() => parseRuntimeArguments(["assist-point-click", "--session", session,
    "--snapshot", snapshot, "--x", "-1", "--y", "700"]), /screenshot coordinates/u);
  assert.equal(parseRuntimeArguments(["assist-start", "--fallback-for", "profile",
    "--chat", "https://web.max.ru/-12"]).fallbackFor, "profile");
});

test("MAX assisted recovery carries only the exact authorized chat and message target", () => {
  assert.deepEqual(assistTargetContext({ command: "reply", chat: "https://web.max.ru/-12",
    targetText: "Тестовое сообщение", pages: 2 }), {
    targetChat: "https://web.max.ru/-12",
    targetMessage: { messageId: null, targetText: "Тестовое сообщение", targetAuthor: null },
    targetPages: 2,
  });
  assert.deepEqual(assistTargetContext({ command: "chat-update", chat: "https://web.max.ru/-12",
    pages: 1 }), {
    targetChat: "https://web.max.ru/-12", targetMessage: null, targetPages: 1,
  });
  assert.deepEqual(assistTargetContext({ command: "create-group", pages: 1 }), {
    targetChat: null, targetMessage: null, targetPages: 1,
  });
});

test("MAX stages a chosen file before message text can be sent", async () => {
  let staged = false;
  let openedPicker = false;
  const fileName = "synthetic-smoke.txt";
  const page = {
    getByText(name) {
      assert.equal(name, fileName);
      return { count: async () => Number(staged), last() {
        return { isVisible: async () => staged };
      } };
    },
    getByRole(role, { name }) {
      assert.equal(role, "button");
      assert.match("Загрузить файл", name);
      return { last() { return this; }, count: async () => 1, isVisible: async () => true,
        click: async () => { openedPicker = true; } };
    },
    waitForEvent: async (event) => {
      assert.equal(event, "filechooser");
      return { setFiles: async (files) => {
        assert.deepEqual(files, [`/tmp/${fileName}`]);
        staged = true;
      } };
    },
    waitForTimeout: async () => {},
  };
  await uploadFiles(page, [`/tmp/${fileName}`], 500);
  assert.equal(openedPicker, true);

  staged = false;
  page.waitForEvent = async () => ({ setFiles: async () => {} });
  await assert.rejects(uploadFiles(page, [`/tmp/${fileName}`], 1),
    (error) => error instanceof MaxRuntimeError && error.code === "MAX_ATTACHMENT_NOT_STAGED");
});

test("MAX in-session control rejects stale or expanded packets before browser dispatch", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const snapshotId = "22222222-2222-4222-8222-222222222222";
  assert.equal(validateAssistControlPacket({ command: "click", sessionId, snapshotId, ref: "r1" }, sessionId).ref, "r1");
  assert.equal(validateAssistControlPacket({ command: "point-contextmenu", sessionId, snapshotId,
    x: 700, y: 450 }, sessionId).x, 700);
  assert.deepEqual(validateAssistControlPacket({ command: "point-scroll", sessionId,
    snapshotId, x: 850, y: 700, deltaY: 600 }, sessionId).x, 850);
  for (const invalid of [
    { command: "click", sessionId, snapshotId, ref: "r101" },
    { command: "click", sessionId, snapshotId, ref: "r1", url: "https://example.test" },
    { command: "fill", sessionId, snapshotId, ref: "r1", text: "" },
    { command: "key", sessionId, snapshotId, key: "ControlOrMeta+L" },
    { command: "scroll", sessionId, snapshotId, deltaY: 0 },
    { command: "click", sessionId: snapshotId, snapshotId, ref: "r1" },
    { command: "point-click", sessionId, snapshotId, x: -1, y: 700 },
    { command: "point-scroll", sessionId, snapshotId, x: 850, y: 700, deltaY: 2000 },
    { command: "point-click", sessionId, snapshotId, x: 850, y: 700, ref: "r1" },
  ]) {
    assert.throws(() => validateAssistControlPacket(invalid, sessionId),
      (error) => error instanceof MaxRuntimeError && error.code === "MAX_ASSIST_CONTROL_REJECTED");
  }
});

test("MAX in-session actions cover all authorized commands with a fresh visible snapshot", () => {
  const snapshot = { id: "22222222-2222-4222-8222-222222222222", at: 1000,
    fingerprint: "current", refs: new Set(["r1"]) };
  const packet = { command: "click", snapshotId: snapshot.id, ref: "r1" };
  const basis = { config: { fallbackFor: "member-add", mutationAuthorized: true, interactionMode: "manual-control" },
    snapshot, packet, fingerprint: "current", now: 2000 };
  assert.equal(assertAssistActionAllowed(basis), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "create-group", mutationAuthorized: true, interactionMode: "manual-control" } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "send", mutationAuthorized: true, interactionMode: "manual-control" } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "send", mutationAuthorized: true, interactionMode: "manual-control" },
    packet: { command: "point-contextmenu", snapshotId: snapshot.id } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" },
    packet: { command: "point-click", snapshotId: snapshot.id } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "members", mutationAuthorized: false, interactionMode: "manual-control" } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "members", mutationAuthorized: false, interactionMode: "manual-control" },
    packet: { command: "scroll", snapshotId: snapshot.id } }), snapshot);
  assert.equal(assertAssistActionAllowed({ ...basis,
    config: { fallbackFor: "members", mutationAuthorized: false, interactionMode: "manual-control" },
    snapshot: { ...snapshot, inspectionMode: "visual" },
    packet: { command: "point-scroll", snapshotId: snapshot.id } }).inspectionMode, "visual");
  for (const [change, code] of [
    [{ config: { fallbackFor: "download", mutationAuthorized: false, interactionMode: "manual-control" },
      packet: { ...packet, command: "fill" } }, "MAX_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ config: { fallbackFor: "download", mutationAuthorized: false, interactionMode: "manual-control" },
      packet: { ...packet, command: "key", key: "Enter" } }, "MAX_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ config: { fallbackFor: "members", mutationAuthorized: false, interactionMode: "manual-control" },
      packet: { ...packet, command: "fill" } }, "MAX_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ packet: { ...packet, snapshotId: "33333333-3333-4333-8333-333333333333" } }, "MAX_ASSIST_SNAPSHOT_STALE"],
    [{ fingerprint: "changed" }, "MAX_ASSIST_SNAPSHOT_STALE"],
    [{ now: 121001 }, "MAX_ASSIST_SNAPSHOT_STALE"],
    [{ packet: { ...packet, ref: "r2" } }, "MAX_ASSIST_TARGET_INVALID"],
    [{ config: { fallbackFor: "send", mutationAuthorized: false, interactionMode: "manual-control" } },
      "MAX_ASSIST_ACTION_NOT_AUTHORIZED"],
    [{ config: { fallbackFor: "read", mutationAuthorized: false, interactionMode: "read-only" },
      packet: { command: "point-contextmenu", snapshotId: snapshot.id } }, "MAX_ASSIST_ACTION_NOT_AUTHORIZED"],
  ]) {
    assert.throws(() => assertAssistActionAllowed({ ...basis, ...change }),
      (error) => error instanceof MaxRuntimeError && error.code === code);
  }
});

test("MAX visual fallback keeps read-only points on chat navigation", async () => {
  const box = { x: 20, y: 80, width: 280, height: 48 };
  const chat = { tag: "button", type: "", label: "Госключ Отправьте документы, которые хотите подписать", href: "",
    chatRow: true, box, viewportWidth: 1280, pathname: "/" };
  const page = { evaluate: async () => chat };
  assert.equal(await inspectGeneralAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "read-only"), true);
  page.evaluate = async () => ({ ...chat, label: "Отправить", chatRow: false });
  assert.equal(await inspectGeneralAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "read-only"), false);
  page.evaluate = async () => ({ ...chat, href: "https://example.org" });
  assert.equal(await inspectGeneralAssistPoint(page, { command: "point-click", x: 100, y: 100 }, "manual-control"), false);
});

test("MAX profile fallback opens only the exact chat header and contacts navigation", async () => {
  const header = { tag: "button", type: "", label: "Открыть профиль Виктория", href: "", chatRow: false,
    box: { x: 527, y: 12, width: 609, height: 40 }, viewportWidth: 1280,
    pathname: "/-12" };
  const page = { evaluate: async () => header };
  const point = { command: "point-click", x: 800, y: 32 };
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "profile"), true);
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "read"), false);
  page.evaluate = async () => ({ ...header, label: "Позвонить" });
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "profile"), false);
  page.evaluate = async () => ({ ...header, box: { ...header.box, y: 410 } });
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "profile"), false);
  page.evaluate = async () => ({ ...header, box: { ...header.box, x: 430 } });
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "profile"), false);
  page.evaluate = async () => ({ ...header, label: "Контакты", pathname: "/",
    box: { x: 12, y: 450, width: 60, height: 44 } });
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "contacts"), true);
  assert.equal(await inspectGeneralAssistPoint(page, point, "read-only", "profile"), false);
});

test("MAX manual recovery reuses ordinary mutation authorization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-assist-auth-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const missingConfirmation = parseRuntimeArguments([
      "assist-start",
      "--fallback-for",
      "send",
      "--chat",
      "Проект Альфа",
      "--message",
      "Готово",
    ]);
    assert.throws(
      () => prepareAssistAuthorization(missingConfirmation),
      /requires --confirm/u,
    );

    const authorizedSend = parseRuntimeArguments([
      "assist-start",
      "--fallback-for",
      "send",
      "--chat",
      "Проект Альфа",
      "--message",
      "Готово",
      "--confirm",
    ]);
    const sendAuthorization = prepareAssistAuthorization(authorizedSend);
    assert.equal(sendAuthorization.interactionMode, "manual-control");
    assert.equal(sendAuthorization.mutationAuthorized, true);
    assert.match(sendAuthorization.authorizationHash, /^[0-9a-f]{64}$/u);

    const previewOptions = parseRuntimeArguments([
      "create-group",
      "--title",
      "Проект Альфа",
      "--member",
      "@one",
      "--dry-run",
    ]);
    const preview = buildMutationPreview(previewOptions);
    const authorizedGroup = parseRuntimeArguments([
      "assist-start",
      "--fallback-for",
      "create-group",
      "--title",
      "Проект Альфа",
      "--member",
      "@one",
      "--confirm",
      "--approval-hash",
      preview.approvalHash,
    ]);
    assert.equal(prepareAssistAuthorization(authorizedGroup).mutationAuthorized, true);
    authorizedGroup.title = "Другой чат";
    assert.throws(
      () => prepareAssistAuthorization(authorizedGroup),
      /exact --approval-hash/u,
    );

    const addPreview = buildMutationPreview(parseRuntimeArguments([
      "member-add", "--chat", "Группа Альфа", "--member", "@id123_bot", "--dry-run",
    ]));
    const addAuthorization = prepareAssistAuthorization(parseRuntimeArguments([
      "assist-start", "--fallback-for", "member-add", "--chat", "Группа Альфа",
      "--member", "@id123_bot", "--confirm", "--approval-hash", addPreview.approvalHash,
    ]));
    assert.equal(addAuthorization.operation.chat, "Группа Альфа");
    assert.deepEqual(addAuthorization.operation.members, ["@id123_bot"]);

    const members = prepareAssistAuthorization(parseRuntimeArguments([
      "assist-start",
      "--fallback-for",
      "members",
      "--chat",
      "Проект Альфа",
    ]));
    assert.equal(members.interactionMode, "manual-control");
    assert.equal(members.mutationAuthorized, false);
  } finally {
    if (previousConfigHome === undefined) delete process.env.TRELIO_CONFIG_HOME;
    else process.env.TRELIO_CONFIG_HOME = previousConfigHome;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("MAX assisted recovery gate permits search and exact chat navigation only", () => {
  const search = {
    tag: "input",
    type: "search",
    label: "Поиск",
    box: { x: 20, y: 40, width: 280, height: 36 },
  };
  assert.equal(assistInteractionAllowed({ kind: "fill", ...search }), true);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "a",
    label: "Избранное",
    href: "https://web.max.ru/0",
    box: { x: 10, y: 160, width: 320, height: 52 },
  }), true);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "button",
    label: "Новый чат",
    box: { x: 20, y: 80, width: 180, height: 40 },
  }), false);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "button",
    label: "Госключ Отправьте документы, которые хотите подписать",
    chatRow: true,
    box: { x: 10, y: 220, width: 320, height: 52 },
  }), true);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "button",
    label: "Госключ Отправьте документы, которые хотите подписать",
    chatRow: false,
    box: { x: 10, y: 220, width: 320, height: 52 },
  }), false);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "a",
    label: "Госключ Отправьте документы, которые хотите подписать",
    href: "https://web.max.ru/173475128",
    box: { x: 10, y: 220, width: 320, height: 52 },
  }), true);
  assert.equal(assistInteractionAllowed({
    kind: "fill",
    tag: "textarea",
    label: "Написать сообщение",
    box: { x: 700, y: 820, width: 400, height: 48 },
  }), false);
  assert.equal(assistInteractionAllowed({
    kind: "click",
    tag: "a",
    label: "Справка",
    href: "https://example.test/",
    box: { x: 10, y: 220, width: 240, height: 40 },
  }), false);
});

test("MAX classifies only login and deterministic UI incompatibility for recovery", () => {
  assert.equal(
    normalizeMaxRuntimeError(new Error("MAX login is required. Run login.")).code,
    "MAX_LOGIN_REQUIRED",
  );
  assert.equal(
    normalizeMaxRuntimeError(new Error("Could not safely identify the MAX dialog search field.")).code,
    "MAX_UI_UNSUPPORTED",
  );
  assert.equal(
    normalizeMaxRuntimeError(new Error("MAX chat list has no recognized rows.")).code,
    "MAX_UI_UNSUPPORTED",
  );
  assert.equal(
    normalizeMaxRuntimeError(new Error("MAX send result is ambiguous. Do not retry automatically.")) instanceof MaxRuntimeError,
    false,
  );
  assert.equal(
    normalizeMaxRuntimeError(new Error("net::ERR_CONNECTION_RESET")) instanceof MaxRuntimeError,
    false,
  );
});

test("MAX login handoff finishes as soon as the owner closes the visible window", async () => {
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

test("MAX login handoff keeps a bounded timeout when the window is not closed", async () => {
  const page = {
    isClosed: () => false,
    waitForEvent: () => new Promise(() => undefined),
  };

  assert.equal(await waitForLoginHandoff(page, 5), "hold_expired");
  assert.throws(
    () => parseRuntimeArguments(["login", "--hold-ms", "4999"]),
    /--hold-ms must be from 5000 to 600000/u,
  );
  assert.throws(
    () => parseRuntimeArguments(["login", "--hold-ms", "600001"]),
    /--hold-ms must be from 5000 to 600000/u,
  );
});

test("MAX skill tells the owner to close the login window and requires a fresh probe", () => {
  const skillSource = fs.readFileSync(
    new URL("../SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skillSource, /После входа в MAX закройте окно\./u);
  assert.match(skillSource, /сразу\s+выполни один (?:свежий|fresh) `probe`/u);
  assert.match(skillSource, /runtimeExecution\.localAction/u);
  assert.match(skillSource, /identity передаёт\s+проверенный host/u);
  assert.match(skillSource, /1800000/u);
  assert.match(skillSource, /search_public_product_feedback/u);
  assert.match(skillSource, /render_public_product_feedback_proposal/u);
  assert.match(skillSource, /три раза завершилась несетевой ошибкой/u);
  assert.match(skillSource, /Не требуй четвёртой попытки/u);
  assert.match(skillSource, /сетевого timeout и HTTP 5xx не засчитываются/u);
  assert.match(skillSource, /Если нужный результат уже есть, остановись/u);
  assert.match(skillSource, /--fallback-for members/u);
  assert.doesNotMatch(skillSource, /Запускай exact `runtimeExecution\.command`/u);
  assert.doesNotMatch(skillSource, /не закрывайте (?:его|окно)/iu);
});

test("MAX parses bounded history, repeated files and exact member references", () => {
  const options = parseRuntimeArguments([
    "create-group",
    "--title",
    "Проект Альфа",
    "--member",
    "@one",
    "--member",
    "https://max.ru/u/two",
    "--file",
    "/tmp/one.txt",
    "--file",
    "/tmp/two.txt",
    "--pages",
    "3",
  ]);
  assert.equal(options.title, "Проект Альфа");
  assert.deepEqual(options.members, ["@one", "https://max.ru/u/two"]);
  // parseArguments intentionally canonicalizes local paths for the current OS.
  // Resolve the fixtures the same way so this regression describes the
  // cross-platform contract instead of hard-coding POSIX separators.
  assert.deepEqual(options.files, [
    path.resolve("/tmp/one.txt"),
    path.resolve("/tmp/two.txt"),
  ]);
  assert.equal(options.pages, 3);
  assert.throws(
    () => parseRuntimeArguments(["read", "--pages", "21"]),
    /--pages must be an integer/u,
  );
  assert.throws(
    () => parseRuntimeArguments(["admin-add", "--chat", "Команда", "--member", "@one"]),
    /Unsupported MAX browser command/u,
  );
  assert.throws(
    () => parseRuntimeArguments(["invite-link", "--chat", "Команда"]),
    /Unsupported MAX browser command/u,
  );
});

test("MAX retries one blank SPA shell before probing the authenticated UI", async () => {
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
    evaluate: async () => ({ loginReady: false, authenticatedReady: true }),
  };

  const result = await openHome(page, { timeoutMs: 60_000 });
  assert.deepEqual(result, { uiReady: true });
  assert.equal(readinessChecks, 2);
  assert.equal(reloads, 1);
});

test("MAX fails closed when the SPA stays blank after one controlled reload", async () => {
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
    /MAX home rendered no visible interactive UI/u,
  );
  assert.equal(reloads, 1);
});

test("MAX action selection requires one exact normalized dialog title", () => {
  const results = [
    { index: 0, title: "ООО Вкус моря" },
    { index: 1, title: "  ООО   ВКУС  " },
  ];

  assert.equal(normalizeDialogTitle(" ООО  Вкус "), "ооо вкус");
  assert.equal(selectExactDialogResult(results, "ООО Вкус").index, 1);
  assert.throws(
    () => selectExactDialogResult([results[0]], "ООО Вкус"),
    /No exact visible MAX dialog matched/u,
  );
  assert.throws(
    () => selectExactDialogResult(
      [
        { index: 0, title: "ООО Вкус" },
        { index: 1, title: "ооо вкус" },
      ],
      "ООО Вкус",
    ),
    /Ambiguous exact MAX dialog title/u,
  );
});

test("MAX binds Favorites to the reserved /0 route and All-folder index zero", () => {
  const homeSnapshot = {
    dialogs: [
      { index: 0, listIndex: "0", title: "Избранное", text: "Избранное Последняя заметка" },
      { index: 1, listIndex: "1", title: "Екатерина", text: "Екатерина Фото" },
    ],
    coverage: { complete: true, scope: "all-folder" },
  };
  const searchResults = [
    { index: 0, title: "Избранное", text: "Избранное Канал создан" },
    { index: 1, title: "ИЗБРАННОЕ", text: "ИЗБРАННОЕ Рекламный канал" },
  ];

  assert.equal(isFavoritesReference("Избранное"), true);
  assert.equal(isFavoritesReference("https://web.max.ru/0"), true);
  assert.equal(isFavoritesReference("0"), true);
  assert.equal(isFavoritesReference("https://web.max.ru/-1"), false);
  assert.equal(selectFavoritesHomeDialog(homeSnapshot)?.listIndex, "0");
  assert.throws(
    () => selectExactDialogResult(searchResults, "Избранное"),
    /Ambiguous exact MAX dialog title/u,
  );
  assert.equal(
    isFavoritesReference("Публичное Избранное"),
    false,
  );
  assert.throws(
    () => selectFavoritesHomeDialog({
      ...homeSnapshot,
      dialogs: [{ index: 0, listIndex: "0", title: "Другой" }],
    }),
    /personal Favorites could not be identified/u,
  );
});

test("MAX preserves read-only but never reuses legacy autonomous authorization", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseRuntimeArguments(["send", "--chat", "test", "--message", "hello"]);
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

test("MAX passive read guard blocks binary read receipts and forwards other traffic", async () => {
  let routeHandler = null;
  const context = {
    routeWebSocket: async (_pattern, handler) => {
      routeHandler = handler;
    },
  };
  const forwarded = [];
  let clientMessageHandler = null;
  const client = {
    connectToServer: () => ({ send: (message) => forwarded.push(message) }),
    onMessage: (handler) => {
      clientMessageHandler = handler;
    },
  };
  const state = await installPassiveReadGuard(context);
  routeHandler(client);

  const receipt = Buffer.from([0x81, ...Buffer.from("READ_MESSAGE", "utf8"), 0x01]);
  assert.equal(passiveReadFrameMarker(receipt), "READ_MESSAGE");
  assert.equal(shouldBlockPassiveReadFrame(receipt), true);
  clientMessageHandler(receipt);
  assert.equal(forwarded.length, 0);
  assert.equal(state.blockedFrames, 1);

  const historyRequest = Buffer.from("LOAD_MESSAGES", "utf8");
  clientMessageHandler(historyRequest);
  assert.deepEqual(forwarded, [historyRequest]);

  state.allowReadReceipts = true;
  clientMessageHandler(Buffer.from("READ_REACTION", "utf8"));
  assert.equal(forwarded.length, 2);
  assert.equal(state.forwardedReadFrames, 1);
});

test("MAX exact contact resolver prefers stable /u identity and rejects ambiguity", () => {
  const results = [
    { stableId: "ivan", title: "Иван", text: "Иван @ivan" },
    { stableId: "ivan-work", title: "Иван", text: "Иван @ivan-work" },
  ];
  assert.equal(normalizeContactReference("https://max.ru/u/Ivan/"), "ivan");
  assert.equal(normalizeContactReference("https://max.ru/id123_bot"), "id123_bot");
  assert.equal(selectExactContactResult(results, "@ivan").stableId, "ivan");
  assert.throws(
    () => selectExactContactResult(results, "Иван"),
    /Several exact MAX contacts/u,
  );
});

test("MAX selects an exact bot in the participant modal without a chat heading", async () => {
  // MAX's participant picker is a modal list, not a chat search result. A bot
  // should be selected by its official handle before the final Add action.
  const page = domPage('<div role="dialog"><div role="option">Рабочий бот @id123_bot</div></div>');
  const input = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    fill: async () => {},
  };
  let clicked = null;
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = (selector) => ({ last() { return this; }, click: async () => { clicked = selector; } });
  page.waitForTimeout = async () => {};

  const selected = await chooseExactPickerEntry(page, "https://max.ru/id123_bot", 5000);
  assert.equal(selected.stableId, "id123_bot");
  assert.equal(clicked, '[data-trelio-max-picker="0"]');
});

test("MAX native picker resolves a bot by exact @username when the row has no profile link", async () => {
  const page = domPage('<div role="dialog"><div role="option">ООО Вкус <span>Бот</span></div></div>');
  let filled = null;
  let clicked = false;
  const input = { last() { return this; }, count: async () => 1, isVisible: async () => true,
    fill: async (value) => { filled = value; } };
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = () => ({ last() { return this; }, click: async () => { clicked = true; } });
  page.waitForTimeout = async () => {};
  const selected = await chooseExactPickerEntry(page, "https://max.ru/id470804627750_2_bot", 5_000);
  assert.equal(filled, "@id470804627750_2_bot");
  assert.equal(selected.verifiedSearchHandle, "id470804627750_2_bot");
  assert.equal(clicked, true);
});

test("MAX bot picker accepts one badge-bearing cell without a profile link", async () => {
  // The current picker may render the Bot badge before other row details, so
  // an exact suffix is insufficient even after searching the official handle.
  const page = domPage('<div role="dialog"><div class="cell">Бот <span>Бот</span> ООО Вкус</div></div>');
  let clicked = null;
  const input = { last() { return this; }, count: async () => 1, isVisible: async () => true,
    fill: async () => {} };
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = (selector) => ({ last() { return this; }, click: async () => { clicked = selector; } });
  page.waitForTimeout = async () => {};
  const selected = await chooseExactPickerEntry(page, "https://max.ru/id470804627750_2_bot", 5_000);
  assert.equal(selected.verifiedSearchHandle, "id470804627750_2_bot");
  assert.equal(clicked, '[data-trelio-max-picker="0"]');
});

test("MAX bot picker rejects a cell without an independent Bot badge", async () => {
  const page = domPage('<div role="dialog"><div class="cell">ООО Вкус</div></div>');
  let clicked = false;
  const input = { last() { return this; }, count: async () => 1, isVisible: async () => true,
    fill: async () => {} };
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = () => ({ last() { return this; }, click: async () => { clicked = true; } });
  page.waitForTimeout = async () => {};
  await assert.rejects(() => chooseExactPickerEntry(page, "@id470804627750_2_bot", 5_000),
    (error) => error.code === "MAX_PICKER_TARGET_UNRESOLVED");
  assert.equal(clicked, false);
});

test("MAX forward picker selects the private Favorites row by chat identity", () => {
  const rows = [
    { index: 0, title: "Избранное Новости" },
    { index: 1, title: "Избранное Сообщения для себя" },
  ];
  assert.equal(selectExactForwardDestination(rows, "https://web.max.ru/0").index, 1);
  assert.throws(() => selectExactForwardDestination(rows.slice(0, 1), "https://web.max.ru/0"),
    (error) => error.code === "MAX_PICKER_TARGET_UNRESOLVED"
      && error.details.finalMutationActionStarted === false);
  assert.throws(() => selectExactForwardDestination(rows, "https://web.max.ru/-123"),
    (error) => error.code === "MAX_PICKER_TARGET_UNRESOLVED");
});

test("MAX reaction strip accepts the measured overhang but rejects a ninth control", async () => {
  const menu = { x: 301.5, y: 352, width: 308, height: 36 };
  const cells = Array.from({ length: 8 }, (_, index) => ({
    index, x: 303.5 + index * 42, y: 300, width: 32, height: 32,
  }));
  const page = (buttons) => ({ evaluate: async () => buttons, locator: () => ({}),
    waitForTimeout: async () => {} });
  assert.equal((await findVerifiedReactionStrip(page(cells), menu)).length, 8);
  let reads = 0;
  const animating = { ...page(cells), evaluate: async () => {
    reads += 1;
    return reads === 1 ? cells.map((cell, index) => index === 7 ? cell
      : { ...cell, y: 332, width: 0, height: 0 }) : cells;
  } };
  assert.equal((await findVerifiedReactionStrip(animating, menu)).length, 8);
  assert.equal(reads, 2);
  assert.equal((await findVerifiedReactionStrip(page([...cells,
    { index: 8, x: 345.5, y: 300, width: 32, height: 32 },
  ]), menu)).length, 8);
  await assert.rejects(() => findVerifiedReactionStrip(page([...cells,
    { index: 8, x: 271.5, y: 300, width: 32, height: 32 },
  ]), menu, 0), (error) => error.code === "MAX_UI_UNSUPPORTED"
    && error.details.distinctCount === 9);
});

test("MAX verifies a new reaction count on the same message without emoji text", () => {
  const before = { index: 0, timestamp: "19:38 ред.", text: "Тест 123 19:38 ред." };
  const after = { index: 0, timestamp: "19:38 ред.", text: "Тест 123 1 19:38 ред." };
  assert.equal(reactionCounterAddedToMessage(before, after), true);
  assert.equal(reactionCounterAddedToMessage(before, { ...after, text: "Другой текст 1 19:38 ред." }), false);
  assert.equal(reactionCounterAddedToMessage(before, { ...after, text: "Тест 123 0 19:38 ред." }), false);
  assert.equal(reactionCounterAddedToMessage(before, { ...after, timestamp: "19:39" }), false);
});

test("MAX chat settings choose the title input, never the description or composer", async () => {
  const makeField = (box) => ({ isVisible: async () => true, boundingBox: async () => box });
  const title = makeField({ x: 560, y: 220, width: 615, height: 50 });
  const search = makeField({ x: 20, y: 80, width: 380, height: 40 });
  const description = makeField({ x: 560, y: 325, width: 615, height: 60 });
  const composer = makeField({ x: 560, y: 740, width: 615, height: 50 });
  const page = {
    viewportSize: () => ({ width: 1280, height: 900 }),
    getByText: () => ({ count: async () => 1 }),
    locator: (selector) => {
      const entries = selector === "textarea" ? [description, composer] : [search, title];
      return { count: async () => entries.length, nth: (index) => entries[index] };
    },
  };
  assert.equal(await findChatSettingsField(page, "title"), title);
  assert.equal(await findChatSettingsField(page, "description"), description);
  const ambiguous = { ...page, locator: () => ({ count: async () => 2,
    nth: () => title }) };
  await assert.rejects(() => findChatSettingsField(ambiguous, "title"),
    (error) => error.code === "MAX_UI_UNSUPPORTED");
});

test("MAX chat description clearing is bound to the structural approval hash", () => {
  const withDescription = parseRuntimeArguments([
    "chat-update", "--chat", "https://web.max.ru/-123", "--title", "Исходное название",
    "--description", "",
  ]);
  assert.equal(withDescription.description, "");
  const preview = buildMutationPreview(withDescription);
  assert.equal(preview.operation.description, "");
  const changed = parseRuntimeArguments([
    "chat-update", "--chat", "https://web.max.ru/-123", "--title", "Исходное название",
    "--description", "другое",
  ]);
  assert.notEqual(buildMutationPreview(changed).approvalHash, preview.approvalHash);
  assert.throws(() => validateCommandOptions(parseRuntimeArguments([
    "send", "--chat", "A", "--message", "B", "--description", "X",
  ])),
    /does not accept --description/u);
});

test("MAX native group creation searches a short name but selects only the full person", async () => {
  const page = domPage('<div role="dialog"><div role="option" style="display:none">Ольга Бурлева Додо Вкус исполнительный директор Был(-а) недавно</div></div>');
  const result = page.document.querySelector('[role="option"]');
  const queries = [];
  const input = { last() { return this; }, count: async () => 1, isVisible: async () => true,
    fill: async (value) => { queries.push(value); result.style.display = value === "ольга" ? "block" : "none"; } };
  let clicked = false;
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = () => ({ last() { return this; }, click: async () => { clicked = true; } });
  page.waitForTimeout = async () => {};
  const selected = await chooseExactPickerEntry(page, "Ольга Бурлева Додо Вкус исполнительный директор", 5_000);
  assert.deepEqual(queries, ["ольга бурлева додо вкус исполнительный директор", "ольга"]);
  assert.match(selected.title, /^Ольга Бурлева/u);
  assert.equal(clicked, true);
});

test("MAX picker keeps ambiguous bots separate and never clicks a wrong identity", async () => {
  const page = domPage('<div role="dialog"><div role="option">Первый @id123_bot</div><div role="option">Второй @id123_bot</div><div role="option">Похожий @id1234_bot</div></div>');
  const input = { last() { return this; }, count: async () => 1, isVisible: async () => true, fill: async () => {} };
  let clicked = false;
  page.getByPlaceholder = () => input;
  page.getByRole = () => input;
  page.locator = () => ({ last() { return this; }, click: async () => { clicked = true; } });
  page.waitForTimeout = async () => {};
  assert.equal((await collectPickerResults(page)).length, 3);
  await assert.rejects(() => chooseExactPickerEntry(page, "@id123_bot", 5000),
    (error) => error instanceof MaxRuntimeError && error.code === "MAX_PICKER_TARGET_UNRESOLVED"
      && error.details.finalMutationActionStarted === false);
  assert.equal(clicked, false);
});

test("MAX recognizes official bot links only inside visible chat participant details", async () => {
  const page = domPage('<div role="listitem" class="message"><a href="https://max.ru/id999_bot">Ссылка в переписке</a></div><section class="chatInfo"><h2>Участники 2</h2><div class="member"><a href="https://max.ru/id123_bot">Рабочий бот</a></div></section>');
  const members = await collectVisibleMembers(page);
  assert.equal(selectExactContactResult(members, "@id123_bot").stableId, "id123_bot");
  assert.throws(() => selectExactContactResult(members, "@id999_bot"), /No exact MAX contacts/u);
});

test("MAX refuses a message list as membership when participant details are absent", async () => {
  const page = domPage('<div role="listitem" class="message"><a href="https://max.ru/id123_bot">Рабочий бот</a></div>');
  await assert.rejects(() => collectVisibleMembers(page), /Could not safely identify the MAX participant list/u);
});

test("MAX native members reads full-width participant buttons from the current group details", async () => {
  const page = domPage(`<div role="listitem" class="message"><a href="https://max.ru/id999_bot">Чужая ссылка</a></div>
    <section class="infoPanel"><button data-rect="575,441,95,40">Участники 2</button>
    <button data-rect="563,550,624,56">Добавить участников</button>
    <button data-rect="563,606,624,56">Пригласить по ссылке</button>
    <button data-rect="563,662,624,56">Владислав Иващенко ·владелец (вы) В сети</button>
    <button data-rect="563,718,624,56">Ольга Бурлева Додо Вкус исполнительный директор Был(-а) недавно</button></section>`);
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    const [x, y, width, height] = this.getAttribute("data-rect")
      ? this.getAttribute("data-rect").split(",").map(Number) : [0, 0, 300, 60];
    return { x, y, width, height, right: x + width, bottom: y + height };
  };
  const members = await collectVisibleMembers(page);
  assert.equal(members.length, 2);
  assert.match(members[0].title, /Владислав Иващенко/u);
  assert.match(members[1].title, /Ольга Бурлева/u);
  assert.equal(members.some((member) => member.title.includes("Чужая ссылка")), false);
});

test("MAX reads every virtualized member before treating a bot as absent", async () => {
  const page = domPage(`<button>Чужой диалог</button><section class="infoPanel">
    <button>Участники 18</button><button>Добавить участников</button>
    <button>Пригласить по ссылке</button><div class="participants-scroll" style="overflow-y:auto"></div>
  </section>`);
  const scroller = page.document.querySelector(".participants-scroll");
  let top = 0;
  Object.defineProperties(scroller, {
    clientHeight: { value: 300 }, scrollHeight: { configurable: true, value: 1080 },
    scrollTop: { get: () => top, set: (value) => {
      top = Math.min(780, Math.max(0, value));
      const first = Math.min(12, Math.floor(top / 60));
      scroller.innerHTML = Array.from({ length: 6 }, (_, offset) =>
        `<div class="member">Участник ${first + offset + 1}</div>`).join("");
    } },
  });
  scroller.scrollTop = 0;
  page.waitForTimeout = async () => {};
  const complete = await collectCompleteMembers(page, { timeoutMs: 5000 });
  assert.equal(complete.coverage.complete, true);
  assert.equal(complete.members.length, 18);
  assert.equal(complete.members.at(-1).title, "Участник 18");
  scroller.scrollTop = 0;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 300 });
  await assert.rejects(() => collectCompleteMembers(page, { timeoutMs: 5000 }),
    (error) => error instanceof MaxRuntimeError && error.code === "MAX_UI_UNSUPPORTED"
      && /incomplete/u.test(error.message));
});

test("MAX recognizes the current accessible new-chat action", async () => {
  let clicked = false;
  const action = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { clicked = true; },
  };
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.match("Начать общение", options.name);
      return action;
    },
  };
  await clickNewChatAction(page, 5_000);
  assert.equal(clicked, true);
});

test("MAX chooses the current group menu item without selecting a group call", async () => {
  let clicked = false;
  const visible = { last() { return this; }, count: async () => 1,
    isVisible: async () => true, click: async () => { clicked = true; } };
  const absent = { last() { return this; }, count: async () => 0 };
  const page = { getByRole(role, options) {
    if (role === "menuitem") {
      assert.match("Создать группу", options.name);
      assert.doesNotMatch("Создать групповой звонок", options.name);
      return visible;
    }
    return absent;
  }, getByText: () => absent };
  await clickCreateGroupMenuAction(page, 5_000);
  assert.equal(clicked, true);
});

test("MAX identity references cannot match a different bot's display name", () => {
  const results = [{ stableId: "id999_bot", title: "id123_bot", text: "id123_bot" }];
  assert.throws(() => selectExactContactResult(results, "@id123_bot"), /No exact MAX contacts/u);
  assert.throws(() => selectExactContactResult(results, "https://max.ru/id123_bot"), /No exact MAX contacts/u);
});

test("MAX structural mutations bind confirmation to the exact dry-run payload", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trelio-max-test-"));
  const previousConfigHome = process.env.TRELIO_CONFIG_HOME;
  process.env.TRELIO_CONFIG_HOME = temporary;
  try {
    const options = parseRuntimeArguments([
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

// A real DOM selector engine is essential here: the original fake-page tests
// never exercised the collision between avatarBadgeWrapper and unread badges.
// All content is synthetic; no captured chats or provider credentials in Git.
const domPage = (html, pathname = "/") => {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const style = (node) => ({ display: node.style?.display || "block", visibility: "visible", overflowY: node.style?.overflowY || "visible" });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.style.display === "none" ? 0 : 300, height: 60, right: 600 };
  };
  const context = vm.createContext({ document, window: { location: { origin: "https://web.max.ru", pathname, href: `https://web.max.ru${pathname}` }, getComputedStyle: style, innerWidth: 1280, innerHeight: 900 }, getComputedStyle: style, URL, HTMLElement: window.HTMLElement, HTMLAnchorElement: window.HTMLAnchorElement, HTMLInputElement: window.HTMLInputElement });
  return { document, evaluate: async (callback, arg) => {
    context.argument = arg;
    // Serialize only the result so cross-realm objects compare as ordinary JSON.
    return JSON.parse(JSON.stringify(vm.runInContext(`(${callback.toString()})(argument)`, context)));
  } };
};
const row = (title, badge = "", extra = "", attrs = "") => `<button ${attrs}><div class="avatarBadgeWrapper"><img></div><h3 class="title"><span class="name">${title}</span></h3>${badge}<span>${extra}</span></button>`;
const unreadBadge = (count) => `<div class="badgeIcon" aria-label=", ${count} новое сообщение, "><span>${count}</span></div>`;

test("MAX recognizes only an explicit international phone as a phone lookup", () => {
  assert.equal(normalizePhoneLookupQuery("+1 (202) 555-0123"), "+12025550123");
  assert.equal(normalizePhoneLookupQuery("Виктория"), null);
  assert.equal(normalizePhoneLookupQuery("12025550123"), null);
  assert.equal(normalizePhoneLookupQuery("+1 202"), null);
});

test("MAX phone search uses the provider action and proves the opened chat route", async () => {
  let route = "https://web.max.ru/";
  let filledSearch = null;
  let filledPhone = null;
  const searchField = {
    first() { return this; },
    count: async () => 1, isVisible: async () => true, click: async () => {},
    fill: async (value) => { filledSearch = value; },
  };
  const phoneField = {
    isVisible: async () => true,
    fill: async (value) => { filledPhone = value; },
  };
  const page = {
    getByPlaceholder: () => searchField,
    getByRole: (_role, { name }) => ({
      first() { return this; },
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        if (String(name).includes("продолжить")) route = "https://web.max.ru/123456789";
      },
    }),
    locator: () => ({ first() { return this; }, count: async () => 1, nth: () => phoneField }),
    waitForTimeout: async () => {},
    evaluate: async () => ({ path: new URL(route).pathname,
      chatReady: route !== "https://web.max.ru/", title: "Виктория", notFoundOrPrivate: false }),
    url: () => route,
  };
  const result = await lookupContactByPhone(page, { timeoutMs: 50 }, "+12025550123");
  assert.equal(filledSearch, "+12025550123");
  assert.equal(filledPhone, "+12025550123");
  assert.deepEqual(result.contacts, [{ title: "Виктория", url: route,
    matchMethod: "provider-phone-lookup" }]);
  assert.equal(result.lookupState, "matched");
});

test("MAX phone search never treats missing provider action as an empty contact list", async () => {
  const searchField = { count: async () => 1, isVisible: async () => true,
    click: async () => {}, fill: async () => {}, first() { return this; } };
  const page = { getByPlaceholder: () => searchField,
    getByRole: () => ({ first() { return this; }, count: async () => 0 }),
    locator: () => ({ first() { return this; }, count: async () => 0 }),
    waitForTimeout: async () => {} };
  await assert.rejects(() => lookupContactByPhone(page, { timeoutMs: 50 }, "+12025550123"),
    /Find by number action/u);
});

test("MAX reads a phone only from the visible contact profile", async () => {
  const page = domPage('<div class="messageWrapper">Напишите +1 415 555-0100</div>'
    + '<div role="dialog"><h2>Виктория</h2><div><span>Номер телефона</span>'
    + '<a href="tel:+12025550123">+1 202 555-0123</a></div></div>', "/123456789");
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 600, y: 100, width: 300, height: 80 };
  };
  const profile = await collectContactProfile(page);
  assert.equal(profile.recognized, true);
  assert.equal(profile.phone, "+1 202 555-0123");
  assert.equal(profile.phoneVisibility, "visible");

  page.document.querySelector("a").remove();
  const hidden = await collectContactProfile(page);
  assert.equal(hidden.phone, null);
  assert.equal(hidden.phoneVisibility, "not_visible_in_profile");

  const sidebarOnly = domPage('<aside><h3>Другая переписка</h3>'
    + '<a href="tel:+12025550123">+1 202 555-0123</a></aside>', "/123456789");
  sidebarOnly.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 600, y: 100, width: 300, height: 80 };
  };
  assert.equal((await collectContactProfile(sidebarOnly)).recognized, false);
});

test("MAX opens details by the one labelled chat-header button on a numeric URL", async () => {
  const page = domPage('<button data-x="77">Другой чат</button>'
    + '<button data-x="520">Виктория</button>'
    + '<button data-x="520" data-y="73">Добавить в контакты</button>'
    + '<button data-x="1060" aria-label="Позвонить"></button>', "/123456789");
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: Number(this.getAttribute("data-x") || 0),
      y: Number(this.getAttribute("data-y") || 35), width: 200, height: 45 };
  };
  let clicked = false;
  page.getByRole = () => ({ count: async () => 0 });
  page.locator = (selector) => selector.startsWith('[data-testid')
    ? { last: () => ({ count: async () => 0 }) }
    : { click: async () => {
      assert.equal(page.document.querySelectorAll('[data-trelio-max-chat-header="true"]').length, 1);
      assert.equal(page.document.querySelector('[data-trelio-max-chat-header="true"]').textContent, "Виктория");
      clicked = true;
    } };
  page.waitForTimeout = async () => {};
  await openChatDetails(page, { chat: "https://web.max.ru/123456789", timeoutMs: 1000 });
  assert.equal(clicked, true);
});

test("MAX opens the named profile action from a numeric URL before banner buttons", async () => {
  let clicked = false;
  const page = {
    getByRole: (role, { name }) => {
      assert.equal(role, "button");
      assert.match("Открыть профиль Виктория", name);
      return { count: async () => 1, isVisible: async () => true,
        click: async () => { clicked = true; } };
    },
    locator: () => { throw new Error("Generic header lookup must not run"); },
    evaluate: () => { throw new Error("Banner geometry lookup must not run"); },
    waitForTimeout: async () => {},
  };
  await openChatDetails(page, { chat: "https://web.max.ru/123456789", timeoutMs: 1000 });
  assert.equal(clicked, true);
});

test("MAX does not call a bare phone-search route a verified contact", async () => {
  const home = domPage('<main><div role="status">Ничего не найдено</div></main>');
  const state = await inspectPhoneLookupOutcome(home);
  assert.equal(state.chatReady, false);
  assert.equal(state.notFoundOrPrivate, true);
  const direct = domPage('<main><header><h2>Виктория</h2></header><div contenteditable="true"></div></main>', "/123456789");
  assert.equal((await inspectPhoneLookupOutcome(direct)).chatReady, true);
});

test("MAX assisted snapshot prioritizes the participant modal over the chat list", async () => {
  const page = domPage(`<button>Другой чат</button><div role="dialog"><input placeholder="Поиск участников">
    <div role="option">Рабочий бот @id123_bot</div><button>Добавить</button></div>`);
  const controls = await collectAssistControls(page);
  assert.equal(controls[0].role, "input");
  assert.equal(controls[0].label, "Поиск участников");
  assert.equal(controls[1].role, "option");
  assert.match(controls[1].label, /id123_bot/u);
  assert.equal(controls.at(-1).label, "Добавить");
  assert.equal(controls.some((control) => control.label === "Другой чат"), false);
  assert.equal(page.document.querySelectorAll("[data-trelio-max-assist-ref]").length, controls.length);
  const before = await assistPageDigest(page);
  page.document.querySelector("body > button").textContent = "Фоновое обновление чата";
  assert.equal(await assistPageDigest(page), before);
  page.document.querySelector("input").value = "id123_bot";
  const after = await assistPageDigest(page);
  assert.match(before, /^[0-9a-f]{64}$/u);
  assert.notEqual(after, before);
});

test("MAX assisted snapshot keeps the Add footer when focus is inside a nested modal list", async () => {
  const page = domPage(`<button>Другой чат</button><div class="modal-shell" data-size="440,700">
    <div class="modal-list" data-size="360,500"><input placeholder="Найти по имени">
    <div role="option">ООО Вкус Бот</div></div><button>Добавить</button></div>`);
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    const [width, height] = this.getAttribute("data-size")
      ? this.getAttribute("data-size").split(",").map(Number) : [300, 60];
    return { x: 440, y: 100, width, height, right: 440 + width, bottom: 100 + height };
  };
  Object.defineProperty(page.document, "activeElement", {
    configurable: true, value: page.document.querySelector("input"),
  });
  const controls = await collectAssistControls(page);
  assert.equal(controls.some((control) => control.label === "Добавить"), true);
  assert.equal(controls.some((control) => control.label === "Другой чат"), false);
});

test("MAX assisted snapshot binds a wide picker instead of a changing sidebar", async () => {
  const page = domPage(`<button id="sidebar">Другой чат</button><div class="modal-shell" data-size="1190,850">
    <div class="modal-list" data-size="1070,620"><input placeholder="Найти по имени">
    <div role="option">ООО Вкус Бот</div></div><button>Добавить</button></div>`);
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    const [width, height] = this.getAttribute("data-size")
      ? this.getAttribute("data-size").split(",").map(Number) : [300, 60];
    return { x: 40, y: 20, width, height, right: 40 + width, bottom: 20 + height };
  };
  Object.defineProperty(page.document, "activeElement", { configurable: true, value: page.document.body });
  const controls = await collectAssistControls(page);
  assert.equal(controls.some((control) => control.label === "Добавить"), true);
  assert.equal(controls.some((control) => control.label === "Другой чат"), false);
  const before = await assistPageDigest(page);
  page.document.querySelector("#sidebar").textContent = "Новое сообщение";
  assert.equal(await assistPageDigest(page), before);
});

test("MAX download snapshots ignore background updates but bind the exact attachment", async () => {
  const page = domPage('<button id="sidebar">Other chat</button><input id="composer">'
    + '<div data-trelio-max-assist-download-surface="true">report.docx'
    + '<button id="file" aria-label="Скачать">Скачать • 1 MB</button>'
    + '<button id="reply">Ответить</button></div>');
  const initial = await assistPageDigest(page, false, true);
  const controls = await collectAssistControls(page, false, true);
  assert.deepEqual(controls.map(({label}) => label), ['Скачать']);
  assert.equal(page.document.querySelector('#sidebar').hasAttribute('data-trelio-max-assist-ref'), false);
  page.document.querySelector('#sidebar').textContent = 'New preview and presence';
  page.document.querySelector('#composer').value = 'Other draft';
  assert.equal(await assistPageDigest(page, false, true), initial);
  page.screenshot = async () => {
    page.document.querySelector('#sidebar').textContent += ' update';
    return Buffer.from('image');
  };
  const captured = await captureStableAssistFrame(page, false, true);
  assert.equal(captured.fingerprint, initial);
  page.document.querySelector('#file').textContent = 'Скачать • 2 MB';
  assert.notEqual(await assistPageDigest(page, false, true), initial);
  page.document.querySelector('#file').remove();
  await assert.rejects(assistPageDigest(page, false, true),
    error => error.code === 'MAX_ASSIST_DOWNLOAD_TARGET_CHANGED');
});

test("MAX download points cannot reach an unrelated control or a covering overlay", async () => {
  const page = domPage('<button id="other">Send</button>'
    + '<div data-trelio-max-assist-download-surface="true"><button id="file">Скачать</button></div>');
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    return {x:this.id === 'other'?20:500,y:700,width:300,height:60};
  };
  page.document.elementFromPoint = () => page.document.querySelector('#file');
  assert.equal((await inspectAssistDownloadSurface(page, {point:{x:550,y:720}})).pointAllowed, true);
  assert.equal((await inspectAssistDownloadSurface(page, {point:{x:50,y:720}})).pointAllowed, false);
  page.document.elementFromPoint = () => page.document.querySelector('#other');
  assert.equal((await inspectAssistDownloadSurface(page, {point:{x:550,y:720}})).pointAllowed, false);
  page.document.querySelector('[data-trelio-max-assist-download-surface]').remove();
  await assert.rejects(inspectAssistDownloadSurface(page), error => error.code === 'MAX_ASSIST_DOWNLOAD_TARGET_CHANGED');
});

test("MAX erases download pixels if its exact control disappears during capture", async () => {
  const page = domPage('<div data-trelio-max-assist-download-surface="true"><button>Скачать</button></div>');
  const image = Buffer.from('private screenshot');
  page.screenshot = async () => {
    page.document.querySelector('button').remove();
    return image;
  };
  await assert.rejects(captureStableAssistFrame(page, false, true),
    error => error.code === 'MAX_ASSIST_DOWNLOAD_TARGET_CHANGED');
  assert.equal(image.every(byte => byte === 0), true);
});

test("MAX retries only a changing screenshot and erases the discarded image", async () => {
  const page = domPage('<div role="dialog"><input placeholder="Найти по имени"><button>Добавить</button></div>');
  let captures = 0;
  const images = [];
  page.screenshot = async () => {
    captures += 1;
    const image = Buffer.from(`image-${captures}`);
    images.push(image);
    if (captures === 1) page.document.querySelector('input').value = 'бот';
    return image;
  };
  page.waitForTimeout = async () => {};
  const result = await captureStableAssistFrame(page);
  assert.equal(captures, 2);
  assert.equal(images[0].every((byte) => byte === 0), true);
  assert.equal(result.bytes, images[1]);
  assert.equal(result.controls.some((control) => control.label === 'Добавить'), true);
});

test("MAX member snapshots ignore sidebar and presence updates but bind the participant scroller", async () => {
  const page = domPage(`<button id="sidebar">Чужой диалог</button><section class="infoPanel">
    <div class="toolbar"><button>Участники 18</button><button>Добавить участников</button>
    <button>Пригласить по ссылке</button></div><div class="participants-scroll" style="overflow-y:auto">
    <button class="member">Участник 1 В сети</button></div></section>`, "/-12345");
  const scroller = page.document.querySelector(".participants-scroll");
  let top = 0;
  Object.defineProperties(scroller, {
    clientHeight: { value: 300 }, scrollHeight: { value: 1080 },
    scrollTop: { get: () => top, set: (value) => { top = Math.min(780, Math.max(0, value)); } },
  });
  const controls = await collectAssistControls(page, true);
  assert.equal(controls.some((control) => control.label === "Чужой диалог"), false);
  assert.equal(controls.some((control) => control.label === "Участник 1 В сети"), true);
  const before = await assistPageDigest(page, true);
  page.document.querySelector("#sidebar").textContent = "Новое сообщение";
  page.document.querySelector(".member").textContent = "Участник 1 Был недавно";
  assert.equal(await assistPageDigest(page, true), before);
  assert.deepEqual(await scrollAssistMemberSurface(page, 600),
    { recognized: true, moved: true, atEnd: false });
  assert.notEqual(await assistPageDigest(page, true), before);
});

test("MAX assisted scroll accepts a short participant list with or without a count", async () => {
  const page = domPage(`<button>Чужой диалог</button><section class="infoPanel">
    <button data-rect="575,441,95,40">Участники 2</button>
    <button data-rect="563,550,624,56">Добавить участников</button>
    <button data-rect="563,606,624,56">Пригласить по ссылке</button>
    <button data-rect="563,662,624,56">Владислав</button>
    <button data-rect="563,718,624,56">Ольга</button></section>`, "/-12345");
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    const [x, y, width, height] = this.getAttribute("data-rect")
      ? this.getAttribute("data-rect").split(",").map(Number) : [0, 0, 300, 60];
    return { x, y, width, height, right: x + width, bottom: y + height };
  };
  await collectAssistControls(page, true);
  assert.deepEqual(await scrollAssistMemberSurface(page, 600),
    { recognized: true, moved: false, atEnd: true });
  page.document.querySelector(".infoPanel button").textContent = "Участники";
  assert.deepEqual(await scrollAssistMemberSurface(page, 600),
    { recognized: true, moved: false, atEnd: true });
  page.document.querySelector(".infoPanel button").textContent = "Участники 3";
  assert.deepEqual(await scrollAssistMemberSurface(page, 600),
    { recognized: false, moved: false, atEnd: true });
});

test("MAX unknown participant layout still permits a bounded visual screenshot route", async () => {
  const page = domPage(`<aside id="sidebar">Чужой чат</aside><main>
    <button id="members">Участники</button><button id="remove">Удалить участника</button>
    <div id="list">Участники группы</div></main>`, "/-12345");
  const digest = await assistPageDigest(page, true);
  assert.equal(typeof digest, "string");
  assert.equal(digest.length, 64);
  assert.deepEqual(await collectAssistControls(page, true), []);
  page.document.querySelector("#sidebar").textContent = "Новое сообщение";
  assert.equal(await assistPageDigest(page, true), digest);
  page.document.elementFromPoint = () => page.document.querySelector("#members");
  let opened = 0;
  page.document.querySelector("#members").addEventListener("click", () => { opened += 1; });
  assert.deepEqual(await inspectVisualMemberPoint(page, {
    command: "point-click", x: 850, y: 450,
  }), { allowed: true });
  assert.deepEqual(await inspectVisualMemberPoint(page, {
    command: "point-click", x: 850, y: 450,
  }, true), { allowed: true });
  assert.equal(opened, 1);
  page.document.elementFromPoint = () => page.document.querySelector("#remove");
  let removed = 0;
  page.document.querySelector("#remove").addEventListener("click", () => { removed += 1; });
  assert.deepEqual(await inspectVisualMemberPoint(page, {
    command: "point-click", x: 850, y: 450,
  }, true), { allowed: false });
  assert.equal(removed, 0);
  assert.deepEqual(await inspectVisualMemberPoint(page, {
    command: "point-scroll", x: 850, y: 700,
  }), { allowed: true });
  assert.deepEqual(await inspectVisualMemberPoint(page, {
    command: "point-scroll", x: 100, y: 700,
  }), { allowed: false });
});

test("MAX visual member recovery can open the exact chat header but not a call", async () => {
  const page = domPage('<button id="header">Курьеры Ломоносов-1</button><button id="call">Звонок</button>', '/-12345');
  page.document.defaultView.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 600, y: 8, width: 250, height: 48 };
  };
  let opened = 0;
  page.document.querySelector('#header').addEventListener('click', () => { opened += 1; });
  page.document.elementFromPoint = () => page.document.querySelector('#header');
  assert.deepEqual(await inspectVisualMemberPoint(page,
    { command: 'point-click', x: 700, y: 30 }, true), { allowed: true });
  assert.equal(opened, 1);
  page.document.elementFromPoint = () => page.document.querySelector('#call');
  assert.deepEqual(await inspectVisualMemberPoint(page,
    { command: 'point-click', x: 700, y: 30 }, true), { allowed: false });
});

test("MAX assisted browser installs the read-only gate before application handlers", () => {
  const setupGate = (mode) => {
    const { window, document } = parseHTML(`
      <html><body>
        <input id="search" type="search" placeholder="Поиск">
        <button id="chat"><h3>Госключ</h3><span>Отправьте документы, которые хотите подписать</span></button>
        <button id="send">Отправить</button>
        <textarea id="composer" placeholder="Сообщение"></textarea>
        <a id="external" href="https://example.test/">Справка</a>
      </body></html>
    `);
    window.innerWidth = 1280;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.id === "composer") return { x: 700, y: 820, width: 400, height: 48 };
      if (this.id === "send") return { x: 500, y: 80, width: 120, height: 40 };
      return { x: 20, y: this.id === "search" ? 40 : 160, width: 320, height: 52 };
    };
    const context = vm.createContext({
      window,
      document,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      MutationObserver: window.MutationObserver,
      URL,
    });
    vm.runInContext(`(${installMaxAssistGate.toString()})({ mode: ${JSON.stringify(mode)} })`, context);
    return { window, document };
  };

  const { window, document } = setupGate("read-only");

  const allowedInput = new window.Event("beforeinput", { bubbles: true, cancelable: true });
  document.querySelector("#search").dispatchEvent(allowedInput);
  assert.equal(allowedInput.defaultPrevented, false);

  const allowedChat = new window.Event("click", { bubbles: true, cancelable: true });
  document.querySelector("#chat").dispatchEvent(allowedChat);
  assert.equal(allowedChat.defaultPrevented, false);

  const blockedSend = new window.Event("click", { bubbles: true, cancelable: true });
  document.querySelector("#send").dispatchEvent(blockedSend);
  assert.equal(blockedSend.defaultPrevented, true);

  const blockedComposer = new window.Event("beforeinput", { bubbles: true, cancelable: true });
  document.querySelector("#composer").dispatchEvent(blockedComposer);
  assert.equal(blockedComposer.defaultPrevented, true);
  assert.equal(document.querySelector("#composer").readOnly, true);
  assert.equal(window.__trelioMaxAssistState.blockedActions, 2);
});

test("MAX manual-control gate allows the authorized UI but blocks external navigation", () => {
  // linkedom shares arbitrary Window properties inside one process. Exercise
  // the second immutable gate mode in a fresh process so this test cannot
  // accidentally reuse the read-only page's state.
  const source = `
    import assert from "node:assert/strict";
    import { parseHTML } from "linkedom";
    import { installMaxAssistGate } from ${JSON.stringify(new URL("../scripts/trelio-max.mjs", import.meta.url).href)};
    const { window, document } = parseHTML(
      '<html><body><button id="send">Отправить</button>'
      + '<textarea id="composer" placeholder="Сообщение"></textarea>'
      + '<a id="external" href="https://example.test/">Справка</a></body></html>',
    );
    window.innerWidth = 1280;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 20, y: 40, width: 320, height: 52 });
    Object.assign(globalThis, {
      window,
      document,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      HTMLAnchorElement: window.HTMLAnchorElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      MutationObserver: window.MutationObserver,
    });
    installMaxAssistGate({ mode: "manual-control" });
    const allowedSend = new window.Event("click", { bubbles: true, cancelable: true });
    document.querySelector("#send").dispatchEvent(allowedSend);
    assert.equal(allowedSend.defaultPrevented, false);
    const allowedComposer = new window.Event("beforeinput", { bubbles: true, cancelable: true });
    document.querySelector("#composer").dispatchEvent(allowedComposer);
    assert.equal(allowedComposer.defaultPrevented, false);
    const allowedEnter = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(allowedEnter, "key", { value: "Enter" });
    document.body.dispatchEvent(allowedEnter);
    assert.equal(allowedEnter.defaultPrevented, false);
    const blockedExternal = new window.Event("click", { bubbles: true, cancelable: true });
    document.querySelector("#external").dispatchEvent(blockedExternal);
    assert.equal(blockedExternal.defaultPrevented, true);
    assert.equal(window.__trelioMaxAssistState.mode, "manual-control");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("MAX assisted download gate permits only the active file gateway transfer", () => {
  for (const { mode, fallbackFor, ready, allowed } of [
    { mode: "manual-control", fallbackFor: "download", ready: true, allowed: true },
    { mode: "manual-control", fallbackFor: "download", ready: false, allowed: false },
    { mode: "manual-control", fallbackFor: "members", ready: true, allowed: false },
    { mode: "read-only", fallbackFor: "read", ready: true, allowed: false },
  ]) {
    // Each page gets a fresh immutable gate. Reproduce the temporary anchor
    // used by the real MAX file button, including its synthetic click.
    const source = `
      import assert from "node:assert/strict";
      import { parseHTML } from "linkedom";
      import { installMaxAssistGate } from ${JSON.stringify(new URL("../scripts/trelio-max.mjs", import.meta.url).href)};
      const { window, document } = parseHTML('<html><body><a id="file">file</a></body></html>');
      window.innerWidth = 1280;
      window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
      Object.assign(globalThis, { window, document, Element: window.Element,
        HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
        HTMLTextAreaElement: window.HTMLTextAreaElement, MutationObserver: window.MutationObserver });
      if (${ready}) window.__trelioMaxDownloadNavigation = {};
      installMaxAssistGate({mode: ${JSON.stringify(mode)}, fallbackFor: ${JSON.stringify(fallbackFor)}});
      for (const [href, permit] of [
        ['https://fd.oneme.ru/file', ${allowed}],
        ['http://fd.oneme.ru/file', false],
        ['https://fd.oneme.ru.example.test/file', false],
        ['https://fd.oneme.ru:444/file', false],
        ['https://user@fd.oneme.ru/file', false],
        ['https://example.test/file', false],
      ]) {
        const anchor = document.querySelector('#file'); anchor.setAttribute('href', href);
        const click = new window.Event('click', {bubbles: true, cancelable: true});
        anchor.dispatchEvent(click);
        assert.equal(click.defaultPrevented, !permit, href);
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("MAX reports a DOM-gate denial even when the browser click completes", async () => {
  await assertAssistGateActionCompleted({ evaluate: async () => 3 }, 3);
  await assert.rejects(assertAssistGateActionCompleted({ evaluate: async () => 4 }, 3),
    (error) => error.code === "MAX_ASSIST_ACTION_BLOCKED"
      && /Inspect live state/u.test(error.message));
});

test("MAX distinguishes a delayed login screen from the authenticated home", async () => {
  const outerShell = domPage('<button aria-label="Изменить язык"></button><a>Помощь</a>');
  assert.deepEqual(await outerShell.evaluate(inspectMaxSessionDocument, false), {
    loginReady: false,
    authenticatedReady: false,
  });

  // Some login variants mention messages in promotional copy. The exact QR /
  // phone-login controls still take precedence and must never fall through to
  // the authenticated dialog-search probe.
  const login = domPage(
    '<h3>Войдите в MAX по QR-коду</h3>'
      + '<p>Общайтесь и читайте сообщения после входа</p>'
      + '<button>Войти по номеру телефона</button>',
  );
  assert.deepEqual(await login.evaluate(inspectMaxSessionDocument, false), {
    loginReady: true,
    authenticatedReady: false,
  });

  const expiredLogin = domPage(
    '<h3>QR-код устарел</h3>'
      + '<p>Авторизационная сессия не найдена</p>'
      + '<button aria-label="Обновить QR-код"></button>'
      + '<button>Войти по номеру телефона</button>',
  );
  assert.equal(
    (await expiredLogin.evaluate(inspectMaxSessionDocument, false)).loginReady,
    true,
  );

  const authenticated = domPage(
    '<button><span>Все</span></button>'
      + '<input placeholder="Поиск">'
      + row("Избранное"),
  );
  assert.deepEqual(await authenticated.evaluate(inspectMaxSessionDocument, false), {
    loginReady: false,
    authenticatedReady: true,
  });

  const directChat = domPage(
    '<main><div class="messageWrapper">Сообщение</div><div contenteditable="true"></div></main>',
    "/-123",
  );
  assert.equal(
    (await directChat.evaluate(inspectMaxSessionDocument, false)).authenticatedReady,
    true,
  );
});

test("MAX recognizes chat unread badges after avatars and excludes every folder", async () => {
  const page = domPage(`<nav><button><span class="title">Все 6</span><span aria-label="непрочитанных чатов 6">6</span></button><button><span class="title">Важное 1</span></button></nav>${row("Анна", unreadBadge(2))}${row("Дом 52", unreadBadge(25))}${row("Чат 2026", "", "Получено 8 сентября")}`);
  const results = await collectDialogResults(page, "", true);
  assert.deepEqual(results.map(({ title, unreadCount }) => ({ title, unreadCount })), [
    { title: "Анна", unreadCount: 2 }, { title: "Дом 52", unreadCount: 25 },
  ]);
});

test("MAX never infers unread from dates, titles, preview text or avatar decoration", async () => {
  const page = domPage(row("52 новых сообщения", "", "12 новых сообщений получено 2026", 'aria-label="Дом 52, 8 сентября"'));
  assert.equal((await collectDialogResults(page, "", true)).length, 0);
  assert.equal((await collectDialogResults(page))[0].unreadCount, 0);
});

test("MAX retains long previews and muted chats; hidden and nested actions are excluded", async () => {
  const page = domPage(`<div role="listitem">${row("Длинный чат", unreadBadge(3), "я".repeat(1200))}</div>${row("Скрытый", unreadBadge(5), "", 'style="display:none"')}${row("Тихий", unreadBadge(9), '<span aria-label="уведомления отключены"></span>')}`);
  const results = await collectDialogResults(page, "", true);
  assert.deepEqual(results.map((r) => [r.title, r.unreadCount]), [["Длинный чат", 3], ["Тихий", 9]]);
});

test("MAX preserves duplicate titles for exact target ambiguity instead of merging chats", async () => {
  const results = await collectDialogResults(domPage(row("Анна", unreadBadge(1)) + row("Анна", unreadBadge(2))));
  assert.equal(results.length, 2);
  assert.throws(() => selectExactDialogResult(results, "Анна"), /Ambiguous exact/u);
});

test("MAX query discovery matches chat titles, not folder labels or message previews", async () => {
  const results = await collectDialogResults(domPage(`<button><span class="title">Работа</span></button>${row("Команда Работа")}${row("Другой", "", "Работа")}`), "работа");
  assert.deepEqual(results.map((r) => r.title), ["Команда Работа"]);
});

test("MAX unknown unread count stays unknown, explicit zero stays read", async () => {
  const results = await collectDialogResults(domPage(row("Точка", '<span class="unread"></span>') + row("Ноль", unreadBadge(0))));
  assert.equal(results[0].unreadCount, null);
  assert.equal(results[0].isUnread, true);
  assert.equal(results[1].isUnread, false);
});

test("MAX lists dialogs without a query but rejects incomplete commands before browser launch", async () => {
  const options = parseRuntimeArguments(["dialogs"]);
  assert.doesNotThrow(() => validateCommandOptions(options));
  await assert.rejects(() => runBrowserCommand(parseRuntimeArguments(["contacts"])), /contacts requires --query/u);
  await assert.rejects(() => runBrowserCommand(parseRuntimeArguments(["profile"])), /profile requires --chat/u);
  await assert.rejects(() => runBrowserCommand(parseRuntimeArguments(["login", "--headless"])), /login requires --headed/u);
});

test("MAX unread discovery fails closed for missing folders or an unrecognized empty list", async () => {
  const options = { timeoutMs: 5000, limit: 100 };
  const noFolder = { getByRole: () => ({ count: async () => 0 }) };
  await assert.rejects(() => collectHomeDialogs(noFolder, options), /All folder is missing/u);
  const noRows = { getByRole: () => ({ count: async () => 1, click: async () => {} }), waitForFunction: async () => { throw new Error("timeout"); } };
  await assert.rejects(() => collectHomeDialogs(noRows, options), /Empty account state is not verified/u);
});

test("MAX search cells are supported without admitting folder title spans", async () => {
  const page = domPage('<button><span class="title">Анна</span></button><button><div class="cell"><span class="title"><span class="name">Анна</span></span><span class="text">Превью</span></div></button>');
  assert.deepEqual((await collectDialogResults(page, "Анна")).map((r) => r.title), ["Анна"]);
});

test("MAX group URLs retain signed numeric IDs and reject other origins and credentials", () => {
  assert.equal(normalizeChatUrl("https://web.max.ru/-12345"), "https://web.max.ru/-12345");
  assert.equal(normalizeChatUrl("-12345"), "https://web.max.ru/-12345");
  assert.equal(normalizeChatUrl("https://max.ru/u/anna"), "https://web.max.ru/u/anna");
  for (const url of ["https://evil.test/-12345", "https://user:password@web.max.ru/123", "https://web.max.ru/123?other=1", "https://web.max.ru/123#other"]) {
    assert.throws(() => normalizeChatUrl(url), /official numeric/u);
  }
});

test("MAX accepts only the official Goskey bot deep link", () => {
  for (const origin of ["https://max.ru", "https://web.max.ru"]) {
    assert.equal(normalizeChatUrl(origin + "/goskey_bot/"), "https://web.max.ru/goskey_bot");
  }
  for (const url of [
    "https://evil.test/goskey_bot", "http://max.ru/goskey_bot",
    "https://web.max.ru/goskey_bot?start=other", "https://web.max.ru/goskey_bot#other",
    "https://user:password@web.max.ru/goskey_bot", "https://web.max.ru/goskey_bot_fake",
    "https://web.max.ru/some_other_bot", "https://web.max.ru/goskey_bot/extra",
  ]) assert.throws(() => normalizeChatUrl(url), /official numeric/u);
});

test("Goskey opening requires the exact route and a loaded chat without starting the bot", async () => {
  let actual = "https://web.max.ru/goskey_bot";
  const page = {
    goto: async (url) => assert.equal(url, "https://web.max.ru/goskey_bot"),
    waitForFunction: async () => {},
    evaluate: async () => ({ loginReady: false, authenticatedReady: true }),
    url: () => actual,
  };
  const options = { chat: "https://max.ru/goskey_bot", timeoutMs: 5000 };
  assert.equal((await openChat(page, options)).url, actual);
  // A numeric redirect or similarly named bot is not silently accepted as proof.
  actual = "https://web.max.ru/123";
  await assert.rejects(() => openChat(page, options), /exact requested chat URL/u);
  actual = "https://web.max.ru/goskey_bot";
  page.waitForFunction = async () => { throw new Error("No bot chat surface"); };
  page.reload = async () => {};
  await assert.rejects(() => openChat(page, options), /no visible interactive UI/u);
});

test("MAX history excludes provider controls and recognizes current outgoing metadata", async () => {
  const message = (text) => `<div class="messageWrapper"><div class="message"><div class="message">${text}</div></div></div>`;
  const page = domPage('<div class="messageWrapper messageWrapper--control">Сохраните что-нибудь</div>'
    + '<button aria-label="2 новое сообщение">Preview</button>'
    + message("Повтор")
    + message("Повтор")
    + `<div class="messageWrapper messageWrapper--isOut"><div data-bubbles-variant="outgoing">Текст <span class="meta"><span class="text">04:43</span></span></div></div>`
    + message("а".repeat(8500)));
  const messages = await visibleMessages(page, 20);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].text, "Повтор");
  assert.equal(messages[1].text, "Повтор");
  assert.equal(messages[2].timestamp, "04:43");
  assert.equal(messages[2].isOutgoing, true);
  assert.equal(messages[3].text.length, 8500);
});

test("MAX history reads quote variants and the filename beside a file-type icon", async () => {
  const page = domPage(
    '<div class="messageWrapper">'
    + '<div class="quotedMessage">Цитата</div><div>Ответ</div>'
    + '</div>'
    + '<div class="messageWrapper">'
    + '<div class="fileType">TXT</div> <span>sample-report.txt</span> <span>Скачать</span>'
    + '</div>',
  );
  const messages = await visibleMessages(page, 20);
  assert.equal(messages[0].replyText, "Цитата");
  assert.equal(messages[1].attachments[0].name, "sample-report.txt");
});

test("MAX reads an outgoing reply's distinct sender block without a quote class", async () => {
  const page = domPage(
    '<div class="messageWrapper messageWrapper--isOut">'
    + '<div><span class="name">Владислав</span> <span>Исходный текст</span></div>'
    + '<div>Новый ответ</div></div>',
  );
  const messages = await visibleMessages(page, 20);
  assert.equal(messages[0].replyText, "Владислав Исходный текст");
});

test("MAX selects a document without provider ID or author by the complete read text", async () => {
  // Synthetic current file-card layout: the visible text includes the file
  // type, controls, size and time, while a direct chat omits sender and ID.
  // Exercise read -> target resolution together, not a fabricated read result.
  const html = '<div class="messageWrapper"><div class="fileType">DOCX</div> '
    + '<span>отчет о проверке помещения.docx</span> '
    + '<button>Скачать</button> • 1.82 MB <span class="meta">09:14</span></div>';
  const page = domPage(html);
  page.locator = (selector) => ({
    count: async () => page.document.querySelectorAll(selector).length,
    selector,
  });
  const [message] = await visibleMessages(page, 20);
  assert.equal(message.providerMessageId, null);
  assert.equal(message.author, null);
  const target = await findMessageTarget(page, { targetText: message.text });
  assert.equal(target.message.messageKey, message.messageKey);
  assert.equal(target.locator.selector, '[data-trelio-max-message="0"]');

  // The runtime must explain how to recover the historical failure without
  // accepting a local hash/index as an ID or dropping an inferred author.
  for (const options of [
    { messageId: message.messageKey },
    { messageId: String(message.index) },
    { targetText: "отчет о проверке помещения.docx" },
    { targetText: message.text, targetAuthor: "Название личного чата" },
  ]) {
    await assert.rejects(() => findMessageTarget(page, options), (error) => {
      assert.match(error.message, /No exact MAX messages/u);
      assert.match(error.message, /messageKey and index are not provider IDs/u);
      assert.match(error.message, /complete returned message\.text/u);
      assert.match(error.message, /only when that message has a non-null author/u);
      assert.doesNotMatch(error.message, /отчет о проверке|Название личного/u);
      return true;
    });
  }

  const duplicatePage = domPage(html + html);
  duplicatePage.locator = () => { throw new Error("Ambiguous target must not create an action locator"); };
  await assert.rejects(
    () => findMessageTarget(duplicatePage, { targetText: message.text }),
    /Several exact MAX messages/u,
  );
  await assert.rejects(
    () => findMessageTarget(page, { targetText: message.text }, { outgoingOnly: true }),
    /No exact MAX messages/u,
  );
});

test("MAX download instructions distinguish provider identity from snapshot metadata", () => {
  const instructions = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  assert.match(instructions, /providerMessageId=null/u);
  assert.match(instructions, /messageKey.*локальный хеш/u);
  assert.match(instructions, /весь.*message\.text/u);
  assert.match(instructions, /при `author=null`\s+опусти/u);
});

test("MAX member removal accepts member-scoped wording but not chat deletion", () => {
  for (const label of ["Удалить участника", "Исключить из чата", "Убрать из группы", "Remove member"]) {
    assert.match(label, MEMBER_REMOVE_ACTION);
  }
  assert.doesNotMatch("Удалить чат", MEMBER_REMOVE_ACTION);
});

test("MAX opens a group-scoped More action on the exact member row", async () => {
  const page = domPage('<button data-trelio-max-member="1">Тестовый участник</button>'
    + '<button id="sidebar-more" aria-label="Ещё">Ещё</button>'
    + '<button id="row-more" aria-label="Ещё" style="display:none">Ещё</button>'
    + '<button id="other-more" aria-label="Ещё" style="display:none">Ещё</button>');
  const boxes = {
    '[data-trelio-max-member="1"]': { x: 563, y: 718, width: 624, height: 56 },
    '#sidebar-more': { x: 426, y: 371, width: 24, height: 24 },
    '#row-more': { x: 1140, y: 732, width: 24, height: 24 },
    '#other-more': { x: 1100, y: 732, width: 24, height: 24 },
  };
  for (const [selector, box] of Object.entries(boxes)) {
    page.document.querySelector(selector).getBoundingClientRect = () => box;
  }
  let clicked = null;
  page.locator = (selector) => selector.includes('data-trelio-max-member="1"')
    ? { hover: async () => { page.document.querySelector("#row-more").style.display = "block"; } }
    : { click: async () => {
      clicked = page.document.querySelector('[data-trelio-max-member-row-more="true"]')?.id;
    } };
  page.waitForTimeout = async () => {};
  await openSelectedMemberRowMore(page, 1, 1_000);
  assert.equal(clicked, "row-more");
  page.document.querySelector("#other-more").style.display = "block";
  await assert.rejects(() => openSelectedMemberRowMore(page, 1, 1_000),
    (error) => error.code === "MAX_UI_UNSUPPORTED"
      && error.details.finalMutationActionStarted === false
      && error.details.rowSurface.count === 2);
  assert.equal(clicked, "row-more");
});

test("MAX accepts plain Delete only inside one selected member-row menu", async () => {
  const clicked = [];
  const menuFor = (labels) => ({
    getByRole: (role, { name }) => ({
      count: async () => role === "menuitem" ? labels.filter((label) => name.test(label)).length : 0,
      nth: (index) => ({ isVisible: async () => true,
        click: async () => { clicked.push(labels.filter((label) => name.test(label))[index]); } }),
    }),
    getByText: (name) => ({ count: async () => labels.filter((label) => name.test(label)).length,
      nth: (index) => ({ isVisible: async () => true,
        click: async () => { clicked.push(labels.filter((label) => name.test(label))[index]); } }),
    }),
  });
  let labels = ["Сделать администратором", "Удалить"];
  const page = { locator: () => ({ count: async () => 1, first: () => menuFor(labels) }),
    evaluate: async () => ({ visibleMenus: 1, menuActions: ["удалить"] }) };
  await clickRowMemberRemovalAction(page, 1_000);
  assert.deepEqual(clicked, ["Удалить"]);
  labels = ["Удалить чат"];
  await assert.rejects(() => clickRowMemberRemovalAction(page, 1_000),
    (error) => error.code === "MAX_UI_UNSUPPORTED"
      && error.details.finalMutationActionStarted === false);
  assert.deepEqual(clicked, ["Удалить"]);
  labels = ["Удалить", "Удалить"];
  await assert.rejects(() => clickRowMemberRemovalAction(page, 1_000),
    (error) => error.code === "MAX_UI_UNSUPPORTED"
      && error.details.finalMutationActionStarted === false);
});

test("MAX member menu diagnostics reveal actions without leaking a participant name", async () => {
  const page = domPage('<div role="menu"><div><span>Удалить из группы НеизвестноеИмя</span></div>'
    + '<div><span>Заблокировать</span></div></div>');
  const surface = await inspectMemberRemovalSurface(page);
  assert.equal(surface.visibleMenus, 1);
  assert.deepEqual(surface.menuActions, ["удалить из группы [другое]", "заблокировать"]);
  assert.doesNotMatch(JSON.stringify(surface), /НеизвестноеИмя/u);
});

test("MAX verifies the exact /0 surface before classifying Favorites history", async () => {
  const shell = '<div data-index="0"><button class="cell cell--selected"><h3>Избранное</h3></button></div>'
    + '<main><button aria-label="Открыть профиль Избранное">Избранное Сообщения для себя</button>'
    + '<div contenteditable="true"></div>';
  const nonEmpty = domPage(`${shell}<div class="messageWrapper messageWrapper--control">Сохраните что-нибудь</div><div class="messageWrapper">Заметка</div></main>`, "/0");
  const nonEmptyState = await inspectFavoritesSurface(nonEmpty);
  assert.equal(nonEmptyState.identityReady, true);
  assert.equal(nonEmptyState.regularMessageCount, 1);
  assert.equal((await waitForFavoritesHistory(nonEmpty, 0)).emptyState, null);

  const empty = domPage(`${shell}<div class="messageWrapper messageWrapper--control">Сохраните что-нибудь</div></main>`, "/0");
  assert.equal((await waitForFavoritesHistory(empty, 0)).emptyState, "favorites-empty");

  // Keep the surface verifier consistent with the home-list collector: it
  // accepts data-index on the interactive row itself, while selected-state may
  // be carried by the inner cell. A longer control copy must not make a
  // genuinely empty /0 unverifiable either.
  const alternateLayout = domPage(
    '<button data-index="0"><div class="cell cell--selected"><h3>Избранное</h3></div></button>'
    + '<main><button aria-label="Открыть профиль: Избранное"></button>'
    + '<div role="textbox" contenteditable="true"></div>'
    + '<div class="messageWrapper messageWrapper--control">Сохраните что-нибудь, чтобы вернуться к этому позже</div></main>',
    "/0",
  );
  const alternateState = await inspectFavoritesSurface(alternateLayout);
  assert.equal(alternateState.identityReady, true);
  assert.equal(alternateState.selectedRowVisible, true);
  assert.equal(alternateState.headerVisible, true);
  assert.equal((await waitForFavoritesHistory(alternateLayout, 0)).emptyState, "favorites-empty");

  const wrongChat = domPage(`${shell}<div class="messageWrapper">Заметка</div></main>`, "/123");
  await assert.rejects(
    () => waitForFavoritesHistory(wrongChat, 0),
    (error) => {
      assert.match(error.message, /did not reach a verifiable/u);
      assert.match(error.message, /"path":"\/123"/u);
      assert.match(error.message, /"identityReady":false/u);
      assert.doesNotMatch(error.message, /Заметка/u);
      return true;
    },
  );
});

test("MAX passive guard recognizes every supported binary frame representation", () => {
  const bytes = new TextEncoder().encode("READ_MESSAGE");
  assert.equal(shouldBlockPassiveReadFrame(bytes), true);
  assert.equal(shouldBlockPassiveReadFrame(bytes.buffer), true);
  assert.equal(shouldBlockPassiveReadFrame(new DataView(bytes.buffer)), true);
  assert.equal(shouldBlockPassiveReadFrame(new TextEncoder().encode("LOAD_MESSAGES")), false);
});

test("MAX walks a virtual list, deduplicates overlapping windows and reports truncation", async () => {
  const makeList = () => {
    const page = domPage('<div id="list" style="overflow-y:auto"></div>');
    const list = page.document.querySelector('#list');
    let top = 0;
    const render = () => {
      const index = Math.min(2, Math.floor(top / 100));
      list.innerHTML = `<div data-index="${index}">${row(`Чат ${index}`, unreadBadge(index + 1))}</div>`;
    };
    Object.defineProperties(list, {
      clientHeight: { value: 100 }, scrollHeight: { value: 300 },
      scrollTop: { get: () => top, set: (v) => { top = v; render(); } },
    });
    render();
    return Object.assign(page, {
      getByRole: () => ({ count: async () => 1, click: async () => {} }),
      waitForFunction: async () => {}, waitForTimeout: async () => {},
    });
  };
  const full = await collectHomeDialogs(makeList(), { timeoutMs: 5000, limit: 100 });
  assert.deepEqual(full.dialogs.map((r) => r.title), ["Чат 0", "Чат 1", "Чат 2"]);
  assert.equal(full.coverage.complete, true);
  const bounded = await collectHomeDialogs(makeList(), { timeoutMs: 5000, limit: 1 });
  assert.equal(bounded.dialogs.length, 1);
  assert.equal(bounded.coverage.complete, false);
});

test("MAX deep links reload one blank shell and reject an unverified target", async () => {
  let checks = 0, reloads = 0;
  const options = { chat: 'https://web.max.ru/-123', timeoutMs: 5000 };
  const page = {
    goto: async () => {}, reload: async () => { reloads += 1; },
    waitForFunction: async () => { if (++checks === 1) throw new Error('blank'); },
    evaluate: async () => ({ loginReady: false, authenticatedReady: true }), url: () => options.chat,
  };
  assert.equal((await openChat(page, options)).url, options.chat);
  assert.equal(reloads, 1);
  page.waitForFunction = async () => {};
  page.url = () => 'https://web.max.ru/-456';
  await assert.rejects(() => openChat(page, options), /exact requested chat URL/u);
  page.waitForFunction = async () => { throw new Error('blank'); };
  await assert.rejects(() => openChat(page, options), /no visible interactive UI/u);
});

const attachmentTransferFixture = ({ bytes = Buffer.from('synthetic attachment'), status = 200,
  headers = { 'content-disposition': 'attachment; filename="example.docx"' }, fetchError = null } = {}) => {
  let routeHandler;
  let nativeHandler;
  const events = [];
  const context = {
    addInitScript: async () => {},
    route: async (pattern, handler) => { assert.equal(pattern.test('https://fd.oneme.ru/synthetic'), true); routeHandler = handler; },
    unroute: async (_pattern, handler) => { assert.equal(handler, routeHandler); events.push('unroute'); },
  };
  const page = {
    context: () => context,
    evaluate: async () => {},
    mainFrame: () => frame,
    on: (event, handler) => { assert.equal(event, 'download'); nativeHandler = handler; },
    off: (_event, handler) => { assert.equal(handler, nativeHandler); },
  };
  const frame = { page: () => page };
  const route = {
    request: () => ({ isNavigationRequest: () => true, method: () => 'GET', frame: () => frame }),
    fetch: async (options) => {
      assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 1000 });
      events.push('fetch');
      if (fetchError) throw fetchError;
      return { status: () => status, headers: () => headers, body: async () => bytes,
        dispose: async () => { events.push('dispose'); } };
    },
    fulfill: async (options) => { assert.deepEqual(options, { status: 204, body: '' }); events.push('204'); },
    abort: async () => { events.push('abort'); },
    continue: async () => { events.push('continue'); },
  };
  return { page, route, events, trigger: () => routeHandler(route), native: (download) => nativeHandler(download) };
};

test('MAX captures the gateway attachment before Chrome can create a crashing native download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-browser-transfer-'));
  const fixture = attachmentTransferFixture();
  const saved = [];
  const pending = [];
  const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000,
    onSaved: (value) => saved.push(value), onPending: (value) => pending.push(value) });
  try {
    // This is the response from the exact clicked file, not an arbitrary URL
    // supplied by the model. A 204 consumes it without download.saveAs or a
    // second GET. The bytes are published before the browser route completes.
    await fixture.trigger();
    const result = await transfer.completion;
    assert.equal(result.transferMethod, 'browser-context-attachment');
    assert.equal(result.sizeBytes, 20);
    assert.equal(fs.readFileSync(result.path, 'utf8'), 'synthetic attachment');
    assert.equal(saved.length, 1);
    assert.equal(pending.length, 1);
    assert.deepEqual(fixture.events, ['fetch', '204', 'abort', 'dispose']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ['example.docx']);
    await fixture.trigger();
    assert.equal(saved.length, 1, 'another navigation must not become another saved attachment');
  } finally { await transfer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MAX gateway rejects redirects, non-attachments, incomplete bodies and URL-bearing errors', async () => {
  for (const scenario of [
    { status: 302, expected: 'MAX_DOWNLOAD_HTTP_FAILED' },
    { headers: { 'content-disposition': 'inline; filename="example.docx"' }, expected: 'MAX_DOWNLOAD_SOURCE_REJECTED' },
    { headers: { 'content-disposition': 'attachment; filename="example.docx"', 'content-length': '100' }, expected: 'MAX_DOWNLOAD_SIZE_REJECTED' },
    { bytes: Buffer.alloc(0), expected: 'MAX_DOWNLOAD_SIZE_REJECTED' },
    { fetchError: new Error('https://fd.oneme.ru/private?token=not-for-logs'), expected: 'MAX_DOWNLOAD_TRANSFER_FAILED' },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-rejected-transfer-'));
    const fixture = attachmentTransferFixture(scenario);
    const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000 });
    try {
      await fixture.trigger();
      await assert.rejects(transfer.completion, (error) => {
        assert.equal(error.code, scenario.expected);
        assert.doesNotMatch(JSON.stringify(error), /private|token|not-for-logs/u);
        assert.doesNotMatch(error.message, /fd\.oneme|private|token/u);
        return true;
      });
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(fixture.events.includes('204'), false);
    } finally { await transfer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('MAX gateway ignores subresources and rejects an unrelated popup or POST before fetching', async () => {
  for (const scenario of ['subresource', 'unrelated-popup', 'post']) {
    const fixture = attachmentTransferFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-scoped-transfer-'));
    const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000 });
    const foreignFrame = { page: () => ({ mainFrame: () => foreignFrame, opener: async () => null }) };
    fixture.route.request = () => ({ isNavigationRequest: () => scenario !== 'subresource',
      method: () => scenario === 'post' ? 'POST' : 'GET',
      frame: () => scenario === 'unrelated-popup' ? foreignFrame : fixture.page.mainFrame() });
    try {
      await fixture.trigger();
      assert.deepEqual(fixture.events, [scenario === 'subresource' ? 'continue' : 'abort']);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally { await transfer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('MAX atomically keeps an existing or concurrently created output and cleans failed transfers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-exclusive-transfer-'));
  const output = path.join(root, 'result.docx');
  try {
    await assert.rejects(saveAttachmentAtomically(output, 'file.docx', async (temporary) => {
      fs.writeFileSync(temporary, 'new bytes');
      fs.writeFileSync(output, 'keep me');
    }), (error) => error.code === 'MAX_DOWNLOAD_OUTPUT_EXISTS');
    assert.equal(fs.readFileSync(output, 'utf8'), 'keep me');
    assert.deepEqual(fs.readdirSync(root), ['result.docx']);
    await assert.rejects(saveAttachmentAtomically(output, 'file.docx', () => {
      throw new Error('must not begin another transfer');
    }), (error) => error.code === 'MAX_DOWNLOAD_OUTPUT_EXISTS');
    fs.unlinkSync(output);
    await assert.rejects(saveAttachmentAtomically(output, 'file.docx', (temporary) => {
      fs.writeFileSync(temporary, 'partial');
      throw new Error('failed transfer');
    }), (error) => error.code === 'MAX_DOWNLOAD_SAVE_FAILED');
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(attachmentResponseFilename("attachment; filename*=UTF-8''%D1%84%D0%B0%D0%B9%D0%BB.docx"), 'файл.docx');
    assert.equal(attachmentResponseFilename('attachment; filename="../../example.docx"'), 'example.docx');
    assert.throws(() => attachmentResponseFilename('attachment; filename=".."'), /safe file name/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MAX transfer stop waits for the exact pending response before releasing browser handlers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-pending-transfer-'));
  const fixture = attachmentTransferFixture();
  const originalFetch = fixture.route.fetch;
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  fixture.route.fetch = async (options) => { await blocked; return originalFetch(options); };
  const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000 });
  const triggered = fixture.trigger();
  let stopped = false;
  const stopping = transfer.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  unblock();
  await triggered;
  await stopping;
  assert.equal((await transfer.completion).sizeBytes, 20);
  assert.equal(fixture.events.at(-1), 'unroute');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MAX routes only its exact HTTPS file gateway into the existing page', () => {
  const calls = [];
  const receiver = {};
  const browser = { location: { href: 'https://web.max.ru/123' },
    open: function (...arguments_) { calls.push({ sameReceiver: this === receiver, arguments_ }); return 'window'; } };
  vm.runInNewContext(`(${installMaxDownloadNavigation.toString()})()`, { window: browser, URL });
  browser.open.call(receiver, 'https://fd.oneme.ru/attachment?opaque=private', '_blank', 'noopener');
  browser.open.call(receiver, 'https://fd.oneme.ru.attacker.test/file', '_blank');
  browser.open.call(receiver, 'http://fd.oneme.ru/file', '_blank');
  browser.open.call(receiver, 'https://unrelated.example/file', '_blank');
  assert.deepEqual(calls.map((call) => call.arguments_[1]), ['_self', '_blank', '_blank', '_blank']);
  assert.equal(calls.every((call) => call.sameReceiver), true);
  assert.equal(calls[0].arguments_[2], 'noopener');
});

test('MAX rejects a gateway request without a created Frame without leaking a routing exception', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-frameless-transfer-'));
  const fixture = attachmentTransferFixture();
  fixture.route.request = () => ({ isNavigationRequest: () => true,
    frame: () => { throw new Error('Frame not created for https://fd.oneme.ru/private?token=secret'); } });
  const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000 });
  try {
    await fixture.trigger();
    await assert.rejects(transfer.completion, (error) => error.code === 'MAX_DOWNLOAD_SOURCE_REJECTED'
      && !/token|secret|private|fd\.oneme/u.test(error.message));
    assert.deepEqual(fixture.events, ['abort']);
  } finally { await transfer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('MAX legacy same-origin and blob attachments still save through the bound native transfer', async () => {
  for (const url of ['https://web.max.ru/file', 'blob:https://web.max.ru/synthetic']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-legacy-transfer-'));
    const fixture = attachmentTransferFixture();
    const transfer = await installAttachmentTransfer(fixture.page, { output: root, timeoutMs: 1000 });
    try {
      await fixture.native({ url: () => url, suggestedFilename: () => 'legacy.txt',
        saveAs: async (temporary) => fs.writeFileSync(temporary, 'legacy') });
      const saved = await transfer.completion;
      assert.equal(saved.transferMethod, 'browser-native-attachment');
      assert.equal(fs.readFileSync(saved.path, 'utf8'), 'legacy');
    } finally { await transfer.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
