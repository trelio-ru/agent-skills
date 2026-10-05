import assert from "node:assert/strict";
import test from "node:test";

import { validateTelegramReleaseInput } from "../tools/validate-release-input.mjs";

const validInput = JSON.stringify({
  api_id: "12345",
  api_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

test("Telegram tagged release input accepts the exact distributable pair", () => {
  assert.doesNotThrow(() => validateTelegramReleaseInput(validInput));
});

test("Telegram tagged release input fails closed without disclosing bad values", () => {
  const sensitiveFixture = "do-not-print-this-fixture";
  for (const candidate of [
    undefined,
    "",
    sensitiveFixture,
    JSON.stringify({ api_id: "12345" }),
    JSON.stringify({ api_id: "0", api_hash: "a".repeat(32) }),
    JSON.stringify({ api_id: "12345", api_hash: sensitiveFixture }),
    JSON.stringify({ api_id: "12345", api_hash: "a".repeat(32), extra: "field" }),
  ]) {
    assert.throws(
      () => validateTelegramReleaseInput(candidate),
      (error) => {
        assert.doesNotMatch(String(error), new RegExp(sensitiveFixture, "u"));
        return /missing or invalid/u.test(String(error));
      },
    );
  }
});
