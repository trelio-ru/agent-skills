import assert from 'node:assert/strict';
import test from 'node:test';
import { CourtPortal } from '../scripts/browser.mjs';
import { RuntimeError } from '../scripts/core.mjs';

// Exercise the real portal gates without network or credentials. An HTTP
// error must close document reads but never make a ready session unrecoverable.
function fixture(status = 404) {
  let url = 'https://ej.sudrf.ru/case?id=synthetic-case';
  let password = false, nextStatus = 200, expired = false;
  const calls = [];
  const context = { pages: () => [page] };
  const page = {
    context: () => context, url: () => url, isClosed: () => false,
    locator: () => ({ count: async () => password ? 1 : 0 }),
    goto: async target => {
      calls.push(target); url = target;
      portal.documentResponses.set(page, { url, status: nextStatus });
    },
    bringToFront: () => { throw Error('unexpected_focus'); },
  };
  const portal = new CourtPortal({}, async () => { if (expired) throw new RuntimeError('lease_expired'); });
  portal.page = page; portal.context = context;
  portal.documentResponses.set(page, { url, status });
  return { portal, page, context, calls,
    password: () => { password = true; }, expire: () => { expired = true; },
    setUrl: value => { url = value; }, setDestinationStatus: value => { nextStatus = value; } };
}
const publicUrl = 'https://court.sudrf.ru/modules.php?name=sud_delo&case_id=123';
for (const status of [401, 403, 404, 503]) {
  test(`HTTP ${status} permits explicit read-only recovery in the same page/context`, async () => {
    const f = fixture(status);
    await assert.rejects(f.portal.playwrightContext(), { code: 'service_http_error', httpStatus: status });
    await assert.rejects(f.portal.action({ action: 'click', ref: '1:1', confirm: true }), { code: 'service_http_error' });
    assert.deepEqual(await f.portal.action({ action: 'navigate', url: publicUrl }), { ok: true });
    assert.deepEqual(f.calls, [publicUrl]);
    assert.deepEqual(await f.portal.playwrightContext(), { context: f.context, page: f.page });
  });
}
test('dry-run leaves the failed document and its evidence untouched', async () => {
  const f = fixture();
  assert.deepEqual(await f.portal.action({ action: 'navigate', url: publicUrl, dryRun: true }),
    { dryRun: true, action: 'navigate', authorizationRequired: false });
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.portal.actionSafe(), { code: 'service_http_error', httpStatus: 404 });
});
test('a second HTTP failure is reported for the destination, not hidden as recovery success', async () => {
  const f = fixture(); f.setDestinationStatus(503);
  await assert.rejects(f.portal.action({ action: 'navigate', url: publicUrl }),
    { code: 'service_http_error', httpStatus: 503, httpOrigin: 'https://court.sudrf.ru' });
  await assert.rejects(f.portal.playwrightContext(), { code: 'service_http_error', httpStatus: 503 });
});
test('recovery never relaxes lease, auth or writable-route gates', async () => {
  for (const prepare of [
    f => { f.portal.authorization = {}; }, f => f.password(), f => f.expire(),
    f => f.setUrl('https://esia.gosuslugi.ru/login'),
  ]) {
    const f = fixture(); prepare(f);
    await assert.rejects(f.portal.action({ action: 'navigate', url: publicUrl }));
    assert.deepEqual(f.calls, []);
  }
  for (const url of ['https://evil.example/', 'https://ej.sudrf.ru/appeal/new', 'https://ej.sudrf.ru/submit']) {
    const f = fixture();
    await assert.rejects(f.portal.action({ action: 'navigate', url, confirm: true }));
    assert.deepEqual(f.calls, []);
  }
});
test('writable navigation still requires a fresh snapshot on a healthy document', async () => {
  const f = fixture(200);
  await assert.rejects(f.portal.action({ action: 'navigate', url: 'https://ej.sudrf.ru/appeal/new', confirm: true }),
    { code: 'fresh_snapshot_required' });
  assert.deepEqual(f.calls, []);
});
