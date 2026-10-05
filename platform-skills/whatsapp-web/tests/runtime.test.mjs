import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as sdk from '@whiskeysockets/baileys';
import pino from 'pino';
import { encryptRecord, decryptRecord, identityFromEnv, configRoot, RuntimeError, LEASE_MS, RUNTIME_VERSION, childEnvironment } from '../scripts/core.mjs';
import { WhatsAppClient, messageView, validateRequest, providerStatus } from '../scripts/client.mjs';
import { parseArguments, requestControl } from '../scripts/trelio-whatsapp.mjs';
import { createHandoff } from '../scripts/handoff.mjs';
import { nativeHelper, ensurePrivateDirectory, vaultKey, deleteVaultKey } from '../scripts/native.mjs';

const chat='12345678901@s.whatsapp.net';
function fixture(policy='confirm') {
  const saved=[], calls=[];
  const client=new WhatsAppClient({sdk,pino,permit:async()=>{},persist:async value=>saved.push(value),onPhase:()=>{},onQr:()=>{},onFatal:()=>{}});
  client.connected=true; client.data.policy=policy;
  client.data.chats[chat]={id:chat,name:'Тест',unreadCount:3};
  client.socket={sendMessage:async(id,message,options)=>{calls.push({id,message,options});return {key:{remoteJid:id,id:options.messageId,fromMe:true},message:{conversation:message.text},messageTimestamp:10};},end:()=>{}};
  return {client,calls,saved};
}
const request=()=>({command:'send',chat,text:'Синтетический текст',requestId:crypto.randomUUID()});
async function authorized(client, packet) {
  const preview=await client.execute({...packet,dryRun:true});
  return client.execute({...packet,confirm:true,approvalHash:preview.approvalHash});
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function eventFixture() {
  const context=fixture(),socket=context.client.socket;
  socket.ev=new EventEmitter();socket.ws=new EventEmitter();
  context.client.sdk={...sdk,default:()=>socket};
  await context.client.connect();
  return {...context,socket};
}

test('the worker lease version follows the package that removes persistent authorization',async()=>{
  const release=JSON.parse(await fs.readFile(new URL('../release.json',import.meta.url),'utf8'));
  assert.equal(RUNTIME_VERSION,release.runtime.version);
  assert.notEqual(RUNTIME_VERSION,'1.2.0');
});
test('me projects only the current authenticated account chat ID without device or raw profile data',async()=>{
  const {client,calls}=fixture('read-only');
  client.socket.user={id:'99999999999:42@s.whatsapp.net',name:'PRIVATE_PROFILE',lid:'PRIVATE_LID',extra:'PRIVATE_METADATA'};
  client.data.contacts[chat]={id:chat,name:'PRIVATE_PROFILE'};
  const result=await client.execute({command:'me'});
  assert.deepEqual(result,{chatId:'99999999999@s.whatsapp.net',isSelf:true});
  assert.deepEqual(calls,[]);
  client.socket.user={id:'888:3@lid'};
  assert.deepEqual(await client.execute({command:'me'}),{chatId:'888@lid',isSelf:true});
  client.close();
});
test('self identity is not inferred from contacts, missing account metadata or a disconnected socket',async()=>{
  const {client}=fixture();
  client.data.contacts[chat]={id:chat,name:'My account'};
  for(const id of [undefined,'','555@g.us','invalid','777@newsletter']){
    client.socket.user={id};
    await assert.rejects(client.execute({command:'me'}),/self_identity_unavailable/);
  }
  client.socket.user={id:chat};client.connected=false;
  await assert.rejects(client.execute({command:'me'}),/provider_not_connected/);
  client.close();
});
test('the exact self chat supports an initial send with no synced dialog and retains the normal preview guard',async()=>{
  const {client,socket,calls}=await eventFixture();client.data.policy='confirm';client.data.chats={};
  socket.user={id:'12345678901:7@s.whatsapp.net'};
  const me=await client.execute({command:'me'});
  assert.deepEqual((await client.execute({command:'read',chat:me.chatId})).messages,[]);
  const packet={...request(),chat:me.chatId};
  await assert.rejects(client.execute(packet),/exact_approval_required/);
  const preview=await client.execute({...packet,dryRun:true});const original=socket.sendMessage;
  socket.sendMessage=async(id,content,options)=>{
    socket.ws.emit('CB:ack,class:message',{attrs:{class:'message',from:id,id:options.messageId}});
    await tick();return original(id,content,options);
  };
  const result=await client.execute({...packet,confirm:true,approvalHash:preview.approvalHash});
  assert.equal(result.serverAcknowledged,true);assert.equal(calls.length,1);assert.equal(calls[0].id,me.chatId);
  await assert.rejects(client.execute({command:'read',chat:'77777777777@s.whatsapp.net'}),/chat_not_in_synced_history/);
  client.close();
});

test('a server ACK received before send resolves survives the pending echo and vault restart',async()=>{
  const {client,socket,saved}=await eventFixture(),packet=request();let sends=0;
  socket.sendMessage=async(id,content,options)=>{
    sends++;
    socket.ws.emit('CB:ack,class:message',{attrs:{class:'message',from:id,id:options.messageId}});
    await tick();
    return sdk.proto.WebMessageInfo.fromObject({key:{remoteJid:id,id:options.messageId,fromMe:true},message:{conversation:content.text},status:1});
  };
  const result=await authorized(client,packet);
  assert.equal(sends,1);assert.equal(result.verified,true);assert.equal(result.serverAcknowledged,true);
  assert.equal(result.delivered,false);assert.equal(result.read,false);assert.equal(result.providerStatus,2);
  const restored=new WhatsAppClient({sdk,pino,saved:saved.at(-1),permit:async()=>{},persist:async()=>{}});
  const after=await restored.execute({command:'result',requestId:packet.requestId});
  assert.equal(after.serverAcknowledged,true);assert.equal(after.delivered,false);assert.equal(after.providerStatus,2);
  client.close();
});
test('delivery before message upsert is retained and protobuf enum names are normalized',async()=>{
  const {client,socket}=await eventFixture(),id=crypto.randomUUID();
  client.data.attempts[id]={chatId:chat,messageId:'OUT',state:'submitted'};
  socket.ev.emit('messages.update',[{key:{remoteJid:chat,id:'OUT',fromMe:true},update:{status:3}}]);
  await tick();
  client.ingest([{key:{remoteJid:chat,id:'OUT',fromMe:true},message:{conversation:'synthetic'},status:'PENDING'}]);
  const result=await client.execute({command:'result',requestId:id});
  assert.equal(result.serverAcknowledged,true);assert.equal(result.delivered,true);assert.equal(result.read,false);
  assert.equal(providerStatus('READ',sdk),4);assert.equal(providerStatus('PENDING',sdk),1);
  assert.equal(providerStatus('unknown',sdk),null);assert.equal(providerStatus('2',sdk),null);
  assert.equal(messageView({key:{id:'M',remoteJid:chat},message:{conversation:'synthetic'},status:'READ'},sdk).status,4);
  client.close();
});
test('send waits for a delayed server ACK but does not turn a group member receipt into delivery to all',async()=>{
  const {client,socket}=await eventFixture(),packet=request();const original=socket.sendMessage;
  socket.sendMessage=async(id,content,options)=>{
    setTimeout(()=>socket.ws.emit('CB:ack,class:message',{attrs:{class:'message',from:id,id:options.messageId}}),20);
    return original(id,content,options);
  };
  const result=await authorized(client,packet);assert.equal(result.serverAcknowledged,true);assert.equal(result.delivered,false);
  const groupRequest=crypto.randomUUID();
  client.data.attempts[groupRequest]={chatId:'555@g.us',messageId:'GROUP',state:'submitted',providerStatus:2};
  socket.ev.emit('message-receipt.update',[{key:{remoteJid:'555@g.us',id:'GROUP',fromMe:true},receipt:{userJid:chat,receiptTimestamp:100}}]);
  await tick();assert.equal(client.confirmation(groupRequest).delivered,false);
  client.close();
});
test('confirmations require exact outgoing ID and chat, or the stored provider LID mapping',async()=>{
  const {client,socket}=await eventFixture(),id=crypto.randomUUID();
  client.data.attempts[id]={chatId:chat,messageId:'OUT',state:'submitted'};
  for(const key of [{remoteJid:chat,id:'OTHER',fromMe:true},{remoteJid:chat,id:'OUT',fromMe:false},
    {remoteJid:'55555555555@s.whatsapp.net',id:'OUT',fromMe:true},{remoteJid:'555@g.us',id:'OUT',fromMe:true}]){
    assert.equal(await client.recordConfirmation(key,3,socket),false);
  }
  const lidKey={remoteJid:'999@lid',id:'OUT',fromMe:true};
  assert.equal(await client.recordConfirmation(lidKey,3,socket),false);
  socket.signalRepository={lidMapping:{getPNForLID:async lid=>lid==='999@lid'?chat:null}};
  assert.equal(await client.recordConfirmation(lidKey,3,socket),true);
  assert.equal(client.confirmation(id).delivered,true);
  client.close();
});
test('negative server ACK is reported without claiming success or replaying the send',async()=>{
  const {client,socket}=await eventFixture(),packet=request();let sends=0;
  socket.sendMessage=async(id,content,options)=>{
    sends++;socket.ws.emit('CB:ack,class:message',{attrs:{class:'message',from:id,id:options.messageId,error:'463'}});
    await tick();
    return {key:{remoteJid:id,id:options.messageId,fromMe:true},message:{conversation:content.text},status:1};
  };
  const result=await authorized(client,packet);
  assert.equal(sends,1);assert.equal(result.verified,false);assert.equal(result.serverAcknowledged,false);
  assert.equal(result.providerRejected,true);assert.equal(result.providerStatus,0);
  await assert.rejects(authorized(client,packet),/request_already_attempted/);
  client.close();
});
test('closing the session ends confirmation waiting without implying acknowledgement',async()=>{
  const {client}=fixture(),id=crypto.randomUUID();client.data.attempts[id]={state:'submitted',chatId:chat,messageId:'WAIT'};
  const pending=client.waitForConfirmation(id);client.close();
  const result=await pending;assert.equal(result.serverAcknowledged,false);assert.equal(client.confirmationWaiters.size,0);
});

test('vault binds identity, detects tampering, and preserves binary SDK keys without plaintext persistence',()=>{
  const key=crypto.randomBytes(32),identity={skill:'whatsapp-web',company:'a',member:'b',connection:'c'};
  const serialized=JSON.stringify({secret:Buffer.from('SYNTHETIC_ONLY')},sdk.BufferJSON.replacer);
  const encrypted=encryptRecord(key,identity,{serialized});
  assert.ok(!encrypted.includes('SYNTHETIC_ONLY'));
  assert.deepEqual(JSON.parse(decryptRecord(key,identity,encrypted).serialized,sdk.BufferJSON.reviver).secret,Buffer.from('SYNTHETIC_ONLY'));
  assert.throws(()=>decryptRecord(key,{...identity,connection:'d'},encrypted));
  const envelope=JSON.parse(encrypted);const bytes=Buffer.from(envelope.data,'base64');bytes[0]^=1;envelope.data=bytes.toString('base64');
  assert.throws(()=>decryptRecord(key,identity,JSON.stringify(envelope)));
});
test('host identity and CLI reject secret/TTL options; only bounded request-file transport exists',()=>{
  assert.throws(()=>identityFromEnv({}));
  assert.equal(configRoot({LOCALAPPDATA:'C:\\Users\\Example\\AppData\\Local'},'win32'),'C:\\Users\\Example\\AppData\\Local\\Trelio');
  assert.throws(()=>configRoot({},'win32'),/config_home_invalid/);
  assert.throws(()=>configRoot({},'linux'),/unsupported_platform/);
  for(const flag of ['--headless','--qr','--password','--ttl','--extend'])assert.throws(()=>parseArguments(['start',flag,'x']));
  assert.equal(LEASE_MS,1800000);
  assert.equal(parseArguments(['request','--session',crypto.randomUUID(),'--input','/tmp/request.json']).command,'request');
  assert.throws(()=>validateRequest({command:'send',chat,text:'hello'}));
  assert.throws(()=>validateRequest({command:'read',chat,script:'process.exit()'}));
  assert.deepEqual(childEnvironment({PATH:'/safe',DEBUG:'*',NODE_OPTIONS:'--inspect',PASSWORD:'x'}),{PATH:'/safe'});
});
test('reads retain unread and partial coverage; equal display names never resolve an action',async()=>{
  const {client,calls}=fixture();
  client.ingest([{key:{remoteJid:chat,id:'IN',fromMe:false},message:{conversation:'Проверка'},messageTimestamp:1}]);
  const result=await client.execute({command:'read',chat});
  assert.equal(result.messages[0].text,'Проверка');assert.equal(result.coverage.complete,false);
  assert.equal(client.data.chats[chat].unreadCount,3);assert.deepEqual(calls,[]);
  client.data.chats['999@g.us']={id:'999@g.us',name:'Тест'};
  await assert.rejects(client.execute({command:'read',chat:'Тест'}),/chat_ambiguous/);
  assert.equal((await client.execute({command:'read',chat})).messages.length,1);
});
test('message projection excludes media URL and keys and retains reply/author identity',()=>{
  const raw={key:{remoteJid:chat,id:'M',participant:'999@lid'},message:{imageMessage:{caption:'Фото',url:'https://private.example',mediaKey:Buffer.from('PRIVATE'),fileSha256:Buffer.from('PRIVATE'),contextInfo:{stanzaId:'REPLY'}}}};
  const result=messageView(raw,sdk),json=JSON.stringify(result);
  assert.equal(result.text,'Фото');assert.equal(result.replyTo,'REPLY');assert.equal(result.author,'999@lid');assert.ok(!json.includes('PRIVATE')&&!json.includes('private.example'));
});
test('long history pages preserve complete bodies and a usable cursor within control byte budget',async()=>{
  const {client}=fixture();
  client.ingest(Array.from({length:100},(_,i)=>({key:{remoteJid:chat,id:`M${i}`,fromMe:false},
    message:{conversation:'я'.repeat(20000)},messageTimestamp:i+1})));
  const first=await client.execute({command:'read',chat,limit:100});
  assert.ok(Buffer.byteLength(JSON.stringify(first))<1024*1024);
  assert.equal(first.coverage.hasMore,true);assert.equal(first.messages.at(-1).id,'M99');
  assert.ok(first.messages.every(m=>m.text.length===20000));
  const second=await client.execute({command:'read',chat,limit:100,before:first.coverage.nextBeforeId});
  assert.ok(!second.messages.some(m=>first.messages.some(previous=>previous.id===m.id)));
  client.data.chats['999@g.us']={id:'999@g.us'};
  const unread=await client.execute({command:'unread'});
  assert.equal(unread.coverage.unknownUnreadChats,1);
  assert.equal(client.data.chats[chat].unreadCount,3);
});
test('nested disappearing view-once media cannot be downloaded or forwarded',async()=>{
  const {client,calls}=fixture();
  client.ingest([{key:{remoteJid:chat,id:'ONCE',fromMe:false},message:{ephemeralMessage:{message:{
    viewOnceMessageV2:{message:{imageMessage:{fileLength:10,mimetype:'image/jpeg'}}}}}},messageTimestamp:1}]);
  await assert.rejects(client.execute({command:'download',chat,messageId:'ONCE',output:'/unused'}),/view_once_not_exportable/);
  await assert.rejects(client.execute({command:'forward',chat,target:chat,messageId:'ONCE',requestId:crypto.randomUUID(),dryRun:true}),/view_once_not_exportable/);
  assert.equal(calls.length,0);
});
test('partial local control responses reject promptly without retrying the operation',async()=>{
  let calls=0;
  const server=http.createServer((req,res)=>{calls++;res.writeHead(200,{'Content-Type':'application/json'});
    res.write('{"incomplete":');setImmediate(()=>res.destroy());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(requestControl({port:server.address().port,token:'a'.repeat(64)},{command:'status'}),/control_result_incomplete|session_unreachable/);
    assert.equal(calls,1);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('send requires exact preview; changed text rejected; successful submission is not claimed delivered',async()=>{
  const {client,calls}=fixture(),packet=request();
  await assert.rejects(client.execute(packet),/exact_approval_required/);
  const preview=await client.execute({...packet,dryRun:true});assert.equal(calls.length,0);
  await assert.rejects(client.execute({...packet,text:'Changed',confirm:true,approvalHash:preview.approvalHash}),/exact_approval_required/);
  const result=await client.execute({...packet,confirm:true,approvalHash:preview.approvalHash});
  assert.equal(calls.length,1);assert.equal(result.state,'submitted');assert.equal(result.verified,false);
  assert.equal(client.data.chats[chat].unreadCount,3);
});
test('timeout never repeats an outgoing request, including after a new process restores the vault',async()=>{
  const {client}=fixture();let calls=0;
  client.socket.sendMessage=async()=>{calls++;throw Error('SIMULATED_NETWORK_TIMEOUT');};
  const packet=request();await assert.rejects(authorized(client,packet),/mutation_result_ambiguous/);
  const restored=new WhatsAppClient({sdk,pino,saved:client.serialize(),permit:async()=>{},persist:async()=>{},onFatal:()=>{}});
  restored.connected=true;restored.socket=client.socket;
  await assert.rejects(authorized(restored,packet),/request_already_attempted/);assert.equal(calls,1);
});
test('ambiguous submission retains the durable provider ID and can correlate a later exact acknowledgement',async()=>{
  const {client,saved}=fixture();const packet=request();let providerId;
  client.socket.sendMessage=async(id,_content,options)=>{
    providerId=options.messageId;
    const claim=JSON.parse(saved.at(-1),sdk.BufferJSON.reviver).attempts[packet.requestId];
    assert.equal(claim.chatId,id);assert.equal(claim.messageId,providerId);assert.equal(claim.state,'attempted');
    throw Error('SYNTHETIC_LOST_RESPONSE');
  };
  await assert.rejects(authorized(client,packet),/mutation_result_ambiguous/);
  const restored=new WhatsAppClient({sdk,pino,saved:client.serialize(),permit:async()=>{},persist:async()=>{}});
  const before=await restored.execute({command:'result',requestId:packet.requestId});
  assert.equal(before.chatId,chat);assert.equal(before.messageId,providerId);assert.equal(before.state,'ambiguous');
  assert.equal(before.serverAcknowledged,false);
  restored.ingest([{key:{remoteJid:chat,id:providerId,fromMe:false},message:{conversation:'synthetic'},status:3}]);
  assert.equal((await restored.execute({command:'result',requestId:packet.requestId})).serverAcknowledged,false);
  restored.ingest([{key:{remoteJid:chat,id:providerId,fromMe:true},message:{conversation:'synthetic'},status:sdk.proto.WebMessageInfo.Status.SERVER_ACK}]);
  assert.equal((await restored.execute({command:'result',requestId:packet.requestId})).serverAcknowledged,true);
  const legacy=crypto.randomUUID();restored.data.attempts[legacy]={state:'attempted'};
  assert.equal((await restored.execute({command:'result',requestId:legacy})).messageId,null);
});

test('SDK diagnostics cannot leak synthetic state or corrupt the guardian pipe',async()=>{
  const stdioUrl=new URL('../scripts/worker-stdio.mjs',import.meta.url).href;
  const signalUrl=new URL('../node_modules/libsignal/src/session_record.js',import.meta.url).href;
  const script=`
    const {guardianRequest}=await import(${JSON.stringify(stdioUrl)});
    const {default:Record}=await import(${JSON.stringify(signalUrl)});
    const record=new Record();
    record.closeSession({indexInfo:{closed:-1},synthetic:'SYNTHETIC_PRIVATE_STATE'});
    console.log({[Symbol.for('nodejs.util.inspect.custom')](){process.exit(42)}});
    await new Promise(r=>process.stdout.write('SYNTHETIC_STDOUT',r));
    await new Promise(r=>process.stderr.write('SYNTHETIC_STDERR','utf8',r));
    guardianRequest('permit',1);
    guardianRequest('own',2,123);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0);assert.equal(stderr,'');
  assert.deepEqual(stdout.trim().split('\n').map(JSON.parse),[{op:'permit',id:1},{op:'own',id:2,pid:123}]);
});
test('read-only remains enforced and persistent autonomous cannot be enabled',async()=>{
  const {client,calls}=fixture('read-only');
  await assert.rejects(client.execute({...request(),dryRun:true}),/read_only_policy/);
  await assert.rejects(client.execute({command:'policy',mode:'autonomous',confirm:true}),/policy_confirmation_required/);
  assert.equal(calls.length,0);
});

test('legacy autonomous is normalized without losing state and never authorizes a later call',async()=>{
  const {client,saved}=fixture();
  client.data.policy='autonomous';
  client.data.attempts['legacy']={state:'ambiguous',chatId:chat,messageId:'KEPT'};
  const restored=new WhatsAppClient({sdk,pino,saved:client.serialize(),permit:async()=>{},persist:async value=>saved.push(value)});
  restored.connected=true;restored.socket=client.socket;
  assert.deepEqual(await restored.execute({command:'policy'}),{policy:'confirm'});
  assert.equal(restored.data.attempts.legacy.messageId,'KEPT');
  const packet=request();
  await assert.rejects(restored.execute(packet),/exact_approval_required/);
  await authorized(restored,packet);
  // Neither the completed invocation nor its persisted journal is a grant.
  await assert.rejects(restored.execute(request()),/exact_approval_required/);
  assert.equal(JSON.parse(saved.at(-1)).policy,'confirm');
  const next=new WhatsAppClient({sdk,pino,saved:saved.at(-1),permit:async()=>{},persist:async()=>{}});
  next.connected=true;next.socket=client.socket;
  await assert.rejects(next.execute(request()),/exact_approval_required/);
});

function get(url,headers={},method='GET') {
  return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end();});
}
test('QR refresh replaces only an unpaired socket and ignores retired socket events',async()=>{
  const sockets=[],phases=[],codes=[];
  const fakeSdk={...sdk,default:()=>{const socket={ev:new EventEmitter(),end:()=>{socket.ended=true;}};sockets.push(socket);return socket;}};
  const client=new WhatsAppClient({sdk:fakeSdk,pino,permit:async()=>{},persist:async()=>{},onPhase:p=>phases.push(p),onQr:async q=>codes.push(q),onFatal:()=>assert.fail('unexpected fatal')});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  await client.connect();sockets[0].ev.emit('connection.update',{qr:'SYNTHETIC_OLD'});await tick();
  const creds=client.data.creds;
  await client.refreshQr();assert.equal(sockets.length,2);assert.equal(sockets[0].ended,true);assert.equal(client.data.creds,creds);
  sockets[0].ev.emit('creds.update',{registered:true});sockets[0].ev.emit('connection.update',{qr:'SYNTHETIC_STALE',connection:'open'});
  sockets[1].ev.emit('connection.update',{qr:'SYNTHETIC_NEW'});await tick();
  assert.deepEqual(codes,['SYNTHETIC_OLD','SYNTHETIC_NEW']);assert.equal(client.connected,false);assert.equal(client.data.creds.registered,false);
  client.data.creds.registered=true;
  await assert.rejects(client.refreshQr(),/qr_refresh_unavailable/);assert.equal(sockets.length,2);
  client.close();await assert.rejects(client.refreshQr(),/qr_refresh_unavailable/);
});
test('QR refresh binds revision and origin, clears the old image, and rejects replay after pairing',async()=>{
  let url,refreshes=0,resolveRefresh;
  const handoff=await createHandoff({open:async u=>{url=u;},qrcode:{toString:async()=>'<svg>SYNTHETIC</svg>'},remainingMs:10000,onCancel:()=>{},
    onRefresh:()=>{refreshes++;return new Promise(resolve=>{resolveRefresh=resolve;});}});
  try {
    await get(url,{'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-site':'none'});
    handoff.update('SYNTHETIC_OLD');
    const headers={'sec-fetch-site':'same-origin',origin:new URL(url).origin};
    assert.equal((await get(url+'/refresh?v=1',{...headers,origin:'https://foreign.example'},'POST')).status,403);
    assert.equal((await get(url+'/refresh?v=1',headers,'POST')).status,202);
    assert.equal((await get(url+'/refresh?v=1',headers,'POST')).status,403);
    assert.equal((await get(url+'/qr?v=1',headers)).status,403);assert.equal(refreshes,1);
    const pending=JSON.parse((await get(url+'/state',headers)).text);assert.equal(pending.phase,'refreshing');assert.equal(pending.hasQr,false);assert.equal(pending.canRefresh,false);
    handoff.update('SYNTHETIC_NEW');resolveRefresh();
    assert.equal((await get(url+'/qr?v=3',headers)).status,200);
    handoff.ready();assert.equal((await get(url+'/refresh?v=4',headers,'POST')).status,403);
  } finally {handoff.close();}
});
test('synthetic browser refresh keeps one page and replaces the QR without a reload',{skip:process.platform!=='darwin'},async()=>{
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage();page.setDefaultTimeout(5000);let handoff,refreshes=0;
  try {
    handoff=await createHandoff({open:u=>page.goto(u),qrcode:{toString:async()=>'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#e5f2eb"/><text x="80" y="150">TEST QR</text></svg>'},remainingMs:10000,onCancel:()=>{},
      onRefresh:async()=>{refreshes++;setTimeout(()=>handoff.update('SYNTHETIC_NEW'),100);}});
    handoff.update('SYNTHETIC_OLD');
    await page.waitForFunction(()=>!document.getElementById('refresh').disabled && document.querySelector('#qr').getAttribute('src')?.endsWith('v=1'));
    const initialUrl=page.url();
    await page.getByRole('button',{name:'Обновить QR-код',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#qr').getAttribute('src')?.endsWith('v=3'));
    assert.equal(refreshes,1);assert.equal(page.url(),initialUrl);assert.equal(browser.contexts()[0].pages().length,1);
    await page.screenshot({path:path.join(os.tmpdir(),'trelio-whatsapp-qr-refresh-synthetic.png')});
    handoff.ready();await page.waitForFunction(()=>document.querySelector('#refresh').hidden);
  } finally {handoff?.close();await browser.close();}
});
test('QR handoff binds owner page, rejects foreign origins/replay, clears pairing credential on success',async()=>{
  let url,cancelled=false;
  const handoff=await createHandoff({open:async value=>{url=value;},qrcode:{toString:async()=>'<svg>SYNTHETIC_QR</svg>'},remainingMs:10000,onCancel:()=>{cancelled=true;}});
  try {
    assert.equal((await get(url)).status,403);
    const headers={'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-site':'none'};
    assert.equal((await get(url,headers)).status,200);assert.equal((await get(url,headers)).status,403);
    handoff.update('synthetic-pairing-secret');
    assert.equal((await get(url+'/state',{'sec-fetch-site':'cross-site'})).status,403);
    const state=await get(url+'/state',{'sec-fetch-site':'same-origin'});assert.equal(state.status,200);assert.ok(!state.text.includes('synthetic-pairing-secret'));
    assert.equal((await get(url+'/qr?v=1',{'sec-fetch-site':'same-origin'})).status,200);
    assert.equal((await get(url+'/cancel',{'sec-fetch-site':'same-origin',origin:'https://foreign.example'},'POST')).status,403);assert.equal(cancelled,false);
    handoff.ready();assert.equal((await get(url+'/qr?v=2',{'sec-fetch-site':'same-origin'})).status,403);
  } finally { handoff.close(); }
});
test('real native supervisor kills a stalled worker at its absolute synthetic deadline',{skip:!['darwin','win32'].includes(process.platform)},async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'whatsapp-native-'));
  try {
    const helper=await nativeHelper(root),worker=path.join(root,'fixture.mjs');
    await fs.writeFile(worker,"process.stdin.once('data',()=>{while(true){}});",{mode:0o600});
    const started=Date.now();const child=spawn(helper,['guard',process.execPath,worker,'700'],{detached:true,stdio:['pipe','ignore','ignore']});
    child.stdin.end('{}\n');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('native deadline failed'));},5000);child.on('exit',()=>{clearTimeout(timer);resolve();});});
    assert.ok(Date.now()-started<4000);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('native guardian accepts permits after real libsignal diagnostics',{skip:process.platform!=='darwin'},async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'whatsapp-stdio-native-'));
  let child;
  try {
    const helper=await nativeHelper(root),worker=path.join(root,'fixture.mjs'),proof=path.join(root,'ack');
    const stdioUrl=new URL('../scripts/worker-stdio.mjs',import.meta.url).href;
    const signalUrl=new URL('../node_modules/libsignal/src/session_record.js',import.meta.url).href;
    await fs.writeFile(worker,`
      import {guardianRequest} from ${JSON.stringify(stdioUrl)};
      import Record from ${JSON.stringify(signalUrl)};
      import fs from 'node:fs';
      let configured=false;
      process.stdin.on('data',chunk=>{
        if(!configured){configured=true;new Record().closeSession({indexInfo:{closed:-1},synthetic:'TEST_ONLY'});guardianRequest('permit',1);}
        else if(JSON.parse(chunk.toString()).ok===true)fs.writeFileSync(${JSON.stringify(proof)},'ack',{mode:0o600});
      });
    `,{mode:0o600});
    child=spawn(helper,['guard',process.execPath,worker,'1500'],{detached:true,stdio:['pipe','ignore','ignore']});
    child.stdin.end('{}\n');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('guardian did not stop')),5000);
      child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);resolve();});});
    assert.equal(await fs.readFile(proof,'utf8'),'ack');
  } finally {if(child?.exitCode===null && child?.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
    await fs.rm(root,{recursive:true,force:true});}
});

test('non-financial native key store reuses a synthetic key with encryption and exact identity',{skip:!['darwin','win32'].includes(process.platform)},async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'whatsapp-key-store-'));
  const account=crypto.randomBytes(32).toString('hex');let helper,directory,created=false,key,restored;
  try {
    helper=await nativeHelper(root); directory=path.join(root,'store'); await ensurePrivateDirectory(directory,helper);
    key=await vaultKey(helper,directory,account,true);created=true;
    restored=await vaultKey(helper,directory,account,false);assert.deepEqual(restored,key);
    const identity={skill:'whatsapp-web',company:'synthetic',member:'synthetic',connection:account};
    const ciphertext=encryptRecord(key,identity,{test:'synthetic native roundtrip'});
    assert.equal(decryptRecord(restored,identity,ciphertext).test,'synthetic native roundtrip');
    assert.throws(()=>decryptRecord(restored,{...identity,member:'other'},ciphertext));
  } finally {
    key?.fill(0);restored?.fill(0);
    if(created)await deleteVaultKey(helper,directory,account);
    await fs.rm(root,{recursive:true,force:true});
  }
});
