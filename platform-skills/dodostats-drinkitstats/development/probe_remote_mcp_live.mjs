#!/usr/bin/env node

/**
 * Perform a bounded, read-only verification of the public provider contract.
 *
 * This is development/release tooling, not the production integration path.
 * Production calls must go through Trelio's trusted Remote MCP host so that
 * assignment, release, DNS/IP, protocol and live read-only selection run again.
 */

import { readFile } from "node:fs/promises";

const skillDirectory = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("remote-mcp.json", skillDirectory), "utf8"),
);
const { remoteMcp } = manifest;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOL_COUNT = 64;
const MAX_TOOL_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 3;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

class ProviderContractError extends Error {}

const postJsonRpcOnce = async (payload) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(remoteMcp.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": remoteMcp.protocolVersion,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const ErrorType = response.status >= 500 ? Error : ProviderContractError;
      throw new ErrorType(`Remote MCP returned HTTP ${response.status}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
      throw new ProviderContractError(
        `Remote MCP response must contain 1-${MAX_RESPONSE_BYTES} bytes.`,
      );
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ProviderContractError("Remote MCP returned invalid UTF-8 JSON.");
    }
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Initialize and tools/list are idempotent reads. Retry only transport/5xx
 * failures; an explicit provider 4xx or a valid incompatible MCP response is
 * a contract result and must not be blurred by repeated requests.
 */
const postJsonRpc = async (payload) => {
  let lastError;

  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return await postJsonRpcOnce(payload);
    } catch (error) {
      lastError = error;

      if (error instanceof ProviderContractError || attempt === READ_ATTEMPTS) {
        break;
      }
      await wait(250 * attempt);
    }
  }

  throw lastError;
};

const initialized = await postJsonRpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: remoteMcp.protocolVersion,
    capabilities: {},
    clientInfo: {
      name: "trelio-agent-skill-release-probe",
      version: manifest.release.version,
    },
  },
});

if (initialized?.result?.protocolVersion !== remoteMcp.protocolVersion) {
  throw new Error("Remote MCP negotiated an unexpected protocol version.");
}

if (
  remoteMcp.schemaVersion !== 2
  || remoteMcp.toolPolicy?.mode !== "all_read_only"
  || Object.hasOwn(remoteMcp, "allowedTools")
) {
  throw new Error("Remote MCP manifest does not declare all_read_only discovery.");
}

const tools = [];
let cursor = null;
for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
  const listed = await postJsonRpc({
    jsonrpc: "2.0",
    id: page + 2,
    method: "tools/list",
    params: cursor ? { cursor } : {},
  });
  const pageTools = listed?.result?.tools;
  if (!Array.isArray(pageTools)) {
    throw new Error("Remote MCP tools/list did not return an array.");
  }
  tools.push(...pageTools);
  if (tools.length > MAX_TOOL_COUNT) {
    throw new Error(`Remote MCP published more than ${MAX_TOOL_COUNT} tools.`);
  }
  cursor = typeof listed.result.nextCursor === "string" && listed.result.nextCursor
    ? listed.result.nextCursor
    : null;
  if (!cursor) break;
}
if (cursor) {
  throw new Error(`Remote MCP tools/list exceeded ${MAX_TOOL_PAGES} pages.`);
}

const toolNames = tools.map((tool) => String(tool?.name || ""));
if (
  toolNames.length === 0
  || toolNames.some((name) => !TOOL_NAME_PATTERN.test(name))
  || new Set(toolNames).size !== toolNames.length
) {
  throw new Error("Remote MCP published an empty or ambiguous tool list.");
}

for (const tool of tools) {
  if (
    tool?.annotations?.readOnlyHint !== true
    || tool?.annotations?.destructiveHint !== false
  ) {
    throw new Error(`Tool ${tool?.name || "<unknown>"} is not strictly read-only.`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  endpoint: remoteMcp.endpoint,
  protocolVersion: initialized.result.protocolVersion,
  server: initialized.result.serverInfo,
  discoveredTools: [...toolNames].sort(),
})}\n`);
