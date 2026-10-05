import readline from 'node:readline';
import fs from 'node:fs/promises';
import { loadPlaywright, launchOwnedBrowser, Portal } from '../scripts/browser.mjs';
import { guardianConfig, providerRequestAllowed } from '../scripts/core.mjs';

// Anonymous rendering only: no authenticate(), cookies, response bodies, raw
// page text, screenshots or browser errors. Even a rendered ESIA form stays
// empty. Retain bounded static paths and numeric rendering evidence only.
const lines = readline.createInterface({ input: process.stdin });
const config = guardianConfig(await new Promise(resolve => lines.once('line', resolve)));
const waiting = new Map(); let sequence = 0, owned;
lines.on('line', line => { const packet = JSON.parse(line); waiting.get(packet.id)?.(); waiting.delete(packet.id); });
const permit = async (op = 'permit', extra = {}) => {
  const id = ++sequence, ack = new Promise(resolve => waiting.set(id, resolve));
  process.stdout.write(`${JSON.stringify({ id, op, ...extra })}\n`); await ack;
};
const observations = new Map(); let requestsTruncated = false;
function observe(request, extra = {}) {
  const url = new URL(request.url());
  // Non-static paths and every query/fragment may carry a challenge identifier.
  const asset = url.pathname.length <= 300 && /^\/[a-zA-Z0-9_./-]+\.(?:js|json|html|css|woff2?|png|svg|ico)$/.test(url.pathname);
  const entry = { origin: url.origin, path: asset ? url.pathname : '[non-static]',
    type: request.resourceType(), method: request.method(),
    allowed: providerRequestAllowed({ url: request.url(), navigation: request.isNavigationRequest(),
      method: request.method(), resourceType: request.resourceType() }), ...extra };
  const identity = JSON.stringify([entry.origin, entry.path, entry.type, entry.method]);
  if (observations.has(identity) || observations.size < 150)
    observations.set(identity, { ...observations.get(identity), ...entry });
  else requestsTruncated = true;
}
try {
  owned = await launchOwnedBrowser({ playwright: await loadPlaywright(config.root), permit });
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
  await portal.page.waitForTimeout(15000);
  const surface = await portal.page.evaluate(() => ({ bodyChildren: document.body?.children.length ?? 0,
    textLength: document.body?.innerText.length ?? 0, inputs: document.querySelectorAll('input').length,
    unresolvedTemplates: (document.body?.innerText.match(/\{\{[^}]+\}\}/g) ?? []).length,
    styleSheets: document.styleSheets.length, origin: location.origin,
    // Fixed categories catch the real public error page without exposing a
    // redirect/challenge URL or copying arbitrary page text into diagnostics.
    pageKind: /^\/404\/?$/.test(location.pathname) ? 'not_found' :
      /^\/lk(?:\/|$)/.test(location.pathname) ? 'account' : 'other',
    loginField: Boolean(document.querySelector('input#login')),
    loginControls: [...document.querySelectorAll('a,button')].filter(node => /^Войти$/.test(node.textContent.trim())).length,
    notFound: /страница не найдена|страницу не найд|нет такой страницы|ничего не нашлось/i.test(document.body?.innerText ?? ''),
    loginTargets: [...document.querySelectorAll('a,button')].filter(node => /^Войти$/.test(node.textContent.trim())).slice(0, 4).map(node => {
      const href = node.getAttribute('href');
      if (!href) return { tag: node.tagName.toLowerCase(), link: false };
      const url = new URL(href, location.href);
      return { tag: node.tagName.toLowerCase(), link: true, origin: url.origin,
        pathKind: ['/auth/esia/', '/auth/esia', '/idp/rlogin', '/login', '/login/'].includes(url.pathname) ? url.pathname : 'other' };
    }),
    errorHeadings: [...document.querySelectorAll('h1,h2')].filter(node => /ошибк|не найден|не нашлось|недоступ/i.test(node.textContent)).length }));
  // Exercise the same storage boundary without returning any stored values.
  // Static resource permission must not introduce a foreign vault origin.
  await portal.storage();
  await fs.writeFile(config.file, JSON.stringify({ surface, requestsTruncated, requests: [...observations.values()] }), { mode: 0o600 });
} catch (error) {
  await fs.writeFile(config.file, JSON.stringify({ errorClass: error.name, requestsTruncated, requests: [...observations.values()] }), { mode: 0o600 });
} finally {
  await owned?.browser.close().catch(() => {}); await owned?.server.close().catch(() => {});
  process.exit(0);
}
