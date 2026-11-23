import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// Test the materialized release files against the real host worker on its
// sanctioned loopback fixture route. Synthetic identities cannot access Trelio.
const checkout = process.env.TRELIO_RUNTIME_CHECKOUT;
const packager = process.env.TRELIO_SKILL_PACKAGER;
const release = fileURLToPath(new URL('../', import.meta.url));
const inn = '3802016949';

test('materialized package can continue a changed form through the native guest worker',
  { skip: !checkout || !packager, timeout: 145_000 }, async t => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'trelio-registry-release-fixture-')));
    const runtimeModule = name => pathToFileURL(join(checkout, 'host-runtime/scripts', name)).href;
    const [{ buildRuntimePackage }, visual, sessions, local] = await Promise.all([
      import(pathToFileURL(packager).href), import(runtimeModule('trelio-visual-session.mjs')),
      import(runtimeModule('trelio-browser-session.mjs')), import(runtimeModule('trelio-workspace.mjs')),
    ]);
    const { packageBytes } = buildRuntimePackage(release);
    const archive = JSON.parse(packageBytes);
    for (const file of archive.files) {
      await writeFile(join(temporary, file.path), Buffer.from(file.contentBase64, 'base64'), { mode: file.mode });
    }
    const { run } = await import(pathToFileURL(join(temporary, archive.entrypoint.path)).href);
    const page = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
      '<!DOCTYPE html><meta charset="utf-8"><title>Изменившаяся форма</title>'
      + '<form onsubmit="event.preventDefault(); out.textContent=field.value">'
      + '<label>Новая подпись поля <input id="field"></label><button>Найти</button></form><output id="out"></output>',
      );
    });
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + page.address().port;
    const now = Date.now();
    const environment = { TRELIO_ORIGIN: 'https://registry-release.test', TRELIO_SKILL_ID: 'registry-release-fixture',
      TRELIO_SKILL_VISUAL_GUEST_PROFILE: '1', TRELIO_SKILL_COMPANY_ID: randomUUID(), TRELIO_SKILL_MEMBER_ID: randomUUID(),
      TRELIO_SKILL_RUNTIME_SESSION_ID: randomUUID(), TRELIO_BROWSER_SESSION_STARTED_AT: String(now),
      TRELIO_BROWSER_SESSION_DEADLINE_AT: String(now + archive.browserSession.leaseMs),
      TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify(archive.browserSession) };
    const call = options => visual.runVisualSession({ ...options, origins: [origin],
      ...(options.operation === 'navigate' ? { args: { url: origin + '/' } } : {}),
      env: environment, fixture: { directory: temporary } });
    const host = { visual: { ...visual, runVisualSession: call }, sessions,
      local: { ...local, resolveWorkspaceBridgeConfigDirectory: () => temporary } };
    const invoke = (...argv) => run(argv, environment, async () => host);
    t.after(async () => {
      await call({ operation: 'close' }).catch(() => {});
      for (let i = 0; i < 32; i += 1) {
        const status = await call({ operation: 'status' }).catch(() => null);
        if (status && !status.sessionId && ['not_configured', 'saved_unverified'].includes(status.state)) break;
        await sleep(250);
      }
      page.closeAllConnections();
      await new Promise(resolve => page.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    });
    let result = await invoke('check', 'fns', inn);
    const start = result;
    for (let i = 0; i < 3 && result.status === 'pending'; i += 1) result = await invoke(...start.next);
    assert.equal(result.status, 'visual_review', JSON.stringify(result));
    const screen = await invoke('screenshot', 'fns', inn);
    assert.equal(screen.image?.mimeType, 'image/png');
    assert(screen.image.data.length > 100);
    const text = await invoke('read-text', 'fns', inn);
    assert.equal(text.sessionId, screen.sessionId);
    const control = text.controls.find(c => c.role === 'textbox' && c.label === 'Новая подпись поля');
    assert(control);
    const clicked = await invoke('click', 'fns', inn, text.frameId, String(control.x), String(control.y));
    let filled = await invoke('enter-inn', 'fns', inn, clicked.frameId);
    assert.equal(filled.sessionId, screen.sessionId);
    await invoke('key', 'fns', inn, filled.frameId, 'Enter');
    filled = await invoke('read-text', 'fns', inn);
    assert.match(filled.text, /3802016949/u);
    assert.equal((await invoke('close', 'fns', inn)).state, 'closed');
  });
