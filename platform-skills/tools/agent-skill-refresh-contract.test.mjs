import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const platformSkillsDirectory = new URL("platform-skills/", repositoryRoot);

/**
 * Read every current provider instruction from the canonical repository.
 * Release packages are immutable, so catching a stale cadence before tagging
 * is the only reliable way to keep all newly published skills consistent with
 * the generic Agent Workspaces routing contract.
 */
const readCurrentSkillInstructions = async () => {
  const entries = await readdir(platformSkillsDirectory, { withFileTypes: true });
  const sources = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceUrl = new URL(`${entry.name}/SKILL.md`, platformSkillsDirectory);
    try {
      sources.push({
        skillId: entry.name,
        source: await readFile(sourceUrl, "utf8"),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return sources;
};

test("provider instructions never require a fresh get_agent_skill before each subcommand", async () => {
  const instructions = await readCurrentSkillInstructions();
  assert.ok(instructions.length > 0);

  for (const { skillId, source } of instructions) {
    assert.doesNotMatch(
      source,
      /(?:перед\s+кажд(?:ой\s+командой|ым\s+запуском)|before\s+(?:each|every)\s+(?:command|run))[\s\S]{0,160}`?get_agent_skill`?/iu,
      `${skillId} must not refresh get_agent_skill before every runtime subcommand`,
    );
    assert.doesNotMatch(
      source,
      /Не переиспользуй старый command/iu,
      `${skillId} must reuse the exact command across related user turns`,
    );
  }
});

test("affected connected-service skills state the bounded session reuse contract", async () => {
  const instructions = new Map(
    (await readCurrentSkillInstructions()).map(({ skillId, source }) => [skillId, source]),
  );

  for (const skillId of [
    "email-imap-smtp",
    "max-web",
    "telegram-mtproto",
    "telegram-web",
  ]) {
    const source = instructions.get(skillId);
    assert.ok(source, `missing ${skillId}/SKILL.md`);
    assert.match(source, /Один раз перед первой командой сессии/u);
    assert.match(source, /не повторяй `get_agent_skill` перед каждой\s+подкомандой/u);
    assert.match(
      source,
      /Host управляет допуском до 12 часов без продления при чтении/u,
    );
    assert.match(source, /один раз при `AGENT_SKILL_RELEASE_CHANGED`/u);
    assert.match(source, /утрате полного текста или compaction/u);
    assert.match(source, /через 12 часов/u);
    assert.doesNotMatch(source, /Перечитай skill в следующем пользовательском ходе/u);
  }
});

test("gosuslugi keeps one headed browser session for the whole procedure", async () => {
  const instructions = new Map(
    (await readCurrentSkillInstructions()).map(({ skillId, source }) => [skillId, source]),
  );
  const source = instructions.get("gosuslugi");

  assert.ok(source, "missing gosuslugi/SKILL.md");
  assert.match(source, /С первого перехода[^\n]+headed local browser/u);
  assert.match(source, /Не запускай предварительный headless probe/u);
  assert.match(source, /одну основную agent-owned вкладку[^\n]+до завершения всей связанной процедуры/u);
  assert.match(source, /Не закрывай вкладку, context или browser между промежуточными/u);
  assert.match(source, /оставляй браузер в фоне без закрытия вкладки или сессии/u);
  assert.match(source, /При ручном blocker оставь текущую вкладку открытой/u);
});

// This is a context-size guard, not a billing estimate. UTF-8 bytes are stable
// without a network tokenizer dependency; changes to the budgets must explain
// which always-loaded operational requirement needs the extra context.
test("provider instructions keep history and unused workflow detail out of the hot context", async () => {
  const instructions = new Map(
    (await readCurrentSkillInstructions()).map(({ skillId, source }) => [skillId, source]),
  );
  for (const [skillId, maximumBytes] of [["t-bank", 15500]]) {
    assert.ok(Buffer.byteLength(instructions.get(skillId), "utf8") <= maximumBytes,
      `${skillId}: move supporting detail into references before raising the context budget`);
  }
});
