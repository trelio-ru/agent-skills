import readline from 'node:readline';
import fs from 'node:fs/promises';
import { loadPlaywright, launchOwnedBrowser, Portal } from '../scripts/browser.mjs';
import { providerRequestAllowed } from '../scripts/core.mjs';

// Maintainer-only anonymous rendering probe. Launch through the native guardian,
// never the personal runtime: there is no vault, cookie import, credential input,
// authentication submission, screenshot, response body or raw browser log here.
// The only page is the fixed public login entrypoint in a fresh memory context.
const lines = readline.createInterface({ input: process.stdin });
const config = JSON.parse(await new Promise(resolve => lines.once('line', resolve)));
const waiting = new Map(); let sequence = 0, owned;
lines.on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(); waiting.delete(packet.id); });
const permit = async (op = 'permit', extra = {}) => {
  const id = ++sequence, ack = new Promise(resolve => waiting.set(id, resolve));
  process.stdout.write(`${JSON.stringify({ id, op, ...extra })}\n`); await ack;
};
const observations = new Map();
function observe(request, extra = {}) {
  const url = new URL(request.url());
  // Queries/fragments and non-static paths can contain challenge identifiers.
  // Only public static asset paths are retained; all other paths are classified.
  const asset = url.pathname.length <= 300 && /^\/[a-zA-Z0-9_./-]+\.(?:js|json|css|woff2?)$/.test(url.pathname);
  const entry = { origin: url.origin, path: asset ? url.pathname : '[non-static]',
    type: request.resourceType(), method: request.method(),
    allowed: providerRequestAllowed({ url: request.url(), navigation: request.isNavigationRequest(),
      method: request.method(), resourceType: request.resourceType() }), ...extra };
  const identity = JSON.stringify([entry.origin, entry.path, entry.type, entry.method]);
  if (observations.has(identity) || observations.size < 100)
    observations.set(identity, { ...observations.get(identity), ...entry });
}
try {
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit });
  // Portal.open installs the production request policy. No authenticate call
  // is made, so even a successfully rendered form remains empty and untouched.
  const original = owned.browser.newContext.bind(owned.browser);
  owned.browser.newContext = async options => {
    const context = await original(options);
    context.on('request', request => observe(request));
    context.on('response', response => observe(response.request(), { status: response.status() }));
    context.on('requestfailed', request => {
      const failure = request.failure()?.errorText ?? '';
      observe(request, { failure: /^net::ERR_[A-Z_]+$/.test(failure) ? failure : 'request_failed' });
    });
    return context;
  };
  const portal = new Portal(owned.browser, permit, { onPhase: () => {}, persist: () => { throw Error('not_allowed'); } });
  await portal.open(null);
  await portal.page.waitForTimeout(20000);
  const surface = await portal.page.evaluate(() => ({ bodyChildren: document.body?.children.length ?? 0,
    textLength: document.body?.innerText.length ?? 0, inputs: document.querySelectorAll('input').length }));
  await fs.writeFile(config.file, JSON.stringify({ surface, requests: [...observations.values()] }), { mode: 0o600 });
} catch (error) {
  await fs.writeFile(config.file, JSON.stringify({ errorClass: error.name, requests: [...observations.values()] }), { mode: 0o600 });
} finally {
  await owned?.browser.close().catch(() => {}); await owned?.server.close().catch(() => {});
  process.exit(0);
}
