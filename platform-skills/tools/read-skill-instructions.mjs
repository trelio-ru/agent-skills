import fs from 'node:fs';

/** Read the same ordered corpus agents must load from the signed package.
 * Contract assertions must follow relocated rules, while the independent byte
 * guard continues measuring only the always-delivered main SKILL.md.
 */
export function readSkillInstructions(skillUrl) {
  const main = fs.readFileSync(new URL('SKILL.md', skillUrl), 'utf8');
  let map;
  try { map = JSON.parse(fs.readFileSync(new URL('scripts/instruction-guides/map.json', skillUrl), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return main; throw error; }
  // Original headings precede the compact source-navigation index so semantic
  // section tests inspect the actual rule, not a second heading linking to it.
  return map.sections.map(section =>
    fs.readFileSync(new URL(`scripts/instruction-guides/${section.file}`, skillUrl), 'utf8') + (section.sourceSuffix ?? '')).join('') + '\n' + main;
}
