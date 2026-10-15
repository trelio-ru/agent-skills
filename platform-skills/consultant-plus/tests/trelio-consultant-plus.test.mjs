import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.resolve(testDirectory, "../scripts/trelio-consultant-plus.mjs");
const companyId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";

const readInstructionBundle = async () => {
  const skillDirectory = path.resolve(testDirectory, "..");
  return readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
};

const runRuntime = async (configHome, args, extraEnvironment = {}) => {
  const result = await execFileAsync(process.execPath, [runtimePath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TRELIO_CONFIG_HOME: configHome,
      TRELIO_SKILL_ID: "consultant-plus",
      TRELIO_SKILL_COMPANY_ID: companyId,
      TRELIO_SKILL_MEMBER_ID: memberId,
      ...extraEnvironment,
    },
  });
  return JSON.parse(result.stdout);
};

test("runtime persists browser access state without credentials", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-consultant-plus-"));
  const configHome = path.join(temporaryDirectory, "config");

  try {
    assert.deepEqual(await runRuntime(configHome, ["status"]), {
      ok: true,
      accessState: "unknown",
      browserPreference: null,
      configured: false,
      canUseConsultantPlus: false,
      lastVerifiedAt: null,
      updatedAt: null,
      storesCredentials: false,
    });

    const connected = await runRuntime(configHome, [
      "set-connected",
      "--browser",
      "codex-chrome",
    ]);
    assert.equal(connected.accessState, "connected");
    assert.equal(connected.browserPreference, "codex-chrome");
    assert.equal(connected.canUseConsultantPlus, true);
    assert.match(connected.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/u);

    const stateFile = path.join(
      configHome,
      "integrations",
      "consultant-plus",
      companyId,
      memberId,
      "browser",
      "state",
      "access.json",
    );
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(stored.accessState, "connected");
    assert.equal(stored.browserPreference, "codex-chrome");
    assert.equal(Object.hasOwn(stored, "cookie"), false);
    assert.equal(Object.hasOwn(stored, "password"), false);

    if (process.platform !== "win32") {
      assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
      assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    }

    const reconnect = await runRuntime(configHome, ["set-needs-reconnect"]);
    assert.equal(reconnect.accessState, "needs_reconnect");
    assert.equal(reconnect.browserPreference, "codex-chrome");
    assert.equal(reconnect.lastVerifiedAt, null);

    const noAccess = await runRuntime(configHome, ["set-no-access"]);
    assert.equal(noAccess.accessState, "no_access");
    assert.equal(noAccess.browserPreference, null);

    const reset = await runRuntime(configHome, ["reset", "--confirm"]);
    assert.equal(reset.accessState, "unknown");
    assert.equal(reset.configured, false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("runtime rejects invalid identity, browser and symlinked private paths", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "trelio-consultant-plus-safe-"));
  const configHome = path.join(temporaryDirectory, "config");

  try {
    await assert.rejects(
      runRuntime(configHome, ["status"], { TRELIO_SKILL_MEMBER_ID: "not-a-uuid" }),
      /TRELIO_SKILL_MEMBER_ID/u,
    );
    await assert.rejects(
      runRuntime(configHome, ["set-connected", "--browser", "safari"]),
      /поддерживаемый --browser/u,
    );

    await mkdir(configHome, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(configHome, 0o700);
    const externalDirectory = path.join(temporaryDirectory, "external");
    await mkdir(externalDirectory);
    await symlink(externalDirectory, path.join(configHome, "integrations"), "dir");

    await assert.rejects(
      runRuntime(configHome, ["set-no-access"]),
      /Небезопасный путь локального состояния/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("skill keeps onboarding, browser handoff, workspace evidence, export and fallback decisions explicit", async () => {
  const instructions = await readInstructionBundle();

  // Keep every pre-refactor security/evidence decision explicit while allowing
  // concise phrasing. These assertions cover the main delivered text itself;
  // the Markdown skill must not depend on inaccessible package references.
  const decisions = [
    /ask once\s+whether the user wants this skill and has access/u,
    /`no_access`: do not repeat the access question/u,
    /`unavailable_on_surface`[\s\S]*without changing saved state/u,
    /Codex desktop: `codex-browser`[\s\S]*in-app Browser/u,
    /Claude in Chrome/u,
    /Show the browser only for required human/u,
    /hide\s+or collapse[\s\S]*keeping exact tab\/profile\/session alive/u,
    /Continue\s+search, navigation, bounded DOM reading, export and download verification[\s\S]*background/u,
    /do not bring the window back unless the user must act/u,
    /warning that work \*\*will\*\* end[\s\S]*Продолжить работу[\s\S]*not logout/u,
    /AX\/DOM click[\s\S]*fresh screenshot[\s\S]*visual click[\s\S]*recheck/u,
    /Never[\s\S]*request\s+sign-in or report an access blocker from that warning alone/u,
    /Download\s+autonomously/u,
    /Before Agent Workspace handoff\/submit, save every exact source materially/u,
    /supporting conclusions, recommendations, controlling dates, quotes or edition/u,
    /Exclude exploratory\/unrelied results/u,
    /commentary[\s\S]*labeled commentary rather than primary source/u,
    /Do not automatically attach\s+or publish all sources outside that Workspace/u,
    /Prefer DOCX/u,
    /PDF for forms/u,
    /Unicode text/u,
    /no bulk result-list,[\s\S]*all-edition or corpus exports/u,
    /Never request, receive, store or inspect\s+login\/password, OTP, cookies, profile files or session tokens/u,
    /independent public legal source/u,
    /wait for explicit selection/u,
    /not automatic switching/u,
    /Never enter protected ConsultantPlus via alternate credentials/u,
  ];
  for (const decision of decisions) assert.match(instructions, decision);
  assert.ok(Buffer.byteLength(instructions.trim()) <= 16384);

});
