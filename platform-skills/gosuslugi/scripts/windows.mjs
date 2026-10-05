import { requireThat, RuntimeError } from './core.mjs';

const windows = new WeakMap();
const contexts = new WeakMap();

// Playwright's normal newPage creates a foreground window. Configure only the
// native-owned browser to create inactive headed targets from the outset.
// Chromium implements minimized creation as ShowInactive followed by Minimize.
// Keep the inactive window in its normal state without that visible animation.
// No OS application is activated, hidden or selected by name; user-owned
// windows are never touched.
export async function backgroundBrowser(browser) {
  const session = await browser.newBrowserCDPSession();
  const createContext = browser.newContext.bind(browser);
  let creating = Promise.resolve();
  browser.newContext = options => {
    // Context IDs are obtained from the protocol, not private Playwright fields.
    // Serialize this short sequence so simultaneous callers cannot bind a page
    // to somebody else's in-memory context or accidentally reuse its cookies.
    const operation = creating.catch(() => {}).then(async () => {
      requireThat(!options?.storageState?.origins?.length, 'use_private_origin_storage');
      requireThat(options?.viewport === null, 'inactive_browser_requires_native_viewport');
      const before = new Set((await session.send('Target.getBrowserContexts')).browserContextIds);
      const context = await createContext(options);
      try {
        const added = (await session.send('Target.getBrowserContexts')).browserContextIds.filter(id => !before.has(id));
        requireThat(added.length === 1, 'browser_context_binding_failed');
        const state = { creating: Promise.resolve(), windowId: null };
        const createPage = (storage = false) => {
          const operation = state.creating.catch(() => {}).then(async () => {
            const ready = context.waitForEvent('page', { timeout: 10000 });
            ready.catch(() => {});
            const { targetId } = await session.send('Target.createTarget', { url: 'about:blank',
              browserContextId: added[0], background: true, focus: false, newWindow: !storage });
            const page = await ready;
            const binding = await context.newCDPSession(page);
            try {
              const { targetInfo } = await binding.send('Target.getTargetInfo');
              requireThat(targetInfo.targetId === targetId && targetInfo.browserContextId === added[0], 'browser_page_binding_failed');
            } finally { await binding.detach(); }
            const { windowId } = await session.send('Browser.getWindowForTarget', { targetId });
            if (storage) requireThat(windowId === state.windowId, 'storage_window_binding_failed');
            else state.windowId = windowId;
            windows.set(page, { session, targetId, windowId, storage });
            return page;
          });
          state.creating = operation;
          return operation;
        };
        state.createPage = createPage;
        contexts.set(context, state);
        context.newPage = () => createPage(false);
        return context;
      } catch (error) { await context.close(); throw error instanceof RuntimeError ? error : new RuntimeError('browser_background_unavailable'); }
    });
    creating = operation;
    return operation;
  };
}

export async function isOwnedPage(page) {
  // The context's page event can precede Target.createTarget's result. Wait for
  // that exact creation/binding to finish before classifying the page. A popup
  // cannot acquire ownership: the target and context IDs are checked above.
  await contexts.get(page.context())?.creating.catch(() => {});
  return windows.has(page);
}

export function newOwnedStoragePage(context) {
  const state = contexts.get(context); requireThat(state, 'browser_context_binding_failed');
  // Reuse the existing context's window as a background tab. A storage
  // snapshot must not create or activate a second native window.
  return state.createPage(true);
}

async function requireWindowState(session, windowId, state) {
  // A native window restore can finish after the protocol command is accepted.
  // Poll only that one bounded transition; never reissue the window action.
  for (let attempt = 0; attempt < 30; attempt++) {
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    if (bounds.windowState === state) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new RuntimeError('browser_background_required');
}

export async function showOwnedPage(page) {
  const window = windows.get(page); requireThat(window, 'browser_page_binding_failed');
  await window.session.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
  await requireWindowState(window.session, window.windowId, 'normal');
  await page.bringToFront();
}
export async function ownedPageWindowState(page) {
  const window = windows.get(page); requireThat(window, 'browser_page_binding_failed');
  const result = await window.session.send('Browser.getWindowBounds', { windowId: window.windowId });
  return result.bounds.windowState;
}
