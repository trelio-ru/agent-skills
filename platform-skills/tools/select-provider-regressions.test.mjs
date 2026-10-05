import assert from "node:assert/strict";
import test from "node:test";

import { selectProviderRegressions } from "./select-provider-regressions.mjs";

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
    assert.equal(selection.hostedMatrix.include.length, 24, filePath);
    assert.ok(selection.selfHostedSkills.includes("gosuslugi"), filePath);
    assert.ok(selection.selfHostedSkills.includes("dodostats-drinkitstats"), filePath);
    assert.equal(selection.runConsultantPlus, true, filePath);
    assert.equal(selection.runTelegramContract, true, filePath);
    assert.equal(selection.runDodoStats, true, filePath);
  }
});

test("instruction-only providers still run the shared instruction contracts", () => {
  const selection = selectProviderRegressions([
    "platform-skills/ozon-buyer-search/SKILL.md",
  ]);

  assert.deepEqual(selection.selfHostedSkills, ["ozon-buyer-search"]);
  assert.equal(selection.runSourceTests, true);
  assert.equal(selection.hasHostedMatrix, false);
});

test("an unregistered provider fails closed instead of silently skipping CI", () => {
  assert.throws(
    () => selectProviderRegressions(["platform-skills/new-provider/SKILL.md"]),
    /Unknown provider directories require an explicit CI route: new-provider/u,
  );
});
