import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import pino from 'pino';
import * as sdk from '@whiskeysockets/baileys';
import { createProtocolNetwork, dnsAnswer, readDnsJson } from '../scripts/protocol-network.mjs';
import { WhatsAppClient } from '../scripts/client.mjs';

const host='web.whatsapp.com';
const missing=()=>Object.assign(new Error('PRIVATE_DNS_TEXT'),{code:'ENOTFOUND'});
const answer=()=>({Status:0,Question:[{name:host+'.',type:1}],Answer:[
  {name:host+'.',type:5,TTL:300,data:'mmx-ds.cdn.whatsapp.net.'},
  {name:'mmx-ds.cdn.whatsapp.net.',type:1,TTL:300,data:'8.8.8.8'},
]});
const resolve=(network,name=host,options={})=>new Promise((resolve,reject)=>network.agent.options.lookup(name,options,(error,address,family)=>error?reject(error):resolve({address,family})));

test('system DNS remains primary and unrelated, non-DNS and IPv6-only failures never use HTTPS',async()=>{
  let queries=0;
  const normal=createProtocolNetwork({permit:async()=>{},lookup:(_host,_options,callback)=>callback(null,'1.1.1.1',4),query:async()=>{queries++;}});
  assert.deepEqual(await resolve(normal),{address:'1.1.1.1',family:4}); normal.close();
  for(const [name,code,options] of [['unrelated.example','ENOTFOUND',{}],[host,'ECONNRESET',{}],[host,'ETIMEDOUT',{}],[host,'ENOTFOUND',{family:6}]]){
    const network=createProtocolNetwork({permit:async()=>{},lookup:(_host,_options,callback)=>callback(Object.assign(new Error(),{code})),query:async()=>{queries++;}});
    await assert.rejects(resolve(network,name,options),error=>error.code===code);network.close();
  }
  assert.equal(queries,0);
});

test('only a correlated public A record or bounded provider CNAME chain is accepted',()=>{
  assert.deepEqual(dnsAnswer(answer()),{addresses:['8.8.8.8'],ttlMs:60000});
  for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','224.0.0.1','::1']){
    const body=answer();body.Answer[1].data=address;assert.throws(()=>dnsAnswer(body),/dns_fallback_unavailable/);
  }
  for(const mutate of [body=>body.Status=3,body=>body.TC=true,body=>body.CD=true,body=>body.Question[0].name='unrelated.example',
    body=>body.Question[0].name=17,body=>body.Question[0].type=28,body=>body.Answer[0].data='unrelated.example.',
    body=>body.Answer[1].name='unrelated.example.',body=>body.Answer[1].TTL=-1,
    body=>body.Answer.push({...body.Answer[0]}),body=>body.Answer=Array(33).fill(body.Answer[1])]){
    const body=answer();mutate(body);assert.throws(()=>dnsAnswer(body));
  }
});

test('DNS-only fallback is single-flight, honors TTL and callback all semantics without leaking addresses',async()=>{
  const events=[];let queries=0,permits=0,time=0;
  const network=createProtocolNetwork({permit:async()=>{permits++;},now:()=>time,
    lookup:(_host,_options,callback)=>callback(missing()),onDiagnostic:value=>events.push(value),
    query:async()=>{queries++;return {addresses:['8.8.8.8'],ttlMs:1000};}});
  try{
    const [one,two]=await Promise.all([resolve(network),resolve(network,host,{all:true})]);
    assert.deepEqual(one,{address:'8.8.8.8',family:4});assert.deepEqual(two,{address:[{address:'8.8.8.8',family:4}],family:undefined});
    assert.equal(queries,1);assert.equal(permits,2);
    await resolve(network);assert.equal(queries,1);assert.equal(events.at(-1).state,'https_cache');
    time=1001;await resolve(network);assert.equal(queries,2);
    assert.ok(!JSON.stringify(events).includes('8.8.8.8'));assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  }finally{network.close();}
});

test('resolver failures are bounded and preserve the original DNS error',async()=>{
  let queries=0;const original=missing();
  const network=createProtocolNetwork({permit:async()=>{},lookup:(_host,_options,callback)=>callback(original),
    query:async()=>{queries++;throw new Error('PRIVATE_RESOLVER');}});
  try{await assert.rejects(resolve(network),error=>error===original);assert.equal(queries,2);}
  finally{network.close();}
});

test('stop aborts pending resolution and no late system callback can open a connection',async()=>{
  let started,callback;const entered=new Promise(resolve=>started=resolve);
  const network=createProtocolNetwork({permit:async()=>{},lookup:(_host,_options,done)=>done(missing()),
    query:(_endpoint,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(missing()),{once:true});started();})});
  const pending=resolve(network);await entered;network.close();await assert.rejects(pending,error=>error.code==='ENOTFOUND');
  const delayed=createProtocolNetwork({permit:async()=>{},lookup:(_host,_options,done)=>callback=done});
  const late=resolve(delayed);delayed.close();callback(null,'8.8.8.8',4);await assert.rejects(late,error=>error.code==='ENOTFOUND');
});

test('HTTPS JSON transport sends no credentials and rejects redirects, partial and oversized responses',async()=>{
  await assert.rejects(readDnsJson('http://127.0.0.1/'),/dns_fallback_unavailable/);
  for(const scenario of ['success','redirect','oversized','partial','invalid']){
    const request=(url,options,onResponse)=>{
      assert.equal(url.hostname,'dns.google');assert.equal(url.searchParams.get('name'),host);
      assert.equal(url.searchParams.get('edns_client_subnet'),'0.0.0.0/0');
      assert.deepEqual(options.headers,{accept:'application/dns-json'});assert.equal(options.timeout,2500);
      const req=new EventEmitter();req.destroy=error=>req.emit('error',error);
      queueMicrotask(()=>{
        const response=Readable.from([scenario==='oversized'?Buffer.alloc(16385):Buffer.from(scenario==='invalid'?'PRIVATE_INVALID':JSON.stringify(answer()))]);
        response.statusCode=scenario==='redirect'?302:200;onResponse(response);
        if(scenario==='partial')response.emit('aborted');
      });return req;
    };
    if(scenario==='success')assert.deepEqual(await readDnsJson('https://dns.google/resolve',{request}),{addresses:['8.8.8.8'],ttlMs:60000});
    else await assert.rejects(readDnsJson('https://dns.google/resolve',{request}),/dns_fallback_unavailable/);
  }
});

test('the SDK receives a DNS-only HTTPS agent and closes it with the original session',async()=>{
  let options;
  const socket={ev:new EventEmitter(),end:()=>{}};
  const client=new WhatsAppClient({sdk:{...sdk,default:value=>{options=value;return socket;}},pino,
    permit:async()=>{},persist:async()=>{},onPhase:()=>{},onQr:()=>{},onFatal:()=>{}});
  await client.connect();
  assert.equal(typeof options.agent.options.lookup,'function');assert.notEqual(options.agent.options.rejectUnauthorized,false);
  assert.equal(options.waWebSocketUrl,undefined);assert.equal(options.connectTimeoutMs,30000);
  assert.equal(options.maxMsgRetryCount,0);assert.equal(options.markOnlineOnConnect,false);
  let destroyed=false;const destroy=options.agent.destroy.bind(options.agent);options.agent.destroy=()=>{destroyed=true;destroy();};
  client.close();assert.equal(destroyed,true);
});

test('DNS diagnostics keep only fixed strategy/state and ignore resolver data',()=>{
  const client=new WhatsAppClient({sdk,pino,permit:async()=>{},persist:async()=>{},onPhase:()=>{},onQr:()=>{},onFatal:()=>{}});
  client.diagnostics.network({strategy:'system_then_https',state:'https_resolved',ip:'PRIVATE_ADDRESS',url:'PRIVATE_URL'});
  assert.deepEqual(client.diagnostics.snapshot().dns,{strategy:'system_then_https',state:'https_resolved'});
  assert.ok(!JSON.stringify(client.diagnostics.snapshot()).includes('PRIVATE'));
  client.diagnostics.network({strategy:'system_then_https',state:'PRIVATE_DATA'});assert.equal(client.diagnostics.snapshot().dns,undefined);
  client.close();
});
