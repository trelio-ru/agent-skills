/** Original three Ascard MCP operations, sharing Trelio's verified core.
 * Merely importing this module never starts stdio, a browser or a network call.
 * A persistent server reuses its scraper/page; overlapping calls fail busy. */
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {AvitoScraper} from '../core/scraper.js';
import {ScraperError,type SearchFilters} from '../core/types.js';
import {project} from '../projection.js';
const searchProperties={query:{type:'string',minLength:1,maxLength:200},price_min:{type:'integer',minimum:0},price_max:{type:'integer',minimum:0},
  location:{type:'string',description:'Public region slug, for example moskva'},category:{type:'string'},
  location_id:{type:'integer',description:'Legacy upstream input; rejected explicitly, use location slug'},
  sort:{type:'string',enum:['default','date','price_asc','price_desc']}};
export const tools:Tool[]=[
  {name:'avito_search',description:'Search public Avito listings; one bounded page.',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{...searchProperties,page:{type:'integer',minimum:1,maximum:100}},required:['query'],additionalProperties:false}},
  {name:'avito_get_details',description:'Read one public listing: description, price, seller, images, specifications.',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{url:{type:'string',maxLength:2000}},required:['url'],additionalProperties:false}},
  {name:'avito_search_all',description:'Read multiple pages within max_pages/limit budgets; reports partial coverage.',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{...searchProperties,page:{type:'integer',minimum:1,maximum:100},limit:{type:'integer',minimum:1,maximum:1000},max_pages:{type:'integer',minimum:1,maximum:100}},required:['query'],additionalProperties:false}},
  {name:'avito_access_status',description:'Passively check a manual access challenge in the same browser; no navigation or replay.',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{},additionalProperties:false}},
];
export function validateToolInput(name:string,args:unknown):Record<string,any> {
  const tool=tools.find(tool=>tool.name===name);
  if(!tool || !args || typeof args!=='object' || Array.isArray(args))throw new ScraperError('Некорректный инструмент или аргументы','INVALID_INPUT');
  const input=args as Record<string,unknown>;
  const properties=tool.inputSchema.properties as Record<string,any>;
  for(const key of tool.inputSchema.required || [])if(!Object.hasOwn(input,key))throw new ScraperError('Не хватает обязательного аргумента','INVALID_INPUT');
  for(const [key,value] of Object.entries(input)) {
    const rule=properties[key];
    if(!rule || (rule.type==='integer' ? !Number.isSafeInteger(value) || Number(value)<(rule.minimum??0) || Number(value)>(rule.maximum??Number.MAX_SAFE_INTEGER)
      : typeof value!=='string' || value.length<(rule.minLength??0) || value.length>(rule.maxLength??2000) || (rule.enum && !rule.enum.includes(value)))) {
      throw new ScraperError('Недопустимое поле или значение','INVALID_INPUT');
    }
  }return input;
}
export const safeError=(error:unknown) => error instanceof ScraperError ? {code:error.code,message:error.message} : {code:'RUNTIME_FAILED',message:'Операция Авито не выполнена'};
export async function callTool(scraper:AvitoScraper,name:string,raw:unknown):Promise<any> {
  const args=validateToolInput(name,raw);
  if(name==='avito_access_status')return scraper.accessStatus();
  if(name==='avito_get_details')return project({details:await scraper.getItemDetails(args.url)});
  const filters:SearchFilters={query:args.query,priceMin:args.price_min,priceMax:args.price_max,location:args.location,category:args.category,
    locationId:args.location_id,page:args.page,sort:args.sort};
  if(name==='avito_search') {const results=await scraper.search(filters);return project({count:results.length,results});}
  // Pagination bounds belong to the core, not just MCP's advertised schema.
  // A dedicated bounded iterator avoids altering defaults on a shared scraper.
  const results=[];
  for await(const row of scraper.searchAllPages(filters,{limit:args.limit,maxPages:args.max_pages}))results.push(row);
  return project({count:results.length,results,coverage:scraper.lastCoverage});
}
export function createMcpServer(scraper:AvitoScraper):Server {
  const server=new Server({name:'trelio-avito-search',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{return {content:[{type:'text' as const,text:JSON.stringify({success:true,...await callTool(scraper,request.params.name,request.params.arguments??{})})}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({success:false,error:safeError(error)})}]};}
  });return server;
}
export async function startMcpServer(scraper:AvitoScraper):Promise<void> {
  const server=createMcpServer(scraper);
  const close=()=>{void Promise.allSettled([scraper.close(),server.close()]);};
  process.once('SIGINT',close);process.once('SIGTERM',close);process.stdin.once('end',close);
  await server.connect(new StdioServerTransport());
}
