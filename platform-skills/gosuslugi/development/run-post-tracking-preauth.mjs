// Public, credential-free maintainer probe. It stops at the ESIA request and
// never invokes authorize or reads a vault. Only URL structure is reported;
// OAuth values, auth DOM, cookies, request bodies and headers stay private.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEsiaAuthorization } from '../scripts/playwright-client.mjs';

const modulePath = process.argv[2];
if (!modulePath || !path.isAbsolute(modulePath)) throw new Error('playwright_module_required');
const { chromium } = await import(pathToFileURL(modulePath).href);
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'post-tracking-preauth-'));
let browser, context, login;
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: false });
  context = await browser.newContext();
  const page = await context.newPage();
  // Observe the relying party's outer Post ID request before following it.
  // Only allowlisted structural URL metadata can leave this public probe.
  let structuralCount = 0;
  context.on('request', request => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame() || structuralCount++ >= 15) return;
    const url = new URL(request.url());
    const redirect = url.searchParams.get('redirect_uri');
    let redirectTarget;
    try { const target = new URL(redirect); redirectTarget = { origin: target.origin, path: target.pathname }; } catch {}
    console.log(JSON.stringify({ phase: 'public_navigation', origin: url.origin, path: url.pathname,
      parameters: [...url.searchParams.keys()], redirectTarget }));
  });
  await page.goto('https://www.pochta.ru/tracking', { waitUntil: 'domcontentloaded', timeout: 30000 });
  login = await createEsiaAuthorization(page, {
    origin: 'https://www.pochta.ru', configHome: root, confirm: true,
    company: '11111111-1111-4111-8111-111111111111', member: '22222222-2222-4222-8222-222222222222',
  });
  const signIn = page.locator('a[href*="/api/auth/login"]').first();
  await signIn.click({ timeout: 15000 });
  await page.waitForURL(url => url.origin === 'https://passport.pochta.ru', { timeout: 15000 });
  await page.getByText(/Госуслуги/i).click({ timeout: 15000 });
  let timeout;
  try {
    await Promise.race([login.request, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(new Error(), { code: 'preauth_timeout' })), 20000);
    })]);
    console.log(JSON.stringify({ phase: 'esia_request_ready' }));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'preauth_failed', code: error.code || 'preauth_unknown' }));
    process.exitCode = 1;
  } finally { clearTimeout(timeout); }
} catch (error) {
  console.log(JSON.stringify({ phase: 'probe_failed', code: error.code || error.name || 'unknown' }));
  process.exitCode = 1;
} finally {
  await login?.close();
  await context?.close();
  await browser?.close();
  await fs.rm(root, { recursive: true, force: true });
}
