import assert from "node:assert/strict";
import test from "node:test";
import { inspectPublicFile } from "./check-public-source.mjs";

test("private providers and credential files cannot enter public history", () => {
  assert.deepEqual(inspectPublicFile("platform-skills/1c-vkus/SKILL.md", Buffer.from("fixture")), ["private_provider"]);
  assert.deepEqual(inspectPublicFile(".secrets/release.json", Buffer.from("fixture")), ["private_material"]);
  assert.deepEqual(inspectPublicFile("cache/account.session", Buffer.from("fixture")), ["private_material"]);
});

test("real-looking application input is rejected while declared synthetic CI input remains usable", () => {
  const fixtureValue = "0123456789abcdef".repeat(2);
  assert.deepEqual(inspectPublicFile("fixture.json", Buffer.from(JSON.stringify({ api_hash: fixtureValue }))), ["application_identity"]);
  assert.deepEqual(inspectPublicFile("fixture.json", Buffer.from(JSON.stringify({ api_hash: "a".repeat(32) }))), []);
});
