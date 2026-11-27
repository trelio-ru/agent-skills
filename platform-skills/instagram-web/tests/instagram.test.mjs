import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_SESSION_DEFAULT_LEASE_MS, buildRuntimePackage } from '../../tools/build-runtime-package.mjs';
import { runInstagram } from '../scripts/trelio-instagram.mjs';

const origin = 'https://www.instagram.com';
const post = `${origin}/p/Synthetic_1/`;
const denyIo = new Proxy({}, { get() { throw Error('unexpected host access'); } });
const observation = (url, overrides = {}) => ({
  kind: 'trelio.browser-text/v1', state: 'ready', verifiedDocumentUrl: url,
  title: 'Instagram', text: 'Synthetic content', nextOffset: null, scanLimited: false,
  controls: [{ label: 'Like', url: 'private control' }], ...overrides,
});
const visualStatus = (state, reason = 'none', extra = {}) => ({
  kind: 'trelio.visual-browser/v1', state, reason, ...extra,
});

async function fixture(t, { exact = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-instagram-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const host = pathToFileURL(path.join(directory, 'host.mjs'));
  await fs.writeFile(host, `
export const VISUAL_PRESENTATION_API = 'trelio.visual-presentation/v1';
export const VISUAL_EXACT_DOCUMENT_READ_API = ${JSON.stringify(exact ? 'trelio.visual-exact-document-read/v1' : '')};
export const calls = [];
export function runVisualSession({ env, ...request }) {
  calls.push(request);
  const result = JSON.parse(env.SYNTHETIC_RESULT);
  if (!(request.operation in result)) throw new Error('unexpected browser operation');
  return result[request.operation];
}`);
  const env = { TRELIO_VISUAL_SESSION_MODULE_URL: host.href, TRELIO_SKILL_ID: 'instagram-web' };
  return {
    env,
    calls: (await import(host.href)).calls,
    run: (argv, result, binding = {}) => runInstagram(argv,
      { ...env, ...binding, SYNTHETIC_RESULT: JSON.stringify(result) }),
  };
}

test('only the declared read and session surface reaches the host', async () => {
  assert.deepEqual(await runInstagram(['__trelio_accounts_import'], denyIo), { schemaVersion: 1, accounts: [] });
  const { commands } = await runInstagram(['commands'], denyIo);
  assert.deepEqual(Object.keys(commands), ['doctor', 'status', 'setup', 'wait', 'ready', 'close', 'read']);
  for (const input of [
    'http://instagram.com/one', 'https://instagram.com.invalid/one',
    'https://example.test@instagram.com/one', 'https://instagram.com:443/one',
    `${origin}/../one`, `${origin}/a/../two`, `${origin}/three%2ffour`,
    `${origin}/.one`, `${origin}/one..two`, `${origin}/${'a'.repeat(31)}`,
    `${origin}/`, `${origin}/accounts/login/`, `${origin}/DIRECT/`, `${origin}/share/p/token`,
    `${origin}/reel/extra/suffix/`, `${post}\n`, `${post}?bad=one\\two`,
  ]) await assert.rejects(runInstagram(['read', '--url', input], denyIo), /INSTAGRAM_COMMAND_INVALID/, input);
  for (const argv of [
    ['click', '--x', '10'], ['type-text'], ['navigate', '--url', post], ['setup', '--url', post],
    ['__trelio_accounts_import', 'extra'], ['read', '--url', post, '--offset', '-1'],
    ['read', '--url', post, '--offset', '1e3'], ['read', '--url', post, '--offset', '100001'],
  ]) await assert.rejects(runInstagram(argv, denyIo), /INSTAGRAM_COMMAND_INVALID/);
});

test('content is bound to one canonical Instagram URL and projected without controls', async t => {
  const host = await fixture(t);
  const examples = [
    ['https://instagram.com/Some.Profile?igsh=ignored', `${origin}/some.profile/`, 'profile'],
    [`${post}#ignored`, post, 'post'],
    ['https://instagram.com/reel/Upper_Case-42?utm_source=ignored', `${origin}/reel/Upper_Case-42/`, 'reel'],
  ];
  for (const [input, expected, targetKind] of examples) {
    assert.deepEqual(await host.run(['read', '--url', input], { navigate: observation(expected) }), {
      schemaVersion: 1, state: 'observed', targetKind, url: expected, title: 'Instagram',
      text: 'Synthetic content', nextOffset: null, scanLimited: false,
    });
    assert.deepEqual(host.calls.at(-1), {
      origins: [origin], domains: ['instagram.com'],
      presentation: 'hidden', observationMode: 'text', operation: 'navigate',
      args: { url: expected, expectedDocumentUrl: expected },
    });
  }
  const loginWall = observation(post, { title: 'Log in • Instagram', text: 'Log in to continue' });
  const reflected = await host.run(['read', '--url', post], { navigate: loginWall });
  assert.equal(reflected.state, 'observed', 'exact URL alone cannot establish available post content');
  const pageChanged = visualStatus('error', 'stale_frame');
  assert.deepEqual(await host.run(['read', '--url', post], { navigate: pageChanged }), pageChanged);
  for (const bad of [
    observation(post, { verifiedDocumentUrl: undefined }),
    observation(`${origin}/accounts/login/`),
    observation('https://www.facebook.com/login/'),
    observation(post, { nextOffset: 0 }),
    observation(post, { scanLimited: undefined }),
    visualStatus('ready'),
  ]) {
    const before = host.calls.length;
    await assert.rejects(host.run(['read', '--url', post], { navigate: bad }), /INSTAGRAM_DOCUMENT_UNVERIFIED/);
    assert.equal(host.calls.length, before + 1, 'the failed exact read cannot dispatch setup or another navigation');
  }
});

test('a cold worker and continuation keep the original navigation and distinguish HTTP refusal', async t => {
  const host = await fixture(t);
  const preparing = visualStatus('preparing');
  assert.deepEqual(await host.run(['read', '--url', post], {
    navigate: preparing, wait: preparing,
  }), preparing);
  assert.deepEqual(host.calls.splice(0).map(({ operation }) => operation), ['navigate', 'wait']);
  assert.equal((await host.run(['read', '--url', post], {
    navigate: preparing, wait: visualStatus('ready'),
    'read-text': observation(post, { nextOffset: 100, scanLimited: true }),
  })).nextOffset, 100);
  assert.deepEqual(host.calls.splice(0).map(({ operation }) => operation), ['navigate', 'wait', 'read-text']);
  await host.run(['read', '--url', post, '--offset', '100'], { 'read-text': observation(post) });
  assert.deepEqual(host.calls.shift().args, { expectedDocumentUrl: post, offset: 100 });
  const blocked = visualStatus('error', 'http_document_failure', { origin, httpStatus: 403 });
  assert.deepEqual(await host.run(['read', '--url', post], { navigate: blocked }), blocked);
  assert.deepEqual(host.calls.map(({ operation }) => operation), ['navigate']);
});

test('manual setup belongs to the selected account and older hosts fail before browser access', async t => {
  const host = await fixture(t);
  for (const binding of [{}, { TRELIO_SKILL_VISUAL_GUEST_PROFILE: '1', TRELIO_SKILL_ACCOUNT_JSON: '{}' }])
    await assert.rejects(host.run(['setup'], {}, binding), /INSTAGRAM_PERSONAL_ACCOUNT_REQUIRED/);
  assert.equal(host.calls.length, 0);
  const manual = visualStatus('manual_input_required', 'manual_control_active');
  assert.deepEqual(await host.run(['setup'], { setup: manual }, { TRELIO_SKILL_ACCOUNT_JSON: '{}' }), manual);
  assert.deepEqual(host.calls[0], {
    origins: [origin], domains: ['instagram.com'],
    presentation: 'hidden', observationMode: 'text', operation: 'setup',
    args: { url: `${origin}/` },
  });
  const stale = await fixture(t, { exact: false });
  await assert.rejects(stale.run(['read', '--url', post], {}), /INSTAGRAM_HOST_UPGRADE_REQUIRED/);
  assert.equal(stale.calls.length, 0);
});

test('release package includes only provider source and the guest opt-in; packaged CLI cold-starts offline', async t => {
  const root = new URL('../', import.meta.url);
  const release = JSON.parse(await fs.readFile(new URL('release.json', root), 'utf8'));
  const { packageBytes } = buildRuntimePackage(fileURLToPath(root));
  const built = JSON.parse(packageBytes);
  assert.deepEqual(built.files.map(file => file.path).sort(),
    ['trelio-instagram.mjs', 'trelio-visual-guest-profile.json']);
  const guest = built.files.find(file => file.path === 'trelio-visual-guest-profile.json');
  assert.equal(Buffer.from(guest.contentBase64, 'base64').toString('utf8').trim(), '{"schemaVersion":1}');
  assert.deepEqual(built.browserSession, { apiVersion: 1, sessionClass: 'protected-snapshot',
    manualAssist: true, leaseMs: BROWSER_SESSION_DEFAULT_LEASE_MS });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-instagram-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of built.files)
    await fs.writeFile(path.join(directory, file.path), Buffer.from(file.contentBase64, 'base64'));
  const cli = path.join(directory, built.entrypoint.path);
  const execute = (...argv) => JSON.parse(execFileSync(process.execPath, [cli, ...argv], { env: {}, encoding: 'utf8' }));
  assert.deepEqual(execute('__trelio_accounts_import'), { schemaVersion: 1, accounts: [] });
  assert.deepEqual(execute('doctor'), { schemaVersion: 1, runtimeVersion: release.runtime.version,
    minimumHostVersion: release.runtime.minimumHostVersion, hostVisualAvailable: false });
});
