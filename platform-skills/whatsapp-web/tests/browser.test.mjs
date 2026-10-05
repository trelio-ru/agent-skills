import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { WhatsAppBrowser } from '../scripts/browser.mjs';
import { parseArguments } from '../scripts/trelio-whatsapp.mjs';
import { ensurePrivateDirectory, nativeHelper } from '../scripts/native.mjs';

test('browser mode is explicit and does not silently replace the protocol session',()=>{
  assert.equal(parseArguments(['start','--mode','browser']).options['--mode'],'browser');
  assert.throws(()=>parseArguments(['start','--mode','automatic']),/unsupported_mode/);
  assert.throws(()=>parseArguments(['request','--mode','browser']),/unsupported_option/);
  assert.equal(parseArguments(['start','--mode','browser','--headless']).options['--headless'],true);
  assert.throws(()=>parseArguments(['start','--headless']),/headless_requires_browser_mode/);
  assert.equal(parseArguments(['doctor','--mode','browser']).options['--mode'],'browser');
  assert.equal(parseArguments(['bootstrap','--mode','browser']).options['--mode'],'browser');
});
test('browser policy cannot retain or create a sending allowance for another conversation',async()=>{
  const client=new WhatsAppBrowser({context:{},permit:async()=>{},persist:async()=>{},saved:{schema:2,transport:'browser',policy:'autonomous',attempts:{}}});
  assert.equal((await client.execute({command:'policy'})).policy,'confirm');
  await assert.rejects(client.execute({command:'policy',mode:'autonomous',confirm:true}),/policy_confirmation_required/);client.close();
});

test('headed browser observations, input and journal preserve UI and login boundaries', {skip:!['darwin','win32'].includes(process.platform),timeout:60000},async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'wa-browser-fixture-'));
  const helper=await nativeHelper(root),directory=path.join(root,'output');
  await ensurePrivateDirectory(directory,helper);
  const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':'chrome',headless:false});
  const context=await browser.newContext({viewport:{width:900,height:700}});
  await context.route('https://web.whatsapp.com/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body>
    <aside id="pane-side">Synthetic chat list</aside><main id="main"><h1>Fixture chat</h1>
    <input aria-label="Message"><button id="send" onclick="document.querySelector('#messages').textContent=document.querySelector('input').value">Send</button>
    <p id="messages"></p><a href="https://example.com/">External link</a><input type="file" accept="image/*" hidden>
    </main></body></html>`}));
  const saved=[],phases=[],failures=[];
  const client=new WhatsAppBrowser({context,helper,permit:async()=>{},persist:async text=>saved.push(JSON.parse(text)),
    onPhase:phase=>phases.push(phase),onFatal:code=>failures.push(code)});
  try {
    await client.connect();assert.equal(client.connected,true);assert.equal(phases.at(-1),'ready');
    const snapshot=await client.execute({command:'browser-snapshot',output:path.join(directory,'first.png')});
    if(process.platform!=='win32')assert.equal((await fs.stat(snapshot.output)).mode&0o077,0);
    const input=snapshot.controls.find(row=>row.label==='Message');assert.ok(input);
    const packet={command:'browser-type',snapshotId:snapshot.snapshotId,ref:input.ref,text:'Synthetic message',requestId:randomUUID()};
    await assert.rejects(client.execute(packet),/exact_approval_required/);
    const preview=await client.execute({...packet,dryRun:true});
    assert.equal((await client.execute({...packet,confirm:true,approvalHash:preview.approvalHash})).state,'applied');
    assert.equal(await client.page.locator('input[aria-label="Message"]').inputValue(),'Synthetic message');
    const next=await client.execute({command:'browser-snapshot',output:path.join(directory,'second.png')});
    const send=next.controls.find(row=>row.label==='Send');
    const click={command:'browser-click',snapshotId:next.snapshotId,x:Math.round(send.box.x+send.box.width/2),y:Math.round(send.box.y+send.box.height/2),requestId:randomUUID()};
    const clickPreview=await client.execute({...click,dryRun:true});await client.execute({...click,confirm:true,approvalHash:clickPreview.approvalHash});
    assert.equal(await client.page.locator('#messages').innerText(),'Synthetic message');
    assert.equal((await client.execute({command:'result',requestId:click.requestId})).verified,false);
    assert.ok(saved.length>=5);assert.equal(saved.at(-1).transport,'browser');assert.equal(saved.at(-1).wasAuthenticated,true);
    assert.equal(saved.at(-1).auth,undefined);

    const positioned=await client.execute({command:'browser-snapshot',output:path.join(directory,'positioned.png')});
    await client.page.locator('#send').evaluate(node=>node.style.transform='translateY(25px)');
    await assert.rejects(client.execute({command:'browser-click',snapshotId:positioned.snapshotId,x:10,y:10,requestId:randomUUID(),dryRun:true}),/browser_snapshot_changed/);

    await client.page.locator('#pane-side').evaluate(node=>node.style.display='none');
    assert.equal(await client.authState(),'browser_loading');
    await client.page.locator('#pane-side').evaluate(node=>node.style.display='');
    assert.equal(await client.authState(),'ready');
    const before=await client.execute({command:'browser-snapshot',output:path.join(directory,'before-qr.png')});
    await client.page.evaluate(()=>{const qr=document.createElement('div');qr.dataset.ref='SYNTHETIC_AUTH_VALUE';qr.textContent='Login fixture';document.body.append(qr);});
    assert.equal(await client.authState(),'browser_login_required');
    await assert.rejects(client.execute({command:'browser-snapshot',output:path.join(directory,'forbidden.png')}),/browser_login_or_sensitive_page/);
    await assert.rejects(fs.stat(path.join(directory,'forbidden.png')),/ENOENT/);
    await assert.rejects(client.execute({command:'browser-click',snapshotId:before.snapshotId,x:10,y:10,requestId:randomUUID(),dryRun:true}),/browser_login_or_sensitive_page/);
    await client.page.locator('[data-ref]').evaluate(node=>node.remove());
    await client.execute({command:'policy',mode:'read-only',confirm:true});
    const readOnly=await client.execute({command:'browser-snapshot',output:path.join(directory,'readonly.png')});
    await assert.rejects(client.execute({command:'browser-click',snapshotId:readOnly.snapshotId,x:10,y:10,requestId:randomUUID(),dryRun:true}),/read_only_policy/);
    await client.beforeClose();client.close();
    assert.deepEqual(failures,[]);
  } finally {client.close();await context.close();await browser.close();await fs.rm(root,{recursive:true});}
});
