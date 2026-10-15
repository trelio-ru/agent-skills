/** Single signed entrypoint and programmatic API. All original layers are
 * exported, so tests/consumers exercise the actual delivered implementation. */
import {main} from './cli.js';
import {safeError} from './mcp/server.js';
export {main,consumeProxyPool} from './cli.js';
export {AvitoScraper} from './core/scraper.js';
export {AvitoParser} from './core/parser.js';
export {BrowserManager,requireIdentity,requestAllowed} from './core/browser.js';
export {ProxyManager,parseProxy} from './core/proxy-manager.js';
export {SequentialRotation} from './plugins/proxy/sequential.js';
export {RandomRotation} from './plugins/proxy/random.js';
export {RoundRobinRotation} from './plugins/proxy/round-robin.js';
export {ConsoleOutput} from './plugins/output/console.js';
export {JsonOutput} from './plugins/output/json.js';
export * from './utils/url-builder.js';
export * from './utils/delays.js';
export * from './utils/user-agents.js';
export {tools,validateToolInput,callTool,createMcpServer,safeError} from './mcp/server.js';
export {project} from './projection.js';
// The bundled file is CommonJS for proxy-chain's native Node dependencies.
// Importing it for tests/API must never parse argv or launch a browser.
if(typeof require!=='undefined' && require.main===module)main().catch(error=>{
  if(error?.code==='commander.helpDisplayed' || error?.code==='commander.version')return;
  const detail=String(error?.code||'').startsWith('commander.')?{code:'INVALID_INPUT',message:'Некорректная команда или параметры'}:safeError(error);
  process.stdout.write(JSON.stringify({ok:false,error:detail})+'\n');process.exitCode=1;
});
