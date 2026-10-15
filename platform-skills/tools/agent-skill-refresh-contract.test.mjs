import { reportInstructionBudget } from "./report-instruction-budget.mjs";
import { fileURLToPath } from "node:url";
import { readSkillInstructions } from "./read-skill-instructions.mjs";
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
        source: readSkillInstructions(new URL(`${entry.name}/`, platformSkillsDirectory)),
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
  const main = instructions.get("gosuslugi");
  const source = main + "\n" + await readFile(new URL("gosuslugi/references/browser-lifecycle.md", platformSkillsDirectory), "utf8");

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
    assert.ok(Buffer.byteLength(await readFile(new URL(`${skillId}/SKILL.md`, platformSkillsDirectory)), "utf8") <= maximumBytes,
      `${skillId}: move supporting detail into references before raising the context budget`);
  }
});

// Source publication gate: no oversized provider can silently return as debt.
// The delivery envelope is independently guarded by backend/host at read time.
test("all public main instructions fit the UTF-8 publication budget", async () => {
  const rows = await reportInstructionBudget(fileURLToPath(platformSkillsDirectory));
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.filter(row => row.exceedsLimit || row.envelopeFixtureExceedsLimit), []);
});

test("Post keeps every irreversible-action and caller-lifecycle boundary in its compact main text", async () => {
  const text = (await readFile(new URL('russian-post-registered-mail/SKILL.md', platformSkillsDirectory), 'utf8')).replace(/\s+/gu, ' ');
  const decisions = [
    /does not replace required paper original, enclosure inventory, declared-value letter or paper delivery notice/u,
    /If legal sufficiency\/method is unclear, ask before payment or sending/u,
    /Missing own `runtimeExecution`, `localAction` or rename CLI is not a blocker/u,
    /Never open personal Chrome or enumerate profiles/u,
    /No relogin merely to rename/u,
    /Never inspect\/copy cookies, tokens, storageState or personal profile files/u,
    /before first login click/u,
    /Tracking needs Gosuslugi \*\*4\.3\.11\+\*\*/u,
    /Starting helper only on `passport\.pochta\.ru` misses external state/u,
    /Pass `login\.request\.arguments` once/u,
    /No unconditional root `goto` immediately after callback/u,
    /never pass it to helper/u,
    /Never expose auth DOM\/screenshots, passwords, OTP, OAuth code\/state or network bodies/u,
    /Attach success\/rejection handlers to both `login\.request` and `login\.authenticated` \*\*before click\*\*/u,
    /Never block command queue on either promise/u,
    /no per-step finally close/u,
    /New authorize needs proven loss\/expiry, not read timeout or selector failure/u,
    /Human blocker keeps them alive/u,
    /cannot extend Gosuslugi native credential deadline/u,
    /silence is not consent/u,
    /If unavailable, explain and ask how to proceed; never silently omit it/u,
    /up to \*\*300 ₽\*\*; higher price or any changed field needs new confirmation/u,
    /no automatic payment\/submit retry/u,
    /reload exact card and read persisted title/u,
    /PDF name, input or toast alone proves nothing/u,
    /old title permits retry only after establishing current state and no pending save/u,
    /Never resend\/pay to rename/u,
    /Reconcile all original numbers including failures/u,
  ];
  for (const decision of decisions) assert.match(text, decision);
  // No package/reference loader exists for these Markdown surfaces. Their
  // entire contract must survive the same duplicated transport hazard.
  for (const skill of ['consultant-plus', 'russian-post-registered-mail']) {
    const main = await readFile(new URL(`${skill}/SKILL.md`, platformSkillsDirectory), 'utf8');
    const data = { instructions: main, context: 'x'.repeat(4096) };
    assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: data,
      content: [{ type: 'text', text: JSON.stringify(data) }] })) <= 40000);
  }
});
