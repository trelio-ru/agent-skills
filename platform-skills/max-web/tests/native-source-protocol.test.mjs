import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaxNativeObserver, createMaxExactReadGate, decodeMaxNativeFrame,
  inspectMaxFrameHeader, inspectMaxReadCoverage } from '../scripts/max-native-protocol.mjs';
import { installPassiveReadGuard, joinMaxNativeSnapshot, projectMaxMonitorSnapshot,
  parseArguments, validateCommandOptions, outgoingMaxConversationReference, maxConversationReference } from '../scripts/trelio-max.mjs';

// Independent synthetic encoder: fixtures describe the public protocol, never
// capture an account, authentication response, body or real network packet.
const pack = value => {
  if (value === null) return Buffer.from([0xc0]);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xc3 : 0xc2]);
  if (typeof value === 'bigint') { const output = Buffer.alloc(9); output[0] = 0xd3; output.writeBigInt64BE(value, 1); return output; }
  if (Number.isInteger(value)) { const output = Buffer.alloc(5); output[0] = 0xd2; output.writeInt32BE(value, 1); return output; }
  if (typeof value === 'string') {
    const encoded = Buffer.from(value), header = Buffer.alloc(3); header[0] = 0xda; header.writeUInt16BE(encoded.length, 1);
    return Buffer.concat([header, encoded]);
  }
  const items = Array.isArray(value) ? value : Object.entries(value).flat();
  const header = Buffer.alloc(3); header[0] = Array.isArray(value) ? 0xdc : 0xde;
  header.writeUInt16BE(Array.isArray(value) ? value.length : Object.keys(value).length, 1);
  return Buffer.concat([header, ...items.map(pack)]);
};
const frame = (opcode, payload, { cmd = 1, seq = 1, compressed = false } = {}) => {
  const data = pack(payload);
  // A standard all-literals LZ4 block exercises compressed native parsing.
  const rest = data.length - 15, extension = [];
  if (compressed && rest >= 0) { let count = rest; while (count >= 255) { extension.push(255); count -= 255; } extension.push(count); }
  const body = compressed ? Buffer.concat([Buffer.from([Math.min(data.length, 15) << 4, ...extension]), data]) : data;
  const header = Buffer.alloc(10); header[0] = 10; header[1] = cmd; header.writeInt16BE(seq, 2);
  header.writeInt16BE(opcode, 4); header[6] = compressed ? 1 : 0; header.writeUIntBE(body.length, 7, 3);
  return Buffer.concat([header, body]);
};
const messages = [
  { id: 10n, sender: 111n, time: 100, text: 'Before' },
  { id: 11n, sender: 222n, time: 200, text: 'First' },
  { id: 12n, sender: 333n, time: 300, text: 'Second' },
];
const history = (observer, { seq = 2, socket = 1, rows = messages, mark = 100, unread = 2, chatId = 77n } = {}) => {
  observer.observeOutbound(frame(49, { chatId, from: -1, backward: 100, getChat: true }, { cmd: 0, seq }), socket);
  observer.observeInbound(frame(49, { chat: { id: chatId, participants: { 111: mark }, newMessages: unread }, messages: rows }, { seq, compressed: true }), socket);
};
const observer = () => {
  const value = createMaxNativeObserver();
  value.observeInbound(frame(19, { profile: { contact: { id: 111n } }, token: 'SYNTHETIC_IGNORED' }), 1);
  history(value); return value;
};
const receipt = (messageId = 12n, mark = 300, extra = {}) => frame(50,
  { type: 'READ_MESSAGE', chatId: 77n, messageId, mark, ...extra }, { cmd: 0, seq: 8, compressed: true });

test('MAX native frame decoder bounds header, compression, maps, integer identity and UTF-8', () => {
  const decoded = decodeMaxNativeFrame(frame(49, { chatId: 77n, messages }, { compressed: true }));
  assert.equal(decoded.opcode, 49); assert.equal(decoded.payload.chatId, 77n);
  assert.equal(decoded.payload.messages[1].sender, 222n);
  assert.equal(Object.getPrototypeOf(decoded.payload), null);
  for (const invalid of [Buffer.alloc(9), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from([10, 0, 0, 0, 0, 50, 0, 0, 0, 1])]) {
    assert.equal(inspectMaxFrameHeader(invalid), null);
    assert.throws(() => decodeMaxNativeFrame(invalid), /MAX_NATIVE_PROTOCOL_UNAVAILABLE/u);
  }
  const version = frame(50, {}); version[0] = 11;
  assert.equal(inspectMaxFrameHeader(version), null);
  const corrupt = frame(50, {}); corrupt[6] = 255;
  assert.throws(() => decodeMaxNativeFrame(corrupt));
  const duplicate = frame(50, {}); const map = Buffer.from([0x82, 0xa1, 0x78, 1, 0xa1, 0x78, 2]);
  const header = duplicate.subarray(0, 10); header.writeUIntBE(map.length, 7, 3);
  assert.throws(() => decodeMaxNativeFrame(Buffer.concat([header, map])));
});

test('MAX native observer requires correlated same-socket history and genuine login identity', () => {
  const value = observer();
  assert.equal(value.snapshot('77').messages[1].senderUserId, '222');
  assert.equal(value.snapshot('77').viewerId, '111');
  assert.equal(JSON.stringify(value.state()).includes('SYNTHETIC'), false);
  assert.equal(value.snapshot('78'), null);
  const uncorrelated = createMaxNativeObserver();
  uncorrelated.observeInbound(frame(49, { messages }), 1);
  assert.equal(uncorrelated.snapshot('77'), null);
  const wrongSocket = createMaxNativeObserver();
  wrongSocket.observeInbound(frame(19, { profile: { contact: { id: 111n } } }), 1);
  wrongSocket.observeOutbound(frame(49, { chatId: 77n, backward: 100, from: -1 }, { cmd: 0, seq: 2 }), 1);
  wrongSocket.observeInbound(frame(49, { messages }, { seq: 2 }), 2);
  assert.equal(wrongSocket.snapshot('77'), null);
  value.observeInbound(frame(19, { profile: { contact: { id: 999n } } }), 1);
  assert.equal(value.snapshot('77'), null);
  assert.equal(value.state().failed, true);
});

test('MAX native sender is joined only to exact chat/ID and complete rendered native text', () => {
  const value = observer(), snapshot = { chatReference: { url: 'https://web.max.ru/77', stableId: '77' },
    messages: messages.map(row => ({ providerMessageId: row.id.toString(), text: row.text,
      replyText: null, author: 'Owner @name', attachments: [] })) };
  const joined = joinMaxNativeSnapshot(snapshot, value);
  assert.equal(joined.nativeIdentityVerified, true);
  assert.deepEqual(joined.messages.map(row => row.senderUserId), ['111', '222', '333']);
  assert.equal(joinMaxNativeSnapshot({ ...snapshot, chatReference: { ...snapshot.chatReference, stableId: '78' } }, value).nativeIdentityVerified, undefined);
  assert.equal(joinMaxNativeSnapshot({ ...snapshot, messages: [{ ...snapshot.messages[1], text: 'truncated' }] }, value).nativeIdentityVerified, undefined);
  const options = { companyId: '11111111-1111-4111-8111-111111111111', memberId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333', chat: 'https://web.max.ru/77', limit: 20 };
  const baseline = projectMaxMonitorSnapshot(joined, options);
  const next = projectMaxMonitorSnapshot({ ...joined, messages: [...joined.messages,
    { providerMessageId: '13', text: 'Next', replyText: null, attachments: [], senderUserId: '222' }] }, { ...options, cursor: baseline.nextCursor });
  assert.equal(next.events[0].senderNamespace, 'max_user_id');
  assert.equal(next.coverage.ownerIdentityAvailable, true);
  const legacy = projectMaxMonitorSnapshot(snapshot, options);
  assert.equal(legacy.coverage.ownerIdentityAvailable, false);
});

test('MAX read coverage requires complete native unread range including equal-time neighbours', () => {
  const value = observer(), current = value.snapshot('77');
  assert.equal(inspectMaxReadCoverage({ history: current, messageId: '11', coveredMessageIds: ['11'] }).interval.length, 1);
  assert.throws(() => inspectMaxReadCoverage({ history: current, messageId: '12', coveredMessageIds: ['12'] }));
  assert.throws(() => inspectMaxReadCoverage({ history: { ...current, unread: 3 }, messageId: '12', coveredMessageIds: ['11', '12'] }));
  assert.throws(() => inspectMaxReadCoverage({ history: { ...current, readMark: null }, messageId: '12', coveredMessageIds: ['11', '12'] }));
  const simultaneous = { ...current, messages: current.messages.map(row => ({ ...row, time: row.time === 200 ? 300 : row.time })) };
  assert.throws(() => inspectMaxReadCoverage({ history: simultaneous, messageId: '11', coveredMessageIds: ['11'] }));
});

test('MAX exact receipt gate spends before send, rejects reactions/broad range, correlates native result', () => {
  const value = observer(), gate = createMaxExactReadGate({ observer: value, chatId: '77', messageId: '12', coveredMessageIds: ['11', '12'] });
  assert.equal(gate.consume(receipt(), 1), false); // Reload/current history is mandatory.
  history(value, { seq: 3 });
  assert.equal(gate.consume(receipt(12n, 301), 1), false);
  assert.equal(gate.consume(receipt(12n, 300, { type: 'READ_REACTION' }), 1), false);
  assert.equal(gate.consume(receipt(12n, 300, { other: true }), 1), false);
  assert.equal(gate.consume(receipt(), 2), false);
  assert.equal(gate.consume(receipt(), 1), true);
  assert.equal(gate.status().attempted, true);
  assert.equal(gate.consume(receipt(), 1), false); // A lost send cannot replay.
  gate.observeInbound(frame(50, { mark: 300, unread: 0 }, { seq: 9 }), 1);
  assert.equal(gate.status().acknowledged, false);
  gate.observeInbound(frame(50, { mark: 300, unread: 0 }, { seq: 8 }), 2);
  assert.equal(gate.status().acknowledged, false);
  gate.observeInbound(frame(50, { mark: 300, unread: 0 }, { seq: 8 }), 1);
  assert.equal(gate.status().acknowledged, true);
});

test('MAX exact receipt gate refuses changed native body and accepts read-only reconciliation', () => {
  const value = observer(), gate = createMaxExactReadGate({ observer: value, chatId: '77', messageId: '12', coveredMessageIds: ['11', '12'] });
  history(value, { seq: 3, rows: messages.map(row => row.id === 12n ? { ...row, text: 'Changed' } : row) });
  assert.equal(gate.consume(receipt(), 1), false);
  assert.equal(gate.status().attempted, false);
  const unchanged = observer(), reconcile = createMaxExactReadGate({ observer: unchanged, chatId: '77', messageId: '12', coveredMessageIds: ['11', '12'] });
  history(unchanged, { seq: 3, mark: 300, unread: 0 });
  assert.equal(reconcile.status().acknowledged, true);
  assert.equal(reconcile.status().attempted, false);
});

test('MAX SAME websocket guard blocks compressed opcode50 and grants one exact consumed frame', async () => {
  let route, inbound, outbound; const serverTraffic = [], clientTraffic = [];
  const context = { routeWebSocket: async (_pattern, callback) => { route = callback; } };
  const state = await installPassiveReadGuard(context);
  route({ url: () => 'wss://api.oneme.ru/websocket', send: value => clientTraffic.push(value),
    onMessage: callback => { outbound = callback; }, connectToServer: () => ({
      onMessage: callback => { inbound = callback; }, send: value => serverTraffic.push(value) }) });
  inbound(frame(19, { profile: { contact: { id: 111n } } }));
  outbound(frame(49, { chatId: 77n, backward: 100, from: -1 }, { cmd: 0, seq: 2 }));
  inbound(frame(49, { chat: { id: 77n, participants: { 111: 100 }, newMessages: 2 }, messages }, { seq: 2 }));
  state.exactReadGate = createMaxExactReadGate({ observer: state.native, chatId: '77', messageId: '12', coveredMessageIds: ['11', '12'] });
  outbound(receipt()); assert.equal(serverTraffic.length, 1);
  outbound(frame(49, { chatId: 77n, backward: 100, from: -1 }, { cmd: 0, seq: 3 }));
  inbound(frame(49, { chat: { id: 77n, participants: { 111: 100 }, newMessages: 2 }, messages }, { seq: 3 }));
  outbound(receipt()); assert.equal(serverTraffic.length, 3);
  outbound(receipt()); assert.equal(serverTraffic.length, 3);
  inbound(frame(50, { mark: 300, unread: 0 }, { seq: 8 }));
  assert.equal(state.exactReadGate.status().acknowledged, true);
  assert.equal(state.forwardedReadFrames, 1);
  assert.equal(clientTraffic.length, 4);
});

test('MAX ACK arguments are separate from task/passive read and require exact committed refs', () => {
  const revision = 'a'.repeat(64), scope = `max-conversation/v1.${'b'.repeat(64)}`;
  const args = ['ack-reference', '--chat', 'https://web.max.ru/77', '--message-id', '12', '--expected-revision', revision,
    '--expected-conversation-key', scope, '--covered-reference', `12:${revision}`];
  const environment = { TRELIO_SKILL_ID: 'max-web', TRELIO_SKILL_RUNTIME_VERSION: '2.11.0',
    TRELIO_SKILL_COMPANY_ID: '11111111-1111-4111-8111-111111111111',
    TRELIO_SKILL_MEMBER_ID: '22222222-2222-4222-8222-222222222222',
    TRELIO_SKILL_CONNECTION_ID: '33333333-3333-4333-8333-333333333333' };
  const parse = args => parseArguments(args, environment);
  assert.doesNotThrow(() => validateCommandOptions(parse([...args, '--confirm'])));
  assert.doesNotThrow(() => validateCommandOptions(parse([...args, '--verify-only'])));
  for (const tail of [[], ['--confirm', '--verify-only'], ['--confirm', '--message', 'forbidden'], ['--confirm', '--cursor', 'bad']]) {
    assert.throws(() => validateCommandOptions(parse([...args, ...tail])));
  }
  assert.throws(() => validateCommandOptions(parse(['monitor', '--chat', 'https://web.max.ru/77', '--verify-only'])));
});

const nativeOptions={companyId:'11111111-1111-4111-8111-111111111111',memberId:'22222222-2222-4222-8222-222222222222',
  connectionId:'33333333-3333-4333-8333-333333333333',chat:'https://web.max.ru/77',limit:1,conversationReferences:true};
const rendered=rows=>({chatReference:{url:'https://web.max.ru/77',stableId:'77'},
  messages:rows.map(row=>({providerMessageId:row.id.toString(),text:row.text??'',replyText:null,attachments:[]}))});

test('native MAX initial unread is paged into the same cursor and later reads elsewhere cannot hide new events',()=>{
  const value=observer(),joined=joinMaxNativeSnapshot(rendered(messages),value);
  const first=projectMaxMonitorSnapshot(joined,{...nativeOptions,unreadBackfill:true});
  assert.deepEqual(first.events.map(row=>row.id),['message:77:11']);assert.equal(first.hasMore,true);
  assert.equal(first.baselineOnly,false);assert.equal(first.coverage.initialUnreadOnly,true);
  assert.equal(first.coverage.nativeMessageVerified,true);assert.equal(first.readState.readReceiptsSent,false);
  assert.equal(JSON.parse(Buffer.from(first.nextCursor,'base64url')).v,2);
  const second=projectMaxMonitorSnapshot(joined,{...nativeOptions,cursor:first.nextCursor});
  assert.deepEqual(second.events.map(row=>row.id),['message:77:12']);assert.equal(second.hasMore,false);
  const later=[...messages,{id:13n,sender:222n,time:400,text:'Read on another device'}];
  history(value,{seq:3,rows:later,mark:400,unread:0});
  const third=projectMaxMonitorSnapshot(joinMaxNativeSnapshot(rendered(later),value),{...nativeOptions,cursor:second.nextCursor});
  assert.deepEqual(third.events.map(row=>row.id),['message:77:13']);
  const incomplete=joinMaxNativeSnapshot(rendered(messages),observer());incomplete.nativeUnreadMessageIds=null;
  assert.throws(()=>projectMaxMonitorSnapshot(incomplete,{...nativeOptions,unreadBackfill:true}),/initial native MAX unread/);
  assert.throws(()=>projectMaxMonitorSnapshot(rendered(messages),nativeOptions),/Native MAX message identity/);
});

test('native MAX empty baseline progresses only with complete native timeline proof, and hidden edits change revision',()=>{
  const value=observer();
  value.observeOutbound(frame(49,{chatId:77n,from:-1,backward:100},{cmd:0,seq:3}),1);
  value.observeInbound(frame(49,{chat:{id:77n,participants:{111:0},newMessages:0,messagesCount:0},messages:[]},{seq:3}),1);
  const empty=joinMaxNativeSnapshot({...rendered([]),emptyState:'direct-chat-empty'},value);
  const first=projectMaxMonitorSnapshot(empty,{...nativeOptions,unreadBackfill:true});assert.equal(first.baselineOnly,true);
  value.observeOutbound(frame(49,{chatId:77n,from:-1,backward:100},{cmd:0,seq:4}),1);
  value.observeInbound(frame(49,{chat:{id:77n,participants:{111:0},newMessages:1,messagesCount:1},messages:[messages[1]]},{seq:4}),1);
  const complete=joinMaxNativeSnapshot(rendered([messages[1]]),value);
  const next=projectMaxMonitorSnapshot(complete,{...nativeOptions,cursor:first.nextCursor});assert.equal(next.events.length,1);
  assert.throws(()=>projectMaxMonitorSnapshot({...complete,nativeFullTimelineVerified:false},{...nativeOptions,cursor:first.nextCursor}),/initial-history review/);
  const revision=next.events[0].revision;
  history(value,{seq:5,rows:[{...messages[1],attaches:[{type:'FILE',fileId:999n}]}],mark:100,unread:1});
  const edit=projectMaxMonitorSnapshot(joinMaxNativeSnapshot(rendered([messages[1]]),value),{...nativeOptions,cursor:next.nextCursor});
  assert.equal(edit.events[0].kind,'edit');assert.notEqual(edit.events[0].revision,revision);
});

test('native MAX range is chronological rather than numeric ID ordering and rejects altered covered attachments',()=>{
  const rows=[{id:90n,sender:222n,time:200,text:'Earlier'},{id:12n,sender:333n,time:300,text:'Latest'}];
  const value=observer();history(value,{seq:3,rows,mark:100,unread:2});
  assert.equal(inspectMaxReadCoverage({history:value.snapshot('77'),messageId:'12',coveredMessageIds:['90','12']}).interval.length,2);
  assert.throws(()=>inspectMaxReadCoverage({history:value.snapshot('77'),messageId:'12',coveredMessageIds:['12']}));
  const gate=createMaxExactReadGate({observer:value,chatId:'77',messageId:'12',coveredMessageIds:['90','12']});
  history(value,{seq:4,rows:[{...rows[0],attaches:[{type:'FILE',fileId:999n}]},rows[1]],mark:100,unread:2});
  assert.equal(gate.consume(receipt(),1),false);assert.equal(gate.status().attempted,false);
});

test('MAX MessagePack uint64 timestamps remain exact and unsafe times never authorize ACK',()=>{
  const value=observer(),base=1792690000000n;
  value.observeOutbound(frame(49,{chatId:77n,from:-1n,backward:100},{cmd:0,seq:3}),1);
  value.observeInbound(frame(49,{chat:{id:77n,participants:{111:base},newMessages:1},
    messages:[{id:12n,sender:222n,time:base+1000n,text:'Synthetic'}]},{seq:3}),1);
  assert.equal(value.snapshot('77').messages[0].time,Number(base+1000n));
  const gate=createMaxExactReadGate({observer:value,chatId:'77',messageId:'12',coveredMessageIds:['12']});
  value.observeOutbound(frame(49,{chatId:77n,from:-1n,backward:100},{cmd:0,seq:4}),1);
  value.observeInbound(frame(49,{chat:{id:77n,participants:{111:base},newMessages:1},
    messages:[{id:12n,sender:222n,time:base+1000n,text:'Synthetic'}]},{seq:4}),1);
  assert.equal(gate.consume(frame(50,{type:'READ_MESSAGE',chatId:77n,messageId:12n,mark:base+1000n},{cmd:0,seq:8}),1),true);
  gate.observeInbound(frame(50,{mark:base+1000n,unread:0},{seq:8}),1);assert.equal(gate.status().acknowledged,true);
  history(value,{seq:5,rows:[{id:13n,sender:222n,time:9007199254740992n,text:'Unsafe'}],mark:0,unread:1});
  assert.equal(value.snapshot('77'),null);
});


test('MAX outgoing hint reads the SAME browser-observed native chat without another socket or send',async()=>{
  let route,inbound,outbound;const traffic=[];
  const context={routeWebSocket:async(_pattern,callback)=>{route=callback;}};
  await installPassiveReadGuard(context);
  route({url:()=> 'wss://api.oneme.ru/websocket',send:()=>{},onMessage:callback=>{outbound=callback;},
    connectToServer:()=>({onMessage:callback=>{inbound=callback;},send:value=>traffic.push(value)})});
  inbound(frame(19,{profile:{contact:{id:111n}}}));
  outbound(frame(49,{chatId:77n,backward:100,from:-1},{cmd:0,seq:2}));
  inbound(frame(49,{chat:{id:77n,participants:{111:100},newMessages:2},messages},{seq:2}));
  const options={companyId:'11111111-1111-4111-8111-111111111111',memberId:'22222222-2222-4222-8222-222222222222',
    connectionId:'33333333-3333-4333-8333-333333333333',chat:'https://web.max.ru/77',
    account:{id:'44444444-4444-4444-8444-444444444444',companyBinding:'a'.repeat(64)}};
  const page={context:()=>context,url:()=>options.chat,evaluate:async()=>({ready:true,title:'PRIVATE_TITLE'})};
  const expected=maxConversationReference({url:options.chat,stableId:'77'},options,true).conversationKey;
  assert.deepEqual(await outgoingMaxConversationReference(page,options,{url:options.chat}),{available:true,conversationKey:expected});
  assert.equal(traffic.length,1,'hint emits neither native history nor mutation/ACK');
  assert.deepEqual(await outgoingMaxConversationReference(page,options,{url:'https://web.max.ru/88'}),
    {available:false,code:'MAX_CONVERSATION_REFERENCE_UNAVAILABLE'});
});

test('MAX account discovery observes only the native full-sync marker chain and projects no chat content',async()=>{
  const {projectMaxAccountSnapshot,parseMaxAccountCursor}=await import('../scripts/trelio-max.mjs');
  const selected={companyId:'11111111-1111-4111-8111-111111111111',memberId:'22222222-2222-4222-8222-222222222222',connectionId:'44444444-4444-4444-8444-444444444444',
    account:{id:'33333333-3333-4333-8333-333333333333',companyBinding:'a'.repeat(64)}};
  const value=createMaxNativeObserver();
  // A partial cache sync, an arbitrary UI list and a naked response cannot
  // supply an account inventory. The observer never retains the token/body.
  value.observeInbound(frame(19,{profile:{contact:{id:111n}},chats:[{id:77n}],time:1000,chatMarker:0}),1);
  assert.equal(value.accountSnapshot(),null);
  value.observeOutbound(frame(19,{token:'SYNTHETIC_SECRET',chatsSync:0},{cmd:0,seq:3}),1);
  value.observeInbound(frame(19,{profile:{contact:{id:111n}},chats:[{id:77n,lastEventTime:800,newMessages:1,title:'PRIVATE_TITLE',lastMessage:{text:'PRIVATE_BODY'}}],time:1000,chatMarker:900},{seq:3}),1);
  assert.equal(value.accountSnapshot().complete,false);
  assert.throws(()=>projectMaxAccountSnapshot(value.accountSnapshot(),selected),/MAX monitor|MAX dialog/iu);
  value.observeOutbound(frame(53,{marker:900},{cmd:0,seq:4}),1);
  value.observeInbound(frame(53,{chats:[{id:-88n,lastEventTime:850,newMessages:1},{id:0n,lastEventTime:0,newMessages:0}],marker:0},{seq:4,compressed:true}),2);
  assert.equal(value.accountSnapshot().complete,false,'another socket cannot finish the chain');
  value.observeInbound(frame(53,{chats:[{id:-88n,lastEventTime:850,newMessages:1},{id:0n,lastEventTime:0,newMessages:0}],marker:0},{seq:4,compressed:true}),1);
  const snapshot=value.accountSnapshot();assert.equal(snapshot.complete,true);assert.deepEqual(snapshot.chats.map(row=>row.chatId),['-88','77']);
  const page=projectMaxAccountSnapshot(snapshot,selected);
  assert.deepEqual(page.conversationsToSync,['-88','77']);assert.deepEqual(page.events,[]);assert.equal(page.coverage.unreadOnly,false);
  assert.equal(parseMaxAccountCursor(page.nextCursor).startedAt,1000);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE_|SYNTHETIC_|111|viewerId|token|title|text/);
  const later=projectMaxAccountSnapshot({...snapshot,time:2000},{...selected,cursor:page.nextCursor});assert.equal(later.initialAccountCursor,page.nextCursor);assert.equal(parseMaxAccountCursor(later.nextCursor).startedAt,2000);assert.deepEqual(later.conversationsToSync,[]);
  assert.throws(()=>projectMaxAccountSnapshot({...snapshot,viewerId:'222'}, {...selected,cursor:page.nextCursor}),/baseline changed/);
  const stale=createMaxNativeObserver();stale.observeOutbound(frame(19,{chatsSync:100},{cmd:0}),1);
  stale.observeInbound(frame(19,{profile:{contact:{id:111n}},chats:[],time:1000,chatMarker:0}),1);assert.equal(stale.accountSnapshot(),null);
});

test('MAX newly discovered history includes already-read messages after the ORIGINAL account baseline',async()=>{
  const {projectMaxAccountSnapshot}=await import('../scripts/trelio-max.mjs');
  const selected={companyId:'11111111-1111-4111-8111-111111111111',memberId:'22222222-2222-4222-8222-222222222222',connectionId:'44444444-4444-4444-8444-444444444444',
    account:{id:'33333333-3333-4333-8333-333333333333',companyBinding:'a'.repeat(64)},chat:'https://web.max.ru/77',conversationReferences:true,limit:1};
  const initial=projectMaxAccountSnapshot({viewerId:'111',time:150,complete:true,chats:[{chatId:'77',lastEventTime:100,unread:1}]},selected).nextCursor;
  const value=observer();history(value,{mark:300,unread:0});
  const joined=joinMaxNativeSnapshot({chatReference:{url:selected.chat,stableId:'77'},messages:messages.map(row=>({providerMessageId:row.id.toString(),text:row.text,replyText:null,attachments:[]}))},value);
  const first=projectMaxMonitorSnapshot(joined,{...selected,initialAccountCursor:initial});
  assert.deepEqual(first.events.map(row=>row.messageId),['11']);assert.equal(first.hasMore,true);
  const second=projectMaxMonitorSnapshot(joined,{...selected,cursor:first.nextCursor});assert.deepEqual(second.events.map(row=>row.messageId),['12']);
  assert.equal(projectMaxMonitorSnapshot(joined,{...selected,cursor:second.nextCursor}).events.length,0);
  const missing={...joined,messages:joined.messages.filter(row=>row.providerMessageId!=='12')};
  assert.throws(()=>projectMaxMonitorSnapshot(missing,{...selected,initialAccountCursor:initial}),/fully rendered/);
  assert.throws(()=>projectMaxMonitorSnapshot({...joined,nativeWindowStart:200,nativeFullTimelineVerified:false},{...selected,initialAccountCursor:initial}),/original account baseline/);
  for(const argv of [['monitor','--account-discovery','--conversation-references'],['monitor','--chat',selected.chat,'--conversation-references','--initial-account-cursor',initial]])
    validateCommandOptions(parseArguments(argv,{TRELIO_SKILL_ID:'max-web',TRELIO_SKILL_RUNTIME_VERSION:'2.12.0',TRELIO_SKILL_COMPANY_ID:selected.companyId,TRELIO_SKILL_MEMBER_ID:selected.memberId,TRELIO_SKILL_CONNECTION_ID:selected.connectionId}));
  for(const argv of [['monitor','--account-discovery','--chat',selected.chat,'--conversation-references'],['read','--account-discovery'],['monitor','--account-discovery']])
    assert.throws(()=>validateCommandOptions(parseArguments(argv,{TRELIO_SKILL_ID:'max-web',TRELIO_SKILL_RUNTIME_VERSION:'2.12.0',TRELIO_SKILL_COMPANY_ID:selected.companyId,TRELIO_SKILL_MEMBER_ID:selected.memberId,TRELIO_SKILL_CONNECTION_ID:selected.connectionId})));
});


test('MAX account monitor navigates the SAME guarded browser and uses only browser-emitted full inventory',async()=>{
  const {readMaxAccountMonitor}=await import('../scripts/trelio-max.mjs');
  let route,inbound,outbound,navigations=0;const sent=[];
  const context={routeWebSocket:async(_pattern,callback)=>{route=callback;}};await installPassiveReadGuard(context);
  route({url:()=> 'wss://api.oneme.ru/websocket',send:()=>{},onMessage:callback=>{outbound=callback;},
    connectToServer:()=>({onMessage:callback=>{inbound=callback;},send:value=>sent.push(value)})});
  const options={companyId:'11111111-1111-4111-8111-111111111111',memberId:'22222222-2222-4222-8222-222222222222',
    connectionId:'44444444-4444-4444-8444-444444444444',account:{id:'33333333-3333-4333-8333-333333333333',companyBinding:'a'.repeat(64)},timeoutMs:500};
  const page={context:()=>context,goto:async(url)=>{assert.equal(url,'https://web.max.ru/');navigations++;
    // The ordinary browser navigation, not the monitor, emits protocol frames.
    outbound(frame(19,{token:'SYNTHETIC_PRIVATE_TOKEN',chatsSync:0},{cmd:0,seq:1}));
    inbound(frame(19,{profile:{contact:{id:111n}},time:1000,chats:[{id:77n,lastEventTime:800,newMessages:0}],chatMarker:900},{seq:1}));
    outbound(frame(53,{marker:900},{cmd:0,seq:2}));
    inbound(frame(53,{chats:[{id:88n,lastEventTime:850}],marker:0},{seq:2}));},
    waitForFunction:async()=>{},evaluate:async()=>({authenticatedReady:true,loginReady:false}),waitForTimeout:async()=>assert.fail('complete inventory is already observed')};
  const result=await readMaxAccountMonitor(page,options);assert.equal(navigations,1);assert.deepEqual(result.conversationsToSync,['88']);
  assert.equal(sent.length,2);assert.deepEqual(sent.map(value=>inspectMaxFrameHeader(value).opcode),[19,53]);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|token|viewerId|profile/);
});
