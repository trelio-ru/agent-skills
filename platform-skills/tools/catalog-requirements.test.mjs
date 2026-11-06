import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { normalizeCatalogRequirements } from "./catalog-requirements.mjs";

const root = new URL("../", import.meta.url);
const fixture = { schemaVersion: 1, companySetup: false, personalAccount: "required",
  authorization: "browser", connectionLabel: "Личный аккаунт сервиса" };

test("each public provider owns valid display requirements outside instructions and runtime packages", async () => {
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const skillRoot = new URL(`${directory.name}/`, root);
    try { await readFile(new URL("SKILL.md", skillRoot)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const metadata = JSON.parse(await readFile(new URL("catalog-requirements.json", skillRoot), "utf8"));
    assert.deepEqual(normalizeCatalogRequirements(metadata), metadata, directory.name);
    try {
      const release = JSON.parse(await readFile(new URL("release.json", skillRoot), "utf8"));
      assert.ok(!release.runtime.files.some(file => file.source === "catalog-requirements.json"), directory.name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
});

test("requirements validation is independent of skill identity and version and rejects config/content extensions", () => {
  assert.deepEqual(normalizeCatalogRequirements(fixture), fixture);
  for (const changes of [{ schemaVersion: 2 }, { personalAccount: "unknown" }, { authorization: "oauth" },
    { companySetup: "false" }, { connectionLabel: "~e1:private:field~" }, { connectionLabel: "" },
    { connectionLabel: "x".repeat(241) }, { connectionLabel: "First\nSecond" }, { version: "9.0.0" },
    { credentials: "not-a-public-field" }, { companyId: "not-a-public-field" }]) {
    assert.throws(() => normalizeCatalogRequirements({ ...fixture, ...changes }));
  }
  assert.throws(() => normalizeCatalogRequirements(null));
  assert.throws(() => normalizeCatalogRequirements(Object.create(fixture)));
});
