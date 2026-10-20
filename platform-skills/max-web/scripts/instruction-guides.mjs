import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Closed signed document map, never a caller-controlled filesystem path.
// The metadata route runs before native/identity/browser/network initialization.
const files = ["part-01.md", "part-02.md", "part-03.md", "part-04.md", "part-05.md", "part-06.md", "part-07.md", "part-08.md", "part-09.md"];
export async function getInstructionGuides() {
  return { schemaVersion: 1, requiredBeforeWork: 'all_in_order', guides:
    await Promise.all(files.map(async file => {
      const location = new URL(`./instruction-guides/${file}`, import.meta.url);
      const bytes = await fs.readFile(location);
      return { path: fileURLToPath(location), sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    })) };
}
