import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { identity, credentials, Fault, hash } from '../scripts/core.mjs';
import { CalDAV, appleUrl, multistatus, escapeXml } from '../scripts/caldav.mjs';
import { createEvent, mutateEvent, occurrences, parse, freeWindows, fingerprint } from '../scripts/events.mjs';
import { CalendarOperations } from '../scripts/operations.mjs';
import { Store, privateProcess } from '../scripts/storage.mjs';
import { configure } from '../scripts/setup.mjs';
import { argumentsOf, execute } from '../scripts/trelio-apple-calendar.mjs';

const owner = () => ({ account: crypto.randomUUID(), company: crypto.randomUUID(), member: crypto.randomUUID(), binding: 'a'.repeat(64) });
const auth = { username: 'synthetic@example.test', password: 'abcd-efgh-ijkl-mnop' };
const calendar = { id: 'c'.repeat(32), url: 'https://p01-caldav.icloud.com/123/calendars/work/', name: 'Synthetic calendar', writable: true, canCreate: true, canDelete: true };
function memory() {
  let state = { version: 1, credentials: auth, preferences: { calendars: [calendar.id], timezone: 'Europe/Moscow' }, plans: {}, operations: {}, references: {} };
  return { owner: owner(), read: async () => structuredClone(state), write: async value => { state = structuredClone(value); } };
}
const changes = (extra = {}) => ({ title: 'Планирование', start: '2027-03-02T10:00:00', end: '2027-03-02T11:00:00', timezone: 'Europe/Moscow', ...extra });
const range = ['2027-03-01T00:00:00Z','2027-04-01T00:00:00Z'];
function resource(data) { return { data, id: 'e'.repeat(32), calendarId: calendar.id, etag: '"1"' }; }
function provider() {
  const resources = new Map(); const calls = []; let fail = false, normalize = false;
  const client = { addresses: ['mailto:synthetic@example.test'], calendars: async () => [calendar],
    events: async () => [...resources].map(([url,value]) => ({ ...resource(value.text), url, etag: value.etag, id: hash(url).slice(0,32) })),
    get: async url => resources.has(url) ? { ...resources.get(url), url } : { missing: true },
    request: async (method,url,options) => {
      calls.push({ method,url,options });
      if (method === 'DELETE') resources.delete(url);
      else resources.set(url, { text: normalize ? options.body.replace('Планирование','Changed on server') : options.body, etag: '"2"' });
      if (fail) throw new Fault('network_outcome_unknown');
      return { status: 201 };
    } };
  return { client, resources, calls, fail: value => { fail = value; }, normalize: value => { normalize = value; } };
}

test('host identity and app password are validated without accepting arbitrary endpoints or env credentials', () => {
  assert.throws(() => identity({}), { code: 'host_identity_required' });
  const o = owner(); const env = { TRELIO_SKILL_ID: 'apple-calendar', TRELIO_SKILL_COMPANY_ID: o.company,
    TRELIO_SKILL_MEMBER_ID: o.member, TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: o.account, providerRef: null, companyBinding: o.binding }) };
  assert.deepEqual(identity(env), o);
  assert.deepEqual(credentials(auth), auth);
  for (const password of ['primary-password', 'secret\nvalue', '']) assert.throws(() => credentials({ ...auth,password }));
  for (const url of ['http://caldav.icloud.com/', 'https://caldav.icloud.com.evil.test/', 'https://user@caldav.icloud.com/',
    'https://caldav.icloud.com:444/', 'https://example.test/', 'https://caldav.icloud.com/a%2fb']) assert.throws(() => appleUrl(url));
});

test('actual HTTP adapter validates redirect before sending Authorization and never redirects writes', async () => {
  const calls = [];
  const client = new CalDAV(auth, { fetcher: async (url,options) => { calls.push({url,options}); return new Response(null,{status:302,headers:{location:'https://attacker.example.test/'}}); } });
  await assert.rejects(client.get('https://caldav.icloud.com/'), { code: 'server_origin_denied' });
  assert.equal(calls.length,1); assert.match(calls[0].options.headers.Authorization,/^Basic /);
  await assert.rejects(client.request('PUT','https://caldav.icloud.com/a',{body:'synthetic'}), { code:'write_redirect_requires_reconciliation' });
  assert.equal(calls.length,2);
});
const prop = (url,body,status='') => `<x:response><x:href>${escapeXml(url)}</x:href>${status ? `<x:status>${status}</x:status>` : `<x:propstat><x:prop>${body}</x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat>`}</x:response>`;
const multi = body => `<x:multistatus xmlns:x="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</x:multistatus>`;
test('CalDAV principal/home discovery, shared privileges and REPORT use parsed namespaces and exact collection scope', async () => {
  const raw = createEvent(changes(), 'UTC'); let step=0;
  const responses = [multi(prop('https://caldav.icloud.com/','<x:current-user-principal><x:href>/123/principal/</x:href></x:current-user-principal>')),
    multi(prop('https://caldav.icloud.com/123/principal/','<c:calendar-home-set><x:href>https://p01-caldav.icloud.com/123/calendars/</x:href></c:calendar-home-set><c:calendar-user-address-set><x:href>mailto:synthetic@example.test</x:href></c:calendar-user-address-set>')),
    multi(prop(calendar.url,'<x:resourcetype><x:collection/><c:calendar/></x:resourcetype><x:displayname>Работа</x:displayname><x:current-user-privilege-set><x:privilege><x:read/></x:privilege></x:current-user-privilege-set><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>')),
    multi(prop(calendar.url+'one.ics',`<x:getetag>"one"</x:getetag><c:calendar-data>${escapeXml(raw)}</c:calendar-data>`))];
  const client = new CalDAV(auth,{fetcher:async (_url, options)=> { assert.ok(['PROPFIND','REPORT'].includes(options.method)); return new Response(responses[step++],{status:207}); }});
  const rows = await client.calendars(); assert.equal(rows[0].name,'Работа'); assert.equal(rows[0].writable,false);
  assert.deepEqual(client.addresses,['mailto:synthetic@example.test']);
  const events = await client.events(rows[0],...range); assert.equal(events[0].data,raw); assert.equal(events[0].etag,'"one"');
  assert.throws(()=>multistatus('<!DOCTYPE x><x/>',calendar.url),{code:'xml_invalid'});
  assert.throws(()=>multistatus(multi(prop('https://evil.example.test/a','')),calendar.url));
});

test('weekly recurrence preserves wall time across DST; all-day end is exclusive', () => {
  const data = createEvent(changes({ start:'2027-03-21T09:00:00', end:'2027-03-21T10:00:00', timezone:'Europe/Berlin', recurrence:'FREQ=WEEKLY;COUNT=3' }), 'UTC');
  const rows = occurrences(resource(data),'2027-03-20T00:00:00Z','2027-04-08T00:00:00Z');
  assert.deepEqual(rows.map(row=>row.start),['2027-03-21T08:00:00.000Z','2027-03-28T07:00:00.000Z','2027-04-04T07:00:00.000Z']);
  const day = createEvent(changes({start:'2027-03-02',end:'2027-03-03',allDay:true}), 'UTC');
  const [event] = occurrences(resource(day),...range); assert.equal(event.allDay,true); assert.equal(Date.parse(event.end)-Date.parse(event.start),86400000);
  assert.throws(()=>createEvent(changes({start:'2027-03-28T02:30:00',end:'2027-03-28T04:00:00',timezone:'Europe/Berlin'}),'UTC'),{code:'event_time_invalid_or_ambiguous'});
});
test('single-instance move/cancellation preserve series, alarms and detached recurrence identity', () => {
  const data = createEvent(changes({recurrence:'FREQ=DAILY;COUNT=3',alarms:[15]}),'UTC');
  const id = occurrences(resource(data),...range)[1].recurrenceId;
  const moved = mutateEvent(data,{action:'update',scope:'occurrence',recurrenceId:id,changes:{start:'2027-03-10T10:00:00',end:'2027-03-10T11:00:00'}},'Europe/Moscow',[]);
  const rows = occurrences(resource(moved),...range); assert.equal(rows.length,3); assert.equal(rows.find(row=>row.recurrenceId===id).start,'2027-03-10T07:00:00.000Z');
  const cancelled = mutateEvent(moved,{action:'delete',scope:'occurrence',recurrenceId:id},'Europe/Moscow',[]);
  assert.equal(occurrences(resource(cancelled),...range).length,2);
  assert.equal(parse(moved).getFirstSubcomponent('vevent').getAllSubcomponents('valarm').length,1);
  assert.throws(()=>mutateEvent(moved,{action:'update',scope:'series',changes:{recurrence:null}},'UTC',[]),{code:'recurrence_has_exceptions'});
});
test('EXDATE/RDATE, moved-in exceptions and transparent/free windows retain correct coverage', () => {
  const data = createEvent(changes({recurrence:'FREQ=DAILY;COUNT=2'}),'UTC').replace('END:VEVENT','EXDATE;TZID=Europe/Moscow:20270303T100000\r\nRDATE;TZID=Europe/Moscow:20270310T100000\r\nEND:VEVENT');
  const rows = occurrences(resource(data),...range); assert.equal(rows.length,2); assert.match(rows[1].start,/2027-03-10/);
  const free = freeWindows([{start:'2027-03-01T10:00:00Z',end:'2027-03-01T11:00:00Z',status:'CONFIRMED',transparency:'OPAQUE'},
    {start:'2027-03-01T12:00:00Z',end:'2027-03-01T13:00:00Z',transparency:'TRANSPARENT'}],'2027-03-01T09:00:00Z','2027-03-01T14:00:00Z',60);
  assert.equal(free.length,2); assert.equal(free[1].end,'2027-03-01T14:00:00.000Z');
});
test('RSVP changes only verified attendee, preserves organizer revision and refuses edits by attendee', () => {
  const data = createEvent(changes({attendees:[{email:'other@example.test'}]}),'UTC','mailto:synthetic@example.test');
  assert.throws(()=>mutateEvent(data,{action:'update',scope:'series',changes:{title:'hijack'}},'UTC',['mailto:other@example.test']),{code:'organizer_required'});
  const result = mutateEvent(data,{action:'reply',scope:'series',response:'ACCEPTED'},'UTC',['mailto:other@example.test']);
  assert.equal(parse(result).getFirstSubcomponent('vevent').getFirstProperty('attendee').getParameter('partstat'),'ACCEPTED');
  assert.equal(parse(result).getFirstSubcomponent('vevent').getFirstPropertyValue('sequence'),1);
  assert.throws(()=>mutateEvent(data,{action:'reply',scope:'series',response:'ACCEPTED'},'UTC',['mailto:unrelated@example.test']));
});

test('one-use plan persists unknown BEFORE write, has CAS, and lost result is reconciled without dispatch', async () => {
  const store=memory(), p=provider(), ops=new CalendarOperations(store,{makeClient:()=>p.client});
  const plan=await ops.plan({action:'create',calendarId:calendar.id,changes:changes()});
  p.fail(true);
  const request=p.client.request; p.client.request=async (...args)=> { assert.equal((await store.read()).operations[plan.planId].state,'unknown'); return request(...args); };
  await assert.rejects(ops.apply(plan.planId,plan.planHash),{code:'network_outcome_unknown'});
  assert.equal(p.calls[0].options.headers['If-None-Match'],'*');
  await assert.rejects(ops.plan({action:'create',calendarId:calendar.id,changes:changes()}),{code:'unknown_write_pending'});
  await assert.rejects(ops.apply(plan.planId,plan.planHash),{code:'operation_already_dispatched'});
  const receipt=await ops.reconcile(plan.planId); assert.equal(receipt.state,'verified'); assert.equal(p.calls.length,1);
  assert.equal((await ops.reconcile(plan.planId)).state,'verified');
});
test('fresh ETag conflict, expired plan, wrong company and read-only calendar stop before dispatch', async () => {
  const store=memory(),p=provider(),ops=new CalendarOperations(store,{makeClient:()=>p.client});
  const url=calendar.url+'event.ics';p.resources.set(url,{text:createEvent(changes(),'UTC'),etag:'"old"'});
  const rows=await ops.list({from:range[0],to:range[1]}); const spec={action:'update',calendarId:calendar.id,eventId:rows.events[0].id,scope:'series',changes:{title:'Changed'}};
  const plan=await ops.plan(spec);p.resources.get(url).etag='"new"';
  await assert.rejects(ops.apply(plan.planId,plan.planHash),{code:'calendar_changed'});assert.equal(p.calls.length,0);
  store.owner.company=crypto.randomUUID();await assert.rejects(ops.apply(plan.planId,plan.planHash),{code:'plan_invalid'});
  const expired = new CalendarOperations(store,{makeClient:()=>p.client,clock:()=>Date.now()+3600000});
  store.owner.company=owner().company;
  p.client.calendars=async()=>[{...calendar,writable:false}];await assert.rejects(ops.plan(spec),{code:'calendar_read_only'});
});
test('mismatching server read-back retains unknown, and DELETE verifies only exact absence', async () => {
  const store=memory(),p=provider(),ops=new CalendarOperations(store,{makeClient:()=>p.client});
  const plan=await ops.plan({action:'create',calendarId:calendar.id,changes:changes()});p.normalize(true);
  assert.equal((await ops.apply(plan.planId,plan.planHash)).state,'unknown'); assert.equal(p.calls.length,1);
  const store2=memory(),p2=provider(),ops2=new CalendarOperations(store2,{makeClient:()=>p2.client});
  const made=await ops2.plan({action:'create',calendarId:calendar.id,changes:changes()});const created=await ops2.apply(made.planId,made.planHash);
  const deletion=await ops2.plan({action:'delete',calendarId:calendar.id,eventId:created.eventId,scope:'series'});
  assert.equal((await ops2.apply(deletion.planId,deletion.planHash)).state,'verified'); assert.equal(p2.calls.at(-1).options.headers['If-Match'],'"2"');
});

test('packaged CLI guides/importer need no credentials, reject unknown flags, and signed policies have exact commands', async () => {
  const env={...process.env,TRELIO_SKILL_ID:'apple-calendar',TRELIO_SKILL_COMPANY_ID:crypto.randomUUID(),TRELIO_SKILL_MEMBER_ID:crypto.randomUUID()};delete env.TRELIO_SKILL_ACCOUNT_JSON;
  const cli=fileURLToPath(new URL('../scripts/trelio-apple-calendar.mjs',import.meta.url));
  for(const command of ['guides','__trelio_accounts_import']) {
    const result=spawnSync(process.execPath,[cli,command],{env,encoding:'utf8',shell:false});assert.equal(result.status,0,result.stdout);assert.equal(result.stderr,'');
    const json=JSON.parse(result.stdout);if(command==='guides') { const item=json.requiredFiles[0];const bytes=await fs.readFile(item.path);assert.equal(bytes.length,item.sizeBytes);assert.equal(hash(bytes),item.sha256); }
    else assert.deepEqual(json,{schemaVersion:1,accounts:[]});
  }
  assert.throws(()=>argumentsOf(['read','--endpoint','https://evil.example.test']));
  const policy=JSON.parse(await fs.readFile(new URL('../trelio-assistant-execution.json',import.meta.url)));
  assert.ok(!policy.taskCommands.some(value=>['configure','disconnect','recover-lock'].includes(value[0])));
});

test('native secure vault cold-start, Unicode path, account binding, tamper refusal and process lock', {skip:!['darwin','win32'].includes(process.platform),timeout:180000}, async t => {
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'apple-calendar-тест-')));
  const root=path.join(parent,'private'),o=owner(),store=new Store(root,o);t.after(async()=>{store.close();await fs.rm(parent,{recursive:true,force:true});});
  await store.init();await store.lock(async()=>{const state=await store.read();state.credentials=auth;await store.write(state);assert.deepEqual((await store.read()).credentials,auth);
    await assert.rejects(new Store(root,o).lock(async()=>{}),{code:'account_busy_or_recovery_required'});});
  const file=path.join(store.dir,'state.enc'),bytes=await fs.readFile(file,'utf8');assert.ok(!bytes.includes(auth.password));assert.ok(!bytes.includes(auth.username));
  const tampered=bytes.replace(/[a-zA-Z0-9](?=[^a-zA-Z0-9]*$)/,'!');await fs.writeFile(file,tampered);
  await assert.rejects(store.read());
  if(process.platform==='darwin') {
    // Synthetic account only: remove the key created by this test through the
    // same compiled helper. Never enumerate or modify a human Keychain entry.
    const native=path.join(root,'native','apple-calendar');const binary=path.join(native,(await fs.readdir(native))[0]);
    await privateProcess(binary,[],JSON.stringify({account:o.account,mode:'delete'}));
  }
});

// Real HTTP form transport and actual shared renderer, with synthetic human
// submits. No credentials or form HTML are printed. The hosted checkout pins
// the public contract; a local maintainer may point to that exact module.
const contractModule = process.env.TRELIO_TEST_FORM_MODULE_URL || new URL('../../../_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-workspace.mjs',import.meta.url).href;
function visit(url, method='GET', body='', supplied={}) {
  return new Promise((resolve,reject)=> {
    const target=new URL(url),headers=method==='GET'?{'sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-site':'none'}:
      {origin:target.origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'navigate','sec-fetch-dest':'document','content-type':'application/x-www-form-urlencoded'};
    const request=http.request(url,{method,headers:{...headers,...supplied}},response=> { const chunks=[];response.on('data',value=>chunks.push(value));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()})); });
    request.on('error',reject);request.end(body);
  });
}
test('protected shared form: rejects invalid credentials and saves after a fresh human submit', async()=> {
  const store=memory();let writes=0;const save=store.write;store.write=async value=>{writes++;await save(value);};
  let attempts=0;
  const result=await configure(store,{formModule:contractModule,makeClient:()=>({calendars:async()=>{if(++attempts===1)throw new Fault('needs_reconnect');return[calendar];}}),open:async url=>{
    const first=await visit(url);assert.equal(first.status,200);assert.match(first.body,/data-trelio-local-form/);
    // Exercise the actual host-rendered page: the user can reach account
    // management without a support redirect, and password entry stays local.
    assert.match(first.body, /href="https:\/\/account\.apple\.com\/"/);
    assert.match(first.body, /Вход в учётную запись и безопасность/);
    assert.match(first.body, /Пароли приложений/);
    assert.match(first.body, /Trelio Calendar/);
    assert.match(first.body, /Форма действует 5 минут/);
    assert.ok(!first.body.includes('support.apple.com'));
    const nonce=first.body.match(/name="nonce" value="([^"]+)"/)[1];
    const post=values=>visit(url,'POST',new URLSearchParams({nonce,decision:'save',...values}).toString(),{origin:'null'});
    const failure=await post(auth);assert.equal(failure.status,422);assert.ok(!failure.body.includes(auth.password));assert.equal(writes,0);
    assert.match(failure.body, /href="https:\/\/account\.apple\.com\/"/);
    assert.equal(attempts,1);
    const done=await post(auth);assert.equal(done.status,200);assert.equal(writes,1);
    assert.ok(!done.body.includes(auth.username));
  }});
  assert.equal(result.configured,true);assert.equal((await store.read()).credentials.username,auth.username);
});
test('one credential submit saves all calendars and device timezone despite incidental browser requests', async()=> {
  const store=memory(), initial=await store.read();initial.credentials=null;initial.preferences.calendars=[];await store.write(initial);
  const extra={...calendar,id:'d'.repeat(32),name:'Synthetic second calendar',writable:false};
  let writes=0;const persist=store.write;store.write=async state=>{writes++;await persist(state);};
  const result=await configure(store,{formModule:contractModule,detectTimezone:()=> 'America/New_York',
    makeClient:()=>({calendars:async()=>[calendar,extra]}),open:async url=>{
      // A browser can fetch an icon or probe the page independently of the
      // document. Neither request is allowed to interrupt the human submit.
      const first=await visit(url);assert.match(first.body,/Подключатся все доступные календари/);
      assert.deepEqual([...first.body.matchAll(/<input\b[^>]* name="([^"]+)"/g)].map(match=>match[1]).sort(),
        ['nonce','password','username']);
      assert.equal((await visit(new URL('/favicon.ico',url),'GET','',{'sec-fetch-dest':'image'})).status,404);
      assert.equal((await visit(url,'GET','',{'sec-fetch-dest':'empty'})).status,403);
      assert.equal(writes,0);
      const nonce=first.body.match(/name="nonce" value="([^"]+)"/)[1];
      const saved=await visit(url,'POST',new URLSearchParams({nonce,decision:'save',...auth}).toString());
      assert.equal(saved.status,200);assert.match(saved.body,/Apple Calendar подключён/);
      assert.ok(!saved.body.includes(auth.password));assert.ok(!saved.body.includes('calendar_'));
    }});
  assert.equal(writes,1);assert.equal(result.calendarCount,2);
  assert.deepEqual((await store.read()).preferences,{calendars:[calendar.id,extra.id],timezone:'America/New_York'});
});
test('one-step reconnect preserves saved scope, timezone and pending journal despite new device settings or calendars', async()=> {
  for(const pending of [false,true]) {
    const store=memory(),state=await store.read();
    state.preferences.timezone='Asia/Tokyo';state.operations=pending?{operation:{state:'unknown'}}:{};await store.write(state);
    const result=await configure(store,{formModule:contractModule,
      detectTimezone:()=>{throw Error('saved zone must not be replaced');},
      makeClient:()=>({calendars:async()=>[calendar,{...calendar,id:'d'.repeat(32)}]}),open:async url=>{
        const first=await visit(url);assert.match(first.body,/Сохранятся прежние календари и часовой пояс/);
        const nonce=first.body.match(/name="nonce" value="([^"]+)"/)[1];
        assert.equal((await visit(url,'POST',new URLSearchParams({nonce,decision:'save',...auth}).toString())).status,200);
      }});
    assert.equal(result.calendarCount,1);assert.deepEqual((await store.read()).preferences,state.preferences);
    assert.deepEqual((await store.read()).operations,state.operations);
  }
});
test('missing device timezone stops before opening the form or asking for credentials', async()=> {
  const store=memory(),initial=await store.read();initial.credentials=null;initial.preferences.calendars=[];await store.write(initial);
  await assert.rejects(configure(store,{formModule:contractModule,detectTimezone:()=>null,
    makeClient:()=>assert.fail('provider must not be called'),open:async()=>assert.fail('form must not open')}),
  {code:'setup_timezone_unavailable'});
  assert.deepEqual(await store.read(),initial);
});
test('missing saved calendar and unexpected scope fields refuse before changing the pending connection', async()=> {
  for(const extraFields of [{},{timezone:'Asia/Tokyo'},{customize:'on'}]) {
    const store=memory(),initial=await store.read();initial.operations={operation:{state:'unknown'}};await store.write(initial);
    let writes=0;store.write=async()=>{writes++;};
    const extra={...calendar,id:'d'.repeat(32)};
    const task=configure(store,{formModule:contractModule,
      makeClient:()=>({calendars:async()=>[extra]}),open:async url=>{
        const first=await visit(url);const nonce=first.body.match(/name="nonce" value="([^"]+)"/)[1];
        const post=values=>visit(url,'POST',new URLSearchParams({nonce,decision:'save',...values}).toString());
        const response=await post({...auth,...extraFields});
        assert.equal(response.status,403);
      }});
    await assert.rejects(task,Object.keys(extraFields).length ?
      {code:'setup_request_denied',details:{stage:'form_fields'}} : {code:'calendar_selection_unavailable'});
    assert.equal(writes,0);assert.deepEqual(await store.read(),initial);
  }
});
test('cancel and forged Origin never save; timeout does not commit a late authentication response', async()=> {
  for(const scenario of ['cancel','origin','cross-site-null','late']) {
    const store=memory();let writes=0;store.write=async()=>{writes++;};
    const task=configure(store,{formModule:contractModule,timeout:scenario==='late'?30:1000,
      makeClient:()=>({calendars:async()=>{await new Promise(resolve=>setTimeout(resolve,80));return[calendar];}}),open:async url=>{
        const first=await visit(url);const nonce=first.body.match(/name="nonce" value="([^"]+)"/)[1];
        try { await visit(url,'POST',new URLSearchParams({nonce,decision:scenario==='cancel'?'cancel':'save',...auth}).toString(),scenario==='origin'?{origin:'https://evil.example.test'}:scenario==='cross-site-null'?{origin:'null','sec-fetch-site':'cross-site'}:{}); } catch { /* expiry closes its own loopback socket */ }
      }});
    await assert.rejects(task,{code:scenario==='cancel'?'user_cancelled':scenario==='late'?'setup_expired':'setup_request_denied'});
    await new Promise(resolve=>setTimeout(resolve,90));assert.equal(writes,0);
  }
});
test('expired exact plan and definitive precondition rejection never create a second dispatch', async()=> {
  let now=Date.now();const store=memory(),p=provider(),ops=new CalendarOperations(store,{makeClient:()=>p.client,clock:()=>now});
  const plan=await ops.plan({action:'create',calendarId:calendar.id,changes:changes()});now+=16*60000;
  await assert.rejects(ops.apply(plan.planId,plan.planHash),{code:'plan_expired'});assert.equal(p.calls.length,0);
  const fresh=await ops.plan({action:'create',calendarId:calendar.id,changes:changes()});let calls=0;
  p.client.request=async()=>{calls++;throw new Fault('calendar_changed');};
  await assert.rejects(ops.apply(fresh.planId,fresh.planHash),{code:'calendar_changed'});
  assert.equal((await ops.reconcile(fresh.planId)).state,'rejected');assert.equal(calls,1);
});

test('private native pipes reject early child exit instead of accepting partial stdout', async()=> {
  await assert.rejects(privateProcess(process.execPath,['-e','process.stdout.write("partial");process.exit(0)'],Buffer.alloc(8*1024*1024)),{code:'native_storage_unavailable'});
});
test('Linux credential storage is explicitly unsupported, without plaintext fallback', {skip:process.platform!=='linux'}, async()=> {
  await assert.rejects(new Store('/unused',owner()).seal({credentials:auth}),{code:'secure_storage_unsupported'});
});
test('native bootstrap rejects symlink/junction ancestors before creating a vault', {skip:!['darwin','win32'].includes(process.platform)}, async t=> {
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'apple-calendar-link-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const destination=path.join(parent,'destination');await fs.mkdir(destination);
  const link=path.join(parent,'alias');await fs.symlink(destination,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(new Store(path.join(link,'private'),owner()).init());
  assert.deepEqual(await fs.readdir(destination),[]);
});
test('Windows helper starts under Restricted parent process policy without changing persistent policies', {skip:process.platform!=='win32',timeout:120000}, async()=> {
  const ps=path.join(process.env.SystemRoot||process.env.SYSTEMROOT,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=`
    $ErrorActionPreference='Stop'
    [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
    [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35') | Out-Null
    $packet=([Web.Script.Serialization.JavaScriptSerializer]::new()).DeserializeObject([Console]::In.ReadToEnd())
    $before=[Management.Automation.PSSerializer]::Serialize((Microsoft.PowerShell.Security\\Get-ExecutionPolicy -List))
    $env:PSExecutionPolicyPreference='Restricted'
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$packet.executable
    $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$packet.helper+'"'
    $start.UseShellExecute=$false
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.EnvironmentVariables.Remove('PSExecutionPolicyPreference')
    $child=[Diagnostics.Process]::Start($start)
    $child.StandardInput.Write($packet.input);$child.StandardInput.Close()
    $result=$child.StandardOutput.ReadToEnd();$child.WaitForExit()
    if($child.ExitCode -ne 0){exit 2}
    $env:PSExecutionPolicyPreference='Bypass'
    if([Management.Automation.PSSerializer]::Serialize((Microsoft.PowerShell.Security\\Get-ExecutionPolicy -List)) -ne $before){exit 3}
    [Console]::Out.Write($result)
  `;
  const result=await privateProcess(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],JSON.stringify({
    executable:ps,helper:fileURLToPath(new URL('../scripts/vault-windows.ps1',import.meta.url)),input:JSON.stringify({mode:'seal',account:crypto.randomUUID(),data:Buffer.from('synthetic').toString('base64')})
  }),120000);
  assert.ok(result.length>0);
});

test('server scheduling diagnostics are nonsemantic but attendee response and unknown Apple properties remain exact',()=> {
  const data=createEvent(changes({attendees:[{email:'other@example.test'}]}),'UTC','mailto:synthetic@example.test');
  const status=data.replace('ATTENDEE;', 'ATTENDEE;SCHEDULE-STATUS=1.2;');
  assert.equal(fingerprint(data),fingerprint(status));
  assert.notEqual(fingerprint(data),fingerprint(data.replace('PARTSTAT=NEEDS-ACTION','PARTSTAT=ACCEPTED')));
  assert.notEqual(fingerprint(data),fingerprint(data.replace('END:VEVENT','X-APPLE-SYNTHETIC:changed\r\nEND:VEVENT')));
});
