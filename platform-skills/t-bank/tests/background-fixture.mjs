import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Portal } from '../scripts/browser.mjs';

// Observe only a PID, never a user's window title or contents. No activation,
// hiding or restoration of another app is allowed to make this assertion pass.
export function assertBackground(browserPid, phase) {
  let pid;
  if (process.platform === 'darwin') {
    const front = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    assert.match(front, /^ASN:[a-f0-9x-]+:$/i);
    const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', front], { encoding: 'utf8' });
    const match = info.match(/"pid"=(\d+)/); assert.ok(match);
    pid = Number(match[1]);
  } else if (process.platform === 'win32') {
    const source = 'using System; using System.Runtime.InteropServices; public class FocusProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }';
    pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -TypeDefinition '${source}'; [uint32]$focusPid=0; [void][FocusProbe]::GetWindowThreadProcessId([FocusProbe]::GetForegroundWindow(),[ref]$focusPid); $focusPid`],
    { encoding: 'utf8', windowsHide: true }).trim());
    assert.ok(Number.isFinite(pid));
  } else return;
  assert.notEqual(pid, browserPid, `automatic browser operations must not take OS focus: ${phase}`);
}

export async function testBackgroundStorage(browser, permit, browserPid) {
  let requests = 0, authExternal = 0;
  const fixtureBrowser = {
    newBrowserCDPSession: () => browser.newBrowserCDPSession(),
    newContext: async options => {
      const context = await browser.newContext(options);
      await context.route('**/*', async route => {
        requests++;
        const url = new URL(route.request().url());
        if (url.hostname === 'chat.example') {
          if (url.pathname.startsWith('/auth-')) authExternal++;
          return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/plain',
            headers: { 'Access-Control-Allow-Origin': '*' }, body: url.pathname.endsWith('.js') ? 'window.chatLoaded=true' : 'chat-ready' });
        }
        if (url.hostname === 'id.tbank.ru') return route.fulfill({ contentType: 'text/html', body: `
          <h1>Введите пароль</h1><input type="password">
          <script src="https://chat.example/auth-script.js"></script>
          <script>window.authProbe=fetch('https://chat.example/auth-fetch').then(()=>false,()=>true)</script>` });
        if (url.hostname === 'www.tbank.ru') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <h1>Мои счета</h1><button>Выйти</button><textarea id="draft"></textarea><p id="chat"></p>
          <script src="https://chat.example/chat.js"></script>
          <script>fetch('https://chat.example/chat-data').then(r=>r.text()).then(t=>document.getElementById('chat').textContent=t)</script>` });
        return route.abort();
      });
      return context;
    },
  };
  const makePortal = () => new Portal(fixtureBrowser, permit, { onPhase() {}, persist: async () => {} });
  const bank = makePortal(); let restored;
  try {
    await bank.open(null);
    await bank.page.getByText('chat-ready', { exact: true }).waitFor();
    assert.equal(await bank.page.evaluate(() => window.chatLoaded), true, 'chat bootstraps before handoff without reloading');
    assert.equal(bank.handedOff, false);
    assertBackground(browserPid, 'initial cabinet and external chat');
    await bank.page.goto('https://id.tbank.ru/auth/step');
    assert.equal(await bank.page.evaluate(() => window.authProbe), true);
    assert.equal(authExternal, 0, 'auth scripts and XHR keep the strict network boundary');
    await bank.page.evaluate(async () => {
      localStorage.setItem('synthetic-session', 'id-session');
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('synthetic-idb', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('entries', 'readwrite');
        tx.objectStore('entries').put({ when: new Date('2024-01-02T03:04:05Z'), amount: 42n, bytes: new Uint8Array([2, 7]) }, 'record');
        tx.oncomplete = resolve; tx.onerror = reject;
      });
      db.close();
    });
    await bank.page.goto('https://www.tbank.ru/mybank/');
    await bank.page.getByText('chat-ready', { exact: true }).waitFor();
    await bank.page.evaluate(() => localStorage.setItem('synthetic-session', 'bank-session'));
    await bank.page.locator('#draft').fill('unsent synthetic draft');
    await bank.context.addCookies([{ name: 'synthetic-cookie', value: 'session-only', domain: '.tbank.ru', path: '/', secure: true }]);
    const before = requests;
    let saved;
    for (let step = 0; step < 3; step++) {
      saved = await bank.storage();
      assertBackground(browserPid, `storage snapshot ${step}`);
      assert.equal(bank.context.pages().length, 1, 'private storage tab is closed');
      assert.equal(await bank.page.locator('#draft').inputValue(), 'unsent synthetic draft');
      assert.equal(bank.page.url(), 'https://www.tbank.ru/mybank/');
      assert.equal(requests, before, 'storage transfer must never reach the network');
    }
    assert.equal(saved.origins.length, 2);
    assert.equal(saved.cookies[0].name, 'synthetic-cookie');
    const extra = await bank.context.newPage();
    assert.equal(extra.context(), bank.context);
    assertBackground(browserPid, 'ordinary context.newPage');
    await extra.close();
    await bank.close();
    restored = makePortal(); await restored.open(saved);
    assertBackground(browserPid, 'restore saved origins');
    assert.equal(restored.context.pages().length, 1);
    assert.equal(await restored.page.evaluate(() => localStorage.getItem('synthetic-session')), 'bank-session');
    await restored.page.goto('https://id.tbank.ru/auth/step');
    assert.deepEqual(await restored.page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('synthetic-idb'); request.onsuccess = () => resolve(request.result); });
      const value = await new Promise(resolve => { const request = db.transaction('entries').objectStore('entries').get('record'); request.onsuccess = () => resolve(request.result); });
      db.close();
      return { session: localStorage.getItem('synthetic-session'), date: value.when.toISOString(), big: String(value.amount), bytes: [...value.bytes] };
    }), { session: 'id-session', date: '2024-01-02T03:04:05.000Z', big: '42', bytes: [2, 7] });
    assertBackground(browserPid, 'IndexedDB restore and auth guard');
  } finally { await bank.close().catch(() => {}); await restored?.close().catch(() => {}); }
}
