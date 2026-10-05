import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildRuntimePackage } from "./build-runtime-package.mjs";

const skillsDirectory = new URL("../", import.meta.url);
const descriptorPath = "trelio-secret-setup.json";
const setupHostFloor = [2, 0, 10];

const supportsSetup = (version) => {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < setupHostFloor.length; index += 1) {
    if (parts[index] !== setupHostFloor[index]) return parts[index] > setupHostFloor[index];
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
  const built = buildRuntimePackage(fileURLToPath(new URL(`${slug}/`, skillsDirectory)));
  const runtimePackage = JSON.parse(built.packageBytes.toString("utf8"));
  const file = runtimePackage.files.find((entry) => entry.path === descriptorPath);
  assert.ok(file, `${slug}: setup without Run must be included in the signed package`);
  const bytes = Buffer.from(file.contentBase64, "base64");
  assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(supportsSetup(built.minimumHostVersion), `${slug}: setup needs host >=2.0.10`);
  assert.ok(runtimePackage.capabilities.includes("secret-checkout"));
  const descriptor = JSON.parse(bytes.toString("utf8"));
  assert.equal(descriptor.schemaVersion, 1);
  assert.ok(descriptor.commands.length > 0 && descriptor.commands.length <= 8);
  const bindings = new Set(built.connectionDefinition.secretFields.map((field) => field.bindingKey));
  for (const command of descriptor.commands) {
    assert.ok(bindings.has(command.bindingKey), `${slug}: setup must use its own connection binding`);
  }
  return descriptor.commands;
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
    const commands = readPackagedSetup(slug);
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
