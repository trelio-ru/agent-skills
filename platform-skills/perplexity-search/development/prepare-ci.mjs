import { readFileSync } from "node:fs";
import vm from "node:vm";

// This provider ships browser instructions, not a Node runtime or a browser.
// CI compiles the exact delivered REPL controller without installing browsers,
// opening a personal session, or treating a static check as a live search.
const instruction = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const controller = [...instruction.matchAll(/```javascript\r?\n([\s\S]*?)```/gu)]
  .map((match) => match[1])
  .find((source) => source.startsWith("var perplexityPacing ="));
if (!controller) throw new Error("perplexity_pacing_controller_missing");
new vm.Script(controller, { filename: "perplexity-search-controller" });
