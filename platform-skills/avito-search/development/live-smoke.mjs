#!/usr/bin/env node
/** Maintainer-only source smoke. Synthetic identity is confined to a development
 * config root, never supplied to an MCP/protected Trelio operation. No existing
 * account, profile or browser state is loaded. The real public provider reads
 * are explicitly authorized by the development request, not by this fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../scripts/trelio-avito.mjs';

const modulePath = process.argv[2];
if (!modulePath || !path.isAbsolute(modulePath) || !fs.statSync(modulePath).isFile()) throw new Error('Pass the exact existing generic browser-session module path');
// Retain only rate-limit timestamps between development attempts. A new
// fixture identity/temporary browser must not erase a known IP cooldown.
const root = path.join(os.homedir(), '.cache', 'trelio', 'development', 'avito-search');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const startedAt = Date.now();
process.env.TRELIO_CONFIG_HOME = root;
process.env.TRELIO_SKILL_ID = 'avito-search';
for (const key of ['TRELIO_SKILL_COMPANY_ID','TRELIO_SKILL_MEMBER_ID','TRELIO_SKILL_CONNECTION_ID']) process.env[key] = '11111111-1111-4111-8111-111111111111';
process.env.TRELIO_BROWSER_SESSION_MODULE_URL = pathToFileURL(modulePath).href;
process.env.TRELIO_BROWSER_SESSION_POLICY_JSON = JSON.stringify({apiVersion:1,sessionClass:'delegated-ephemeral',leaseMs:1800000,manualAssist:true});
process.env.TRELIO_BROWSER_SESSION_STARTED_AT = String(startedAt);
process.env.TRELIO_BROWSER_SESSION_DEADLINE_AT = String(startedAt + 1800000);
try {
  const result = await main(['search','--query','iphone','--location','Москва','--limit','2','--open','1','--headed']);
  const item = result.opened?.[0];
  const success = result.count > 0 && item?.id === result.items[0].id && Boolean(item.title && item.description && item.url);
  process.stdout.write(`${JSON.stringify({ok:success,searchCount:result.count,itemRead:Boolean(item),pricePresent:typeof item?.price==='number',descriptionPresent:Boolean(item?.description)})}\n`);
  if (!success) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ok:false,errorCode:error.code||'RUNTIME_FAILED',functionalSmokePassed:false})}\n`);
  process.exitCode=1;
}
