import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { addPhotoDownloadReferences, visibleMessages, findPhotoDownloadTarget,
  downloadPhotoAttachment, photoSourceDigest, parseArguments, validateCommandOptions } from '../scripts/trelio-max.mjs';

const identity = { TRELIO_SKILL_ID:'max-web', TRELIO_SKILL_RUNTIME_VERSION:'2.13.1',
  TRELIO_SKILL_COMPANY_ID:'11111111-1111-4111-8111-111111111111',
  TRELIO_SKILL_MEMBER_ID:'22222222-2222-4222-8222-222222222222',
  TRELIO_SKILL_CONNECTION_ID:'33333333-3333-4333-8333-333333333333' };
const options = () => parseArguments(['download','--chat','https://web.max.ru/123',
  '--attachment-ref',`max-photo/v1.${'a'.repeat(64)}`,'--output',path.join(os.tmpdir(),'synthetic-photo.jpg')],identity);
const source = id => `https://i.oneme.ru/i?r=synthetic-${id}&expires=123`;
const photo = id => `<button class="tile"><img class="image" src="${source(id)}"></button>`;
const bubble = (...ids) => `<div class="messageWrapper">${ids.map(photo).join('')}<span class="meta">10:15</span></div>`;
const jpeg = Buffer.from([255,216,255,224,0,10,1,2,3,4,255,217]);

// Execute the actual DOM callbacks in an isolated realm. Only browser transport
// and clicks are simulated; lookup/ref hashing, viewer verification and the
// production atomic save/transfer all run unchanged.
const fixture = (html, { wrongViewer=false, replaceOnTransfer=false }={}) => {
  const {window,document}=parseHTML(`<html><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect=()=>({width:300,height:60,right:900});
  const realm=vm.createContext({document,window:{location:{href:'https://web.max.ru/123'},innerWidth:1280,
    getComputedStyle:()=>({display:'block',visibility:'visible'})},URL,HTMLElement:window.HTMLElement,HTMLAnchorElement:window.HTMLAnchorElement});
  const evaluate=async(fn,arg,node)=>{realm.fn=fn.toString();realm.argument=arg;realm.target=node;
    return JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(${node?'target, ':''}argument)`,realm))??'null');};
  const events=new Map(),log=[];
  const response = bytes => ({status:()=>200,headers:()=>({'content-type':'image/jpeg','content-length':String(bytes.length)}),body:async()=>bytes,dispose:async()=>{}});
  const context={request:{get:async(url,config)=>{assert.equal(config.maxRedirects,0);assert.equal(config.maxRetries,0);
    return response(Buffer.from(new URL(url).searchParams.get('r')));}},route:async()=>{},unroute:async()=>{},
    addInitScript:async()=>{if(replaceOnTransfer===true)document.querySelector('dialog img')?.setAttribute('src',source('changed'));
      if(replaceOnTransfer==='retained')document.querySelector('dialog')?.insertAdjacentHTML('beforeend',`<img src="${source('other')}">`);}};
  const wrap=selector=>({count:async()=>document.querySelectorAll(selector).length,
    getAttribute:async name=>document.querySelector(selector)?.getAttribute(name),
    evaluate:async(fn,arg)=>evaluate(fn,arg,document.querySelector(selector)),
    locator:xpath=>({click:async()=>{assert.match(xpath,/ancestor::button/);log.push('open-photo');
      const original=document.querySelector(selector).getAttribute('src');
      document.body.insertAdjacentHTML('beforeend',`<dialog open><img src="${wrongViewer?source('other'):original}"><button>Скачать</button></dialog>`);}}),
    getByRole:()=>({count:async()=>document.querySelectorAll(`${selector} button`).length,
      click:async()=>{log.push('download-photo');await events.get('download')({url:()=> 'blob:https://web.max.ru/synthetic',
        suggestedFilename:()=> 'photo.jpg',saveAs:async file=>fs.writeFileSync(file,jpeg)});}})});
  const page={document,context:()=>context,url:()=> 'https://web.max.ru/123',evaluate,
    locator:wrap,on:(name,fn)=>events.set(name,fn),off:name=>events.delete(name),
    waitForFunction:async(fn,arg)=>{if(!await evaluate(fn,arg))throw Error('Synthetic viewer timeout');}};
  return {page,log};
};
const read = async(page,opts=options())=>{const messages=await visibleMessages(page,100);
  const candidates=await addPhotoDownloadReferences(page,opts,messages);return {messages,candidates};};

test('MAX photo refs distinguish same-minute bubbles and each album image without provider IDs',async()=>{
 const {page}=fixture(bubble('first')+bubble('second','third'));
 const {messages,candidates}=await read(page);
 assert.equal(messages[0].messageKey,messages[1].messageKey);
 assert.equal(candidates.length,3);assert.equal(new Set(candidates.map(x=>x.downloadRef)).size,3);
 assert.equal(messages.flatMap(x=>x.attachments).filter(x=>x.downloadRef).length,3);
 assert.doesNotMatch(JSON.stringify(messages),/synthetic-|expires|i\.oneme/);
 const selected=await findPhotoDownloadTarget(page,{...options(),attachmentRef:candidates[2].downloadRef});
 assert.equal(selected.source,source('third'));
 // Provider signature refresh and preceding-message insertion preserve identity;
 // neither URL tokens nor the DOM position become the selector.
 page.document.querySelectorAll('img').forEach(n=>n.setAttribute('src',n.getAttribute('src').replace('expires=123','expires=456')));
 page.document.body.insertAdjacentHTML('afterbegin','<div class="messageWrapper">Earlier</div>');
 assert.equal((await findPhotoDownloadTarget(page,{...options(),attachmentRef:candidates[2].downloadRef})).source,source('third').replace('123','456'));
});

test('MAX photo refs refuse repeated images, changed bytes, other accounts/chats and decorative images',async()=>{
 const duplicate=fixture(bubble('same')+bubble('same'));
 const result=await read(duplicate.page);assert.equal(result.messages.some(m=>m.attachments.some(a=>a.downloadRef)),false);
 await assert.rejects(findPhotoDownloadTarget(duplicate.page,{...options(),attachmentRef:result.candidates[0].downloadRef}),{code:'MAX_PHOTO_REFERENCE_INVALID'});
 const {page}=fixture(bubble('original')+'<div class="messageWrapper"><img class="avatarImage" src="https://i.oneme.ru/i?r=avatar"></div>');
 const {candidates}=await read(page);assert.equal(candidates.length,1);
 const ref=candidates[0].downloadRef;
 for(const changed of [{memberId:'44444444-4444-4444-8444-444444444444'},{chat:'https://web.max.ru/456'}])
  await assert.rejects(findPhotoDownloadTarget(page,{...options(),...changed,attachmentRef:ref}),{code:'MAX_PHOTO_REFERENCE_INVALID'});
 page.document.querySelector('button.tile img').setAttribute('src',source('replacement'));
 await assert.rejects(findPhotoDownloadTarget(page,{...options(),attachmentRef:ref}),{code:'MAX_PHOTO_REFERENCE_INVALID'});
});

test('MAX photo download verifies the selected viewer and saves original bytes privately once',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'max-photo-test-'));
 try{
  const {page,log}=fixture(bubble('one')+bubble('two'));
  const {candidates}=await read(page);const output=path.join(directory,'saved.jpg');
  const result=await downloadPhotoAttachment(page,{...options(),attachmentRef:candidates[1].downloadRef,output});
  assert.equal(result.downloaded,true);assert.deepEqual(fs.readFileSync(output),jpeg);
  assert.equal(result.sizeBytes,jpeg.length);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(log,['open-photo','download-photo']);
  if(process.platform!=='win32')assert.equal(fs.statSync(output).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-|expires|i\.oneme/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('MAX photo download never clicks Download for a wrong or subsequently replaced viewer',async()=>{
 for(const config of [{wrongViewer:true},{replaceOnTransfer:true},{replaceOnTransfer:'retained'}]){
  const {page,log}=fixture(bubble('one'),config);const {candidates}=await read(page);
  await assert.rejects(downloadPhotoAttachment(page,{...options(),attachmentRef:candidates[0].downloadRef}),{code:'MAX_PHOTO_VIEWER_UNVERIFIED'});
  assert.deepEqual(log,['open-photo']);
 }
});

test('MAX photo identity rejects redirects, non-images, oversized/incomplete bodies and redacts network errors',async()=>{
 for(const patch of [{status:()=>302},{headers:()=>({'content-type':'text/html','content-length':'4'})},
  {headers:()=>({'content-type':'image/jpeg','content-length':String(5*1024*1024)})},
  {headers:()=>({'content-type':'image/jpeg','content-length':'999'})},
  {body:async()=>{throw Error('https://i.oneme.ru/private?SECRET');}}]){
  const response={status:()=>200,headers:()=>({'content-type':'image/jpeg','content-length':'4'}),body:async()=>Buffer.from('1234'),dispose:async()=>{},...patch};
  await assert.rejects(photoSourceDigest({context:()=>({request:{get:async()=>response}})},source('test')),error=>{
   assert.equal(error.code,'MAX_PHOTO_REFERENCE_UNAVAILABLE');assert.doesNotMatch(error.message,/SECRET|https:/);return true;});
 }
});

test('MAX photo selector belongs only to exact read-only download and never message mutations/assist',()=>{
 validateCommandOptions(options());
 for(const patch of [{command:'reply',message:'test',confirm:true},{command:'assist-start',fallbackFor:'download'},
  {targetText:'10:15'},{attachmentIndex:2},{attachmentRef:'invalid'},{chat:'Display name'}])
  assert.throws(()=>validateCommandOptions({...options(),...patch}));
});


test('MAX photo budget cannot turn an unexamined duplicate into a unique selector',async()=>{
 const {page}=fixture(Array.from({length:21},(_,i)=>bubble(`photo-${i}`)).join(''));
 const {messages,candidates}=await read(page);
 assert.equal(candidates.length,0);assert.equal(messages.some(m=>m.attachments.some(a=>a.downloadRef)),false);
});
