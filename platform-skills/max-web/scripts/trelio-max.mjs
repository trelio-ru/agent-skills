#!/usr/bin/env node

/**
 * Local MAX web runtime for the Trelio skill catalog.
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

const SKILL_ID = "max-web";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const MAX_WEB_URL = "https://web.max.ru/";
const MAX_WEB_ORIGIN = new URL(MAX_WEB_URL).origin;
const MAX_FAVORITES_URL = new URL("0", MAX_WEB_URL).toString();
let browserSessionRuntimePromise = null;
const browserSessionRuntime = () => {
  const moduleUrl = String(process.env.TRELIO_BROWSER_SESSION_MODULE_URL || "");
  if (!moduleUrl.startsWith("file:")) {
    throw new Error("MAX requires the host browser-session runtime.");
  }
  browserSessionRuntimePromise ||= import(moduleUrl);
  return browserSessionRuntimePromise;
};
// HTTP status is checked before DOM/login classification. The shared host
// observes only the current main document; provider authority stays here.
const documentObservers = new WeakMap();
const installDocumentHttpObserver = (context, runtime) => {
  documentObservers.set(context, runtime.createDocumentHttpObserver(context, {
    isAllowedUrl: value => new URL(value).origin === MAX_WEB_ORIGIN,
  }));
};
const assertDocumentAvailable = (page) => {
  const failure = typeof page.context === "function" && documentObservers.get(page.context())?.failure(page);
  if (failure) throw new MaxRuntimeError("MAX_SERVICE_HTTP_ERROR", "MAX returned an HTTP error.", failure);
};
const POLICY_MODES = new Set(["confirm", "read-only"]);
const ADAPTER_VERSION = "45";
const MEMBER_REMOVE_ACTION = /(?:удалить|исключить|убрать)\s+(?:участника|из\s+(?:чата|группы|беседы))|(?:remove|kick)\s+(?:participant|member|from\s+(?:chat|group))/iu;
const MAX_UI_READY_TIMEOUT_MS = 10_000;
// A cold worker must launch Chrome, hydrate home and then resolve the exact
// contact. One ordinary UI deadline cannot cover those sequential steps.
const MAX_ASSIST_START_TIMEOUT_MS = 45_000;
const MAX_ASSIST_HOLD_MS = 1_800_000;
const MAX_HISTORY_PAGES = 20;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_GROUP_MEMBERS_PER_OPERATION = 100;
const MAX_WATCH_ITERATIONS = 60;
const MAX_WATCH_INTERVAL_MS = 300_000;
const PASSIVE_READ_PROTOCOL_MARKERS = ["READ_MESSAGE", "READ_REACTION"];
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
const ASSIST_READ_ONLY_COMMANDS = new Set([
  "contacts",
  "dialogs",
  "profile",
  "probe",
  "read",
  "unread",
  "watch",
]);
const ASSIST_MANUAL_CONTROL_COMMANDS = new Set([
  "chat-update",
  "create-direct",
  "create-group",
  "delete",
  "download",
  "edit",
  "forward",
  "member-add",
  "member-remove",
  "members",
  "react",
  "reply",
  "send",
]);
const ASSIST_COMMANDS = new Set([
  ...ASSIST_READ_ONLY_COMMANDS,
  ...ASSIST_MANUAL_CONTROL_COMMANDS,
]);
const ASSIST_MESSAGE_TARGET_COMMANDS = new Set([
  "delete", "download", "edit", "forward", "react", "reply",
]);
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
  "profile",
  "react",
  "read",
  "reply",
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

class MaxRuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "MaxRuntimeError";
    this.code = code;
    this.details = details;
  }
}

const environmentValue = (environment, name) => {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  if (process.platform !== "win32") return undefined;
  const matched = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
  return matched ? environment[matched] : undefined;
};

const requireRuntimeIdentity = (environment = process.env) => {
  // Identity is authenticated and injected by the generic package host after
  // live release resolution. Keeping it out of provider arguments prevents a
  // model-authored command from selecting another member's local namespace.
  const identity = {
    skillId: String(environmentValue(environment, "TRELIO_SKILL_ID") || ""),
    runtimeVersion: String(
      environmentValue(environment, "TRELIO_SKILL_RUNTIME_VERSION") || "",
    ),
    companyId: String(
      environmentValue(environment, "TRELIO_SKILL_COMPANY_ID") || "",
    ).toLowerCase(),
    memberId: String(
      environmentValue(environment, "TRELIO_SKILL_MEMBER_ID") || "",
    ).toLowerCase(),
    connectionId: String(
      environmentValue(environment, "TRELIO_SKILL_CONNECTION_ID") || "",
    ).toLowerCase(),
  };
  if (identity.skillId !== SKILL_ID) {
    throw new MaxRuntimeError(
      "MAX_INVALID_IDENTITY",
      `Runtime must be resolved for ${SKILL_ID}.`,
    );
  }
  if (!VERSION_PATTERN.test(identity.runtimeVersion)) {
    throw new MaxRuntimeError(
      "MAX_INVALID_IDENTITY",
      "TRELIO_SKILL_RUNTIME_VERSION is missing or invalid.",
    );
  }
  for (const key of ["companyId", "memberId", "connectionId"]) {
    if (!UUID_PATTERN.test(identity[key])) {
      throw new MaxRuntimeError(
        "MAX_INVALID_IDENTITY",
        `Trusted ${key} is missing or invalid.`,
      );
    }
  }
  return identity;
};

const runtimeErrorPayload = (error) => {
  const normalized = normalizeMaxRuntimeError(error);
  const payload = {
    ok: false,
    error: normalized instanceof Error ? normalized.message : String(normalized),
  };
  if (normalized instanceof MaxRuntimeError) {
    payload.code = normalized.code;
    if (normalized.details !== undefined) payload.details = normalized.details;
  }
  return payload;
};

/**
 * Turn only deterministic provider-state and selector failures into public
 * recovery codes. Transport failures and ambiguous mutations deliberately stay
 * unclassified so skill instructions cannot mistake them for browser fallback
 * authority.
 */
const normalizeMaxRuntimeError = (error) => {
  if (error instanceof MaxRuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/MAX login is required/iu.test(message)) {
    return new MaxRuntimeError("MAX_LOGIN_REQUIRED", message);
  }
  if (/(?:could not safely identify|rendered no visible interactive UI|session state could not be safely identified|chat list could not be identified|chat list has no recognized rows|UI fingerprint is not supported)/iu.test(message)) {
    return new MaxRuntimeError("MAX_UI_UNSUPPORTED", message);
  }
  return error;
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
    // Empty means "use the common host discovery". An exact --chrome value
    // remains a provider CLI override, but platform lookup belongs to the
    // shared browser layer and is not duplicated by every adapter.
    chromeExecutable: "",
    headed: false,
    holdMs: 600_000,
    timeoutMs: 60_000,
    query: "",
    chat: "",
    contextRef: "",
    contact: "",
    title: "",
    description: null,
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
    assistX: null,
    assistY: null,
    holdMsExplicit: false,
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
    } else if (argument === "--send-mode") options.sendMode = value();
    else if (argument === "--chrome") options.chromeExecutable = path.resolve(value());
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--headless") options.headed = false;
    else if (argument === "--hold-ms") {
      options.holdMs = Number(value());
      options.holdMsExplicit = true;
    }
    else if (argument === "--timeout-ms") options.timeoutMs = Number(value());
    else if (argument === "--query") options.query = value();
    else if (argument === "--chat") options.chat = value();
    else if (argument === "--context-ref") options.contextRef = normalizeChatContextRef(value());
    else if (argument === "--contact") options.contact = value();
    else if (argument === "--title") options.title = value();
    else if (argument === "--description") {
      // An empty argument deliberately clears the description. Other CLI
      // values still reject an empty token so their identities stay exact.
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options.description = next;
      index += 1;
    }
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

  if (!SUPPORTED_COMMANDS.has(options.command)) {
    throw new Error(`Unsupported MAX browser command: ${options.command || "(missing)"}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.pages) || options.pages < 1 || options.pages > MAX_HISTORY_PAGES) {
    throw new Error(`--pages must be an integer from 1 to ${MAX_HISTORY_PAGES}.`);
  }
  if (!Number.isInteger(options.attachmentIndex) || options.attachmentIndex < 1 || options.attachmentIndex > 100) {
    throw new Error("--attachment-index must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > MAX_WATCH_ITERATIONS) {
    throw new Error(`--iterations must be an integer from 1 to ${MAX_WATCH_ITERATIONS}.`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > MAX_WATCH_INTERVAL_MS) {
    throw new Error(`--interval-ms must be from 1000 to ${MAX_WATCH_INTERVAL_MS}.`);
  }
  if (options.files.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`One MAX message can contain at most ${MAX_FILES_PER_MESSAGE} --file values.`);
  }
  if (options.members.length > MAX_GROUP_MEMBERS_PER_OPERATION) {
    throw new Error(`One MAX operation can contain at most ${MAX_GROUP_MEMBERS_PER_OPERATION} --member values.`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 5_000) {
    throw new Error("--timeout-ms must be at least 5000.");
  }
  if (options.command === "assist-start" && !options.holdMsExplicit) {
    options.holdMs = MAX_ASSIST_HOLD_MS;
  }
  const maximumHoldMs = options.command === "assist-start" ? MAX_ASSIST_HOLD_MS : 600_000;
  if (!Number.isFinite(options.holdMs) || options.holdMs < 5_000 || options.holdMs > maximumHoldMs) {
    throw new Error(`--hold-ms must be from 5000 to ${maximumHoldMs}.`);
  }
  if (options.command === "assist-start" && !ASSIST_COMMANDS.has(options.fallbackFor)) {
    throw new Error(
      `assist-start requires --fallback-for with one supported MAX command: ${[...ASSIST_COMMANDS].sort().join(", ")}.`,
    );
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
  if (options.command === "assist-scroll" && (!Number.isInteger(options.assistDeltaY)
    || options.assistDeltaY === 0 || Math.abs(options.assistDeltaY) > 1500)) {
    throw new Error("assist-scroll requires --delta-y from -1500 to 1500, excluding zero.");
  }
  if (["assist-point-click", "assist-point-contextmenu", "assist-point-scroll"].includes(options.command)
    && (![options.assistX, options.assistY].every((coordinate) => Number.isInteger(coordinate)
      && coordinate >= 0 && coordinate <= 8192))) {
    throw new Error(`${options.command} requires integer --x and --y screenshot coordinates.`);
  }
  if (options.command === "assist-point-scroll" && (!Number.isInteger(options.assistDeltaY)
    || options.assistDeltaY === 0 || Math.abs(options.assistDeltaY) > 1500)) {
    throw new Error("assist-point-scroll requires --delta-y from -1500 to 1500, excluding zero.");
  }
  return options;
};

const usage = () => `
Usage:
  trelio-max.mjs bootstrap
  trelio-max.mjs doctor
  trelio-max.mjs probe
  trelio-max.mjs assist-start --fallback-for read --chat "Название или URL" [--hold-ms 1800000]
  trelio-max.mjs assist-start --fallback-for dialogs --query "Название" --limit 20
  trelio-max.mjs assist-start --fallback-for send --chat "Название" --message "Текст" --confirm
  trelio-max.mjs assist-status --session UUID
  trelio-max.mjs assist-snapshot --session UUID
  trelio-max.mjs assist-click --session UUID --snapshot UUID --ref r1
  trelio-max.mjs assist-contextmenu --session UUID --snapshot UUID --ref r1
  trelio-max.mjs assist-fill --session UUID --snapshot UUID --ref r1 --text "Поиск"
  trelio-max.mjs assist-key --session UUID --snapshot UUID --key Escape
  trelio-max.mjs assist-scroll --session UUID --snapshot UUID --delta-y 600
  trelio-max.mjs assist-point-click --session UUID --snapshot UUID --x 700 --y 450
  trelio-max.mjs assist-point-contextmenu --session UUID --snapshot UUID --x 700 --y 450
  trelio-max.mjs assist-point-scroll --session UUID --snapshot UUID --x 850 --y 700 --delta-y 600
  trelio-max.mjs assist-stop --session UUID
  trelio-max.mjs policy show
  trelio-max.mjs policy set --send-mode read-only
  trelio-max.mjs login
  trelio-max.mjs dialogs [--query "Название"] --limit 100 [--context-ref TASK_URL]
  trelio-max.mjs contacts --query "Имя, @username или +79990000000"
  trelio-max.mjs profile --chat "Точное название или URL" [--context-ref TASK_URL]
  trelio-max.mjs read --chat "Название или URL" --limit 20 --pages 2 [--context-ref TASK_URL]
  trelio-max.mjs unread --limit 10 --pages 1
  trelio-max.mjs watch --limit 10 --iterations 4 --interval-ms 15000
  trelio-max.mjs download --chat "Название" --message-id ID --attachment-index 1 --output PATH
  trelio-max.mjs send --chat "Название" --message "Текст" --file PATH --confirm
  trelio-max.mjs reply --chat "Название" --message-id ID --message "Текст" --confirm
  trelio-max.mjs react --chat "Название" --message-id ID --reaction "👍" --confirm
  trelio-max.mjs edit --chat "Название" --message-id ID --message "Новый текст" --dry-run
  trelio-max.mjs delete --chat "Название" --message-id ID --dry-run
  trelio-max.mjs forward --chat "Источник" --message-id ID --to-chat "Получатель" --dry-run
  trelio-max.mjs create-direct --contact "https://max.ru/u/name" --message "Текст" --dry-run
  trelio-max.mjs create-group --title "Название" --member "@one" --member "@two" --dry-run
  trelio-max.mjs members --chat "Название"
  trelio-max.mjs member-add --chat "Название" --member "@name" --dry-run
  trelio-max.mjs member-remove --chat "Название" --member "@name" --dry-run
  trelio-max.mjs chat-update --chat "Название" --title "Новое название" --description "" --dry-run

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

// This is a locator journal, not an address book inferred from names. Provider
// URLs are its primary keys; duplicate names always retain distinct records.
// The existing profile lock serializes ordinary commands and assisted workers.
const chatReferencesPath = (options) => path.join(connectionRoot(options), "state", "chat-references.json");
const MAX_CHAT_REFERENCES_BYTES = 1024 * 1024;
const writeChatReferences = (options, value) => {
  const file = chatReferencesPath(options);
  ensurePrivateDirectory(path.dirname(file));
  // Unique exclusive staging avoids following an old .tmp symlink. The
  // journal contains only allowlisted locator fields, never message content.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};
const hasChatReferenceIdentity = (options) => ["companyId", "memberId", "connectionId"]
  .every((key) => UUID_PATTERN.test(options[key] || ""));
const normalizeChatContextRef = (value) => {
  try {
    if (typeof value !== "string" || value.length > 512) throw new Error();
    const url = new URL(value);
    if (url.origin !== "https://trelio.ru" || url.username || url.password
      || url.search || url.hash || !/^\/[a-z0-9_-]+\/[a-z0-9_-]+\/tasks\/\d+\/?$/u.test(url.pathname)) throw new Error();
    return `${url.origin}${url.pathname.replace(/\/?$/u, "/")}`;
  } catch {
    throw new MaxRuntimeError("MAX_CHAT_CONTEXT_INVALID", "--context-ref requires a canonical Trelio task URL without query or fragment.");
  }
};

const loadChatReferences = (options) => {
  if (!hasChatReferenceIdentity(options)) return { schemaVersion: 1, chats: [] };
  const file = chatReferencesPath(options);
  try {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: 1, chats: [] };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHAT_REFERENCES_BYTES) throw new Error();
    ensurePrivateFile(file);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Object.keys(value).sort().join(",") !== "chats,schemaVersion"
      || value.schemaVersion !== 1 || !Array.isArray(value.chats) || value.chats.length > 1000) throw new Error();
    const seen = new Set();
    for (const chat of value.chats) {
      const keys = Object.keys(chat).sort().join(",");
      if (!["contextRefs,titles,url,verifiedAt", "contextRefs,lookupPhone,titles,url,verifiedAt"].includes(keys)
        || typeof chat.url !== "string" || normalizeChatUrl(chat.url) !== chat.url || seen.has(chat.url)
        || (chat.lookupPhone !== undefined && (!chat.lookupPhone || normalizePhoneLookupQuery(chat.lookupPhone) !== chat.lookupPhone))
        || !Array.isArray(chat.titles) || chat.titles.length > 8
        || chat.titles.some((title) => typeof title !== "string" || !title.trim() || title.length > 160)
        || !Array.isArray(chat.contextRefs) || chat.contextRefs.length > 32
        || chat.contextRefs.some((ref) => typeof ref !== "string" || normalizeChatContextRef(ref) !== ref)
        || typeof chat.verifiedAt !== "string" || !Number.isFinite(Date.parse(chat.verifiedAt))) throw new Error();
      seen.add(chat.url);
    }
    return value;
  } catch {
    // Do not leak the file, raw parser diagnostics or private metadata. An
    // invalid journal cannot authorize fallback to a similarly named person.
    throw new MaxRuntimeError("MAX_CHAT_REFERENCE_STORE_INVALID", "The local MAX chat reference journal is invalid. Preserve it and diagnose the journal; do not select a replacement chat by name.");
  }
};

const chatReferenceValue = (chat, contextRef = "") => ({
  url: chat.url,
  stableId: new URL(chat.url).pathname.replace(/^\/(?:u\/)?/u, "").replace(/\/$/u, ""),
  title: chat.titles.at(-1) || null,
  verifiedAt: chat.verifiedAt,
  contextMatched: Boolean(contextRef && chat.contextRefs.includes(contextRef)),
});

const knownChatReferences = (options, query = options.query || "") => {
  const needle = normalizeDialogTitle(query);
  return loadChatReferences(options).chats.filter((chat) =>
    (!options.contextRef || chat.contextRefs.includes(options.contextRef))
    && (!needle || chat.titles.some((title) => normalizeDialogTitle(title).includes(needle))))
    .slice(-Math.min(options.limit || 20, 100)).map((chat) => chatReferenceValue(chat, options.contextRef));
};

const rememberChatReference = (options, reference, bindContext = false) => {
  const url = normalizeChatUrl(reference.url);
  const title = String(reference.title || "").replace(/\s+/gu, " ").trim().slice(0, 160);
  const journal = loadChatReferences(options);
  let chat = journal.chats.find((entry) => entry.url === url);
  if (!chat) {
    chat = { url, titles: [], contextRefs: [], verifiedAt: "" };
  }
  if (title) chat.titles = [...chat.titles.filter((value) => value !== title), title].slice(-8);
  // Only the official phone-lookup result supplies this private locator. It
  // does not enter knownChats or task bindings and never authorizes sending.
  // A later lookup must resolve to this exact provider URL before use: phone
  // reassignment or a stale match cannot silently change the recipient.
  if (reference.lookupPhone !== undefined) {
    if (!reference.lookupPhone || normalizePhoneLookupQuery(reference.lookupPhone) !== reference.lookupPhone) {
      throw new MaxRuntimeError("MAX_CHAT_REFERENCE_STORE_INVALID", "The MAX phone lookup locator is invalid.");
    }
    chat.lookupPhone = reference.lookupPhone;
  }
  // Only a successful exact read/profile may bind a task. Exploring several
  // candidates through assist must never silently decide which one is relevant.
  if (bindContext && options.contextRef && !chat.contextRefs.includes(options.contextRef)) {
    chat.contextRefs = [...chat.contextRefs, options.contextRef].slice(-32);
  }
  chat.verifiedAt = new Date().toISOString();
  // Refresh recency by provider identity, then evict only the oldest records.
  // Count and byte limits must agree: many long task URLs cannot make a journal
  // that this same runtime would reject on its next invocation.
  journal.chats = [...journal.chats.filter((entry) => entry.url !== url), chat].slice(-1000);
  while (Buffer.byteLength(`${JSON.stringify(journal)}\n`, "utf8") > MAX_CHAT_REFERENCES_BYTES) journal.chats.shift();
  if (hasChatReferenceIdentity(options)) writeChatReferences(options, journal);
  return chatReferenceValue(chat, options.contextRef);
};

const contextChatReference = (options) => {
  if (!options.contextRef || !["read", "profile"].includes(options.command)) return null;
  const expected = normalizeDialogTitle(options.chat);
  const matches = loadChatReferences(options).chats.filter((chat) =>
    chat.contextRefs.includes(options.contextRef)
    && chat.titles.some((title) => normalizeDialogTitle(title) === expected));
  if (matches.length > 1) throw new MaxRuntimeError("MAX_CHAT_AMBIGUOUS",
    "Several verified MAX chats match this task and title. Inspect their exact URLs; do not repeat the same title lookup.",
    { candidates: matches.map((chat) => chatReferenceValue(chat, options.contextRef)), finalMutationActionStarted: false });
  return matches.length === 1 ? matches[0].url : null;
};

const inspectOpenedChatReference = async (page, fallbackTitle = "") => {
  let url;
  try { url = normalizeChatUrl(page.url()); } catch { return null; }
  const surface = await page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const visible = (node) => node && node.getBoundingClientRect().width > 0
      && node.getBoundingClientRect().height > 0;
    // An empty contenteditable attribute is HTML's enabled state. MAX uses
    // it for a new contact's composer before any message wrapper exists.
    const ready = Array.from(main.querySelectorAll('[class~="messageWrapper"], [data-message-id], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], textarea')).some(visible);
    const profile = Array.from(main.querySelectorAll('button, [role="button"]'))
      .find((node) => visible(node) && /^Открыть профиль\s+/iu.test(node.getAttribute("aria-label") || ""));
    const heading = Array.from(main.querySelectorAll("header h1, header h2, header h3")).find(visible);
    const title = profile?.getAttribute("aria-label")?.replace(/^Открыть профиль\s+/iu, "")
      || heading?.textContent || null;
    return { ready, title };
  });
  if (!surface?.ready) return null;
  try { if (normalizeChatUrl(page.url()) !== url) return null; } catch { return null; }
  return { url, title: surface.title || fallbackTitle || null };
};

const rememberOpenedChat = async (page, options, opened, bindContext = false) => {
  const reference = await inspectOpenedChatReference(page, opened?.matched || "");
  if (!reference || normalizeChatUrl(opened.url) !== reference.url) return null;
  return rememberChatReference(options, reference, bindContext);
};

const canRecoverAssistPreparation = (error, interactionMode) => error instanceof MaxRuntimeError
  && (["MAX_UI_UNSUPPORTED", "MAX_PICKER_TARGET_UNRESOLVED"].includes(error.code)
    || (error.code === "MAX_CHAT_AMBIGUOUS" && interactionMode === "read-only"));
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
      throw new MaxRuntimeError(
        "MAX_ASSIST_START_IN_PROGRESS",
        "Another MAX assisted-browser start is already in progress.",
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
    throw new MaxRuntimeError(
      "MAX_ASSIST_SESSION_INVALID",
      "The local MAX assisted-browser session record is invalid.",
    );
  }
  const terminalFile = path.join(connectionRoot(options), "state", "assist-snapshots",
    record.sessionId, "terminal.json");
  if (!fs.existsSync(terminalFile)) return record;
  const terminalStat = fs.lstatSync(terminalFile);
  if (!terminalStat.isFile() || terminalStat.isSymbolicLink() || terminalStat.size > 16_384) {
    throw new MaxRuntimeError("MAX_ASSIST_SESSION_INVALID", "The exact MAX worker outcome is invalid.");
  }
  ensurePrivateFile(terminalFile);
  let terminal;
  try {
    terminal = JSON.parse(fs.readFileSync(terminalFile, "utf8"));
  } catch {
    // JSON parse diagnostics can quote bytes from corrupt private state.
    throw new MaxRuntimeError("MAX_ASSIST_SESSION_INVALID", "The exact MAX worker outcome is invalid.");
  }
  const terminalKeys = new Set(["schemaVersion", "sessionId", "pid", "phase", "error", "message"]);
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)
    || Object.keys(terminal).some((key) => !terminalKeys.has(key))
    || terminal.schemaVersion !== 1 || terminal.sessionId !== record.sessionId
    || terminal.pid !== record.pid || !["closed", "failed"].includes(terminal.phase)) {
    throw new MaxRuntimeError("MAX_ASSIST_SESSION_INVALID", "The exact MAX worker outcome is invalid.");
  }
  return { ...record, ...terminal, port: null, token: null };
};

const assistStartupDeadline = (expiresAt, now = Date.now()) =>
  Math.min(now + MAX_ASSIST_START_TIMEOUT_MS, expiresAt);

const writeAssistTerminalState = (options, sessionId, fields) => {
  const current = readAssistSession(options);
  // A timed-out worker can finish after a newer start has acquired the same
  // namespace. Keep its outcome in its own UUID directory: even a retirement
  // racing this write cannot overwrite the new session's shared record.
  if (!current || current.sessionId !== sessionId || current.pid !== process.pid) return false;
  const file = path.join(connectionRoot(options), "state", "assist-snapshots", sessionId, "terminal.json");
  writePrivateJson(file, { schemaVersion: 1, sessionId, pid: process.pid, ...fields });
  return true;
};

const waitForAssistShutdown = async (record, {
  readRecord,
  isAlive = processIsAlive,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20_000,
}) => {
  const deadline = now() + timeoutMs;
  while (true) {
    const current = readRecord();
    // The worker writes this receipt only after the host has awaited browser
    // closure and released the profile lock. Node may still retain unrelated
    // handles (or its PID may be reused), so PID liveness alone is not the
    // browser lifecycle. Missing/replaced records are never positive evidence.
    if (current?.sessionId === record.sessionId && current.pid === record.pid
      && current.phase === "closed") return true;
    if (!isAlive(record.pid)) return true;
    if (now() >= deadline) return false;
    await wait(100);
  }
};

const closeAssistControlServer = (server) => new Promise((resolve, reject) => {
  // server.close alone waits for clients that have sent only partial headers
  // or bodies. Those local control sockets must not delay Chrome closure until
  // Node's HTTP timeout. Stop has already fenced actions and file transfers;
  // its acknowledgement is flushed before this helper runs. This closes only
  // the worker's loopback HTTP clients, never MAX's browser/WebSocket traffic.
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections();
});

const afterAssistResponse = (response, callback) => {
  // Register before response.end: tearing down sockets immediately afterwards
  // can lose the accepted-stop response. A disconnected caller still requested
  // cleanup, so either finish or close starts it, exactly once.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    callback();
  };
  response.once("finish", settle);
  response.once("close", settle);
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
  passiveReadProtection: "preserve-unread",
  ...extra,
});

/**
 * Keep the model-driven recovery window useful for search and chat navigation
 * without turning native screen control into an unguarded mutation channel.
 * The browser-side copy below applies the same policy synchronously to trusted
 * native mouse/keyboard events before the MAX application receives them.
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
      || pathname === "/"
    );
  if (kind === "fill") return searchLike;
  if (kind !== "click") return false;
  if (searchLike) return true;
  // The exact profile command starts in an already resolved chat. Its title
  // button opens contact details without changing the chat. Geometry limits
  // this exception to the header, while the action-word check below still
  // rejects call, settings, add and other controls in that region.
  const profileHeader = fallbackFor === "profile"
    && /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(pathname)
    && Boolean(box) && box.x >= viewportWidth * 0.36 && box.x < viewportWidth * 0.8
    && box.y >= 0 && box.y < 110 && box.width >= 80 && box.height >= 20
    && ["button", "div", "span"].includes(normalizedTag)
    && !href && /\p{L}/u.test(normalizedLabel);
  const contactsTab = fallbackFor === "contacts"
    && Boolean(box) && box.x >= 0 && box.x < 110 && box.y < 700
    && /^(?:контакты|contacts)$/iu.test(normalizedLabel) && !href;
  if (!inLeftPane && !profileHeader && !contactsTab) return false;
  if (!normalizedLabel) return false;
  // Opening a contact through MAX's search action has no message effect. Cold
  // direct links need this exact control even during read/profile preparation.
  // Keep the exception on the home search surface; a bot button, generic
  // Continue action or a similarly worded mutation must not gain authority.
  const phoneSearchAction = pathname === "/" && inLeftPane
    && ["dialogs", "contacts", "profile", "read", "unread", "watch"].includes(fallbackFor)
    && normalizedTag === "button" && !href && !chatRow
    && /^(?:найти по номеру|find by phone)(?:\s+\+?[\d\s()-]{6,25})?$/iu.test(normalizedLabel);
  if (phoneSearchAction) return true;
  // A verified chat row includes its latest-message preview in the accessible
  // label. Words such as "Отправьте" there describe a received message; they
  // do not turn opening the row into a send action.
  if (chatRow && ["a", "button", "div", "li", "span"].includes(normalizedTag) && !href) {
    return true;
  }
  if (href) {
    try {
      const url = new URL(href, MAX_WEB_URL);
      return url.origin === MAX_WEB_ORIGIN
        && /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(url.pathname)
        && !url.search && !url.hash;
    } catch {
      return false;
    }
  }
  if (/(?:отправ|send|ответ|reply|редакт|edit|удал|delete|пересл|forward|реакц|react|созда|create|нов(?:ый|ая)\s+чат|new\s+chat|добав|add|убрат|remove|настрой|settings|выйти|logout|покинуть|leave|заблок|block|пожаловат|report|позвон|звонок|call|видео|video|закреп|pin|архив|archive|без\s+звука|mute)/iu.test(normalizedLabel)) {
    return false;
  }
  if (profileHeader || contactsTab) return true;
  return false;
};

const installMaxAssistGate = (configuration = {}) => {
  if (window.__trelioMaxAssistState) return;
  const mode = configuration.mode === "manual-control" ? "manual-control" : "read-only";
  const fallbackFor = String(configuration.fallbackFor || "");
  const state = { version: 2, mode, blockedActions: 0 };
  Object.defineProperty(window, "__trelioMaxAssistState", {
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
      'a, button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"]',
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
    const chatRow = Boolean(element.querySelector(
      'h3, [role="heading"][aria-level="3"], [class~="cell"] > [class~="title"] [class~="name"]',
    ));
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
        const url = new URL(value.href, "https://web.max.ru/");
        if (url.origin === "https://web.max.ru") return true;
        // MAX's file button dispatches a synthetic click on a temporary anchor.
        // This is the same attachment navigation consumed by the installed
        // transfer handler, not a permission to browse an external site. Keep
        // it unavailable in every other operation and before transfer setup;
        // the route still verifies the initiating frame, response and one file.
        return fallbackFor === "download"
          && Boolean(window.__trelioMaxDownloadNavigation)
          && url.origin === "https://fd.oneme.ru"
          && !url.username && !url.password;
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
      && (/(?:найти|поиск|find|search)/iu.test(value.label) || window.location.pathname === "/");
    if (kind === "fill") return searchLike;
    if (kind !== "click") return false;
    if (searchLike) return true;
    const profileHeader = fallbackFor === "profile"
      && /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(window.location.pathname)
      && value.box.x >= window.innerWidth * 0.36 && value.box.x < window.innerWidth * 0.8
      && value.box.y >= 0 && value.box.y < 110
      && value.box.width >= 80 && value.box.height >= 20
      && ["button", "div", "span"].includes(value.tag)
      && !value.href && /\p{L}/u.test(value.label);
    const contactsTab = fallbackFor === "contacts"
      && value.box.x >= 0 && value.box.x < 110 && value.box.y < 700
      && /^(?:контакты|contacts)$/iu.test(value.label) && !value.href;
    if ((!inLeftPane && !profileHeader && !contactsTab) || !value.label) return false;
    // Mirror the host semantic gate for the provider's exact home-search
    // action. The native event fence must allow this click before MAX's
    // handler, otherwise cold-contact recovery silently cancels its own lookup.
    const phoneSearchAction = window.location.pathname === "/" && inLeftPane
      && ["dialogs", "contacts", "profile", "read", "unread", "watch"].includes(fallbackFor)
      && value.tag === "button" && !value.href && !value.chatRow
      && /^(?:найти по номеру|find by phone)(?:\s+\+?[\d\s()-]{6,25})?$/iu.test(value.label);
    if (phoneSearchAction) return true;
    // The chat preview is part of the row label. Permit only a structurally
    // recognized row here, so a bot prompt cannot block navigation or grant
    // the surrounding composer and toolbar any new action.
    if (value.chatRow && ["a", "button", "div", "li", "span"].includes(value.tag)
      && !value.href) return true;
    if (value.href) {
      try {
        const url = new URL(value.href, "https://web.max.ru/");
        return url.origin === "https://web.max.ru"
          && /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(url.pathname)
          && !url.search && !url.hash;
      } catch {
        return false;
      }
    }
    if (/(?:отправ|send|ответ|reply|редакт|edit|удал|delete|пересл|forward|реакц|react|созда|create|нов(?:ый|ая)\s+чат|new\s+chat|добав|add|убрат|remove|настрой|settings|выйти|logout|покинуть|leave|заблок|block|пожаловат|report|позвон|звонок|call|видео|video|закреп|pin|архив|archive|без\s+звука|mute)/iu.test(value.label)) {
      return false;
    }
    if (profileHeader || contactsTab) return true;
    return false;
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
    // visible MAX UI, including Enter/Space on confirmation surfaces whose
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
  if (sendMode === "read-only") throw new Error("Local MAX policy is read-only; sending is disabled.");
  // --confirm attests authorization for this call only. The agent derives it
  // from exact approval or an explicit allowance in this conversation; the
  // runtime never persists that allowance or proposes enabling it.
  if (!options.confirm) {
    throw new Error("MAX send requires --confirm for this invocation.");
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
    throw new Error(`MAX local file was not found: ${file}`);
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
    if (seen.has(identity)) throw new Error(`Duplicate MAX member reference: ${normalized}`);
    seen.add(identity);
    result.push(normalized);
  }
  return result;
};

const validateCommandOptions = (options) => {
  if (options.contextRef && !["dialogs", "read", "profile"].includes(options.command)) {
    throw new Error(`${options.command} does not accept --context-ref. Task bindings are read-only and never select a mutation recipient.`);
  }
  options.members = normalizeUniqueMembers(options.members);
  if (options.title) options.title = options.title.normalize("NFKC").replace(/\s+/gu, " ").trim();

  // Reject unused local-path and content arguments instead of merely ignoring
  // them. This keeps both the ordinary adapter and manual recovery bound to the
  // exact operation and prevents an unrelated command from loading a local
  // file into the provider process.
  if ((options.message || options.messageFile)
    && !["create-direct", "edit", "reply", "send"].includes(options.command)) {
    throw new Error(`${options.command} does not accept --message or --message-file.`);
  }
  if (options.files.length > 0
    && !["create-direct", "reply", "send"].includes(options.command)) {
    throw new Error(`${options.command} does not accept --file.`);
  }
  if (options.avatar && !["chat-update", "create-group"].includes(options.command)) {
    throw new Error(`${options.command} does not accept --avatar.`);
  }
  if (options.description !== null && options.command !== "chat-update") {
    throw new Error(`${options.command} does not accept --description.`);
  }
  if (options.output && options.command !== "download") {
    throw new Error(`${options.command} does not accept --output.`);
  }
  const message = outgoingMessage(options);

  if (options.command === "contacts" && !options.query) {
    throw new Error(`${options.command} requires --query.`);
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
    "profile",
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
    const contactUrl = normalizeChatUrl(options.contact);
    if (!/\/u\/[A-Za-z0-9_-]+\/?$/u.test(new URL(contactUrl).pathname)) {
      throw new Error("create-direct requires an official MAX /u/ contact URL.");
    }
    options.contact = contactUrl;
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
  if (options.command === "chat-update" && !options.title && !options.avatar && options.description === null) {
    throw new Error("chat-update requires --title, --description or --avatar.");
  }
  if (options.title && options.title.length > 255) throw new Error("--title cannot exceed 255 characters.");
  if (options.description !== null && options.description.length > 1000) {
    throw new Error("--description cannot exceed 1000 characters.");
  }

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
    description: options.description,
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
    throw new Error(`MAX ${options.command} always requires --confirm.`);
  }
  const expected = buildMutationPreview(options).approvalHash;
  if (!options.approvalHash || options.approvalHash !== expected) {
    throw new Error(
      `MAX ${options.command} requires the exact --approval-hash returned by an unchanged --dry-run.`,
    );
  }
  return policyMode;
};

const prepareAssistAuthorization = (options) => {
  if (options.contextRef) throw new Error("assist-start does not accept --context-ref. Bind the inspected URL with a successful exact read.");
  const operation = {
    ...options,
    command: options.fallbackFor,
    members: [...options.members],
    files: [...options.files],
    dryRun: false,
  };
  const { message } = validateCommandOptions(operation);
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
    chat: operation.chat || null,
    contact: operation.contact || null,
    title: operation.title || null,
    description: operation.description,
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

const assistTargetContext = (operation) => ({
  targetChat: operation.chat || null,
  targetMessage: ASSIST_MESSAGE_TARGET_COMMANDS.has(operation.command)
    ? {
      messageId: operation.messageId || null,
      targetText: operation.targetText || null,
      targetAuthor: operation.targetAuthor || null,
    }
    : null,
  targetPages: operation.pages,
});

const frameBytes = (frame) => {
  if (Buffer.isBuffer(frame)) return frame;
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  return Buffer.from(String(frame), "utf8");
};

const passiveReadFrameMarker = (frame) => {
  const bytes = frameBytes(frame);
  return PASSIVE_READ_PROTOCOL_MARKERS.find((marker) => bytes.includes(Buffer.from(marker, "utf8"))) || null;
};

const shouldBlockPassiveReadFrame = (frame) => Boolean(passiveReadFrameMarker(frame));

const installPassiveReadGuard = async (context) => {
  if (typeof context.routeWebSocket !== "function") {
    throw new Error(
      "MAX passive reading requires Playwright WebSocket routing. Run bootstrap with the current runtime release.",
    );
  }
  const state = {
    allowReadReceipts: false,
    blockedFrames: 0,
    blockedByType: Object.fromEntries(PASSIVE_READ_PROTOCOL_MARKERS.map((marker) => [marker, 0])),
    forwardedReadFrames: 0,
  };

  // MAX optimistically updates unread counters in the DOM before its binary
  // WebSocket request reaches the server. Intercepting the protocol frame is
  // therefore the only reliable way to keep the server-side read mark and the
  // sender-visible receipt unchanged while the agent inspects a chat. Merely
  // clicking "mark unread" afterwards would not undo an already-sent receipt.
  await context.routeWebSocket(/.*/u, (client) => {
    const server = client.connectToServer();
    client.onMessage((message) => {
      const marker = passiveReadFrameMarker(message);
      if (marker && !state.allowReadReceipts) {
        state.blockedFrames += 1;
        state.blockedByType[marker] += 1;
        return;
      }
      if (marker) state.forwardedReadFrames += 1;
      server.send(message);
    });
  });
  return state;
};

const bodyText = (page) => page.evaluate(() => document.body?.innerText || "");

const inspectMaxSessionDocument = (readyOnly = false) => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width >= 1
      && rect.height >= 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const normalizedText = (element) => [
    element.textContent,
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    element.getAttribute?.("placeholder"),
  ].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  const visibleElements = (selector) =>
    Array.from(document.querySelectorAll(selector)).filter(visible);

  // The unauthenticated MAX shell renders language/help controls before the
  // QR panel on slower Windows machines. Generic button visibility therefore
  // cannot prove that the session UI is ready. Wait for a provider-owned login
  // marker or for an authenticated home marker before classifying the page.
  const loginPattern = /(?:войдите\s+в\s+max|войти\s+по\s+номеру\s+телефона|qr-код\s+устарел|авторизационная\s+сессия\s+не\s+найдена|sign\s+in\s+to\s+max|log\s+in\s+to\s+max|sign\s+in\s+with\s+(?:a\s+)?phone|log\s+in\s+with\s+(?:a\s+)?phone|qr\s+code\s+expired|authentication\s+session\s+(?:was\s+)?not\s+found)/iu;
  const searchPattern = /(?:найти|поиск|find|search)/iu;
  const headingOrAction = visibleElements("h1, h2, h3, h4, [role=\"heading\"], button, [role=\"button\"]");
  const loginControlReady = headingOrAction.some((element) =>
    loginPattern.test(normalizedText(element)));
  const searchControlReady = visibleElements(
    'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]',
  ).some((element) => searchPattern.test(normalizedText(element)));
  const homeFolderReady = visibleElements("button, [role=\"button\"]").some((element) =>
    /^(?:все|all)(?:\s|,|$)/iu.test(normalizedText(element)));
  const dialogRowReady = visibleElements("button h3, [role=\"button\"] h3").length > 0;
  const chatRouteReady = /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(window.location.pathname)
    && visibleElements(
      '[class~="messageWrapper"], [data-message-id], textarea, [contenteditable="true"], [role="textbox"]',
    ).length > 0;
  const authenticatedReady = searchControlReady
    || homeFolderReady
    || dialogRowReady
    || chatRouteReady;
  const body = String(document.body?.innerText || document.body?.textContent || "")
    .replace(/\s+/gu, " ")
    .trim();
  // Body-text fallback covers provider variants where the same login copy is
  // not exposed through heading/button semantics. A recognized authenticated
  // home wins so a chat message quoting login instructions cannot log the user
  // out in the runtime's eyes.
  const loginReady = loginControlReady || (!authenticatedReady && loginPattern.test(body));
  if (readyOnly) return loginReady || authenticatedReady;
  return { loginReady, authenticatedReady };
};

const assertLoggedIn = async (page) => {
  assertDocumentAvailable(page);
  const session = await page.evaluate(inspectMaxSessionDocument, false);
  if (session.loginReady) {
    throw new Error("MAX login is required. Run login and let the user finish it in the visible window.");
  }
  if (!session.authenticatedReady) {
    throw new Error(
      "MAX session state could not be safely identified after the UI loaded. The runtime failed closed; do not repeat login automatically.",
    );
  }
};

const waitForVisibleMaxUi = async (page, timeoutMs) => {
  const boundedTimeoutMs = Math.min(timeoutMs, MAX_UI_READY_TIMEOUT_MS);
  // MAX is a client-rendered application. `domcontentloaded` may fire while
  // only the outer shell is visible, so browser commands must wait for a
  // classifiable login or authenticated surface before probing selectors.
  return page.waitForFunction(inspectMaxSessionDocument, true, {
    timeout: boundedTimeoutMs,
  }).then(() => true).catch(() => false);
};

const openHome = async (page, options, allowLogin = false) => {
  await page.goto(MAX_WEB_URL, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  assertDocumentAvailable(page);
  let uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  if (!uiReady) {
    // A copied or long-idle persistent profile can occasionally restore a
    // blank SPA shell on the first navigation. One controlled reload recovers
    // that state without weakening selector checks or repeating a user action.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    assertDocumentAvailable(page);
    uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  }
  if (!uiReady && !allowLogin) {
    throw new Error(
      "MAX home rendered no visible interactive UI after one controlled reload. The runtime failed closed.",
    );
  }
  if (!allowLogin) await assertLoggedIn(page);
  return { uiReady };
};

const findSearchInput = async (page, timeoutMs) => {
  const candidates = [
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
      // MAX changes generated class names frequently; try an accessible fallback.
    }
  }

  // Last-resort semantic fallback: on the authenticated MAX home screen the
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
    "Could not safely identify the MAX dialog search field. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
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

/**
 * Phone lookup is a provider action, not a substring search over chat titles.
 * Only an explicit international number enters that action; a numeric chat
 * title or an incomplete local number must keep its ordinary search meaning.
 */
const normalizePhoneLookupQuery = (value) => {
  const compact = String(value || "").normalize("NFKC").replace(/[\s()\-–—]/gu, "");
  return /^\+[1-9]\d{6,14}$/u.test(compact) ? compact : null;
};

const normalizeDialogTitle = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/\s+/gu, " ")
  .trim()
  .toLocaleLowerCase("ru-RU");

const selectExactDialogResult = (results, reference) => {
  const expected = normalizeDialogTitle(reference);
  const exactMatches = results.filter((result) => normalizeDialogTitle(result.title) === expected);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new MaxRuntimeError(
      "MAX_CHAT_AMBIGUOUS",
      `Ambiguous exact MAX dialog title: ${reference}. Inspect the candidates; do not repeat the same name lookup.`,
      {
        candidates: exactMatches.slice(0, 20).map(({ title, url, stableId }) => ({ title, url: url || null, stableId: stableId || null })),
        candidatesComplete: exactMatches.length <= 20,
        recoveryArguments: ["assist-start", "--fallback-for", "dialogs", "--query", reference, "--limit", "20"],
        finalMutationActionStarted: false,
      },
    );
  }

  const visibleCandidates = results
    .slice(0, 5)
    .map((result) => `"${result.title}"`)
    .join(", ");
  throw new Error(
    visibleCandidates
      ? `No exact visible MAX dialog matched: ${reference}. Visible partial matches: ${visibleCandidates}. Use the exact title or an official chat URL.`
      : `No exact visible MAX dialog matched: ${reference}. Use the exact title or an official chat URL.`,
  );
};

const selectFavoritesHomeDialog = (snapshot) => {
  // MAX reserves /0 for the personal Favorites surface and renders the same
  // target as list index zero in the All folder. Binding both invariants avoids
  // confusing it with public channels that are also named "Избранное".
  const matches = snapshot.dialogs.filter((dialog) =>
    String(dialog.listIndex) === "0"
    && normalizeDialogTitle(dialog.title) === "избранное");
  if (matches.length === 1) return matches[0];
  throw new Error(
    "MAX personal Favorites could not be identified as /0 and All-folder list index 0. The runtime failed closed.",
  );
};

const inspectFavoritesSurface = (page) => page.evaluate(() => {
  const visible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 1
      && rect.height > 1
      && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
  const hasSelectionMarker = (node) => Boolean(node && (
    String(node.className || "").split(/\s+/u).includes("cell--selected")
    || node.getAttribute("aria-selected") === "true"
    || node.getAttribute("aria-current") === "true"
  ));
  const main = document.querySelector("main");
  const selectedRow = Array.from(document.querySelectorAll(
    'button[data-index="0"], a[data-index="0"], [role="button"][data-index="0"], '
    + '[role="option"][data-index="0"], [role="listitem"][data-index="0"], '
    + '[data-index="0"] button, [data-index="0"] a, [data-index="0"] [role="button"], '
    + '[data-index="0"] [role="option"], [data-index="0"] [role="listitem"]',
  )).find((candidate) => {
    if (!visible(candidate)) return false;
    const indexedRow = candidate.getAttribute("data-index") === "0"
      ? candidate
      : candidate.closest('[data-index="0"]');
    if (!indexedRow || normalize(indexedRow.querySelector("h3")?.textContent) !== "избранное") {
      return false;
    }
    // The home-list collector already accepts data-index on the interactive
    // row or an ancestor. Preserve that contract here and inspect the whole
    // exact index-zero row for the selected marker, without weakening the
    // route/title identity invariant.
    return hasSelectionMarker(candidate)
      || hasSelectionMarker(indexedRow)
      || Boolean(indexedRow.querySelector(
        '.cell--selected, [aria-selected="true"], [aria-current="true"]',
      ));
  });
  const header = main && Array.from(main.querySelectorAll(
    'button, [role="button"], h1, h2, h3, [role="heading"]',
  )).find((candidate) => {
    if (!visible(candidate)) return false;
    const label = normalize(candidate.getAttribute("aria-label"));
    const text = normalize(candidate.textContent);
    return (
      label.includes("избранное") && label.includes("открыть профиль")
    ) || (
      text.includes("избранное") && text.includes("сообщения для себя")
    );
  });
  const composer = main && Array.from(main.querySelectorAll(
    'textarea, [contenteditable="true"], [role="textbox"]',
  )).find(visible);
  const wrappers = Array.from(document.querySelectorAll('[class~="messageWrapper"]')).filter(visible);
  const regularMessages = wrappers.filter((wrapper) => !String(wrapper.className || "")
    .split(/\s+/u).includes("messageWrapper--control"));
  const control = wrappers.find((wrapper) => String(wrapper.className || "")
    .split(/\s+/u).includes("messageWrapper--control")
    && ["сохраните что-нибудь", "save something"].some((phrase) =>
      normalize(wrapper.textContent).includes(phrase)));
  return {
    path: window.location.pathname,
    identityReady: window.location.pathname === "/0" && Boolean(selectedRow && header),
    selectedRowVisible: Boolean(selectedRow),
    headerVisible: Boolean(header),
    composerVisible: Boolean(composer),
    controlVisible: Boolean(control),
    regularMessageCount: regularMessages.length,
  };
});

const waitForFavoritesHistory = async (page, timeoutMs) => {
  const deadline = Date.now() + Math.min(timeoutMs, MAX_UI_READY_TIMEOUT_MS);
  let state = await inspectFavoritesSurface(page);

  // MAX first paints the selected conversation shell and hydrates its history
  // asynchronously. Do not classify the chat from the sidebar preview or from
  // the early composer-only frame: both appear before real saved messages.
  if (state.identityReady && state.regularMessageCount > 0) {
    return { state, emptyState: null };
  }
  while (Date.now() < deadline) {
    if (state.identityReady && state.regularMessageCount > 0) {
      return { state, emptyState: null };
    }
    await page.waitForTimeout(250);
    state = await inspectFavoritesSurface(page);
  }

  // The provider control “Сохраните что-нибудь” is present in every Favorites
  // history, including non-empty ones. It proves an empty chat only after the
  // exact /0 surface stayed open for the full hydration window and no ordinary
  // message wrapper appeared.
  if (state.identityReady && state.composerVisible && state.controlVisible) {
    return { state, emptyState: "favorites-empty" };
  }
  // These content-free fields are sufficient to distinguish a provider DOM
  // drift from slow history hydration on another OS. Never include chat text,
  // labels, HTML or a screenshot in the runtime error.
  const safeState = JSON.stringify({
    path: state.path,
    identityReady: state.identityReady,
    selectedRowVisible: state.selectedRowVisible,
    headerVisible: state.headerVisible,
    composerVisible: state.composerVisible,
    controlVisible: state.controlVisible,
    regularMessageCount: state.regularMessageCount,
  });
  throw new Error(
    `MAX Favorites history did not reach a verifiable loaded or empty state. Safe structural state: ${safeState}. The runtime failed closed; do not retry automatically.`,
  );
};

const inspectDirectChatHistorySurface = (page) => page.evaluate(() => {
  const main = document.querySelector("main");
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none"
      && style.visibility !== "hidden";
  };
  const histories = main && Array.from(main.querySelectorAll('[class~="history"]')).filter(visible);
  const history = histories?.length === 1 ? histories[0] : null;
  const profile = main && Array.from(main.querySelectorAll('button, [role="button"]'))
    .find((node) => visible(node) && /^Открыть профиль\s+/iu.test(node.getAttribute("aria-label") || ""));
  const composer = history && Array.from(history.querySelectorAll(
    'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  )).find(visible);
  // MAX's ordinary history renders .emptyHistory when lastMessageId is absent
  // and the pending queue is empty. The same class is used for blocked chats,
  // scheduled messages and pins, so require the direct-dialog placeholder in
  // the one visible conversation history, never a phrase anywhere on the page.
  const empty = history && Array.from(history.querySelectorAll('[class~="emptyHistory"]'))
    .some((node) => visible(node) && Array.from(node.querySelectorAll("span, p, h1, h2, h3, div"))
      .some((label) => visible(label) && ["сообщений пока нет", "no messages yet"]
        .includes((label.textContent || "").replace(/\s+/gu, " ").trim().toLowerCase())));
  const loading = history && (history.getAttribute("aria-busy") === "true" || Array.from(history.querySelectorAll(
    '[class~="loader"], [class~="spinner"], [role="progressbar"], [aria-busy="true"]',
  )).some(visible));
  // Count structural messages even if their text/geometry cannot be parsed.
  // A changed selector or an unrendered attachment must not become empty history.
  const messageNodes = main ? Array.from(main.querySelectorAll(
    '[class~="messageWrapper"], [data-message-id], [class~="message"]',
  )).filter((node) => !node.classList.contains("messageWrapper--control")) : [];
  return {
    directRoute: /^\/(?:[1-9]\d*|u\/[A-Za-z0-9_-]+)\/?$/u.test(window.location.pathname),
    headerVisible: Boolean(profile),
    historyVisible: Boolean(history),
    composerVisible: Boolean(composer),
    emptyPlaceholderVisible: Boolean(empty),
    loading: Boolean(loading),
    messageNodeCount: messageNodes.length,
  };
});

const waitForDirectChatHistory = async (page, opened, options) => {
  const expectedUrl = normalizeChatUrl(opened.url);
  const deadline = Date.now() + Math.min(options.timeoutMs, MAX_UI_READY_TIMEOUT_MS);
  let state;
  for (;;) {
    assertDocumentAvailable(page);
    // Identity is rechecked throughout hydration, including the final empty
    // decision. A phone lookup, saved locator or matching title alone proves
    // neither an empty conversation nor permission to select another person.
    let sameChat = false;
    try { sameChat = normalizeChatUrl(page.url()) === expectedUrl; } catch { /* Home is not a chat. */ }
    if (!sameChat) throw new MaxRuntimeError("MAX_CHAT_IDENTITY_UNVERIFIED",
      "MAX changed the requested chat while loading history. No message action was started.",
      { reason: "history-chat-changed", finalMutationActionStarted: false });
    state = await inspectDirectChatHistorySurface(page);
    const hasMessages = (await visibleMessages(page, 1)).length > 0;
    try { sameChat = normalizeChatUrl(page.url()) === expectedUrl; } catch { sameChat = false; }
    if (!sameChat) throw new MaxRuntimeError("MAX_CHAT_IDENTITY_UNVERIFIED",
      "MAX changed the requested chat while loading history. No message action was started.",
      { reason: "history-chat-changed", finalMutationActionStarted: false });
    if (hasMessages) return null;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  // Wait the full bounded hydration window even when the placeholder is
  // already painted. Ordinary messages arriving during that window take
  // precedence over the early empty frame; composer-only shells fail closed.
  if (state.directRoute && state.headerVisible && state.historyVisible
    && state.composerVisible && state.emptyPlaceholderVisible && !state.loading
    && state.messageNodeCount === 0) return "direct-chat-empty";
  throw new MaxRuntimeError("MAX_UI_UNSUPPORTED",
    "MAX message history did not expose recognized messages or a verified empty direct dialog. Keep the dedicated profile.",
    { reason: "history-empty-unverified", ...state, finalMutationActionStarted: false });
};

const collectDialogResults = (page, query = "", unreadOnly = false) => page.evaluate(({ needle, onlyUnread }) => {
  document.querySelectorAll("[data-trelio-max-dialog]").forEach((node) => {
    node.removeAttribute("data-trelio-max-dialog");
  });
  const normalized = String(needle || "").normalize("NFKC").toLowerCase().trim();
  const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], [role="option"], [role="listitem"]'));
  const results = [];
  for (const node of nodes) {
    const visibleLines = String(node.innerText || "")
      .split(/\n+/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const text = visibleLines.join(" ");
    // MAX search can return several messages from one dialog. De-duplicate by
    // its canonical link when available, while preserving different chats or
    // contacts that happen to use the same visible title.
    const titleNode = node.querySelector('h3, [role="heading"][aria-level="3"]')
      || (normalized ? node.querySelector('[class~="cell"] > [class~="title"] [class~="name"]') : null);
    const title = (
      titleNode?.textContent
      || visibleLines.find((line) => line.length <= 160)
      || ""
    ).replace(/\s+/gu, " ").trim();
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const link = node.matches("a[href]") ? node : node.closest("a[href]") || node.querySelector("a[href]");
    let url = null;
    try {
      const candidate = link?.getAttribute("href") || "";
      const parsed = candidate ? new URL(candidate, window.location.origin) : null;
      const canonicalPath = parsed
        && (/^\/-?\d+\/?$/u.test(parsed.pathname) || /^\/u\/[A-Za-z0-9_-]+\/?$/u.test(parsed.pathname));
      if (
        parsed
        && canonicalPath
        && !parsed.search
        && !parsed.hash
        && ["https://web.max.ru", "https://max.ru"].includes(parsed.origin)
      ) {
        parsed.protocol = "https:";
        parsed.host = "web.max.ru";
        url = parsed.toString();
      }
    } catch {
      url = null;
    }
    // Folder buttons and avatarBadgeWrapper used to masquerade as unread
    // dialogs. A chat must have its own title (not a nested action's title)
    // or canonical chat link. Never infer unread from arbitrary digits in
    // an accessible name: they can be an address, a date or a preview.
    const titleOwner = titleNode?.closest('a, button, [role="button"], [role="option"], [role="listitem"]');
    if ((!titleNode || titleOwner !== node) && !url) continue;
    const indicators = Array.from(node.querySelectorAll(
      '[aria-label], [class*="unread" i], [class*="badge" i]',
    )).filter((indicator) => {
      const label = indicator.getAttribute("aria-label") || "";
      const classes = String(indicator.className || "");
      return /непрочитан|unread|нов(?:ое|ых|ые) сообщ|new messages?/iu.test(label)
        || /(?:^|\s)(?:unread|unread[-_][^\s]*|badge)(?:\s|$)/iu.test(classes);
    });
    const unreadLabel = indicators.map((indicator) =>
      indicator.getAttribute("aria-label") || indicator.textContent || "",
    ).join(" ");
    const unreadMatch = unreadLabel.match(/(?:^|[^\d])(\d{1,6})(?:\s*\+)?(?:\s|$)/u);
    const isUnread = indicators.length > 0 && (!unreadMatch || Number(unreadMatch[1]) > 0);
    const unreadCount = unreadMatch ? Number(unreadMatch[1]) : isUnread ? null : 0;
    if (!text || !title || (normalized && !title.toLowerCase().includes(normalized))) continue;
    if (onlyUnread && !isUnread) continue;
    if (rect.width < 20 || rect.height < 10 || style.display === "none" || style.visibility === "hidden") continue;
    const identity = (url || title).toLocaleLowerCase("ru-RU");
    // Distinct chats may share a title. Only a provider URL proves sameness;
    // keeping ambiguous titles lets the exact action resolver fail closed.
    if (url && results.some((item) => item.url === url)) continue;
    node.setAttribute("data-trelio-max-dialog", String(results.length));
    results.push({
      index: results.length,
      identity,
      title,
      text,
      url,
      listIndex: node.closest("[data-index]")?.getAttribute("data-index") || null,
      stableId: url?.match(/\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/u)?.[1] || null,
      isUnread,
      unreadCount,
    });
    if (results.length >= 100) break;
  }
  return results;
}, { needle: query, onlyUnread: unreadOnly });

const inspectPhoneLookupOutcome = (page) => page.evaluate(() => {
  const visible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const box = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return box.width > 1 && box.height > 1
      && style.display !== "none" && style.visibility !== "hidden";
  };
  const path = window.location.pathname;
  const main = document.querySelector("main");
  const header = main && Array.from(main.querySelectorAll("header h1, header h2, header h3, header button, [class*='header' i] h3"))
    .find(visible);
  const composer = main && Array.from(main.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
    .find(visible);
  const notices = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"]'))
    .filter(visible)
    .map((node) => String(node.textContent || "").replace(/\s+/gu, " ").trim());
  return {
    path,
    chatReady: /^\/(?:u\/[A-Za-z0-9_-]+|-?\d+)\/?$/u.test(path)
      && path !== "/0" && Boolean(header || composer),
    title: header?.textContent?.replace(/\s+/gu, " ").trim() || null,
    notFoundOrPrivate: notices.some((text) =>
      /(?:не найден|не удалось найти|нет пользователя|ничего не найдено|not found)/iu.test(text)),
  };
});

/**
 * MAX exposes an explicit “Find by number” action in chat search. A normal
 * title search cannot verify a phone: its returned title often contains only
 * a person's name. Require the provider action and a loaded canonical chat
 * route before reporting a match, and never treat an empty search list as proof
 * that the number is unregistered.
 */
const lookupContactByPhone = async (page, options, phone) => {
  const search = await findSearchInput(page, options.timeoutMs);
  await fillLocator(search, phone, page);
  await page.waitForTimeout(800);
  const findAction = page.getByRole("button", { name: /^найти по номеру(?:\s|$)|^find by phone(?:\s|$)/iu });
  if (await findAction.count() !== 1 || !await findAction.isVisible().catch(() => false)) {
    throw new Error("Could not safely identify the MAX Find by number action. The runtime failed closed; do not interpret ordinary contact search as phone verification.");
  }
  await findAction.click({ timeout: options.timeoutMs });
  await page.waitForTimeout(500);

  // Some MAX layouts open a separate phone-entry dialog after the search
  // action. Fill only its phone field and exact Continue control; do not use
  // the chat composer or a general submit button as a fallback.
  const phoneInputs = page.locator('input[type="tel"], input[placeholder*="номер телефона" i], input[aria-label*="номер телефона" i]');
  const visiblePhoneInputs = [];
  for (let index = 0; index < await phoneInputs.count(); index += 1) {
    const input = phoneInputs.nth(index);
    if (await input.isVisible().catch(() => false)) visiblePhoneInputs.push(input);
  }
  if (visiblePhoneInputs.length > 1) {
    throw new Error("Could not safely identify one MAX phone lookup field.");
  }
  if (visiblePhoneInputs.length === 1) {
    await fillLocator(visiblePhoneInputs[0], phone, page);
    const proceed = page.getByRole("button", { name: /^(?:продолжить|continue)$/iu });
    if (await proceed.count() !== 1 || !await proceed.isVisible().catch(() => false)) {
      throw new Error("Could not safely identify the MAX phone lookup Continue action.");
    }
    await proceed.click({ timeout: options.timeoutMs });
  }

  const deadline = Date.now() + Math.min(options.timeoutMs, MAX_UI_READY_TIMEOUT_MS);
  let outcome = await inspectPhoneLookupOutcome(page);
  while (!outcome.chatReady && !outcome.notFoundOrPrivate && Date.now() < deadline) {
    assertDocumentAvailable(page);
    await page.waitForTimeout(250);
    outcome = await inspectPhoneLookupOutcome(page);
  }
  assertDocumentAvailable(page);
  if (!outcome.chatReady && outcome.notFoundOrPrivate) {
    return { query: phone, contacts: [], lookupState: "not_found_or_private",
      coverage: { complete: true, scope: "provider-phone-lookup" } };
  }
  if (!outcome.chatReady) {
    // This is an inspected but unsupported provider surface, not proof that
    // the number is absent. A read-only worker can keep its fenced search
    // window open for inspection instead of crashing with a generic error.
    // Transport/HTTP errors above retain their own classifications.
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED",
      "MAX Find by number did not expose a verifiable contact or an explicit unavailable result. The runtime failed closed.",
      { reason: "phone-lookup-outcome-unverified", finalMutationActionStarted: false });
  }
  const url = normalizeChatUrl(page.url());
  rememberChatReference(options, { url, title: outcome.title, lookupPhone: phone });
  return {
    query: phone,
    contacts: [{ title: outcome.title, url, matchMethod: "provider-phone-lookup" }],
    lookupState: "matched",
    coverage: { complete: true, scope: "provider-phone-lookup" },
  };
};

const positionHomeDialogList = (page, reset) => page.evaluate((goToStart) => {
  const heading = document.querySelector("button h3");
  let scroller = heading?.parentElement;
  while (scroller && scroller !== document.body) {
    if (/auto|scroll/u.test(getComputedStyle(scroller).overflowY)) break;
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === document.body) return { atEnd: true, scrollable: false };
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  if (goToStart) scroller.scrollTop = 0;
  else if (!atEnd) scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.8);
  return { atEnd: goToStart ? false : atEnd, scrollable: true };
}, reset);

/**
 * Enumerate the home list without opening a conversation. MAX virtualizes it,
 * so one DOM snapshot cannot promise account-wide coverage. Walk the list in
 * bounded viewport steps and retain the provider's list index across renders.
 * Folder badges count unmuted chats and are deliberately not used as totals.
 */
const collectHomeDialogs = async (page, options) => {
  const allFolder = page.getByRole("button", { name: /^Все(?:\s|,|$)/u });
  if (await allFolder.count() !== 1) {
    throw new Error("MAX chat list could not be identified: the All folder is missing or ambiguous. Keep the dedicated MAX profile; do not switch browsers or repeat login.");
  }
  await allFolder.click({ timeout: options.timeoutMs });
  // Search readiness alone does not establish that the asynchronous list has
  // loaded. An unknown/empty shell must never turn into 'no unread messages'.
  await page.waitForFunction(() => Array.from(document.querySelectorAll("button h3"))
    .some((heading) => heading.getBoundingClientRect().width > 0), null,
  { timeout: Math.min(options.timeoutMs, MAX_UI_READY_TIMEOUT_MS) }).catch(() => {
    throw new Error("MAX chat list has no recognized rows. Empty account state is not verified; do not report zero unread chats.");
  });
  await positionHomeDialogList(page, true);
  await page.waitForTimeout(150);
  const dialogs = [];
  const seen = new Set();
  let complete = false;
  for (let step = 0; step < 30; step += 1) {
    const rows = await collectDialogResults(page);
    for (const row of rows) {
      const key = row.url || (row.listIndex !== null ? `list:${row.listIndex}` : `visible:${row.index}:${row.title}`);
      if (seen.has(key)) continue;
      seen.add(key);
      dialogs.push(row);
    }
    const position = await positionHomeDialogList(page, false);
    if (position.atEnd) { complete = true; break; }
    if (dialogs.length >= options.limit) break;
    await page.waitForTimeout(150);
  }
  return {
    dialogs: dialogs.slice(0, options.limit),
    coverage: { complete: complete && dialogs.length <= options.limit,
      scope: "all-folder", returned: Math.min(dialogs.length, options.limit),
      limit: options.limit, snapshotStable: false },
  };
};

const openHomeDialogResult = async (page, selected, options) => {
  // collectHomeDialogs may finish at the bottom of MAX's virtualized list, so
  // its original DOM marker is not stable. Rewind and locate the exact row by
  // provider list index; title-only fallback is allowed only when one visible
  // row matches, preserving the duplicate-title guard established above.
  await positionHomeDialogList(page, true);
  await page.waitForTimeout(150);
  for (let step = 0; step < 30; step += 1) {
    const rows = await collectDialogResults(page);
    const matches = rows.filter((row) => selected.listIndex !== null
      ? row.listIndex === selected.listIndex
      : normalizeDialogTitle(row.title) === normalizeDialogTitle(selected.title));
    if (matches.length === 1) {
      await page.locator(`[data-trelio-max-dialog="${matches[0].index}"]`)
        .click({ timeout: options.timeoutMs });
      return;
    }
    if (matches.length > 1) {
      throw new Error(
        `MAX home dialog became ambiguous while opening: ${selected.title}. Use an official chat URL.`,
      );
    }
    const position = await positionHomeDialogList(page, false);
    if (position.atEnd) break;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `MAX home dialog disappeared before it could be opened: ${selected.title}. Reread the live dialog list before retrying.`,
  );
};

const normalizeChatUrl = (reference) => {
  if (typeof reference !== "string" || reference.length > 2048) throw new Error("MAX chat URL is too long or invalid.");
  const url = new URL(reference, MAX_WEB_URL);
  const numeric = /^\/-?\d+\/?$/u.test(url.pathname);
  const contact = /^\/u\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname);
  // The official Goskey public page links directly to this exact web route.
  // Accepting that provider-owned identity fixes the signing workflow without
  // opening every arbitrary top-level path or trusting a matching chat title.
  // openChat still requires the same canonical URL and a ready message surface.
  const goskeyBot = /^\/goskey_bot\/?$/u.test(url.pathname);
  if (url.username || url.password || ![MAX_WEB_ORIGIN, "https://max.ru"].includes(url.origin) || (!numeric && !contact && !goskeyBot) || url.search || url.hash) {
    throw new Error("MAX chat URL must be an official numeric, /u/ contact or exact Goskey bot URL.");
  }
  url.protocol = "https:";
  url.host = "web.max.ru";
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString();
};

const isFavoritesReference = (reference) => {
  if (normalizeDialogTitle(reference) === "избранное") return true;
  try {
    return normalizeChatUrl(reference) === MAX_FAVORITES_URL;
  } catch {
    return false;
  }
};

const openFavoritesChat = async (page, options) => {
  await page.goto(MAX_FAVORITES_URL, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  assertDocumentAvailable(page);
  let uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  if (!uiReady) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    assertDocumentAvailable(page);
    uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
  }
  if (!uiReady) throw new Error("MAX Favorites rendered no visible interactive UI after one controlled reload.");
  await assertLoggedIn(page);

  let method = "favorites-url";
  let fallback = null;
  let surface = await inspectFavoritesSurface(page);
  if (!surface.identityReady && surface.path === "/0") {
    // A direct deep link can still be hydrating or about to canonicalize back
    // to home. Give identity a short bounded chance before deciding whether the
    // provider-owned list-row fallback is required.
    const identityDeadline = Date.now() + Math.min(options.timeoutMs, 3_000);
    while (!surface.identityReady && surface.path === "/0" && Date.now() < identityDeadline) {
      await page.waitForTimeout(150);
      surface = await inspectFavoritesSurface(page);
    }
  }
  if (!surface.identityReady && surface.path !== "/") {
    throw new Error("MAX /0 did not open or return to the authenticated home surface.");
  }
  if (!surface.identityReady) {
    // The current MAX SPA can canonicalize a direct /0 navigation back to `/`
    // without selecting the conversation. Its server-rendered home buttons are
    // visible before Svelte attaches the click handlers, so wait through the
    // bounded hydration interval before the one allowed interaction. A quick
    // click on the initial “Сохраните что-нибудь” preview is silently ignored.
    await page.waitForTimeout(Math.min(options.timeoutMs, 5_000));
    const snapshot = await collectHomeDialogs(page, { ...options, limit: 100 });
    const favorites = selectFavoritesHomeDialog(snapshot);
    await openHomeDialogResult(page, favorites, options);
    method = "favorites-url-with-home-fallback";
    fallback = "all-folder-index-0";
  }
  const history = await waitForFavoritesHistory(page, options.timeoutMs);
  return {
    method,
    url: MAX_FAVORITES_URL,
    observedUrl: page.url(),
    fallback,
    emptyState: history.emptyState,
  };
};

const openChat = async (page, options) => {
  if (isFavoritesReference(options.chat)) {
    return openFavoritesChat(page, options);
  }
  if (!/^https?:\/\//iu.test(options.chat) && !/^-?\d+$/u.test(options.chat)) {
    const savedUrl = contextChatReference(options);
    if (savedUrl) {
      // A task binding can resume a previously identified conversation despite
      // a new namesake. It does not participate in mutation target resolution.
      return { ...(await openChat(page, { ...options, chat: savedUrl })),
        method: "task-context", matched: options.chat };
    }
  }
  if (/^https?:\/\//iu.test(options.chat) || /^-?\d+$/u.test(options.chat)) {
    const expectedUrl = normalizeChatUrl(options.chat);
    await page.goto(expectedUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    // Direct deep links can restore an empty SPA just like the home route.
    // A matching URL and elapsed delay are not evidence of an opened chat.
    assertDocumentAvailable(page);
    let uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
    if (!uiReady) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
      assertDocumentAvailable(page);
      uiReady = await waitForVisibleMaxUi(page, options.timeoutMs);
    }
    if (!uiReady) throw new Error("MAX chat rendered no visible interactive UI after one controlled reload.");
    await assertLoggedIn(page);
    let observedUrl = null;
    try { observedUrl = normalizeChatUrl(page.url()); } catch { /* Home is not a chat URL. */ }
    let method = "url";
    if (observedUrl !== expectedUrl) {
      // MAX can discard a cold deep link for a new contact that has no saved
      // conversation yet. A forged history URL or a title search would not
      // prove that the requested person is open. Recover only from our own
      // official lookup locator, in the same guarded browser and namespace.
      const home = page.url() === MAX_WEB_URL;
      const phone = home && loadChatReferences(options).chats
        .find((chat) => chat.url === expectedUrl)?.lookupPhone;
      if (!phone) throw new MaxRuntimeError("MAX_UI_UNSUPPORTED",
        "MAX did not open the exact requested chat URL. If MAX returned home after a phone lookup, repeat contacts with the original phone, then use its exact URL.",
        { reason: home ? "deep-link-returned-home" : "unexpected-chat-route", finalMutationActionStarted: false });
      const recovered = await lookupContactByPhone(page, options, phone);
      if (recovered.lookupState !== "matched" || recovered.contacts.length !== 1
        || recovered.contacts[0].url !== expectedUrl || page.url() !== expectedUrl) {
        throw new MaxRuntimeError("MAX_CHAT_IDENTITY_UNVERIFIED",
          "MAX phone lookup no longer opens the exact requested chat. No message action was started.",
          { reason: "phone-lookup-target-changed", finalMutationActionStarted: false });
      }
      method = "url-with-phone-lookup";
    }
    await page.waitForFunction(() => document.querySelector('[class~="messageWrapper"], [data-message-id], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], textarea'),
      null, { timeout: Math.min(options.timeoutMs, MAX_UI_READY_TIMEOUT_MS) });
    // Recheck after hydration: a matching route before the wait must not
    // authorize a message operation if the SPA changed chats in the meantime.
    const reference = await inspectOpenedChatReference(page);
    if (reference?.url !== expectedUrl) throw new MaxRuntimeError("MAX_CHAT_IDENTITY_UNVERIFIED",
      "MAX did not expose a ready surface for the exact requested chat.",
      { reason: "chat-surface-unverified", finalMutationActionStarted: false });
    return { method, url: expectedUrl };
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
  await page.locator(`[data-trelio-max-dialog="${selected.index}"]`).click({ timeout: options.timeoutMs });
  await page.waitForTimeout(2_000);
  const openedUrl = page.url();
  const chatUrlOpened = openedUrl !== MAX_WEB_URL && openedUrl !== MAX_WEB_ORIGIN;
  const messageSurfaceVisible = (await visibleMessages(page, 1)).length > 0;
  const composerVisible = await findComposer(page).then(() => true).catch(() => false);
  if (!chatUrlOpened && !messageSurfaceVisible && !composerVisible) {
    throw new Error(
      "MAX dialog click had no verifiable effect. The runtime failed closed; do not send or retry automatically.",
    );
  }
  return { method: "search", matched: selected.title, url: openedUrl };
};

const loadHistoryPages = async (page, pages, timeoutMs) => {
  let loadedPages = 1;
  for (let pageIndex = 1; pageIndex < pages; pageIndex += 1) {
    const scrolled = await page.evaluate(() => {
      const message = Array.from(document.querySelectorAll(
        '[data-message-id], [data-testid*="message" i], [class*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
      )).find((node) => node instanceof HTMLElement && (node.innerText || node.textContent || "").trim());
      if (!(message instanceof HTMLElement)) return false;
      let container = message.parentElement;
      while (container && container !== document.body) {
        const style = window.getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight + 40 && /auto|scroll/u.test(style.overflowY)) {
          const before = container.scrollHeight;
          container.scrollTop = 0;
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
          container.setAttribute("data-trelio-max-history-height", String(before));
          return true;
        }
        container = container.parentElement;
      }
      return false;
    });
    if (!scrolled) break;
    await page.waitForTimeout(Math.min(2_000, Math.max(600, Math.round(timeoutMs / 30))));
    const grew = await page.evaluate(() => {
      const container = document.querySelector('[data-trelio-max-history-height]');
      if (!(container instanceof HTMLElement)) return false;
      const previous = Number(container.getAttribute("data-trelio-max-history-height") || 0);
      container.removeAttribute("data-trelio-max-history-height");
      return container.scrollHeight > previous;
    });
    loadedPages += 1;
    if (!grew) break;
  }
  return loadedPages;
};

const visibleMessages = async (page, limit) => {
  const rawMessages = await page.evaluate((maxCount) => {
  document.querySelectorAll("[data-trelio-max-message]").forEach((node) => {
    node.removeAttribute("data-trelio-max-message");
  });
  // MAX nests multiple .message elements inside one messageWrapper. Taking
  // all of them duplicates each message and can return list previews instead
  // of conversation history. Prefer exactly one outer wrapper per message.
  const wrappers = Array.from(document.querySelectorAll('[class~="messageWrapper"]'))
    // Provider controls use the same outer class as real messages. In
    // Favorites, “Сохраните что-нибудь” is a permanent helper card even when
    // saved messages exist, so it must never enter the returned history.
    .filter((node) => !String(node.className || "").split(/\s+/u).includes("messageWrapper--control"));
  const candidates = wrappers.length ? wrappers : Array.from(document.querySelectorAll('[data-message-id]'));
  const nodes = candidates.filter((node) => !candidates.some((parent) => parent !== node && parent.contains(node)));
  const results = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const text = (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || rect.width < 40 || rect.height < 12) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (window.innerWidth >= 900 && rect.right < window.innerWidth * 0.28) continue;
    const providerMessageId = [
      node.getAttribute("data-message-id"),
      node.getAttribute("data-id"),
      node.id?.match(/(?:message|msg)[-_:]?([A-Za-z0-9_-]+)/iu)?.[1],
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id"),
    ].find(Boolean) || null;
    const authorNode = node.querySelector(
      '[data-testid*="author" i], [data-testid*="sender" i], [class*="author" i], [class*="sender" i], [class*="name" i]',
    );
    const timeNode = node.querySelector(
      'time, [class*="time" i], [data-testid*="time" i], [class~="meta"] [class~="text"], [class~="meta"]',
    );
    const replyNode = node.querySelector(
      '[class*="reply" i], [class*="replied" i], [class*="quote" i], '
      + '[data-testid*="reply" i], [data-testid*="quote" i], '
      + '[aria-label*="ответ" i], [aria-label*="reply" i], blockquote',
    );
    // A file card can expose its type icon ("TXT") as the only element with
    // a file-like class while the actual filename is a sibling. The outer
    // message text is still scoped to this one attachment-bearing message.
    // Use it only when the candidate has no useful name; do not infer files
    // from ordinary text messages without an attachment control.
    const filenameInMessage = text.match(/(?:^|\s)([^\s<>/\\]+\.[A-Za-z][A-Za-z0-9]{1,7})(?=\s|$)/u)?.[1] || null;
    const attachments = Array.from(node.querySelectorAll(
      'a[download], [aria-label*="скач" i], [aria-label*="download" i], [class*="attachment" i], [class*="file" i], img, video, audio',
    )).slice(0, 20).map((attachment, index) => ({
      index: index + 1,
      name: attachment.getAttribute("download")
        || attachment.getAttribute("aria-label")
        || attachment.getAttribute("alt")
        || attachment.getAttribute("title")
        || attachment.querySelector('[class*="filename" i], [class*="file-name" i]')?.textContent?.replace(/\s+/gu, " ").trim()
        || (filenameInMessage && /^(?:txt|pdf|docx?|xlsx?|zip|rar|7z|скачать|download)$/iu.test(attachment.textContent?.trim() || "") ? filenameInMessage : null)
        || attachment.textContent?.replace(/\s+/gu, " ").trim()
        || null,
      href: attachment instanceof HTMLAnchorElement ? attachment.href : null,
      kind: attachment.tagName.toLowerCase(),
    }));
    const author = authorNode?.textContent?.replace(/\s+/gu, " ").trim() || null;
    const timestamp = timeNode?.getAttribute("datetime")
      || timeNode?.getAttribute("title")
      || timeNode?.textContent?.replace(/\s+/gu, " ").trim()
      || null;
    const isOutgoing = node.matches('[data-outgoing="true"], [data-is-out="true"]')
      || node.querySelector('[data-bubbles-variant="outgoing"]') !== null
      || /(?:^|\s)(?:outgoing|message-out|is-out|viewer|[^\s]*--isout)(?:\s|$)/iu.test(node.className || "")
      || /вы:|you:/iu.test(author || "");
    // In the current MAX reply card, the quoted sender can be marked with a
    // generic "name" class while the quote container has no reply/quote
    // class at all. Only an outgoing message with a distinct sender block may
    // use the smallest ancestor that contains both that sender and quote text;
    // a whole-message ancestor would also include the new reply and is unsafe.
    let structuralReplyText = null;
    if (!replyNode && isOutgoing && authorNode && author) {
      for (let parent = authorNode.parentElement; parent && parent !== node; parent = parent.parentElement) {
        const candidate = (parent.innerText || parent.textContent || "").replace(/\s+/gu, " ").trim();
        if (candidate.length > author.length && candidate.length < text.length
          && candidate.startsWith(author) && text.startsWith(candidate)) {
          structuralReplyText = candidate;
          break;
        }
      }
    }
    // Repeated identical text without a provider ID can be two real messages.
    // Only provider identity proves duplication; never collapse by body/time.
    if (providerMessageId && seen.has(providerMessageId)) continue;
    if (providerMessageId) seen.add(providerMessageId);
    node.setAttribute("data-trelio-max-message", String(results.length));
    results.push({
      index: results.length,
      providerMessageId,
      author,
      timestamp,
      text,
      isOutgoing,
      replyText: replyNode?.textContent?.replace(/\s+/gu, " ").trim() || structuralReplyText,
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
      // Direct chats often omit both provider ID and author in the DOM. A
      // read snapshot still supplies an exact text selector; asking the agent
      // to add the chat title as author makes that valid target unmatchable.
      // Keep every supplied constraint fail-closed rather than silently
      // dropping it or treating a local hash/index as a provider identity.
      `${reason} exact MAX messages matched the requested target. Read the exact chat again. `
      + "Use --message-id only with its non-null providerMessageId; messageKey and index are not provider IDs. "
      + "Otherwise copy the complete returned message.text into --target-text, including file controls and time. "
      + "Add --target-author only when that message has a non-null author; never infer it from the chat title. "
      + "Several identical messages remain ambiguous; do not select one by position.",
    );
  }
  const target = page.locator(`[data-trelio-max-message="${matches[0].index}"]`);
  if (await target.count() !== 1) {
    throw new Error("The exact MAX message disappeared before the action. Read the chat again and retry once.");
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
  throw new Error(`Could not safely identify the MAX action: ${label}`);
};

const inspectMemberRemovalSurface = (page) => page.evaluate(() => {
  // Return only bounded generic UI actions from the conversation pane after
  // selecting the exact member. This helps identify provider wording changes
  // without exposing chat messages, other contacts, or the selected name.
  const actionPattern = /^(?:ещ[её]|more|дополнительно|additional|меню|menu|удалить(?:\s+из\s+(?:чата|группы|беседы)|\s+участника)?|исключить(?:\s+из\s+(?:чата|группы|беседы))?|remove(?:\s+(?:member|participant))?|kick|открыть\s+профиль|open\s+profile)$/iu;
  const actions = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
    .filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 4 && rect.height > 4 && rect.x >= window.innerWidth * 0.35
        && style.display !== "none" && style.visibility !== "hidden";
    })
    .map((node) => (node.getAttribute("aria-label") || node.innerText || node.textContent || "")
      .replace(/\s+/gu, " ").trim())
    .filter((label) => label.length <= 60 && actionPattern.test(label));
  // MAX sometimes renders menu rows as plain divs without button/menuitem
  // roles. Inspect action elements and text leaves only inside the visible
  // menu, and replace every
  // word outside a fixed action vocabulary before it leaves the browser. A
  // contact name or arbitrary chat text can therefore never enter diagnostics.
  const safeWords = new Set([
    "ещё", "еще", "more", "удалить", "исключить", "убрать", "remove", "kick",
    "из", "чата", "группы", "беседы", "участника", "участников", "пользователя",
    "контакт", "контакта", "member", "participant", "from", "chat", "group",
    "покинуть", "leave", "заблокировать", "block", "пожаловаться", "report",
  ]);
  const menus = Array.from(document.querySelectorAll('[role="menu"]'))
    .filter((node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 4);
  const menuCandidates = menus.flatMap((menu) => Array.from(menu.querySelectorAll("*"))
    .filter((node) => node instanceof HTMLElement && (node.childElementCount === 0
      || node.matches('button, [role="button"], [role="menuitem"]'))));
  const menuActions = [...new Set(menuCandidates.map((node) => (
    node.getAttribute("aria-label") || node.textContent || ""
  ).normalize("NFKC").replace(/\s+/gu, " ").trim()).filter(Boolean).map((label) => (
    label.toLocaleLowerCase("ru-RU").match(/[\p{L}]+/gu) || []
  ).slice(0, 8).map((word) => safeWords.has(word) ? word : "[другое]").join(" ")))]
    .filter(Boolean).slice(0, 12);
  return {
    actionLabels: [...new Set(actions)].slice(0, 12),
    visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 4).length,
    visibleMenus: menus.length,
    menuCandidateCount: menuCandidates.length,
    menuActions,
  };
});

const openSelectedMemberRowMore = async (page, memberIndex, timeoutMs) => {
  const row = page.locator(`[data-trelio-max-member="${memberIndex}"]`);
  await row.hover({ timeout: timeoutMs });
  await page.waitForTimeout(250);
  const surface = await page.evaluate((index) => {
    document.querySelectorAll('[data-trelio-max-member-row-more]').forEach((node) => {
      node.removeAttribute('data-trelio-max-member-row-more');
    });
    const selected = document.querySelector(`[data-trelio-max-member="${index}"]`);
    if (!(selected instanceof HTMLElement)) return { count: 0, actionLabels: [] };
    const rowBox = selected.getBoundingClientRect();
    const actionLabels = [];
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((node) => {
        if (!(node instanceof HTMLElement) || node === selected) return false;
        const box = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const overlap = box.y < rowBox.y + rowBox.height && box.y + box.height > rowBox.y;
        const onRight = box.x >= rowBox.x + rowBox.width * 0.6
          && box.x < rowBox.x + rowBox.width + 32;
        if (!overlap || !onRight || box.width < 8 || box.width > 160
          || box.height < 8 || box.height > rowBox.height
          || style.display === "none" || style.visibility === "hidden") return false;
        const label = (node.getAttribute("aria-label") || node.innerText || node.textContent || "")
          .replace(/\s+/gu, " ").trim();
        // The row contains a person's name. Only fixed generic controls may
        // leave the browser in the failure details.
        actionLabels.push(/^(?:ещ[её]|more|меню|menu|удалить|исключить|убрать)$/iu.test(label)
          ? label.toLocaleLowerCase("ru-RU") : "[другое]");
        return /^(?:ещ[её]|more)$/iu.test(label);
      });
    if (candidates.length === 1) {
      candidates[0].setAttribute('data-trelio-max-member-row-more', 'true');
    }
    return { count: candidates.length, actionLabels: [...new Set(actionLabels)].slice(0, 8) };
  }, memberIndex);
  if (surface.count !== 1) {
    throw new MaxRuntimeError(
      "MAX_UI_UNSUPPORTED",
      "MAX did not expose one group-scoped More action on the selected participant row.",
      { finalMutationActionStarted: false, rowSurface: surface },
    );
  }
  await page.locator('[data-trelio-max-member-row-more="true"]').click({ timeout: timeoutMs });
  await page.waitForTimeout(400);
};

const clickRowMemberRemovalAction = async (page, timeoutMs) => {
  const menus = page.locator('[role="menu"]:visible');
  if (await menus.count() !== 1) {
    throw new MaxRuntimeError(
      "MAX_UI_UNSUPPORTED",
      "The selected participant row did not open one visible menu.",
      { finalMutationActionStarted: false, surface: await inspectMemberRemovalSurface(page) },
    );
  }
  const menu = menus.first();
  const exactRowDelete = /^(?:удалить|remove)$/iu;
  for (const pattern of [MEMBER_REMOVE_ACTION, exactRowDelete]) {
    const representations = [
      menu.getByRole("menuitem", { name: pattern }),
      menu.getByRole("button", { name: pattern }),
      menu.getByText(pattern),
    ];
    for (const representation of representations) {
      const count = await representation.count();
      if (count > 10) {
        throw new MaxRuntimeError(
          "MAX_UI_UNSUPPORTED",
          "MAX exposed too many matching actions in one participant-row menu.",
          { finalMutationActionStarted: false },
        );
      }
      const visible = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = representation.nth(index);
        if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) visible.push(candidate);
      }
      if (visible.length > 1) {
        throw new MaxRuntimeError(
          "MAX_UI_UNSUPPORTED",
          "MAX exposed multiple member-removal actions in one participant-row menu.",
          { finalMutationActionStarted: false, surface: await inspectMemberRemovalSurface(page) },
        );
      }
      if (visible.length === 1) {
        // The generic “Удалить” is accepted only within the menu opened from
        // the exact group-member row. A personal-profile or chat menu cannot
        // enter this helper through the surrounding group-scoped path.
        await visible[0].click({ timeout: timeoutMs });
        return;
      }
    }
  }
  throw new MaxRuntimeError(
    "MAX_UI_UNSUPPORTED",
    "MAX did not expose a removal action in the selected participant row's More menu.",
    { finalMutationActionStarted: false, surface: await inspectMemberRemovalSurface(page) },
  );
};

const confirmVisibleDialogAction = async (page, label, timeoutMs) => {
  const dialogs = page.getByRole("dialog");
  for (let index = (await dialogs.count()) - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!await dialog.isVisible({ timeout: 500 }).catch(() => false)) continue;
    const button = dialog.getByRole("button", { name: label }).last();
    if (!await button.count() || !await button.isVisible({ timeout: 500 }).catch(() => false)) {
      throw new Error(`MAX confirmation dialog did not expose the expected action: ${label}`);
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
  throw new Error("Could not safely identify the MAX participant/chat picker search field.");
};

const normalizeContactReference = (value) => {
  const raw = String(value || "").normalize("NFKC").trim();
  // MAX publishes bot profiles as max.ru/id..._bot, while human profile
  // references commonly use /u/<handle>. Both forms name one exact handle;
  // a URL with a different host, query or fragment is never treated as one.
  if (/^https:\/\//iu.test(raw)) {
    try {
      const url = new URL(raw);
      const handle = url.pathname.match(/^\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/u)?.[1];
      if (["max.ru", "web.max.ru"].includes(url.hostname)
        && url.protocol === "https:" && !url.search && !url.hash && handle) {
        return handle.toLocaleLowerCase("ru-RU");
      }
    } catch {
      // Invalid URLs stay unmatched; never guess an identity from their tail.
    }
  }
  return raw.replace(/^@/u, "").replace(/\/$/u, "")
    .replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
};

const selectExactContactResult = (results, reference) => {
  const expected = normalizeContactReference(reference);
  const identityReference = /^@/u.test(String(reference || "").trim())
    || /^https:\/\//iu.test(String(reference || "").trim());
  const matches = results.filter((result) => {
    const stableId = normalizeContactReference(result.stableId);
    if (identityReference) return stableId === expected;
    const title = normalizeContactReference(result.title);
    const textTokens = String(result.text || "")
      .split(/\s+/u)
      .map(normalizeContactReference);
    // Picker rows append presence text to the exact display name. Only a
    // recognized presence suffix may be ignored; arbitrary shared prefixes
    // remain ambiguous and cannot identify a different person.
    const suffix = title.startsWith(`${expected} `) ? title.slice(expected.length + 1) : "";
    const exactNameWithPresence = /^(?:был\(-а\) недавно|в сети|только что|\d+\s+(?:мин|ч) назад)$/iu.test(suffix);
    return stableId === expected || title === expected || exactNameWithPresence || textTokens.includes(expected);
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "No" : "Several";
    throw new Error(
      `${reason} exact MAX contacts matched ${reference}. Use the official /u/ profile URL or exact @username.`,
    );
  }
  return matches[0];
};

const collectPickerResults = (page) => page.evaluate(() => {
  document.querySelectorAll("[data-trelio-max-picker]").forEach((node) => {
    node.removeAttribute("data-trelio-max-picker");
  });
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width >= 20 && rect.height >= 10
      && style.display !== "none" && style.visibility !== "hidden";
  };
  const surfaceSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]';
  const dialogs = Array.from(document.querySelectorAll(surfaceSelector))
    .filter(visible);
  // Search fields can live in a custom modal without an ARIA dialog role.
  // Prefer the surface holding the focused search input over an older overlay.
  const dialog = document.activeElement?.closest(surfaceSelector) || dialogs.at(-1);
  if (!dialog) return [];
  // MAX also renders picker results as ordinary cells. Keep them inside the
  // active dialog: a cell in the chat list must never become a member choice.
  const selector = '[role="option"], [role="listitem"], button, a[href], [data-testid*="contact" i], [data-testid*="member" i], [class~="cell"]';
  const results = [];
  for (const node of dialog.querySelectorAll(selector)) {
    if (!visible(node)) continue;
    // A row may contain a nested profile link or button. Mark the outer row
    // once so one displayed bot cannot masquerade as two exact matches.
    const parent = node.parentElement?.closest(selector);
    if (parent && dialog.contains(parent)) continue;
    const text = String(node.innerText || node.textContent || "")
      .replace(/\s+/gu, " ").trim();
    if (!text || text.length > 500) continue;
    const link = node.matches("a[href]") ? node : node.querySelector("a[href]");
    let url = null;
    let linkedHandle = null;
    try {
      const candidate = link?.getAttribute("href");
      const parsed = candidate ? new URL(candidate, window.location.origin) : null;
      const handle = parsed?.pathname.match(/^\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/u)?.[1];
      if (parsed && ["max.ru", "web.max.ru"].includes(parsed.hostname)
        && parsed.protocol === "https:" && !parsed.search && !parsed.hash && handle) {
        url = parsed.toString();
        linkedHandle = handle;
      }
    } catch {
      // A malformed or external link cannot establish contact identity.
    }
    const mentionedHandle = (text.match(/(?:^|\s)@([A-Za-z0-9_.-]+)(?=\s|$)/u)
      || node.getAttribute("aria-label")?.match(/(?:^|\s)@([A-Za-z0-9_.-]+)(?=\s|$)/u))?.[1] || null;
    if (linkedHandle && mentionedHandle
      && linkedHandle.toLowerCase() !== mentionedHandle.toLowerCase()) continue;
    const stableId = linkedHandle || mentionedHandle;
    const rowLike = node.matches('[role="option"], [role="listitem"], [data-testid*="contact" i], [data-testid*="member" i], [class~="cell"]');
    if (!stableId && !rowLike) continue;
    // The badge is an independent provider cue. Its visible text need not be
    // the last token in the row, so do not infer bot identity from a name.
    const botBadge = Array.from(node.querySelectorAll('*')).some((child) =>
      child.childElementCount === 0 && /^(?:бот|bot)$/iu.test(
        String(child.getAttribute('aria-label') || child.textContent || '').trim(),
      ) && visible(child));
    node.setAttribute("data-trelio-max-picker", String(results.length));
    results.push({ index: results.length, title: text, text, url, stableId, botBadge });
    if (results.length >= 100) break;
  }
  return results;
});

const chooseExactPickerEntry = async (page, reference, timeoutMs) => {
  const input = await findPickerSearchInput(page, timeoutMs);
  const normalized = normalizeContactReference(reference);
  const exactBotHandle = /_bot$/iu.test(normalized)
    && (/^@/u.test(String(reference).trim()) || /^https:\/\//iu.test(String(reference).trim()));
  // MAX's group picker searches bot usernames only with the @ prefix. Its
  // result may expose the display name and Bot badge but no profile link.
  const queries = exactBotHandle ? [`@${normalized}`] : [normalized];
  if (!exactBotHandle && normalized.includes(" ")) queries.push(normalized.split(" ")[0]);
  let selected;
  let lastError;
  for (const query of queries) {
    await fillLocator(input, query, page);
    await page.waitForTimeout(1_200);
    const results = await collectPickerResults(page);
    try {
      selected = selectExactContactResult(results, reference);
      break;
    } catch (error) {
      // The exact @username query itself can establish the bot identity when
      // MAX returns one bot-labelled row without a stable href. Never extend
      // this inference to a plain name, multiple rows or a non-bot result.
      if (exactBotHandle && results.length === 1 && !results[0].stableId
        && (results[0].botBadge || /(?:^|\s)(?:бот|bot)\s*$/iu.test(results[0].title))) {
        selected = { ...results[0], verifiedSearchHandle: normalized };
        break;
      }
      lastError = error;
      if (!String(error?.message || "").startsWith("No exact MAX contacts matched ")) break;
    }
  }
  if (!selected) {
    // Selection fails before the final create/add action. Preserve that fact
    // explicitly so a missing bot can be inspected without guessing about a
    // mutation which was never started.
    if (lastError instanceof Error && /^(?:No|Several) exact MAX contacts matched /u.test(lastError.message)) {
      throw new MaxRuntimeError("MAX_PICKER_TARGET_UNRESOLVED", lastError.message, {
        finalMutationActionStarted: false,
      });
    }
    throw lastError;
  }
  await page.locator(`[data-trelio-max-picker="${selected.index}"]`).click({ timeout: timeoutMs });
  return selected;
};

const selectExactForwardDestination = (results, reference) => {
  // The forward picker contains chats, not people. Its rows do not expose
  // profile handles, so applying the contact matcher to a chat URL would
  // silently turn /0 into a search for a person named "0".
  const favorites = isFavoritesReference(reference);
  const expected = normalizeDialogTitle(reference);
  const matches = results.filter((result) => {
    const title = normalizeDialogTitle(result.title);
    if (favorites) return title === "избранное сообщения для себя";
    if (/^https?:\/\//iu.test(String(reference)) || /^-?\d+$/u.test(String(reference))) return false;
    return title === expected;
  });
  if (matches.length !== 1) {
    throw new MaxRuntimeError("MAX_PICKER_TARGET_UNRESOLVED",
      "MAX forward destination is not one exact verified chat in the picker.",
      { finalMutationActionStarted: false });
  }
  return matches[0];
};

const chooseExactForwardDestination = async (page, reference, timeoutMs) => {
  const input = await findPickerSearchInput(page, timeoutMs);
  await fillLocator(input, isFavoritesReference(reference) ? "Избранное" : reference, page);
  await page.waitForTimeout(1_200);
  const selected = selectExactForwardDestination(await collectPickerResults(page), reference);
  await page.locator(`[data-trelio-max-picker="${selected.index}"]`).click({ timeout: timeoutMs });
  return selected;
};

const findComposer = async (page) => {
  const locators = [
    page.locator('textarea').last(),
    page.locator('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]').last(),
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
    'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], input:not([type="hidden"])',
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
    "Could not safely identify a visible MAX message composer. The runtime failed closed; inspect the current UI and publish a compatible plugin update before retrying.",
  );
};

const uploadFiles = async (page, files, timeoutMs) => {
  if (files.length === 0) return;
  const names = files.map((file) => path.basename(file));
  const previousCounts = await Promise.all(names.map((name) => page.getByText(name, { exact: true }).count()));
  const uploadButton = page.getByRole("button", {
    name: /^(?:загрузить|прикрепить)(?: файл)?$|^(?:upload|attach)(?: file)?$/iu,
  }).last();
  let chooser = null;
  if (await uploadButton.count() && await uploadButton.isVisible({ timeout: 700 }).catch(() => false)) {
    // A chat may contain several hidden file inputs (including avatar and
    // media inputs). Use the visible attachment action so the provider chooses
    // its own current input rather than guessing that the last input is chat.
    const firstChooser = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
    await uploadButton.click({ timeout: timeoutMs });
    chooser = await firstChooser;
    if (!chooser) {
      const fileOption = page.getByRole("menuitem", {
        name: /^(?:файл|документ|file|document)$/iu,
      }).last();
      if (await fileOption.count() && await fileOption.isVisible({ timeout: 700 }).catch(() => false)) {
        const secondChooser = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
        await fileOption.click({ timeout: timeoutMs });
        chooser = await secondChooser;
      }
    }
  }
  if (chooser) {
    await chooser.setFiles(files);
  } else {
    const inputs = page.locator('input[type="file"]');
    if (!await inputs.count()) {
      throw new MaxRuntimeError("MAX_ATTACHMENT_NOT_STAGED", "MAX did not expose an attachment picker.");
    }
    await inputs.last().setInputFiles(files, { timeout: timeoutMs });
  }
  // Selecting a browser file is not proof that MAX attached it to the draft.
  // Require a newly visible filename before filling or sending message text,
  // so a failed upload cannot silently publish a text-only partial result.
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    const staged = await Promise.all(names.map(async (name, index) => {
      const candidates = page.getByText(name, { exact: true });
      return await candidates.count() > previousCounts[index]
        && await candidates.last().isVisible({ timeout: 500 }).catch(() => false);
    }));
    if (staged.every(Boolean)) return;
    await page.waitForTimeout(250);
  }
  throw new MaxRuntimeError(
    "MAX_ATTACHMENT_NOT_STAGED",
    "MAX did not show every selected file in the outgoing draft; no message was sent.",
  );
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
  if (!hasText) throw new Error("Could not find the MAX send button for the attachment.");
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
      "MAX send result is ambiguous: the exact outgoing text did not appear in the open chat. Do not retry automatically.",
    );
  });
  const remainingDraft = (await composerText(composer)).trim();
  if (remainingDraft) {
    throw new Error(
      "MAX send result is ambiguous: the composer still contains text. Do not retry automatically.",
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
        `MAX send result is ambiguous: attachment ${filename} did not appear in the open chat. Do not retry automatically.`,
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
    // Even login and assisted recovery create their first headed window
    // inactive. DOM focus/clicks are local to the page; they must not redirect
    // the user's keyboard from another application into a MAX draft.
    startInBackground: true,
    acceptDownloads: browserOptions.acceptDownloads !== false,
    label: "MAX",
    // MAX's passive-read protocol guard and exact assist gate remain in the
    // provider adapter. The common layer guarantees they are installed before
    // the first navigation and binds them to the same leased profile.
    prepareContext: async (context) => {
      installDocumentHttpObserver(context, runtime);
      const readGuard = await installPassiveReadGuard(context);
      if (browserOptions.assistGate) {
        await context.addInitScript(installMaxAssistGate, browserOptions.assistGate);
      }
      return readGuard;
    },
    preparePage: browserOptions.assistGate
      ? (page) => page.evaluate(installMaxAssistGate, browserOptions.assistGate)
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
    reject(new MaxRuntimeError(
      "MAX_ASSIST_SESSION_UNAVAILABLE",
      "The MAX assisted-browser control channel is unavailable.",
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
          reject(new MaxRuntimeError(
            failure.code || "MAX_ASSIST_SESSION_UNAVAILABLE",
            failure.error || "The MAX assisted-browser control channel rejected the request.",
            failure.details,
          ));
        } catch {
          reject(new MaxRuntimeError(
            "MAX_ASSIST_SESSION_UNAVAILABLE",
            "The MAX assisted-browser control channel rejected the request.",
          ));
        }
        return;
      }
      try {
        resolve(JSON.parse(value));
      } catch {
        reject(new MaxRuntimeError(
          "MAX_ASSIST_SESSION_UNAVAILABLE",
          "The MAX assisted-browser control channel returned an invalid response.",
        ));
      }
    });
  });
  request.once("timeout", () => request.destroy(new Error("assist control timeout")));
  request.once("error", () => reject(new MaxRuntimeError(
    "MAX_ASSIST_SESSION_UNAVAILABLE",
    "The MAX assisted-browser control channel is unavailable.",
  )));
  request.end(body);
});

const removeAssistSessionIfExact = (options, sessionId) => {
  const file = assistSessionPath(options);
  try {
    const current = readAssistSession(options);
    if (current?.sessionId === sessionId) {
      fs.rmSync(file, { force: true });
      // A killed detached worker cannot run its own finally cleanup. Remove
      // only screenshots tied to this exact fenced session when its record is
      // retired; another active session keeps its separate directory.
      fs.rmSync(path.join(connectionRoot(options), "state", "assist-snapshots", sessionId),
        { recursive: true, force: true });
    }
  } catch {
    // Never remove a record whose identity cannot be re-read exactly.
  }
};

const activeAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record) return null;
  if (record.phase === "closed") {
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    removeAssistSessionIfExact(options, record.sessionId);
    return null;
  }
  // A concurrent start must not delete the record before its detached worker
  // has had a chance to publish the PID and loopback control endpoint.
  if (record.phase === "starting") {
    if (processIsAlive(record.pid)) {
      throw new MaxRuntimeError(
        "MAX_ASSIST_SESSION_UNAVAILABLE",
        "A MAX assisted-browser session is starting. Wait briefly before checking it again.",
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
    throw new MaxRuntimeError(
      "MAX_ASSIST_SESSION_UNAVAILABLE",
      "A MAX assisted-browser session exists but is not ready. Wait briefly or stop that exact session.",
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
      throw new MaxRuntimeError(
        "MAX_ASSIST_SESSION_ACTIVE",
        "Another MAX assisted-browser session is already active. Stop it before changing the exact authorized operation.",
        publicAssistStatus(current.record),
      );
    }
    return { ...current.status, reused: true };
  }

  const sessionId = randomUUID();
  const expiresAt = Math.min(
    Date.now() + Math.min(options.holdMs, MAX_ASSIST_HOLD_MS),
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
      error: "MAX_ASSIST_WORKER_START_FAILED",
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
    interactionMode: authorization.interactionMode,
    mutationAuthorized: authorization.mutationAuthorized,
    authorizationHash: authorization.authorizationHash,
    uploadPaths: authorization.uploadPaths,
    downloadOutput: authorization.downloadOutput,
    ...assistTargetContext(authorization.operation),
    // The worker must reuse the exact host-discovered or explicitly selected
    // executable from assist-start. Re-resolving it in a detached process
    // could report one app while opening another after an installation change.
    browserExecutable: options.chromeExecutable,
    expiresAt,
  })}\n`);
  child.unref();

  const deadline = assistStartupDeadline(expiresAt);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = readAssistSession(options);
    if (!record || record.sessionId !== sessionId) {
      throw new MaxRuntimeError(
        "MAX_ASSIST_WORKER_START_FAILED",
        "The MAX assisted-browser worker did not retain its exact session record.",
      );
    }
    if (record.phase === "failed") {
      throw new MaxRuntimeError(
        record.error || "MAX_ASSIST_WORKER_START_FAILED",
        record.message || "The MAX assisted-browser worker failed before becoming ready.",
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
  throw new MaxRuntimeError(
    "MAX_ASSIST_START_TIMEOUT",
    "The MAX assisted-browser window did not become ready before the bounded startup deadline.",
    { sessionId },
  );
});

const statusAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record || record.sessionId !== options.assistSession) {
    throw new MaxRuntimeError(
      "MAX_ASSIST_SESSION_NOT_FOUND",
      "The exact MAX assisted-browser session is not active.",
    );
  }
  if (record.phase === "closed") return { ok: true, ...publicAssistStatus(record), closed: true };
  return requestAssistControl(record, "status");
};

const interactWithAssistSession = async (options) => {
  const record = readAssistSession(options);
  if (!record || record.sessionId !== options.assistSession) {
    throw new MaxRuntimeError(
      "MAX_ASSIST_SESSION_NOT_FOUND",
      "The exact MAX assisted-browser session is not active.",
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
    throw new MaxRuntimeError(
      "MAX_ASSIST_SESSION_NOT_FOUND",
      "The exact MAX assisted-browser session is not active.",
    );
  }
  const status = record.phase === "closed"
    ? { ok: true, ...publicAssistStatus(record) }
    : await requestAssistControl(record, "stop");
  const closed = await waitForAssistShutdown(record, { readRecord: () => readAssistSession(options) });
  if (!closed) {
    throw new MaxRuntimeError(
      "MAX_ASSIST_STOP_UNCONFIRMED",
      "The MAX assisted-browser worker accepted stop but its shutdown is not yet confirmed.",
      { sessionId: record.sessionId },
    );
  }
  removeAssistSessionIfExact(options, record.sessionId);
  return { ...status, phase: "closed", closed: true };
};

const readAssistWorkerConfig = () => {
  const input = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 64 * 1024) {
    throw new MaxRuntimeError("MAX_ASSIST_CONFIG_INVALID", "The assisted-browser worker config is too large.");
  }
  const value = JSON.parse(input);
  const expectedMode = ASSIST_READ_ONLY_COMMANDS.has(value?.fallbackFor)
    ? "read-only"
    : "manual-control";
  const uploadsValid = Array.isArray(value?.uploadPaths)
    && value.uploadPaths.length <= MAX_FILES_PER_MESSAGE
    && value.uploadPaths.every((file) => typeof file === "string"
      && path.isAbsolute(file)
      && fs.existsSync(file)
      && fs.statSync(file).isFile());
  const downloadOutputValid = value?.downloadOutput === null
    || (typeof value?.downloadOutput === "string" && path.isAbsolute(value.downloadOutput));
  const browserExecutableValid = typeof value?.browserExecutable === "string"
    && path.isAbsolute(value.browserExecutable);
  const targetChatValid = value?.targetChat === null
    || (typeof value?.targetChat === "string" && value.targetChat.length > 0
      && value.targetChat.length <= 512);
  const targetMessageValid = ASSIST_MESSAGE_TARGET_COMMANDS.has(value?.fallbackFor)
    ? value?.targetMessage && ["messageId", "targetText", "targetAuthor"].every((key) => (
      value.targetMessage[key] === null || (typeof value.targetMessage[key] === "string"
        && value.targetMessage[key].length <= 8_192)))
      && Object.values(value.targetMessage).some(Boolean)
    : value?.targetMessage === null;
  if (value?.schemaVersion !== 1
    || !UUID_PATTERN.test(value.sessionId || "")
    || !ASSIST_COMMANDS.has(value.fallbackFor)
    || value.interactionMode !== expectedMode
    || value.mutationAuthorized !== MUTATING_COMMANDS.has(value.fallbackFor)
    || !/^[0-9a-f]{64}$/u.test(value.authorizationHash || "")
    || !uploadsValid
    || !downloadOutputValid
    || !browserExecutableValid
    || !targetChatValid
    || !targetMessageValid
    || !Number.isInteger(value.targetPages)
    || value.targetPages < 1 || value.targetPages > MAX_HISTORY_PAGES
    || (value.fallbackFor === "download") !== Boolean(value.downloadOutput)
    || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= Date.now()
    || value.expiresAt - Date.now() > MAX_ASSIST_HOLD_MS) {
    throw new MaxRuntimeError("MAX_ASSIST_CONFIG_INVALID", "The assisted-browser worker config is invalid.");
  }
  return value;
};

const readBoundedAssistBody = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > 4_096) {
      reject(new MaxRuntimeError("MAX_ASSIST_CONTROL_REJECTED", "The assisted-browser request is too large."));
      request.destroy();
    }
  });
  request.on("end", () => {
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new MaxRuntimeError("MAX_ASSIST_CONTROL_REJECTED", "The assisted-browser request is invalid."));
    }
  });
  request.on("error", reject);
});

const markAssistMemberSurface = (page) => page.evaluate(() => {
  document.querySelectorAll('[data-trelio-max-assist-member-surface]').forEach((node) => {
    node.removeAttribute('data-trelio-max-assist-member-surface');
  });
  const visible = (node) => {
    const box = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const label = (node) => String(node.getAttribute('aria-label') || node.innerText || node.textContent || '')
    .replace(/\s+/gu, ' ').trim();
  const tabs = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((node) => visible(node)
      && /^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?)$/iu.test(label(node)));
  if (tabs.length !== 1) return false;
  let panel = tabs[0].parentElement;
  while (panel && panel !== document.body) {
    const actions = Array.from(panel.querySelectorAll('button, [role="button"]'));
    const hasAdd = actions.some((node) => /^(?:добавить участников|add (?:participants|members))$/iu.test(label(node)));
    const hasInvite = actions.some((node) => /^(?:пригласить по ссылке|invite by link)$/iu.test(label(node)));
    const scroller = [panel, ...panel.querySelectorAll('*')].some((node) => {
      const style = window.getComputedStyle(node);
      return node.clientHeight >= 80 && node.scrollHeight > node.clientHeight + 2
        && /auto|scroll/u.test(style.overflowY);
    });
    const invite = actions.find((node) => /^(?:пригласить по ссылке|invite by link)$/iu.test(label(node)));
    const inviteBox = invite?.getBoundingClientRect();
    const memberRows = actions.some((node) => {
      if (node === tabs[0] || /^(?:добавить участников|add (?:participants|members)|пригласить по ссылке|invite by link)$/iu.test(label(node))) {
        return false;
      }
      const box = node.getBoundingClientRect();
      return inviteBox && box.y >= inviteBox.y + inviteBox.height - 4
        && Math.abs(box.x - inviteBox.x) <= 16 && box.width >= inviteBox.width * 0.8;
    });
    if (hasAdd && hasInvite && (scroller || memberRows)) break;
    panel = panel.parentElement;
  }
  if (!panel || panel === document.body) return false;
  panel.setAttribute('data-trelio-max-assist-member-surface', 'true');
  return true;
});

const inspectAssistDownloadSurface = async (page, { assignRefs = false, point = null } = {}) => {
  const surface = await page.evaluate(({ assignRefs, point }) => {
    const marked = document.querySelectorAll('[data-trelio-max-assist-download-surface="true"]');
    if (marked.length !== 1) return null;
    const message = marked[0];
    const box = message.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return null;
    const label = (node) => String(node.getAttribute('aria-label') || node.getAttribute('title')
      || node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim();
    const candidates = Array.from(message.querySelectorAll('a[download], button, [role="button"]'))
      .filter((node) => node.matches('a[download]') || /скач|download/iu.test(label(node)));
    const controls = [];
    let pointAllowed = false;
    if (assignRefs) document.querySelectorAll('[data-trelio-max-assist-ref]').forEach((node) =>
      node.removeAttribute('data-trelio-max-assist-ref'));
    const binding = [];
    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden'
        || rect.x >= window.innerWidth || rect.y >= window.innerHeight
        || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) continue;
      const ref = `r${controls.length + 1}`;
      if (assignRefs) node.setAttribute('data-trelio-max-assist-ref', ref);
      const href = node.getAttribute('href');
      binding.push([node.tagName, label(node), href, rect.x, rect.y, rect.width, rect.height]);
      controls.push({ ref, role: node.getAttribute('role') || node.tagName.toLowerCase(),
        label: label(node).slice(0, 160), editable: false, href: null,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      if (point && point.x >= rect.x && point.y >= rect.y
        && point.x < rect.x + rect.width && point.y < rect.y + rect.height) {
        const hit = document.elementFromPoint(point.x, point.y);
        pointAllowed ||= Boolean(hit && (hit === node || node.contains(hit)));
      }
      if (controls.length >= 100) break;
    }
    if (!controls.length) return null;
    // Bind the exact selected message and file controls, not changing presence,
    // story animations or unrelated sidebar previews. The complete screenshot
    // is still visual evidence; its other controls gain no refs or point access.
    return { state: JSON.stringify({ url: window.location.href,
      viewport: [window.innerWidth, window.innerHeight],
      text: String(message.innerText || message.textContent || '').replace(/\s+/gu, ' ').trim(),
      box: [box.x, box.y, box.width, box.height], controls: binding }), controls, pointAllowed };
  }, { assignRefs, point });
  if (!surface) {
    throw new MaxRuntimeError("MAX_ASSIST_DOWNLOAD_TARGET_CHANGED", "The exact MAX attachment control is no longer available. Inspect live state before another action.");
  }
  if (Buffer.byteLength(surface.state) > 2 * 1024 * 1024) {
    throw new MaxRuntimeError("MAX_ASSIST_PAGE_TOO_LARGE", "The exact MAX attachment surface is too large to bind a safe UI snapshot.");
  }
  return { fingerprint: createHash('sha256').update(surface.state).digest('hex'),
    controls: surface.controls, pointAllowed: surface.pointAllowed };
};

const assistPageDigest = async (page, membersOnly = false, downloadOnly = false) => {
  if (downloadOnly) return (await inspectAssistDownloadSurface(page)).fingerprint;
  if (membersOnly && !await markAssistMemberSurface(page)) {
    // A changed MAX details layout must not prevent the agent from seeing the
    // already opened exact chat. This weaker binding is used only for visual
    // participant inspection; it never authorizes a member mutation or claims
    // that all participants have been enumerated.
    const visualState = await page.evaluate(() => JSON.stringify({
      mode: 'visual-members', url: window.location.href,
      width: window.innerWidth, height: window.innerHeight,
    }));
    return createHash('sha256').update(visualState).digest('hex');
  }
  const state = await page.evaluate((memberScope) => {
    const selector = 'button, [role="button"], [role="option"], [role="listitem"], a[href], input, textarea, [contenteditable="true"]';
    if (memberScope) {
      const panel = document.querySelector('[data-trelio-max-assist-member-surface="true"]');
      const tab = Array.from(panel.querySelectorAll('button, [role="button"]'))
        .find((node) => /^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?)$/iu.test(
          String(node.getAttribute('aria-label') || node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim(),
        ));
      const scrollers = [panel, ...panel.querySelectorAll('*')].filter((node) => {
        const style = window.getComputedStyle(node);
        return node.clientHeight >= 80 && node.scrollHeight > node.clientHeight + 2
          && /auto|scroll/u.test(style.overflowY);
      });
      const depth = (node) => {
        let value = 0;
        while (node && node !== panel) { value += 1; node = node.parentElement; }
        return value;
      };
      const scroller = scrollers.sort((a, b) => depth(b) - depth(a))[0] || null;
      const rect = panel.getBoundingClientRect();
      // Presence labels and sidebar previews can change while the operator
      // looks at the list. Scrolling is tied to the exact panel, tab, count,
      // geometry and position; a click also rechecks its exact target label.
      return JSON.stringify({ url: window.location.href, memberPanel: true,
        tab: tab?.getAttribute('aria-label') || tab?.innerText || tab?.textContent || null,
        rect: [rect.x, rect.y, rect.width, rect.height],
        scrollTop: scroller?.scrollTop ?? null });
    }
    const modalSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i]';
    const picker = Array.from(document.querySelectorAll(modalSelector))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const hasSearch = Array.from(node.querySelectorAll('input')).some((input) => {
          const box = input.getBoundingClientRect();
          return box.width >= 8 && box.height >= 8;
        });
        const hasFinalAdd = Array.from(node.querySelectorAll('button, [role="button"]')).some((button) =>
          /^(?:добавить|add)$/iu.test(String(button.getAttribute('aria-label') || button.innerText
            || button.textContent || '').replace(/\s+/gu, ' ').trim()));
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && hasSearch && hasFinalAdd;
      })
      // A nested result list omits the final button. Use the smallest visible
      // ancestor containing both search and Add, even when the modal is wide.
      .sort((a, b) => {
        const left = a.getBoundingClientRect();
        const right = b.getBoundingClientRect();
        return left.width * left.height - right.width * right.height;
      })[0];
    const activeDialog = picker || Array.from(document.querySelectorAll(modalSelector))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.width < window.innerWidth * 0.9
          && rect.height < window.innerHeight * 0.95
          && style.display !== "none" && style.visibility !== "hidden"
          && (!document.activeElement || document.activeElement === document.body
            || node.contains(document.activeElement));
      })
      .sort((a, b) => {
        const left = a.getBoundingClientRect();
        const right = b.getBoundingClientRect();
        return right.width * right.height - left.width * left.height;
      })[0] || document.activeElement?.closest(modalSelector);
    // The sidebar receives unrelated messages and presence updates while a
    // picker is open. Bind the snapshot to that modal and its control geometry
    // instead of invalidating every exact input on a background update.
    const nodes = Array.from((activeDialog || document).querySelectorAll(selector));
    const controls = [...new Set(nodes)].slice(0, 500).map((node) => {
      const rect = node.getBoundingClientRect();
      return [node.tagName, node.getAttribute("role"), node.getAttribute("aria-label"),
        node.getAttribute("title"), node.getAttribute("placeholder"),
        node instanceof HTMLInputElement && !['password', 'file'].includes(node.type) ? node.value : null,
        rect.x, rect.y, rect.width, rect.height];
    });
    return JSON.stringify({ url: window.location.href,
      surface: activeDialog?.getAttribute("role") || (activeDialog ? "modal" : null),
      text: activeDialog ? null : document.body?.innerText || "", controls });
  }, membersOnly);
  if (Buffer.byteLength(state) > 2 * 1024 * 1024) {
    throw new MaxRuntimeError("MAX_ASSIST_PAGE_TOO_LARGE", "The assisted MAX page is too large to bind a safe UI snapshot.");
  }
  return createHash("sha256").update(state).digest("hex");
};

const collectAssistControls = async (page, membersOnly = false, downloadOnly = false) => {
  if (downloadOnly) return (await inspectAssistDownloadSurface(page, { assignRefs: true })).controls;
  if (membersOnly && !await markAssistMemberSurface(page)) {
    // Coordinate actions are separately bounded and never reuse DOM refs from
    // an unrecognized panel. The screenshot remains available to the model.
    return [];
  }
  return page.evaluate((memberScope) => {
  document.querySelectorAll("[data-trelio-max-assist-ref]").forEach((node) => {
    node.removeAttribute("data-trelio-max-assist-ref");
  });
  const selector = 'button, [role="button"], [role="option"], [role="listitem"], a[href], input, textarea, [contenteditable="true"]';
  const result = [];
  // When a modal is open, the sidebar is not an authorized target and its
  // changing content must not consume the bounded set of exact control refs.
  const modalSelector = '[role="dialog"], [aria-modal="true"], [class*="modal" i]';
  const picker = Array.from(document.querySelectorAll(modalSelector))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const hasSearch = Array.from(node.querySelectorAll('input')).some((input) => {
        const box = input.getBoundingClientRect();
        return box.width >= 8 && box.height >= 8;
      });
      const hasFinalAdd = Array.from(node.querySelectorAll('button, [role="button"]')).some((button) =>
        /^(?:добавить|add)$/iu.test(String(button.getAttribute('aria-label') || button.innerText
          || button.textContent || '').replace(/\s+/gu, ' ').trim()));
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && hasSearch && hasFinalAdd;
    })
    .sort((a, b) => {
      const left = a.getBoundingClientRect();
      const right = b.getBoundingClientRect();
      return left.width * left.height - right.width * right.height;
    })[0];
  const activeDialog = picker || Array.from(document.querySelectorAll(modalSelector))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && rect.width < window.innerWidth * 0.9
        && rect.height < window.innerHeight * 0.95
        && style.display !== "none" && style.visibility !== "hidden"
        && (!document.activeElement || document.activeElement === document.body
          || node.contains(document.activeElement));
    })
    .sort((a, b) => {
      const left = a.getBoundingClientRect();
      const right = b.getBoundingClientRect();
      return right.width * right.height - left.width * left.height;
    })[0] || document.activeElement?.closest(modalSelector);
  const memberPanel = memberScope
    ? document.querySelector('[data-trelio-max-assist-member-surface="true"]') : null;
  const nodes = Array.from((memberPanel || activeDialog || document).querySelectorAll(selector));
  const seen = new Set();
  for (const node of nodes) {
    if (node instanceof HTMLInputElement && ['password', 'file'].includes(node.type)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const box = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (box.width < 8 || box.height < 8 || style.display === "none" || style.visibility === "hidden"
      || box.x >= window.innerWidth || box.y >= window.innerHeight || box.x + box.width <= 0 || box.y + box.height <= 0) continue;
    const ref = `r${result.length + 1}`;
    node.setAttribute("data-trelio-max-assist-ref", ref);
    const label = String(node.getAttribute("aria-label") || node.getAttribute("title")
      || node.getAttribute("placeholder") || node.innerText || node.textContent || "")
      .replace(/\s+/gu, " ").trim().slice(0, 160);
    const link = node instanceof HTMLAnchorElement ? node : node.closest("a[href]");
    const href = link?.href?.startsWith(`${window.location.origin}/`) ? link.href : null;
    result.push({ ref, role: node.getAttribute("role") || node.tagName.toLowerCase(), label,
      editable: node.matches('input:not([type="password"]):not([type="file"]), textarea, [contenteditable="true"]'),
      href, box: { x: box.x, y: box.y, width: box.width, height: box.height } });
    if (result.length >= 100) break;
  }
  return result;
  }, membersOnly);
};

const captureStableAssistFrame = async (page, membersOnly = false, downloadOnly = false) => {
  // Repeating a passive capture is safe; repeating a click is not. Zero every
  // rejected image before another attempt so changing private content does
  // not accumulate in memory or the session screenshot directory.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fingerprint = await assistPageDigest(page, membersOnly, downloadOnly);
    const controls = await collectAssistControls(page, membersOnly, downloadOnly);
    const bytes = await page.screenshot({ type: "png", fullPage: false,
      animations: "disabled", scale: "css" });
    if (bytes.length > 8 * 1024 * 1024) {
      bytes.fill(0);
      throw new MaxRuntimeError("MAX_ASSIST_SNAPSHOT_CHANGED", "The MAX screenshot exceeds the safe size limit.");
    }
    let current;
    try {
      current = await assistPageDigest(page, membersOnly, downloadOnly);
    } catch (error) {
      // A disappearing exact attachment is also a rejected capture. Erase its
      // private pixels before propagating that fail-closed binding error.
      bytes.fill(0);
      throw error;
    }
    if (current === fingerprint) {
      return { fingerprint, controls, bytes };
    }
    bytes.fill(0);
    if (attempt < 2) await page.waitForTimeout(120 * (attempt + 1));
  }
  throw new MaxRuntimeError("MAX_ASSIST_SNAPSHOT_CHANGED", "The MAX page changed during its screenshot. Take a fresh snapshot.");
};

const scrollAssistMemberSurface = (page, deltaY) => page.evaluate((amount) => {
  const panel = document.querySelector('[data-trelio-max-assist-member-surface="true"]');
  if (!panel) return { recognized: false, moved: false, atEnd: false };
  const candidates = [panel, ...panel.querySelectorAll('*')].filter((node) => {
    const style = window.getComputedStyle(node);
    return node.clientHeight >= 80 && node.scrollHeight > node.clientHeight + 2
      && /auto|scroll/u.test(style.overflowY);
  });
  const depth = (node) => {
    let value = 0;
    while (node && node !== panel) { value += 1; node = node.parentElement; }
    return value;
  };
  const scroller = candidates.sort((a, b) => depth(b) - depth(a))[0];
  if (!scroller) {
    // A short group can fit entirely in the details pane. Treat a scroll as
    // reaching the end only when the pane advertises one exact count and its
    // own visible participant rows satisfy that count. A missing scroller in
    // a larger or uncounted group still fails closed instead of scrolling the
    // chat history or declaring unseen members absent.
    const label = (node) => String(node.getAttribute('aria-label') || node.innerText || node.textContent || '')
      .replace(/\s+/gu, ' ').trim();
    const actions = Array.from(panel.querySelectorAll('button, [role="button"]'));
    const counts = [...new Set(actions.map((node) => label(node).match(
      /^(?:участники\s+(\d+)|(\d+)\s+участников|members\s+(\d+))$/iu,
    )).filter(Boolean).map((match) => Number(match[1] || match[2] || match[3])))];
    const invite = actions.find((node) => /^(?:пригласить по ссылке|invite by link)$/iu.test(label(node)));
    const inviteBox = invite?.getBoundingClientRect();
    const rows = actions.filter((node) => {
      const text = label(node);
      if (/^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?|добавить участников|add (?:participants|members)|пригласить по ссылке|invite by link)$/iu.test(text)) return false;
      const box = node.getBoundingClientRect();
      return inviteBox && box.y >= inviteBox.y + inviteBox.height - 4
        && Math.abs(box.x - inviteBox.x) <= 16 && box.width >= inviteBox.width * 0.8;
    });
    // The live MAX tab can say only "Участники". A recognized pane with rows
    // still has no participant scroller to move; this is a successful no-op,
    // not proof of complete membership. If MAX does advertise a count, keep
    // rejecting a mismatch so the operator cannot infer an absent member.
    return { recognized: rows.length > 0 && (counts.length === 0
      || (counts.length === 1 && rows.length === counts[0])), moved: false, atEnd: true };
  }
  const before = scroller.scrollTop;
  scroller.scrollTop += amount;
  return { recognized: true, moved: scroller.scrollTop !== before,
    atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 };
}, deltaY);

const inspectVisualMemberPoint = (page, packet, execute = false) => page.evaluate(({ x, y, command, executeClick }) => {
  if (x < Math.ceil(window.innerWidth * 0.42) || x >= window.innerWidth - 8
    || y < 0 || y >= window.innerHeight - 8) return { allowed: false };
  if (y < 72) {
    if (command !== 'point-click') return { allowed: false };
    const header = document.elementFromPoint(x, y)?.closest('button, [role="button"]');
    const rect = header?.getBoundingClientRect();
    const label = String(header?.getAttribute('aria-label') || header?.innerText
      || header?.textContent || '').replace(/\s+/gu, ' ').trim();
    const allowed = Boolean(header && rect && rect.width >= 80 && rect.height >= 24
      && rect.x > window.innerWidth * 0.37 && rect.x < window.innerWidth * 0.75
      && /\p{L}/u.test(label) && label.length <= 120
      && !/^(?:назад|back|звонок|позвонить|видеозвонок|поиск|ещё|еще|more|call|video)$/iu.test(label));
    // Opening the exact chat's header/details panel has no member mutation.
    // It is needed only when changed markup defeated automatic preparation.
    if (allowed && executeClick) header.click();
    return { allowed };
  }
  if (command === 'point-scroll') return { allowed: true };
  const target = document.elementFromPoint(x, y);
  const control = target?.closest('button, [role="button"]');
  const label = String(control?.getAttribute('aria-label') || control?.innerText
    || control?.textContent || '').replace(/\s+/gu, ' ').trim();
  // A coordinate click can only open the visible participant section. It
  // cannot select a person, open an action menu, or press Add/Remove.
  const allowed = Boolean(control && !control.closest('a[href]')
    && /^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?)$/iu.test(label));
  // Resolve and activate the same semantic element in one browser task. A
  // separate mouse click could land on a newly appeared destructive control.
  if (allowed && executeClick) control.click();
  return { allowed };
}, { ...packet, executeClick: execute });

// A visual point is resolved inside the already fenced provider page. The
// read-only gate still needs a semantic chat/search target; an approved manual
// operation may use an unlabelled control, but never an external link or a
// password/file input. This is the same authority as native control of this
// exact window, with an additional fresh screenshot binding.
const inspectGeneralAssistPoint = async (page, packet, interactionMode, fallbackFor) => {
  const target = await page.evaluate(({ x, y }) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const node = document.elementFromPoint(x, y);
    let element = node?.closest('a, button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="listitem"], [role="textbox"]') || node;
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
      href: link?.href || '',
      chatRow: Boolean(element.querySelector?.('h3, [role="heading"][aria-level="3"], [class~="cell"] > [class~="title"] [class~="name"]')),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewportWidth: window.innerWidth, pathname: window.location.pathname,
    };
  }, packet);
  if (!target || ['password', 'file'].includes(target.type)) return false;
  if (target.href && !target.href.startsWith(`${MAX_WEB_ORIGIN}/`)) return false;
  if (interactionMode === 'read-only' && ['point-click', 'click', 'fill'].includes(packet.command)) {
    return assistInteractionAllowed({ ...target, fallbackFor,
      kind: packet.command === 'fill' ? 'fill' : 'click' });
  }
  return true;
};

const validateAssistControlPacket = (packet, sessionId) => {
  const shapes = {
    status: "command,sessionId",
    stop: "command,sessionId",
    snapshot: "command,sessionId",
    click: "command,ref,sessionId,snapshotId",
    contextmenu: "command,ref,sessionId,snapshotId",
    fill: "command,ref,sessionId,snapshotId,text",
    key: "command,key,sessionId,snapshotId",
    scroll: "command,deltaY,sessionId,snapshotId",
    "point-click": "command,sessionId,snapshotId,x,y",
    "point-contextmenu": "command,sessionId,snapshotId,x,y",
    "point-scroll": "command,deltaY,sessionId,snapshotId,x,y",
  };
  if (!packet || packet.sessionId !== sessionId
    || Object.keys(packet).sort().join(",") !== shapes[packet.command]
    || (["click", "contextmenu", "fill", "key", "scroll", "point-click", "point-contextmenu", "point-scroll"].includes(packet.command)
      && !UUID_PATTERN.test(packet.snapshotId || ""))
    || (["click", "contextmenu", "fill"].includes(packet.command)
      && !/^r(?:[1-9]|[1-9]\d|100)$/u.test(packet.ref || ""))
    || (packet.command === "fill" && (typeof packet.text !== "string"
      || packet.text.length < 1 || packet.text.length > 256))
    || (packet.command === "key" && !["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"].includes(packet.key))
    || (["scroll", "point-scroll"].includes(packet.command) && (!Number.isInteger(packet.deltaY)
      || packet.deltaY === 0 || Math.abs(packet.deltaY) > 1500))) {
    throw new MaxRuntimeError("MAX_ASSIST_CONTROL_REJECTED", "The assisted-browser control request was rejected.");
  }
  if (["point-click", "point-contextmenu", "point-scroll"].includes(packet.command)
    && (![packet.x, packet.y].every((coordinate) => Number.isInteger(coordinate)
      && coordinate >= 0 && coordinate <= 8192))) {
    throw new MaxRuntimeError("MAX_ASSIST_CONTROL_REJECTED", "The screenshot point is invalid.");
  }
  return packet;
};

const assertAssistActionAllowed = ({ config, snapshot, packet, fingerprint, now = Date.now() }) => {
  if (config.fallbackFor === "download"
    && (packet.command === "fill" || (packet.command === "key" && packet.key !== "Escape"))) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_NOT_AUTHORIZED", "Attachment recovery permits only the exact file control and inspection.");
  }
  const approvedOperation = config.interactionMode === "read-only"
    || (config.interactionMode === "manual-control"
      && (config.mutationAuthorized || ["members", "download"].includes(config.fallbackFor)));
  const memberInspection = config.fallbackFor === "members"
    && !config.mutationAuthorized
    && ["click", "scroll", "point-click", "point-scroll"].includes(packet.command);
  if (["contextmenu", "point-contextmenu"].includes(packet.command)
    && (config.interactionMode !== "manual-control"
      || (!config.mutationAuthorized && config.fallbackFor !== "download"))) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_NOT_AUTHORIZED", "Context menus require an authorized mutation or download.");
  }
  if (config.fallbackFor === "members"
    && ["point-click", "point-scroll"].includes(packet.command)
    && !memberInspection) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_NOT_AUTHORIZED", "Participant inspection is read-only.");
  }
  if (!approvedOperation && !memberInspection) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_NOT_AUTHORIZED", "In-session controls require an exact authorized MAX operation.");
  }
  if (config.fallbackFor === "members" && ["fill", "key"].includes(packet.command)) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_NOT_AUTHORIZED", "Participant inspection cannot enter text.");
  }
  if (!snapshot || packet.snapshotId !== snapshot.id
    || now - snapshot.at > 120_000 || fingerprint !== snapshot.fingerprint) {
    throw new MaxRuntimeError("MAX_ASSIST_SNAPSHOT_STALE", "Take a fresh MAX snapshot and reselect the target before acting.", {
      // This guard runs before any UI action. Refresh only the observation;
      // never translate an old ref/coordinate onto the changed surface or
      // extend the exact operation's authorization/absolute session lease.
      actionApplied: false,
      recovery: { command: "assist-snapshot", reselectTarget: true, automaticReplay: false },
      ...(UUID_PATTERN.test(config.sessionId || "")
        ? { recoveryArguments: ["assist-snapshot", "--session", config.sessionId] }
        : {}),
    });
  }
  if (["click", "contextmenu", "fill"].includes(packet.command) && !snapshot.refs.has(packet.ref)) {
    throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The requested control is absent from the current snapshot.", {
      actionApplied: false,
      recovery: { command: "assist-snapshot", reselectTarget: true, automaticReplay: false },
      ...(UUID_PATTERN.test(config.sessionId || "")
        ? { recoveryArguments: ["assist-snapshot", "--session", config.sessionId] }
        : {}),
    });
  }
  return snapshot;
};

const assertAssistGateActionCompleted = async (page, blockedBefore) => {
  const blockedAfter = await page.evaluate(() => window.__trelioMaxAssistState?.blockedActions || 0);
  if (blockedAfter !== blockedBefore) {
    throw new MaxRuntimeError("MAX_ASSIST_ACTION_BLOCKED", "The MAX interaction gate blocked this action. Inspect live state before another action.");
  }
};

const runAssistWorker = async () => {
  const config = readAssistWorkerConfig();
  const options = {
    ...parseArguments(["doctor"]),
    chromeExecutable: config.browserExecutable,
    headed: true,
    holdMs: Math.max(5_000, config.expiresAt - Date.now()),
  };
  const file = assistSessionPath(options);
  let publicFailure = null;
  try {
    await withBrowser(options, async (page, readGuard) => {
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
      let closing = false;
      const stopped = new Promise((resolve) => {
        stopSession = (reason) => { closing = true; resolve(reason); };
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
            ? Promise.reject(new MaxRuntimeError(
                "MAX_ASSIST_UPLOAD_REJECTED",
                "The assisted MAX session requested files more than once for one authorized operation.",
              ))
            : chooser.setFiles(config.uploadPaths))
            .then(() => {
              uploadsHandled += 1;
            })
            .catch((error) => {
              interactionFailure = error instanceof MaxRuntimeError
                ? error
                : new MaxRuntimeError(
                    "MAX_ASSIST_UPLOAD_FAILED",
                    "The assisted MAX window could not attach the exact authorized local files.",
                  );
              stopSession("interaction_failure");
            });
          trackTransfer(transfer);
        });
      }
      const attachmentTransfer = config.downloadOutput ? await installAttachmentTransfer(page, {
        output: config.downloadOutput,
        timeoutMs: options.timeoutMs,
        onPending: trackTransfer,
        onSaved: (saved) => { downloadEvents += 1; downloads.push(saved); },
        onFailure: (error) => { interactionFailure = error; stopSession("interaction_failure"); },
      }) : null;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        try {
          const url = new URL(frame.url());
          if (url.origin !== MAX_WEB_ORIGIN) {
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
      await openHome(page, options, true);
      const session = await page.evaluate(inspectMaxSessionDocument, false);
      if (session.loginReady) {
        throw new MaxRuntimeError(
          "MAX_LOGIN_REQUIRED",
          "MAX login is required. Stop assisted recovery and run login in the dedicated profile.",
        );
      }
      const gateMode = await page.evaluate(() => window.__trelioMaxAssistState?.mode || null);
      if (gateMode !== config.interactionMode) {
        throw new MaxRuntimeError(
          "MAX_ASSIST_GUARD_NOT_READY",
          "The MAX assisted-browser interaction gate was not installed before provider inspection.",
        );
      }
      let boundChatPath = null;
      let preparationIssue = null;
      try {
        if (["member-add", "members"].includes(config.fallbackFor)) {
        // Recovery starts in the exact requested chat. The read-only members
        // session stops at its details panel; only an approved add operation
        // opens the picker and gains in-session mutation controls.
        const target = { ...options, chat: config.targetChat };
        await openChat(page, target);
        boundChatPath = new URL(page.url()).pathname;
        await openChatDetails(page, target);
        if (config.fallbackFor === "member-add") {
          await clickVisibleAction(page, /добавить участников|add (?:participants|members)/iu, options.timeoutMs);
        }
        } else if (config.targetChat) {
        // Keep the failed operation's exact chat in view for inspection. The
        // in-session action gate remains bound to the authorized operation.
        const target = { ...options, chat: config.targetChat, pages: config.targetPages,
          ...config.targetMessage };
        await openChat(page, target);
        boundChatPath = new URL(page.url()).pathname;
        if (config.targetMessage) {
          await loadHistoryPages(page, target.pages, target.timeoutMs);
          const selected = await findMessageTarget(page, target);
          await selected.locator.scrollIntoViewIfNeeded({ timeout: target.timeoutMs });
          if (config.fallbackFor === "download") {
            // The selected DOM node carries only a local binding marker. If MAX
            // replaces it, recovery fails closed rather than choosing a new file.
            await selected.locator.evaluate((node) =>
              node.setAttribute('data-trelio-max-assist-download-surface', 'true'));
          }
          if (config.fallbackFor !== "download") {
            await openMessageActionMenu(page, selected.locator, target.timeoutMs);
            if (config.fallbackFor === "forward") {
              // Opening the destination picker has no external effect. Show
              // this exact form in the fenced recovery session so selector
              // failures can be diagnosed without a second browser profile.
              await clickVisibleAction(page, /переслать|forward/iu, target.timeoutMs);
            }
          }
        } else if (config.fallbackFor === "chat-update") {
          await openChatDetails(page, target);
          // The settings button only opens the edit form; Save remains the
          // separately authorized final mutation. Snapshot the real fields.
          await clickVisibleAction(page,
            /^(?:показать настройки|редактировать чат|edit chat|show settings)$/iu,
            target.timeoutMs);
        }
        }
      } catch (error) {
        const normalized = normalizeMaxRuntimeError(error);
        if (!canRecoverAssistPreparation(normalized, config.interactionMode)) throw error;
        // Preparation only navigates and opens menus. When a changed layout
        // prevents one of those steps, keep the same fenced window open so
        // the agent can identify the exact target visually. No mutation has
        // been dispatched and an unknown target is never reported as ready.
        preparationIssue = normalized.code;
      }
      // Handing out a fenced session does not authorize taking OS focus.
      // The user can select the window; in-session snapshots and controls work
      // while it stays behind the application the user is currently using.
      const token = randomBytes(32).toString("hex");
      const screenshots = new Set();
      let assistSnapshot = null;
      let controlBusy = false;
      const assertAssistSurface = async () => {
        if (page.isClosed() || new URL(page.url()).origin !== MAX_WEB_ORIGIN
          || (boundChatPath && new URL(page.url()).pathname !== boundChatPath)) {
          throw new MaxRuntimeError("MAX_ASSIST_SESSION_UNAVAILABLE", "The exact MAX window is no longer available.");
        }
        const current = await page.evaluate(inspectMaxSessionDocument, false);
        const mode = await page.evaluate(() => window.__trelioMaxAssistState?.mode || null);
        if (current.loginReady || mode !== config.interactionMode) {
          throw new MaxRuntimeError("MAX_ASSIST_GUARD_NOT_READY", "The MAX login or interaction gate changed during recovery.");
        }
      };
      const observe = async () => {
        assertDocumentAvailable(page);
        await assertAssistSurface();
        const membersOnly = config.fallbackFor === "members";
        const inspectionMode = membersOnly
          ? (await markAssistMemberSurface(page) ? "structured" : "visual") : "structured";
        // CSS-sized pixels make image coordinates usable without guessing the
        // display scale, including on Retina screens.
        const { fingerprint, controls, bytes } = await captureStableAssistFrame(page, membersOnly,
          config.fallbackFor === "download");
        const directory = path.join(connectionRoot(options), "state", "assist-snapshots", config.sessionId);
        ensurePrivateDirectory(directory);
        const screenshotPath = path.join(directory, `${randomUUID()}.png`);
        try {
          // Retain only the current local screenshot. A 30-minute session can
          // take many observations, but earlier ones must not grow the private
          // content cache or be mistaken for the live picker.
          for (const previous of screenshots) fs.rmSync(previous, { force: true });
          screenshots.clear();
          fs.writeFileSync(screenshotPath, bytes, { flag: "wx", mode: 0o600 });
          screenshots.add(screenshotPath);
        } finally {
          bytes.fill(0);
        }
        assistSnapshot = { id: randomUUID(), at: Date.now(), fingerprint, inspectionMode,
          refs: new Set(controls.map((control) => control.ref)),
          controls: new Map(controls.map((control) => [control.ref, control])) };
        // Expose the actual opened route, not a row number or its title hash.
        // A later exact read can bind it to a task after contextual inspection.
        const reference = config.interactionMode === "read-only"
          ? await inspectOpenedChatReference(page) : null;
        const chatReference = reference ? rememberChatReference(options, reference) : null;
        return { ok: true, sessionId: config.sessionId, snapshotId: assistSnapshot.id,
          screenshotPath, controls, fingerprint: await safeUiFingerprint(page),
          chatReference,
          interactionMode: config.interactionMode, fallbackFor: config.fallbackFor,
          inspectionMode,
          coverage: membersOnly ? { complete: false, scope: "visible-screen" } : undefined };
      };
      const act = async (packet) => {
        assertDocumentAvailable(page);
        await assertAssistSurface();
        const snapshot = assertAssistActionAllowed({ config, snapshot: assistSnapshot, packet,
          fingerprint: await assistPageDigest(page, config.fallbackFor === "members", config.fallbackFor === "download") });
        if (["point-click", "point-contextmenu", "point-scroll"].includes(packet.command)) {
          const allowed = config.fallbackFor === "download"
            ? (await inspectAssistDownloadSurface(page, { point: packet })).pointAllowed
            : config.fallbackFor === "members"
            ? (await inspectVisualMemberPoint(page, packet)).allowed
            : await inspectGeneralAssistPoint(page, packet, config.interactionMode, config.fallbackFor);
          if (!allowed) {
            throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The screenshot point is outside the authorized MAX control surface.");
          }
        }
        let target = null;
        if (["click", "contextmenu", "fill"].includes(packet.command)) {
          target = page.locator(`[data-trelio-max-assist-ref="${packet.ref}"]`);
          if (await target.count() !== 1) {
            throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The requested MAX control changed.");
          }
          const currentLabel = await target.evaluate((node) => String(node.getAttribute("aria-label")
            || node.getAttribute("title") || node.getAttribute("placeholder")
            || node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 160));
          if (currentLabel !== snapshot.controls.get(packet.ref)?.label) {
            throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The requested MAX control changed since the snapshot.");
          }
        }
        if (packet.command === "fill") {
          const editable = await target.evaluate((node) => node.matches(
            'input:not([type="password"]):not([type="file"]), textarea, [contenteditable="true"]',
          ));
          if (!editable) throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The requested MAX control is not editable.");
        }
        if (config.interactionMode === "read-only" && ["click", "fill"].includes(packet.command)) {
          const box = snapshot.controls.get(packet.ref)?.box;
          if (!box || !await inspectGeneralAssistPoint(page, { command: packet.command,
            x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
          "read-only", config.fallbackFor)) {
            throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The read-only session permits only chat navigation and search.");
          }
        }
        if (config.interactionMode === "read-only" && packet.command === "key"
          && !["Escape", "ArrowUp", "ArrowDown"].includes(packet.key)) {
          throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "This key is not permitted in a read-only session.");
        }
        if (["click", "contextmenu"].includes(packet.command)) {
          const href = await target.evaluate((node) => node.closest("a[href]")?.href || null);
          if (href && !href.startsWith(`${MAX_WEB_ORIGIN}/`)) {
            throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The requested control leaves the MAX origin.");
          }
          if (config.fallbackFor === "members") {
            // The members recovery session is inspection only. Its sole click
            // expands the participant section already opened in the exact chat.
            const participantControl = await target.evaluate((node) => {
              const label = String(node.getAttribute("aria-label") || node.innerText || node.textContent || "")
                .replace(/\s+/gu, " ").trim();
              return /^(?:участники|members)(?:\s+\d+)?$/iu.test(label)
                && !node.closest("a[href]");
            });
            if (!participantControl) {
              throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The members session may open only the participant section.");
            }
          }
        }
        // Consume the snapshot before dispatch: if the response is lost, a
        // repeat with the same ID cannot click Add twice. The next action
        // requires a new live observation and an unchanged exact session.
        assistSnapshot = null;
        const blockedBefore = await page.evaluate(() => window.__trelioMaxAssistState?.blockedActions || 0);
        try {
          if (packet.command === "click") await target.click({ timeout: 3_000 });
          else if (packet.command === "contextmenu") await target.click({ button: "right", timeout: 3_000 });
          else if (packet.command === "point-click") {
            if (config.fallbackFor === "members") {
              const result = await inspectVisualMemberPoint(page, packet, true);
              if (!result.allowed) {
                throw new MaxRuntimeError("MAX_ASSIST_TARGET_INVALID", "The participant tab changed before its click.");
              }
            } else {
              await page.mouse.click(packet.x, packet.y);
            }
          }
          else if (packet.command === "point-contextmenu") await page.mouse.click(packet.x, packet.y, { button: "right" });
          else if (packet.command === "point-scroll") {
            await page.mouse.move(packet.x, packet.y);
            await page.mouse.wheel(0, packet.deltaY);
          }
          else if (packet.command === "fill") await target.fill(packet.text, { timeout: 3_000 });
          else if (packet.command === "key") await page.keyboard.press(packet.key);
          else if (config.fallbackFor === "members") {
            const position = await scrollAssistMemberSurface(page, packet.deltaY);
            if (!position.recognized) {
              throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "The exact MAX participant scroller is not identified.");
            }
          } else await page.mouse.wheel(0, packet.deltaY);
          // Playwright's click can complete even when the synchronous DOM gate
          // prevents the provider action. Check both gate modes so callers get
          // the real blocked result and inspect fresh state before retrying.
          await assertAssistGateActionCompleted(page, blockedBefore);
        } catch (error) {
          if (error instanceof MaxRuntimeError && error.code === "MAX_UI_UNSUPPORTED") throw error;
          if (error instanceof MaxRuntimeError && error.code === "MAX_ASSIST_ACTION_BLOCKED") throw error;
          throw new MaxRuntimeError("MAX_ASSIST_ACTION_AMBIGUOUS", "The MAX UI action has an unknown result. Inspect live state before another action.");
        }
        return { ok: true, sessionId: config.sessionId, action: packet.command,
          verification: "Take a new snapshot and inspect the live result before continuing." };
      };
      const status = async (phase = "active") => {
        const fingerprint = await safeUiFingerprint(page).catch(() => null);
        const gate = await page.evaluate(() => ({
          installed: Boolean(window.__trelioMaxAssistState),
          mode: window.__trelioMaxAssistState?.mode || null,
          blockedActions: Number(window.__trelioMaxAssistState?.blockedActions || 0),
        })).catch(() => ({ installed: false, mode: null, blockedActions: 0 }));
        const instructions = config.interactionMode === "read-only"
          ? [
              "Use the existing MAX window or bounded in-session snapshot and controls; read-only forbids context menus.",
              "This recovery surface is read-only: search and exact chat navigation are allowed; composer input and mutations are blocked.",
              "Call assist-stop for this exact session in a finally-style cleanup after inspection.",
            ]
          : [
              config.fallbackFor === "members"
                  ? "Use assist-snapshot and bounded participant-only click/scroll in this exact chat; no member mutation is authorized."
                  : "Use this exact MAX window or assist-snapshot/click/contextmenu/fill/key/scroll/point-click/point-contextmenu/point-scroll; do not attach another tab.",
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
          preparationIssue,
          interactionGate: gate,
          blockedWindows,
          unexpectedNavigation,
          uploadsHandled,
          transfersPending: pendingTransfers.size,
          downloads,
          passiveReadProtection: passiveReadSummary(readGuard),
          instructions,
        };
      };
      const server = http.createServer(async (request, response) => {
        const send = (code, value) => {
          response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store",
            Connection: "close" });
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
            throw new MaxRuntimeError("MAX_ASSIST_CONTROL_REJECTED", "The assisted-browser control request was rejected.");
          }
          const packet = await readBoundedAssistBody(request);
          validateAssistControlPacket(packet, config.sessionId);
          if (closing) {
            throw new MaxRuntimeError("MAX_ASSIST_SESSION_CLOSING", "The exact MAX session is closing.");
          }
          if (packet.command === "status") {
            send(200, await status());
            return;
          }
          if (packet.command === "snapshot" || ["click", "contextmenu", "fill", "key", "scroll", "point-click", "point-contextmenu", "point-scroll"].includes(packet.command)) {
            if (controlBusy) throw new MaxRuntimeError("MAX_ASSIST_CONTROL_BUSY", "Another action is active in this MAX session.");
            controlBusy = true;
            try {
              send(200, packet.command === "snapshot" ? await observe() : await act(packet));
            } finally {
              controlBusy = false;
            }
            return;
          }
          if (controlBusy) {
            throw new MaxRuntimeError("MAX_ASSIST_CONTROL_BUSY", "Wait for the active MAX action before stopping its session.");
          }
          if (pendingTransfers.size > 0) {
            throw new MaxRuntimeError(
              "MAX_ASSIST_TRANSFER_PENDING",
              "The exact authorized file transfer is still in progress. Check status before stopping the session.",
            );
          }
          // Fence another awaited handler before gathering the last read-only
          // status; no new action may slip between acceptance and shutdown.
          closing = true;
          const acknowledgement = await status("closing");
          afterAssistResponse(response, () => stopSession("requested"));
          send(200, acknowledgement);
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
        await attachmentTransfer?.stop();
        await closeAssistControlServer(server);
        for (const screenshot of screenshots) fs.rmSync(screenshot, { force: true });
        fs.rmSync(path.join(connectionRoot(options), "state", "assist-snapshots", config.sessionId),
          { recursive: true, force: true });
      }
      if (interactionFailure) throw interactionFailure;
      if (stopReason === "unexpected_navigation") {
        throw new MaxRuntimeError(
          "MAX_ASSIST_UNEXPECTED_NAVIGATION",
          "The assisted MAX window left the allowed provider origin and was closed.",
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
      writeAssistTerminalState(options, config.sessionId, {
        phase: "failed",
        error: publicFailure.code || "MAX_ASSIST_WORKER_FAILED",
        message: publicFailure.error,
      });
    } else {
      // withBrowser has completed its own finally, including Chrome closure
      // and lock release. Preserve that exact evidence for the stop caller;
      // it retires the receipt, or the next start retires an expired one.
      writeAssistTerminalState(options, config.sessionId, { phase: "closed" });
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
  const pathname = window.location.pathname;
  return {
    pageKind: pathname === "/" ? "home" : /^\/(?:-?\d+|u\/[A-Za-z0-9_-]+)\/?$/u.test(pathname) ? "chat" : "other",
    visibleInputs: count('input:not([type="hidden"])'),
    visibleTextareas: count("textarea"),
    visibleEditables: count('[contenteditable="true"]'),
    visibleButtons: count('button, [role="button"]'),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
});

const passiveReadSummary = (readGuard) => ({
  mode: "preserve-unread",
  blockedFrames: readGuard.blockedFrames,
  blockedByType: { ...readGuard.blockedByType },
  forwardedReadFrames: readGuard.forwardedReadFrames,
  note: "MAX server-side message/reaction read receipts stayed blocked unless a verified send or reply explicitly enabled them.",
});

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

const markReadAfterVerifiedReply = async (page, options, readGuard) => {
  const forwardedBefore = readGuard.forwardedReadFrames;
  readGuard.allowReadReceipts = true;
  try {
    // The UI has already updated its local read marker optimistically while
    // the guard was blocking the network frame. Reloading rehydrates the
    // authoritative unread state and makes MAX emit its normal READ_MESSAGE
    // only after the outgoing answer has been verified in the chat.
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await waitForVisibleMaxUi(page, options.timeoutMs);
    await assertLoggedIn(page);
    const lastMessage = page.locator(
      '[data-message-id], [data-testid*="message" i], [class*="message" i], [aria-label*="сообщ" i], [aria-label*="message" i]',
    ).last();
    if (await lastMessage.count()) {
      await lastMessage.scrollIntoViewIfNeeded({ timeout: options.timeoutMs }).catch(() => undefined);
    }
    await page.waitForTimeout(1_500);
    const forwardedReadFrames = readGuard.forwardedReadFrames - forwardedBefore;
    return {
      attempted: true,
      forwardedReadFrames,
      status: forwardedReadFrames > 0
        ? "read-receipt-forwarded-after-verified-answer"
        : "answer-sent-no-read-receipt-was-needed-or-observed",
    };
  } catch (error) {
    // Sending has already succeeded, so throwing here would invite an unsafe
    // retry and could duplicate the message. Report the narrower read-mark
    // failure while preserving the successful send result.
    return {
      attempted: true,
      forwardedReadFrames: readGuard.forwardedReadFrames - forwardedBefore,
      status: "answer-sent-read-mark-not-confirmed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    readGuard.allowReadReceipts = false;
  }
};

const readChatMessages = async (page, options) => {
  const opened = await openChat(page, options);
  const loadedPages = await loadHistoryPages(page, options.pages, options.timeoutMs);
  let messages = await visibleMessages(page, options.limit);
  let emptyState = opened.emptyState || null;
  if (!emptyState && messages.length === 0) {
    emptyState = await waitForDirectChatHistory(page, opened, options);
    messages = await visibleMessages(page, options.limit);
  }
  if (messages.length === 0) {
    if (emptyState) {
      const chatReference = await rememberOpenedChat(page, options, opened, true);
      if (!chatReference) throw new MaxRuntimeError("MAX_CHAT_IDENTITY_UNVERIFIED",
        "MAX did not retain the exact empty chat surface.",
        { reason: "empty-history-chat-changed", finalMutationActionStarted: false });
      return {
        opened,
        chatReference,
        loadedPages,
        messages: [],
        emptyState,
      };
    }
    // Missing/changed message selectors must not silently claim empty history.
    // Only explicitly verified provider empty states are accepted. A message
    // disappearing between hydration and extraction is not such evidence.
    throw new Error("MAX message history has no recognized messages; empty history is not verified. Keep the dedicated profile and report the UI limitation.");
  }
  return {
    opened,
    chatReference: await rememberOpenedChat(page, options, opened, true),
    loadedPages,
    messages,
  };
};

const readUnreadDialogs = async (page, options) => {
  await openHome(page, options);
  const snapshot = await collectHomeDialogs(page, { ...options, limit: 100 });
  const unreadDialogs = snapshot.dialogs.filter((dialog) => dialog.isUnread).slice(0, options.limit);
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
  const failedChats = chats.filter((chat) => chat.error).length;
  return {
    ok: failedChats === 0,
    unreadDialogs: chats,
    coverage: { ...snapshot.coverage, returned: chats.length, limit: options.limit,
      scannedDialogs: snapshot.dialogs.length, complete: snapshot.coverage.complete
      && snapshot.dialogs.filter((dialog) => dialog.isUnread).length <= options.limit
      && failedChats === 0, failedChats },
  };
};

const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// MAX's current file button opens fd.oneme.ru in a transient window. On
// macOS Chrome can crash in its native download manager before saveAs finishes.
// Intercept only that provider-owned GET navigation, fetch its attachment in
// the same browser context, then answer 204 so Chromium never creates a native
// download. Cookies and signed URLs stay inside Playwright; neither is returned
// to the agent. Other requests, origins and non-navigation resources are intact.
const MAX_FILE_GATEWAY = /^https:\/\/fd\.oneme\.ru\//u;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const safeDownloadFilename = (name) => {
  const filename = path.win32.basename(path.posix.basename(String(name || "")));
  if (!filename || filename === "." || filename === ".." || /[\x00-\x1f\x7f]/u.test(filename)) {
    throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX attachment has no safe file name.");
  }
  return filename;
};

const attachmentResponseFilename = (disposition) => {
  if (!/^attachment(?:;|$)/iu.test(String(disposition || ""))) {
    throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX file gateway did not return an attachment.");
  }
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition);
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/iu.exec(disposition);
  try {
    return safeDownloadFilename(encoded ? decodeURIComponent(encoded[1].trim()) : (ordinary?.[1] ?? ordinary?.[2]?.trim()));
  } catch {
    throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX attachment has no safe file name.");
  }
};

const saveAttachmentAtomically = async (output, name, write) => {
  const destination = fs.existsSync(output) && fs.statSync(output).isDirectory()
    ? path.join(output, safeDownloadFilename(name)) : output;
  if (fs.existsSync(destination)) {
    throw new MaxRuntimeError("MAX_DOWNLOAD_OUTPUT_EXISTS", "Refusing to overwrite an existing MAX download.");
  }
  ensureOutputParentDirectory(path.dirname(destination));
  // An owner-only staging directory keeps an incomplete transfer private.
  // link() publishes a finished file exclusively: unlike saveAs/rename it
  // cannot overwrite a destination created by another process during transfer.
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".trelio-max-download-"));
  if (process.platform !== "win32") fs.chmodSync(staging, 0o700);
  const temporary = path.join(staging, "attachment");
  try {
    await write(temporary);
    const stat = fs.statSync(temporary);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_DOWNLOAD_BYTES) {
      throw new MaxRuntimeError("MAX_DOWNLOAD_SIZE_REJECTED", "MAX downloads must contain 1–268435456 bytes.");
    }
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    const digest = sha256File(temporary);
    fs.linkSync(temporary, destination);
    return { path: destination, name: path.basename(destination), sizeBytes: stat.size, sha256: digest };
  } catch (error) {
    if (error instanceof MaxRuntimeError) throw error;
    throw new MaxRuntimeError(error?.code === "EEXIST" ? "MAX_DOWNLOAD_OUTPUT_EXISTS" : "MAX_DOWNLOAD_SAVE_FAILED",
      error?.code === "EEXIST" ? "Refusing to overwrite an existing MAX download." : "Could not save the complete MAX attachment.");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

const installMaxDownloadNavigation = () => {
  if (window.__trelioMaxDownloadNavigation) return;
  const original = window.open;
  const scoped = function (url, target, ...features) {
    try {
      if (new URL(String(url), window.location.href).origin === "https://fd.oneme.ru") {
        // The first popup navigation has no Playwright Frame yet. Keep this
        // one fixed file gateway in the existing page: its routed 204 leaves
        // MAX loaded and lets Node verify the initiating frame before fetching.
        return original.call(this, url, "_self", ...features);
      }
    } catch { /* Unknown window targets retain the provider's normal behavior. */ }
    return original.call(this, url, target, ...features);
  };
  window.__trelioMaxDownloadNavigation = { original, scoped };
  window.open = scoped;
};

const installAttachmentTransfer = async (page, { output, timeoutMs, onPending = () => {},
  onSaved = () => {}, onFailure = () => {} }) => {
  const context = page.context();
  let transferCount = 0;
  const pending = new Set();
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Assist sessions await their stop signal instead of completion, but still
  // consume this rejection; ordinary download awaits the same exact result.
  void completion.catch(() => undefined);
  const run = (work) => {
    transferCount += 1;
    const transfer = (async () => {
      if (transferCount !== 1) {
        throw new MaxRuntimeError("MAX_DOWNLOAD_MULTIPLE_REJECTED", "One MAX operation may download only one attachment.");
      }
      return work();
    })().then((saved) => { onSaved(saved); resolve(saved); return saved; }).catch((error) => {
      // Playwright exceptions can include a signed file URL. Never return the
      // raw exception, headers or response body across the runtime boundary.
      const failure = error instanceof MaxRuntimeError ? error
        : new MaxRuntimeError("MAX_DOWNLOAD_TRANSFER_FAILED", "MAX attachment transfer failed in the browser session.");
      onFailure(failure);
      reject(failure);
    });
    pending.add(transfer);
    void transfer.finally(() => pending.delete(transfer));
    onPending(transfer);
    return transfer;
  };
  const routeAttachment = async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue().catch(() => undefined);
    let sourceFrame;
    try { sourceFrame = request.frame(); } catch {
      await run(() => { throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX file navigation has no verified initiating frame."); });
      return route.abort().catch(() => undefined);
    }
    try {
      const sourcePage = sourceFrame.page();
      if (request.method() !== "GET" || sourceFrame !== sourcePage.mainFrame()
        || (sourcePage !== page && await sourcePage.opener() !== page)) {
        return route.abort().catch(() => undefined);
      }
    } catch {
      await run(() => { throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX file navigation lost its verified initiating frame."); });
      return route.abort().catch(() => undefined);
    }
    await run(async () => {
      let response;
      try {
        // Redirects are deliberately not followed: a file response cannot
        // widen this fixed provider origin to another site or private network.
        response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: timeoutMs });
        if (response.status() !== 200) {
          throw new MaxRuntimeError("MAX_DOWNLOAD_HTTP_FAILED", "MAX file gateway did not return a complete attachment.",
            { httpStatus: response.status() });
        }
        const headers = response.headers();
        const name = attachmentResponseFilename(headers["content-disposition"]);
        const length = Number(headers["content-length"]);
        if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
          throw new MaxRuntimeError("MAX_DOWNLOAD_SIZE_REJECTED", "MAX attachment exceeds the 256 MiB download limit.");
        }
        const bytes = await response.body();
        if (Number.isFinite(length) && length > 0 && length !== bytes.length) {
          throw new MaxRuntimeError("MAX_DOWNLOAD_SIZE_REJECTED", "MAX attachment size does not match its response.");
        }
        const saved = await saveAttachmentAtomically(output, name,
          (temporary) => fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }));
        // The verified local result remains valid if MAX has already closed its
        // temporary window. Aborting/fulfilling that page never starts a second
        // download and must not turn a saved file into a retryable failure.
        await route.fulfill({ status: 204, body: "" }).catch(() => undefined);
        return { ...saved, transferMethod: "browser-context-attachment" };
      } finally {
        await route.abort().catch(() => undefined);
        await response?.dispose().catch(() => undefined);
      }
    });
  };
  const nativeAttachment = (download) => run(async () => {
    // Legacy same-origin/blob cards still use Playwright's native transfer.
    // Current gateway navigation is consumed above, never retried through a
    // second transport after an ambiguous result.
    const source = new URL(download.url());
    if (source.origin !== MAX_WEB_ORIGIN) {
      throw new MaxRuntimeError("MAX_DOWNLOAD_SOURCE_REJECTED", "MAX attachment used an unsupported file origin.");
    }
    const saved = await saveAttachmentAtomically(output, safeDownloadFilename(download.suggestedFilename()),
      (temporary) => download.saveAs(temporary));
    return { ...saved, transferMethod: "browser-native-attachment" };
  });
  await context.route(MAX_FILE_GATEWAY, routeAttachment);
  // Assist is installed before home navigation; ordinary download is already
  // on its exact chat. Cover both without replacing cookies or provider state.
  await context.addInitScript(installMaxDownloadNavigation);
  await page.evaluate(installMaxDownloadNavigation);
  page.on("download", nativeAttachment);
  return {
    completion,
    stop: async () => {
      page.off("download", nativeAttachment);
      if (pending.size) await Promise.allSettled([...pending]);
      await context.unroute(MAX_FILE_GATEWAY, routeAttachment).catch(() => undefined);
      await page.evaluate(() => {
        const state = window.__trelioMaxDownloadNavigation;
        if (state && window.open === state.scoped) window.open = state.original;
        delete window.__trelioMaxDownloadNavigation;
      }).catch(() => undefined);
    },
  };
};

const downloadSelectedAttachment = async (page, options) => {
  await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  const attachments = target.locator.locator(
    'a[download], button[aria-label*="скач" i], button[aria-label*="download" i], [role="button"][aria-label*="скач" i], [role="button"][aria-label*="download" i], button[title*="скач" i], button[title*="download" i]',
  );
  // Current MAX renders a document as a file card whose accessible button is
  // named “Скачать” by its visible child text, without aria-label/download.
  // Keep the lookup inside the exact message so another file cannot be saved.
  const visibleDownloadButtons = target.locator.getByRole("button", { name: /^(?:скачать|download)$/iu });
  const candidates = await attachments.count() ? attachments : visibleDownloadButtons;
  const count = await candidates.count();
  if (options.attachmentIndex > count) {
    throw new Error(
      `MAX message exposes ${count} downloadable attachment(s); requested index ${options.attachmentIndex}.`,
    );
  }
  const transfer = await installAttachmentTransfer(page, { output: options.output, timeoutMs: options.timeoutMs });
  let timer;
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MaxRuntimeError("MAX_DOWNLOAD_TIMEOUT", "MAX attachment did not finish in time.")), options.timeoutMs);
    });
    // Attach handlers before the click: MAX can synchronously start its popup
    // navigation, so registering after the click loses the exact transfer.
    const completed = Promise.race([transfer.completion, expired]);
    void completed.catch(() => undefined);
    await candidates.nth(options.attachmentIndex - 1).click({ timeout: options.timeoutMs });
    return { downloaded: true, ...(await completed), sourceMessage: target.message };
  } finally {
    clearTimeout(timer);
    await transfer.stop();
  }
};

const replyToMessage = async (page, options, readGuard) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await target.locator.hover({ timeout: options.timeoutMs });
  const namedReply = target.locator.getByRole("button", { name: /ответить|reply/iu });
  if (await namedReply.count() && await namedReply.last().isVisible({ timeout: 700 }).catch(() => false)) {
    await namedReply.last().click({ timeout: options.timeoutMs });
  } else {
    // The current hover toolbar has two unnamed, equally sized buttons next
    // to the bubble: menu on the left and quick reply on the right. Require
    // exactly that scoped shape before clicking; a changed toolbar fails shut.
    const buttons = target.locator.locator("button");
    const visible = [];
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      const box = await button.boundingBox();
      if (box && box.width >= 24 && box.width <= 48 && box.height >= 24 && box.height <= 48) {
        visible.push({ button, x: box.x });
      }
    }
    if (visible.length !== 2 || Math.abs(visible[0].x - visible[1].x) > 90) {
      throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "Could not safely identify the MAX quick-reply toolbar.");
    }
    await visible.sort((left, right) => right.x - left.x)[0].button.click({ timeout: options.timeoutMs });
  }
  const dispatched = await sendOpenChat(page, options);
  const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
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
    throw new Error("MAX did not show a scoped delete confirmation and the target is still present.");
  }
  await target.locator.waitFor({ state: "detached", timeout: Math.min(options.timeoutMs, 15_000) }).catch(() => {
    throw new Error("MAX delete result is ambiguous: the exact message is still present. Do not retry automatically.");
  });
  return {
    deleted: true,
    opened,
    target: target.message,
    policyMode,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const findVerifiedReactionStrip = async (page, menuBox, readyTimeoutMs = 2_500) => {
  // Read all cell rectangles in one provider DOM turn. Playwright's separate
  // boundingBox calls report 0×0 for seven visible reaction controls in this
  // MAX build, whereas getBoundingClientRect in the same page reports 32×32.
  // Stamp only bounded nearby controls so the subsequent click remains tied
  // to the exact menu whose geometry was validated below.
  const collectNearby = () => page.evaluate((menu) => {
    document.querySelectorAll('[data-trelio-max-reaction-index]').forEach((node) => {
      node.removeAttribute('data-trelio-max-reaction-index');
    });
    const result = [];
    for (const node of document.querySelectorAll('button, [role="button"]')) {
      const box = node.getBoundingClientRect();
      if (box.x < menu.x - 50 || box.x > menu.x + menu.width + 50
        || box.y < menu.y - 100 || box.y > menu.y) continue;
      if (result.length >= 32) break;
      node.setAttribute('data-trelio-max-reaction-index', String(result.length));
      result.push({ index: result.length, x: box.x, y: box.y,
        width: box.width, height: box.height });
    }
    return result;
  }, menuBox);
  const deadline = Date.now() + readyTimeoutMs;
  let nearby;
  let strip;
  let distinct;
  do {
    nearby = await collectNearby();
    strip = nearby.filter((box) => box.width >= 28 && box.width <= 40
      && box.height >= 28 && box.height <= 40
      // The strip is 18 px wider than the menu in the current MAX layout.
      && box.x >= menuBox.x - 32 && box.x + box.width <= menuBox.x + menuBox.width + 32
      && box.y >= menuBox.y - 65 && box.y + box.height <= menuBox.y - 10);
    strip.sort((left, right) => left.x - right.x);
    // MAX animates the first seven controls from 0×0 to 32×32 after the menu
    // item has already appeared. Poll only this bounded structural state;
    // no mutation occurs until all eight physical cells form one even row.
    distinct = strip.filter((item, index) => index === 0 || item.x - strip[index - 1].x >= 12);
    if (distinct.length === 8 && distinct.every((item, index) => index === 0
      || (item.x - distinct[index - 1].x >= 35 && item.x - distinct[index - 1].x <= 50))) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  if (distinct.length !== 8 || distinct.some((item, index) => index > 0
    && (item.x - distinct[index - 1].x < 35 || item.x - distinct[index - 1].x > 50))) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX reaction strip no longer has the verified layout.", {
      candidateCount: strip.length,
      distinctCount: distinct.length,
      menuBox: [Math.round(menuBox.x), Math.round(menuBox.y), Math.round(menuBox.width), Math.round(menuBox.height)],
      nearbyButtons: nearby.slice(0, 24).map((box) => [
        Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height),
      ]),
    });
  }
  return distinct.map((box) => ({
    button: page.locator(`[data-trelio-max-reaction-index="${box.index}"]`),
    x: box.x,
  }));
};

const reactionCounterAddedToMessage = (before, after) => {
  if (!before?.timestamp || before.timestamp !== after?.timestamp
    || !before.text.endsWith(before.timestamp) || !after.text.endsWith(after.timestamp)) return false;
  const original = before.text.slice(0, -before.timestamp.length).trim();
  const updated = after.text.slice(0, -after.timestamp.length).trim();
  // MAX renders the emoji as a graphic but places its new numeric count in
  // the message wrapper text. Require an otherwise unchanged exact message
  // and one newly appended positive counter; do not mistake a different
  // message or arbitrary text change for a verified reaction.
  if (!updated.startsWith(`${original} `)) return false;
  const appended = updated.slice(original.length).trim();
  return /^[1-9]\d{0,3}$/u.test(appended);
};

const reactToMessage = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await loadHistoryPages(page, options.pages, options.timeoutMs);
  const target = await findMessageTarget(page, options);
  await openMessageActionMenu(page, target.locator, options.timeoutMs);
  // The seven common reactions are pictograms above the context-menu items.
  // Their buttons currently lack accessible names and text, so bind the
  // requested emoji to one position only after validating the whole strip.
  const reactionOrder = ["👍", "❤️", "🥳", "🔥", "😭", "😍", "👌"];
  const reactionIndex = reactionOrder.indexOf(options.reaction);
  if (reactionIndex < 0) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX reaction is not in the verified quick-reaction strip.");
  }
  const firstMenuItem = page.getByRole("menuitem").first();
  const menuBox = await firstMenuItem.boundingBox();
  if (!menuBox) throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX reaction menu is not visible.");
  const strip = await findVerifiedReactionStrip(page, menuBox);
  await strip[reactionIndex].button.click({ timeout: options.timeoutMs });
  let verified = false;
  const deadline = Date.now() + Math.min(options.timeoutMs, 5_000);
  do {
    const current = (await visibleMessages(page, 100)).find((message) => message.index === target.message.index);
    verified = reactionCounterAddedToMessage(target.message, current);
    if (verified || Date.now() >= deadline) break;
    await page.waitForTimeout(150);
  } while (true);
  if (!verified) {
    throw new Error("MAX reaction result is ambiguous. Do not retry automatically.");
  }
  return {
    reacted: true,
    reaction: options.reaction,
    verification: "The exact message gained one visible reaction counter after the verified emoji-cell click.",
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
  const destination = await chooseExactForwardDestination(page, options.toChat, options.timeoutMs);
  await clickVisibleAction(page, /отправить|send/iu, options.timeoutMs);
  await page.waitForTimeout(1_200);
  return {
    forwarded: true,
    opened,
    target: target.message,
    destination,
    policyMode,
    verification: "MAX accepted the exact destination and closed the send action.",
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const openChatDetails = async (page, options) => {
  // MAX labels the conversation title with its action, including when the
  // caller knows only a numeric chat URL. Prefer that accessible action so a
  // contact banner below the header cannot be mistaken for profile details.
  const profileAction = page.getByRole("button", {
    name: /^(?:открыть профиль|open profile)(?:\s|$)/iu,
  });
  try {
    if (await profileAction.count() === 1 && await profileAction.isVisible({ timeout: 700 })) {
      await profileAction.click({ timeout: options.timeoutMs });
      await page.waitForTimeout(800);
      return;
    }
  } catch {
    // Older MAX layouts may expose only the title or a generic header button.
  }
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
        // MAX's chat title is a broad text button at the left edge of the
        // conversation pane. A URL-only lookup cannot supply its name, while
        // the pane also has several call/menu buttons. Constrain both the
        // position and visible label before choosing any fallback action.
        const label = String(node.getAttribute("aria-label") || node.innerText || node.textContent || "")
          .replace(/\s+/gu, " ").trim();
        return rect.width >= 80
          && rect.height >= 24
          && rect.x > window.innerWidth * 0.37
          && rect.x < window.innerWidth * 0.75
          && rect.y < 65
          && /\p{L}/u.test(label)
          && label.length <= 120
          && !/^(?:назад|back|звонок|позвонить|видеозвонок|поиск|ещё|еще|more|call|video)$/iu.test(label)
          && style.display !== "none"
          && style.visibility !== "hidden";
      });
    if (candidates.length !== 1) return false;
    candidates[0].setAttribute("data-trelio-max-chat-header", "true");
    return true;
  });
  if (!selected) throw new Error("Could not safely identify the MAX chat header/details action.");
  await page.locator('[data-trelio-max-chat-header="true"]').click({ timeout: options.timeoutMs });
  await page.waitForTimeout(800);
};

const collectContactProfile = (page) => page.evaluate(() => {
  const visible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const box = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return box.width >= 20 && box.height >= 10
      && style.display !== "none" && style.visibility !== "hidden";
  };
  const phonePattern = /\+?\d[\d\s()\-–—]{5,24}\d/u;
  const usablePhone = (raw) => {
    const match = String(raw || "").match(phonePattern)?.[0]?.trim() || "";
    const digits = match.replace(/\D/gu, "");
    return digits.length >= 7 && digits.length <= 15 ? match : null;
  };
  // Read only the opened profile/details panel. A phone written in a message,
  // preview, or another contact's sidebar row is never a profile phone.
  const panels = Array.from(document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [class*="profile" i], [class*="details" i], [class*="info" i], main [class~="layout-inner"]',
  )).filter((panel) => visible(panel)
    && panel.getBoundingClientRect().x > 200
    // Current MAX renders contact details as a routed view in the main pane,
    // without a dialog role or a profile class. Its layout-inner is also used
    // by chats: exclude editors as well as history before reading any field.
    && !panel.querySelector('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')
    && !panel.querySelector('[class~="messageWrapper"], [data-message-id]'));
  const scored = panels.map((panel) => {
    const links = Array.from(panel.querySelectorAll('a[href^="tel:"]')).filter(visible);
    const labels = Array.from(panel.querySelectorAll("span, div, label, p"))
      .filter((node) => visible(node) && node.children.length === 0
        && /^(?:номер телефона|телефон|phone(?: number)?)$/iu.test(
          String(node.textContent || "").replace(/\s+/gu, " ").trim()));
    const heading = Array.from(panel.querySelectorAll("h1, h2, h3"))
      .find(visible);
    return { panel, links, labels, heading,
      score: (links.length || labels.length ? 100 : 0) + (heading ? 10 : 0) };
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score
      || a.panel.getBoundingClientRect().width * a.panel.getBoundingClientRect().height
        - b.panel.getBoundingClientRect().width * b.panel.getBoundingClientRect().height);
  const selected = scored[0];
  if (!selected) return { recognized: false, phone: null, phoneVisibility: "unknown" };

  const found = [];
  for (const link of selected.links) {
    const number = usablePhone(link.textContent) || usablePhone(link.getAttribute("href")?.slice(4));
    if (number) found.push(number);
  }
  for (const label of selected.labels) {
    // Provider layouts differ in whether the number is a sibling or a child
    // of the row. Inspect at most two ancestors of the exact phone label.
    const row = label.parentElement;
    const text = [row?.textContent, row?.parentElement?.textContent]
      .map((value) => String(value || "").replace(label.textContent || "", ""));
    for (const value of text) {
      const number = usablePhone(value);
      if (number) { found.push(number); break; }
    }
  }
  const distinct = [...new Map(found.map((number) => [number.replace(/\D/gu, ""), number])).values()];
  return {
    recognized: true,
    name: selected.heading?.textContent?.replace(/\s+/gu, " ").trim() || null,
    phone: distinct.length === 1 ? distinct[0] : null,
    phoneVisibility: distinct.length === 1 ? "visible"
      : distinct.length > 1 ? "ambiguous" : "not_visible_in_profile",
  };
});

const readContactProfile = async (page, options) => {
  const opened = await openChat(page, options);
  // MAX uses numeric routes for direct contacts as well as group chats. The
  // URL shape cannot classify a person; only the opened, scoped details panel
  // can establish whether it exposes one visible profile phone.
  await openChatDetails(page, options);
  const profile = await collectContactProfile(page);
  if (!profile.recognized || profile.phoneVisibility === "ambiguous") {
    throw new Error("Could not safely identify one MAX contact profile phone. The runtime failed closed.");
  }
  return { opened, ...profile, url: normalizeChatUrl(page.url()) };
};

const collectVisibleMembers = (page) => page.evaluate(() => {
  document.querySelectorAll("[data-trelio-max-member]").forEach((node) => {
    node.removeAttribute("data-trelio-max-member");
  });
  document.querySelectorAll("[data-trelio-max-member-surface]").forEach((node) => {
    node.removeAttribute("data-trelio-max-member-surface");
  });
  // Standalone profile links can occur in chat messages and never prove that
  // the linked bot belongs to this chat. Inspect participant-style rows only.
  // A chat history also contains listitems. Only rows explicitly marked as
  // participants inside a visible details surface may establish membership.
  const details = Array.from(document.querySelectorAll(
    '[role="dialog"], [class*="info" i], [class*="detail" i], [class*="member" i]',
  )).filter((node) => /(?:^|\s)(?:участники|members)(?:\s+\d+)?(?:\s|$)/iu.test(
    (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim(),
  ));
  let rows = Array.from(document.querySelectorAll(
    '[data-testid*="member" i], [class*="member" i], [role="listitem"]',
  )).filter((row) => details.some((panel) => panel !== row && panel.contains(row)));
  if (rows.length === 0) {
    // Current MAX renders participant entries as ordinary buttons without a
    // member class. Anchor them to the details panel's Participants tab and
    // Add/Invite actions, then take only full-width rows below those actions.
    // Chat-history buttons and sidebar dialogs never satisfy this geometry.
    const visibleButton = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width >= 40 && rect.height >= 16 && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const label = (node) => String(node.getAttribute("aria-label") || node.innerText || node.textContent || "")
      .replace(/\s+/gu, " ").trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visibleButton);
    const participantTabs = buttons.filter((node) => /^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?)$/iu.test(label(node)));
    const addActions = buttons.filter((node) => /^(?:добавить участников|add (?:participants|members))$/iu.test(label(node)));
    const inviteActions = buttons.filter((node) => /^(?:пригласить по ссылке|invite by link)$/iu.test(label(node)));
    if (participantTabs.length === 1 && addActions.length === 1 && inviteActions.length === 1) {
      const tab = participantTabs[0].getBoundingClientRect();
      const add = addActions[0].getBoundingClientRect();
      const invite = inviteActions[0].getBoundingClientRect();
      const aligned = Math.abs(add.x - invite.x) <= 16 && Math.abs(add.width - invite.width) <= 16
        && tab.x >= add.x - 16 && tab.x < add.x + add.width
        && invite.y >= add.y + add.height - 8;
      if (aligned) {
        rows = buttons.filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.y >= invite.y + invite.height - 4
            && Math.abs(rect.x - add.x) <= 16
            && rect.width >= add.width * 0.8
            && rect.height >= 32 && rect.height <= 120;
        });
      }
    }
  }
  if (rows.length === 0) {
    throw new Error("Could not safely identify the MAX participant list in chat details.");
  }
  // The marker is scoped to the smallest details container that includes the
  // participant rows. The assisted reader and bounded scroller use this exact
  // surface so changing sidebar previews cannot invalidate a member snapshot.
  const surface = details.filter((panel) => rows.every((row) => panel.contains(row)))
    .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0]
    || (() => {
      let ancestor = rows[0].parentElement;
      while (ancestor && ancestor !== document.body) {
        const text = (ancestor.innerText || ancestor.textContent || "").replace(/\s+/gu, " ");
        if (/(?:участники|members)/iu.test(text)
          && rows.every((row) => ancestor.contains(row))) return ancestor;
        ancestor = ancestor.parentElement;
      }
      return null;
    })();
  if (!surface || surface === document.body) {
    throw new Error("Could not safely identify the MAX participant surface in chat details.");
  }
  surface.setAttribute("data-trelio-max-member-surface", "true");
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;
    const rect = row.getBoundingClientRect();
    const style = window.getComputedStyle(row);
    if (rect.width < 40 || rect.height < 16 || style.display === "none" || style.visibility === "hidden") continue;
    const text = (row.innerText || row.textContent || "").replace(/\s+/gu, " ").trim();
    if (!text || text.length > 500) continue;
    const link = row.matches("a[href]") ? row : row.querySelector('a[href*="/u/"], a[href*="_bot"]');
    let href = null;
    let linkedHandle = null;
    try {
      const parsed = link instanceof HTMLAnchorElement ? new URL(link.href, window.location.origin) : null;
      const handle = parsed?.pathname.match(/^\/(?:u\/)?([A-Za-z0-9_-]+)\/?$/u)?.[1];
      if (parsed && ["max.ru", "web.max.ru"].includes(parsed.hostname)
        && parsed.protocol === "https:" && !parsed.search && !parsed.hash && handle) {
        href = parsed.toString();
        linkedHandle = handle;
      }
    } catch {
      // An unrelated link cannot prove membership identity.
    }
    const stableId = linkedHandle || text.match(/@([A-Za-z0-9_.-]+)/u)?.[1] || null;
    if (row.matches("a[href]") && !stableId) continue;
    const key = stableId?.toLowerCase() || text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    row.setAttribute("data-trelio-max-member", String(result.length));
    result.push({ index: result.length, title: text, text, url: href, stableId });
  }
  return result;
});

const positionMemberList = (page, reset) => page.evaluate((goToStart) => {
  const surface = document.querySelector('[data-trelio-max-member-surface="true"]');
  if (!surface) return { recognized: false, scrollable: false, atEnd: false, expectedCount: null };
  const labels = Array.from(surface.querySelectorAll('h1, h2, h3, button, [role="button"]'))
    .map((node) => String(node.getAttribute("aria-label") || node.innerText || node.textContent || "")
      .replace(/\s+/gu, " ").trim());
  const counts = [...new Set(labels.map((label) => label.match(
    /^(?:участники\s+(\d+)|(\d+)\s+участников|members\s+(\d+))$/iu,
  )).filter(Boolean).map((match) => Number(match[1] || match[2] || match[3])))];
  if (counts.length > 1) return { recognized: false, scrollable: false, atEnd: false, expectedCount: null };
  let scroller = surface.querySelector('[data-trelio-max-member]')?.parentElement || surface;
  while (scroller && scroller !== surface.parentElement) {
    const style = window.getComputedStyle(scroller);
    if (scroller.scrollHeight > scroller.clientHeight + 2 && /auto|scroll/u.test(style.overflowY)) break;
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === surface.parentElement) {
    return { recognized: true, scrollable: false, atEnd: true, expectedCount: counts[0] ?? null };
  }
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  if (goToStart) scroller.scrollTop = 0;
  else if (!atEnd) {
    scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.8);
  }
  return { recognized: true, scrollable: true,
    atEnd: !goToStart && atEnd,
    expectedCount: counts[0] ?? null };
}, reset);

const ensureVisibleMemberSection = async (page, options) => {
  try {
    return await collectVisibleMembers(page);
  } catch (error) {
    if (!/Could not safely identify the MAX participant list/iu.test(String(error?.message || ""))) throw error;
  }
  const section = page.getByRole("button", {
    name: /^(?:участники(?:\s+\d+)?|\d+\s+участников|members(?:\s+\d+)?)$/iu,
  });
  if (await section.count() !== 1 || !await section.isVisible({ timeout: 700 }).catch(() => false)) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX participant section is not uniquely identified.");
  }
  await section.click({ timeout: options.timeoutMs });
  await page.waitForTimeout(250);
  return collectVisibleMembers(page);
};

/**
 * MAX virtualizes large participant lists. A top-of-panel DOM read can prove
 * the visible rows, but it cannot prove that a bot is absent. Walk the exact
 * details scroller and require its advertised participant count when present.
 */
const collectCompleteMembers = async (page, options) => {
  await ensureVisibleMemberSection(page, options);
  let position = await positionMemberList(page, true);
  if (!position.recognized) throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX participant surface is not recognized.");
  await page.waitForTimeout(150);
  const members = [];
  const seen = new Set();
  let reachedEnd = false;
  for (let step = 0; step < 40; step += 1) {
    const visible = await collectVisibleMembers(page);
    for (const member of visible) {
      const key = member.stableId?.toLowerCase() || member.url
        || normalizeContactReference(member.title).replace(
          /\s+(?:был\(-а\) недавно|в сети|только что|\d+\s+(?:мин|ч) назад)$/iu, "",
        );
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ ...member, index: members.length });
    }
    position = await positionMemberList(page, false);
    if (!position.recognized) break;
    if (position.atEnd) { reachedEnd = true; break; }
    await page.waitForTimeout(150);
  }
  if (!reachedEnd || (position.expectedCount !== null && members.length !== position.expectedCount)) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX participant list is incomplete; full membership cannot be verified.");
  }
  return { members, coverage: { complete: true, scope: "participants", count: members.length } };
};

const listChatMembers = async (page, options) => {
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  return { opened, ...await collectCompleteMembers(page, options) };
};

const createDirectChat = async (page, options, readGuard) => {
  const policyMode = assertMutationAllowed(options);
  const contactUrl = normalizeChatUrl(options.contact);
  if (!/\/u\/[A-Za-z0-9_-]+\/?$/u.test(new URL(contactUrl).pathname)) {
    throw new Error("create-direct requires an official MAX /u/ contact URL.");
  }
  await page.goto(contactUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  assertDocumentAvailable(page);
  await waitForVisibleMaxUi(page, options.timeoutMs);
  await assertLoggedIn(page);
  const dispatched = await sendOpenChat(page, options);
  const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
  return {
    created: true,
    kind: "direct",
    contactUrl,
    policyMode,
    ...dispatched,
    readMark,
    retryPolicy: "Do not retry automatically after an ambiguous failure.",
  };
};

const clickNewChatAction = async (page, timeoutMs) => {
  // MAX labels the blue plus “Начать общение” in the current Russian UI.
  // Match its accessible action name, never an arbitrary blue or plus button.
  const explicit = page.getByRole("button", { name: /начать общение|новый чат|создать чат|start (?:a )?chat|new chat|create chat/iu }).last();
  if (await explicit.count() && await explicit.isVisible({ timeout: 700 }).catch(() => false)) {
    await explicit.click({ timeout: timeoutMs });
  } else {
    const plus = page.locator(
      'button[aria-label*="начать общение" i], button[aria-label*="созд" i], button[aria-label*="добав" i], button[aria-label="+"], [role="button"][aria-label="+"]',
    ).first();
    if (!await plus.count() || !await plus.isVisible({ timeout: 700 }).catch(() => false)) {
      throw new Error("Could not safely identify the MAX new-chat action.");
    }
    await plus.click({ timeout: timeoutMs });
  }
};

const clickCreateGroupMenuAction = (page, timeoutMs) => {
  // Current MAX calls the menu item “Создать группу”; “групповой чат” is
  // retained for older clients while the anchored match excludes channels
  // and group calls immediately below it.
  return clickVisibleAction(page,
    /^(?:создать группу|создать групповой чат|create (?:a )?group(?: chat)?)$/iu,
    timeoutMs);
};

const openCreateGroupFlow = async (page, options) => {
  await openHome(page, options);
  await clickNewChatAction(page, options.timeoutMs);
  await clickCreateGroupMenuAction(page, options.timeoutMs);
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
  if (!titleInput) throw new Error("Could not safely identify the MAX group title field.");
  await fillLocator(titleInput, options.title, page);
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("MAX group avatar upload is unavailable in the current UI.");
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
      "Several MAX chats already use this exact title. Use a unique title before creating another group.",
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
      `A MAX chat named ${options.title} already exists but is missing requested members: ${verification.missing.join(", ")}. Use a unique title.`,
    );
  }
  await openCreateGroupFlow(page, options);
  const selectedMembers = [];
  for (const member of options.members) {
    selectedMembers.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
  }
  await clickVisibleAction(page, /продолжить|continue|далее|next/iu, options.timeoutMs);
  await fillGroupTitleAndAvatar(page, options);
  await clickVisibleAction(page, /^(?:создать|создать чат|create|create chat)$/iu, options.timeoutMs);
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
    throw new Error("MAX group creation result is ambiguous and exact live verification failed. Do not retry automatically.");
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
  await ensureVisibleMemberSection(page, options);
  const changed = [];
  let beforeMembers = [];
  if (!remove) {
    const before = await collectCompleteMembers(page, options);
    beforeMembers = before.members;
    const pending = options.members.filter((reference) => {
      try {
        selectExactContactResult(beforeMembers, reference);
        return false;
      } catch (error) {
        // An ambiguous existing participant is unsafe to interpret as absent.
        if (!String(error?.message || "").startsWith("No exact MAX contacts matched ")) throw error;
        return true;
      }
    });
    if (pending.length === 0) {
      return {
        changed: false,
        alreadyMembers: true,
        opened,
        members: beforeMembers,
        policyMode,
      };
    }
    await positionMemberList(page, true);
    await clickVisibleAction(page, /добавить участников|add (?:participants|members)/iu, options.timeoutMs);
    for (const member of pending) {
      changed.push(await chooseExactPickerEntry(page, member, options.timeoutMs));
    }
    // The details pane still shows “Добавить участников” behind the picker.
    // Require the exact final action so it cannot reopen that picker.
    await clickVisibleAction(page, /^(?:добавить|add)$/iu, options.timeoutMs);
  } else {
    for (const member of options.members) {
      const current = await collectCompleteMembers(page, options);
      const selected = selectExactContactResult(current.members, member);
      await positionMemberList(page, true);
      let visibleSelection = null;
      for (let step = 0; step < 40; step += 1) {
        const visible = await collectVisibleMembers(page);
        try {
          visibleSelection = selectExactContactResult(visible,
            selected.stableId ? `@${selected.stableId}` : selected.url || member);
          break;
        } catch (error) {
          if (!String(error?.message || "").startsWith("No exact MAX contacts matched ")) throw error;
        }
        const position = await positionMemberList(page, false);
        if (position.atEnd || !position.recognized) break;
        await page.waitForTimeout(150);
      }
      if (!visibleSelection) {
        throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "The selected MAX participant is not visible in the bounded member list.");
      }
      // A normal click on the participant row opens that person's personal
      // profile. Its More menu may delete a contact or chat, not remove group
      // membership. Hover the exact row and use only an action aligned with
      // that row inside the group's participant list.
      await openSelectedMemberRowMore(page, visibleSelection.index, options.timeoutMs);
      await clickRowMemberRemovalAction(page, options.timeoutMs);
      const confirmed = await confirmVisibleDialogAction(page, /удалить|исключить|remove|kick/iu, options.timeoutMs);
      if (!confirmed) throw new Error("MAX did not show the expected scoped member-removal confirmation.");
      changed.push(selected);
    }
  }
  await page.waitForTimeout(1_000);
  if (!remove) {
    // A successful click is not proof of membership. Reload the exact chat so
    // a still-open picker cannot be mistaken for the live participant list.
    const current = await listChatMembers(page, options);
    const missing = changed.filter((selected) => {
      if (selected.verifiedSearchHandle) {
        // The picker bound this display name to an exact @username search.
        // After Add, require one newly appearing live member with that name.
        const displayName = normalizeContactReference(selected.title).replace(/\s+бот$/iu, "");
        const hasName = (member) => {
          const title = normalizeContactReference(member.title);
          return title === displayName || title.startsWith(`${displayName} `);
        };
        return beforeMembers.some(hasName)
          || current.members.filter(hasName).length !== 1
          || current.members.length < beforeMembers.length + changed.length;
      }
      try {
        const identity = selected.stableId ? `@${selected.stableId}` : selected.url || selected.title;
        selectExactContactResult(current.members, identity);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      throw new MaxRuntimeError(
        "MAX_MEMBER_ADD_UNVERIFIED",
        "MAX accepted the add action, but the exact participant was not verified in the live member list. Reread membership before retrying.",
        { finalMutationActionStarted: true, missingCount: missing.length },
      );
    }
  } else {
    // A confirmation click does not prove that MAX removed the selected
    // participant. Reload the exact group's member list and require that
    // every requested reference is absent before reporting success.
    const current = await listChatMembers(page, options);
    for (const reference of options.members) {
      try {
        selectExactContactResult(current.members, reference);
        throw new MaxRuntimeError(
          "MAX_MEMBER_REMOVE_UNVERIFIED",
          "MAX accepted the removal action, but the exact participant is still in the live member list. Do not retry automatically.",
          { finalMutationActionStarted: true },
        );
      } catch (error) {
        if (error instanceof MaxRuntimeError) throw error;
        if (!String(error?.message || "").startsWith("No exact MAX contacts matched ")) {
          throw new MaxRuntimeError(
            "MAX_MEMBER_REMOVE_UNVERIFIED",
            "MAX accepted the removal action, but the exact participant could not be verified absent. Do not retry automatically.",
            { finalMutationActionStarted: true },
          );
        }
      }
    }
  }
  return {
    changed: true,
    operation: remove ? "remove" : "add",
    opened,
    members: changed,
    policyMode,
    retryPolicy: "Do not repeat an ambiguous member mutation before rereading the live member list.",
  };
};

const findChatSettingsField = async (page, kind) => {
  const heading = kind === "title" ? /^название чата$/iu : /^описание чата$/iu;
  if (await page.getByText(heading, { exact: true }).count() !== 1) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX chat settings field label is not unique.");
  }
  const viewport = page.viewportSize() || { width: 1280, height: 900 };
  const fields = page.locator(kind === "title" ? 'input:not([type="hidden"])' : "textarea");
  const matches = [];
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (!await field.isVisible().catch(() => false)) continue;
    const box = await field.boundingBox();
    // The chat form is in the upper right pane. This excludes the left chat
    // search and the lower message composer even when labels are not wired to
    // their inputs. A changed layout must fail closed rather than edit another
    // field, as the old generic "last textbox" fallback did.
    if (box && box.x >= viewport.width * 0.3 && box.y < viewport.height * 0.6
      && box.width >= viewport.width * 0.3 && box.height >= 20) matches.push(field);
  }
  if (matches.length !== 1) {
    throw new MaxRuntimeError("MAX_UI_UNSUPPORTED", "MAX chat settings field is not uniquely identified.");
  }
  return matches[0];
};

const updateChat = async (page, options) => {
  const policyMode = assertMutationAllowed(options);
  const opened = await openChat(page, options);
  await openChatDetails(page, options);
  // Group Info currently exposes a pencil icon as “Показать настройки”.
  // The older named edit action remains valid for other MAX layouts.
  await clickVisibleAction(page, /^(?:показать настройки|редактировать чат|edit chat|show settings)$/iu, options.timeoutMs);
  if (options.title) {
    await fillLocator(await findChatSettingsField(page, "title"), options.title, page);
  }
  if (options.description !== null) {
    await fillLocator(await findChatSettingsField(page, "description"), options.description, page);
  }
  if (options.avatar) {
    const upload = page.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!await upload.count()) throw new Error("MAX chat avatar upload is unavailable in the current UI.");
    await upload.setInputFiles(options.avatar, { timeout: options.timeoutMs });
  }
  await clickVisibleAction(page, /сохранить|save/iu, options.timeoutMs);
  await page.waitForTimeout(1_000);
  if (options.title || options.description !== null) {
    // A filled field only proves a local draft. Re-enter the exact chat's
    // settings after save to establish that the server persisted both values.
    await openChat(page, options);
    await openChatDetails(page, options);
    await clickVisibleAction(page, /^(?:показать настройки|редактировать чат|edit chat|show settings)$/iu, options.timeoutMs);
    const title = options.title ? await (await findChatSettingsField(page, "title")).inputValue() : null;
    const description = options.description !== null
      ? await (await findChatSettingsField(page, "description")).inputValue() : null;
    if ((options.title && title !== options.title)
      || (options.description !== null && description !== options.description)) {
      throw new Error("MAX chat update result is ambiguous. Reread chat details before retrying.");
    }
  }
  return {
    updated: true,
    opened,
    title: options.title || null,
    description: options.description,
    avatar: options.avatar ? fileApprovalDescriptor(options.avatar) : null,
    policyMode,
    retryPolicy: "Reread live chat details before retrying an ambiguous update.",
  };
};

const runBrowserCommand = async (options) => {
  // Reject malformed commands before launching a browser or acquiring its
  // profile. Missing --query for contacts is a CLI error, not a login failure.
  validateCommandOptions(options);
  if (options.command === "login" && !options.headed) throw new Error("MAX login requires --headed.");
  return withBrowser(options, (page, readGuard) => executeBrowserCommand(page, options, readGuard));
};

const executeBrowserCommand = async (page, options, readGuard) => {
  if (options.command === "login") {
    // A new owner handoff may switch the MAX account inside this same profile.
    // Invalidate only locator metadata; cookies and credentials remain owned by
    // the normal login flow. Never reuse task bindings across such a handoff.
    loadChatReferences(options);
    if (hasChatReferenceIdentity(options)) writeChatReferences(options, { schemaVersion: 1, chats: [] });
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
      browserSession: { kind: "dedicated-chromium", sharedWithCodexBrowser: false },
      searchReady: true,
      fingerprint: await safeUiFingerprint(page),
      passiveReadProtection: passiveReadSummary(readGuard),
      diagnosticPolicy: "No chat text, message text, cookies or credentials are included.",
    };
  }
  if (options.command === "dialogs") {
    await openHome(page, options);
    if (!options.query) {
      const snapshot = await collectHomeDialogs(page, options);
      return { query: "", ...snapshot, knownChats: knownChatReferences(options), passiveReadProtection: passiveReadSummary(readGuard) };
    }
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    return {
      query: options.query,
      dialogs: (await collectDialogResults(page, options.query)).slice(0, options.limit),
      knownChats: knownChatReferences(options),
      coverage: { complete: false, scope: "visible-search-results" },
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "contacts") {
    await openHome(page, options);
    const phone = normalizePhoneLookupQuery(options.query);
    if (phone) {
      return {
        ...(await lookupContactByPhone(page, options, phone)),
        passiveReadProtection: passiveReadSummary(readGuard),
      };
    }
    const search = await findSearchInput(page, options.timeoutMs);
    await fillLocator(search, options.query, page);
    await page.waitForTimeout(1_800);
    const results = await collectDialogResults(page, options.query);
    return {
      query: options.query,
      contacts: results.filter((result) => result.url?.includes("/u/") || /@[A-Za-z0-9_.-]+/u.test(result.text)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "profile") {
    const result = await readContactProfile(page, options);
    return {
      ...result,
      chatReference: await rememberOpenedChat(page, options, result.opened, true),
      passiveReadProtection: passiveReadSummary(readGuard),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "read") {
    return {
      ...(await readChatMessages(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
      note: "Loaded MAX messages are returned with bounded structured metadata; read receipts stay blocked.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "unread") {
    return {
      ...(await readUnreadDialogs(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
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
      ok: snapshots.every((snapshot) => snapshot.ok !== false),
      snapshots,
      passiveReadProtection: passiveReadSummary(readGuard),
      schedulingNote: "Use the host scheduler for durable background monitoring; this command is intentionally bounded.",
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "download") {
    return {
      ...(await downloadSelectedAttachment(page, options)),
      passiveReadProtection: passiveReadSummary(readGuard),
      securityBoundary: "chat-only",
    };
  }
  if (options.command === "send") {
    const policyMode = assertMutationAllowed(options);
    const opened = await openChat(page, options);
    const dispatched = await sendOpenChat(page, options);
    const readMark = await markReadAfterVerifiedReply(page, options, readGuard);
    return {
      sent: true,
      opened,
      policyMode,
      ...dispatched,
      readMark,
      passiveReadProtection: passiveReadSummary(readGuard),
      retryPolicy: "Do not retry automatically after an ambiguous failure.",
    };
  }
  if (options.command === "reply") {
    return {
      ...(await replyToMessage(page, options, readGuard)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "edit") {
    return { ...(await editMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "delete") {
    return { ...(await deleteMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "react") {
    return { ...(await reactToMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "forward") {
    return { ...(await forwardMessage(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "create-direct") {
    return {
      ...(await createDirectChat(page, options, readGuard)),
      passiveReadProtection: passiveReadSummary(readGuard),
    };
  }
  if (options.command === "create-group") {
    return { ...(await createGroupChat(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "members") {
    return { ...(await listChatMembers(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "member-add") {
    return { ...(await mutateMembers(page, options, false)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "member-remove") {
    return { ...(await mutateMembers(page, options, true)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  if (options.command === "chat-update") {
    return { ...(await updateChat(page, options)), passiveReadProtection: passiveReadSummary(readGuard) };
  }
  throw new Error(`Unsupported MAX browser command: ${options.command}`);
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
      browserSession: { kind: "dedicated-chromium", sharedWithCodexBrowser: false },
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
  const result = await runBrowserCommand(options);
  output({ ok: true, ...result });
  if (result.ok === false) process.exitCode = 2;
};

export {
  ADAPTER_VERSION,
  MEMBER_REMOVE_ACTION,
  inspectMemberRemovalSurface,
  openSelectedMemberRowMore,
  clickRowMemberRemovalAction,
  MaxRuntimeError,
  assistAppName,
  assistStartupDeadline,
  waitForAssistShutdown,
  closeAssistControlServer,
  afterAssistResponse,
  writeAssistTerminalState,
  readAssistSession,
  assistInteractionAllowed,
  collectDialogResults,
  collectContactProfile,
  collectHomeDialogs,
  requireRuntimeIdentity,
  runtimeErrorPayload,
  openChat,
  visibleMessages,
  findMessageTarget,
  validateCommandOptions,
  withBrowser,
  readUnreadDialogs,
  runBrowserCommand,
  assertMutationAllowed,
  assertSendAllowed,
  buildMutationPreview,
  connectionRoot,
  chatReferencesPath,
  loadChatReferences,
  normalizeChatContextRef,
  knownChatReferences,
  rememberChatReference,
  contextChatReference,
  inspectOpenedChatReference,
  rememberOpenedChat,
  canRecoverAssistPreparation,
  installPassiveReadGuard,
  installMaxAssistGate,
  inspectMaxSessionDocument,
  loadPolicy,
  normalizeDialogTitle,
  normalizeMaxRuntimeError,
  normalizeChatUrl,
  normalizeContactReference,
  normalizePhoneLookupQuery,
  lookupContactByPhone,
  inspectPhoneLookupOutcome,
  openChatDetails,
  openHome,
  installDocumentHttpObserver,
  assertDocumentAvailable,
  parseArguments,
  prepareAssistAuthorization,
  passiveReadFrameMarker,
  policyPath,
  selectExactDialogResult,
  isFavoritesReference,
  inspectFavoritesSurface,
  inspectDirectChatHistorySurface,
  waitForDirectChatHistory,
  readChatMessages,
  selectFavoritesHomeDialog,
  selectExactContactResult,
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
  chooseExactPickerEntry,
  selectExactForwardDestination,
  findChatSettingsField,
  findVerifiedReactionStrip,
  reactionCounterAddedToMessage,
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
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "__assist-worker") {
    // The detached worker communicates only through its owner-only session
    // record and authenticated loopback channel; stdout/stderr are discarded.
    runAssistWorker().catch(() => {
      process.exitCode = 2;
    });
  } else {
    main().catch((error) => {
      output(runtimeErrorPayload(error));
      process.exitCode = 2;
    });
  }
}
