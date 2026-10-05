import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { openHome, installDocumentHttpObserver, assertDocumentAvailable, runtimeErrorPayload } from '../scripts/trelio-max.mjs';
const runtime = await import(pathToFileURL(path.resolve('_contracts/agent-workspaces-runtime/host-runtime/scripts/trelio-browser-session.mjs')).href);
test('HTTP failures stop before UI probe, reload or login and keep safe evidence', async () => {
 for (const status of [401,403,404,429,500,503]) {
  const context = new EventEmitter(); let waits = 0, reloads = 0;
  const frame = { page: () => page };
  const page = { context: () => context, mainFrame: () => frame, isClosed: () => false,
   url: () => 'https://web.max.ru/',
   goto: async () => { const request = { isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame };
    context.emit('request', request); context.emit('response', { request: () => request, url: () => 'https://web.max.ru/?private=SECRET', status: () => status });
    page.url = () => 'https://web.max.ru/?private=SECRET'; },
   waitForFunction: async () => { waits++; throw Error('Unexpected UI probe'); }, reload: async () => { reloads++; } };
  installDocumentHttpObserver(context, runtime);
  await assert.rejects(openHome(page, { timeoutMs: 100 }, true), error => {
   const value = runtimeErrorPayload(error); assert.equal(value.code, 'MAX_SERVICE_HTTP_ERROR');
   assert.deepEqual(value.details, { httpStatus: status, origin: 'https://web.max.ru' });
   assert.equal(JSON.stringify(value).includes('SECRET'), false); return true;
  });
  assert.equal(waits, 0); assert.equal(reloads, 0);
  assert.throws(() => assertDocumentAvailable(page), error => error.details.httpStatus === status);
 }
});
