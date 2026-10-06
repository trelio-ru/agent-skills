import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import test from 'node:test';
import { afterAssistResponse, closeAssistControlServer } from '../scripts/trelio-max.mjs';

test('MAX stop flushes its full acknowledgement and releases an unfinished HTTP client', async () => {
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const payload = { ok: true, phase: 'closing', evidence: 'x'.repeat(32_000) };
  const server = http.createServer((request, response) => {
    request.resume();
    afterAssistResponse(response, () => {
      closeAssistControlServer(server).then(resolveClosed, rejectClosed);
    });
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stalled = net.connect(port, '127.0.0.1');
  stalled.on('error', () => {});
  let timeout;
  try {
    await once(stalled, 'connect');
    const partialHeadersParsed = new Promise(resolve => stalled.write(
      'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n', resolve,
    ));
    await partialHeadersParsed;
    // Unlike an idle keep-alive socket, a client with incomplete headers holds
    // server.close until the HTTP header timeout. Use a real TCP client so this
    // regression exercises Node's lifecycle, not a mock of the implementation.
    const received = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, method: 'POST',
        path: '/', agent: false }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(JSON.parse(body)));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
    assert.deepEqual(received, payload);
    await Promise.race([closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('Control shutdown retained an unfinished client')), 1_500);
    })]);
  } finally {
    clearTimeout(timeout);
    stalled.destroy();
    if (server.listening) server.close();
    server.closeAllConnections();
  }
});

test('MAX still cleans up when the stop caller disconnects before acknowledgement', () => {
  const response = new EventEmitter();
  let stopped = 0;
  afterAssistResponse(response, () => { stopped += 1; });
  response.emit('close');
  response.emit('finish');
  assert.equal(stopped, 1);
});
