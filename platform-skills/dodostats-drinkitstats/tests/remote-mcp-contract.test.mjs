import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillDirectory = new URL("../", import.meta.url);

const readJson = async (relativePath) => JSON.parse(
  await readFile(new URL(relativePath, skillDirectory), "utf8"),
);

test("marketplace manifest keeps one public combined skill", async () => {
  const manifest = await readJson("remote-mcp.json");

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.release, {
    skillId: "dodostats-drinkitstats",
    catalogSlug: "dodostats-drinkitstats",
    catalogVisibility: "platform",
    marketplaceCategory: "business",
    version: "1.1.0",
    title: "DodoStats / DrinkitStats",
    description:
      "Read-only анализ выручки Dodo и Drinkit по сохранённым снимкам: доступность данных, поиск точек, сводки, динамика, рейтинги и сравнение локаций.",
    searchTerms: [
      "DodoStats",
      "DrinkitStats",
      "dodostats.ru",
      "drinkitstats.ru",
      "Додо Статс",
      "Дринкит Статс",
      "выручка Додо",
      "выручка Drinkit",
      "рейтинг пиццерий",
      "рейтинг кофеен",
    ],
    summary:
      "Разрешить навыку автоматически использовать все актуальные строго read-only методы DodoStats и DrinkitStats.",
  });
});

test("Remote MCP declaration discovers all current strict reads without credentials", async () => {
  const { remoteMcp } = await readJson("remote-mcp.json");
  const endpoint = new URL(remoteMcp.endpoint);

  assert.equal(remoteMcp.schemaVersion, 2);
  assert.equal(remoteMcp.transport, "streamable_http");
  assert.equal(remoteMcp.protocolVersion, "2025-03-26");
  assert.equal(endpoint.protocol, "https:");
  assert.equal(endpoint.hostname, "dodostats.ru");
  assert.equal(endpoint.port, "");
  assert.equal(endpoint.pathname, "/mcp");
  assert.equal(endpoint.username, "");
  assert.equal(endpoint.password, "");
  assert.deepEqual(remoteMcp.authentication, { type: "none" });
  assert.deepEqual(remoteMcp.headers, {});
  assert.equal(remoteMcp.credentialHelp, null);

  assert.deepEqual(remoteMcp.toolPolicy, { mode: "all_read_only" });
  assert.equal(Object.hasOwn(remoteMcp, "allowedTools"), false);
});

test("instructions preserve snapshot, location, currency and quality rules", async () => {
  const instructions = await readFile(new URL("SKILL.md", skillDirectory), "utf8");
  const interfaceDefinition = await readFile(
    new URL("agents/openai.yaml", skillDirectory),
    "utf8",
  );

  assert.match(instructions, /^---\nname: dodostats-drinkitstats\n/u);
  assert.match(instructions, /get_available_revenue_data/u);
  assert.match(instructions, /search_locations/u);
  assert.match(instructions, /country-qualified/u);
  assert.match(instructions, /allow_mixed_currencies=true/u);
  assert.match(instructions, /generated_at/u);
  assert.match(instructions, /is_partial/u);
  assert.match(instructions, /missing_periods/u);
  assert.match(instructions, /новый строго read-only метод provider-а не требует/u);
  assert.match(instructions, /sources\.\*\.mtime/u);
  assert.match(instructions, /происхождение файла снимка, а не свежесть/u);
  assert.match(instructions, /Не переключайся на второй домен/u);
  assert.match(interfaceDefinition, /display_name: "DodoStats \/ DrinkitStats"/u);
});
