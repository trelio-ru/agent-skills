#!/usr/bin/env node

/**
 * Local Telegram Web runtime for the Trelio skill catalog.
 *
 * Browser cookies stay in a persistent profile outside every workspace. The
 * executable intentionally exposes only chat operations; incoming content
 * cannot invoke Trelio or another integration through this runtime.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_ID = "telegram-web";
const TELEGRAM_WEB_URL = "https://web.telegram.org/k/";
const TELEGRAM_WEB_ORIGIN = new URL(TELEGRAM_WEB_URL).origin;
let browserSessionRuntimePromise = null;
const browserSessionRuntime = () => {
  const moduleUrl = String(process.env.TRELIO_BROWSER_SESSION_MODULE_URL || "");
  if (!moduleUrl.startsWith("file:")) {
    throw new Error("Telegram Web requires the host browser-session runtime.");
  }
  browserSessionRuntimePromise ||= import(moduleUrl);
  return browserSessionRuntimePromise;
};
// HTTP status is checked before DOM/login classification. The shared host
// observes only the current main document; provider authority stays here.
const documentObservers = new WeakMap();
const installDocumentHttpObserver = (context, runtime) => {
  documentObservers.set(context, runtime.createDocumentHttpObserver(context, {
    isAllowedUrl: value => new URL(value).origin === TELEGRAM_WEB_ORIGIN,
  }));
};
const assertDocumentAvailable = (page) => {
  const failure = typeof page.context === "function" && documentObservers.get(page.context())?.failure(page);
  if (failure) throw new TelegramWebRuntimeError("TELEGRAM_SERVICE_HTTP_ERROR", "TELEGRAM returned an HTTP error.", failure);
};
const POLICY_MODES = new Set(["confirm", "read-only"]);
const ADAPTER_VERSION = "7";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const TELEGRAM_ASSIST_START_TIMEOUT_MS = 15_000;
const TELEGRAM_ASSIST_HOLD_MS = 1_800_000;
const TELEGRAM_UI_READY_TIMEOUT_MS = 10_000;
const TELEGRAM_HISTORY_PAGES = 20;
const TELEGRAM_GLOBAL_SEARCH_PAGES = 100;
const TELEGRAM_SEARCH_QUERY_MAX_CHARS = 256;
// Context expansion opens one result chat at a time and returns full messages,
// not compact search snippets. A ten-hit/ten-message radius caps one invocation
// at 210 contextual messages while leaving snippet-only search at its existing
// one-hundred-result ceiling.
const TELEGRAM_SEARCH_CONTEXT_RADIUS = 10;
const TELEGRAM_SEARCH_CONTEXT_RESULT_LIMIT = 10;
const TELEGRAM_SEARCH_CONTEXT_SCROLL_ATTEMPTS = 12;
const TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET = 5_000;
const TELEGRAM_GLOBAL_SEARCH_CURSOR_MAX_CHARS = 1_024;
const TELEGRAM_FILES_PER_MESSAGE = 10;
const TELEGRAM_GROUP_MEMBERS_PER_OPERATION = 100;
const TELEGRAM_WATCH_ITERATIONS = 60;
const TELEGRAM_WATCH_INTERVAL_MS = 300_000;
const STRUCTURAL_CONFIRMATION_COMMANDS = new Set([
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "edit",
  "forward",
  "member-add",
  "member-remove",
]);
const MUTATING_COMMANDS = new Set([
  ...STRUCTURAL_CONFIRMATION_COMMANDS,
  "react",
  "reply",
  "send",
]);
const ASSIST_READ_ONLY_COMMANDS = new Set(["contacts", "dialogs", "probe", "read", "search", "unread", "watch"]);
const ASSIST_MANUAL_CONTROL_COMMANDS = new Set([
  "chat-update", "create-direct", "create-group", "delete", "download", "edit", "forward",
  "member-add", "member-remove", "members", "react", "reply", "send",
]);
const ASSIST_COMMANDS = new Set([...ASSIST_READ_ONLY_COMMANDS, ...ASSIST_MANUAL_CONTROL_COMMANDS]);
const SUPPORTED_COMMANDS = new Set([
  "assist-click",
  "assist-contextmenu",
  "assist-fill",
  "assist-key",
  "assist-point-click",
  "assist-point-contextmenu",
  "assist-point-scroll",
  "assist-snapshot",
  "assist-scroll",
  "assist-start",
  "assist-status",
  "assist-stop",
  "bootstrap",
  "chat-update",
  "contacts",
  "create-direct",
  "create-group",
  "delete",
  "dialogs",
  "doctor",
  "download",
  "edit",
  "forward",
  "help",
  "login",
  "member-add",
  "member-remove",
  "members",
  "policy",
  "probe",
  "react",
  "read",
  "reply",
  "search",
  "send",
  "unread",
  "watch",
]);

const output = (payload) => process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

const configHome = () => {
  if (process.env.TRELIO_CONFIG_HOME) return path.resolve(process.env.TRELIO_CONFIG_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "Trelio");
  }
  return path.join(os.homedir(), ".config", "trelio");
};

const cacheHome = () => {
  if (process.env.TRELIO_CACHE_HOME) return path.resolve(process.env.TRELIO_CACHE_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), "Trelio", "cache");
  }
  return path.join(os.homedir(), ".cache", "trelio");
};

const normalizeIdentityPart = (value, label) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(normalized)) {
    throw new Error(`${label} must contain only lowercase letters, digits and hyphens.`);
  }
  return normalized;
};

const ensurePrivateDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
};

const ensurePrivateFile = (file) => {
  if (!fs.existsSync(file) || process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Unsafe permissions on ${file}: expected 600, got ${mode.toString(8)}.`);
  }
};

const writePrivateJson = (file, value) => {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
};

class TelegramWebRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TelegramWebRuntimeError";
    this.code = code;
    this.details = details;
  }
}

const requireRuntimeIdentity = (environment = process.env) => {
  // The signed host supplies company/member/connection identity. Legacy CLI
  // flags may repeat it but can never choose another profile namespace.
  const identity = {
    skillId: String(environmentValue(environment, "TRELIO_SKILL_ID") || ""),
    runtimeVersion: String(environmentValue(environment, "TRELIO_SKILL_RUNTIME_VERSION") || ""),
    companyId: String(environmentValue(environment, "TRELIO_SKILL_COMPANY_ID") || "").toLowerCase(),
    memberId: String(environmentValue(environment, "TRELIO_SKILL_MEMBER_ID") || "").toLowerCase(),
    connectionId: String(environmentValue(environment, "TRELIO_SKILL_CONNECTION_ID") || "").toLowerCase(),
  };
  if (identity.skillId !== SKILL_ID || !VERSION_PATTERN.test(identity.runtimeVersion)
    || ![identity.companyId, identity.memberId, identity.connectionId].every((part) => UUID_PATTERN.test(part))) {
    throw new TelegramWebRuntimeError("TELEGRAM_INVALID_IDENTITY", "Trusted Telegram Web runtime identity is missing or invalid.");
  }
  return identity;
};

const environmentValue = (environment, name) => {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  if (process.platform !== "win32") return undefined;
  const matched = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
  return matched ? environment[matched] : undefined;
};

const runtimeErrorPayload = (error) => {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
  if (error instanceof TelegramWebRuntimeError) {
    payload.code = error.code;
    if (error.details !== undefined) payload.details = error.details;
  }
  return payload;
};

const parseArguments = (argv, environment = process.env) => {
  const identity = requireRuntimeIdentity(environment);
  const options = {
    command: "",
    policyCommand: "",
    companyId: identity.companyId,
    memberId: identity.memberId,
    connectionId: identity.connectionId,
    sendMode: "",
    // Browser discovery is shared by the host runtime. This field is set only
    // when the caller explicitly chooses an exact executable with --chrome.
    chromeExecutable: "",
    // `null` distinguishes an omitted browser-mode flag from an explicit
    // `--headless`. Login may safely upgrade the omitted mode to its mandatory
    // visible owner handoff, while an explicit contradictory flag must fail
    // before a browser process or profile lock is opened.
    headed: null,
    holdMs: 600_000,
    holdMsExplicit: false,
    timeoutMs: 60_000,
    query: "",
    globalSearch: false,
    cursor: "",
    searchOffset: 0,
    chat: "",
    contact: "",
    title: "",
    members: [],
    message: "",
    messageFile: "",
    files: [],
    avatar: "",
    output: "",
    messageId: "",
    targetText: "",
    targetAuthor: "",
    reaction: "",
    toChat: "",
    attachmentIndex: 1,
    limit: 20,
    pages: 1,
    context: 0,
    iterations: 1,
    intervalMs: 15_000,
    confirm: false,
    dryRun: false,
    approvalHash: "",
    fallbackFor: "",
    assistSession: "",
    assistSnapshot: "",
    assistRef: "",
    assistText: "",
    assistKey: "",
    assistDeltaY: 0,
    assistX: -1,
    assistY: -1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (!options.command && !argument.startsWith("--")) options.command = argument;
    else if (options.command === "policy" && !options.policyCommand && !argument.startsWith("--")) {
      options.policyCommand = argument;
    } else if (argument === "--company-id") {
      if (value().toLowerCase() !== identity.companyId) throw new Error("--company-id cannot override the signed runtime identity.");
    } else if (argument === "--member-id") {
      if (value().toLowerCase() !== identity.memberId) throw new Error("--member-id cannot override the signed runtime identity.");
    } else if (argument === "--connection-id") {
      if (value().toLowerCase() !== identity.connectionId) throw new Error("--connection-id cannot override the signed runtime identity.");
    }
    else if (argument === "--send-mode") options.sendMode = value();
    else if (argument === "--chrome") options.chromeExecutable = path.resolve(value());
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--headless") options.headed = false;
    else if (argument === "--hold-ms") {
      options.holdMs = Number(value());
      options.holdMsExplicit = true;
    }
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value());
    else if (argument === "--query") options.query = value();
    else if (argument === "--global") options.globalSearch = true;
    else if (argument === "--cursor") options.cursor = value();
    else if (argument === "--chat") options.chat = value();
    else if (argument === "--contact") options.contact = value();
    else if (argument === "--title") options.title = value();
    else if (argument === "--member") options.members.push(value());
    else if (argument === "--message") options.message = value();
    else if (argument === "--message-file") options.messageFile = path.resolve(value());
    else if (argument === "--file") options.files.push(path.resolve(value()));
    else if (argument === "--avatar") options.avatar = path.resolve(value());
    else if (argument === "--output") options.output = path.resolve(value());
    else if (argument === "--message-id") options.messageId = value();
    else if (argument === "--target-text") options.targetText = value();
    else if (argument === "--target-author") options.targetAuthor = value();
    else if (argument === "--reaction") options.reaction = value();
    else if (argument === "--to-chat") options.toChat = value();
    else if (argument === "--attachment-index") options.attachmentIndex = Number(value());
    else if (argument === "--limit") options.limit = Number(value());
    else if (argument === "--pages") options.pages = Number(value());
    else if (argument === "--context") options.context = Number(value());
    else if (argument === "--iterations") options.iterations = Number(value());
    else if (argument === "--interval-ms") options.intervalMs = Number(value());
    else if (argument === "--confirm") options.confirm = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--approval-hash") options.approvalHash = value();
    else if (argument === "--fallback-for") options.fallbackFor = value();
    else if (argument === "--session") options.assistSession = value();
    else if (argument === "--snapshot") options.assistSnapshot = value();
    else if (argument === "--ref") options.assistRef = value();
    else if (argument === "--text") options.assistText = value();
    else if (argument === "--key") options.assistKey = value();
    else if (argument === "--delta-y") options.assistDeltaY = Number(value());
    else if (argument === "--x") options.assistX = Number(value());
    else if (argument === "--y") options.assistY = Number(value());
    else if (argument === "--help" || argument === "-h") options.command = "help";
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.companyId || !options.memberId || !options.connectionId) {
    throw new Error("--company-id, --member-id and --connection-id are required.");
  }
  options.companyId = normalizeIdentityPart(options.companyId, "company-id");
  options.memberId = normalizeIdentityPart(options.memberId, "member-id");
  options.connectionId = normalizeIdentityPart(options.connectionId, "connection-id");
  if (!SUPPORTED_COMMANDS.has(options.command)) {
    throw new Error(`Unsupported Telegram Web browser command: ${options.command || "(missing)"}`);
  }
  if (options.command === "assist-start" && !ASSIST_COMMANDS.has(options.fallbackFor)) {
    throw new Error("assist-start requires --fallback-for with one supported Telegram Web command.");
  }
  if (["assist-status", "assist-stop", "assist-snapshot", "assist-click", "assist-contextmenu", "assist-fill", "assist-key", "assist-scroll", "assist-point-click", "assist-point-contextmenu", "assist-point-scroll"].includes(options.command)
    && !UUID_PATTERN.test(options.assistSession)) {
    throw new Error(`${options.command} requires an exact --session UUID.`);
  }
  if (["assist-click", "assist-contextmenu", "assist-fill", "assist-key", "assist-scroll", "assist-point-click", "assist-point-contextmenu", "assist-point-scroll"].includes(options.command)
    && !UUID_PATTERN.test(options.assistSnapshot)) {
    throw new Error(`${options.command} requires a fresh --snapshot UUID.`);
  }
  if (["assist-click", "assist-contextmenu", "assist-fill"].includes(options.command)
    && !/^r(?:[1-9]|[1-9]\d|100)$/u.test(options.assistRef)) {
    throw new Error(`${options.command} requires an exact --ref from the snapshot.`);
  }
  if (options.command === "assist-fill" && (!options.assistText || options.assistText.length > 256)) {
    throw new Error("assist-fill requires --text from 1 to 256 characters.");
  }
  if (options.command === "assist-key" && !["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"].includes(options.assistKey)) {
    throw new Error("assist-key requires one supported --key.");
  }
  if (["assist-scroll", "assist-point-scroll"].includes(options.command)
    && (!Number.isInteger(options.assistDeltaY) || options.assistDeltaY === 0 || Math.abs(options.assistDeltaY) > 1500)) {
    throw new Error(`${options.command} requires --delta-y from -1500 to 1500, excluding zero.`);
  }
  if (["assist-point-click", "assist-point-contextmenu", "assist-point-scroll"].includes(options.command)
    && ![options.assistX, options.assistY].every((coordinate) => Number.isInteger(coordinate)
      && coordinate >= 0 && coordinate <= 8192)) {
    throw new Error(`${options.command} requires integer --x and --y screenshot coordinates.`);
  }
  if (options.command === "assist-start" && options.headed === false) {
    throw new Error("Telegram Web assisted recovery requires a visible browser window.");
  }
  if (options.command === "assist-start" && !options.holdMsExplicit) {
    options.holdMs = TELEGRAM_ASSIST_HOLD_MS;
  }
  if (options.command === "assist-start" && options.holdMs > TELEGRAM_ASSIST_HOLD_MS) {
    throw new Error("Telegram Web assisted recovery cannot exceed 30 minutes.");
  }
  const operationCommand = options.command === "assist-start" ? options.fallbackFor : options.command;
  if (options.globalSearch && operationCommand !== "search") {
    throw new Error("--global is supported only by the Telegram Web search command.");
  }
  if (operationCommand === "search" && !options.globalSearch) {
    throw new Error("Telegram Web search requires explicit --global scope.");
  }
  if (options.cursor && operationCommand !== "search") {
    throw new Error("--cursor is supported only by the Telegram Web search command.");
  }
  if (options.command === "login") {
    if (options.headed === false) {
      throw new Error("Telegram Web login cannot run with --headless; it always opens a visible headed window.");
    }
    // Keep `--headed` in the documented command for clarity, but make the
    // runtime itself uphold the invariant for older callers that invoke plain
    // `login`. This prevents an omitted flag from creating a headless process
    // that can never complete the owner authentication handoff.
    options.headed = true;
  } else {
    // Every non-login command preserves the existing headless default. An
    // explicit `--headed` remains available for controlled diagnostics.
    options.headed = options.headed === true || options.command === "assist-start";
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  const maximumPages = operationCommand === "search"
    ? TELEGRAM_GLOBAL_SEARCH_PAGES
    : TELEGRAM_HISTORY_PAGES;
  if (!Number.isInteger(options.pages) || options.pages < 1 || options.pages > maximumPages) {
    throw new Error(`--pages must be an integer from 1 to ${maximumPages}.`);
  }
  if (
    !Number.isInteger(options.context)
    || options.context < 0
    || options.context > TELEGRAM_SEARCH_CONTEXT_RADIUS
  ) {
    throw new Error(`--context must be an integer from 0 to ${TELEGRAM_SEARCH_CONTEXT_RADIUS}.`);
  }
  if (options.context && operationCommand !== "search") {
    throw new Error("--context is supported only by the Telegram Web search command.");
  }
  if (options.context && options.limit > TELEGRAM_SEARCH_CONTEXT_RESULT_LIMIT) {
    throw new Error(
      `Telegram Web search with context requires --limit 1..${TELEGRAM_SEARCH_CONTEXT_RESULT_LIMIT}.`,
    );
  }
  if (!Number.isInteger(options.attachmentIndex) || options.attachmentIndex < 1 || options.attachmentIndex > 100) {
    throw new Error("--attachment-index must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > TELEGRAM_WATCH_ITERATIONS) {
    throw new Error(`--iterations must be an integer from 1 to ${TELEGRAM_WATCH_ITERATIONS}.`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > TELEGRAM_WATCH_INTERVAL_MS) {
    throw new Error(`--interval-ms must be from 1000 to ${TELEGRAM_WATCH_INTERVAL_MS}.`);
  }
  if (options.files.length > TELEGRAM_FILES_PER_MESSAGE) {
    throw new Error(`One Telegram Web message can contain at most ${TELEGRAM_FILES_PER_MESSAGE} --file values.`);
  }
  if (options.members.length > TELEGRAM_GROUP_MEMBERS_PER_OPERATION) {
    throw new Error(`One Telegram Web operation can contain at most ${TELEGRAM_GROUP_MEMBERS_PER_OPERATION} --member values.`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 5_000) {
    throw new Error("--timeout-ms must be at least 5000.");
  }
  const maximumHoldMs = options.command === "assist-start" ? TELEGRAM_ASSIST_HOLD_MS : 600_000;
  if (!Number.isFinite(options.holdMs) || options.holdMs < 5_000 || options.holdMs > maximumHoldMs) {
    throw new Error(`--hold-ms must be from 5000 to ${maximumHoldMs}.`);
  }
  return options;
};

const usage = () => `
Usage:
  trelio-telegram-web.mjs bootstrap
  trelio-telegram-web.mjs doctor
  trelio-telegram-web.mjs probe
  trelio-telegram-web.mjs policy show
  trelio-telegram-web.mjs policy set --send-mode read-only
  trelio-telegram-web.mjs login --headed
  trelio-telegram-web.mjs assist-start --fallback-for read --chat "Название"
  trelio-telegram-web.mjs assist-status --session UUID
  trelio-telegram-web.mjs assist-snapshot --session UUID
  trelio-telegram-web.mjs assist-click --session UUID --snapshot UUID --ref r1
  trelio-telegram-web.mjs assist-contextmenu --session UUID --snapshot UUID --ref r1
  trelio-telegram-web.mjs assist-fill --session UUID --snapshot UUID --ref r1 --text "Поиск"
  trelio-telegram-web.mjs assist-key --session UUID --snapshot UUID --key Escape
  trelio-telegram-web.mjs assist-scroll --session UUID --snapshot UUID --delta-y 600
  trelio-telegram-web.mjs assist-point-click --session UUID --snapshot UUID --x 700 --y 450
  trelio-telegram-web.mjs assist-point-contextmenu --session UUID --snapshot UUID --x 700 --y 450
  trelio-telegram-web.mjs assist-point-scroll --session UUID --snapshot UUID --x 850 --y 700 --delta-y 600
  trelio-telegram-web.mjs assist-stop --session UUID
  trelio-telegram-web.mjs dialogs --query "Название"
  trelio-telegram-web.mjs contacts --query "Имя или @username"
  trelio-telegram-web.mjs search --global --query "Текст" --limit 10 --pages 2 --context 10
  trelio-telegram-web.mjs search --global --query "Текст" --limit 10 --pages 20 --cursor NEXT_CURSOR
  trelio-telegram-web.mjs read --chat "Название" --limit 20 --pages 2
  trelio-telegram-web.mjs unread --limit 10 --pages 1
  trelio-telegram-web.mjs watch --limit 10 --iterations 4 --interval-ms 15000
  trelio-telegram-web.mjs download --chat "Название" --message-id ID --attachment-index 1 --output PATH
  trelio-telegram-web.mjs send --chat "Название" --message "Текст" --file PATH --confirm
  trelio-telegram-web.mjs reply --chat "Название" --message-id ID --message "Текст" --confirm
  trelio-telegram-web.mjs react --chat "Название" --message-id ID --reaction "👍" --confirm
  trelio-telegram-web.mjs edit --chat "Название" --message-id ID --message "Новый текст" --dry-run
  trelio-telegram-web.mjs delete --chat "Название" --message-id ID --dry-run
  trelio-telegram-web.mjs forward --chat "Источник" --message-id ID --to-chat "Получатель" --dry-run
  trelio-telegram-web.mjs create-direct --contact "https://t.me/name" --message "Текст" --dry-run
  trelio-telegram-web.mjs create-group --title "Название" --member "@one" --member "@two" --dry-run
  trelio-telegram-web.mjs members --chat "Название"
  trelio-telegram-web.mjs member-add --chat "Название" --member "@name" --dry-run
  trelio-telegram-web.mjs member-remove --chat "Название" --member "@name" --dry-run
  trelio-telegram-web.mjs chat-update --chat "Название" --title "Новое название" --dry-run

Structural commands: show the unchanged --dry-run output, then repeat the exact
command with --confirm --approval-hash HASH instead of --dry-run.
`.trim();

const connectionRoot = (options) => path.join(
  configHome(),
  "integrations",
  SKILL_ID,
  options.companyId,
  options.memberId,
  options.connectionId,
);

const policyPath = (options) => path.join(connectionRoot(options), "config", "policy.json");
const profilePath = (options) => path.join(connectionRoot(options), "state", "chrome-profile");
const downloadsPath = (options) => path.join(
  cacheHome(),
  "integrations",
  SKILL_ID,
  options.companyId,
  options.memberId,
  options.connectionId,
  "downloads",
);

const assistSessionPath = (options) => path.join(
  connectionRoot(options),
  "state",
  "assist-session.json",
);

const assistAppName = (executable) => (
  /(?:^|[\\/])msedge(?:\.exe)?$/iu.test(executable)
    ? "Microsoft Edge"
    : /(?:^|[\\/])chromium(?:-browser)?(?:\.exe)?$/iu.test(executable)
      ? "Chromium"
      : "Google Chrome"
);

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const withAssistStartLock = async (options, callback) => {
  const lock = path.join(connectionRoot(options), "locks", "assist-start.lock");
  ensurePrivateDirectory(path.dirname(lock));
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pidFile = path.join(lock, "pid");
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    if (processIsAlive(pid)) {
      throw new TelegramWebRuntimeError(
        "TELEGRAM_ASSIST_START_IN_PROGRESS",
        "Another Telegram Web assisted-browser start is already in progress.",
      );
    }
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  }
  try {
    return await callback();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

const readAssistSession = (options) => {
  const file = assistSessionPath(options);
  if (!fs.existsSync(file)) return null;
  ensurePrivateFile(file);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!record || record.schemaVersion !== 1 || !UUID_PATTERN.test(record.sessionId || "")) {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_INVALID",
      "The local Telegram Web assisted-browser session record is invalid.",
    );
  }
  return record;
};

const publicAssistStatus = (record, extra = {}) => ({
  sessionId: record.sessionId,
  phase: record.phase,
  fallbackFor: record.fallbackFor,
  interactionMode: record.interactionMode,
  mutationAuthorized: Boolean(record.mutationAuthorized),
  authorizationHash: record.authorizationHash,
  expiresAt: new Date(record.expiresAt).toISOString(),
  browserSession: {
    kind: "dedicated-chromium-assisted",
    sharedWithCodexBrowser: false,
    appName: record.appName,
  },
  runtimeReadOnly: record.interactionMode === "read-only",
  readState: createReadState(),
  ...extra,
});

/**
 * Keep the model-driven recovery window useful for search and chat navigation
 * without turning native screen control into an unguarded mutation channel.
 * The browser-side copy below applies the same policy synchronously to trusted
 * native mouse/keyboard events before the Telegram Web application receives them.
 */
const assistInteractionAllowed = ({
  kind,
  tag,
  type = "",
  label = "",
  href = "",
  chatRow = false,
  box,
  viewportWidth = 1280,
  pathname = "/",
  fallbackFor = "",
}) => {
  const normalizedLabel = String(label).normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalizedTag = String(tag).toLowerCase();
  const normalizedType = String(type).toLowerCase();
  const leftPaneLimit = Math.min(650, Math.max(360, viewportWidth * 0.52));
  const inLeftPane = Boolean(box)
    && box.width >= 10
    && box.height >= 10
    && box.x >= 0
    && box.x < leftPaneLimit;
  const searchLike = normalizedTag === "input"
    && ["", "search", "text"].includes(normalizedType)
    && inLeftPane
    && box.y < 500
    && box.width >= 80
    && (
      /(?:найти|поиск|find|search)/iu.test(normalizedLabel)
      || pathname === "/k/"
    );
  if (kind === "fill") return searchLike;
  if (kind !== "click") return false;
  if (searchLike) return true;
  // A contacts recovery may need to open the left navigation entry before
  // searching. The exception is tied to that command and the narrow sidebar;
  // it does not authorize arbitrary menu actions in a read-only session.
  const contactsTab = fallbackFor === "contacts" && Boolean(box)
    && box.x >= 0 && box.x < 110 && box.y < 700 && !href
    && /^(?:контакты|contacts)$/iu.test(normalizedLabel);
  if (contactsTab) return true;
  if (!inLeftPane || !normalizedLabel) return false;
  // Chat preview text may contain words such as "send". A peer row is safe
  // only when it has no external href; nested action buttons stay excluded.
  if (chatRow && !href) return true;
  if (/(?:отправ|send|ответ|reply|редакт|edit|удал|delete|пересл|forward|реакц|react|созда|create|нов(?:ый|ая)\s+чат|new\s+chat|добав|add|убрат|remove|настрой|settings|выйти|logout|покинуть|leave|заблок|block|пожаловат|report|позвон|звонок|call|видео|video|закреп|pin|архив|archive|без\s+звука|mute)/iu.test(normalizedLabel)) {
    return false;
  }
  if (href) {
    try {
      const url = new URL(href, TELEGRAM_WEB_URL);
      if (url.origin !== TELEGRAM_WEB_ORIGIN
        || url.pathname !== "/k/"
        || url.search
        || (url.hash && !/^#-?[1-9]\d*$/u.test(url.hash))) return false;
    } catch {
      return false;
    }
    return true;
  }
  return Boolean(chatRow)
    && ["a", "button", "div", "li", "span"].includes(normalizedTag);
};

const installTelegramAssistGate = (configuration = {}) => {
  if (window.__trelioTelegramAssistState) return;
  const mode = configuration.mode === "manual-control" ? "manual-control" : "read-only";
  const fallbackFor = String(configuration.fallbackFor || "");
  const state = { version: 2, mode, blockedActions: 0 };
  Object.defineProperty(window, "__trelioTelegramAssistState", {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const descriptor = (candidate) => {
    if (!(candidate instanceof Element)) return null;
    const element = candidate.closest(
      'a, button, input, textarea, .chatlist-chat[data-peer-id], [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"]',
    );
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type") || "";
    const label = normalize([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.textContent,
    ].filter(Boolean).join(" "));
    // Read the declared href for every anchor-shaped element. Some DOM
    // implementations and custom-element wrappers do not preserve the native
    // HTMLAnchorElement prototype, but an external href must still fail closed.
    const href = tag === "a"
      ? (element.getAttribute("href") || element.href || "")
      : "";
    const chatRow = element.matches('.chatlist-chat[data-peer-id]');
    return {
      element,
      tag,
      type,
      label,
      href,
      chatRow,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const allowed = (kind, candidate) => {
    const value = descriptor(candidate);
    if (!value) return false;
    if (mode === "manual-control") {
      if (kind === "fill") {
        return ["input", "textarea"].includes(value.tag)
          || value.element.getAttribute("contenteditable") === "true"
          || value.element.getAttribute("role") === "textbox";
      }
      if (kind !== "click") return false;
      if (!value.href) return true;
      try {
        return new URL(value.href, "https://web.telegram.org/k/").origin === "https://web.telegram.org";
      } catch {
        return false;
      }
    }
    const leftPaneLimit = Math.min(650, Math.max(360, window.innerWidth * 0.52));
    const inLeftPane = value.box.width >= 10
      && value.box.height >= 10
      && value.box.x >= 0
      && value.box.x < leftPaneLimit;
    const searchLike = value.tag === "input"
      && ["", "search", "text"].includes(value.type.toLowerCase())
      && inLeftPane
      && value.box.y < 500
      && value.box.width >= 80
      && (/(?:найти|поиск|find|search)/iu.test(value.label) || window.location.pathname === "/k/");
    if (kind === "fill") return searchLike;
    if (kind !== "click") return false;
    if (searchLike) return true;
    const contactsTab = fallbackFor === "contacts"
      && value.box.x >= 0 && value.box.x < 110 && value.box.y < 700
      && !value.href && /^(?:контакты|contacts)$/iu.test(value.label);
    if (contactsTab) return true;
    if (!inLeftPane || !value.label) return false;
    if (value.chatRow && !value.href) return true;
    if (/(?:отправ|send|ответ|reply|редакт|edit|удал|delete|пересл|forward|реакц|react|созда|create|нов(?:ый|ая)\s+чат|new\s+chat|добав|add|убрат|remove|настрой|settings|выйти|logout|покинуть|leave|заблок|block|пожаловат|report|позвон|звонок|call|видео|video|закреп|pin|архив|archive|без\s+звука|mute)/iu.test(value.label)) {
      return false;
    }
    if (value.href) {
      try {
        const url = new URL(value.href, "https://web.telegram.org/k/");
        if (url.origin !== "https://web.telegram.org"
          || url.pathname !== "/k/"
          || url.search
          || (url.hash && !/^#-?[1-9]\d*$/u.test(url.hash))) return false;
      } catch {
        return false;
      }
      return true;
    }
    return value.chatRow && ["a", "button", "div", "li", "span"].includes(value.tag);
  };
  const block = (event) => {
    state.blockedActions += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const harden = () => {
    if (mode === "manual-control") return;
    for (const element of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      if (allowed("fill", element)) continue;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.readOnly = true;
      } else {
        element.setAttribute("contenteditable", "false");
      }
    }
  };
  const clickEvents = [
    "auxclick",
    "click",
    "contextmenu",
    "dblclick",
    "mousedown",
    "mouseup",
    "pointerdown",
    "pointerup",
  ];
  for (const name of clickEvents) {
    window.addEventListener(name, (event) => {
      if (!allowed("click", event.target)) block(event);
    }, true);
  }
  for (const name of ["beforeinput", "change", "drop", "input", "paste"] ) {
    window.addEventListener(name, (event) => {
      if (!allowed("fill", event.target)) block(event);
    }, true);
  }
  window.addEventListener("keydown", (event) => {
    // Manual recovery must be able to use the same keyboard controls as the
    // visible Telegram Web UI, including Enter/Space on confirmation surfaces whose
    // focused element is not itself an input. Origin/navigation guards and the
    // exact-operation authorization remain active independently of keystrokes.
    if (mode === "manual-control") return;
    const navigationKey = /^(?:Arrow(?:Down|Left|Right|Up)|End|Escape|Home|PageDown|PageUp)$/u.test(event.key);
    if (!navigationKey && !allowed("fill", event.target)) block(event);
  }, true);
  window.addEventListener("submit", (event) => {
    if (mode === "read-only") block(event);
  }, true);
  const observer = new MutationObserver(harden);
  const startHardening = () => {
    harden();
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  // An init script can run before the parser creates <html>. Install the event
  // interception immediately and defer only the DOM hardening observer.
  if (document.documentElement) startHardening();
  else document.addEventListener("DOMContentLoaded", startHardening, { once: true });
};

const loadPolicy = (options) => {
  const file = policyPath(options);
  if (!fs.existsSync(file)) return { sendMode: "confirm" };
  ensurePrivateFile(file);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  // Legacy device-wide authorization never carries into another conversation.
  // Read it as confirm without rewriting the session or its rollback data.
  if (value.sendMode === "autonomous") value.sendMode = "confirm";
  if (!POLICY_MODES.has(value.sendMode)) {
    throw new Error(`Local policy ${file} has an unsupported sendMode.`);
  }
  return { sendMode: value.sendMode };
};

const assertSendAllowed = (options) => {
  const { sendMode } = loadPolicy(options);
  if (sendMode === "read-only") throw new Error("Local Telegram Web policy is read-only; sending is disabled.");
  // --confirm attests authorization for this call only. The agent derives it
  // from exact approval or an explicit allowance in this conversation; the
  // runtime never persists that allowance or proposes enabling it.
  if (!options.confirm) {
    throw new Error("Telegram Web send requires --confirm for this invocation.");
  }
  return sendMode;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sha256File = (file) => {
  const digest = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
};

const fileApprovalDescriptor = (file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Telegram Web local file was not found: ${file}`);
  }
  const stat = fs.statSync(file);
  return {
    path: file,
    name: path.basename(file),
    sizeBytes: stat.size,
    sha256: sha256File(file),
  };
};

const ensureOutputParentDirectory = (directory) => {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Download parent is not a directory: ${directory}`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
};

const outgoingMessage = (options) => {
  if (options.messageFile) {
    ensurePrivateFile(options.messageFile);
    return fs.readFileSync(options.messageFile, "utf8");
  }
  return options.message;
};

const requireMessageTarget = (options) => {
  if (!options.messageId && !options.targetText) {
    throw new Error(`${options.command} requires --message-id or --target-text.`);
  }
};

const normalizeUniqueMembers = (members) => {
  const result = [];
  const seen = new Set();
  for (const member of members) {
    const normalized = String(member || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!normalized) throw new Error("--member cannot be empty.");
    const identity = normalized.toLocaleLowerCase("ru-RU");
    if (seen.has(identity)) throw new Error(`Duplicate Telegram Web member reference: ${normalized}`);
    seen.add(identity);
    result.push(normalized);
  }
  return result;
};

const normalizeGlobalSearchQuery = (value) => {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) throw new Error("Telegram Web search requires --query.");
  if (normalized.length > TELEGRAM_SEARCH_QUERY_MAX_CHARS) {
    throw new Error(
      `Telegram Web search query cannot exceed ${TELEGRAM_SEARCH_QUERY_MAX_CHARS} characters.`,
    );
  }
  return normalized;
};

const encodeGlobalSearchCursor = (query, offset) => {
  if (!Number.isInteger(offset) || offset < 1 || offset > TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET) {
    throw new Error("Telegram Web global search cursor offset is invalid.");
  }
  const payload = {
    offset,
    provider: "telegram-web",
    queryDigest: sha256(query),
    v: 1,
  };
  const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (cursor.length > TELEGRAM_GLOBAL_SEARCH_CURSOR_MAX_CHARS) {
    throw new Error("Telegram Web global search cursor is too large.");
  }
  return cursor;
};

const decodeGlobalSearchCursor = (query, value) => {
  if (!value) return 0;
  const cursor = String(value).trim();
  if (
    !cursor
    || cursor.length > TELEGRAM_GLOBAL_SEARCH_CURSOR_MAX_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new Error("Telegram Web global search cursor is invalid.");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Telegram Web global search cursor is invalid.");
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || Object.keys(payload).sort().join(",") !== "offset,provider,queryDigest,v"
    || payload.v !== 1
    || payload.provider !== "telegram-web"
    || payload.queryDigest !== sha256(query)
  ) {
    throw new Error(
      "Telegram Web global search cursor does not belong to this query. Start from the first page.",
    );
  }
  if (
    !Number.isInteger(payload.offset)
    || payload.offset < 1
    || payload.offset > TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET
  ) {
    throw new Error("Telegram Web global search cursor is invalid.");
  }
  return payload.offset;
};

const validateCommandOptions = (options) => {
  const message = outgoingMessage(options);
  options.members = normalizeUniqueMembers(options.members);
  if (options.title) options.title = options.title.normalize("NFKC").replace(/\s+/gu, " ").trim();

  if (options.globalSearch && options.command !== "search") {
    throw new Error("--global is supported only by the Telegram Web search command.");
  }

  // `parseArguments` normally establishes this invariant. Keep the guard in
  // command validation as defense in depth for imported or future callers
  // that construct an options object directly. Validation runs before
  // `withBrowser`, so a bad mode cannot touch the persistent browser profile.
  if (options.command === "login" && options.headed !== true) {
    throw new Error("Telegram Web login requires a visible headed browser mode.");
  }

  if (["dialogs", "contacts"].includes(options.command) && !options.query) {
    throw new Error(`${options.command} requires --query.`);
  }
  if (options.command === "search") {
    if (!options.globalSearch) throw new Error("Telegram Web search requires explicit --global scope.");
    options.query = normalizeGlobalSearchQuery(options.query);
    options.searchOffset = decodeGlobalSearchCursor(options.query, options.cursor);
    if (
      !Number.isInteger(options.context)
      || options.context < 0
      || options.context > TELEGRAM_SEARCH_CONTEXT_RADIUS
    ) {
      throw new Error(`--context must be an integer from 0 to ${TELEGRAM_SEARCH_CONTEXT_RADIUS}.`);
    }
    if (options.context && options.limit > TELEGRAM_SEARCH_CONTEXT_RESULT_LIMIT) {
      throw new Error(
        `Telegram Web search with context requires --limit 1..${TELEGRAM_SEARCH_CONTEXT_RESULT_LIMIT}.`,
      );
    }
  } else {
    if (options.context) {
      throw new Error("--context is supported only by the Telegram Web search command.");
    }
    if (options.cursor) {
      throw new Error("--cursor is supported only by the Telegram Web search command.");
    }
  }
  if ([
    "chat-update",
    "delete",
    "download",
    "edit",
    "forward",
    "member-add",
    "member-remove",
    "members",
    "react",
    "read",
    "reply",
    "send",
  ].includes(options.command) && !options.chat) {
    throw new Error(`${options.command} requires --chat.`);
  }
  if (["delete", "download", "edit", "forward", "react", "reply"].includes(options.command)) {
    requireMessageTarget(options);
  }
  if (["send", "reply", "create-direct"].includes(options.command) && !message && options.files.length === 0) {
    throw new Error(`${options.command} requires --message, --message-file or at least one --file.`);
  }
  if (options.command === "edit" && !message) throw new Error("edit requires --message or --message-file.");
  if (options.command === "react" && !options.reaction) throw new Error("react requires --reaction.");
  if (options.command === "forward" && !options.toChat) throw new Error("forward requires --to-chat.");
  if (options.command === "download" && !options.output) throw new Error("download requires --output.");
  if (options.command === "create-direct") {
    if (!options.contact) throw new Error("create-direct requires --contact.");
    if (!normalizeContactReference(options.contact)) {
      throw new Error("create-direct requires an exact @username, t.me URL or visible contact name.");
    }
  }
  if (options.command === "create-group") {
    const title = options.title.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!title || title.length > 255) throw new Error("create-group requires --title from 1 to 255 characters.");
    if (options.members.length === 0) throw new Error("create-group requires at least one --member.");
    options.title = title;
  }
  if (["member-add", "member-remove"].includes(options.command) && options.members.length === 0) {
    throw new Error(`${options.command} requires at least one --member.`);
  }
  if (options.command === "chat-update" && !options.title && !options.avatar) {
    throw new Error("chat-update requires --title or --avatar.");
  }
  if (options.title && options.title.length > 255) throw new Error("--title cannot exceed 255 characters.");

  options.files.forEach(fileApprovalDescriptor);
  if (options.avatar) fileApprovalDescriptor(options.avatar);
  return { message };
};

const mutationApprovalPayload = (options) => {
  const { message } = validateCommandOptions(options);
  return {
    command: options.command,
    chat: options.chat || null,
    contact: options.contact || null,
    title: options.title || null,
    members: options.members,
    message: message || null,
    files: options.files.map(fileApprovalDescriptor),
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    messageId: options.messageId || null,
    targetText: options.targetText || null,
    targetAuthor: options.targetAuthor || null,
    reaction: options.reaction || null,
    toChat: options.toChat || null,
  };
};

const buildMutationPreview = (options) => {
  if (!MUTATING_COMMANDS.has(options.command)) {
    throw new Error(`Command ${options.command} does not support --dry-run.`);
  }
  const payload = mutationApprovalPayload(options);
  return {
    dryRun: true,
    operation: payload,
    approvalHash: sha256(JSON.stringify(payload)),
    confirmationRequired: STRUCTURAL_CONFIRMATION_COMMANDS.has(options.command)
      || loadPolicy(options).sendMode === "confirm",
  };
};

const assertMutationAllowed = (options) => {
  const policyMode = assertSendAllowed(options);
  if (!STRUCTURAL_CONFIRMATION_COMMANDS.has(options.command)) return policyMode;
  if (!options.confirm) {
    throw new Error(`Telegram Web ${options.command} always requires --confirm.`);
  }
  const expected = buildMutationPreview(options).approvalHash;
  if (!options.approvalHash || options.approvalHash !== expected) {
    throw new Error(
      `Telegram Web ${options.command} requires the exact --approval-hash returned by an unchanged --dry-run.`,
    );
  }
  return policyMode;
};

/**
 * Telegram Web keeps its ordinary product read semantics. Unlike the MAX
 * adapter, this compact runtime does not inspect or rewrite provider protocol
 * frames: opening a dialog may mark its visible messages as read. Returning
 * that fact with every browser result makes the side effect explicit without
 * pretending that a generic browser selector can reliably suppress it.
 */
const prepareAssistAuthorization = (options) => {
  const operation = {
    ...options,
    command: options.fallbackFor,
    members: [...options.members],
    files: [...options.files],
    dryRun: false,
  };
  const { message } = validateCommandOptions(operation);
  const fileCommands = new Set(["send", "reply", "create-direct", "create-group"]);
  if (operation.files.length && !fileCommands.has(operation.command)) {
    throw new Error(`Telegram Web ${operation.command} does not accept --file in assisted recovery.`);
  }
  if (operation.avatar && !["create-group", "chat-update"].includes(operation.command)) {
    throw new Error(`Telegram Web ${operation.command} does not accept --avatar in assisted recovery.`);
  }
  let policyMode = null;
  if (MUTATING_COMMANDS.has(operation.command)) {
    // Manual recovery is not a second authorization path. It must satisfy the
    // same per-call policy and exact approval hash as the ordinary adapter.
    policyMode = assertMutationAllowed(operation);
  }
  if (operation.command === "download") {
    if (fs.existsSync(operation.output) && !fs.statSync(operation.output).isDirectory()) {
      throw new Error(`Refusing to overwrite existing download: ${operation.output}`);
    }
    const outputParent = fs.existsSync(operation.output) && fs.statSync(operation.output).isDirectory()
      ? operation.output
      : path.dirname(operation.output);
    ensureOutputParentDirectory(outputParent);
  }
  const payload = {
    command: operation.command,
    query: operation.query || null,
    globalSearch: operation.globalSearch,
    cursor: operation.cursor || null,
    context: operation.context,
    chat: operation.chat || null,
    contact: operation.contact || null,
    title: operation.title || null,
    members: operation.members,
    message: message || null,
    files: operation.files.map(fileApprovalDescriptor),
    avatar: operation.avatar ? fileApprovalDescriptor(operation.avatar) : null,
    output: operation.output || null,
    messageId: operation.messageId || null,
    targetText: operation.targetText || null,
    targetAuthor: operation.targetAuthor || null,
    reaction: operation.reaction || null,
    toChat: operation.toChat || null,
    attachmentIndex: operation.attachmentIndex,
    limit: operation.limit,
    pages: operation.pages,
    iterations: operation.iterations,
    intervalMs: operation.intervalMs,
  };
  const interactionMode = ASSIST_READ_ONLY_COMMANDS.has(operation.command)
    ? "read-only"
    : "manual-control";
  return {
    operation,
    interactionMode,
    mutationAuthorized: MUTATING_COMMANDS.has(operation.command),
    policyMode,
    authorizationHash: sha256(JSON.stringify(payload)),
    uploadPaths: [...operation.files, ...(operation.avatar ? [operation.avatar] : [])],
    downloadOutput: operation.command === "download" ? operation.output : null,
  };
};

const createReadState = () => ({
  mode: "ordinary-telegram-web",
  mayMarkVisibleMessagesRead: true,
  note: "Opening a Telegram Web dialog may mark its visible messages as read.",
});

const assertLoggedIn = async (page) => {
  assertDocumentAvailable(page);
  const state = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 1
        && rect.height >= 1
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const authVisible = Array.from(document.querySelectorAll("#auth-pages, .auth-pages"))
      .some(visible);
    const appVisible = Array.from(document.querySelectorAll(
      '.chatlist-chat[data-peer-id], .input-search input, input.input-search-input, .chat-input .input-message-input[contenteditable="true"]',
    )).some(visible);
    return { authVisible, appVisible };
  });
  if (!state.appVisible || state.authVisible) {
    throw new Error("Telegram Web login is required. Run login and let the user finish it in the visible window.");
  }
};

const waitForVisibleTelegramUi = async (page, timeoutMs) => {
  const boundedTimeoutMs = Math.min(timeoutMs, TELEGRAM_UI_READY_TIMEOUT_MS);
  return page.waitForFunction(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 1
        && rect.height >= 1
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    // Telegram Web is a client-rendered application. `domcontentloaded` may fire while
    // the persistent profile still shows an empty shell, so browser commands
    // must wait for a visible interactive surface before probing selectors.
    return Array.from(document.querySelectorAll(
      '#auth-pages, .chatlist-chat[data-peer-id], .input-search input, input.input-search-input, textarea, [contenteditable="true"], button, [role="button"]',
    )).some(visible);
  }, null, { timeout: boundedTimeoutMs }).then(() => true).catch(() => false);
};

const openHome = async (page, options, allowLogin = false) => {
  await page.goto(TELEGRAM_WEB_URL, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  assertDocumentAvailable(page);
  let uiReady = await waitForVisibleTelegramUi(page, options.timeoutMs);
  if (!uiReady) {
    // A copied or long-idle persistent profile can occasionally restore a
    // blank SPA shell on the first navigation. One controlled reload recovers
    // that state without weakening selector checks or repeating a user action.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    assertDocumentAvailable(page);
    uiReady = await waitForVisibleTelegramUi(page, options.timeoutMs);
  }
  if (!uiReady && !allowLogin) {
    throw new Error(
      "Telegram Web home rendered no visible interactive UI after one controlled reload. The runtime failed closed.",
    );
  }
  if (!allowLogin) await assertLoggedIn(page);
  return { uiReady };
};

const findSearchInput = async (page, timeoutMs) => {
  const candidates = [
    page.locator('.input-search input, input.input-search-input, .sidebar-left input[type="text"]').filter({ visible: true }).first(),
    page.getByPlaceholder(/найти|поиск|find|search/iu).first(),
    page.getByRole("textbox", { name: /найти|поиск|find|search/iu }).first(),
    page.locator(
      'input[type="search"], input[placeholder*="найти" i], input[placeholder*="поиск" i], input[placeholder*="find" i], input[placeholder*="search" i]',
    ).first(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 1_000 })) {
        await candidate.click({ timeout: timeoutMs });
        return candidate;
      }
    } catch {
      // Telegram Web changes generated class names frequently; try an accessible fallback.
    }
  }

  // Last-resort semantic fallback: on the authenticated Telegram Web home screen the
  // dialog search is normally the only visible input in the upper-left chat
  // pane. Geometry keeps this fallback away from the message composer.
  const visibleInputs = page.locator('input:not([type="hidden"])');
  const fallbackCandidates = [];
  for (let index = 0; index < await visibleInputs.count(); index += 1) {
    const candidate = visibleInputs.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (!box || box.x > 600 || box.y > 400 || box.width < 80 || box.height < 20) continue;
    fallbackCandidates.push(candidate);
  }
  if (fallbackCandidates.length === 1) {
    await fallbackCandidates[0].click({ timeout: timeoutMs });
    return fallbackCandidates[0];
  }

  throw new Error(
    "Could not safely identify the Telegram Web dialog search field. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
  );
};

const fillLocator = async (locator, value, page) => {
  try {
    await locator.fill(value);
  } catch {
    await locator.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(value);
  }
};

const normalizeDialogTitle = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/\s+/gu, " ")
  .trim()
  .toLocaleLowerCase("ru-RU");

const boundedGlobalSearchText = (value, maximum) => {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    value: normalized.slice(0, maximum),
    truncated: normalized.length > maximum,
  };
};

/**
 * Convert browser-owned search rows into a small allowlisted result shape.
 *
 * Telegram message text is untrusted data. The adapter therefore constructs
 * chat URLs only from numeric PeerIds, bounds every visible string and hashes
 * an allowlisted identity instead of returning arbitrary DOM attributes.
 */
const normalizeGlobalSearchRows = (rawRows, maximum = 100) => {
  if (!Array.isArray(rawRows)) throw new Error("Telegram Web search rows must be an array.");
  if (
    !Number.isInteger(maximum)
    || maximum < 1
    || maximum > TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET + 1
  ) {
    throw new Error(
      `Telegram Web search row limit must be an integer from 1 to ${TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET + 1}.`,
    );
  }

  const results = [];
  const seen = new Set();
  for (const rawRow of rawRows) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const peerId = String(rawRow.peerId || "").trim();
    const messageId = String(rawRow.messageId || "").trim();
    const rawThreadId = String(rawRow.threadId || "").trim();
    const threadId = /^-?\d{1,24}$/u.test(rawThreadId) ? rawThreadId : null;
    if (!/^-?[1-9]\d{0,24}$/u.test(peerId) || !/^[1-9]\d{0,19}$/u.test(messageId)) {
      continue;
    }

    const identity = `${peerId}:${messageId}:${threadId || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const title = boundedGlobalSearchText(rawRow.title, 256);
    const sender = boundedGlobalSearchText(rawRow.sender, 256);
    const timestamp = boundedGlobalSearchText(rawRow.timestamp, 128);
    const messageText = boundedGlobalSearchText(rawRow.messageText, 4_000);
    const chatUrl = `${TELEGRAM_WEB_URL}#${peerId}`;
    results.push({
      messageId,
      threadId,
      chat: {
        peerId,
        title: title.value || null,
        url: chatUrl,
      },
      sender: sender.value || null,
      timestamp: timestamp.value || null,
      text: messageText.value,
      textTruncated: messageText.truncated,
      messageKey: sha256(JSON.stringify({ peerId, messageId, threadId })),
    });
    if (results.length >= maximum) break;
  }
  return results;
};

const buildGlobalSearchCoverage = ({
  returned,
  limit,
  offset = 0,
  nextCursor = null,
  cursorLimitReached = false,
  pagesLoaded,
  empty,
  hasExtraResult,
  scrollExhausted,
  pageLimitReached,
  unrecognizedRows,
}) => {
  const hasUnrecognizedRows = Boolean(unrecognizedRows);
  const providerWindowComplete = !hasUnrecognizedRows && Boolean(empty || scrollExhausted);
  const hasMore = hasExtraResult ? true : providerWindowComplete ? false : null;
  const complete = offset === 0 && providerWindowComplete && !hasExtraResult;
  const pageComplete = !hasUnrecognizedRows && Boolean(hasExtraResult || providerWindowComplete);
  let incompleteReason = null;
  if (!complete) {
    if (hasUnrecognizedRows) incompleteReason = "unrecognized_result_rows";
    else if (cursorLimitReached) incompleteReason = "cursor_limit_reached";
    else if (hasExtraResult) incompleteReason = "result_limit_reached";
    else if (pageLimitReached) incompleteReason = "page_limit_reached";
    else if (offset > 0 && providerWindowComplete) incompleteReason = "paginated_window";
    else incompleteReason = "provider_ui_window";
  }
  return {
    scope: "all_accessible_cloud_chats",
    providerSurface: "telegram_web_global_message_search",
    returned,
    limit,
    seenBefore: offset,
    seenThrough: offset + returned,
    pagesLoaded,
    hasMore,
    nextCursor,
    cursorLimitReached: Boolean(cursorLimitReached),
    limitReached: returned >= limit && hasMore === true,
    pageComplete,
    complete,
    incompleteReason,
    snapshotStable: false,
    unrecognizedRows: hasUnrecognizedRows,
    excludedChatTypes: ["secret"],
  };
};

const selectExactDialogResult = (results, reference) => {
  const expected = normalizeDialogTitle(reference);
  const exactMatches = results.filter((result) => normalizeDialogTitle(result.title) === expected);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new Error(
      `Ambiguous exact Telegram Web dialog title: ${reference}. Use an official chat URL.`,
    );
  }

  const visibleCandidates = results
    .slice(0, 5)
    .map((result) => `"${result.title}"`)
    .join(", ");
  throw new Error(
    visibleCandidates
      ? `No exact visible Telegram Web dialog matched: ${reference}. Visible partial matches: ${visibleCandidates}. Use the exact title or an official chat URL.`
      : `No exact visible Telegram Web dialog matched: ${reference}. Use the exact title or an official chat URL.`,
  );
};

const collectDialogResults = (page, query = "", unreadOnly = false) => page.evaluate(({ needle, onlyUnread }) => {
  document.querySelectorAll("[data-trelio-telegram-dialog]").forEach((node) => {
    node.removeAttribute("data-trelio-telegram-dialog");
  });
  const normalized = String(needle || "").normalize("NFKC").toLowerCase().trim();
  const primaryRows = Array.from(document.querySelectorAll('.chatlist-chat[data-peer-id]'));
  const nodes = primaryRows.length > 0
    ? primaryRows
    : Array.from(document.querySelectorAll('a, button, [role="button"], [role="option"], [role="listitem"]'));
  const results = [];
  for (const node of nodes) {
    const visibleLines = String(node.innerText || "")
      .split(/\n+/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const text = visibleLines.join(" ");
    // Telegram Web search can return several messages from one dialog. De-duplicate by
    // its canonical link when available, while preserving different chats or
    // contacts that happen to use the same visible title.
    const titleNode = node.querySelector(
      '.peer-title, [class*="title" i] [class*="name" i], [class*="title" i]',
    );
    const title = (
      titleNode?.textContent
      || visibleLines.find((line) => line.length <= 160)
      || ""
    ).replace(/\s+/gu, " ").trim();
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const peerId = node.getAttribute("data-peer-id")
      || node.closest("[data-peer-id]")?.getAttribute("data-peer-id")
      || null;
    const url = /^-?[1-9]\d*$/u.test(peerId || "")
      ? `https://web.telegram.org/k/#${peerId}`
      : null;
    const unreadNode = node.querySelector(
      '[class*="unread" i], [class*="badge" i], [aria-label*="непрочитан" i], [aria-label*="unread" i]',
    );
    const unreadLabel = [
      unreadNode?.getAttribute("aria-label"),
      unreadNode?.textContent,
      node.getAttribute("aria-label"),
    ].filter(Boolean).join(" ");
    const unreadMatch = unreadLabel.match(/\b(\d{1,6})\b/u);
    const isUnread = /unread/iu.test(String(unreadNode?.className || ""))
      || /непрочитан|unread/iu.test(unreadLabel)
      || Boolean(unreadMatch)
      || /new messages|нов(?:ое|ых) сообщ/iu.test(text);
    const unreadCount = unreadMatch ? Number(unreadMatch[1]) : isUnread ? 1 : 0;
    if (!text || !title || text.length > 500 || (normalized && !title.toLowerCase().includes(normalized))) continue;
    if (onlyUnread && !isUnread) continue;
    if (rect.width < 20 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
    const identity = (url || title).toLocaleLowerCase("ru-RU");
    if (results.some((item) => item.identity === identity)) continue;
    node.setAttribute("data-trelio-telegram-dialog", String(results.length));
    results.push({
      index: results.length,
      identity,
      title,
      text,
      url,
      stableId: peerId,
      peerId,
      isUnread,
      unreadCount,
    });
    if (results.length >= 100) break;
  }
  return results;
}, { needle: query, onlyUnread: unreadOnly });

const globalSearchUiState = (page, query) => page.evaluate((needle) => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width >= 1
      && rect.height >= 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const normalizedNeedle = String(needle || "").normalize("NFKC").toLocaleLowerCase().trim();
  const rows = Array.from(document.querySelectorAll(
    '.search-super-container-chats .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query], .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query]',
  )).filter((row) => {
    const rowQuery = String(row.getAttribute("data-search-query") || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .trim();
    return visible(row) && rowQuery === normalizedNeedle;
  });
  const empty = Array.from(document.querySelectorAll(
    '.search-super-container-chats empty-search-placeholder, .search-super-container-chats .empty-search-placeholder, .search-super-container-chats [class*="empty-search" i]',
  )).some(visible);
  const loading = Array.from(document.querySelectorAll(
    '.search-super-container-chats .preloader-container, .search-super-container-chats .preloader, .search-super-container-chats [aria-busy="true"]',
  )).some(visible);
  return { rowCount: rows.length, empty, loading };
}, query);

const waitForGlobalSearchSurface = async (page, timeoutMs, query) => {
  try {
    await page.waitForFunction((needle) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width >= 1
          && rect.height >= 1
          && style.display !== "none"
          && style.visibility !== "hidden";
      };
      const normalizedNeedle = String(needle || "").normalize("NFKC").toLocaleLowerCase().trim();
      const rows = Array.from(document.querySelectorAll(
        '.search-super-container-chats .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query], .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query]',
      )).some((row) => {
        const rowQuery = String(row.getAttribute("data-search-query") || "")
          .normalize("NFKC")
          .toLocaleLowerCase()
          .trim();
        return visible(row) && rowQuery === normalizedNeedle;
      });
      const empty = Array.from(document.querySelectorAll(
        '.search-super-container-chats empty-search-placeholder, .search-super-container-chats .empty-search-placeholder, .search-super-container-chats [class*="empty-search" i]',
      )).some(visible);
      const loading = Array.from(document.querySelectorAll(
        '.search-super-container-chats .preloader-container, .search-super-container-chats .preloader, .search-super-container-chats [aria-busy="true"]',
      )).some(visible);
      return !loading && (rows || empty);
    }, query, { timeout: timeoutMs });
  } catch {
    throw new Error(
      "Telegram Web global message search did not expose a recognized result or empty state. The runtime failed closed.",
    );
  }
  return globalSearchUiState(page, query);
};

const activateGlobalMessageSearchTab = async (page, timeoutMs) => {
  // Telegram Web K's first search-super tab is the chats/messages surface.
  // Selecting that explicit source-owned tab prevents a restored media tab
  // from silently changing the meaning of a global message search.
  const tab = page.locator('.search-super-tabs .menu-horizontal-div-item').filter({ visible: true }).first();
  if (!await tab.count() || !await tab.isVisible({ timeout: 700 }).catch(() => false)) return false;
  await tab.click({ timeout: timeoutMs });
  return true;
};

const collectVisibleGlobalSearchRows = async (page, query, maximumRows) => {
  const rawRows = await page.evaluate(({ needle, maximum }) => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 20
        && rect.height >= 10
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const normalizedNeedle = String(needle || "").normalize("NFKC").toLocaleLowerCase().trim();
    const rows = Array.from(document.querySelectorAll(
      '.search-super-container-chats .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query], .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query]',
    )).filter((row) => String(row.getAttribute("data-search-query") || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .trim() === normalizedNeedle);
    const results = [];
    for (const row of rows) {
      if (!visible(row)) continue;
      const titleNode = row.querySelector('.peer-title, [class*="title" i]');
      const subtitleNode = row.querySelector('.dialog-subtitle, [class*="subtitle" i]');
      const senderNode = subtitleNode?.querySelector(
        '.peer-title, [class*="sender" i], [class*="author" i]',
      );
      const timeNode = row.querySelector('.message-time, time, [class*="time" i]');
      const compact = (value, maximum) => String(value || "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
      results.push({
        peerId: row.getAttribute("data-peer-id"),
        messageId: row.getAttribute("data-mid"),
        threadId: row.getAttribute("data-thread-id") || row.getAttribute("data-thread"),
        title: compact(titleNode?.textContent, 512),
        sender: compact(senderNode?.textContent, 512),
        timestamp: compact(
          timeNode?.getAttribute("datetime")
            || timeNode?.getAttribute("title")
            || timeNode?.textContent,
          256,
        ),
        messageText: compact(subtitleNode?.innerText || subtitleNode?.textContent, 5_000),
      });
      if (results.length >= maximum) break;
    }
    return results;
  }, { needle: query, maximum: maximumRows });
  return {
    rows: normalizeGlobalSearchRows(rawRows, maximumRows),
    observedRowCount: rawRows.length,
  };
};

const globalSearchScrollState = (page, advance = false) => page.evaluate((shouldAdvance) => {
  const roots = Array.from(document.querySelectorAll(
    '.search-super-container-chats .scrollable-y, .search-super-container-chats, .search-group-messages',
  ));
  const candidates = [];
  const seen = new Set();
  for (const root of roots) {
    let current = root;
    for (let depth = 0; current instanceof HTMLElement && depth < 8; depth += 1) {
      if (!seen.has(current)) {
        seen.add(current);
        candidates.push(current);
      }
      current = current.parentElement;
    }
  }
  const container = candidates.find((candidate) => {
    const style = window.getComputedStyle(candidate);
    return candidate.scrollHeight > candidate.clientHeight + 4
      && /auto|scroll/u.test(style.overflowY);
  }) || candidates.find(
    (candidate) => candidate.scrollHeight > candidate.clientHeight + 4,
  );
  if (!(container instanceof HTMLElement)) {
    return { canAdvance: false, advanced: false, atEnd: true };
  }
  const before = container.scrollTop;
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  const canAdvance = before < maximum - 4;
  if (shouldAdvance && canAdvance) {
    const distance = Math.max(320, Math.round(container.clientHeight * 0.85));
    container.scrollTop = Math.min(maximum, before + distance);
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
  return {
    canAdvance,
    advanced: shouldAdvance && container.scrollTop > before,
    atEnd: container.scrollTop >= maximum - 4,
  };
}, advance);

const prepareGlobalMessageSearch = async (page, options) => {
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, options.query, page);
  await page.waitForTimeout(700);
  await activateGlobalMessageSearchTab(page, options.timeoutMs);
  await waitForGlobalSearchSurface(page, options.timeoutMs, options.query);
};

const searchGlobalMessages = async (page, options) => {
  await prepareGlobalMessageSearch(page, options);
  const offset = options.searchOffset || decodeGlobalSearchCursor(options.query, options.cursor);
  const remainingCursorBudget = TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET - offset;
  if (remainingCursorBudget <= 0) {
    throw new Error(
      "Telegram Web global search cursor reached its bounded result ceiling. Narrow the query.",
    );
  }
  const effectiveLimit = Math.min(options.limit, remainingCursorBudget);
  // One extra normalized row proves that another cursor exists. Asking the
  // browser for the whole bounded prefix matters when Telegram retains earlier
  // search rows in the DOM instead of virtualizing them away: a fixed 100-row
  // snapshot would otherwise never advance beyond that prefix.
  const targetCount = offset + effectiveLimit + 1;

  const accumulated = new Map();
  let pagesLoaded = 1;
  let empty = false;
  let hasExtraResult = false;
  let scrollExhausted = false;
  let pageLimitReached = false;
  let unrecognizedRows = false;

  while (true) {
    const state = await globalSearchUiState(page, options.query);
    empty = state.empty && state.rowCount === 0 && accumulated.size === 0;
    const visibleSnapshot = await collectVisibleGlobalSearchRows(
      page,
      options.query,
      targetCount,
    );
    if (visibleSnapshot.observedRowCount > visibleSnapshot.rows.length) {
      // Duplicate or malformed provider rows are omitted from public output.
      // Conservatively keep coverage incomplete because the runtime cannot
      // prove that every visible result was represented by one safe identity.
      unrecognizedRows = true;
    }
    for (const row of visibleSnapshot.rows) {
      if (!accumulated.has(row.messageKey)) accumulated.set(row.messageKey, row);
    }

    if (accumulated.size >= targetCount) {
      hasExtraResult = true;
      break;
    }
    if (empty) {
      scrollExhausted = true;
      break;
    }

    const scroll = await globalSearchScrollState(page);
    if (!scroll.canAdvance) {
      scrollExhausted = !state.loading && !unrecognizedRows;
      break;
    }
    if (pagesLoaded >= options.pages) {
      pageLimitReached = true;
      break;
    }

    const advanced = await globalSearchScrollState(page, true);
    if (!advanced.advanced) {
      scrollExhausted = true;
      break;
    }
    pagesLoaded += 1;
    await page.waitForTimeout(Math.min(2_000, Math.max(900, Math.round(options.timeoutMs / 25))));
  }

  const allMessages = Array.from(accumulated.values());
  const messages = allMessages.slice(offset, offset + effectiveLimit);
  const nextOffset = offset + messages.length;
  const cursorLimitReached = hasExtraResult
    && !unrecognizedRows
    && nextOffset >= TELEGRAM_GLOBAL_SEARCH_MAX_OFFSET;
  const nextCursor = hasExtraResult
    && !unrecognizedRows
    && !cursorLimitReached
    && messages.length > 0
    ? encodeGlobalSearchCursor(options.query, nextOffset)
    : null;
  const result = {
    scope: "global",
    query: options.query,
    messages,
    coverage: buildGlobalSearchCoverage({
      returned: messages.length,
      limit: options.limit,
      offset,
      nextCursor,
      cursorLimitReached,
      pagesLoaded,
      empty,
      hasExtraResult,
      scrollExhausted,
      pageLimitReached,
      unrecognizedRows,
    }),
  };
  if (options.context) {
    result.contextCoverage = await expandGlobalSearchContexts(page, options, messages);
  }
  return result;
};

const normalizeChatUrl = (reference) => {
  const raw = String(reference || "").trim();
  const numericPeerId = /^-?[1-9]\d*$/u.test(raw) ? raw : null;
  if (numericPeerId) {
    if (!Number.isSafeInteger(Number(numericPeerId))) {
      throw new Error("Telegram Web PeerId must be a safe integer.");
    }
    return `${TELEGRAM_WEB_URL}#${numericPeerId}`;
  }

  const url = new URL(raw);
  const peerId = url.hash.replace(/^#/u, "");
  if (
    url.origin !== TELEGRAM_WEB_ORIGIN
    || !/^\/k\/?$/u.test(url.pathname)
    || url.search
    || !/^-?[1-9]\d*$/u.test(peerId)
    || !Number.isSafeInteger(Number(peerId))
  ) {
    throw new Error("Telegram Web chat reference must be a safe PeerId or canonical Web K peer URL.");
  }
  return `${TELEGRAM_WEB_URL}#${peerId}`;
};

const openChat = async (page, options) => {
  if (/^https?:\/\//iu.test(options.chat) || /^\d+$/u.test(options.chat)) {
    await page.goto(normalizeChatUrl(options.chat), {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    assertDocumentAvailable(page);
    await page.waitForTimeout(2_500);
    await assertLoggedIn(page);
    return { method: "url", url: page.url() };
  }
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, options.chat, page);
  await page.waitForTimeout(1_800);
  const results = await collectDialogResults(page, options.chat);
  // Search results are intentionally substring-based for discovery, but an
  // action must select one exact normalized title. A single partial result is
  // still unsafe: it may be a different person or organization with a longer
  // name, as in "ООО Вкус" versus "ООО Вкус моря".
  const selected = selectExactDialogResult(results, options.chat);
  await page.locator(`[data-trelio-telegram-dialog="${selected.index}"]`).click({ timeout: options.timeoutMs });
  await page.waitForTimeout(2_000);
  const openedUrl = page.url();
  const chatUrlOpened = openedUrl !== TELEGRAM_WEB_URL && openedUrl !== TELEGRAM_WEB_ORIGIN;
  const messageSurfaceVisible = (await visibleMessages(page, 1)).length > 0;
  const composerVisible = await findComposer(page).then(() => true).catch(() => false);
  if (!chatUrlOpened && !messageSurfaceVisible && !composerVisible) {
    throw new Error(
      "Telegram Web dialog click had no verifiable effect. The runtime failed closed; do not send or retry automatically.",
    );
  }
  return { method: "search", matched: selected.title, url: openedUrl };
};

const loadHistoryPages = async (page, pages, timeoutMs) => {
  let loadedPages = 1;
  for (let pageIndex = 1; pageIndex < pages; pageIndex += 1) {
    const scrolled = await page.evaluate(() => {
      const telegramContainer = document.querySelector('.bubbles-scrollable');
      let container = telegramContainer instanceof HTMLElement ? telegramContainer : null;
      const message = Array.from(document.querySelectorAll(
        '.bubbles-inner .bubble[data-mid], [data-message-id], [data-testid*="message" i]',
      )).find((node) => node instanceof HTMLElement && (node.innerText || node.textContent || "").trim());
      if (!container && message instanceof HTMLElement) container = message.parentElement;
      if (!(container instanceof HTMLElement)) return false;
      while (container && container !== document.body) {
        const style = window.getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight + 40 && /auto|scroll/u.test(style.overflowY)) {
          const before = container.scrollHeight;
          container.scrollTop = 0;
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
          container.setAttribute("data-trelio-telegram-history-height", String(before));
          return true;
        }
        container = container.parentElement;
      }
      return false;
    });
    if (!scrolled) break;
    await page.waitForTimeout(Math.min(2_000, Math.max(600, Math.round(timeoutMs / 30))));
    const grew = await page.evaluate(() => {
      const container = document.querySelector('[data-trelio-telegram-history-height]');
      if (!(container instanceof HTMLElement)) return false;
      const previous = Number(container.getAttribute("data-trelio-telegram-history-height") || 0);
      container.removeAttribute("data-trelio-telegram-history-height");
      return container.scrollHeight > previous;
    });
    loadedPages += 1;
    if (!grew) break;
  }
  return loadedPages;
};

const visibleMessages = async (page, limit) => {
  const rawMessages = await page.evaluate((maxCount) => {
  document.querySelectorAll("[data-trelio-telegram-message]").forEach((node) => {
    node.removeAttribute("data-trelio-telegram-message");
  });
  const nodes = Array.from(document.querySelectorAll(
    '.bubbles-inner .bubble[data-mid][data-peer-id], .bubbles-inner .grouped-item[data-mid], [data-message-id], [data-testid*="message" i]',
  ));
  const results = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const text = (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 8_000 || rect.width < 40 || rect.height < 12) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (window.innerWidth >= 900 && rect.right < window.innerWidth * 0.28) continue;
    const providerMessageId = [
      node.getAttribute("data-mid"),
      node.getAttribute("data-message-id"),
      node.getAttribute("data-id"),
      node.id?.match(/(?:message|msg)[-_:]?([A-Za-z0-9_-]+)/iu)?.[1],
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
    ].find(Boolean) || null;
    const authorNode = node.querySelector(
      '.colored-name .peer-title, .name .peer-title, [data-testid*="author" i], [data-testid*="sender" i], [class*="author" i], [class*="sender" i], [class*="name" i]',
    );
    const timeNode = node.querySelector('time, [class*="time" i], [data-testid*="time" i]');
    const replyNode = node.querySelector(
      '[class*="reply" i], [data-testid*="reply" i], [aria-label*="ответ" i], [aria-label*="reply" i]',
    );
    const attachments = Array.from(node.querySelectorAll(
      'a[download], [aria-label*="скач" i], [aria-label*="download" i], [class*="attachment" i], [class*="file" i], img, video, audio',
    )).slice(0, 20).map((attachment, index) => ({
      index: index + 1,
      name: attachment.getAttribute("download")
        || attachment.getAttribute("aria-label")
        || attachment.getAttribute("alt")
        || attachment.getAttribute("title")
        || attachment.textContent?.replace(/\s+/gu, " ").trim()
        || null,
      href: attachment instanceof HTMLAnchorElement ? attachment.href : null,
      kind: attachment.tagName.toLowerCase(),
    }));
    const author = authorNode?.textContent?.replace(/\s+/gu, " ").trim() || null;
    const timestamp = node.getAttribute("data-timestamp")
      || timeNode?.getAttribute("datetime")
      || timeNode?.getAttribute("title")
      || timeNode?.textContent?.replace(/\s+/gu, " ").trim()
      || null;
    const isOutgoing = node.matches('.is-out, [data-outgoing="true"], [data-is-out="true"]')
      || /(?:^|\s)(?:outgoing|message-out|is-out|viewer)(?:\s|$)/iu.test(node.className || "")
      || /вы:|you:/iu.test(author || "");
    const identity = providerMessageId || `${author || ""}\u0000${timestamp || ""}\u0000${text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    node.setAttribute("data-trelio-telegram-message", String(results.length));
    results.push({
      index: results.length,
      providerMessageId,
      author,
      timestamp,
      text,
      isOutgoing,
      replyText: replyNode?.textContent?.replace(/\s+/gu, " ").trim() || null,
      attachments,
    });
  }
  return results.slice(-maxCount);
  }, limit);
  return rawMessages.map((message) => ({
    ...message,
    messageKey: sha256(JSON.stringify({
      providerMessageId: message.providerMessageId,
      author: message.author,
      timestamp: message.timestamp,
      text: message.text,
    })),
  }));
};

const unavailableSearchContext = (radius, reason) => ({
  available: false,
  messages: [],
  matchIndex: null,
  coverage: {
    requestedBefore: radius,
    returnedBefore: 0,
    requestedAfter: radius,
    returnedAfter: 0,
    historyStartReached: null,
    historyEndReached: null,
    complete: false,
    incompleteReasons: [reason],
  },
});

const normalizeContextMessage = (message, isMatch) => {
  const text = boundedGlobalSearchText(message.text, 4_000);
  const reply = boundedGlobalSearchText(message.replyText, 2_000);
  const author = boundedGlobalSearchText(message.author, 256);
  const timestamp = boundedGlobalSearchText(message.timestamp, 128);
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.slice(0, TELEGRAM_FILES_PER_MESSAGE).map((attachment, index) => {
        const name = boundedGlobalSearchText(attachment?.name, 512);
        const kind = boundedGlobalSearchText(attachment?.kind, 32);
        return {
          index: index + 1,
          name: name.value || null,
          kind: kind.value || null,
        };
      })
    : [];
  return {
    providerMessageId: String(message.providerMessageId),
    author: author.value || null,
    timestamp: timestamp.value || null,
    text: text.value,
    textTruncated: text.truncated,
    isOutgoing: Boolean(message.isOutgoing),
    replyText: reply.value || null,
    replyTextTruncated: reply.truncated,
    attachments,
    messageKey: message.messageKey,
    isMatch,
  };
};

/**
 * Select one chronological message window from browser snapshots.
 *
 * Search-result message ids and chat-history message ids are numeric and
 * monotonically ordered inside one Telegram peer. BigInt avoids precision loss
 * for provider ids beyond JavaScript's safe-integer range. Browser-only indexes
 * and arbitrary DOM attributes are deliberately dropped from public output.
 */
const selectContextWindow = (
  rawMessages,
  targetMessageId,
  radius,
  { beforeExhausted = false, afterExhausted = false } = {},
) => {
  if (!Array.isArray(rawMessages)) throw new Error("Telegram Web context messages must be an array.");
  if (!Number.isInteger(radius) || radius < 1 || radius > TELEGRAM_SEARCH_CONTEXT_RADIUS) {
    throw new Error(`Telegram Web context radius must be from 1 to ${TELEGRAM_SEARCH_CONTEXT_RADIUS}.`);
  }
  const target = String(targetMessageId || "").trim();
  if (!/^[1-9]\d{0,19}$/u.test(target)) {
    return unavailableSearchContext(radius, "invalid_target_message_id");
  }

  const byId = new Map();
  for (const message of rawMessages) {
    const messageId = String(message?.providerMessageId || "").trim();
    if (!/^[1-9]\d{0,19}$/u.test(messageId) || byId.has(messageId)) continue;
    byId.set(messageId, { ...message, providerMessageId: messageId });
  }
  const ordered = Array.from(byId.values()).sort((left, right) => {
    const leftId = BigInt(left.providerMessageId);
    const rightId = BigInt(right.providerMessageId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const targetIndex = ordered.findIndex((message) => message.providerMessageId === target);
  if (targetIndex < 0) return unavailableSearchContext(radius, "target_message_not_found");

  const before = ordered.slice(Math.max(0, targetIndex - radius), targetIndex);
  const after = ordered.slice(targetIndex + 1, targetIndex + 1 + radius);
  const beforeComplete = before.length >= radius || beforeExhausted;
  const afterComplete = after.length >= radius || afterExhausted;
  const incompleteReasons = [];
  if (!beforeComplete) incompleteReasons.push("before_provider_ui_window");
  if (!afterComplete) incompleteReasons.push("after_provider_ui_window");
  const selected = [...before, ordered[targetIndex], ...after];
  return {
    available: true,
    messages: selected.map((message) => normalizeContextMessage(
      message,
      message.providerMessageId === target,
    )),
    matchIndex: before.length,
    coverage: {
      requestedBefore: radius,
      returnedBefore: before.length,
      requestedAfter: radius,
      returnedAfter: after.length,
      historyStartReached: beforeExhausted && before.length < radius,
      historyEndReached: afterExhausted && after.length < radius,
      complete: beforeComplete && afterComplete,
      incompleteReasons,
    },
  };
};

const markExactGlobalSearchResult = (page, query, result) => page.evaluate((target) => {
  document.querySelectorAll("[data-trelio-telegram-global-context-target]").forEach((node) => {
    node.removeAttribute("data-trelio-telegram-global-context-target");
  });
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width >= 20
      && rect.height >= 10
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const normalizedQuery = String(target.query || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim();
  const matches = Array.from(document.querySelectorAll(
    '.search-super-container-chats .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query], .search-group-messages .chatlist-chat[data-peer-id][data-mid][data-search-query]',
  )).filter((row) => {
    const rowQuery = String(row.getAttribute("data-search-query") || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .trim();
    const rowThreadId = row.getAttribute("data-thread-id") || row.getAttribute("data-thread") || null;
    return visible(row)
      && rowQuery === normalizedQuery
      && row.getAttribute("data-peer-id") === target.peerId
      && row.getAttribute("data-mid") === target.messageId
      && rowThreadId === target.threadId;
  });
  if (matches.length === 1) {
    matches[0].setAttribute("data-trelio-telegram-global-context-target", "true");
  }
  return matches.length;
}, {
  query,
  peerId: result.chat.peerId,
  messageId: result.messageId,
  threadId: result.threadId,
});

const openExactGlobalSearchResult = async (page, options, result) => {
  await prepareGlobalMessageSearch(page, options);
  let matches = 0;
  for (let pageIndex = 1; pageIndex <= options.pages; pageIndex += 1) {
    matches = await markExactGlobalSearchResult(page, options.query, result);
    if (matches === 1) break;
    if (matches > 1) {
      throw new Error("Telegram Web global search exposed more than one exact context target.");
    }
    if (pageIndex >= options.pages) break;
    const scroll = await globalSearchScrollState(page);
    if (!scroll.canAdvance) break;
    const advanced = await globalSearchScrollState(page, true);
    if (!advanced.advanced) break;
    await page.waitForTimeout(Math.min(2_000, Math.max(900, Math.round(options.timeoutMs / 25))));
  }
  if (matches !== 1) {
    throw new Error("Telegram Web could not relocate the exact global search result for context.");
  }

  await page.locator('[data-trelio-telegram-global-context-target="true"]').click({
    timeout: options.timeoutMs,
  });
  try {
    await page.waitForFunction((messageId) => Array.from(document.querySelectorAll(
      '.bubbles-inner .bubble[data-mid], .bubbles-inner .grouped-item[data-mid], .bubbles-inner [data-message-id]',
    )).some((node) => [
      node.getAttribute("data-mid"),
      node.getAttribute("data-message-id"),
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
    ].includes(messageId)), result.messageId, { timeout: options.timeoutMs });
  } catch {
    throw new Error("Telegram Web did not open the exact search-result message for context.");
  }
};

const collectLoadedContextMessages = async (page, accumulated) => {
  const snapshot = await visibleMessages(page, 500);
  for (const message of snapshot) {
    const messageId = String(message.providerMessageId || "").trim();
    if (/^[1-9]\d{0,19}$/u.test(messageId) && !accumulated.has(messageId)) {
      accumulated.set(messageId, message);
    }
  }
};

const centerExactContextMessage = async (page, messageId) => page.evaluate((targetMessageId) => {
  const target = Array.from(document.querySelectorAll(
    '.bubbles-inner .bubble[data-mid], .bubbles-inner .grouped-item[data-mid], .bubbles-inner [data-message-id]',
  )).find((node) => [
    node.getAttribute("data-mid"),
    node.getAttribute("data-message-id"),
    node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
  ].includes(targetMessageId));
  if (!(target instanceof HTMLElement)) return false;
  target.scrollIntoView({ block: "center", inline: "nearest" });
  return true;
}, messageId);

const advanceContextHistory = async (page, direction, timeoutMs) => {
  const state = await page.evaluate((requestedDirection) => {
    let container = document.querySelector('.bubbles-scrollable');
    const target = Array.from(document.querySelectorAll(
      '.bubbles-inner .bubble[data-mid], .bubbles-inner .grouped-item[data-mid], .bubbles-inner [data-message-id]',
    )).find((node) => node instanceof HTMLElement);
    if (!(container instanceof HTMLElement) && target instanceof HTMLElement) {
      container = target.parentElement;
      while (container && container !== document.body) {
        const style = window.getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight + 20 && /auto|scroll/u.test(style.overflowY)) break;
        container = container.parentElement;
      }
    }
    if (!(container instanceof HTMLElement) || container === document.body) {
      return { available: false, atBoundary: false };
    }
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    const distance = Math.max(320, Math.round(container.clientHeight * 0.9));
    container.scrollTop = requestedDirection === "before"
      ? Math.max(0, container.scrollTop - distance)
      : Math.min(maximum, container.scrollTop + distance);
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { available: true, atBoundary: false };
  }, direction);
  if (!state.available) return state;
  await page.waitForTimeout(Math.min(2_000, Math.max(700, Math.round(timeoutMs / 30))));
  return page.evaluate((requestedDirection) => {
    const container = document.querySelector('.bubbles-scrollable');
    if (!(container instanceof HTMLElement)) return { available: false, atBoundary: false };
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    return {
      available: true,
      atBoundary: requestedDirection === "before"
        ? container.scrollTop <= 4
        : container.scrollTop >= maximum - 4,
    };
  }, direction);
};

const loadGlobalSearchContext = async (page, options, result) => {
  await openExactGlobalSearchResult(page, options, result);
  const accumulated = new Map();
  await collectLoadedContextMessages(page, accumulated);
  if (!accumulated.has(result.messageId)) {
    return unavailableSearchContext(options.context, "target_message_not_found");
  }

  let beforeExhausted = false;
  let afterExhausted = false;
  for (const direction of ["before", "after"]) {
    // Return to the exact hit before expanding each side. Otherwise a long
    // upward expansion could leave the browser several virtualized screens
    // away from the target before the newer-message pass starts.
    if (!await centerExactContextMessage(page, result.messageId)) {
      // Telegram Web may virtualize the target bubble after the first side was
      // expanded. Relocate the same exact search row once instead of guessing
      // a scroll distance through unloaded history.
      await openExactGlobalSearchResult(page, options, result);
      await collectLoadedContextMessages(page, accumulated);
      if (!await centerExactContextMessage(page, result.messageId)) {
        return unavailableSearchContext(options.context, "target_message_not_found");
      }
    }
    await page.waitForTimeout(Math.min(1_000, Math.max(350, Math.round(options.timeoutMs / 60))));
    await collectLoadedContextMessages(page, accumulated);
    let stagnantBoundaryAttempts = 0;
    for (let attempt = 0; attempt < TELEGRAM_SEARCH_CONTEXT_SCROLL_ATTEMPTS; attempt += 1) {
      const current = selectContextWindow(
        Array.from(accumulated.values()),
        result.messageId,
        options.context,
        { beforeExhausted, afterExhausted },
      );
      const returned = direction === "before"
        ? current.coverage.returnedBefore
        : current.coverage.returnedAfter;
      if (returned >= options.context) break;

      const previousReturned = returned;
      const movement = await advanceContextHistory(page, direction, options.timeoutMs);
      if (!movement.available) break;
      await collectLoadedContextMessages(page, accumulated);
      const next = selectContextWindow(
        Array.from(accumulated.values()),
        result.messageId,
        options.context,
        { beforeExhausted, afterExhausted },
      );
      const nextReturned = direction === "before"
        ? next.coverage.returnedBefore
        : next.coverage.returnedAfter;
      if (nextReturned > previousReturned) stagnantBoundaryAttempts = 0;
      else if (movement.atBoundary) stagnantBoundaryAttempts += 1;
      else stagnantBoundaryAttempts = 0;
      if (stagnantBoundaryAttempts >= 2) {
        if (direction === "before") beforeExhausted = true;
        else afterExhausted = true;
        break;
      }
    }
  }
  return selectContextWindow(
    Array.from(accumulated.values()),
    result.messageId,
    options.context,
    { beforeExhausted, afterExhausted },
  );
};

const expandGlobalSearchContexts = async (page, options, messages) => {
  let available = 0;
  let complete = true;
  // Opening result chats sequentially keeps one deterministic browser surface
  // and avoids racing the single persistent Telegram Web profile/navigation.
  for (const message of messages) {
    try {
      message.context = await loadGlobalSearchContext(page, options, message);
    } catch {
      message.context = unavailableSearchContext(options.context, "provider_ui_unavailable");
    }
    if (message.context.available) available += 1;
    if (!message.context.coverage.complete) complete = false;
  }
  return {
    radius: options.context,
    attempted: messages.length,
    available,
    complete,
    incompleteReason: complete ? null : "one_or_more_context_windows_incomplete",
    readState: "ordinary-telegram-web",
  };
};

const findMessageTarget = async (page, options, { outgoingOnly = false } = {}) => {
  const messages = await visibleMessages(page, 100);
  const normalizedTargetText = options.targetText
    ? options.targetText.normalize("NFKC").replace(/\s+/gu, " ").trim()
    : null;
  const normalizedTargetAuthor = options.targetAuthor
    ? options.targetAuthor.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU")
    : null;
  const matches = messages.filter((message) => {
    if (options.messageId && message.providerMessageId !== options.messageId) return false;
    if (normalizedTargetText && message.text !== normalizedTargetText) return false;
    if (
      normalizedTargetAuthor
      && String(message.author || "").toLocaleLowerCase("ru-RU") !== normalizedTargetAuthor
    ) return false;
    if (outgoingOnly && !message.isOutgoing) return false;
    return true;
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No" : "Several";
    throw new Error(
      `${reason} exact Telegram Web messages matched the requested target. Use a provider --message-id or add exact --target-text and --target-author.`,
    );
  }
  const target = page.locator(`[data-trelio-telegram-message="${matches[0].index}"]`);
  if (await target.count() !== 1) {
    throw new Error("The exact Telegram Web message disappeared before the action. Read the chat again and retry once.");
  }
  return { locator: target, message: matches[0] };
};

const clickVisibleAction = async (page, label, timeoutMs, { exact = false } = {}) => {
  const candidates = [
    page.getByRole("button", { name: label, exact }).last(),
    page.getByRole("menuitem", { name: label, exact }).last(),
    page.getByText(label, { exact }).last(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) {
        await candidate.click({ timeout: timeoutMs });
        return;
      }
    } catch {
      // Try the next accessible representation of the same exact action.
    }
  }
  throw new Error(`Could not safely identify the Telegram Web action: ${label}`);
};

const confirmVisibleDialogAction = async (page, label, timeoutMs) => {
  const dialogs = page.getByRole("dialog");
  for (let index = (await dialogs.count()) - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible({ timeout: 500 }).catch(() => false)) continue;
    const button = dialog.getByRole("button", { name: label }).last();
    if (!await button.count() || !await button.isVisible({ timeout: 500 }).catch(() => false)) {
      throw new Error(`Telegram Web confirmation dialog did not expose the expected action: ${label}`);
    }
    await button.click({ timeout: timeoutMs });
    return true;
  }
  return false;
};

const openMessageActionMenu = async (page, target, timeoutMs) => {
  await target.hover({ timeout: timeoutMs });
  const menuButtons = [
    target.getByRole("button", { name: /ещ[её]|more|действ|меню/iu }).last(),
    target.locator('[aria-label*="ещ" i], [aria-label*="more" i], [title*="ещ" i], [title*="more" i]').last(),
  ];
  for (const button of menuButtons) {
    try {
      if (await button.count() && await button.isVisible({ timeout: 700 })) {
        await button.click({ timeout: timeoutMs });
        return "button";
      }
    } catch {
      // A right-click remains an intentional semantic fallback for messages.
    }
  }
  await target.click({ button: "right", timeout: timeoutMs });
  return "context-menu";
};

const findPickerSearchInput = async (page, timeoutMs) => {
  const candidates = [
    page.getByPlaceholder(/найти|поиск|find|search/iu).last(),
    page.getByRole("textbox", { name: /найти|поиск|find|search/iu }).last(),
    page.locator('input[type="search"], input[placeholder*="найти" i], input[placeholder*="поиск" i]').last(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) return candidate;
    } catch {
      // Continue to the next accessible picker input.
    }
  }
  throw new Error("Could not safely identify the Telegram Web participant/chat picker search field.");
};

const normalizeContactReference = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/^https:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//iu, "")
  .replace(/^@/u, "")
  .replace(/\/$/u, "")
  .replace(/\s+/gu, " ")
  .trim()
  .toLocaleLowerCase("ru-RU");

const selectExactContactResult = (results, reference) => {
  const expected = normalizeContactReference(reference);
  const matches = results.filter((result) => {
    const stableId = normalizeContactReference(result.stableId);
    const title = normalizeContactReference(result.title);
    const textTokens = String(result.text || "")
      .split(/\s+/u)
      .map(normalizeContactReference);
    return stableId === expected || title === expected || textTokens.includes(expected);
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No" : "Several";
    throw new Error(
      `${reason} exact Telegram Web contacts matched ${reference}. Use an exact @username, t.me URL or visible name.`,
    );
  }
  return matches[0];
};

const chooseExactPickerEntry = async (page, reference, timeoutMs) => {
  const input = await findPickerSearchInput(page, timeoutMs);
  await fillLocator(input, normalizeContactReference(reference), page);
  await page.waitForTimeout(1_200);
  const results = await collectDialogResults(page, normalizeContactReference(reference));
  const selected = selectExactContactResult(results, reference);
  await page.locator(`[data-trelio-telegram-dialog="${selected.index}"]`).click({ timeout: timeoutMs });
  return selected;
};

const findComposer = async (page) => {
  const locators = [
    page.locator('.chat-input .input-message-input[contenteditable="true"], .input-message-input[contenteditable="true"]').filter({ visible: true }).last(),
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"]').last(),
    page.getByRole("textbox").last(),
  ];
  for (const locator of locators) {
    try {
      if (await locator.count() && await locator.isVisible({ timeout: 1_000 })) return locator;
    } catch {
      // Try the next accessible composer.
    }
  }

  // Generated classes and accessibility metadata may change independently.
  // A composer is still expected to be a sizeable editable element in the
  // lower-right chat pane, unlike the dialog search in the upper-left pane.
  const viewport = page.viewportSize() || { width: 1280, height: 900 };
  const editable = page.locator(
    'textarea, [contenteditable="true"], [role="textbox"], input:not([type="hidden"])',
  );
  const geometricCandidates = [];
  for (let index = 0; index < await editable.count(); index += 1) {
    const candidate = editable.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox();
    if (!box) continue;
    if (
      box.x < Math.min(300, viewport.width * 0.28)
      || box.y < viewport.height * 0.5
      || box.width < 120
      || box.height < 20
    ) {
      continue;
    }
    geometricCandidates.push({ candidate, box });
  }
  geometricCandidates.sort((left, right) => (
    (right.box.y + right.box.height) - (left.box.y + left.box.height)
    || right.box.x - left.box.x
  ));
  if (geometricCandidates.length > 0) return geometricCandidates[0].candidate;

  throw new Error(
    "Could not safely identify a visible Telegram Web message composer. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
  );
};

const uploadFiles = async (page, files, timeoutMs) => {
  if (files.length === 0) return;
  const inputs = page.locator('input[type="file"]');
  if (await inputs.count()) {
    await inputs.last().setInputFiles(files, { timeout: timeoutMs });
    return;
  }
  const button = page.getByRole("button", { name: /загрузить|прикрепить|attach|файл/iu }).last();
  const chooserPromise = page.waitForEvent("filechooser", { timeout: timeoutMs });
  await button.click({ timeout: timeoutMs });
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
};

const sendCurrentComposer = async (page, timeoutMs, hasText) => {
  const button = page.getByRole("button", { name: /отправить|send/iu }).last();
  try {
    if (await button.count() && await button.isVisible({ timeout: 1_000 })) {
      await button.click({ timeout: timeoutMs });
      return "button";
    }
  } catch {
    // Text-only chats usually support Enter as the stable fallback.
  }
  if (!hasText) throw new Error("Could not find the Telegram Web send button for the attachment.");
  await page.keyboard.press("Enter");
  return "enter";
};

const composerText = async (composer) => composer.evaluate((element) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent || "";
});

const verifyTextSend = async (page, composer, message, timeoutMs) => {
  const exactMessage = page.getByText(message, { exact: true }).last();
  await exactMessage.waitFor({
    state: "visible",
    timeout: Math.min(timeoutMs, 15_000),
  }).catch(() => {
    throw new Error(
      "Telegram Web send result is ambiguous: the exact outgoing text did not appear in the open chat. Do not retry automatically.",
    );
  });
  const remainingDraft = (await composerText(composer)).trim();
  if (remainingDraft) {
    throw new Error(
      "Telegram Web send result is ambiguous: the composer still contains text. Do not retry automatically.",
    );
  }
  return "exact-text-visible-and-composer-cleared";
};

const verifyAttachmentSend = async (page, files, timeoutMs) => {
  if (files.length === 0) return [];
  const verified = [];
  for (const file of files) {
    const filename = path.basename(file);
    await page.getByText(filename, { exact: true }).last().waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 15_000),
    }).catch(() => {
      throw new Error(
        `Telegram Web send result is ambiguous: attachment ${filename} did not appear in the open chat. Do not retry automatically.`,
      );
    });
    verified.push(filename);
  }
  return verified;
};

const withBrowser = async (options, callback, browserOptions = {}) => {
  const runtime = await browserSessionRuntime();
  return runtime.withPersistentBrowserSession({
    chromeExecutable: options.chromeExecutable,
    profileDirectory: profilePath(options),
    downloadsDirectory: downloadsPath(options),
    lockPath: path.join(connectionRoot(options), "locks", "browser.lock"),
    headed: options.headed,
    acceptDownloads: browserOptions.acceptDownloads !== false,
    label: "Telegram Web",
    // Telegram keeps ordinary provider read semantics. Returning that state
    // from prepareContext makes the shared lifecycle generic without hiding
    // this provider-specific side effect from command results.
    prepareContext: async (context) => {
      installDocumentHttpObserver(context, runtime);
      if (browserOptions.assistGate) {
        // Install the synchronous interaction gate before Telegram's first
        // navigation so native mouse and keyboard input cannot outrun it.
        await context.addInitScript(installTelegramAssistGate, browserOptions.assistGate);
      }
      return createReadState();
    },
    preparePage: browserOptions.assistGate
      ? (page) => page.evaluate(installTelegramAssistGate, browserOptions.assistGate)
      : null,
  }, callback);
};

const bootstrapBrowserSession = async () => {
  const runtime = await browserSessionRuntime();
  return runtime.bootstrapPlaywright();
};

const requestAssistControl = (record, command, fields = {}, timeoutMs = 5_000) => new Promise((resolve, reject) => {
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65_535
    || typeof record.token !== "string" || record.token.length < 32) {
    reject(new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
      "The Telegram Web assisted-browser control channel is unavailable.",
    ));
    return;
  }
  const body = JSON.stringify({ command, sessionId: record.sessionId, ...fields });
  const request = http.request({
    hostname: "127.0.0.1",
    port: record.port,
    path: "/",
    method: "POST",
    headers: {
      Authorization: `Bearer ${record.token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: `127.0.0.1:${record.port}`,
    },
    timeout: timeoutMs,
  }, (response) => {
    let value = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value) > 64 * 1024) request.destroy();
    });
    response.on("end", () => {
      if (response.statusCode !== 200) {
        try {
          const failure = JSON.parse(value);
          reject(new TelegramWebRuntimeError(
            failure.code || "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
            failure.error || "The Telegram Web assisted-browser control channel rejected the request.",
            failure.details,
          ));
        } catch {
          reject(new TelegramWebRuntimeError(
            "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
            "The Telegram Web assisted-browser control channel rejected the request.",
          ));
        }
        return;
      }
      try {
        resolve(JSON.parse(value));
      } catch {
        reject(new TelegramWebRuntimeError(
          "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
          "The Telegram Web assisted-browser control channel returned an invalid response.",
        ));
      }
    });
  });
  request.once("timeout", () => request.destroy(new Error("assist control timeout")));
  request.once("error", () => reject(new TelegramWebRuntimeError(
    "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
    "The Telegram Web assisted-browser control channel is unavailable.",
  )));
  request.end(body);
});

const removeAssistSessionIfExact = (options, sessionId) => {
  const file = assistSessionPath(options);
  try {
    const current = readAssistSession(options);
    if (current?.sessionId === sessionId) {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(connectionRoot(options), 'state', 'assist-snapshots', sessionId),
        { recursive: true, force: true });
    }
  } catch {
    // Never remove a record whose identity cannot be re-read exactly.
  }
};

const activeAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
  // A concurrent start must not delete the record before its detached worker
  // has had a chance to publish the PID and loopback control endpoint.
  if (record.phase === "starting") {
    if (processIsAlive(record.pid)) {
      throw new TelegramWebRuntimeError(
        "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
        "A Telegram Web assisted-browser session is starting. Wait briefly before checking it again.",
        { sessionId: record.sessionId, phase: record.phase },
      );
    }
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
  if (!processIsAlive(record.pid)) {
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
  if (record.phase !== "ready") {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_UNAVAILABLE",
      "A Telegram Web assisted-browser session exists but is not ready. Wait briefly or stop that exact session.",
      { sessionId: record.sessionId, phase: record.phase },
    );
  }
  try {
    const status = await requestAssistControl(record, "status");
    return { record, status };
  } catch (error) {
    if (processIsAlive(record.pid)) throw error;
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
};

const startAssistSession = async (options) => withAssistStartLock(options, async () => {
  const runtime = await browserSessionRuntime();
  options.chromeExecutable ||= runtime.defaultBrowserExecutable();
  const browserSession = runtime.assertManualAssistAllowed({
    expectedSessionClass: "messenger-profile",
  });
  const authorization = prepareAssistAuthorization(options);
  const current = await activeAssistSession(options);
  if (current) {
    if (current.record.authorizationHash !== authorization.authorizationHash) {
      throw new TelegramWebRuntimeError(
        "TELEGRAM_ASSIST_SESSION_ACTIVE",
        "Another Telegram Web assisted-browser session is already active. Stop it before changing the exact authorized operation.",
        publicAssistStatus(current.record),
      );
    }
    return { ...current.status, reused: true };
  }

  const sessionId = randomUUID();
  const expiresAt = Math.min(
    Date.now() + Math.min(options.holdMs, TELEGRAM_ASSIST_HOLD_MS),
    browserSession.deadlineAt,
  );
  const initial = {
    schemaVersion: 1,
    sessionId,
    phase: "starting",
    fallbackFor: options.fallbackFor,
    interactionMode: authorization.interactionMode,
    mutationAuthorized: authorization.mutationAuthorized,
    authorizationHash: authorization.authorizationHash,
    expiresAt,
    pid: null,
    port: null,
    token: null,
    appName: assistAppName(options.chromeExecutable),
  };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__assist-worker"], {
    detached: true,
    windowsHide: false,
    shell: false,
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.once("error", () => {
    writePrivateJson(assistSessionPath(options), {
      ...initial,
      phase: "failed",
      error: "TELEGRAM_ASSIST_WORKER_START_FAILED",
    });
  });
  // The worker blocks on stdin until the parent has durably published its PID,
  // so a second process can distinguish an active start from abandoned state.
  writePrivateJson(assistSessionPath(options), { ...initial, pid: child.pid });
  child.stdin.on("error", () => {});
  child.stdin.end(`${JSON.stringify({
    schemaVersion: 1,
    sessionId,
    fallbackFor: options.fallbackFor,
    companyId: options.companyId,
    memberId: options.memberId,
    connectionId: options.connectionId,
    interactionMode: authorization.interactionMode,
    mutationAuthorized: authorization.mutationAuthorized,
    authorizationHash: authorization.authorizationHash,
    uploadPaths: authorization.uploadPaths,
    downloadOutput: authorization.downloadOutput,
    // The worker must reuse the exact host-discovered or explicitly selected
    // executable from assist-start. Re-resolving it in a detached process
    // could report one app while opening another after an installation change.
    browserExecutable: options.chromeExecutable,
    expiresAt,
  })}\n`);
  child.unref();

  const deadline = Date.now() + TELEGRAM_ASSIST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = readAssistSession(options);
    if (!record || record.sessionId !== sessionId) {
      throw new TelegramWebRuntimeError(
        "TELEGRAM_ASSIST_WORKER_START_FAILED",
        "The Telegram Web assisted-browser worker did not retain its exact session record.",
      );
    }
    if (record.phase === "failed") {
      throw new TelegramWebRuntimeError(
        record.error || "TELEGRAM_ASSIST_WORKER_START_FAILED",
        record.message || "The Telegram Web assisted-browser worker failed before becoming ready.",
      );
    }
    if (record.phase === "ready") {
      const status = await requestAssistControl(record, "status");
      return { ...status, reused: false };
    }
  }
  if (processIsAlive(child.pid)) {
    try {
      process.kill(child.pid);
    } catch {
      // The worker may have exited between the liveness check and the signal.
    }
  }
  removeAssistSessionIfExact(options, sessionId);
  throw new TelegramWebRuntimeError(
    "TELEGRAM_ASSIST_START_TIMEOUT",
    "The Telegram Web assisted-browser window did not become ready before the bounded startup deadline.",
    { sessionId },
  );
});

const statusAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record || record.sessionId !== options.assistSession) {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_NOT_FOUND",
      "The exact Telegram Web assisted-browser session is not active.",
    );
  }
  return requestAssistControl(record, "status");
};

const interactWithAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record || record.sessionId !== options.assistSession) {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_NOT_FOUND",
      "The exact Telegram Web assisted-browser session is not active.",
    );
  }
  const command = options.command.slice("assist-".length);
  const fields = command === "snapshot" ? {}
    : ["click", "contextmenu"].includes(command) ? { snapshotId: options.assistSnapshot, ref: options.assistRef }
      : command === "fill" ? { snapshotId: options.assistSnapshot, ref: options.assistRef, text: options.assistText }
        : command === "key" ? { snapshotId: options.assistSnapshot, key: options.assistKey }
          : ["point-click", "point-contextmenu"].includes(command) ? { snapshotId: options.assistSnapshot,
            x: options.assistX, y: options.assistY }
            : command === "point-scroll" ? { snapshotId: options.assistSnapshot,
              x: options.assistX, y: options.assistY, deltaY: options.assistDeltaY }
              : { snapshotId: options.assistSnapshot, deltaY: options.assistDeltaY };
  return requestAssistControl(record, command, fields, 10_000);
};

const stopAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record || record.sessionId !== options.assistSession) {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_SESSION_NOT_FOUND",
      "The exact Telegram Web assisted-browser session is not active.",
    );
  }
  const status = await requestAssistControl(record, "stop");
  // Chrome may need longer than the loopback acknowledgement to flush its
  // persistent profile and close the worker. Keep the same bounded teardown
  // window as MAX so a normal close is not misreported as a stuck session.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && processIsAlive(record.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processIsAlive(record.pid)) {
    throw new TelegramWebRuntimeError(
      "TELEGRAM_ASSIST_STOP_UNCONFIRMED",
      "The Telegram Web assisted-browser worker accepted stop but its shutdown is not yet confirmed.",
      { sessionId: record.sessionId },
    );
  }
  removeAssistSessionIfExact(options, record.sessionId);
  return { ...status, phase: "closed", closed: true };
};

const readAssistWorkerConfig = () => {
  const input = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new TelegramWebRuntimeError("TELEGRAM_ASSIST_CONFIG_INVALID", "The assisted-browser worker config is too large.");
  }
  const value = JSON.parse(input);
  const identity = requireRuntimeIdentity();
  const expectedMode = ASSIST_READ_ONLY_COMMANDS.has(value?.fallbackFor)
    ? "read-only"
    : "manual-control";
  const uploadsValid = Array.isArray(value?.uploadPaths)
    && value.uploadPaths.length <= TELEGRAM_FILES_PER_MESSAGE + 1
    && value.uploadPaths.every((file) => typeof file === "string"
      && path.isAbsolute(file)
      && fs.existsSync(file)
      && fs.statSync(file).isFile());
  const downloadOutputValid = value?.downloadOutput === null
    || (typeof value?.downloadOutput === "string" && path.isAbsolute(value.downloadOutput));
  const browserExecutableValid = typeof value?.browserExecutable === "string"
    && path.isAbsolute(value.browserExecutable);
  if (value?.schemaVersion !== 1
    || !UUID_PATTERN.test(value.sessionId || "")
    || !UUID_PATTERN.test(value.companyId || "")
    || !UUID_PATTERN.test(value.memberId || "")
    || !UUID_PATTERN.test(value.connectionId || "")
    || value.companyId !== identity.companyId
    || value.memberId !== identity.memberId
    || value.connectionId !== identity.connectionId
    || !ASSIST_COMMANDS.has(value.fallbackFor)
    || value.interactionMode !== expectedMode
    || value.mutationAuthorized !== MUTATING_COMMANDS.has(value.fallbackFor)
    || !/^[0-9a-f]{64}$/u.test(value.authorizationHash || "")
    || !uploadsValid
    || !downloadOutputValid
    || !browserExecutableValid
    || (value.fallbackFor === "download") !== Boolean(value.downloadOutput)
    || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= Date.now()
    || value.expiresAt - Date.now() > TELEGRAM_ASSIST_HOLD_MS) {
    throw new TelegramWebRuntimeError("TELEGRAM_ASSIST_CONFIG_INVALID", "The assisted-browser worker config is invalid.");
  }
  return value;
};

const readBoundedAssistBody = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > 4_096) {
      reject(new TelegramWebRuntimeError("TELEGRAM_ASSIST_CONTROL_REJECTED", "The assisted-browser request is too large."));
      request.destroy();
    }
  });
  request.on("end", () => {
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new TelegramWebRuntimeError("TELEGRAM_ASSIST_CONTROL_REJECTED", "The assisted-browser request is invalid."));
    }
  });
  request.on("error", reject);
});

// Screenshots are deliberately short-lived and bound to the visible provider
// document. Search results can update while the agent thinks; a changed page
// invalidates the previous control refs instead of dispatching to a new row.
const assistPageDigest = async (page, mutationAuthorized) => {
  const state = await page.evaluate((includeText) => {
    const selector = 'a[href], button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"], .chatlist-chat[data-peer-id]';
    const controls = Array.from(document.querySelectorAll(selector)).slice(0, 500).map((node) => {
      const rect = node.getBoundingClientRect();
      return [node.tagName, node.getAttribute('role'), node.getAttribute('aria-label'),
        node.getAttribute('title'), node.getAttribute('placeholder'),
        node.getAttribute('data-peer-id'),
        node.matches('.chatlist-chat[data-peer-id]') ? null
          : String(node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
        node instanceof HTMLInputElement && !['password', 'file'].includes(node.type) ? node.value : null,
        rect.x, rect.y, rect.width, rect.height];
    });
    // A mutation may target an exact message outside the standard controls;
    // retain visible body text in that case. Read-only inspection omits it so
    // unrelated incoming previews do not constantly stale a search snapshot.
    return JSON.stringify({ url: window.location.href, controls,
      text: includeText ? document.body?.innerText || '' : null });
  }, mutationAuthorized);
  if (Buffer.byteLength(state) > 2 * 1024 * 1024) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_PAGE_TOO_LARGE', 'The Telegram Web page is too large for a safe screenshot binding.');
  }
  return sha256(state);
};

const collectAssistControls = (page) => page.evaluate(() => {
  document.querySelectorAll('[data-trelio-telegram-assist-ref]').forEach((node) => {
    node.removeAttribute('data-trelio-telegram-assist-ref');
  });
  const selector = 'a[href], button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"], .chatlist-chat[data-peer-id]';
  const controls = [];
  const seen = new Set();
  for (const node of document.querySelectorAll(selector)) {
    if (node instanceof HTMLInputElement && ['password', 'file'].includes(node.type)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden'
      || rect.x >= window.innerWidth || rect.y >= window.innerHeight
      || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) continue;
    const ref = `r${controls.length + 1}`;
    node.setAttribute('data-trelio-telegram-assist-ref', ref);
    const label = String(node.getAttribute('aria-label') || node.getAttribute('title')
      || node.getAttribute('placeholder')
      || (node.matches('.chatlist-chat[data-peer-id]')
        ? node.querySelector('h3, [role="heading"]')?.textContent || node.getAttribute('data-peer-id')
        : node.innerText || node.textContent) || '')
      .replace(/\s+/gu, ' ').trim().slice(0, 160);
    const link = node.closest('a[href]');
    controls.push({ ref, role: node.getAttribute('role') || node.tagName.toLowerCase(), label,
      editable: node.matches('input:not([type="password"]):not([type="file"]), textarea, [contenteditable="true"]'),
      href: link?.href?.startsWith(`${window.location.origin}/`) ? link.href : null,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    if (controls.length >= 100) break;
  }
  return controls;
});

const inspectAssistPoint = async (page, packet, interactionMode, fallbackFor) => {
  const target = await page.evaluate(({ x, y }) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const node = document.elementFromPoint(x, y);
    let element = node?.closest('a, button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"], .chatlist-chat[data-peer-id]') || node;
    while (element && !(element instanceof HTMLElement)) element = element.parentElement;
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (rect.width < 8 || rect.height < 8 || style.visibility === 'hidden' || style.display === 'none') return null;
    const link = element.closest('a[href]');
    return {
      tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
      label: String(element.getAttribute('aria-label') || element.getAttribute('title')
        || element.getAttribute('placeholder') || element.innerText || element.textContent || '')
        .replace(/\s+/gu, ' ').trim().slice(0, 160),
      href: link?.href || '', chatRow: element.matches('.chatlist-chat[data-peer-id]'),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewportWidth: window.innerWidth, pathname: window.location.pathname,
    };
  }, packet);
  if (!target || ['password', 'file'].includes(target.type)) return false;
  if (target.href && !target.href.startsWith(`${TELEGRAM_WEB_ORIGIN}/k/`)) return false;
  if (interactionMode === 'read-only' && ['click', 'fill', 'point-click'].includes(packet.command)) {
    return assistInteractionAllowed({ ...target, fallbackFor,
      kind: packet.command === 'fill' ? 'fill' : 'click' });
  }
  return true;
};

const validateAssistControlPacket = (packet, sessionId) => {
  const shapes = {
    status: 'command,sessionId', stop: 'command,sessionId', snapshot: 'command,sessionId',
    click: 'command,ref,sessionId,snapshotId', fill: 'command,ref,sessionId,snapshotId,text',
    contextmenu: 'command,ref,sessionId,snapshotId',
    key: 'command,key,sessionId,snapshotId', scroll: 'command,deltaY,sessionId,snapshotId',
    'point-click': 'command,sessionId,snapshotId,x,y',
    'point-contextmenu': 'command,sessionId,snapshotId,x,y',
    'point-scroll': 'command,deltaY,sessionId,snapshotId,x,y',
  };
  if (!packet || packet.sessionId !== sessionId
    || Object.keys(packet).sort().join(',') !== shapes[packet.command]
    || (['click', 'contextmenu', 'fill', 'key', 'scroll', 'point-click', 'point-contextmenu', 'point-scroll'].includes(packet.command)
      && !UUID_PATTERN.test(packet.snapshotId || ''))
    || (['click', 'contextmenu', 'fill'].includes(packet.command) && !/^r(?:[1-9]|[1-9]\d|100)$/u.test(packet.ref || ''))
    || (packet.command === 'fill' && (typeof packet.text !== 'string' || packet.text.length < 1 || packet.text.length > 256))
    || (packet.command === 'key' && !['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown'].includes(packet.key))
    || (['scroll', 'point-scroll'].includes(packet.command)
      && (!Number.isInteger(packet.deltaY) || packet.deltaY === 0 || Math.abs(packet.deltaY) > 1500))
    || (['point-click', 'point-contextmenu', 'point-scroll'].includes(packet.command)
      && ![packet.x, packet.y].every((coordinate) => Number.isInteger(coordinate)
        && coordinate >= 0 && coordinate <= 8192))) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_CONTROL_REJECTED', 'The assisted-browser control request was rejected.');
  }
  return packet;
};

const assertAssistActionAllowed = ({ config, snapshot, packet, fingerprint, now = Date.now() }) => {
  if (!['read-only', 'manual-control'].includes(config.interactionMode)
    || (config.interactionMode === 'manual-control'
      && !config.mutationAuthorized && !['members', 'download'].includes(config.fallbackFor))) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_ACTION_NOT_AUTHORIZED', 'This Telegram Web operation cannot use in-session controls.');
  }
  if (['contextmenu', 'point-contextmenu'].includes(packet.command)
    && (config.interactionMode !== 'manual-control'
      || (!config.mutationAuthorized && config.fallbackFor !== 'download'))) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_ACTION_NOT_AUTHORIZED', 'Context menus require an authorized mutation or download.');
  }
  if (!snapshot || packet.snapshotId !== snapshot.id
    || now - snapshot.at > 120_000 || fingerprint !== snapshot.fingerprint) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_SNAPSHOT_STALE', 'Take a fresh Telegram Web snapshot before acting.');
  }
  if (['click', 'contextmenu', 'fill'].includes(packet.command) && !snapshot.refs.has(packet.ref)) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The requested control is absent from the current snapshot.');
  }
  if (config.interactionMode === 'read-only' && packet.command === 'key'
    && !['Escape', 'ArrowUp', 'ArrowDown'].includes(packet.key)) {
    throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'This key is not permitted in a read-only session.');
  }
  return snapshot;
};

const runAssistWorker = async () => {
  const config = readAssistWorkerConfig();
  const options = {
    companyId: config.companyId,
    memberId: config.memberId,
    connectionId: config.connectionId,
    chromeExecutable: config.browserExecutable,
    headed: true,
    holdMs: Math.max(5_000, config.expiresAt - Date.now()),
    timeoutMs: 60_000,
  };
  const file = assistSessionPath(options);
  let publicFailure = null;
  try {
    await withBrowser(options, async (page, readState) => {
      let stopReason = null;
      let blockedWindows = 0;
      let unexpectedNavigation = false;
      let uploadsHandled = 0;
      let uploadEvents = 0;
      let downloadEvents = 0;
      const downloads = [];
      const pendingTransfers = new Set();
      let interactionFailure = null;
      let stopSession;
      const stopped = new Promise((resolve) => {
        stopSession = resolve;
      });
      page.context().on("page", (candidate) => {
        if (candidate === page) return;
        blockedWindows += 1;
        void candidate.close().catch(() => undefined);
      });
      page.on("close", () => stopSession("window_closed"));
      const trackTransfer = (promise) => {
        pendingTransfers.add(promise);
        void promise.finally(() => pendingTransfers.delete(promise));
      };
      if (config.uploadPaths.length > 0) {
        page.on("filechooser", (chooser) => {
          uploadEvents += 1;
          const transfer = (uploadEvents > 1
            ? Promise.reject(new TelegramWebRuntimeError(
                "TELEGRAM_ASSIST_UPLOAD_REJECTED",
                "The assisted Telegram Web session requested files more than once for one authorized operation.",
              ))
            : chooser.setFiles(config.uploadPaths))
            .then(() => {
              uploadsHandled += 1;
            })
            .catch((error) => {
              interactionFailure = error instanceof TelegramWebRuntimeError
                ? error
                : new TelegramWebRuntimeError(
                    "TELEGRAM_ASSIST_UPLOAD_FAILED",
                    "The assisted Telegram Web window could not attach the exact authorized local files.",
                  );
              stopSession("interaction_failure");
            });
          trackTransfer(transfer);
        });
      }
      if (config.downloadOutput) {
        page.on("download", (download) => {
          downloadEvents += 1;
          const transfer = (async () => {
            if (downloadEvents > 1) {
              throw new TelegramWebRuntimeError(
                "TELEGRAM_ASSIST_DOWNLOAD_REJECTED",
                "The assisted Telegram Web session received more than one download for one authorized operation.",
              );
            }
            const suggestedName = path.basename(download.suggestedFilename());
            if (!suggestedName || suggestedName === "." || suggestedName === "..") {
              throw new TelegramWebRuntimeError(
                "TELEGRAM_ASSIST_DOWNLOAD_REJECTED",
                "The assisted Telegram Web download did not provide a safe file name.",
              );
            }
            const destination = fs.existsSync(config.downloadOutput)
              && fs.statSync(config.downloadOutput).isDirectory()
              ? path.join(config.downloadOutput, suggestedName)
              : config.downloadOutput;
            if (fs.existsSync(destination)) {
              throw new TelegramWebRuntimeError(
                "TELEGRAM_ASSIST_DOWNLOAD_REJECTED",
                `Refusing to overwrite existing download: ${destination}`,
              );
            }
            await download.saveAs(destination);
            if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
            const stat = fs.statSync(destination);
            downloads.push({
              path: destination,
              name: path.basename(destination),
              sizeBytes: stat.size,
              sha256: sha256File(destination),
            });
          })().catch((error) => {
            interactionFailure = error;
            stopSession("interaction_failure");
          });
          trackTransfer(transfer);
        });
      }
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        if (frame.url() === "about:blank") return;
        try {
          const url = new URL(frame.url());
          if (url.origin !== TELEGRAM_WEB_ORIGIN || url.pathname !== "/k/") {
            unexpectedNavigation = true;
            stopSession("unexpected_navigation");
          }
        } catch {
          if (frame.url() !== "about:blank") {
            unexpectedNavigation = true;
            stopSession("unexpected_navigation");
          }
        }
      });
      // Reuse the normal bounded SPA readiness window so a slow Windows login
      // surface is classified before native control is handed to the agent.
      await openHome(page, options);
      const gateMode = await page.evaluate(() => window.__trelioTelegramAssistState?.mode || null);
      if (gateMode !== config.interactionMode) {
        throw new TelegramWebRuntimeError(
          "TELEGRAM_ASSIST_GUARD_NOT_READY",
          "The Telegram Web assisted-browser interaction gate was not installed before provider inspection.",
        );
      }
      await page.bringToFront();
      const token = randomBytes(32).toString("hex");
      const screenshots = new Set();
      let assistSnapshot = null;
      let controlBusy = false;
      const assertAssistSurface = async () => {
        if (page.isClosed()) {
          throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_SESSION_UNAVAILABLE', 'The Telegram Web window is closed.');
        }
        const url = new URL(page.url());
        const mode = await page.evaluate(() => window.__trelioTelegramAssistState?.mode || null);
        if (url.origin !== TELEGRAM_WEB_ORIGIN || url.pathname !== '/k/' || mode !== config.interactionMode) {
          throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_GUARD_NOT_READY', 'The Telegram Web origin or interaction gate changed.');
        }
      };
      const observe = async () => {
        assertDocumentAvailable(page);
        await assertAssistSurface();
        const fingerprint = await assistPageDigest(page, config.mutationAuthorized);
        const controls = await collectAssistControls(page);
        const bytes = await page.screenshot({ type: 'png', fullPage: false,
          animations: 'disabled', scale: 'css' });
        if (bytes.length > 8 * 1024 * 1024
          || await assistPageDigest(page, config.mutationAuthorized) !== fingerprint) {
          bytes.fill(0);
          throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_SNAPSHOT_CHANGED', 'The Telegram Web page changed during its screenshot. Take a fresh snapshot.');
        }
        const directory = path.join(connectionRoot(options), 'state', 'assist-snapshots', config.sessionId);
        ensurePrivateDirectory(directory);
        const screenshotPath = path.join(directory, `${randomUUID()}.png`);
        try {
          for (const previous of screenshots) fs.rmSync(previous, { force: true });
          screenshots.clear();
          fs.writeFileSync(screenshotPath, bytes, { flag: 'wx', mode: 0o600 });
          screenshots.add(screenshotPath);
        } finally {
          bytes.fill(0);
        }
        assistSnapshot = { id: randomUUID(), at: Date.now(), fingerprint,
          refs: new Set(controls.map((control) => control.ref)),
          controls: new Map(controls.map((control) => [control.ref, control])) };
        return { ok: true, sessionId: config.sessionId, snapshotId: assistSnapshot.id,
          screenshotPath, controls, interactionMode: config.interactionMode,
          fallbackFor: config.fallbackFor, readState: telegramReadStateSummary(readState) };
      };
      const act = async (packet) => {
        assertDocumentAvailable(page);
        await assertAssistSurface();
        const snapshot = assertAssistActionAllowed({ config, snapshot: assistSnapshot, packet,
          fingerprint: await assistPageDigest(page, config.mutationAuthorized) });
        if (['point-click', 'point-contextmenu', 'point-scroll'].includes(packet.command)
          && !await inspectAssistPoint(page, packet, config.interactionMode, config.fallbackFor)) {
          throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The screenshot point is outside the authorized Telegram Web surface.');
        }
        let target = null;
        if (['click', 'contextmenu', 'fill'].includes(packet.command)) {
          target = page.locator(`[data-trelio-telegram-assist-ref="${packet.ref}"]`);
          if (await target.count() !== 1) {
            throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The requested Telegram Web control changed.');
          }
          const currentLabel = await target.evaluate((node) => String(node.getAttribute('aria-label')
            || node.getAttribute('title') || node.getAttribute('placeholder')
            || (node.matches('.chatlist-chat[data-peer-id]')
              ? node.querySelector('h3, [role="heading"]')?.textContent || node.getAttribute('data-peer-id')
              : node.innerText || node.textContent) || '').replace(/\s+/gu, ' ').trim().slice(0, 160));
          if (currentLabel !== snapshot.controls.get(packet.ref)?.label) {
            throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The control changed since the screenshot.');
          }
          const href = await target.evaluate((node) => node.closest('a[href]')?.href || null);
          if (href && !href.startsWith(`${TELEGRAM_WEB_ORIGIN}/k/`)) {
            throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The requested control leaves Telegram Web K.');
          }
          if (packet.command === 'fill' && !snapshot.controls.get(packet.ref)?.editable) {
            throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The requested control is not editable.');
          }
          if (config.interactionMode === 'read-only') {
            const box = snapshot.controls.get(packet.ref)?.box;
            if (!box || !await inspectAssistPoint(page, { command: packet.command,
              x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
            'read-only', config.fallbackFor)) {
              throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_TARGET_INVALID', 'The read-only session permits only chat navigation and search.');
            }
          }
        }
        // Consume before dispatch: a lost response cannot replay a send or
        // destructive click. The next action requires a new live observation.
        assistSnapshot = null;
        const blockedBefore = config.interactionMode === 'read-only'
          ? await page.evaluate(() => window.__trelioTelegramAssistState?.blockedActions || 0) : 0;
        try {
          if (packet.command === 'click') await target.click({ timeout: 3_000 });
          else if (packet.command === 'contextmenu') await target.click({ button: 'right', timeout: 3_000 });
          else if (packet.command === 'point-click') await page.mouse.click(packet.x, packet.y);
          else if (packet.command === 'point-contextmenu') await page.mouse.click(packet.x, packet.y, { button: 'right' });
          else if (packet.command === 'fill') await target.fill(packet.text, { timeout: 3_000 });
          else if (packet.command === 'key') await page.keyboard.press(packet.key);
          else if (packet.command === 'point-scroll') {
            await page.mouse.move(packet.x, packet.y);
            await page.mouse.wheel(0, packet.deltaY);
          } else await page.mouse.wheel(0, packet.deltaY);
          if (config.interactionMode === 'read-only') {
            const blockedAfter = await page.evaluate(() => window.__trelioTelegramAssistState?.blockedActions || 0);
            if (blockedAfter !== blockedBefore) {
              throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_ACTION_BLOCKED', 'The read-only gate blocked this action.');
            }
          }
        } catch (error) {
          if (error instanceof TelegramWebRuntimeError && error.code === 'TELEGRAM_ASSIST_ACTION_BLOCKED') throw error;
          throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_ACTION_AMBIGUOUS', 'The Telegram Web action has an unknown result. Inspect live state before another action.');
        }
        return { ok: true, sessionId: config.sessionId, action: packet.command,
          verification: 'Take a new screenshot and inspect the live result before continuing.' };
      };
      const status = async (phase = "active") => {
        const fingerprint = await safeUiFingerprint(page).catch(() => null);
        const gate = await page.evaluate(() => ({
          installed: Boolean(window.__trelioTelegramAssistState),
          mode: window.__trelioTelegramAssistState?.mode || null,
          blockedActions: Number(window.__trelioTelegramAssistState?.blockedActions || 0),
        })).catch(() => ({ installed: false, mode: null, blockedActions: 0 }));
        const instructions = config.interactionMode === "read-only"
          ? [
              "Use this exact Telegram Web window or bounded in-session snapshot and controls; read-only forbids context menus.",
              "This recovery surface is read-only: search and exact chat navigation are allowed; composer input and mutations are blocked.",
              "Call assist-stop for this exact session in a finally-style cleanup after inspection.",
            ]
          : [
              "Use this exact Telegram Web window or assist-snapshot/click/contextmenu/fill/key/scroll/point-click/point-contextmenu/point-scroll; do not attach another tab.",
              `Perform only the exact authorized ${config.fallbackFor} operation and do not inspect unrelated chats.`,
              "Verify the live result before reporting success; an ambiguous mutation must not be retried automatically.",
              "Call assist-stop for this exact session in a finally-style cleanup after verification.",
            ];
        return {
          ok: true,
          ...publicAssistStatus({
            ...config,
            phase,
            appName: assistAppName(options.chromeExecutable),
          }),
          fingerprint,
          interactionGate: gate,
          blockedWindows,
          unexpectedNavigation,
          uploadsHandled,
          transfersPending: pendingTransfers.size,
          downloads,
          readState: telegramReadStateSummary(readState),
          instructions,
        };
      };
      const server = http.createServer(async (request, response) => {
        const send = (code, value) => {
          response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify(value));
        };
        try {
          if (request.socket.remoteAddress !== "127.0.0.1"
            || request.socket.localAddress !== "127.0.0.1"
            || request.headers.host !== `127.0.0.1:${server.address().port}`
            || request.headers.origin
            || request.headers.authorization !== `Bearer ${token}`
            || request.method !== "POST"
            || request.url !== "/") {
            throw new TelegramWebRuntimeError("TELEGRAM_ASSIST_CONTROL_REJECTED", "The assisted-browser control request was rejected.");
          }
          const packet = await readBoundedAssistBody(request);
          validateAssistControlPacket(packet, config.sessionId);
          if (packet.command === "status") {
            send(200, await status());
            return;
          }
          if (packet.command === 'snapshot'
            || ['click', 'contextmenu', 'fill', 'key', 'scroll', 'point-click', 'point-contextmenu', 'point-scroll'].includes(packet.command)) {
            if (controlBusy) throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_CONTROL_BUSY', 'Another action is active in this session.');
            controlBusy = true;
            try {
              send(200, packet.command === 'snapshot' ? await observe() : await act(packet));
            } finally {
              controlBusy = false;
            }
            return;
          }
          if (controlBusy) {
            throw new TelegramWebRuntimeError('TELEGRAM_ASSIST_CONTROL_BUSY', 'Wait for the active Telegram Web action before stopping its session.');
          }
          if (pendingTransfers.size > 0) {
            throw new TelegramWebRuntimeError(
              "TELEGRAM_ASSIST_TRANSFER_PENDING",
              "The exact authorized file transfer is still in progress. Check status before stopping the session.",
            );
          }
          send(200, await status("closing"));
          stopSession("requested");
        } catch (error) {
          send(403, runtimeErrorPayload(error));
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      writePrivateJson(file, {
        schemaVersion: 1,
        sessionId: config.sessionId,
        phase: "ready",
        fallbackFor: config.fallbackFor,
        interactionMode: config.interactionMode,
        mutationAuthorized: config.mutationAuthorized,
        authorizationHash: config.authorizationHash,
        expiresAt: config.expiresAt,
        pid: process.pid,
        port: server.address().port,
        token,
        appName: assistAppName(options.chromeExecutable),
      });
      const timer = setTimeout(() => stopSession("expired"), Math.max(1, config.expiresAt - Date.now()));
      try {
        stopReason = await stopped;
      } finally {
        clearTimeout(timer);
        if (pendingTransfers.size > 0) await Promise.allSettled([...pendingTransfers]);
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(path.join(connectionRoot(options), 'state', 'assist-snapshots', config.sessionId),
          { recursive: true, force: true });
      }
      if (interactionFailure) throw interactionFailure;
      if (stopReason === "unexpected_navigation") {
        throw new TelegramWebRuntimeError(
          "TELEGRAM_ASSIST_UNEXPECTED_NAVIGATION",
          "The assisted Telegram Web window left the allowed provider origin and was closed.",
        );
      }
    }, {
      assistGate: { mode: config.interactionMode, fallbackFor: config.fallbackFor },
      acceptDownloads: Boolean(config.downloadOutput),
    });
  } catch (error) {
    publicFailure = runtimeErrorPayload(error);
  } finally {
    if (publicFailure) {
      writePrivateJson(file, {
        schemaVersion: 1,
        sessionId: config.sessionId,
        phase: "failed",
        fallbackFor: config.fallbackFor,
        interactionMode: config.interactionMode,
        mutationAuthorized: config.mutationAuthorized,
        authorizationHash: config.authorizationHash,
        expiresAt: config.expiresAt,
        pid: process.pid,
        port: null,
        token: null,
        appName: assistAppName(options.chromeExecutable),
        error: publicFailure.code || "TELEGRAM_ASSIST_WORKER_FAILED",
        message: publicFailure.error,
      });
    } else {
      removeAssistSessionIfExact(options, config.sessionId);
    }
  }
};

const waitForLoginHandoff = async (page, holdMs) => {
  // `login` must not claim that it detected authentication: the durable proof
  // belongs to a new browser process started by the following `probe`. Closing
  // this window is only an owner signal that credential entry has finished.
  if (typeof page.isClosed === "function" && page.isClosed()) return "window_closed";

  let holdTimer = null;
  // The handoff may legitimately last longer than Playwright's ordinary page
  // timeout. `holdMs` is the only clock for this wait, so disable the implicit
  // event timeout and keep the result deterministic for slower sign-ins.
  const windowClosed = page.waitForEvent("close", { timeout: 0 })
    .then(() => "window_closed")
    .catch((error) => {
      // A close can race with waitForEvent registration. Normalize only an
      // actually closed page; unrelated provider/runtime failures stay errors.
      if (typeof page.isClosed === "function" && page.isClosed()) return "window_closed";
      throw error;
    });
  const holdExpired = new Promise((resolve) => {
    holdTimer = setTimeout(() => resolve("hold_expired"), holdMs);
  });

  try {
    return await Promise.race([windowClosed, holdExpired]);
  } finally {
    if (holdTimer !== null) clearTimeout(holdTimer);
  }
};

const safeUiFingerprint = async (page) => page.evaluate(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width >= 1
      && rect.height >= 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const count = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
  const authVisible = count("#auth-pages, .auth-pages") > 0;
  const peerHash = window.location.hash.replace(/^#/u, "");
  return {
    pageKind: authVisible ? "auth" : /^-?[1-9]\d*$/u.test(peerHash) ? "chat" : "home",
    visibleDialogRows: count('.chatlist-chat[data-peer-id]'),
    visibleComposers: count('.chat-input .input-message-input[contenteditable="true"]'),
    visibleInputs: count('input:not([type="hidden"])'),
    visibleTextareas: count("textarea"),
    visibleEditables: count('[contenteditable="true"]'),
    visibleButtons: count('button, [role="button"]'),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
});

const telegramReadStateSummary = (readState) => ({ ...readState });

const sendOpenChat = async (page, options) => {
  const message = outgoingMessage(options);
  await uploadFiles(page, options.files, options.timeoutMs);
  const composer = message ? await findComposer(page) : null;
  if (message) await fillLocator(composer, message, page);
  const method = await sendCurrentComposer(page, options.timeoutMs, Boolean(message));
  await page.waitForTimeout(1_200);
  const textVerification = message
    ? await verifyTextSend(page, composer, message, options.timeoutMs)
    : null;
  const verifiedAttachments = await verifyAttachmentSend(page, options.files, options.timeoutMs);
  return { method, textVerification, verifiedAttachments };
};

const ordinaryReadMarkAfterVerifiedReply = () => ({
  attempted: false,
  status: "ordinary-telegram-web-read-state",
  note: "No extra read-state mutation was added after the verified send.",
});

const readChatMessages = async (page, options) => {
  const opened = await openChat(page, options);
  const loadedPages = await loadHistoryPages(page, options.pages, options.timeoutMs);
  return {
    opened,
    loadedPages,
    messages: await visibleMessages(page, options.limit),
  };
};

const readUnreadDialogs = async (page, options) => {
  await openHome(page, options);
  const unreadDialogs = (await collectDialogResults(page, "", true)).slice(0, options.limit);
  const chats = [];
  for (const dialog of unreadDialogs) {
    const nestedOptions = { ...options, chat: dialog.url || dialog.title };
    try {
      chats.push({
        dialog,
        ...(await readChatMessages(page, nestedOptions)),
      });
    } catch (error) {
      chats.push({
        dialog,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { unreadDialogs: chats };
};

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const downloadSelectedAttachment = async (page, options) => {
  await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  const attachments = target.locator.locator(
    'a[download], button[aria-label*="скач" i], button[aria-label*="download" i], [role="button"][aria-label*="скач" i], [role="button"][aria-label*="download" i]',
  );
  const count = await attachments.count();
  if (options.attachmentIndex > count) {
    throw new Error(
      `Telegram Web message exposes ${count} downloadable attachment(s); requested index ${options.attachmentIndex}.`,
    );
  }
  const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs });
  await attachments.nth(options.attachmentIndex - 1).click({ timeout: options.timeoutMs });
  const download = await downloadPromise;
  const suggestedName = download.suggestedFilename();
  const destination = fs.existsSync(options.output) && fs.statSync(options.output).isDirectory()
    ? path.join(options.output, suggestedName)
    : options.output;
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing download: ${destination}`);
  }
  ensureOutputParentDirectory(path.dirname(destination));
  await download.saveAs(destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  const stat = fs.statSync(destination);
  return {
    downloaded: true,
    path: destination,
    name: path.basename(destination),
    sizeBytes: stat.size,
    sha256: sha256File(destination),
    sourceMessage: target.message,
  };
};

const replyToMessage = async (page, options, readState) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /ответить|reply/iu, options.timeoutMs);
  const dispatched = await sendOpenChat(page, options);
  const readMark = await ordinaryReadMarkAfterVerifiedReply(page, options, readState);
  return {
    replied: true,
    opened,
    target: target.message,
    policyMode,
    ...dispatched,
    readMark,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const editMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options, { outgoingOnly: true });
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /редактировать|edit/iu, options.timeoutMs);
  const composer = await findComposer(page);
  const message = outgoingMessage(options);
  await fillLocator(composer, message, page);
  const method = await sendCurrentComposer(page, options.timeoutMs, true);
  const verification = await verifyTextSend(page, composer, message, options.timeoutMs);
  return {
    edited: true,
    opened,
    target: target.message,
    policyMode,
    method,
    verification,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const deleteMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options, { outgoingOnly: true });
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /удалить(?: сообщение)?|delete(?: message)?/iu, options.timeoutMs);
  const confirmed = await confirmVisibleDialogAction(page, /удалить|delete/iu, options.timeoutMs);
  if (!confirmed && await target.locator.count()) {
    throw new Error("Telegram Web did not show a scoped delete confirmation and the target is still present.");
  }
  await target.locator.waitFor({ state: "detached", timeout: Math.min(options.timeoutMs, 15_000) }).catch(() => {
    throw new Error("Telegram Web delete result is ambiguous: the exact message is still present. Do not retry automatically.");
  });
  return {
    deleted: true,
    opened,
    target: target.message,
    policyMode,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const reactToMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await target.locator.hover({ timeout: options.timeoutMs });
  const reactionButton = target.locator.getByRole("button", { name: /реакц|react/iu }).last();
  if (await reactionButton.count() && await reactionButton.isVisible({ timeout: 700 }).catch(() => false)) {
    await reactionButton.click({ timeout: options.timeoutMs });
  } else {
    await openMessageActionMenu(page, target.locator, options.timeoutMs);
    await clickVisibleAction(page, /реакц|react/iu, options.timeoutMs);
  }
  await clickVisibleAction(page, options.reaction, options.timeoutMs, { exact: true });
  await target.locator.getByText(options.reaction, { exact: true }).last().waitFor({
    state: "visible",
    timeout: Math.min(options.timeoutMs, 10_000),
  }).catch(() => {
    throw new Error("Telegram Web reaction result is ambiguous. Do not retry automatically.");
  });
  return {
    reacted: true,
    reaction: options.reaction,
    opened,
    target: target.message,
    policyMode,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const forwardMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  await clickVisibleAction(page, /переслать|forward/iu, options.timeoutMs);
  const destination = await chooseExactPickerEntry(page, options.toChat, options.timeoutMs);
  await clickVisibleAction(page, /отправить|send/iu, options.timeoutMs);
  await page.waitForTimeout(1_200);
  return {
    forwarded: true,
    opened,
    target: target.message,
    destination,
    policyMode,
    verification: "Telegram Web accepted the exact destination and closed the send action.",
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const openChatDetails = async (page, options) => {
  const title = /^https?:\/\//iu.test(options.chat) || /^-?\d+$/u.test(options.chat)
    ? null
    : options.chat;
  const candidates = [
    title ? page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu") }).last() : null,
    page.locator('[data-testid*="chat-header" i] button, [class*="chat-header" i] button, header button').last(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (await candidate.count() && await candidate.isVisible({ timeout: 700 })) {
        await candidate.click({ timeout: options.timeoutMs });
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // Try the geometry fallback below.
    }
  }
  const selected = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width >= 80
          && rect.height >= 24
          && rect.x > window.innerWidth * 0.28
          && rect.y < 180
          && style.display !== "none"
          && style.visibility !== "hidden";
      });
    if (candidates.length !== 1) return false;
    candidates[0].setAttribute("data-trelio-telegram-chat-header", "true");
    return true;
  });
  if (!selected) throw new Error("Could not safely identify the Telegram Web chat header/details action.");
  await page.locator('[data-trelio-telegram-chat-header="true"]').click({ timeout: options.timeoutMs });
  await page.waitForTimeout(800);
};

const collectVisibleMembers = (page) => page.evaluate(() => {
  document.querySelectorAll("[data-trelio-telegram-member]").forEach((node) => {
    node.removeAttribute("data-trelio-telegram-member");
  });
  const rows = Array.from(document.querySelectorAll(
    '[data-peer-id] .peer-title, [data-testid*="member" i], [class*="participant" i], [class*="member" i], [role="listitem"]',
  ));
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    const style = window.getComputedStyle(row);
    if (rect.width < 40 || rect.height < 16 || style.display === "none" || style.visibility === "hidden") continue;
    const text = (row.innerText || row.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 500) continue;
    const link = row.matches("a[href]") ? row : row.querySelector("a[href]");
    const href = link instanceof HTMLAnchorElement ? link.href : null;
    const stableId = row.getAttribute("data-peer-id")
      || row.closest("[data-peer-id]")?.getAttribute("data-peer-id")
      || text.match(/@([A-Za-z0-9_.-]+)/u)?.[1]
      || null;
    const key = stableId?.toLowerCase() || text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    row.setAttribute("data-trelio-telegram-member", String(result.length));
    result.push({ index: result.length, title: text, text, url: href, stableId });
  }
  return result;
});

const listChatMembers = async (page, options) => {
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  return { opened, members: await collectVisibleMembers(page) };
};

const createDirectChat = async (page, options, readState) => {
  const policyMode = assertMutationAllowed(options);
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, normalizeContactReference(options.contact), page);
  await page.waitForTimeout(1_800);
  const contact = selectExactContactResult(
    await collectDialogResults(page, normalizeContactReference(options.contact)),
    options.contact,
  );
  await page.locator(`[data-trelio-telegram-dialog="${contact.index}"]`).click({
    timeout: options.timeoutMs,
  });
  await findComposer(page);
  const dispatched = await sendOpenChat(page, options);
  const readMark = await ordinaryReadMarkAfterVerifiedReply(page, options, readState);
  return {
    created: true,
    kind: "direct",
    contact,
    policyMode,
    ...dispatched,
    readMark,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const openCreateGroupFlow = async (page, options) => {
  await openHome(page, options);
  const explicit = page.getByRole("button", { name: /новый чат|создать чат|new chat|create chat/iu }).last();
  if (await explicit.count() && await explicit.isVisible({ timeout: 700 }).catch(() => false)) {
    await explicit.click({ timeout: options.timeoutMs });
  } else {
    const plus = page.locator(
      'button[aria-label*="созд" i], button[aria-label*="добав" i], button[aria-label="+"], [role="button"][aria-label="+"]',
    ).first();
    if (!await plus.count() || !await plus.isVisible({ timeout: 700 }).catch(() => false)) {
      throw new Error("Could not safely identify the Telegram Web new-chat action.");
    }
    await plus.click({ timeout: options.timeoutMs });
  }
  await clickVisibleAction(page, /создать групповой чат|create group chat/iu, options.timeoutMs);
};

const fillGroupTitleAndAvatar = async (page, options) => {
  const titleCandidates = [
    page.getByLabel(/название|title/iu).last(),
    page.getByPlaceholder(/название|title/iu).last(),
    page.getByRole("textbox").last(),
  ];
  let titleInput = null;
  for (const candidate of titleCandidates) {
    if (await candidate.count() && await candidate.isVisible({ timeout: 700 }).catch(() => false)) {
      titleInput = candidate;
      break;
    }
  }
  if (!titleInput) throw new Error("Could not safely identify the Telegram Web group title field.");
  await fillLocator(titleInput, options.title, page);
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("Telegram Web group avatar upload is unavailable in the current UI.");
    await upload.setInputFiles(options.avatar, { timeout: options.timeoutMs });
  }
};

const findExistingGroupCandidate = async (page, options) => {
  await openHome(page, options);
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, options.title, page);
  await page.waitForTimeout(1_200);
  const results = await collectDialogResults(page, options.title);
  const exact = results.filter((result) => normalizeDialogTitle(result.title) === normalizeDialogTitle(options.title));
  if (exact.length === 0) return null;
  if (exact.length > 1) {
    throw new Error(
      "Several Telegram Web chats already use this exact title. Use a unique title before creating another group.",
    );
  }
  return exact[0];
};

const verifyExistingGroupMembers = async (page, options, candidate) => {
  const nestedOptions = { ...options, chat: candidate.url || candidate.title };
  const current = await listChatMembers(page, nestedOptions);
  const missing = options.members.filter((reference) => {
    try {
      selectExactContactResult(current.members, reference);
      return false;
    } catch {
      return true;
    }
  });
  return { current, missing };
};

const createGroupChat = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const existing = await findExistingGroupCandidate(page, options);
  if (existing) {
    const verification = await verifyExistingGroupMembers(page, options, existing);
    if (verification.missing.length === 0) {
      return {
        created: false,
        alreadyExists: true,
        recoveredIdempotently: true,
        kind: "group",
        title: options.title,
        url: existing.url,
        members: verification.current.members,
        policyMode,
      };
    }
    throw new Error(
      `A Telegram Web chat named ${options.title} already exists but is missing requested members: ${verification.missing.join(", ")}. Use a unique title.`,
    );
  }
  await openCreateGroupFlow(page, options);
  const selectedMembers = [];
  for (const member of options.members) {
    selectedMembers.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
  }
  await clickVisibleAction(page, /продолжить|continue|далее|next/iu, options.timeoutMs);
  await fillGroupTitleAndAvatar(page, options);
  await clickVisibleAction(page, /создать чат|create chat/iu, options.timeoutMs);
  await page.waitForTimeout(1_500);
  const titleVisible = await page.getByText(options.title, { exact: true }).last().isVisible({ timeout: 2_000 })
    .catch(() => false);
  if (!titleVisible) {
    const recovered = await findExistingGroupCandidate(page, options).catch(() => null);
    if (recovered) {
      const verification = await verifyExistingGroupMembers(page, options, recovered).catch(() => null);
      if (verification && verification.missing.length === 0) {
        return {
          created: true,
          recoveredAfterAmbiguousResponse: true,
          kind: "group",
          title: options.title,
          members: verification.current.members,
          url: recovered.url,
          policyMode,
          retryPolicy: "Creation was verified by exact title and participant set; do not repeat it.",
        };
      }
    }
    throw new Error("Telegram Web group creation result is ambiguous and exact live verification failed. Do not retry automatically.");
  }
  return {
    created: true,
    kind: "group",
    title: options.title,
    members: selectedMembers,
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    url: page.url(),
    policyMode,
    retryPolicy: "Search and verify the exact title and participant set before retrying an ambiguous creation.",
  };
};

const mutateMembers = async (page, options, remove) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  const changed = [];
  if (!remove) {
    await clickVisibleAction(page, /добавить участников|add (?:participants|members)/iu, options.timeoutMs);
    for (const member of options.members) {
      changed.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
    }
    await clickVisibleAction(page, /добавить|add/iu, options.timeoutMs);
  } else {
    for (const member of options.members) {
      const current = await collectVisibleMembers(page);
      const selected = selectExactContactResult(current, member);
      const row = page.locator(`[data-trelio-telegram-member="${selected.index}"]`);
      await row.click({ timeout: options.timeoutMs });
      await clickVisibleAction(page, /удалить участника|remove (?:participant|member)/iu, options.timeoutMs);
      const confirmed = await confirmVisibleDialogAction(page, /удалить|remove/iu, options.timeoutMs);
      if (!confirmed) throw new Error("Telegram Web did not show the expected scoped member-removal confirmation.");
      changed.push(selected);
    }
  }
  await page.waitForTimeout(1_000);
  return {
    changed: true,
    operation: remove ? "remove" : "add",
    opened,
    members: changed,
    policyMode,
    retryPolicy: "Do not repeat an ambiguous member mutation before rereading the live member list.",
  };
};

const updateChat = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  await clickVisibleAction(page, /редактировать чат|edit chat/iu, options.timeoutMs);
  if (options.title) {
    const title = page.getByLabel(/название|title/iu).last();
    const fallback = page.getByRole("textbox").last();
    const input = await title.count() && await title.isVisible({ timeout: 700 }).catch(() => false) ? title : fallback;
    if (!await input.count()) throw new Error("Could not safely identify the Telegram Web chat title field.");
    await fillLocator(input, options.title, page);
  }
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("Telegram Web chat avatar upload is unavailable in the current UI.");
    await upload.setInputFiles(options.avatar, { timeout: options.timeoutMs });
  }
  await clickVisibleAction(page, /сохранить|save/iu, options.timeoutMs);
  await page.waitForTimeout(1_000);
  if (options.title) {
    const visible = await page.getByText(options.title, { exact: true }).last().isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (!visible) throw new Error("Telegram Web chat update result is ambiguous. Reread chat details before retrying.");
  }
  return {
    updated: true,
    opened,
    title: options.title || null,
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    policyMode,
    retryPolicy: "Reread live chat details before retrying an ambiguous update.",
  };
};

const runValidatedBrowserCommand = async (options) => withBrowser(options, async (page, readState) => {
  if (options.command === "login") {
    await openHome(page, options, true);
    const handoffStartedAt = Date.now();
    const handoffCompletion = await waitForLoginHandoff(page, options.holdMs);
    return {
      opened: true,
      profile: profilePath(options),
      handoffCompletion,
      heldMs: Math.max(0, Date.now() - handoffStartedAt),
      holdLimitMs: options.holdMs,
      sessionVerified: false,
      nextAction: "Run one fresh probe. Do not repeat login before that probe.",
    };
  }
  if (options.command === "probe") {
    await openHome(page, options);
    // A generic interactive shell is not enough to prove an authenticated
    // session. The home dialog search is the bounded structural proof used by
    // this adapter; selector drift must fail closed instead of returning a
    // contradictory `authenticated: true, searchReady: false` result.
    await findSearchInput(page, options.timeoutMs);
    return {
      adapterVersion: ADAPTER_VERSION,
      authenticated: true,
      searchReady: true,
      fingerprint: await safeUiFingerprint(page),
      readState: telegramReadStateSummary(readState),
      diagnosticPolicy: "No chat text, message text, cookies or credentials are included.",
    };
  }
  if (options.command === "dialogs") {
    await openHome(page, options);
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    return {
      query: options.query,
      dialogs: await collectDialogResults(page, options.query),
      readState: telegramReadStateSummary(readState),
    };
  }
  if (options.command === "contacts") {
    await openHome(page, options);
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    const results = await collectDialogResults(page, options.query);
    return {
      query: options.query,
      contacts: results.filter((result) => result.stableId || /@[A-Za-z0-9_.-]+/u.test(result.text)),
      readState: telegramReadStateSummary(readState),
    };
  }
  if (options.command === "search") {
    return {
      ...(await searchGlobalMessages(page, options)),
      readState: telegramReadStateSummary(readState),
      note: options.context
        ? "Context expansion opens every matched chat and may mark its visible messages as read under ordinary Telegram Web semantics."
        : "Search-result snippets are inspected without opening their chats; restoring Telegram Web home can still preserve ordinary provider read state.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "read") {
    return {
      ...(await readChatMessages(page, options)),
      readState: telegramReadStateSummary(readState),
      note: "Loaded Telegram Web messages are returned with bounded structured metadata; opening the dialog may mark visible messages as read.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "unread") {
    return {
      ...(await readUnreadDialogs(page, options)),
      readState: telegramReadStateSummary(readState),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "watch") {
    const snapshots = [];
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      snapshots.push({
        observedAt: new Date().toISOString(),
        ...(await readUnreadDialogs(page, options)),
      });
      if (iteration + 1 < options.iterations) {
        await waitFor(options.intervalMs);
        await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs }).catch(() => undefined);
      }
    }
    return {
      snapshots,
      readState: telegramReadStateSummary(readState),
      schedulingNote: "Use the host scheduler for durable background monitoring; this command is intentionally bounded.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "download") {
    return {
      ...(await downloadSelectedAttachment(page, options)),
      readState: telegramReadStateSummary(readState),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "send") {
    const policyMode = assertMutationAllowed(options);
    const opened = await openChat(page, options);
    const dispatched = await sendOpenChat(page, options);
    const readMark = await ordinaryReadMarkAfterVerifiedReply(page, options, readState);
    return {
      sent: true,
      opened,
      policyMode,
      ...dispatched,
      readMark,
      readState: telegramReadStateSummary(readState),
      retryPolicy: "Do not retry automatically after an ambiguous failure.",
    };
  }
  if (options.command === "reply") {
    return {
      ...(await replyToMessage(page, options, readState)),
      readState: telegramReadStateSummary(readState),
    };
  }
  if (options.command === "edit") {
    return { ...(await editMessage(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "delete") {
    return { ...(await deleteMessage(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "react") {
    return { ...(await reactToMessage(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "forward") {
    return { ...(await forwardMessage(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "create-direct") {
    return {
      ...(await createDirectChat(page, options, readState)),
      readState: telegramReadStateSummary(readState),
    };
  }
  if (options.command === "create-group") {
    return { ...(await createGroupChat(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "members") {
    return { ...(await listChatMembers(page, options)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "member-add") {
    return { ...(await mutateMembers(page, options, false)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "member-remove") {
    return { ...(await mutateMembers(page, options, true)), readState: telegramReadStateSummary(readState) };
  }
  if (options.command === "chat-update") {
    return { ...(await updateChat(page, options)), readState: telegramReadStateSummary(readState) };
  }
  throw new Error(`Unsupported Telegram Web browser command: ${options.command}`);
});

const runBrowserCommand = async (options) => {
  // Validate the complete command before taking the profile lock or launching
  // Chrome. Besides producing faster errors, this guarantees that the login
  // visibility contract is enforced without an accidental headless launch.
  validateCommandOptions(options);
  return runValidatedBrowserCommand(options);
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "bootstrap") {
    output({ ok: true, ...(await bootstrapBrowserSession()) });
    return;
  }
  if (options.command === "doctor") {
    const runtime = await browserSessionRuntime();
    const browserRuntime = runtime.inspectBrowserRuntime();
    const chromeExecutable = options.chromeExecutable || runtime.defaultBrowserExecutable();
    output({
      ok: true,
      ...browserRuntime,
      chromeExecutable,
      chromeExists: fs.existsSync(chromeExecutable),
      profilePresent: fs.existsSync(profilePath(options)),
      policy: loadPolicy(options),
      localRoot: connectionRoot(options),
      securityBoundary: "chat-only",
      adapterVersion: ADAPTER_VERSION,
    });
    return;
  }
  if (options.command === "policy") {
    if (options.policyCommand === "set") {
      if (!POLICY_MODES.has(options.sendMode)) throw new Error("--send-mode is invalid.");
      writePrivateJson(policyPath(options), { sendMode: options.sendMode });
    } else if (options.policyCommand !== "show") {
      throw new Error("policy requires show or set.");
    }
    output({ ok: true, policy: loadPolicy(options), path: policyPath(options) });
    return;
  }
  if (options.command === "assist-start") {
    output({ ok: true, ...(await startAssistSession(options)) });
    return;
  }
  if (options.command === "assist-status") {
    output({ ok: true, ...(await statusAssistSession(options)) });
    return;
  }
  if (["assist-snapshot", "assist-click", "assist-contextmenu", "assist-fill", "assist-key", "assist-scroll", "assist-point-click", "assist-point-contextmenu", "assist-point-scroll"].includes(options.command)) {
    output({ ok: true, ...(await interactWithAssistSession(options)) });
    return;
  }
  if (options.command === "assist-stop") {
    output({ ok: true, ...(await stopAssistSession(options)) });
    return;
  }
  if (options.dryRun) {
    output({ ok: true, ...buildMutationPreview(options) });
    return;
  }
  output({ ok: true, ...(await runBrowserCommand(options)) });
};

export {
  ADAPTER_VERSION,
  TelegramWebRuntimeError,
  assertMutationAllowed,
  assistInteractionAllowed,
  assertAssistActionAllowed,
  assistPageDigest,
  collectAssistControls,
  inspectAssistPoint,
  installTelegramAssistGate,
  prepareAssistAuthorization,
  requestAssistControl,
  validateAssistControlPacket,
  assertSendAllowed,
  buildGlobalSearchCoverage,
  buildMutationPreview,
  connectionRoot,
  createReadState,
  decodeGlobalSearchCursor,
  encodeGlobalSearchCursor,
  loadPolicy,
  normalizeGlobalSearchQuery,
  normalizeGlobalSearchRows,
  normalizeDialogTitle,
  normalizeContactReference,
  openHome,
  installDocumentHttpObserver,
  assertDocumentAvailable,
  parseArguments,
  policyPath,
  runtimeErrorPayload,
  selectContextWindow,
  selectExactDialogResult,
  selectExactContactResult,
  usage,
  waitForLoginHandoff,
  writePrivateJson,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  (process.argv[2] === "__assist-worker" ? runAssistWorker() : main()).catch((error) => {
    output(runtimeErrorPayload(error));
    process.exitCode = 2;
  });
}
