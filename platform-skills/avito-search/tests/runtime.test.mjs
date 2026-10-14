import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AvitoReader, listingId, requestAllowed, normalizeSearch, boundedResult } from '../scripts/core.mjs';
import { parseArguments, requireIdentity, RequestDiscipline, assertResponse, createTransport, acquireRequestLock, withAnonymousBrowser, waitForAccess } from '../scripts/trelio-avito.mjs';
import { publicUrl } from '../scripts/vendor/avito-api.mjs';
import { parseSearchPage } from '../scripts/vendor/parsers.mjs';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const syntheticItem = (id = 123) => ({ item: { id, title: 'Тестовое объявление', price: 1500,
  formattedPrice: { isHasValue: true, formatedString: '1 500 ₽' }, description: '<p>Описание &amp; комплект</p>',
  isActive: true, address: 'Тестовый адрес', imageUrls: [{ '1280x960': 'https://01.img.avito.st/image.jpg' }] },
  paramsBlock: { items: [{ title: 'Состояние', description: 'Новое' }] }, seller: { name: 'Тестовый продавец' } });
const html = item => `window.__staticRouterHydrationData=JSON.parse(${JSON.stringify(JSON.stringify({loaderData:{'catalog-or-main-or-item':{buyerItem:item}}}))})`;
const searchPage = { totalCount: 1, catalog: { items: [{ type: 'item', id: 123, title: 'Тестовое объявление',
  priceDetailed: { hasValue: true, value: 1500, fullString: '1 500 ₽' }, urlPath: '/moskva/test/test_123', locationId: 637640 }] } };
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-avito-test-'));
const errorCode = code => error => error.code === code;

test('one public search supports arbitrary listing subjects and opens the exact returned item', async () => {
  const calls = [];
  const reader = new AvitoReader({ json: async url => { calls.push(url); return searchPage; },
    html: async url => { calls.push(url); return { url, text: html(syntheticItem()) }; } });
  const result = await reader.search({ query: 'ремонт инструмента', priceMax: 2000, open: 1 });
  assert.equal(result.items[0].id, 123); assert.equal(result.opened[0].description, 'Описание & комплект');
  assert.equal(result.opened[0].price, 1500); assert.equal(result.untrustedContent, true);
  assert.equal(calls.length, 2); assert.equal(new URL(calls[0]).searchParams.get('pmax'), '2000');
  assert.equal(calls[1], 'https://www.avito.ru/123');
});

test('canonical URL and ID select only a safe numeric listing', () => {
  assert.equal(listingId('https://www.avito.ru/moskva/test/test_123?context=test'), 123);
  assert.equal(listingId('123'), 123);
  for (const input of ['0', '-1', '9007199254740992', 'https://evil.test/a/b/c_123', 'https://www.avito.ru:8443/a/b/c_123',
    'https://username@www.avito.ru/a/b/c_123', 'http://www.avito.ru/123', 'https://www.avito.ru/profile', 'file:///123']) {
    assert.throws(() => listingId(input), errorCode('INVALID_ITEM'));
  }
});

test('network targets reject account pages, credentials, ports and external redirects', () => {
  assert.equal(requestAllowed('https://www.avito.ru/web/1/js/items?query=test'), true);
  for (const input of ['https://www.avito.ru/profile', 'https://127.0.0.1/', 'https://evil.test/',
    'https://username@www.avito.ru/', 'https://www.avito.ru:8443/']) assert.equal(requestAllowed(input), false);
});

test('invalid input never reaches the transport', async () => {
  let calls = 0;
  const reader = new AvitoReader({json:()=>{calls++;}});
  for (const input of [{query:''}, {query:4}, {query:'test',priceMin:20,priceMax:10}, {query:'test',limit:200},
    {query:'test',open:4}, {query:'test',page:0}, {query:'test',category:'services'}, {query:'test',location:'Moscow'}]) {
    await assert.rejects(reader.search(input), errorCode('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
  assert.throws(()=>parseArguments(['search','--query','test','--endpoint','https://evil.test']),errorCode('INVALID_INPUT'));
  assert.throws(()=>parseArguments(['search','--query','test','--query','other']),errorCode('INVALID_INPUT'));
  assert.throws(()=>requireIdentity({TRELIO_SKILL_ID:'another'}),errorCode('HOST_BINDING_REQUIRED'));
  assert.equal(normalizeSearch({query:'test'}).location,'Москва');
});

test('a similar location suggestion cannot silently replace the requested city', async () => {
  let calls = 0;
  const reader = new AvitoReader({json:async()=>{calls++; return {result:{locations:[{id:1,names:{1:'Другой город'}}]}};}});
  await assert.rejects(reader.search({query:'test',location:'Казань'}), errorCode('LOCATION_NOT_FOUND'));
  assert.equal(calls,1);
});

test('missing prices and closed items are preserved; a wrong item ID fails closed', async () => {
  const item = syntheticItem(); item.item.formattedPrice.isHasValue=false; item.item.isExpired=true;
  const reader = new AvitoReader({html:async url=>({url,text:html(item)})});
  const result=await reader.item('123'); assert.equal(result.price,null); assert.equal(result.active,false);
  await assert.rejects(reader.item('124'),errorCode('AVITO_RESPONSE_INVALID'));
  await assert.rejects(new AvitoReader({html:async url=>({url,text:'<script>throw new Error()</script>'})}).item('123'),errorCode('AVITO_RESPONSE_INVALID'));
});

test('oversized model-visible text is explicitly bounded', () => {
  const result=boundedResult({description:'x'.repeat(18000),images:Array(60).fill('https://avito.st/test')});
  assert.equal(result.description.length,16000); assert.equal(result.images.length,40); assert.equal(result.contentTruncated,true);
});

test('429 and HTTP-200 firewall responses persist cooldown across CLI instances', async () => {
  const root=temporary(); let now=100000; const waits=[];
  try {
    const discipline=new RequestDiscipline(root,{now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;}});
    await discipline.slot(); await discipline.slot(); assert.equal(waits[1],5000);
    assert.throws(()=>assertResponse({status:429,url:'https://www.avito.ru/',text:'private block text'},discipline),errorCode('AVITO_RATE_LIMITED'));
    const reopened=new RequestDiscipline(root,{now:()=>now,wait:async()=>assert.fail('cooldown must not dispatch')});
    await assert.rejects(reopened.slot(),errorCode('AVITO_RATE_LIMITED'));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root,'request-state.json'),'utf8'))).sort(),['blockedUntil','lastRequestAt']);
    now+=1200001;
    await new RequestDiscipline(root,{now:()=>now,wait:async()=>{}}).slot();
    assert.throws(()=>assertResponse({status:200,url:'https://www.avito.ru/',text:'<div class="firewall-container">'},discipline),errorCode('AVITO_RATE_LIMITED'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('challenge, missing item and invalid redirects remain distinct failures', () => {
  const discipline={block:()=>assert.fail('only rate limits start cooldown')};
  for(const [status,code] of [[439,'AVITO_BLOCKED'],[403,'AVITO_BLOCKED'],[404,'ITEM_NOT_FOUND'],[503,'REQUEST_FAILED']])
    assert.throws(()=>assertResponse({status,url:'https://www.avito.ru/123',text:''},discipline),errorCode(code));
  assert.throws(()=>assertResponse({status:200,url:'https://evil.test/',text:''},discipline),errorCode('AVITO_RESPONSE_INVALID'));
});

test('transport decodes the actual streamed fetch response and never leaks raw browser errors', async () => {
  const previous=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify(searchPage),{status:200});
    const page={evaluate:async (fn,arg)=>{const response=await fn(arg);response.url=arg.url;return response;}};
    const transport=createTransport(page,{slot:async()=>{},block:()=>assert.fail()});
    assert.equal((await transport.json('https://www.avito.ru/web/1/js/items')).totalCount,1);
    await assert.rejects(createTransport({evaluate:()=>{throw new Error('private-cookie-value');}},{slot:async()=>{}}).json('https://www.avito.ru/web/1/js/items'), error=>error.code==='REQUEST_FAILED' && !error.message.includes('private-cookie-value'));
  } finally {globalThis.fetch=previous;}
});

test('concurrent commands cannot share the device request slot', () => {
  const root=temporary();
  try {
    const release=acquireRequestLock(root);
    assert.throws(()=>acquireRequestLock(root),errorCode('AVITO_BUSY'));
    release(); const next=acquireRequestLock(root);next();
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('signed package is deterministic and includes upstream MIT attribution and ephemeral host binding', () => {
  const first=buildRuntimePackage(directory);const second=buildRuntimePackage(directory);
  assert.equal(first.packageSha256,second.packageSha256);
  assert.equal(first.manifest.browserSession.sessionClass,'delegated-ephemeral');
  assert.ok(first.manifest.files.some(file=>file.path==='vendor/avito-shopping-mcp-LICENSE.txt'));
  assert.ok(first.manifest.files.some(file=>file.path==='core.mjs'));
  const help=spawnSync(process.execPath,[path.join(directory,'scripts','trelio-avito.mjs'),'help'],{encoding:'utf8'});
  assert.equal(help.status,0); assert.equal(JSON.parse(help.stdout).readOnly,true);
});

test('anonymous browser cleanup and pre-network routing guard use the real lifecycle', async () => {
  let closed=0;let routeHandler;
  const page={goto:async()=>({status:()=>200}),url:()=> 'https://www.avito.ru/',title:async()=> 'Авито'};
  const browser={newContext:async()=>({route:async(pattern,handler)=>{routeHandler=handler;},newPage:async()=>page}),close:async()=>{closed++;}};
  const host={readBrowserSessionBinding:({expectedSessionClass})=>{assert.equal(expectedSessionClass,'delegated-ephemeral');return {deadlineAt:Date.now()+60000};},
    loadPlaywright:()=>({chromium:{launch:async()=>browser}}),defaultBrowserExecutable:()=> '/synthetic/browser'};
  const discipline={state:{blockedUntil:0},slot:async()=>{}};
  await assert.rejects(withAnonymousBrowser(host,false,discipline,async()=>{throw new Error('synthetic_read_failed');}),/synthetic_read_failed/u);
  assert.equal(closed,1);
  let aborted=0;let continued=0;
  const route=url=>({request:()=>({url:()=>url,method:()=> 'GET',isNavigationRequest:()=>true,resourceType:()=> 'document'}),abort:async()=>{aborted++;},continue:async()=>{continued++;}});
  await routeHandler(route('https://www.avito.ru/profile'));await routeHandler(route('https://127.0.0.1/'));await routeHandler(route('https://www.avito.ru/123'));
  assert.equal(aborted,2);assert.equal(continued,1);
});

test('only a new successful main document resumes manual access; observers are removed', async () => {
  const frame={};let observer;let waits=0;let saves=0;let detached=false;
  const page={on:(name,handler)=>{observer=handler;},off:()=>{detached=true;},mainFrame:()=>frame,
    waitForEvent:async()=>{waits++; observer({status:()=>waits===1?439:200,request:()=>({isNavigationRequest:()=>true,frame:()=>frame})});},
    url:()=> 'https://www.avito.ru/',title:async()=> 'Авито',isClosed:()=>false};
  const discipline={state:{blockedUntil:999},save:()=>{saves++;}};
  await waitForAccess(page,discipline,Date.now()+1000,429);
  assert.equal(waits,2);assert.equal(saves,1);assert.equal(discipline.state.blockedUntil,0);assert.equal(detached,true);
});

test('an exited CLI owner is reclaimed without clearing rate-limit evidence', () => {
  const root=temporary();
  try {
    const moduleUrl=new URL('../scripts/trelio-avito.mjs',import.meta.url).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {acquireRequestLock} from ${JSON.stringify(moduleUrl)}; acquireRequestLock(process.argv[1]);`,root],{encoding:'utf8'});
    assert.equal(child.status,0);
    const discipline=new RequestDiscipline(root);discipline.block();
    const before=fs.readFileSync(path.join(root,'request-state.json'),'utf8');
    const release=acquireRequestLock(root);release();
    assert.equal(fs.readFileSync(path.join(root,'request-state.json'),'utf8'),before);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('public URL hardening and malformed dates do not invent trusted data', () => {
  assert.equal(publicUrl('https://name:password@www.avito.ru/test'),null);
  assert.equal(publicUrl('https://www.avito.ru:8443/test'),null);
  const data=structuredClone(searchPage);data.catalog.items[0].sortTimeStamp=Number.MAX_SAFE_INTEGER;
  assert.equal(parseSearchPage(data,{id:637640,name:'Москва'}).items[0].publishedAt,null);
  const result=boundedResult({values:Array(40).fill('😀'.repeat(2000))});
  assert.ok(Buffer.byteLength(result.values.join(''))<=64000);assert.equal(result.contentTruncated,true);
  assert.ok(result.values.every(value=>!/[\uD800-\uDBFF]$/u.test(value)));
});
