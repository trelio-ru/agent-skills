import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as sdk from '@whiskeysockets/baileys';
import pino from 'pino';
import { WhatsAppClient, validateRequest } from '../scripts/client.mjs';
import { prepareMedia, checkMedia } from '../scripts/media.mjs';

const chat='12345678901@s.whatsapp.net', group='12345@g.us', other='98765432100@s.whatsapp.net';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture() {
  const calls=[], saved=[];
  const socket={user:{id:chat},ev:new EventEmitter(),ws:new EventEmitter(),end:()=>{},
    sendMessage:async(jid,content,options)=>{
      calls.push({jid,content:structuredClone(content),options});
      socket.ws.emit('CB:ack,class:message',{attrs:{class:'message',from:jid,id:options.messageId}});await tick();
      return {key:{remoteJid:jid,id:options.messageId,fromMe:true},message:{conversation:content.text||'media'},status:1};
    },groupMetadata:async()=>({id:group,subject:'Fixture',participants:[{id:chat},{id:other}]})};
  const client=new WhatsAppClient({sdk:{...sdk,default:()=>socket},pino,permit:async()=>{},persist:async x=>saved.push(x),onPhase:()=>{},onQr:()=>{},onFatal:()=>{}});
  client.connected=true;client.data.chats={[chat]:{id:chat,name:'Self'},[group]:{id:group,name:'Fixture'}};
  await client.connect();return {client,socket,calls,saved};
}
async function apply(client,packet) {
  const request={...packet,requestId:randomUUID()},preview=await client.execute({...request,dryRun:true});
  return client.execute({...request,confirm:true,approvalHash:preview.approvalHash});
}

test('new-number resolution requires exact provider evidence and does not create an address-book contact',async()=>{
  const {client,socket,calls}=await fixture();
  socket.onWhatsApp=async phone=>{assert.equal(phone,'+98765432100');return [{jid:other,exists:true}];};
  await assert.rejects(client.execute({command:'send',chat:other,text:'Test',requestId:randomUUID()}),/chat_not_in_synced_history/);
  assert.deepEqual(await client.execute({command:'resolve',phone:'+98765432100'}),{registered:true,chatId:other,source:'provider_phone_lookup',validForSeconds:600});
  assert.equal((await apply(client,{command:'send',chat:other,text:'Test'})).serverAcknowledged,true);
  assert.equal(calls.length,1);assert.equal(client.data.contacts[other],undefined);
  socket.onWhatsApp=async()=>[{jid:chat,exists:true}];
  await assert.rejects(client.execute({command:'resolve',phone:'+98765432100'}),/phone_resolution_mismatch/);
  await assert.rejects(client.execute({command:'resolve',phone:'98765432100'}),/international_phone_required/);client.close();
});
test('server acknowledgement is consistent between result and ordinary history even after a late pending echo',async()=>{
  const {client}=await fixture();const sent=await apply(client,{command:'send',chat,text:'Test'});
  const read=await client.execute({command:'read',chat});
  assert.equal(read.messages[0].status,2);assert.equal((await client.execute({command:'result',requestId:sent.requestId})).providerStatus,2);client.close();
});
test('group receipts retain exact participant observations and the recipient set at submission',async()=>{
  const {client,socket}=await fixture();const sent=await apply(client,{command:'send',chat:group,text:'Test'});
  socket.ev.emit('message-receipt.update',[{key:{remoteJid:group,id:sent.messageId,fromMe:true},receipt:{userJid:other,readTimestamp:123}},
    {key:{remoteJid:group,id:sent.messageId,fromMe:false},receipt:{userJid:chat,readTimestamp:456}}]);await tick();
  const result=await client.execute({command:'receipts',chat:group,messageId:sent.messageId});
  assert.equal(result.counts.recipientsAtSubmission,1);assert.equal(result.counts.read,1);
  assert.equal(result.participants[0].chatId,other);assert.equal(result.participants[0].readAt,123);
  assert.equal((await client.execute({command:'result',requestId:sent.requestId})).delivered,false);client.close();
});
test('on-demand history correlates an early provider response, preserves old pages and never claims full archive coverage',async()=>{
  const {client,socket}=await fixture();client.ingest([{key:{remoteJid:chat,id:'ANCHOR',fromMe:false},message:{conversation:'Recent'},messageTimestamp:200}]);
  let requests=0;
  socket.fetchMessageHistory=async(count,key,time)=>{
    requests++;assert.equal(count,2);assert.equal(key.id,'ANCHOR');assert.equal(time,200000);
    socket.ev.emit('messaging-history.set',{chats:[],contacts:[],messages:[{key:{remoteJid:chat,id:'OLD',fromMe:false},message:{conversation:'Older'},messageTimestamp:100}],peerDataRequestSessionId:'PROVIDER'});
    await tick();return 'PROVIDER';
  };
  const result=await client.execute({command:'history-fetch',chat,before:'ANCHOR',limit:2});
  assert.equal(result.state,'received');assert.equal(result.messages[0].id,'OLD');assert.equal(result.coverage.complete,false);
  assert.equal((await client.execute({command:'history-status',requestId:result.requestId})).messages[0].text,'Older');
  await client.execute({command:'history-fetch',chat,before:'ANCHOR',limit:2});assert.equal(requests,1);client.close();
});
test('a failed history request has a cooldown and does not permanently block another read',async()=>{
  const {client,socket}=await fixture();
  client.ingest([{key:{remoteJid:chat,id:'ANCHOR',fromMe:false},message:{conversation:'Recent'},messageTimestamp:200}]);
  let calls=0;socket.fetchMessageHistory=async()=>{calls++;throw Error('synthetic network failure');};
  const first=await client.execute({command:'history-fetch',chat});assert.equal(first.state,'unknown');
  assert.equal((await client.execute({command:'history-fetch',chat})).requestId,first.requestId);assert.equal(calls,1);
  client.data.historyRequests[first.requestId].at=Date.now()-61000;
  const second=await client.execute({command:'history-fetch',chat});assert.notEqual(second.requestId,first.requestId);assert.equal(calls,2);
  assert.equal((await client.execute({command:'history-status',requestId:first.requestId})).state,'timed_out');client.close();
});
test('group reports join only proved participant aliases and paginate beyond the first recipients',async()=>{
  const {client,socket}=await fixture();const lid='55555@lid';
  socket.groupMetadata=async()=>({id:group,participants:[{id:chat},{id:lid},{id:'11111111111@s.whatsapp.net'}]});
  socket.signalRepository={lidMapping:{getPNForLID:async id=>id===lid?other:null}};
  const sent=await apply(client,{command:'send',chat:group,text:'Test'});
  socket.ev.emit('message-receipt.update',[{key:{remoteJid:group,id:sent.messageId,fromMe:true},receipt:{userJid:other,readTimestamp:123}}]);await tick();
  const first=await client.execute({command:'receipts',chat:group,messageId:sent.messageId,limit:1});
  const next=await client.execute({command:'receipts',chat:group,messageId:sent.messageId,limit:1,cursor:first.coverage.nextCursor});
  assert.equal(first.counts.recipientsAtSubmission,2);assert.equal(first.coverage.total,2);assert.equal(first.counts.read,1);
  assert.notEqual(first.participants[0].chatId,next.participants[0].chatId);assert.equal(next.participants[0].recipientAtSubmission,true);client.close();
});
test('search and contact pagination bind their query and preserve complete message text',async()=>{
  const {client}=await fixture();
  client.ingest([1,2,3].map(n=>({key:{remoteJid:chat,id:`M${n}`,fromMe:false},message:{conversation:`Text ${n}`},messageTimestamp:1700000000+n})));
  const first=await client.execute({command:'search',query:'Text',limit:1});
  const next=await client.execute({command:'search',query:'Text',limit:1,cursor:first.coverage.nextCursor});
  assert.notEqual(first.messages[0].id,next.messages[0].id);
  await assert.rejects(client.execute({command:'search',query:'Other',cursor:first.coverage.nextCursor}),/cursor_context_mismatch/);
  await assert.rejects(client.execute({command:'search',query:'Text',since:'yesterday'}),/search_date_invalid/);client.close();
});
test('chat settings and role changes retain preview and exact payload guards',async()=>{
  const {client,socket}=await fixture();let mutations=0;
  socket.chatModify=async(settings,id)=>{mutations++;assert.equal(id,chat);assert.deepEqual(settings,{pin:true});client.data.chats[chat].pinned=123;};
  assert.equal((await apply(client,{command:'chat-settings',chat,pin:true})).verified,true);
  await assert.rejects(apply(client,{command:'chat-settings',chat,pin:true,archive:true}),/one_chat_setting_required/);
  socket.groupParticipantsUpdate=async(id,people,action)=>{mutations++;assert.equal(id,group);assert.deepEqual(people,[other]);assert.equal(action,'promote');return [{jid:other,status:'200'}];};
  assert.equal((await apply(client,{command:'member-promote',chat:group,participants:[other]})).state,'applied');
  client.data.policy='read-only';await assert.rejects(apply(client,{command:'member-demote',chat:group,participants:[other]}),/read_only_policy/);
  assert.equal(mutations,2);client.close();
});
test('media uses native message shapes and rejects relabelled files and contact injection',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-media-'));
  const file=path.join(directory,'fixture.png');await fs.writeFile(file,Buffer.from([137,80,78,71,13,10,26,10,0]),{mode:0o600});
  try {
    const prepared=await prepareMedia({command:'send',file,fileName:'fixture.png',mimeType:'image/png',mediaType:'image',text:'Caption'});
    assert.ok(Buffer.isBuffer(prepared.content.image));assert.equal(prepared.content.caption,'Caption');assert.equal(prepared.content.document,undefined);prepared.bytes.fill(0);
    await assert.rejects(prepareMedia({command:'send',file,fileName:'fixture.ogg',mimeType:'audio/ogg',mediaType:'voice'}),/media_format_mismatch/);
    assert.throws(()=>checkMedia(Buffer.from('not webp'),'sticker','image/webp'),/media_format_mismatch/);
    assert.throws(()=>validateRequest({command:'send',requestId:randomUUID(),contact:{name:'Name\nTEL:other',phone:'+12345678901'}}),/contact_invalid/);
    const contact=await prepareMedia({command:'send',contact:{name:'Name, one',phone:'+12345678901'}});
    assert.match(contact.content.contacts.contacts[0].vcard,/FN:Name\\, one/);
  } finally {await fs.rm(directory,{recursive:true});}
});

test('block readback joins the proved LID and does not claim an unchanged invite was revoked',async()=>{
  const {client,socket}=await fixture();const lid='55555@lid';
  client.data.chats[lid]={id:lid};socket.updateBlockStatus=async()=>{};
  socket.signalRepository={lidMapping:{getPNForLID:async id=>id===lid?other:null}};
  socket.fetchBlocklist=async()=>[other];
  const blocked=await apply(client,{command:'block',chat:lid,blocked:true});assert.equal(blocked.verified,true);
  const unchanged=await apply(client,{command:'block',chat:lid,blocked:false});assert.equal(unchanged.verified,false);
  const original='ABCDEFGHIJKLMNOPQRSTUV';socket.groupInviteCode=async()=>original;let calls=0;
  socket.groupRevokeInvite=async()=>{calls++;return original;};
  const packet={command:'group-invite-revoke',chat:group,requestId:randomUUID()};
  const preview=await client.execute({...packet,dryRun:true});
  await assert.rejects(client.execute({...packet,confirm:true,approvalHash:preview.approvalHash}),/mutation_result_ambiguous/);
  assert.equal((await client.execute({command:'result',requestId:packet.requestId})).state,'ambiguous');
  assert.equal(calls,1);client.close();
});
