import './http-host-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Portal } from '../scripts/browser.mjs';
import { compileScenario, executeScenario } from '../scripts/scenario.mjs';

/** Real Playwright, synthetic bank/partner/download responses only. */
export async function testPlaywrightScenarios(browser, nativePermit, root) {
  let expired = false, phase, foreignRequests = 0;
  const fixtureBrowser = {
    newBrowserCDPSession: () => browser.newBrowserCDPSession(),
    newContext: async options => {
      const context = await browser.newContext(options);
      // Portal.open adds its real auth policy above this route. Allowed
      // requests fall through to our fixture, never to an actual bank.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://bank-partner.example') {
          foreignRequests++;
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body:
            '<h1>Синтетический партнёр</h1><script>localStorage.setItem("partner-session","synthetic-only")</script>' });
        } else if (url.origin === 'https://www.tbank.ru' && url.pathname === '/statement.txt') {
          await route.fulfill({ contentType: 'text/plain', headers: { 'Content-Disposition': 'attachment; filename="statement.txt"' }, body: 'synthetic statement' });
        } else if (url.origin === 'https://www.tbank.ru') {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
            <h1>Мои счета</h1><button>Выйти</button><button>Полные реквизиты</button>
            <div contenteditable="true" aria-label="Сообщение"></div>
            <input type="file" aria-label="Приложить файл">
            <button id="send">Отправить</button><p id="result"></p>
            <a href="https://bank-partner.example/confirm" target="_blank">Открыть партнёра</a>
            <a href="/statement.txt">Выписка</a>
            <iframe src="https://bank-partner.example/frame"></iframe>
            <script>window.sends=0;document.getElementById('send').onclick=()=>{
              sends++;document.getElementById('result').textContent='Отправлено '+sends;
            };localStorage.setItem('bank-session','synthetic-only');</script>` });
        } else await route.abort();
      });
      return context;
    },
  };
  const bank = new Portal(fixtureBrowser, async (...args) => {
    if (expired) throw Error('synthetic_expired');
    return nativePermit(...args);
  }, { onPhase: value => { phase = value; }, persist: async () => {} });
  try {
    await bank.open(null);
    await assert.rejects(bank.playwrightContext(), /session_not_ready/);
    await bank.page.frameLocator('iframe').locator('h1').waitFor();
    assert.equal(foreignRequests, 1, 'the cabinet loads its partner frame before handoff');
    assert.equal(await bank.authenticate({}), true); assert.equal(phase, 'ready');
    await bank.page.locator('body').evaluate(body => { const input = document.createElement('input'); input.type = 'password'; input.id = 'renewed-login'; body.append(input); });
    await assert.rejects(bank.playwrightContext(), /authentication_is_private/);
    assert.equal(bank.handedOff, false, 'a returned login screen must not be handed over');
    await bank.page.locator('#renewed-login').evaluate(input => input.remove());
    const originalContext = bank.context, originalPage = bank.page;
    const handles = await bank.playwrightContext();
    assert.equal(handles.context, originalContext); assert.equal(handles.page, originalPage);
    assert.equal(bank.handedOff, true);
    const readonly = await executeScenario(compileScenario('return { heading: await page.locator("h1").innerText(), sends: await page.evaluate(() => window.sends) };'), handles);
    assert.deepEqual(readonly.result, { heading: 'Мои счета', sends: 0 });

    // This uses locators, evaluation, upload, a popup, a cross-origin frame
    // and a native download. It is impossible through the old fixed actions.
    const downloadPath = path.join(root, 'synthetic-statement.txt');
    const result = await executeScenario(compileScenario(`
      await page.getByRole('textbox').count();
      await page.locator('[contenteditable]').fill('Синтетический вопрос');
      await page.getByLabel('Приложить файл').setInputFiles({ name: 'question.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic upload') });
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      const popupPromise = context.waitForEvent('page');
      await page.getByRole('link', { name: 'Открыть партнёра' }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      const partner = await popup.locator('h1').innerText();
      // Edge can still expose the previous blocked-page h1 until the new
      // cross-process frame navigation commits. Await that exact document.
      const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
      await Promise.all([
        frame.waitForURL('https://bank-partner.example/frame?after=handoff', { waitUntil: 'domcontentloaded' }),
        page.locator('iframe').evaluate(frame => { frame.src = 'https://bank-partner.example/frame?after=handoff'; })
      ]);
      const frameHeading = await page.frameLocator('iframe').locator('h1').innerText();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Выписка' }).click();
      const download = await downloadPromise;
      await download.saveAs(${JSON.stringify(downloadPath)});
      return { result: await page.locator('#result').innerText(), partner, frameHeading,
        file: await page.getByLabel('Приложить файл').evaluate(input => input.files[0].name),
        download: download.suggestedFilename(), originalOpen: context.pages().includes(page),
        popupOpen: context.pages().includes(popup) && !popup.isClosed() };
    `), handles);
    assert.deepEqual(result.result, { result: 'Отправлено 1', partner: 'Синтетический партнёр',
      frameHeading: 'Синтетический партнёр', file: 'question.txt', download: 'statement.txt', originalOpen: true, popupOpen: true });
    assert.equal(await fs.readFile(downloadPath, 'utf8'), 'synthetic statement');
    const saved = await bank.storage();
    assert.ok(saved.origins.some(origin => origin.origin === 'https://www.tbank.ru'));
    assert.ok(!saved.origins.some(origin => origin.origin === 'https://bank-partner.example'), 'external state is not imported into the bank vault');
    const again = await bank.playwrightContext();
    assert.equal(again.context, originalContext); assert.equal(again.page, originalPage);
    assert.equal((await executeScenario(compileScenario('return await page.evaluate(() => window.sends);'), again)).result, 1);
    await assert.rejects(executeScenario(compileScenario(`
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      throw Error('synthetic failure after sending');
    `), again), /script_result_unknown/);
    assert.equal((await executeScenario(compileScenario('return await page.evaluate(() => window.sends);'), again)).result, 2,
      'unknown outcome is read back without replaying the script');
    await assert.rejects(bank.authenticate({ password: 'synthetic-only' }), /new_session_required_after_handoff/);
    // Closing the initial window is supported by the full-context contract.
    // Persistence must bind the surviving popup, not the original window ID.
    await originalPage.close();
    const surviving = await bank.playwrightContext();
    assert.equal(surviving.context, originalContext);
    assert.equal(surviving.page.isClosed(), false);
    await bank.storage();
    expired = true;
    await assert.rejects(bank.playwrightContext(), /synthetic_expired/);
    expired = false;
    await bank.close(); assert.equal(originalPage.isClosed(), true);
  } finally { await bank.close().catch(() => {}); }

  // A main document may return valid HTML with a failing HTTP status. The
  // shared observer must stop login/context handoff before reading that DOM;
  // the private query string and response body must never reach the error.
  const unavailableBrowser = {
    newBrowserCDPSession: () => browser.newBrowserCDPSession(),
    newContext: async options => {
      const context = await browser.newContext(options);
      await context.route('**/*', route => route.fulfill({ status: 503,
        contentType: 'text/html', body: '<h1>Private fixture body</h1>' }));
      return context;
    },
  };
  const unavailable = new Portal(unavailableBrowser, nativePermit, {
    onPhase: () => assert.fail('HTTP failure must not enter a login phase'),
    persist: async () => assert.fail('HTTP failure must not save bank state'),
  });
  try {
    await assert.rejects(unavailable.open(null), error => error.code === 'service_http_error'
      && error.httpStatus === 503 && error.httpOrigin === 'https://www.tbank.ru');
    await assert.rejects(unavailable.playwrightContext(), error => error.code === 'service_http_error');
    assert.equal(unavailable.handedOff, false);
  } finally { await unavailable.close(); }
}
