#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const excluded = new Set(["1c-vkus", "1c-vkus-kadry", "telegram-web-legacy"]);

/**
 * Check the Git snapshot, not the developer's working directory: caches and
 * personal sessions can exist locally but must never enter public history.
 * This guard supplements review; it does not claim to detect every secret.
 * Diagnostics name paths and rules only, never the matched value.
 */
export const inspectPublicFile = (name, bytes) => {
  const failures = [];
  const parts = name.split("/");
  if (parts[0] === "platform-skills" && excluded.has(parts[1])) failures.push("private_provider");
  if (/(?:^|\/)(?:\.secrets?|credentials|sessions?)(?:\/|$)|\.(?:skillpkg|session|sqlite|db|p12|pfx)$/iu.test(name)) failures.push("private_material");
  const text = bytes.toString("utf8");
  // Exact known tenant and personal identities are excluded from both source
  // and fixtures. Generic UUID fixtures and namespace validators remain valid.
  const privateIdentityHashes = new Set(["e46971b15dce6707216197d0d0f6eed45601ecd0ab0712d37dc5d02986af6ba4", "ed4578023afbbf6a3ec714fd3a4e81781e4ea4ed9aca5345e6f37e122fe12ea3", "acd30acfad92dbc0ab399f1d8bff952310b699b03ff9c268567528d07bf17c29"]);
  for (const match of text.matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/giu)) {
    const digest = createHash("sha256").update(match[0].toLowerCase()).digest("hex");
    if (privateIdentityHashes.has(digest)) failures.push("private_identity");
  }
  if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u.test(text)) failures.push("private_key");
  for (const match of text.matchAll(/api_hash["']?\s*[:=]\s*["']([a-f0-9]{32})["']/giu)) {
    if (!/^([a-f0-9])\1{31}$/iu.test(match[1])) failures.push("application_identity");
  }
  return [...new Set(failures)];
};

export const checkPublicSource = () => {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("public_source_git_inventory_failed");
  const files = result.stdout.split("\0").filter(Boolean);
  if (!files.length) throw new Error("public_source_empty_snapshot");
  const failures = files.flatMap((name) => inspectPublicFile(name, fs.readFileSync(path.join(root, name)))
    .map((rule) => ({ path: name, rule })));
  if (failures.length) {
    process.stderr.write(`${JSON.stringify({ failures })}\n`);
    throw new Error("public_source_review_required");
  }
  process.stdout.write(`${JSON.stringify({ checkedFiles: files.length, publicSource: true })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { checkPublicSource(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
