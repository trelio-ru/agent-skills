/** Trelio adapter for Ascard CLI. JSON is the default model transport;
 * --format console and --output retain upstream's human/table/file modes.
 * No dotenv, PATH executable override, arbitrary evaluate or raw stack output. */
import {Command,InvalidArgumentError} from 'commander';
import {AvitoScraper} from './core/scraper.js';
import {requireIdentity} from './core/browser.js';
import {parseProxy} from './core/proxy-manager.js';
import {ConsoleOutput} from './plugins/output/console.js';
import {JsonOutput} from './plugins/output/json.js';
import {callTool,startMcpServer} from './mcp/server.js';
import {ScraperError,type ScraperOptions} from './core/types.js';
const integer=(value:string) => {
  if(!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))throw new InvalidArgumentError('Нужно целое неотрицательное число');
  return Number(value);
};
const boolean=(value:string) => {
  if(!['true','false'].includes(value))throw new InvalidArgumentError('Нужно true или false');
  return value==='true';
};
export function consumeProxyPool(environment=process.env) {
  const value=environment.TRELIO_AVITO_PROXY_POOL;
  // One-use Agent Secret delivery is process-only. Remove it before browser
  // launch, dependency subprocesses or diagnostics can inherit the value.
  delete environment.TRELIO_AVITO_PROXY_POOL;
  if(value===undefined)return undefined;
  if(value.length>65536)throw new ScraperError('Слишком большой пул прокси','PROXY_INPUT_INVALID');
  const lines=value.split(/\r?\n/u).map(line=>line.trim()).filter(line=>line && !line.startsWith('#'));
  if(!lines.length || lines.length>100)throw new ScraperError('Нужны 1–100 прокси','PROXY_INPUT_INVALID');
  return lines.map(line=>parseProxy(line,true));
}
async function loadHost() {
  requireIdentity();
  const url=process.env.TRELIO_BROWSER_SESSION_MODULE_URL;
  if(!url?.startsWith('file:'))throw new ScraperError('Требуется общий браузерный runtime Trelio','HOST_BINDING_REQUIRED');
  return import(url);
}
function runtimeOptions(options:any):ScraperOptions {
  const proxies=consumeProxyPool();
  if(proxies && options.proxyFile)throw new ScraperError('Выберите один источник прокси','INVALID_INPUT');
  if(!['json','console'].includes(options.format || 'json') || !['sequential','random','round-robin'].includes(options.proxyRotation))throw new ScraperError('Неизвестный формат или ротация','INVALID_INPUT');
  return {headless:options.headless,timeout:options.timeout,stealth:options.stealth,
    ...(options.userAgent?{userAgent:options.userAgent}:{}),
    ...(proxies || options.proxyFile ? {proxy:{enabled:true,proxies,listFile:options.proxyFile,rotation:options.proxyRotation,
      rotateEveryN:options.proxyRotateEvery,rotateOnError:true}}:{})};
}
export async function main(argv=process.argv.slice(2)):Promise<void> {
  const program=new Command().name('trelio-avito').version('1.0.0').description('Ascard Avito scraper adapted for Trelio');
  program.exitOverride().configureOutput({writeErr:()=>{}});
  for(const command of ['doctor','bootstrap'])program.command(command).action(async()=>{
    const host=await loadHost();
    if(command==='bootstrap')host.bootstrapPlaywright();
    const result=host.inspectBrowserRuntime();
    process.stdout.write(JSON.stringify({ok:true,runtimeReady:result.runtimeReady,skillId:'avito-search',version:'1.0.0'})+'\n');
  });
  const common=(command:Command) => command
    .option('--headless <boolean>','Headless mode; manual CAPTCHA requires a headed browser',boolean,false)
    .option('--timeout <ms>','Document timeout, 100–60000 ms',integer,30000)
    .option('--stealth <boolean>','Upstream navigator adjustments',boolean,true)
    .option('--user-agent <text>','Explicit user agent')
    .option('--proxy-file <file>','Credential-free proxy list; passwords use Agent Secret process delivery')
    .option('--proxy-rotation <strategy>','sequential|random|round-robin','sequential')
    .option('--proxy-rotate-every <n>','Rotate before each N+1 document',integer,0);
  for(const name of ['search','search-all','details']) {
    const command=common(program.command(name).argument('<query-or-url>'))
      .option('--format <format>','json|console','json').option('--output <file>','Atomic JSON export');
    if(name!=='details')command.option('--price-min <number>','Minimum price',integer).option('--price-max <number>','Maximum price',integer)
      .option('--location <slug>','Region slug, for example moskva').option('--location-id <id>','Legacy numeric region; explicit unsupported error',integer)
      .option('--category <slug>','Category slug').option('--page <n>','First page',integer,1)
      .option('--sort <order>','default|date|price_asc|price_desc','default');
    if(name==='search-all')command.option('--limit <n>','Max items, 1–1000',integer,200).option('--max-pages <n>','Max pages, 1–100',integer,10);
    command.action(async(value:string,options:any)=>{
      // Validate and consume configuration before initializing the browser.
      const scraper=new AvitoScraper(runtimeOptions(options));
      try {
        requireIdentity();
        const input=name==='details'?{url:value}:{query:value,price_min:options.priceMin,price_max:options.priceMax,
          location:options.location,location_id:options.locationId,category:options.category,page:options.page,sort:options.sort,
          ...(name==='search-all'?{limit:options.limit,max_pages:options.maxPages}:{})};
        const args=Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined));
        const result=await callTool(scraper,name==='details'?'avito_get_details':name==='search-all'?'avito_search_all':'avito_search',args);
        if(options.output)await new JsonOutput().save(result,options.output);
        if(options.format==='console') {
          const output=new ConsoleOutput();
          if(result.details)output.displayDetails(result.details);else output.displayResults(result.results);
        } else process.stdout.write(JSON.stringify({ok:true,...result})+'\n');
      } finally {await scraper.close();}
    });
  }
  common(program.command('mcp')).action(async(options:any)=>{
    requireIdentity();await startMcpServer(new AvitoScraper(runtimeOptions(options)));
  });
  await program.parseAsync(argv,{from:'user'});
}
