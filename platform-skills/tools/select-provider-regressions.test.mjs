import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { selectProviderRegressions } from "./select-provider-regressions.mjs";

test("VK Ads native credential regressions run on macOS and Windows alongside Linux fail-closed tests", () => {
  const selection = selectProviderRegressions(["platform-skills/vk-ads/scripts/storage.mjs"]);
  assert.deepEqual(selection.selfHostedSkills, ["vk-ads"]);
  assert.equal(selection.hostedMatrix.include.length, 3);
  assert.ok(selection.hostedMatrix.include.every(row => row.skill === "vk-ads" && row.test_file === "platform-skills/vk-ads/tests/runtime.test.mjs"));
});

test("a MAX-only change selects only MAX across the hosted OS matrix", () => {
  const selection = selectProviderRegressions([
    "platform-skills/max-web/scripts/trelio-max.mjs",
    "platform-skills/max-web/tests/trelio-max.test.mjs",
  ]);

  assert.equal(selection.full, false);
  assert.deepEqual(selection.selfHostedSkills, ["max-web"]);
  assert.deepEqual(
    selection.hostedMatrix.include.map(({ skill, os }) => `${skill}:${os}`),
    [
      "max-web:ubuntu-latest",
      "max-web:macos-latest",
      "max-web:windows-latest",
    ],
  );
  assert.equal(selection.runTelegramContract, false);
  assert.equal(selection.runDodoStats, false);
});

test("several provider changes select their union without unrelated skills", () => {
  const selection = selectProviderRegressions([
    "platform-skills/telegram-mtproto/scripts/trelio-telegram.py",
    "platform-skills/consultant-plus/SKILL.md",
  ]);

  assert.deepEqual(selection.selectedSkills, ["consultant-plus", "telegram-mtproto"]);
  assert.deepEqual(selection.selfHostedSkills, ["consultant-plus", "telegram-mtproto"]);
  assert.equal(selection.hostedMatrix.include.length, 3);
  assert.ok(selection.hostedMatrix.include.every(({ skill }) => skill === "telegram-mtproto"));
  assert.equal(selection.runConsultantPlus, true);
  assert.equal(selection.runTelegramContract, true);
  assert.equal(selection.runDodoStats, false);
});

test("a GAS Pravосудие change runs its runtime suite on every hosted OS", () => {
  const selection = selectProviderRegressions([
    "platform-skills/gas-pravosudie/scripts/worker.mjs",
  ]);

  assert.deepEqual(selection.selfHostedSkills, ["gas-pravosudie"]);
  assert.deepEqual(selection.hostedMatrix.include, [
    { os: "ubuntu-latest", skill: "gas-pravosudie", language: "node",
      test_file: "platform-skills/gas-pravosudie/tests/runtime.test.mjs" },
    { os: "macos-latest", skill: "gas-pravosudie", language: "node",
      test_file: "platform-skills/gas-pravosudie/tests/runtime.test.mjs" },
    { os: "windows-latest", skill: "gas-pravosudie", language: "node",
      test_file: "platform-skills/gas-pravosudie/tests/runtime.test.mjs" },
  ]);
});

test("dedicated provider changes stay in their dedicated workflows", () => {
  const selection = selectProviderRegressions([
    "platform-skills/email-imap-smtp/scripts/trelio_email.py",
    "platform-skills/t-bank/tests/runtime.test.mjs",
  ]);

  assert.deepEqual(selection.changedProviderIds, ["email-imap-smtp", "t-bank"]);
  assert.deepEqual(selection.selectedSkills, []);
  assert.deepEqual(selection.selfHostedSkills, []);
  assert.equal(selection.runSourceTests, false);
  assert.equal(selection.hasHostedMatrix, false);
});

test("a general and dedicated provider change do not duplicate the dedicated suite", () => {
  const selection = selectProviderRegressions([
    "platform-skills/max-web/SKILL.md",
    "platform-skills/whatsapp-web/SKILL.md",
  ]);

  assert.deepEqual(selection.changedProviderIds, ["max-web", "whatsapp-web"]);
  assert.deepEqual(selection.selfHostedSkills, ["max-web"]);
  assert.ok(selection.hostedMatrix.include.every(({ skill }) => skill === "max-web"));
});

test("shared tooling and workflow changes retain the full regression gate", () => {
  for (const filePath of [
    "platform-skills/tools/build-runtime-package.mjs",
    ".github/workflows/platform-skill-runtimes.yml",
  ]) {
    const selection = selectProviderRegressions([filePath]);
    assert.equal(selection.full, true, filePath);
    assert.equal(selection.hostedMatrix.include.length, 30, filePath);
    assert.ok(selection.selfHostedSkills.includes("vk-ads"), filePath);
    assert.ok(selection.selfHostedSkills.includes("document-facsimile"), filePath);
    assert.ok(selection.selfHostedSkills.includes("gosuslugi"), filePath);
    assert.ok(selection.selfHostedSkills.includes("dodostats-drinkitstats"), filePath);
    assert.equal(selection.runConsultantPlus, true, filePath);
    assert.equal(selection.runTelegramContract, true, filePath);
    assert.equal(selection.runDodoStats, true, filePath);
  }
});

test("instruction-only providers still run the shared instruction contracts", () => {
  for (const skill of ["ozon-buyer-search", "google-ai-search"]) {
    const selection = selectProviderRegressions([
      `platform-skills/${skill}/SKILL.md`,
    ]);

    assert.deepEqual(selection.selfHostedSkills, [skill]);
    assert.equal(selection.runSourceTests, true);
    assert.equal(selection.hasHostedMatrix, false);
  }
});

test("an unregistered provider fails closed instead of silently skipping CI", () => {
  assert.throws(
    () => selectProviderRegressions(["platform-skills/new-provider/SKILL.md"]),
    /Unknown provider directories require an explicit CI route: new-provider/u,
  );
});

test("facsimile storage and DOCX regressions run on all three hosted operating systems", () => {
  const selection = selectProviderRegressions(["platform-skills/document-facsimile/scripts/trelio-facsimile.py"]);
  assert.deepEqual(selection.selfHostedSkills, ["document-facsimile"]);
  assert.deepEqual(selection.hostedMatrix.include, [
    { os: "ubuntu-latest", skill: "document-facsimile", language: "python" },
    { os: "macos-latest", skill: "document-facsimile", language: "python" },
    { os: "windows-latest", skill: "document-facsimile", language: "python" },
  ]);
});


test("a verified retired provider keeps shared contracts without scheduling missing suites", () => {
  const files = ["platform-skills/retired-fixture/ci.json"];
  const selection = selectProviderRegressions(files, { registrations: {}, removedProviderIds: ["retired-fixture"] });
  assert.deepEqual(selection.removedProviderIds, ["retired-fixture"]);
  assert.deepEqual(selection.selectedSkills, []);
  assert.equal(selection.hasHostedMatrix, false);
  assert.equal(selection.runPackageTool, true);
  assert.equal(selection.runSourceTests, true);
  assert.throws(() => selectProviderRegressions(files, { registrations: {} }), /Unknown provider/u);
  assert.throws(() => selectProviderRegressions(["platform-skills/max-web/SKILL.md"], {
    registrations: {}, removedProviderIds: ["max-web"],
  }), /no current CI route/u);
});

test("the real CLI proves complete deletion from Git and rejects registration-only deletion", () => {
  // macOS aliases /var to /private/var; the CLI's direct-entry comparison must
  // receive the same physical path that Node resolves for import.meta.url.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "provider-removal-")));
  try {
    const tools = path.join(root, "platform-skills", "tools");
    const hooks = path.join(root, "empty-hooks");
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(hooks);
    for (const file of ["select-provider-regressions.mjs", "provider-ci.mjs"]) {
      fs.copyFileSync(fileURLToPath(new URL(file, import.meta.url)), path.join(tools, file));
    }
    for (const skill of ["retired-fixture", "partial-fixture"]) {
      const directory = path.join(root, "platform-skills", skill);
      fs.mkdirSync(path.join(directory, "tests"), { recursive: true });
      fs.mkdirSync(path.join(directory, "development"));
      fs.writeFileSync(path.join(directory, "SKILL.md"), "Fixture instruction\n");
      fs.writeFileSync(path.join(directory, "tests/ci.mjs"), "// fixture\n");
      fs.writeFileSync(path.join(directory, "development/prepare.mjs"), "// fixture\n");
      fs.writeFileSync(path.join(directory, "ci.json"), JSON.stringify({
        schemaVersion: 1, language: "node", testFile: "tests/ci.mjs", prepareFile: "development/prepare.mjs",
      }));
    }
    // Use isolated hooks and explicit fixture identity: the regression must not
    // invoke a developer's signing hooks or depend on their global Git config.
    const git = (...args) => {
      const result = spawnSync("git", [
        "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
      ], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const commit = () => { git("add", "-A"); git("commit", "-qm", "Fixture snapshot"); return git("rev-parse", "HEAD"); };
    const select = (base, head) => spawnSync(process.execPath, [
      path.join(tools, "select-provider-regressions.mjs"), "--base", base, "--head", head,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    git("init", "--quiet");
    const base = commit();
    fs.rmSync(path.join(root, "platform-skills/retired-fixture"), { recursive: true });
    const retired = commit();
    const accepted = select(base, retired);
    assert.equal(accepted.status, 0, accepted.stderr);
    const plan = JSON.parse(accepted.stdout);
    assert.deepEqual(plan.removedProviderIds, ["retired-fixture"]);
    assert.equal(plan.runSourceTests, true);
    assert.equal(plan.hasHostedMatrix, false);
    fs.unlinkSync(path.join(root, "platform-skills/partial-fixture/ci.json"));
    const partial = commit();
    const denied = select(retired, partial);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /Unknown provider directories require an explicit CI route: partial-fixture/u);
    // Even a locally missing directory is not proof of retirement when the
    // exact PR head still contains source after its registration was removed.
    fs.rmSync(path.join(root, "platform-skills/partial-fixture"), { recursive: true });
    const locallyMissing = select(retired, partial);
    assert.equal(locallyMissing.status, 1);
    assert.match(locallyMissing.stderr, /explicit CI route: partial-fixture/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
