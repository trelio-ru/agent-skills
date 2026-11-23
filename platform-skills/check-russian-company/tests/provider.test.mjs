import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run } from '../check-russian-company.mjs';
import { parseFedresursResult } from '../registry-workflows.mjs';
import { buildRuntimePackage } from '../../tools/build-runtime-package.mjs';

const inn = '3802016949';
const otherInn = '7707083893';
const env = { TRELIO_HOST_RUNTIME_VERSION: '3.34.39' };
const frameId = randomUUID();
const sessionId = randomUUID();
const active = { state: 'ready', sessionId, frameId, width: 1280, height: 800 };
const missing = { state: 'not_configured' };

function fixture({ text = '', controls = [], failure, onContinue } = {}) {
  const calls = [];
  const states = new Map();
  const browsers = new Map();
  const host = {
    visual: {
      visualSessionBinding: () => ({ scope: 'synthetic-guest', deadlineAt: Date.now() + 300_000 }),
      async runVisualSession(options) {
        const owner = options.env.owner;
        const { operation, args } = options;
        calls.push(options);
        if (operation === 'status') return browsers.get(owner) ? active : missing;
        if (operation === 'navigate') {
          browsers.set(owner, args.url);
          return { state: 'preparing' };
        }
        if (operation === 'wait') return failure ?? active;
        if (operation === 'close') {
          browsers.delete(owner);
          return { state: 'closed' };
        }
        if (operation === 'screenshot') return { ...active, kind: 'trelio.visual-browser/v1', image: { mimeType: 'image/png' } };
        return onContinue?.(options) ?? { ...active, text, controls };
      },
    },
    sessions: {
      browserExecutionOwner: value => value.owner,
      browserExecutionDirectory: (directory, value) => directory + '/' + value.owner,
      withBrowserAccountState: (_directory, action) => action(),
    },
    local: {
      resolveWorkspaceBridgeConfigDirectory: () => '/synthetic',
      readPrivateJsonFile: file => states.get(file) ?? {},
      writePrivateJsonFile: (file, value) => states.set(file, value),
    },
  };
  return { invoke: (argv, owner = 'chat-a') => run(argv, { ...env, owner }, async () => host),
    calls, states, browsers };
}

test('rejects unsupported filters, arbitrary destinations and invalid INNs before touching the host', async () => {
  const disabled = () => assert.fail('invalid argv touched the host');
  for (const [argv, code] of [
    [['check', 'fns', '3802016940'], 'INVALID_COMPANY_INN'],
    [['check', 'fns', inn, '--windowed'], 'INVALID_REGISTRY_COMMAND'],
    [['navigate', 'fns', inn, 'https://foreign.invalid/'], 'INVALID_REGISTRY_COMMAND'],
    [['key', 'kad', inn, frameId, 'Ctrl+L'], 'INVALID_REGISTRY_COMMAND'],
    [['click', 'kad', inn, 'not-a-frame', '12', '22'], 'INVALID_REGISTRY_COMMAND'],
  ]) assert.equal((await run(argv, env, disabled)).diagnostic.code, code);
  assert.deepEqual(await run(['__trelio_accounts_import'], env, disabled), { schemaVersion: 1, accounts: [] });
});

test('uses a healthy source without replaying the opening call and closes its browser', async () => {
  const controls = [
    { role: 'textbox', label: 'Поисковый запрос: *', x: 10, y: 10 },
    { role: 'button', label: 'Найти', x: 20, y: 20 },
  ];
  const { invoke, calls, states, browsers } = fixture({ controls, text: 'МУП\nИНН: 3802016949 ОГРН: 1153850003427' });
  const pending = await invoke(['check', 'fns', inn]);
  assert.deepEqual(pending.next, ['resume', 'fns', inn]);
  assert.equal(await invoke(['check', 'fns', otherInn]).then(r => r.diagnostic.code), 'REGISTRY_SESSION_MISMATCH');
  const result = await invoke(pending.next);
  assert.equal(result.ogrn, '1153850003427');
  assert.equal(result.status, 'found');
  assert.equal(browsers.size, 0);
  assert.deepEqual([...states.values()], [{}]);
  assert.deepEqual(calls.map(c => c.operation),
    ['status', 'navigate', 'status', 'status', 'wait', 'read-text', 'click', 'type-text', 'click', 'close', 'status']);
  assert(calls.every(call => call.presentation === 'hidden' && call.externalNavigation === true));
});

for (const [source, presentation] of [['fns', 'hidden'], ['kad', 'windowed'], ['fedresurs', 'windowed']]) {
  test(`${source}: layout change continues in the owned session and input is bound to its original INN`, async () => {
    const setupText = source === 'fedresurs' ? 'Представление изменилось' : 'Новые подписи полей';
    const { invoke, calls, browsers, states } = fixture({ text: setupText });
    const pending = await invoke(['check', source, inn]);
    assert.equal((await invoke(pending.next)).status, 'visual_review');
    assert.equal((await invoke(['read-text', source, inn], 'other-chat')).diagnostic.code, 'REGISTRY_SESSION_MISMATCH');
    assert.equal((await invoke(['enter-inn', source, otherInn, frameId])).diagnostic.code, 'REGISTRY_SESSION_MISMATCH');
    assert.equal((await invoke(['screenshot', source, inn])).frameId, frameId);
    assert.equal((await invoke(['click', source, inn, frameId, '120', '220'])).sessionId, sessionId);
    assert.equal((await invoke(['enter-inn', source, inn, frameId])).sessionId, sessionId);
    assert.deepEqual(calls.find(c => c.operation === 'type-text').args, { frameId, text: inn });
    assert.equal(calls.filter(c => c.operation === 'navigate').length, 1);
    assert(calls.every(call => call.presentation === presentation));
    assert([...states.values()].every(value => !JSON.stringify(value).includes(inn)));
    assert.equal((await invoke(['close', source, inn])).state, 'closed');
    assert.equal(browsers.size, 0);
  });
}

test('one chat can close its browser while a second chat continues independently', async () => {
  const { invoke, browsers } = fixture({ text: 'New layout' });
  await invoke(['check', 'fns', inn], 'chat-a');
  await invoke(['check', 'kad', otherInn], 'chat-b');
  assert.equal((await invoke(['close', 'kad', otherInn], 'chat-a')).diagnostic.code, 'REGISTRY_SESSION_MISMATCH');
  await invoke(['close', 'fns', inn], 'chat-a');
  assert.deepEqual([...browsers.keys()], ['chat-b']);
  assert.equal((await invoke(['resume', 'kad', otherInn], 'chat-b')).status, 'visual_review');
  await invoke(['close', 'kad', otherInn], 'chat-b');
});

test('a lost response keeps the browser for read-back and does not re-submit input', async () => {
  const { invoke, calls } = fixture({
    controls: [{ role: 'textbox', label: 'Поисковый запрос: *', x: 10, y: 10 }],
    onContinue({ operation }) {
      if (operation === 'type-text') throw new DOMException('Untrusted response detail', 'TimeoutError');
    },
  });
  const pending = await invoke(['check', 'fns', inn]);
  const outcome = await invoke(pending.next);
  assert.equal(outcome.status, 'visual_review');
  assert.equal(outcome.diagnostic.code, 'BROWSER_REQUEST_TIMEOUT');
  assert.equal(outcome.diagnostic.recovery.retry, 'forbidden');
  assert.equal(outcome.diagnostic.evidence.timedOut, true);
  assert.equal((await invoke(pending.next)).status, 'visual_review');
  await invoke(['read-text', 'fns', inn]);
  assert.equal(calls.filter(c => c.operation === 'type-text').length, 1);
  assert(!JSON.stringify(outcome).includes('Untrusted response detail'));
  await invoke(['close', 'fns', inn]);
});

test('unverified access, provider and runtime failures are never reported as empty results', async () => {
  for (const [reason, httpStatus, expected] of [
    ['http_document_failure', 401, 'REGISTRY_ACCESS_REFUSED'],
    ['http_document_failure', 503, 'REGISTRY_HTTP_ERROR'],
    ['lease_expired', undefined, 'BROWSER_LEASE_EXPIRED'],
    ['bootstrap_failed', undefined, 'BROWSER_BOOTSTRAP_FAILED'],
    ['browser_process_lost', undefined, 'BROWSER_PROCESS_LOST'],
  ]) {
    const { invoke } = fixture({ failure: { state: 'error', reason, httpStatus,
      diagnostic: { internal: 'discard this host detail' } } });
    const pending = await invoke(['check', 'fedresurs', inn]);
    const outcome = await invoke(pending.next);
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.diagnostic.code, expected);
    assert.equal(outcome.diagnostic.contract, 'trelio.skill-diagnostic/v1');
    assert.equal(outcome.diagnostic.evidence.httpStatus, httpStatus);
    assert(!JSON.stringify(outcome).includes('discard this host detail'));
  }
});

test('Федресурс requires the filtered result and exact identity to report a match', () => {
  const form = 'Наименование лица, ИНН, номер дела';
  const card = [form, 'Юридические лица', '1', 'ИНН', inn, 'ОГРН', '1153850003427',
    'Конкурсное производство', '27.11.2024', 'Номер судебного дела', 'А19-5659/2024'].join('\n');
  assert.deepEqual(parseFedresursResult(card, inn), { status: 'found', ogrn: '1153850003427',
    stage: 'Конкурсное производство', stageDate: '27.11.2024', caseNumber: 'А19-5659/2024' });
  assert.equal(parseFedresursResult(card, otherInn), null);
  assert.equal(parseFedresursResult(card.replace('Юридические лица\n1', 'Юридические лица\n45'), inn), null);
  assert.deepEqual(parseFedresursResult(form + '\nПо вашему запросу не найдено ни одного совпадения', inn),
    { status: 'no_matches' });
  assert.equal(parseFedresursResult('HTTP 401', inn), null);
});

test('published package materializes the public identity and its real CLI needs the host', async t => {
  const release = fileURLToPath(new URL('../', import.meta.url));
  const { packageBytes } = buildRuntimePackage(release);
  const archive = JSON.parse(packageBytes);
  assert.deepEqual(archive.skill, { id: 'check-russian-company', runtimeVersion: '1.0.1' });
  assert(archive.files.some(file => file.path === 'trelio-visual-guest-profile.json'));
  const directory = await mkdtemp(join(tmpdir(), 'trelio-check-company-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of archive.files) {
    await writeFile(join(directory, file.path), Buffer.from(file.contentBase64, 'base64'), { mode: file.mode });
  }
  const invoke = (...argv) => JSON.parse(execFileSync(process.execPath, [join(directory, archive.entrypoint.path), ...argv],
    { encoding: 'utf8', env: {}, shell: false, timeout: 5000 }));
  assert.deepEqual(invoke('__trelio_accounts_import'), { schemaVersion: 1, accounts: [] });
  assert.equal(invoke('check', 'fns', '3802016940').diagnostic.code, 'INVALID_COMPANY_INN');
  assert.equal(invoke('doctor').diagnostic.code, 'REGISTRY_HOST_REQUIRED');
});

test('all three registries can restore the same snapshot without extending the KAD field policy', async () => {
  const allowed = ['https://egrul.nalog.ru', 'https://kad.arbitr.ru', 'https://bankrot.fedresurs.ru'];
  const { invoke, calls } = fixture();
  for (const source of ['fns', 'kad', 'fedresurs']) {
    const previous = calls.length;
    const started = await invoke(['check', source, inn]);
    assert.equal(started.status, 'pending');
    await invoke(['close', source, inn]);
    const operations = calls.slice(previous);
    assert(operations.every(call => JSON.stringify(call.origins) === JSON.stringify(allowed)));
    assert.deepEqual(operations.find(call => call.operation === 'navigate').fieldCheckPolicy,
      source === 'kad' ? { origins: ['https://kad.arbitr.ru'], labels: ['название, ИНН или ОГРН'] } : undefined);
  }
});
