import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadVoiceAttachment, readCompleteVoice } from '../scripts/trelio-max.mjs';

const ogg = Buffer.from('OggS synthetic voice');
const response = (overrides = {}) => ({
  status: () => 206,
  headers: () => ({
    'content-type': 'audio/ogg',
    'content-length': String(ogg.length),
    'content-range': `bytes 0-${ogg.length - 1}/${ogg.length}`,
  }),
  body: async () => ogg,
  dispose: async () => {},
  ...overrides,
});

test('MAX verifies the whole OGG and refuses partial, redirected, disguised and truncated responses', async () => {
  assert.deepEqual(await readCompleteVoice(response()), ogg);
  for (const patch of [
    { status: () => 302 },
    { headers: () => ({ 'content-type': 'audio/ogg', 'content-length': '8', 'content-range': 'bytes 0-7/16' }) },
    { headers: () => ({ 'content-type': 'text/html', 'content-length': '8' }), status: () => 200 },
    { body: async () => Buffer.from('OggS') },
    { body: async () => Buffer.alloc(ogg.length) },
  ]) {
    await assert.rejects(readCompleteVoice(response(patch)), { code: 'MAX_VOICE_SOURCE_UNVERIFIED' });
  }
});

test('MAX captures the exact player request once, stops playback and saves original bytes', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-voice-test-')));
  try {
    const output = path.join(directory, 'voice.ogg');
    const url = 'https://a.oneme.ru/synthetic?signatureToken=private';
    const frame = {};
    const events = [];
    let handler;
    let acceptsSource = true;
    const page = {
      context: () => ({}),
      mainFrame: () => frame,
      url: () => 'https://web.max.ru/123',
      locator: () => ({ count: async () => 0 }),
      evaluate: async (_, source) => acceptsSource && source === url,
      route: async (pattern, callback) => {
        assert.ok(pattern.test(url));
        assert.ok(!pattern.test('https://example.com/voice'));
        handler = callback;
      },
      unroute: async () => events.push('unroute'),
    };
    const request = (sourceFrame = frame) => ({
      method: () => 'GET',
      resourceType: () => 'media',
      isNavigationRequest: () => false,
      redirectedFrom: () => null,
      frame: () => sourceFrame,
      url: () => url,
    });
    const transfer = sourceFrame => ({
      request: () => request(sourceFrame),
      fallback: async () => events.push('fallback'),
      abort: async () => events.push('abort'),
      fetch: async options => {
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.maxRetries, 0);
        events.push('fetch');
        return response();
      },
    });
    const voice = { locator: selector => ({
      count: async () => 1,
      click: async () => {
        assert.equal(selector, '.buttonWrapper > button');
        await handler(transfer({}));
        await handler(transfer(frame));
      },
    }) };
    const result = await downloadVoiceAttachment(page, { output, timeoutMs: 5000 }, { message: {} }, voice);
    assert.deepEqual(fs.readFileSync(output), ogg);
    assert.equal(result.mediaType, 'audio/ogg');
    assert.equal(result.sizeBytes, ogg.length);
    assert.doesNotMatch(JSON.stringify(result), /signatureToken|a\.oneme\.ru/u);
    assert.deepEqual(events, ['fallback', 'fetch', 'abort', 'unroute']);

    acceptsSource = false;
    const absent = path.join(directory, 'unverified.ogg');
    await assert.rejects(downloadVoiceAttachment(page, { output: absent, timeoutMs: 5000 }, { message: {} }, voice),
      { code: 'MAX_VOICE_TARGET_UNVERIFIED' });
    assert.equal(fs.existsSync(absent), false);
    assert.deepEqual(events.slice(4), ['fallback', 'abort', 'unroute']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
