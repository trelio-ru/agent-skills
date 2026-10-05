#!/usr/bin/env node

/**
 * Validate the distributable Telegram application identity before an
 * immutable tag consumes it. The value is never printed: a failed check must
 * be safe even when GitHub's masking configuration is incomplete.
 */

import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 4_096;

export const validateTelegramReleaseInput = (rawInput) => {
  if (
    typeof rawInput !== "string"
    || rawInput.length === 0
    || Buffer.byteLength(rawInput, "utf8") > MAX_INPUT_BYTES
  ) {
    throw new Error("Telegram release input is missing or invalid.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error("Telegram release input is missing or invalid.");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "api_hash,api_id"
    || typeof parsed.api_id !== "string"
    || typeof parsed.api_hash !== "string"
  ) {
    throw new Error("Telegram release input is missing or invalid.");
  }

  const apiId = parsed.api_id.trim();
  const apiHash = parsed.api_hash.trim();
  if (
    !/^[1-9][0-9]{0,9}$/u.test(apiId)
    || Number(apiId) > 2_147_483_647
    || !/^[a-f0-9]{32}$/iu.test(apiHash)
  ) {
    throw new Error("Telegram release input is missing or invalid.");
  }
};

const run = () => {
  validateTelegramReleaseInput(process.env.TRELIO_TELEGRAM_APP_CREDENTIAL_JSON);
  process.stdout.write("Telegram distributable release input is valid.\n");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Telegram release input is invalid."}\n`);
    process.exitCode = 1;
  }
}
