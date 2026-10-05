#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Provider-specific changes should pay only for their own regressions. These
 * entries describe the providers owned by the general workflow; providers
 * with a dedicated native workflow are deliberately ignored unless shared
 * tooling or this workflow itself changed.
 */
const PROVIDERS = Object.freeze({
  "1c-edo": { owner: "general", matrix: { language: "python" } },
  "consultant-plus": { owner: "general", matrix: null },
  "dodostats-drinkitstats": { owner: "general", matrix: null },
  "gas-pravosudie": {
    owner: "general",
    matrix: {
      language: "node",
      testFile: "platform-skills/gas-pravosudie/tests/runtime.test.mjs",
    },
  },
  "iphone-mirroring": {
    owner: "general",
    matrix: {
      language: "node",
      testFile: "platform-skills/iphone-mirroring/tests/trelio-iphone-mirroring.test.mjs",
    },
  },
  "max-web": {
    owner: "general",
    matrix: {
      language: "node",
      testFile: "platform-skills/max-web/tests/trelio-max.test.mjs",
    },
  },
  "ozon-buyer-search": { owner: "general", matrix: null },
  "russian-post-registered-mail": { owner: "general", matrix: null },
  "telegram-mtproto": { owner: "general", matrix: { language: "python" } },
  "telegram-web": {
    owner: "general",
    matrix: {
      language: "node",
      testFile: "platform-skills/telegram-web/tests/trelio-telegram-web.test.mjs",
    },
  },
  // The archived source stays covered only by the shared instruction contract.
  "email-imap-smtp": { owner: "dedicated", matrix: { language: "python" } },
  "gosuslugi": { owner: "dedicated", matrix: null },
  "t-bank": { owner: "dedicated", matrix: null },
  "whatsapp-web": {
    owner: "dedicated",
    matrix: {
      language: "node",
      testFile: "platform-skills/whatsapp-web/tests/*.test.mjs",
    },
  },
});

const HOSTED_OPERATING_SYSTEMS = Object.freeze([
  "ubuntu-latest",
  "macos-latest",
  "windows-latest",
]);

// Preserve the former full self-hosted gate for shared infrastructure changes.
const FULL_SELF_HOSTED_SKILLS = Object.freeze([
  "email-imap-smtp",
  "1c-edo",
  "iphone-mirroring",
  "gosuslugi",
  "gas-pravosudie",
  "max-web",
  "whatsapp-web",
  "telegram-mtproto",
  "telegram-web",
  "consultant-plus",
  "dodostats-drinkitstats",
]);

const FULL_HOSTED_MATRIX_SKILLS = Object.freeze([
  "email-imap-smtp",
  "1c-edo",
  "iphone-mirroring",
  "gas-pravosudie",
  "max-web",
  "whatsapp-web",
  "telegram-mtproto",
  "telegram-web",
]);

const normalizePath = (filePath) => String(filePath || "")
  .trim()
  .replaceAll("\\", "/")
  .replace(/^\.\//u, "");

const providerFromPath = (filePath) => {
  const match = /^platform-skills\/([^/]+)\//u.exec(filePath);
  return match?.[1] || null;
};

const buildHostedMatrix = (skills) => ({
  include: skills.flatMap((skill) => {
    const provider = PROVIDERS[skill];
    if (!provider?.matrix) return [];
    return HOSTED_OPERATING_SYSTEMS.map((os) => ({
      os,
      skill,
      language: provider.matrix.language,
      ...(provider.matrix.testFile ? { test_file: provider.matrix.testFile } : {}),
    }));
  }),
});

/**
 * Convert an exact PR diff into the smallest safe regression plan. Shared
 * tooling and this workflow retain the old full gate because they can change
 * package semantics or routing for every provider.
 */
export const selectProviderRegressions = (rawFiles) => {
  const files = [...new Set(rawFiles.map(normalizePath).filter(Boolean))].sort();
  const full = files.some((filePath) => (
    filePath === ".github/workflows/platform-skill-runtimes.yml"
    || filePath.startsWith("platform-skills/tools/")
  ));

  const changedProviderIds = [...new Set(files.map(providerFromPath).filter(Boolean))]
    .filter((providerId) => providerId !== "tools")
    .sort();
  const unknownProviderIds = changedProviderIds.filter((providerId) => !PROVIDERS[providerId]);
  if (unknownProviderIds.length > 0) {
    throw new Error(
      `Unknown provider directories require an explicit CI route: ${unknownProviderIds.join(", ")}`,
    );
  }

  // Dedicated workflows own provider-only changes. They rejoin this workflow
  // only for a shared change, when preserving the former broad gate is useful.
  const selectedSkills = full
    ? Object.keys(PROVIDERS).filter((skill) => PROVIDERS[skill].owner === "general").sort()
    : changedProviderIds.filter((skill) => PROVIDERS[skill].owner === "general");
  const selfHostedSkills = full ? [...FULL_SELF_HOSTED_SKILLS] : [...selectedSkills];
  const hostedMatrixSkills = full
    ? [...FULL_HOSTED_MATRIX_SKILLS]
    : selectedSkills.filter((skill) => PROVIDERS[skill].matrix);

  const hostedMatrix = buildHostedMatrix(hostedMatrixSkills);
  const hasWork = selfHostedSkills.length > 0;
  return {
    full,
    files,
    changedProviderIds,
    selectedSkills,
    selfHostedSkills,
    hostedMatrix,
    hasHostedMatrix: hostedMatrix.include.length > 0,
    runPackageTool: hasWork,
    runSourceTests: hasWork,
    runConsultantPlus: full || selectedSkills.includes("consultant-plus"),
    runTelegramContract: full || selectedSkills.includes("telegram-mtproto"),
    runDodoStats: full || selectedSkills.includes("dodostats-drinkitstats"),
  };
};

const parseArguments = (argumentsList) => {
  const options = { base: "", head: "", githubOutput: "" };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = () => argumentsList[++index] || "";
    if (argument === "--base") options.base = value();
    else if (argument === "--head") options.head = value();
    else if (argument === "--github-output") options.githubOutput = value();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.base || !options.head) {
    throw new Error("--base and --head are required.");
  }
  return options;
};

const readChangedFiles = (base, head) => {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${base}...${head}`],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`Unable to read pull-request diff${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean);
};

const appendGithubOutputs = (outputPath, selection) => {
  // Every value is one-line JSON or a scalar, so GitHub cannot reinterpret a
  // changed filename as a workflow command or multiline output delimiter.
  const outputs = {
    provider_matrix: JSON.stringify(selection.hostedMatrix),
    has_provider_matrix: String(selection.hasHostedMatrix),
    run_package_tool: String(selection.runPackageTool),
    run_source_tests: String(selection.runSourceTests),
    run_consultant_plus: String(selection.runConsultantPlus),
    run_telegram_contract: String(selection.runTelegramContract),
    run_dodostats: String(selection.runDodoStats),
    self_hosted_skills: selection.selfHostedSkills.join(","),
    selection_summary: JSON.stringify({
      full: selection.full,
      changedProviderIds: selection.changedProviderIds,
      selectedSkills: selection.selectedSkills,
    }),
  };
  fs.appendFileSync(
    outputPath,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8",
  );
};

export const main = (argumentsList = process.argv.slice(2)) => {
  const options = parseArguments(argumentsList);
  const selection = selectProviderRegressions(readChangedFiles(options.base, options.head));
  if (options.githubOutput) appendGithubOutputs(options.githubOutput, selection);
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
