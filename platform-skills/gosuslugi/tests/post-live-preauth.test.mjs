import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapBrowser, loadPlaywright } from '../scripts/browser.mjs';
import { createEsiaAuthorization } from '../scripts/playwright-client.mjs';

// Run explicitly with GOSUSLUGI_LIVE_POST_PREAUTH=1 before publishing a Postal
// login change. This reads the real public Post redirects and stops at the ESIA
// login page. Synthetic identities have no vault and no credential is entered.
test('live public Post ID handoff reaches the real ESIA request', {
  skip: process.env.GOSUSLUGI_LIVE_POST_PREAUTH !== '1',
  timeout: 90000,
}, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'post-preauth-probe-'));
  let browser, context, login;
  try {
    await bootstrapBrowser(root);
    const playwright = await loadPlaywright(root);
    browser = await playwright.chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true,
    });
    context = await browser.newContext();
    const page = await context.newPage();
    let postIdSeen = false, esiaSeen = false;
    context.on('request', request => {
      if (!request.isNavigationRequest()) return;
      const url = new URL(request.url());
      if (url.origin + url.pathname === 'https://passport.pochta.ru/oauth2/authorize') {
        postIdSeen = url.searchParams.get('redirect_uri') === 'https://zakaznoe.pochta.ru/oauth2/cb';
      }
      if (url.origin + url.pathname === 'https://esia.gosuslugi.ru/aas/oauth2/ac') {
        esiaSeen = url.searchParams.get('redirect_uri') ===
          'https://passport.pochta.ru/pc/ext/v1.0/authorize/esia';
      }
    });
    await page.goto('https://zakaznoe.pochta.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    login = await createEsiaAuthorization(page, {
      origin: 'https://zakaznoe.pochta.ru',
      company: '11111111-1111-4111-8111-111111111111',
      member: '22222222-2222-4222-8222-222222222222',
      configHome: root, confirm: true,
    });
    await page.getByText('Подключить через Госуслуги', { exact: true }).first().click({ timeout: 15000 });
    let timeout;
    try {
      await Promise.race([
        login.request,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('public_post_handoff_timeout')), 30000);
        }),
      ]);
    } finally { clearTimeout(timeout); }
    assert.equal(postIdSeen, true, 'Post ID authorization must bind its observed letters callback');
    assert.equal(esiaSeen, true, 'the browser must request ESIA with the observed Passport callback');
  } finally {
    if (login) await login.close();
    if (context) await context.close();
    if (browser) await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
