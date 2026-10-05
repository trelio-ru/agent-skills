import assert from 'node:assert/strict';
import { Portal } from '../scripts/browser.mjs';

// Exercise Portal.open itself. The transport below replaces only the final
// network dispatch with synthetic responses; the production route handler must
// admit each request first. A blanket fixture route in front of Portal.open
// would hide the real bug by fulfilling even resources rejected by the runtime.
export async function staticAssetsSmoke(browser, permit) {
  const delivered = [];
  const fixtureBrowser = { newContext: async options => {
    const context = await browser.newContext(options);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      delivered.push(url.origin + url.pathname);
      const headers = { 'Access-Control-Allow-Origin': url.pathname.startsWith('/sf-portal-st/')
        ? 'https://www.gosuslugi.ru' : 'https://fssp.gosuslugi.ru' };
      if (url.href === 'https://www.gosuslugi.ru/') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
          <a href="https://fssp.gosuslugi.ru/order/result/123">Задолженность ФССП</a>` });
      } else if (url.href === 'https://fssp.gosuslugi.ru/order/result/123') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
          <link rel="stylesheet" href="https://gu-st.ru/htdocs/css/style.css">
          <h1 id="title">{{block.title}}</h1><main id="view"></main>
          <span id="debt-caption">RESULT.DEBT_INFO.CURRENT_DEBT</span>
          <span id="back-caption">BUTTONS.BACK</span>
          <a href="https://www.gosuslugi.ru/" target="_blank">Открыть окно</a>
          <button onclick="window.open('https://www.gosuslugi.ru/', '_blank')">Открыть через скрипт</button>
          <button onclick="setTimeout(() => window.open('https://www.gosuslugi.ru/', '_blank'), 500)">Открыть с задержкой</button>
          <script src="https://gu-st.ru/htdocs/js/bootstrap.js"></script>
          <script src="https://stat.sputnik.ru/cnt.js"></script>` });
      } else if (url.href === 'https://www.gosuslugi.ru/600367/1/form') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
          <span id="form-caption">FORM.TITLE</span><span id="form-common">BUTTONS.BACK</span>
          <script>
            fetch('https://gu-st.ru/sf-portal-st/assets/i18n/ru.3.510.10-0-fs.json')
              .then(r => r.json()).then(words => document.querySelector('#form-caption').textContent = words['FORM.TITLE']);
            fetch('https://gu-st.ru/sf-portal-st/lib-assets/i18n/ru.3.508.2-3-standalone.json')
              .then(r => r.json()).then(words => document.querySelector('#form-common').textContent = words['BUTTONS.BACK']);
          </script>` });
      } else if (url.href === 'https://gu-st.ru/htdocs/css/style.css') {
        await route.fulfill({ contentType: 'text/css', body: '#title { color: rgb(11, 22, 33); }' });
      } else if (url.href === 'https://gu-st.ru/htdocs/js/bootstrap.js') {
        await route.fulfill({ contentType: 'application/javascript', body: `
          fetch('https://gu-st.ru/htdocs/tpl/index/index-123.html').then(r => r.text()).then(html => {
            document.querySelector('#view').innerHTML = html;
            document.querySelector('#title').textContent = 'Мои документы';
          });
          // Model the FSSP page's two independent dictionaries. If either
          // request is blocked by Portal.open, its key stays visible.
          fetch('https://gu-st.ru/fssp-st/assets/i18n/fssp/ru.3.508.2.json').then(r => r.json()).then(words => {
            document.querySelector('#debt-caption').textContent = words['RESULT.DEBT_INFO.CURRENT_DEBT'];
          });
          fetch('https://gu-st.ru/fssp-st/assets/i18n/ru.3.508.2.json').then(r => r.json()).then(words => {
            document.querySelector('#back-caption').textContent = words['BUTTONS.BACK'];
          });` });
      } else if (url.href === 'https://gu-st.ru/htdocs/tpl/index/index-123.html') {
        await route.fulfill({ headers, contentType: 'text/html', body: '<p id="ready">Документы загружены</p>' });
      } else if (url.href === 'https://gu-st.ru/fssp-st/assets/i18n/fssp/ru.3.508.2.json') {
        await route.fulfill({ headers, contentType: 'application/json', body: '{"RESULT.DEBT_INFO.CURRENT_DEBT":"Текущая задолженность"}' });
      } else if (url.href === 'https://gu-st.ru/fssp-st/assets/i18n/ru.3.508.2.json') {
        await route.fulfill({ headers, contentType: 'application/json', body: '{"BUTTONS.BACK":"Назад"}' });
      } else if (url.href === 'https://gu-st.ru/sf-portal-st/assets/i18n/ru.3.510.10-0-fs.json') {
        await route.fulfill({ headers, contentType: 'application/json', body: '{"FORM.TITLE":"Обращение в ФССП"}' });
      } else if (url.href === 'https://gu-st.ru/sf-portal-st/lib-assets/i18n/ru.3.508.2-3-standalone.json') {
        await route.fulfill({ headers, contentType: 'application/json', body: '{"BUTTONS.BACK":"Назад"}' });
      } else {
        // There is never a fallback to the real network, even when a broken
        // policy accidentally admits an unexpected fixture request.
        await route.abort();
      }
    });
    const register = context.route.bind(context);
    context.route = (pattern, handler) => register(pattern, route => handler(new Proxy(route, {
      get(target, key) {
        if (key === 'continue') return () => route.fallback();
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })));
    return context;
  } };
  const portal = new Portal(fixtureBrowser, permit, { onPhase: () => {}, persist: () => {} });
  try {
    await portal.open(null);
    // Exercise the same allowed click path that opens a FSSP result inside the
    // owned browser. Reading a snapshot and following its link must not make
    // the headed browser active before either translation request completes.
    const link = (await portal.snapshot(value => value)).controls.find(control => control.label === 'Задолженность ФССП');
    assert.ok(link);
    await portal.action({ action: 'click', ref: link.ref });
    await portal.page.waitForURL('https://fssp.gosuslugi.ru/order/result/123');
    await portal.page.locator('#ready').waitFor();
    await portal.page.getByText('Текущая задолженность', { exact: true }).waitFor();
    await portal.page.getByText('Назад', { exact: true }).waitFor();
    const popup = (await portal.snapshot(value => value)).controls.find(control => control.label === 'Открыть окно');
    assert.ok(popup);
    await assert.rejects(portal.action({ action: 'click', ref: popup.ref }), /popup_requires_manual/);
    const scripted = (await portal.snapshot(value => value)).controls.find(control => control.label === 'Открыть через скрипт');
    assert.ok(scripted);
    await assert.rejects(portal.action({ action: 'click', ref: scripted.ref }), /popup_requires_manual/);
    const delayed = (await portal.snapshot(value => value)).controls.find(control => control.label === 'Открыть с задержкой');
    assert.ok(delayed);
    // The timer can fire after click dispatch returns. Its popup must still be
    // blocked by the page guard, without activating another browser window.
    await portal.action({ action: 'click', ref: delayed.ref });
    await portal.page.waitForTimeout(650);
    assert.equal(await portal.page.evaluate(() => window.__trelioPopupGuard()), 2);
    assert.equal(portal.context.pages().length, 1, 'deferred popup must not create a second browser page');
    assert.equal(await portal.page.locator('#title').textContent(), 'Мои документы');
    assert.equal(await portal.page.locator('#title').evaluate(node => getComputedStyle(node).color), 'rgb(11, 22, 33)');
    for (const [url, method] of [['https://gu-st.ru/api/profile', 'GET'],
      ['https://gu-st.ru/htdocs/tpl/index/index-123.html', 'POST']]) {
      const blocked = await portal.page.evaluate(async ({ url, method }) => {
        try { await fetch(url, { method }); return false; } catch { return true; }
      }, { url, method });
      assert.equal(blocked, true);
    }
    assert.equal(delivered.some(url => url.includes('stat.sputnik.ru') || url.includes('/api/')), false);
    assert.equal(delivered.filter(url => url.endsWith('/index-123.html')).length, 1, 'POST must not reach the static transport');
    assert.equal(delivered.filter(url => url.includes('/fssp-st/') && url.endsWith('.json')).length, 2);
    await portal.action({ action: 'navigate', url: 'https://www.gosuslugi.ru/600367/1/form' });
    await portal.page.getByText('Обращение в ФССП', { exact: true }).waitFor();
    await portal.page.getByText('Назад', { exact: true }).waitFor();
    assert.equal(delivered.filter(url => url.includes('/sf-portal-st/') && url.endsWith('.json')).length, 2);
    await assert.rejects(portal.action({ action: 'navigate', url: 'https://gu-st.ru/htdocs/tpl/index/index-123.html' }), /provider_url_rejected/);
    assert.deepEqual(await portal.storage(), { cookies: [], origins: [] });
    await assert.rejects(portal.page.goto('https://gu-st.ru/htdocs/tpl/index/index-123.html'));
  } finally {
    await portal.close();
  }
}
