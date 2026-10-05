import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const source = path.resolve('_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs');
if (!existsSync(source)) throw new Error('Exact host runtime contract checkout is required.');
process.env.TRELIO_BROWSER_SESSION_MODULE_URL = pathToFileURL(source).href;
export const httpRuntime = await import(process.env.TRELIO_BROWSER_SESSION_MODULE_URL);
