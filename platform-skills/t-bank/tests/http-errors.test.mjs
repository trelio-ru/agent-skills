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

import http from 'node:http';
import { requestLocal } from '../scripts/transport.mjs';
test('private T-ID control transport preserves bounded HTTP evidence', async () => {
 const server = http.createServer((_req,res)=>{res.writeHead(400, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'service_http_error',httpStatus:503,httpOrigin:'https://service.test',body:'SECRET'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try { await assert.rejects(requestLocal({port:server.address().port,token:'a'.repeat(64)}, {}), error => error.code==='service_http_error' && error.httpStatus===503 && error.httpOrigin==='https://service.test' && error.body===undefined); }
 finally {await new Promise(resolve=>server.close(resolve));}
});
