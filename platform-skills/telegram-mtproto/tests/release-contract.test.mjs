import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildRuntimePackage } from "../../tools/build-runtime-package.mjs";

const repositoryRoot = new URL("../../../", import.meta.url);
const [
  connectionDocs,
  runtimeDocs,
  skillInstructions,
  releaseSource,
  runtimeSource,
] = await Promise.all([
  readFile(new URL("docs/agent-skill-connections.md", repositoryRoot), "utf8"),
  readFile(new URL("docs/agent-skill-runtime-releases.md", repositoryRoot), "utf8"),
  readFile(new URL("platform-skills/telegram-mtproto/SKILL.md", repositoryRoot), "utf8"),
  readFile(new URL("platform-skills/telegram-mtproto/release.json", repositoryRoot), "utf8"),
  readFile(new URL("platform-skills/telegram-mtproto/scripts/trelio-telegram.py", repositoryRoot), "utf8"),
]);
const releaseManifest = JSON.parse(releaseSource);

test("Telegram MTProto release preserves privacy, search, scheduled-message, edit and Markdown contracts", () => {
  assert.match(connectionDocs, /members --chat ID_OR_USERNAME/u);
  assert.match(skillInstructions, /members --chat ID_OR_USERNAME/u);
  for (const source of [connectionDocs, runtimeDocs, skillInstructions]) {
    assert.match(source, /audience=members/u);
    assert.match(source, /audience=subscribers/u);
    assert.match(source, /providerMayLimitResults/u);
    assert.match(source, /Phone|телефон/iu);
    assert.match(source, /access_hash|access hash/iu);
  }

  assert.match(skillInstructions, /`--limit 1\.\.200`/u);
  assert.match(skillInstructions, /не обходи отказ через Telegram Web\/UI/u);
  for (const source of [connectionDocs, runtimeDocs, skillInstructions]) {
    assert.match(source, /search --global|`--global`/u);
    assert.match(source, /nextCursor|`--cursor`/u);
    assert.match(source, /--context|contextCoverage/u);
    assert.match(source, /secret\s+chats/iu);
    assert.match(source, /coverage/u);
    assert.match(source, /complete/u);
  }
  for (const source of [connectionDocs, runtimeDocs, skillInstructions]) {
    assert.match(source, /edit --chat|`edit`/u);
    assert.match(source, /собствен|own outgoing/iu);
    assert.match(source, /--dry-run/u);
    assert.match(source, /--approval-hash/u);
    assert.match(source, /Telegram Markdown|Telethon(?: parse mode)? `md`/u);
    assert.match(source, /HTML/iu);
    assert.match(source, /\[.*\]\(https:\/\//u);
  }
  for (const source of [connectionDocs, runtimeDocs, skillInstructions]) {
    assert.match(source, /scheduled --chat|`scheduled`/u);
    assert.match(source, /--schedule-at/u);
    assert.match(source, /RFC ?3339/u);
    assert.match(source, /60 секунд|60 seconds/u);
    assert.match(source, /scheduled queue|scheduled-queue|очеред/u);
    assert.match(source, /Telegram Web fallback|Telegram Web/u);
  }
  assert.match(runtimeSource, /scheduled=True/u);
  assert.match(runtimeSource, /MIN_SCHEDULE_LEAD_SECONDS = 60/u);
  assert.match(runtimeSource, /"scheduled"/u);
  assert.match(runtimeSource, /"--schedule-at"/u);
  assert.equal(releaseManifest.release.version, "2.3.6");
  assert.equal(Object.hasOwn(releaseManifest.release, "state"), false);
  assert.equal(releaseManifest.runtime.version, "2.3.4");
  assert.equal(releaseManifest.runtime.minimumHostVersion, "1.11.0");
  assert.deepEqual(
    releaseManifest.connection.configFields.map((field) => field.key),
    [],
  );
  assert.deepEqual(releaseManifest.connection.deprecatedConfigKeys, ["apiId", "allowAutonomous"]);
  assert.deepEqual(releaseManifest.connection.secretFields, []);
  assert.deepEqual(releaseManifest.runtime.capabilities, ["local-session", "network"]);
  assert.deepEqual(releaseManifest.runtime.files[1], {
    sourceEnvironment: "TRELIO_TELEGRAM_APP_CREDENTIAL_JSON",
    releaseInputExposure: "package-recipient",
    path: "telegram-app-credentials.json",
    mode: 420,
  });
  assert.match(skillInstructions, /входят в exact\s+подписанный runtime package/u);
  assert.match(skillInstructions, /может извлечь пару/u);
  assert.match(skillInstructions, /runtimeExecution\.localAction/u);
  assert.match(skillInstructions, /parameters\.arguments/u);
  assert.match(skillInstructions, /legacy-ответ[^.]+не содержит `localAction`/u);
  assert.match(skillInstructions, /без shell/u);
  assert.doesNotMatch(skillInstructions, /approval_policy|ask-for-approval|on-request/u);
  assert.match(skillInstructions, /Managed credential checkout и активный Agent Run[^.]+не нужны/u);
  assert.match(skillInstructions, /Не добавляй `--company-id`, `--member-id`/u);
  assert.doesNotMatch(skillInstructions, /prepare_agent_skill_managed_credential_checkout/u);
  assert.doesNotMatch(skillInstructions, /TRELIO_TELEGRAM_APP_CREDENTIAL_JSON/u);
  assert.doesNotMatch(skillInstructions, /prepare_agent_secret_checkout/u);
  assert.doesNotMatch(runtimeSource, /TRELIO_TELEGRAM_APP_CREDENTIAL_JSON/u);
  assert.doesNotMatch(runtimeSource, /TRELIO_TELEGRAM_API_(?:ID|HASH)/u);
  assert.match(runtimeSource, /TELEGRAM_CHAT_RESOLUTION_FAILED/u);
  assert.match(runtimeSource, /doNotGuessPeerPrefix/u);
  assert.match(skillInstructions, /TELEGRAM_CHAT_RESOLUTION_FAILED/u);
  assert.match(skillInstructions, /Не добавляй и не удаляй\s+`-` \/ `-100`/u);
  for (const hostField of [
    "TRELIO_SKILL_COMPANY_ID",
    "TRELIO_SKILL_MEMBER_ID",
    "TRELIO_SKILL_CONNECTION_ID",
    "TRELIO_SKILL_CONNECTION_CONFIG_JSON",
  ]) {
    assert.match(runtimeSource, new RegExp(hostField, "u"));
  }
});

test("Telegram package embeds only the declared distributable release input", () => {
  const distributableInput = JSON.stringify({
    api_id: "12345",
    api_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const result = buildRuntimePackage(
    fileURLToPath(new URL("../", import.meta.url)),
    { environment: { TRELIO_TELEGRAM_APP_CREDENTIAL_JSON: distributableInput } },
  );
  const runtimePackage = JSON.parse(result.packageBytes.toString("utf8"));
  const credentialFile = runtimePackage.files.find(
    (file) => file.path === "telegram-app-credentials.json",
  );

  assert.ok(credentialFile);
  assert.equal(
    Buffer.from(credentialFile.contentBase64, "base64").toString("utf8"),
    distributableInput,
  );
  assert.equal(runtimePackage.files.length, 2);
  assert.deepEqual(runtimePackage.capabilities, ["local-session", "network"]);
});
