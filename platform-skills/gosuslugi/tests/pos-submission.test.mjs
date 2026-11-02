import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPosSubmissionFlow, safePosFailure } from '../scripts/pos-submission.mjs';

const ORIGIN = 'https://pos.gosuslugi.ru';
function fixture(options = {}) {
  const page = new EventEmitter();
  const model = { material: [{ id: 'description', value: 'Synthetic approved statement' }], choices: ['Synthetic region'],
    agreement: false, footerReady: true, overlay: false, roleCount: 0, roleReady: false, registrationNumber: null };
  let phase = 'esia_request_pending', authorizations = 0;
  const clicks = [];
  page.url = () => ORIGIN + '/form/?opaId=123';
  const mainFrame = {};
  page.mainFrame = () => mainFrame;
  page.route = async () => {}; page.unroute = async () => {};
  page.evaluate = async () => structuredClone(model);
  page.locator = selector => {
    const locator = { filter: () => locator, count: async () => 1, isEnabled: async () => true,
      click: async () => { clicks.push(selector); } };
    return locator;
  };
  const flow = createPosSubmissionFlow(page, { confirm: true }, {
    createAuthorization: async () => { authorizations++; await options.onCreate?.(); return { close: async () => {} }; },
    observeAuthorization: () => ({ snapshot: () => ({ phase,
      ...(phase === 'esia_callback_verified' ? { serviceResponse: { httpStatus: 200, httpOrigin: ORIGIN } } : {}) }) }),
  });
  function request(stage, { otherPage = false, navigation = false, method } = {}) {
    const routes = { token_exchange: '/user-service/esia/esia-token', user_info: '/user-service/esia/get-user-info',
      appeal_create: '/inbox-service/appeals' };
    const value = { frame: () => otherPage ? {} : mainFrame, isNavigationRequest: () => navigation,
      url: () => ORIGIN + routes[stage], method: () => method ?? (stage === 'appeal_create' ? 'POST' : 'GET') };
    page.emit('request', value);
    return { response: status => page.emit('response', { request: () => value, status: () => status }),
      fail: () => page.emit('requestfailed', value) };
  }
  async function start() {
    const review = await flow.review(); model.agreement = true;
    return flow.start({ reviewed: review.reviewId, confirmSubmission: true });
  }
  return { page, model, flow, request, start, clicks, get authorizations() { return authorizations; },
    auth: value => { phase = value; } };
}

test('permission precedes even a URL read, and one Page cannot acquire a second attempt', () => {
  assert.throws(() => createPosSubmissionFlow({ url: () => { throw Error('private'); } }, {}, {}),
    { code: 'pos_submission_permission_required' });
  const f = fixture();
  assert.throws(() => createPosSubmissionFlow(f.page, { confirm: true }, {}), { code: 'pos_page_already_observed' });
});

test('review survives the human agreement, while changed statement invalidates it before login', async () => {
  const f = fixture(), review = await f.flow.review();
  assert.equal(review.phase, 'consent_required');
  f.model.material[0].value = 'changed'; f.model.agreement = true;
  const result = await f.flow.start({ reviewed: review.reviewId, confirmSubmission: true });
  assert.equal(result.code, 'pos_review_changed'); assert.equal(result.outcome, 'not_dispatched');
  assert.equal(f.authorizations, 0); assert.deepEqual(f.clicks, []);
});

test('one helper, modal and personal-role click preserve the same reviewed form', async () => {
  const f = fixture(); await f.start();
  f.model.overlay = true;
  await f.flow.advance(); await f.flow.advance();
  f.auth('esia_callback_verified'); f.model.roleCount = 1; f.model.roleReady = true;
  await f.flow.advance(); await f.flow.advance();
  assert.equal(f.authorizations, 1); assert.equal(f.clicks.length, 3);
  assert.equal(f.model.agreement, true);
  assert.equal(f.model.material[0].value, 'Synthetic approved statement');
  const repeat = await f.flow.start({ confirmSubmission: true });
  assert.equal(repeat.code, 'pos_attempt_already_started'); assert.equal(f.clicks.length, 3);
});

test('a silent 503 create failure remains distinct from successful ESIA and forbids replay', async () => {
  const f = fixture(); await f.start(); f.auth('esia_callback_verified');
  f.request('token_exchange').response(200); f.request('user_info').response(200);
  f.request('appeal_create').response(503);
  const result = await f.flow.inspect();
  assert.equal(result.phase, 'blocked'); assert.equal(result.stage, 'appeal_create');
  assert.equal(result.evidence.appeal_create.httpStatus, 503);
  assert.equal(result.authorization.phase, 'esia_callback_verified');
  assert.equal(result.outcome, 'unknown'); assert.equal(result.recovery.retry, 'forbidden');
  const count = f.clicks.length; await f.flow.advance(); assert.equal(f.clicks.length, count);
});

test('HTTP 200 and verified callback without a registration number never claim submission', async () => {
  const f = fixture(); await f.start(); f.auth('esia_callback_verified');
  f.request('appeal_create').response(200);
  const result = await f.flow.wait({ timeoutMs: 1 });
  assert.equal(result.code, 'pos_submission_unverified'); assert.equal(result.outcome, 'unknown');
  f.model.registrationNumber = '123456789';
  const late = await f.flow.inspect();
  assert.equal(late.outcome, 'confirmed_succeeded');
  assert.equal(late.receipt.registrationNumber, '123456789');
  assert.equal((await f.flow.close()).outcome, 'confirmed_succeeded');
});

test('a missing create response is reconciled by the same Page receipt without another action', async () => {
  const f = fixture(); await f.start(); f.request('appeal_create').fail();
  f.model.registrationNumber = '987654321';
  const result = await f.flow.inspect();
  assert.equal(result.outcome, 'confirmed_succeeded'); assert.equal(result.code, undefined);
  assert.equal(result.evidence.appeal_create.transportFailed, true);
});

test('popup, navigation, wrong methods and pre-attempt requests are not create evidence', async () => {
  const f = fixture(); f.request('appeal_create').response(200); await f.start();
  for (const options of [{ otherPage: true }, { navigation: true }, { method: 'GET' }]) {
    f.request('appeal_create', options).response(503);
  }
  const result = await f.flow.inspect(); assert.deepEqual(result.evidence.appeal_create, {});
});

test('an ambiguous click is consumed once and safe diagnostics omit exception data', async () => {
  const f = fixture();
  f.page.locator = () => ({ click: async () => { throw Object.assign(new Error('secret URL and statement'), { name: 'TimeoutError' }); } });
  const result = await f.start(); assert.equal(result.code, 'pos_action_timeout');
  assert.equal(result.operation, 'start'); assert.equal(result.outcome, 'unknown');
  await f.flow.start({ confirmSubmission: true }); assert.equal(f.authorizations, 1);
  assert.deepEqual(safePosFailure(new Error('secret URL and statement'), 'advance'),
    { code: 'pos_action_failed', operation: 'advance' });
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('read-only wait for a human does not expire the business verification or click anything', async () => {
  const f = fixture(); await f.start();
  const result = await f.flow.wait({ timeoutMs: 1 });
  assert.equal(result.code, undefined); assert.equal(f.clicks.length, 1);
  f.model.overlay = true; await f.flow.advance(); assert.equal(f.clicks.length, 2);
});

test('preflight correction reuses the same flow without repeating the human agreement', async () => {
  const f = fixture(), review = await f.flow.review();
  assert.equal((await f.flow.start({ reviewed: review.reviewId, confirmSubmission: true })).code, 'pos_consent_required');
  f.model.agreement = true;
  assert.equal((await f.flow.start({ reviewed: review.reviewId, confirmSubmission: true })).code, undefined);
  assert.equal(f.authorizations, 1);
});

test('a receipt does not conceal two create requests, and unrelated existing receipts are not new success', async () => {
  const f = fixture(); f.model.registrationNumber = '999';
  assert.equal((await f.flow.inspect()).outcome, 'not_dispatched');
  assert.equal((await f.flow.review()).code, 'pos_existing_result_or_login');
  f.model.registrationNumber = null; await f.start();
  f.request('appeal_create').response(503);
  assert.equal((await f.flow.inspect()).outcome, 'unknown', 'a previous receipt cannot confirm this new request');
  f.request('appeal_create').response(200);
  f.model.registrationNumber = '123';
  const result = await f.flow.inspect();
  assert.equal(result.code, 'pos_multiple_create_requests'); assert.equal(result.outcome, 'unknown');
  assert.equal(result.receipt.registrationNumber, '123');
  assert.equal(result.recovery.nextAction, 'verify_possible_duplicate');
});

test('close while native helper creation is pending revokes the late helper and never clicks', async () => {
  const page = new EventEmitter();
  page.url = () => ORIGIN + '/form/?opaId=123'; page.mainFrame = () => ({});
  page.route = async () => {}; page.unroute = async () => {};
  page.evaluate = async () => ({ agreement: true, footerReady: true, material: [], choices: [] });
  let release, helperClosed = 0, clicks = 0;
  page.locator = () => ({ click: async () => { clicks++; } });
  const pending = new Promise(resolve => { release = resolve; });
  const flow = createPosSubmissionFlow(page, { confirm: true }, {
    createAuthorization: async () => { await pending; return { close: async () => { helperClosed++; } }; },
    observeAuthorization: () => ({ snapshot: () => ({ phase: 'esia_request_pending' }) }),
  });
  const review = await flow.review();
  const started = flow.start({ reviewed: review.reviewId, confirmSubmission: true });
  await new Promise(resolve => setImmediate(resolve)); const closing = flow.close(); release();
  assert.equal((await started).code, 'pos_closed');
  await closing;
  assert.equal(clicks, 0); assert.equal(helperClosed, 1);
});

test('close waits for the bounded in-flight click and retains dispatch evidence', async () => {
  const f = fixture(); let release, clickStarted;
  const clickReady = new Promise(resolve => { clickStarted = resolve; });
  f.page.locator = () => ({ click: async () => {
    clickStarted(); await new Promise(resolve => { release = resolve; });
    f.request('appeal_create').response(503);
  } });
  const starting = f.start(); await clickReady;
  let closed = false; const closing = f.flow.close().then(value => { closed = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await starting;
  const result = await closing;
  assert.equal(result.evidence.appeal_create.httpStatus, 503); assert.equal(result.outcome, 'unknown');
});

test('native setup cannot authorize a statement changed during its await', async () => {
  let changed=false,routes=0;
  const f=fixture({onCreate:()=>{if(!changed){changed=true;f.model.material[0].value='unreviewed replacement';}}});
  f.page.route=async()=>{routes++;};
  const result=await f.start();
  assert.equal(result.code,'pos_review_changed');assert.equal(f.clicks.length,0);
  const review=await f.flow.review();assert.ok(review.reviewId,'the same Page remains reviewable');
  await f.flow.start({reviewed:review.reviewId,confirmSubmission:true});
  assert.equal(routes,1,'a corrected preflight cannot install a second fallback handler');
});

test('lost observation cannot turn one visible receipt into verified whole-attempt success', async () => {
  const f=fixture();await f.start();f.request('appeal_create').response(200);
  for(let n=0;n<65;n++)f.request('token_exchange').response(200);
  f.model.registrationNumber='123';
  const result=await f.flow.inspect();assert.equal(result.code,'pos_observation_overflow');
  assert.equal(result.outcome,'unknown');assert.notEqual(result.recovery.nextAction,'save_receipt');
});

test('attachment failure is visible before an appeal create and keeps successful authorization', async () => {
  const f=fixture();await f.start();f.auth('esia_callback_verified');
  f.page.emit('request',{}); // Unrelated/malformed events remain harmless.
  const request={frame:()=>f.page.mainFrame(),isNavigationRequest:()=>false,
    url:()=>ORIGIN+'/inbox-service/filestorage',method:()=> 'POST'};
  f.page.emit('request',request);f.page.emit('response',{request:()=>request,status:()=>403});
  const result=await f.flow.inspect();
  assert.equal(result.stage,'attachment_upload');assert.equal(result.evidence.attachment_upload.httpStatus,403);
  assert.equal(result.authorization.phase,'esia_callback_verified');assert.deepEqual(result.evidence.appeal_create,{});
});

test('route removal failure still closes the native helper and reports cleanup separately', async () => {
  const f=fixture();await f.start();let removed=0;
  f.page.unroute=async()=>{removed++;throw Error('private browser exception');};
  const result=await f.flow.close();
  assert.equal(removed,1);assert.equal(result.cleanupFailed,true);assert.equal(result.closed,false);
  assert.equal(result.code,'pos_cleanup_failed');assert.ok(!JSON.stringify(result).includes('private'));
});

test('a changed Page aborts its still-paused upload instead of leaving a request behind', async () => {
  const f = fixture(); let routeHandler, forwarded = 0, aborted = 0;
  f.page.route = async (_pattern, handler) => { routeHandler = handler; };
  await f.start();
  const request = { frame: () => f.page.mainFrame(), isNavigationRequest: () => false,
    url: () => ORIGIN + '/inbox-service/filestorage', method: () => 'POST' };
  f.page.emit('request', request);
  // A navigation may race the intercepted upload. The original request must
  // terminate without forwarding, body inspection or a replacement fetch.
  f.page.url = () => ORIGIN + '/form/?opaId=456';
  await routeHandler({ request: () => request,
    fallback: async () => { forwarded++; }, abort: async () => { aborted++; } });
  const result = await f.flow.close();
  assert.equal(forwarded, 0); assert.equal(aborted, 1);
  assert.equal(result.code, 'pos_form_changed'); assert.equal(result.outcome, 'unknown');
});
