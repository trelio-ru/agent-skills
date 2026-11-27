import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Run before provider tests on each hosted OS. The tagged publisher packs
// the declaration with the card text and requirements from this directory.
const withSource = (name) => new URL(`../${name}`, import.meta.url);
const { schemaVersion, release } = JSON.parse(readFileSync(withSource("remote-mcp.json"), "utf8"));
const instructions = readFileSync(withSource("SKILL.md"), "utf8");
const requirements = JSON.parse(readFileSync(withSource("catalog-requirements.json"), "utf8"));

assert.equal(schemaVersion, 1);
assert.equal(release.catalogVisibility, "platform");
assert.equal(release.skillId, release.catalogSlug);
assert.ok(instructions.includes(`\nname: ${release.skillId}\n`));
assert.ok(instructions.includes(`catalog_title: ${JSON.stringify(release.title)}`));
assert.ok(instructions.includes(`catalog_description: ${JSON.stringify(release.description)}`));
assert.equal(requirements.personalAccount, "required");
assert.equal(requirements.authorization, "browser");
