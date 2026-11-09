// Exact read-only common runtime input; no owner profile or live connection.
const moduleUrl = new URL('../../../_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs', import.meta.url).href;
const host = await import(moduleUrl);
if (host.BROWSER_EXECUTION_SESSIONS_API !== 'trelio.browser-execution-sessions/v1') throw Error('parallel_sessions_contract_required');
process.env.TRELIO_BROWSER_SESSION_MODULE_URL = moduleUrl;
