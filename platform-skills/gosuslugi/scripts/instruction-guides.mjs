import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A closed map of signed, public documents. This command must remain usable
// before account selection, native unlock, browser setup or any auth attempt.
// It never accepts a caller-controlled path or loads credential/session state.
const files = {
  safety: 'safety.md', accounts: 'accounts.md', runtime: 'runtime-commands.md',
  browser: 'browser-lifecycle.md', portalAuth: 'portal-authorization.md',
  compatibility: 'compatibility.md', routing: 'routing.md', roles: 'role-review.md',
  esia: 'esia-authorization.md', pos: 'pos-submission.md', goskey: 'goskey-signing.md',
  applications: 'portal-applications.md', playwright: 'playwright-client.md',
};
const directory = fileURLToPath(new URL('../references/', import.meta.url));

export const getInstructionGuides = async () => ({
  schemaVersion: 1,
  requiredBeforeWork: ['safety', 'accounts', 'runtime', 'browser', 'portalAuth', 'compatibility', 'routing'],
  guides: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => {
    const absolutePath = path.join(directory, file);
    const bytes = await fs.readFile(absolutePath);
    return [name, { path: absolutePath, sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  }))),
});
