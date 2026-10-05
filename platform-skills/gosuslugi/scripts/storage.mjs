import { requireThat, RuntimeError } from './core.mjs';
import { newOwnedStoragePage } from './windows.mjs';
import { storageCodec } from './storage-codec.mjs';

// BrowserContext.storageState and newContext({storageState}) secretly create
// foreground pages for non-current origins. Use the same reviewed codec in an
// explicit owned background tab. Its synthetic documents never reach a server
// or execute provider JavaScript; the working/authentication page stays intact.
async function withStoragePage(context, origins, permit, operation) {
  requireThat(origins.length <= 100 && origins.every(origin => {
    try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin; }
    catch { return false; }
  }), 'storage_state_invalid');
  await permit();
  const page = await newOwnedStoragePage(context);
  let expected = null;
  try {
    await page.route('**/*', route => {
      const request = route.request();
      // This route precedes the context's network policy, but can only fulfill
      // the one inert origin document selected by the private storage loop.
      // There is no route.continue/fallback and no provider HTTP request.
      if (expected && request.url() === `${expected}/` && request.method() === 'GET' &&
          request.isNavigationRequest() && request.frame() === page.mainFrame())
        return route.fulfill({ contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" },
          body: '<!doctype html><title></title>' });
      return route.abort('blockedbyclient');
    });
    const result = [];
    for (const origin of origins) {
      await permit(); expected = origin;
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      result.push(await operation(page, origin));
    }
    return result;
  } catch (error) {
    // Playwright errors can include serialized state. Only this fixed category
    // may escape to the worker/status channel; ciphertext stays unchanged.
    throw error instanceof RuntimeError ? error : new RuntimeError('storage_state_transfer_failed');
  } finally { await page.close().catch(() => {}); }
}

export async function restoreOriginStorage(context, state, permit) {
  if (!state.origins.length) return;
  await withStoragePage(context, state.origins.map(item => item.origin), permit,
    (page, origin) => page.evaluate(storageCodec, { mode: 'restore', state: state.origins.find(item => item.origin === origin) }));
}

export async function collectOriginStorage(context, origins, permit) {
  const collected = origins.length ? await withStoragePage(context, origins, permit, async (page, origin) =>
    ({ origin, ...await page.evaluate(storageCodec, { mode: 'collect' }) })) : [];
  await permit();
  const state = { cookies: await context.cookies(),
    origins: collected.filter(item => item.localStorage.length || item.indexedDB?.length) };
  requireThat(Buffer.byteLength(JSON.stringify(state)) <= 4 * 1024 * 1024, 'vault_too_large');
  return state;
}
