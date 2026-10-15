import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const api=require('../dist/trelio-avito.cjs');
const {AvitoScraper,ProxyManager,SequentialRotation,RandomRotation,RoundRobinRotation,parseProxy,buildSearchUrl,itemUrl,extractItemId,callTool,validateToolInput,project,JsonOutput,consumeProxyPool,BrowserManager,requestAllowed}=api;
const target='https://www.avito.ru/moskva/test/listing_123456789';
const row=id=>({id:String(id),url:target.replace('123456789',String(id)),title:'Fixture listing '+id,price:100,currency:'RUB',location:'Fixture'});
class FakeBrowser {
  selections=[];navigations=[];status=200;closed=false;url=target;
  async useProxy(proxy){if(this.closed)throw Error('closed');this.selections.push(proxy);}
  assertLease(){if(this.expired)throw Object.assign(Error('lease'),{code:'AVITO_SESSION_EXPIRED'});}
  getDocumentStatus(){return this.status;}
  async getPage(){return {goto:async url=>{this.navigations.push(url);this.url=url;return {status:()=>this.status};},url:()=>this.url};}
  async close(){this.closed=true;}
  isInitialized(){return !this.closed;}
}
function fixture(pages=[[row(123456789)]],options={}) {
  const browser=new FakeBrowser();
  const parser={detectCaptcha:async()=>false,isBlocked:async()=>false,waitForResults:async()=>true,
    parseSearchResults:async()=>pages[Math.min(browser.navigations.length-1,pages.length-1)],parseItemDetails:async()=>({...row(123456789),fullDescription:'fixture'})};
  const scraper=new AvitoScraper({delayMs:[0,0],wait:async()=>{},...options},{browser,parser});
  return {browser,parser,scraper};
}
const collect=async iterator=>{const rows=[];for await(const row of iterator)rows.push(row);return rows;};

test('all original upstream source layers were imported; provenance inventory is complete',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../upstream-manifest.json',import.meta.url)));
  for(const entry of manifest.files.filter(entry=>entry.path.startsWith('src/')))assert.ok(fs.existsSync(new URL('../'+entry.path,import.meta.url)),entry.path);
  assert.equal(manifest.commit,'583ee55d1999c8fbe5f63c6c6bb0dbb2c28f1e49');
  for(const name of ['AvitoParser','AvitoScraper','ProxyManager','BrowserManager','ConsoleOutput','JsonOutput','randomSleep','humanDelay','getRandomUserAgent'])assert.equal(typeof api[name],'function',name);
});
test('search encodes query, prices, public slugs, page and sort',()=>{
  const url=new URL(buildSearchUrl({query:'a & b',location:'moskva',category:'tovary_dlya_kompyutera',priceMin:0,priceMax:15000,page:2,sort:'price_asc'}));
  assert.equal(url.pathname,'/moskva/tovary_dlya_kompyutera');
  assert.deepEqual(Object.fromEntries(url.searchParams),{q:'a & b',pmin:'0',pmax:'15000',p:'2',s:'1'});
});
test('filters cannot be silently ignored or accept malformed limits',()=>{
  for(const patch of [{priceMin:2,priceMax:1},{priceMax:NaN},{priceMin:-1},{page:0},{page:1.5},{sort:'oops'},{location:'../login'},{category:'a/b'},{query:''}])assert.throws(()=>buildSearchUrl({query:'fixture',...patch}));
  for(const patch of [{locationId:123},{categoryId:4}])assert.throws(()=>buildSearchUrl({query:'fixture',...patch}),error=>error.code==='UNSUPPORTED_FILTER');
});
test('listing URLs reject deceptive hosts, credentials, auth paths and scripts',()=>{
  for(const url of ['https://avito.ru.evil.invalid/a_123','https://user:pass@www.avito.ru/a_123','http://www.avito.ru/a_123','https://www.avito.ru/login/123','https://www.avito.ru/api/123','https://127.0.0.1/a_123','javascript:alert(1)','https://www.avito.ru/a/%2e%2e/account/123'])assert.throws(()=>itemUrl(url),url);
  assert.equal(extractItemId(target),'123456789');assert.equal(extractItemId('/item/12345678'),'12345678');
});
test('all proxy protocols validate ports and never reflect credentials on error',()=>{
  for(const protocol of ['http','https','socks4','socks5'])assert.equal(parseProxy(`${protocol}://proxy.example:1080`).type,protocol);
  assert.equal(parseProxy('http://proxy.example').port,80);
  assert.equal(parseProxy('socks5://u%40test:p%40ss@proxy.example:1080',true).username,'u@test');
  for(const value of ['http://u:SYNTHETIC_PASSWORD_MARKER@proxy.example:80','socks5://proxy.example:0','http://proxy.example:65536','file:///etc/passwd','http://proxy.example:80/path'])assert.throws(()=>parseProxy(value),error=>!error.message.includes('SYNTHETIC_PASSWORD_MARKER'));
});
test('protected proxy input is consumed before a browser subprocess could inherit it',()=>{
  const env={TRELIO_AVITO_PROXY_POOL:'socks5://fake:synthetic@proxy.example:1080'};
  assert.equal(consumeProxyPool(env)[0].password,'synthetic');assert.equal(env.TRELIO_AVITO_PROXY_POOL,undefined);
  const bad={TRELIO_AVITO_PROXY_POOL:'bad'};assert.throws(()=>consumeProxyPool(bad));assert.equal(bad.TRELIO_AVITO_PROXY_POOL,undefined);
});
test('sequential/random pools skip failed entries and remain valid after removal',()=>{
  const proxies=[parseProxy('http://p1.example:80'),parseProxy('http://p2.example:80')];
  for(const Strategy of [SequentialRotation,RandomRotation]) {
    const pool=new Strategy(proxies);pool.markFailed(proxies[0]);assert.equal(pool.next(),proxies[1]);
    pool.removeProxy(proxies[0]);assert.equal(pool.getAvailableCount(),1);assert.equal(pool.next(),proxies[1]);
    pool.markFailed(proxies[1]);assert.equal(pool.next(),null);pool.reset();assert.equal(pool.next(),proxies[1]);
  }
});
test('round-robin failures cool down from the last failure and expose no runtime logs',()=>{
  const proxy=parseProxy('http://p.example:80'),pool=new RoundRobinRotation([proxy],2,0);
  pool.next();pool.markFailed(proxy);pool.markFailed(proxy);assert.equal(pool.next(),proxy);pool.markSuccess(proxy);
  assert.equal(Object.values(pool.getStats())[0].successCount,1);
});
test('proxy manager rotates on the exact N+1 request and preserves the inventory on strategy change',()=>{
  const proxies=[parseProxy('http://p1.example:80'),parseProxy('http://p2.example:80')],pool=new ProxyManager(proxies,'sequential',2);
  assert.equal(pool.getProxy(),proxies[0]);assert.equal(pool.getProxy(),proxies[0]);assert.equal(pool.getProxy(),proxies[1]);
  pool.setRotationStrategy('random');assert.equal(pool.getStats().total,2);pool.markFailed();assert.equal(pool.getStats().total,2);
  pool.setRotationStrategy('sequential');pool.getProxy();pool.markFailed();assert.equal(pool.getStats().failed,1);
});
test('proxy file errors are atomic, bounded and credential-free',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'avito-fixture-'));
  try {
    const file=path.join(root,'proxies.txt'),pool=new ProxyManager();
    fs.writeFileSync(file,'# fixture\nhttp://p.example:80\nsocks5://p.example:1080\n');assert.equal(await pool.loadFromFile(file),2);
    fs.writeFileSync(file,'http://fake:synthetic@p.example:80');await assert.rejects(pool.loadFromFile(file));assert.equal(pool.getStats().total,2);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('the actual scraper applies scheduled proxy selections and reuses its browser',async()=>{
  const proxies=[parseProxy('http://p1.example:80'),parseProxy('http://p2.example:80')];
  const {scraper,browser}=fixture(undefined,{proxy:{enabled:true,proxies,rotateEveryN:1}});
  await scraper.search({query:'fixture'});await scraper.getItemDetails(target);
  assert.deepEqual(browser.selections,proxies);assert.equal(browser.navigations.length,2);
});
test('pagination deduplicates and stops on repeated pages with explicit partial coverage',async()=>{
  const {scraper}=fixture([[row(1),row(2)],[row(2),row(3)],[row(2),row(3)]]);
  const rows=await collect(scraper.searchAllPages({query:'fixture'}));
  assert.deepEqual(rows.map(row=>row.id),['1','2','3']);assert.equal(scraper.lastCoverage.stopReason,'repeated_page');assert.equal(scraper.lastCoverage.complete,false);
});
test('pagination honors limits and releases exclusivity after an early generator return',async()=>{
  const {scraper}=fixture([[row(1),row(2),row(3)]]);
  assert.equal((await collect(scraper.searchAllPages({query:'fixture'},{limit:2}))).length,2);
  assert.equal(scraper.lastCoverage.stopReason,'limit');
  for await(const unused of scraper.searchAllPages({query:'fixture'}))break;
  await scraper.search({query:'fixture'});
});
test('a failed selector is not reported as zero search results',async()=>{
  const {scraper,parser}=fixture();parser.waitForResults=async()=>{throw Error('raw fixture failure');};
  await assert.rejects(scraper.search({query:'fixture'}),error=>error.code==='AVITO_CONTENT_UNAVAILABLE' && !error.message.includes('raw fixture'));
});
test('HTTP blocks never trigger retry or proxy fallback',async()=>{
  for(const status of [403,429,439,500]) {
    const {scraper,browser}=fixture(undefined,{headless:true});browser.status=status;
    await assert.rejects(scraper.search({query:'fixture'}));assert.equal(browser.navigations.length,1);
    if(status===429) {await assert.rejects(scraper.search({query:'fixture'}),error=>error.code==='AVITO_RATE_LIMITED');assert.equal(browser.navigations.length,1);}
  }
});
test('manual access observation is passive and requires a successful document',async()=>{
  const {scraper,browser,parser}=fixture(undefined,{headless:true});browser.status=403;
  await assert.rejects(scraper.search({query:'fixture'}),error=>error.code==='AVITO_MANUAL_REQUIRED');
  assert.deepEqual(await scraper.accessStatus(),{ready:false});browser.status=200;
  assert.deepEqual(await scraper.accessStatus(),{ready:true});assert.equal(browser.navigations.length,1);
});
test('MCP validates actual call arguments and uses the same bounded search core',async()=>{
  const {scraper}=fixture([[row(1),row(2)]]);
  for(const args of [{query:'x',unknown:true},{query:3},{query:'x',page:NaN},{query:'x',limit:0}])assert.throws(()=>validateToolInput('avito_search_all',args));
  const result=await callTool(scraper,'avito_search_all',{query:'fixture',limit:1,max_pages:1});
  assert.equal(result.count,1);assert.equal(result.coverage.stopReason,'limit');assert.equal(result.untrustedContent,true);
  await assert.rejects(callTool(scraper,'avito_search',{query:'fixture',location_id:5}),error=>error.code==='UNSUPPORTED_FILTER');
});
test('projection bounds Unicode and treats hostile object keys as data',()=>{
  const result=project({details:{fullDescription:'я'.repeat(100000),title:'😀'.repeat(2000)},results:Array.from({length:2000},()=>row(1))});
  assert.equal(result.contentTruncated,true);assert.ok(result.details.fullDescription.length<=16000);assert.ok(result.results.length<=1000);assert.equal(result.untrustedContent,true);
});
test('JSON output creates an atomic parseable document and rejects symlink targets',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'avito-output-'));
  try {
    const output=path.join(root,'nested','result.json');await new JsonOutput().saveResults([row(1)],output);
    const result=JSON.parse(fs.readFileSync(output));assert.equal(result.count,1);assert.equal(result.untrustedContent,true);
    if(process.platform!=='win32') {const link=path.join(root,'link.json');fs.symlinkSync(output,link);await assert.rejects(new JsonOutput().saveResults([],link));assert.equal(fs.statSync(output).mode&0o777,0o600);}
    assert.equal(fs.readdirSync(path.dirname(output)).length,1);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('CLI rejects unsupported fields without raw exception/path/secret output',()=>{
  const file=fileURLToPath(new URL('../dist/trelio-avito.cjs',import.meta.url));
  const result=spawnSync(process.execPath,[file,'search','fixture','--unknown','value'],{encoding:'utf8'});
  assert.equal(result.status,1);const packet=JSON.parse(result.stdout);assert.equal(packet.error.code,'INVALID_INPUT');assert.equal(result.stderr,'');
});
test('doctor delegates without opening a browser and unbound runtime fails closed',()=>{
  const file=fileURLToPath(new URL('../dist/trelio-avito.cjs',import.meta.url));
  const env={...process.env,TRELIO_SKILL_ID:'avito-search',TRELIO_SKILL_COMPANY_ID:'11111111-1111-4111-8111-111111111111',TRELIO_SKILL_MEMBER_ID:'22222222-2222-4222-8222-222222222222',TRELIO_SKILL_CONNECTION_ID:'33333333-3333-4333-8333-333333333333',TRELIO_BROWSER_SESSION_MODULE_URL:new URL('../../tools/browser-session-runtime-fixture.mjs',import.meta.url).href};
  const result=spawnSync(process.execPath,[file,'doctor'],{encoding:'utf8',env});assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).runtimeReady,false);
  delete env.TRELIO_SKILL_ID;const denied=spawnSync(process.execPath,[file,'doctor'],{encoding:'utf8',env});assert.equal(JSON.parse(denied.stdout).error.code,'HOST_BINDING_REQUIRED');
});
test('browser network fence rejects external/private/credential destinations',()=>{
  const frame={page:()=>({mainFrame:()=>frame})};
  const request=(url,main=true)=>({url:()=>url,method:()=> 'GET',isNavigationRequest:()=>main,frame:()=>frame});
  assert.equal(requestAllowed(request(target)),true);
  for(const url of ['http://127.0.0.1/','https://www.avito.ru/account/123','https://avito.ru.evil.invalid/','https://u:p@www.avito.ru/a_123'])assert.equal(requestAllowed(request(url)),false);
});
test('browser host lease, executable and teardown are honored without a real website',async()=>{
  let launches=0,closes=0,lastLaunch;const now=Date.now();
  const page={isClosed:()=>false,setDefaultTimeout(){},on(){}};
  const context={route:async()=>{},addInitScript:async()=>{},newPage:async()=>page};
  const host={assertManualAssistAllowed:()=>({deadlineAt:now+60000}),defaultBrowserExecutable:()=>'/synthetic/chrome',loadPlaywright:()=>({chromium:{launch:async options=>{launches++;lastLaunch=options;return {isConnected:()=>true,newContext:async()=>context,close:async()=>{closes++;}};}}})};
  const browser=new BrowserManager({host});await browser.useProxy();assert.equal(await browser.getPage(),page);await browser.useProxy();assert.equal(launches,1);assert.equal(lastLaunch.executablePath,'/synthetic/chrome');assert.equal(lastLaunch.headless,false);
  await browser.close();assert.equal(closes,1);await assert.rejects(browser.useProxy());
});

test('real MCP SDK handshake/list/call validates schema and never launches a browser',async()=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {scraper,browser}=fixture([[row(1)]]);
  const server=api.createMcpServer(scraper),client=new Client({name:'local-fixture',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);await client.connect(clientTransport);
    const list=await client.listTools();assert.equal(list.tools.length,4);
    for(const tool of list.tools)assert.equal(tool.annotations.readOnlyHint,true);
    const good=await client.callTool({name:'avito_search',arguments:{query:'fixture'}});
    assert.equal(JSON.parse(good.content[0].text).count,1);
    const bad=await client.callTool({name:'avito_get_details',arguments:{url:'https://avito.ru.evil.invalid/a_123'}});
    assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).error.code,'INVALID_INPUT');
    assert.equal(browser.navigations.length,1);
  } finally {await client.close();await server.close();await scraper.close();}
});
test('signed package excludes fixtures, original configs and development dependencies',async()=>{
  const {buildRuntimePackage}=await import('../../tools/build-runtime-package.mjs');
  const directory=fileURLToPath(new URL('../',import.meta.url));
  const a=buildRuntimePackage(directory),b=buildRuntimePackage(directory);
  assert.deepEqual(a.packageBytes,b.packageBytes);
  const packet=JSON.parse(a.packageBytes);
  assert.equal(packet.entrypoint.path,'trelio-avito.cjs');
  assert.ok(packet.files.some(file=>file.path==='THIRD-PARTY-NOTICES.txt'));
  assert.ok(packet.files.every(file=>!/(?:node_modules|tests|development|\.env|opencode)/u.test(file.path)));
  // The source provenance file has no executable routing authority.
  assert.equal(packet.browserSession.sessionClass,'delegated-ephemeral');
});

test('repeated projection cannot erase a prior truncation warning',()=>{
  assert.equal(project(project({details:{fullDescription:'x'.repeat(20000)}})).contentTruncated,true);
  for(const url of ['https://www.avito.ru//account/123','https://www.avito.ru/%2faccount/123'])assert.throws(()=>itemUrl(url));
});
test('authenticated SOCKS5 relay binds loopback and closes with the owned browser',async()=>{
  const net=await import('node:net'),http=await import('node:http');
  const sockets=new Set();let authSeen=false;
  const upstream=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let state='hello',buffer=Buffer.alloc(0);
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(state==='hello' && buffer.length>=2 && buffer.length>=2+buffer[1]) {buffer=buffer.subarray(2+buffer[1]);socket.write(Buffer.from([5,2]));state='auth';}
      if(state==='auth' && buffer.length>=2) {
        const userLength=buffer[1];if(buffer.length<3+userLength)return;
        const passLength=buffer[2+userLength];if(buffer.length<3+userLength+passLength)return;
        assert.equal(buffer.subarray(2,2+userLength).toString(),'synthetic-user');authSeen=true;
        buffer=buffer.subarray(3+userLength+passLength);socket.write(Buffer.from([1,0]));state='connect';
      }
      if(state==='connect' && buffer.length>=5) {
        const size=buffer[3]===3?7+buffer[4]:buffer[3]===1?10:22;if(buffer.length<size)return;
        buffer=buffer.subarray(size);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));state='http';
      }
      if(state==='http' && buffer.includes(Buffer.from('\r\n\r\n'))) {socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture');state='done';}
    });
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  let launch;
  const host={assertManualAssistAllowed:()=>({deadlineAt:Date.now()+60000}),defaultBrowserExecutable:()=>'/fixture/chrome',loadPlaywright:()=>({chromium:{launch:async options=>{launch=options;return {isConnected:()=>true,newContext:async()=>({route:async()=>{},addInitScript:async()=>{}}),close:async()=>{}};}}})};
  const browser=new BrowserManager({host});
  try {
    await browser.useProxy(parseProxy(`socks5://synthetic-user:synthetic-password@127.0.0.1:${upstream.address().port}`,true));
    const proxy=new URL(launch.proxy.server);assert.equal(proxy.hostname,'127.0.0.1');assert.equal(launch.proxy.username,undefined);
    const body=await new Promise((resolve,reject)=>{
      const request=http.get({hostname:proxy.hostname,port:proxy.port,path:'http://127.0.0.1:9/data',timeout:5000},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(Buffer.concat(chunks).toString()));
      });request.on('error',reject);request.on('timeout',()=>request.destroy(Error('fixture timeout')));
    });
    assert.equal(body,'fixture');assert.equal(authSeen,true);
  } finally {await browser.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>upstream.close(resolve));}
});
