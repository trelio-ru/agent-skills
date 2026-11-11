import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseArguments, transcribeVoiceCard, validateCommandOptions } from '../scripts/trelio-max.mjs';

const chat = 'https://web.max.ru/123';
const identity = {
  TRELIO_SKILL_ID: 'max-web', TRELIO_SKILL_RUNTIME_VERSION: '2.13.4',
  TRELIO_SKILL_COMPANY_ID: '11111111-1111-4111-8111-111111111111',
  TRELIO_SKILL_MEMBER_ID: '22222222-2222-4222-8222-222222222222',
  TRELIO_SKILL_CONNECTION_ID: '33333333-3333-4333-8333-333333333333',
};
const options = { chat, timeoutMs: 5000 };

const fixture = ({ state = 'start', panel = '', onClick = () => {} } = {}) => {
  const { document } = parseHTML('<html><body><div data-trelio-max-message="0"><div class="attachAudio">'
    + '<div class="buttonWrapper"><button>Play</button></div>'
    + '<div class="content"><div class="waveWrapper"></div><span>'
    + (state ? `<button class="button--inside button--${state}"></button>` : '')
    + '</span></div>' + panel + '</div></div>'
    + '<div class="transcription">UNRELATED TRANSCRIPT</div></body></html>');
  const target = document.querySelector('.attachAudio');
  const wrapper = target.parentElement;
  const snapshot = { index: 0, text: (wrapper.innerText || wrapper.textContent).replace(/\s+/gu, ' ').trim() };
  const location = { href: chat };
  const context = vm.createContext({ window: { location }, target });
  let clicks = 0;
  target.querySelector('.button--inside')?.addEventListener('click', () => {
    clicks += 1;
    onClick(target, location);
  });
  target.querySelector('.buttonWrapper button').addEventListener('click', () => assert.fail('Clicked playback'));
  return {
    target,
    snapshot,
    page: { waitForTimeout: async () => {} },
    card: { evaluate: async (observe, parameters) => {
      context.parameters = parameters;
      return vm.runInContext(`(${observe.toString()})(target, parameters)`, context);
    } },
    clicks: () => clicks,
  };
};

test('MAX transcription admits one exact message and refuses mutation and file arguments', () => {
  const args = ['transcribe', '--chat', chat, '--target-text', '00:56 16:00'];
  validateCommandOptions(parseArguments(args, identity));
  for (const argv of [
    [...args, '--confirm'],
    [...args, '--output', 'file.ogg'],
    [...args, '--message-id', 'm2'],
    [...args, '--attachment-index', '1'],
    ['transcribe', '--chat', 'Contact', '--message-id', 'm1'],
    ['transcribe', '--chat', chat],
  ]) assert.throws(() => validateCommandOptions(parseArguments(argv, identity)), { code: 'MAX_TRANSCRIPTION_INPUT_INVALID' });
});

test('MAX invokes the scoped built-in transcription once and returns its own displayed text', async () => {
  const f = fixture({ onClick: card => {
    card.querySelector('.button--inside').classList.replace('button--start', 'button--process');
  } });
  f.page.waitForTimeout = async () => {
    f.target.insertAdjacentHTML('beforeend', '<div class="transcription">Точный текст.</div>');
  };
  assert.equal(await transcribeVoiceCard(f.page, f.card, options, f.snapshot), 'Точный текст.');
  assert.equal(f.clicks(), 1);
});

test('MAX can use a visible transcript and wait for an existing request without clicking', async () => {
  const visible = fixture({ panel: '<div class="transcription">Готовый текст.</div>' });
  assert.equal(await transcribeVoiceCard(visible.page, visible.card, options, visible.snapshot), 'Готовый текст.');
  assert.equal(visible.clicks(), 0);
  const pending = fixture({ state: 'process' });
  pending.page.waitForTimeout = async () => {
    pending.target.insertAdjacentHTML('beforeend', '<div class="transcription">Обработано.</div>');
  };
  assert.equal(await transcribeVoiceCard(pending.page, pending.card, options, pending.snapshot), 'Обработано.');
  assert.equal(pending.clicks(), 0);
});

test('MAX transcription distinguishes missing control, recognition failure, pending and a changed chat', async () => {
  const missing = fixture({ state: null });
  await assert.rejects(transcribeVoiceCard(missing.page, missing.card, options, missing.snapshot), { code: 'MAX_TRANSCRIPTION_UNAVAILABLE' });
  const failure = fixture({ panel: '<div class="transcription"><span class="noTranscription">Не распознали голос</span></div>' });
  await assert.rejects(transcribeVoiceCard(failure.page, failure.card, options, failure.snapshot), { code: 'MAX_TRANSCRIPTION_FAILED' });
  const pending = fixture({ state: 'process' });
  await assert.rejects(transcribeVoiceCard(pending.page, pending.card, { ...options, timeoutMs: 0 }, pending.snapshot), { code: 'MAX_TRANSCRIPTION_PENDING' });
  const changed = fixture({ onClick: (_, location) => { location.href = 'https://web.max.ru/456'; } });
  await assert.rejects(transcribeVoiceCard(changed.page, changed.card, options, changed.snapshot), { code: 'MAX_TRANSCRIPTION_TARGET_CHANGED' });
  assert.equal(changed.clicks(), 1);
});

test('MAX refuses a voice card when its message snapshot changed before activation', async () => {
  const f = fixture();
  f.target.parentElement.insertAdjacentHTML('beforeend', '<span>Изменённое сообщение</span>');
  await assert.rejects(transcribeVoiceCard(f.page, f.card, options, f.snapshot), { code: 'MAX_TRANSCRIPTION_TARGET_CHANGED' });
  assert.equal(f.clicks(), 0);
});
