import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { remoteMcp } = JSON.parse(readFileSync(new URL("../remote-mcp.json", import.meta.url), "utf8"));

test("Dodo Knowledge Base binds the Russian endpoint and public client to read-only tools", () => {
  assert.deepEqual(remoteMcp, {
    schemaVersion: 4,
    endpoint: "https://knowledgebase.dodois.io/mcp",
    transport: "streamable_http",
    protocolVersion: "2025-03-26",
    authentication: {
      type: "oauth2_pkce",
      clientRegistration: "static",
      clientId: "knowledgebase_mcp",
      scopes: ["knowledgebase:mcp", "offline_access", "openid"],
    },
    // The live Russian catalogue was read after Dodo IS sign-in. A future
    // release must review every additional name before changing this list.
    allowedTools: [
      "current_user",
      "get_announcements",
      "get_content",
      "get_link_templates",
      "get_space_content",
      "get_space_tree",
      "get_spaces",
      "preview_content",
      "search_content",
      "search_in_content",
    ],
    headers: {},
    credentialHelp: null,
  });
});
