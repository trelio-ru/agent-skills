#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { run } from '../scripts/trelio-whatsapp.mjs';
import { RuntimeError, requireThat } from '../scripts/core.mjs';

// Explicit source-development harness, excluded from the release package.
// These reserved fixture IDs represent no Trelio company/member. A distinct
// root prevents test pairings from impersonating or replacing a live catalog
// connection. The exact same vault, OS secret store and guardian protect this login.
try {
  requireThat(process.argv[2] === '--confirm-live-login', 'explicit_live_login_required');
  process.env.TRELIO_CONFIG_HOME = path.join(os.homedir(), '.config', 'trelio', 'development', 'whatsapp-web');
  process.env.TRELIO_SKILL_ID = 'whatsapp-web';
  process.env.TRELIO_SKILL_COMPANY_ID = '10000000-0000-4000-8000-000000000001';
  process.env.TRELIO_SKILL_MEMBER_ID = '10000000-0000-4000-8000-000000000002';
  process.env.TRELIO_SKILL_CONNECTION_ID = '10000000-0000-4000-8000-000000000003';
  process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON = '{"allowAutonomous":false}';
  process.stdout.write(`${JSON.stringify(await run(process.argv.slice(3)))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof RuntimeError ? error.code : 'development_failed' })}\n`);
  process.exitCode = 1;
}
