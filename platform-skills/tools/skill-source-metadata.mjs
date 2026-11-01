/**
 * SKILL.md keeps discovery prose and human catalog copy separate. Only the
 * explicit metadata.catalog_title/catalog_description pair may update a card;
 * legacy description/H1 can be English routing instructions, never UI copy.
 * This bounded reader accepts simple scalars/folded text, never YAML execution.
 * Unsupported or legacy documents retain the explicit draft/current card.
 * The same pure module is used by the browser and the maintainer publisher.
 */
export const readAgentSkillSourceMetadata = (source, expectedSkillId) => {
  const normalized = String(source || "").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > 200_000) return null;
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(`${normalized}\n`);
  if (!match) return null;
  const lines = match[1].split("\n");
  const scalar = value => {
    const text = value.trim();
    if (text.startsWith('"')) {
      try { const parsed = JSON.parse(text); return typeof parsed === "string" ? parsed : null; }
      catch { return null; }
    }
    if (text.startsWith("'")) return /^'(?:[^']|'')*'$/u.test(text) ? text.slice(1, -1).replaceAll("''", "'") : null;
    if (!text || /^[!&*[{|>#]/u.test(text) || /^(?:true|false|null|~)$/iu.test(text)) return null;
    return text.replace(/\s+#.*$/u, "");
  };
  const field = (key, scope = lines) => {
    const indexes = scope.flatMap((line, index) => line.startsWith(`${key}:`) ? [index] : []);
    if (indexes.length !== 1) return null;
    const index = indexes[0];
    const value = scope[index].slice(key.length + 1).trim();
    if (/^[>|][-+]?$/u.test(value)) {
      const continuation = [];
      for (let i = index + 1; i < scope.length && /^(?:\s|$)/u.test(scope[i]); i += 1) {
        continuation.push(scope[i].trim());
      }
      return continuation.join(value.startsWith(">") ? " " : "\n").trim();
    }
    return scalar(value);
  };
  const id = field("name");
  const blocks = lines.flatMap((line, index) => line.startsWith("metadata:") ? [index] : []);
  if (blocks.length !== 1 || lines[blocks[0]].trim() !== "metadata:") return null;
  const metadata = [];
  for (let i = blocks[0] + 1; i < lines.length; i += 1) {
    if (lines[i] && !/^\s/u.test(lines[i])) break;
    if (lines[i] && !lines[i].startsWith("  ")) return null;
    metadata.push(lines[i].slice(2));
  }
  // Match the API normalizer before hashing a publication plan. Never fall
  // back to the agent's technical description or a guessed Markdown heading.
  const description = field("catalog_description", metadata)?.trim();
  const title = field("catalog_title", metadata)?.trim();
  if (!id || (expectedSkillId !== undefined && id !== expectedSkillId) || !description || description.length > 10_000 || !title || title.length > 255) return null;
  return { title, description };
};

/** Catalog presentation is not executable/discovery instruction text. Remove
 * only a validated explicit pair, preserving technical description, body and
 * unrelated metadata. Legacy/unsupported sources remain byte-for-byte intact.
 * This projection is shared by publishers, pre-encryption and budget reports. */
export const stripAgentSkillCatalogMetadata = (source) => {
  if (!readAgentSkillSourceMetadata(source)) return source;
  const text = String(source).trim();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return source;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const header = match[1].split(/\r?\n/u);
  const start = header.findIndex(line => line === "metadata:");
  let end = start + 1;
  while (end < header.length && (!header[end] || /^\s/u.test(header[end]))) end += 1;
  const retained = [];
  for (let index = start + 1; index < end; index += 1) {
    if (/^  catalog_(?:title|description):/u.test(header[index])) {
      // Folded continuations belong to this field, never the next mapping key.
      while (index + 1 < end && /^(?:    |$)/u.test(header[index + 1])) index += 1;
    } else retained.push(header[index]);
  }
  const keepBlock = retained.some(line => line.trim() && !line.trim().startsWith("#"));
  const nextHeader = [...header.slice(0, start), ...(keepBlock ? ["metadata:", ...retained] : []), ...header.slice(end)];
  return ["---", ...nextHeader, "---"].join(newline)
    + (match[0].endsWith("\n") ? newline : "") + text.slice(match[0].length);
};
