import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeError, serviceHttpFailure } from '../scripts/core.mjs';
test('HTTP metadata survives typed errors and rejects untrusted fields/status/origin', () => {
 const error = new RuntimeError('service_http_error', { httpStatus: 503, httpOrigin: 'https://service.test', body: 'SECRET' });
 assert.deepEqual(serviceHttpFailure(error), { httpStatus: 503, httpOrigin: 'https://service.test' });
 assert.equal(error.body, undefined);
 for (const status of [true,'503',399,600,503.5]) assert.deepEqual(serviceHttpFailure(new RuntimeError('service_http_error', {httpStatus:status,httpOrigin:'https://service.test'})), {});
 assert.deepEqual(serviceHttpFailure(new RuntimeError('service_http_error', {httpStatus:503,httpOrigin:'https://service.test/?token=SECRET'})), {});
 assert.deepEqual(serviceHttpFailure(new RuntimeError('session_unreachable', {httpStatus:503,httpOrigin:'https://service.test'})), {});
});

import { EventEmitter } from 'node:events';
import { WhatsAppBrowser } from '../scripts/browser.mjs';
test('WhatsApp HTTP failure cannot become a new QR request or successful login', async () => {
 const context = new EventEmitter(); const page = new EventEmitter();
 const frame = { page: () => page }; page.mainFrame = () => frame;
 page.url = () => 'about:blank'; page.isClosed = () => false;
 context.route = async () => {}; context.pages = () => [page];
 page.goto = async url => {
  const request = { isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame };
  context.emit('request', request); context.emit('response', { request: () => request, url: () => url, status: () => 503 }); page.url = () => url;
 };
 page.evaluate = async () => assert.fail('HTTP failure must be detected before reading login DOM');
 const phases = []; const client = new WhatsAppBrowser({context,permit:async()=>{},persist:async()=>assert.fail('No login proof'),onPhase:value=>phases.push(value),onFatal:()=>{}});
 await assert.rejects(client.connect(), error => error.code === 'service_http_error' && error.httpStatus === 503 && error.httpOrigin === 'https://web.whatsapp.com');
 assert.deepEqual(phases, []); assert.equal(client.connected, false); client.close();
 assert.equal(context.listenerCount('response'), 0);
});
