import assert from "node:assert/strict";
import test from "node:test";
import { readAgentSkillSourceMetadata, stripAgentSkillCatalogMetadata } from "./skill-source-metadata.mjs";

const old = "---\nname: example\ndescription: Technical English discovery.\n---\n\n# Internal title\n\nExact instruction.";
const metadata = 'metadata:\n  catalog_title: "Русское название"\n  catalog_description: >-\n    Краткое описание\n    для человека\n';
const source = old.replace("\n---\n", "\n" + metadata + "---\n");

test("catalog metadata is explicit presentation and never changes delivered instruction bytes", () => {
  assert.deepEqual(readAgentSkillSourceMetadata(source, "example"), {
    title: "Русское название", description: "Краткое описание для человека",
  });
  assert.equal(stripAgentSkillCatalogMetadata(source), old);
  assert.equal(stripAgentSkillCatalogMetadata(source.replaceAll("\n", "\r\n")), old.replaceAll("\n", "\r\n"));
  assert.equal(readAgentSkillSourceMetadata(old, "example"), null);
  assert.equal(stripAgentSkillCatalogMetadata(old), old);
  assert.equal(readAgentSkillSourceMetadata(source, "other"), null);
});

test("projection preserves unrelated metadata and refuses malformed catalog declarations", () => {
  const withOther = source.replace("metadata:\n", "metadata:\n  short-description: Existing Codex copy\n");
  assert.equal(stripAgentSkillCatalogMetadata(withOther),
    old.replace("\n---\n", "\nmetadata:\n  short-description: Existing Codex copy\n---\n"));
  for (const invalid of [
    source.replace("metadata:\n", "metadata: *alias\n"),
    source.replace('catalog_title: "Русское название"', "catalog_title: !execute unsafe"),
    source.replace("  catalog_description:", "  unrelated:"),
    source.replace("metadata:\n", "metadata:\nmetadata:\n"),
  ]) {
    assert.equal(readAgentSkillSourceMetadata(invalid, "example"), null);
    assert.equal(stripAgentSkillCatalogMetadata(invalid), invalid, "unknown formats are not partially rewritten");
  }
});
