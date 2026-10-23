import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildRuntimePackage } from "./build-runtime-package.mjs";

const skillsDirectory = new URL("../", import.meta.url);
const descriptorPath = "trelio-secret-setup.json";
const setupHostFloor = [2, 0, 10], humanInputHostFloor = [3, 18, 0];

const supportsSetup = (version, floor = setupHostFloor) => {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < floor.length; index += 1) {
    if (parts[index] !== floor[index]) return parts[index] > floor[index];
  }
  return true;
};

/**
 * Проверяем именно доставляемые bytes: JSON рядом с исходником не помогает,
 * если release.files забывает включить его в подписанный пакет. Каталог
 * обнаруживается динамически, чтобы следующий secret-backed provider также
 * не мог незаметно привязать личную настройку к рабочему Run.
 * Полную schema и security semantics проверяют generic backend/host tests;
 * здесь закреплены состав provider package и собственные connection bindings.
 */
const readPackagedSetup = (slug) => {
  // Telegram's distributable application identity stays in its private release
  // contour. This existing public builder fixture is synthetic, never a real
  // app/session, and these unsigned bytes remain in memory only.
  const built = buildRuntimePackage(fileURLToPath(new URL(`${slug}/`, skillsDirectory)), slug === "telegram-mtproto"
    ? { environment: { TRELIO_TELEGRAM_APP_CREDENTIAL_JSON: JSON.stringify({ api_id: "12345", api_hash: "a".repeat(32) }) } } : {});
  const runtimePackage = JSON.parse(built.packageBytes.toString("utf8"));
  const file = runtimePackage.files.find((entry) => entry.path === descriptorPath);
  assert.ok(file, `${slug}: setup without Run must be included in the signed package`);
  const bytes = Buffer.from(file.contentBase64, "base64");
  assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(supportsSetup(built.minimumHostVersion), `${slug}: setup needs host >=2.0.10`);
  const descriptor = JSON.parse(bytes.toString("utf8"));
  assert.ok([1, 2].includes(descriptor.schemaVersion));
  assert.ok(descriptor.commands.length <= 8);
  if (descriptor.commands.length) assert.ok(runtimePackage.capabilities.includes("secret-checkout"));
  const bindings = new Set((built.connectionDefinition?.secretFields ?? []).map((field) => field.bindingKey));
  for (const command of descriptor.commands) {
    assert.ok(bindings.has(command.bindingKey), `${slug}: setup must use its own connection binding`);
  }
  if (descriptor.schemaVersion === 1) assert.ok(descriptor.commands.length > 0);
  else {
    assert.ok(supportsSetup(built.minimumHostVersion, humanInputHostFloor), `${slug}: human-input v2 needs host >=3.18.0`);
    assert.ok(runtimePackage.capabilities.includes("local-session"));
    assert.ok(descriptor.humanInputCommands.length > 0);
  }
  return descriptor;
};

test("every company-secret-backed local runtime packages setup without Run", () => {
  const checked = [];
  for (const entry of fs.readdirSync(skillsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const releasePath = new URL(`${entry.name}/release.json`, skillsDirectory);
    if (!fs.existsSync(releasePath)) continue;
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    if (!release.connection?.secretFields?.length) continue;
    readPackagedSetup(entry.name);
    checked.push(entry.name);
  }
  // EDO used to be omitted from release discovery entirely. Keep the known
  // secret-backed providers mandatory while letting discovery cover new ones.
  for (const slug of ["1c-edo"]) {
    assert.ok(checked.includes(slug), `${slug}: missing release manifest`);
  }
});

for (const slug of ["1c-edo"]) {
  test(`${slug}: setup allows only exact connect/doctor argv, never business reads`, () => {
    const commands = readPackagedSetup(slug).commands;
    assert.deepEqual(commands, [
      { id: "connect", arguments: ["connect"], bindingKey: "x_odata", fieldKey: "value",
        environmentVariable: "TRELIO_1C_EDO_X_ODATA" },
      { id: "connect-terminal", arguments: ["connect", "--terminal-prompts"], bindingKey: "x_odata",
        fieldKey: "value", environmentVariable: "TRELIO_1C_EDO_X_ODATA" },
      { id: "doctor", arguments: ["doctor"], bindingKey: "x_odata", fieldKey: "value",
        environmentVariable: "TRELIO_1C_EDO_X_ODATA" },
    ]);
  });
}

for (const [slug, id, args] of [
  ["telegram-mtproto", "login", ["login", "--qr"]],
  ["email-imap-smtp", "configure", ["configure"]],
  ["max-web", "login", ["login", "--headed"]],
]) test(`${slug}: signed human-input setup declares only its existing protected login, not Secret delivery or task authority`, () => {
  const descriptor = readPackagedSetup(slug);
  assert.deepEqual(descriptor, { schemaVersion: 2, commands: [], humanInputCommands: [
    { id, purpose: "authenticate_existing", arguments: args, maximumDurationMs: 600_000 },
  ] });
  const release = JSON.parse(fs.readFileSync(new URL(`${slug}/release.json`, skillsDirectory), "utf8"));
  assert.equal(release.runtime.capabilities.includes("secret-checkout"), false);
  const taskPolicy = JSON.parse(fs.readFileSync(new URL(`${slug}/scripts/trelio-assistant-execution.json`, skillsDirectory), "utf8"));
  assert.ok(!taskPolicy.taskCommands.some(prefix => prefix[0] === args[0]), "human setup must not become an ordinary task prefix");
  assert.ok(!args.includes("--local-account"), "the SAME host selector stays outside immutable provider argv");
});
