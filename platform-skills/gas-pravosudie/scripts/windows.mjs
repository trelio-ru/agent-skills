import { requireThat, RuntimeError } from './core.mjs';

const browsers = new WeakMap(), contexts = new WeakMap(), pages = new WeakMap();

// Configure only the runtime-created contexts. Browser/newContext and the real
// Page/BrowserContext objects remain available to trusted agent scenarios.
// Native background target creation avoids both foreground flashes and any OS
// workaround that would hide/activate somebody else's application afterwards.
export async function newBackgroundContext(browser, options) {
  let owner = browsers.get(browser);
  if (!owner) {
    owner = { session: browser.newBrowserCDPSession(), creating: Promise.resolve() };
    browsers.set(browser, owner);
  }
  const operation = owner.creating.catch(() => {}).then(async () => {
    const session = await owner.session;
    // Restore origin state separately: Playwright's built-in restore creates
    // a foreground page even before the first requested court page exists.
    requireThat(!options?.storageState?.origins?.length, 'use_private_origin_storage');
    const before = new Set((await session.send('Target.getBrowserContexts')).browserContextIds);
    const context = await browser.newContext(options);
    try {
      const added = (await session.send('Target.getBrowserContexts')).browserContextIds.filter(id => !before.has(id));
      requireThat(added.length === 1, 'browser_context_binding_failed');
      const state = { creating: Promise.resolve() };
      state.createPage = (storage = false) => {
        const creation = state.creating.catch(() => {}).then(async () => {
          // A full-context caller can close the initial page and keep only a
          // provider popup. Resolve the current context's windows afresh so
          // storage still reuses its actual surviving window, not a stale ID.
          const existingWindows = new Set();
          for (const page of context.pages()) {
            if (page.isClosed()) continue;
            let binding;
            try {
              binding = await context.newCDPSession(page);
              const { targetInfo } = await binding.send('Target.getTargetInfo');
              requireThat(targetInfo.browserContextId === added[0], 'browser_page_binding_failed');
              existingWindows.add((await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })).windowId);
            } catch (error) {
              // Edge can retain a download-only page target with no native
              // window. A page may also close during this read-only inventory.
              // Neither owns a window to reuse; other protocol failures must
              // still fail closed instead of silently losing ownership checks.
              if (!page.isClosed() && !String(error.message).includes('Protocol error (Browser.getWindowForTarget): Browser window not found')) throw error;
            } finally { await binding?.detach().catch(() => {}); }
          }
          let resolveTarget;
          const target = new Promise(resolve => { resolveTarget = resolve; });
          // A simultaneous popup is not our page. Match the exact public CDP
          // target/context IDs rather than taking the first page event.
          const ready = context.waitForEvent('page', { timeout: 10000, predicate: async page => {
            const targetId = await target;
            if (!targetId || page.isClosed()) return false;
            const binding = await context.newCDPSession(page);
            try {
              const { targetInfo } = await binding.send('Target.getTargetInfo');
              return targetInfo.targetId === targetId && targetInfo.browserContextId === added[0];
            } finally { await binding.detach(); }
          } });
          ready.catch(() => {});
          let targetId;
          try {
            ({ targetId } = await session.send('Target.createTarget', { url: 'about:blank', browserContextId: added[0],
              background: true, focus: false, newWindow: existingWindows.size === 0 }));
          } finally { resolveTarget(targetId); }
          const page = await ready;
          const { windowId } = await session.send('Browser.getWindowForTarget', { targetId });
          if (storage && existingWindows.size) requireThat(existingWindows.has(windowId), 'storage_window_binding_failed');
          pages.set(page, { storage });
          return page;
        });
        state.creating = creation;
        return creation;
      };
      contexts.set(context, state);
      context.newPage = () => state.createPage();
      return context;
    } catch (error) {
      await context.close();
      throw error instanceof RuntimeError ? error : new RuntimeError('browser_background_unavailable');
    }
  });
  owner.creating = operation;
  return operation;
}

export async function isOwnedPage(page) {
  // The page event can arrive before its Target.createTarget acknowledgement.
  // Classification waits for the exact binding; unrelated popups stay unowned.
  await contexts.get(page.context())?.creating.catch(() => {});
  return pages.has(page);
}

export function newOwnedStoragePage(context) {
  const state = contexts.get(context);
  requireThat(state, 'browser_context_binding_failed');
  return state.createPage(true);
}
