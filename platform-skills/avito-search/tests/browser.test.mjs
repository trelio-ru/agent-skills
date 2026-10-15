/** Real Chromium, loopback fixtures only. No Avito navigation, interception,
 * DNS request or alternate browsing surface is used by this suite. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),{AvitoParser}=require('../dist/trelio-avito.cjs');
const html=`<!doctype html><meta charset="utf-8"><title>Local parser fixture</title>
<div data-marker="item" data-item-id="incorrect"><a itemprop="url" href="/moskva/test/ssd_123456789"><h3 itemprop="name">SSD</h3></a>
<meta itemprop="price" content="12000"><span data-marker="item-price">от 12 000 ₽</span><span data-geo-name>Fixture city</span><div class="description">Fixture description</div></div>
<div data-marker="item"><a itemprop="url" href="/moskva/test/ssd_987654321"><h3 itemprop="name">No fixed price</h3></a><span data-marker="item-price">Договорная</span></div>
<div data-marker="item"><a itemprop="url" href="https://www.avito.ru.evil.invalid/a_123"><h3 itemprop="name">External</h3></a></div>
<div data-marker="item"><a itemprop="url" href="/moskva/test/ssd_123456789"><h3 itemprop="name">Duplicate</h3></a></div>
<h1 data-marker="item-view/title-info">Fixture detail</h1><div itemprop="description">Full fixture description</div>
<div data-marker="seller-info/name">Synthetic seller</div><div data-marker="seller-info/rating">4,8</div>
<ul data-marker="item-view/item-params"><li>Состояние: Новое</li></ul><div data-marker="item-view/total-views">12 просмотров</div>
<div data-marker="image-frame/image-wrapper"><img src="/fixture.png"></div><div id="captcha" hidden>Hidden widget</div>`;
test('actual DOM parser preserves price semantics, detail fields and IDs on a local document',async()=>{
  const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    browser=await chromium.launch({headless:true});const context=await browser.newContext();
    const observed=[];
    await context.route('**/*',route=>{observed.push(route.request().url());return route.request().url().startsWith(origin+'/')?route.continue():route.abort();});
    const page=await context.newPage();await page.goto(origin);const parser=new AvitoParser();
    const rows=await parser.parseSearchResults(page);assert.equal(rows.length,2);
    assert.equal(rows[0].id,'123456789');assert.equal(rows[0].price,12000);assert.equal(rows[0].priceText,'от 12 000 ₽');
    assert.equal(rows[1].price,null);assert.equal(rows[1].priceText,'Договорная');
    assert.equal(await parser.detectCaptcha(page),false);
    // Only the URL metadata is synthetic; Chromium remains on loopback.
    const details=await parser.parseItemDetails({evaluate:fn=>page.evaluate(fn),url:()=> 'https://www.avito.ru/moskva/test/ssd_123456789'});
    assert.equal(details.seller.rating,4.8);assert.equal(details.specifications['Состояние'],'Новое');assert.equal(details.viewsCount,12);
    assert.equal(details.fullDescription,'Full fixture description');assert.ok(observed.every(url=>url.startsWith(origin+'/')));
    assert.equal(page.url(),origin+'/');
    await page.locator('#captcha').evaluate(el=>el.hidden=false);assert.equal(await parser.detectCaptcha(page),true);
    await page.setContent('<div data-marker="search-results/no-results">Ничего не найдено</div>');
    assert.equal(await parser.waitForResults(page,100),false);
    await page.setContent('<p>Unknown document</p>');await assert.rejects(parser.waitForResults(page,100));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
