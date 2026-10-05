# Полный Playwright context и защищённый вход T‑ID

Это API существующего signed package Т‑Банка, не отдельный навык браузера.
Клиент принимает обычный `Page` и возвращает те же `page`/`context`; сценарий
не ограничен каталогом команд `snapshot`/`page` и остаётся у вызывающего агента.

## Два живых процесса

1. Агент получает текущий навык Т‑Банка и выполняет verified команду `client`.
   В ответе находятся `modulePath`, `options` с exact company/member и
   `configHome`. Секретов, browser endpoint и OAuth URL в ответе нет.
2. Обычный Playwright-сценарий импортирует клиент по возвращённому пути,
   создаёт свой headed browser/context и открывает публичный сайт. Сценарий
   должен продолжать работать, пока отдельный auth-вызов находится в ожидании.
3. До штатного входа он создаёт `createTIdAuthorization(page, options)`,
   затем сам выполняет наблюдённый login click. Создание помощника требует
   проверенное разрешение на вход и `confirm: true`. Необязательный
   `requestTitle` служит темой fallback, когда runtime не прочитал точный
   заголовок Codex. T‑ID может открыться
   в этой странице либо в новом popup с этой exact страницей как opener.
4. Сценарий выводит только результат `await login.request`: opaque session и
   request IDs, origin, expiresAt и готовый массив CLI arguments. Агент передаёт
   `arguments` тому же verified runtime, не запускает repository source и
   не подменяет identity. Во время этого вызова браузерный процесс остаётся живым.
5. `await login.authenticated` возвращает исходные объекты после проверенного
   callback. Сценарий проверяет рабочий кабинет и продолжает произвольный код.
   Fast SSO с прежними cookies завершается до чтения vault/OS key и не требует
   новых credentials. Сам callback не равен готовности кабинета.

Popup поддерживается тем же вызовом, без нового helper-а на второй странице.
Помощник заранее слушает context и связывает первый реальный OAuth request
с новым direct popup. Исходные форма и выбранные файлы остаются в первой
странице. Callback может штатно отправить `postMessage` и закрыть popup:
успех требует exact callback/state, успешного HTTP ответа и document commit
именно в связанном окне. Одни сообщение или закрытие окна не доказывают вход.
Промежуточный same-origin URL только со `state` также не является callback и не
прерывает flow: `state` проверяется лишь вместе с фактическим OAuth result.
Сценарий проверяет кабинет/номер обращения на исходной странице самостоятельно.
Помощник не отправляет сообщения окну, не повторяет login click/submit и не
закрывает страницы. Ручной challenge остаётся в том же связанном T‑ID popup;
автоматически перехватывать фокус он не разрешает.

`modulePath` действует только для текущего проверенного immutable release.
Сохранённый bootstrap JSON не заменяет `get_agent_skill` при смене release,
context или новой сессии. Результат `client` можно передать сценарию через
owner-only локальный JSON вне Git/Workspace: он содержит только nonsecret
bindings и machine paths, не bearer и не данные входа.

## Пример сценария

Адрес и селекторы ниже иллюстрируют порядок; реальный сценарий получает их
из публичной страницы нужного сайта. Playwright устанавливается штатными
средствами среды вызывающего агента, а не новым Agent Skill.

```js
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// client.json — точный nonsecret ответ verified команды client.
const client = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { createTIdAuthorization } = await import(pathToFileURL(client.modulePath).href);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
let login;
try {
  await page.goto('https://service.example.org/');
  login = await createTIdAuthorization(page, {
    ...client.options,
    configHome: client.configHome,
    origin: 'https://service.example.org',
    confirm: true, // Разрешение пользователя уже проверено агентом.
    // requestTitle можно добавить как короткую тему fallback.
  });
  await page.getByRole('link', { name: 'Войти с T‑ID' }).click();
  console.log(JSON.stringify({ phase: 'tid_authorization_required', ...await login.request }));
  // Здесь агент запускает отдельный verified authorize с выданными arguments.
  const session = await login.authenticated;
  if (session.page !== page || session.context !== context) throw new Error('context_changed');

  // Обычный произвольный Playwright-код в пределах поручения:
  // await page.locator(...).fill(...);
  // await page.locator('input[type=file]').setInputFiles(approvedFiles);
  // const downloaded = page.waitForEvent('download'); ...
  // await page.evaluate(...); await page.goto(nextApprovedUrl);
  console.log(JSON.stringify({ phase: 'scenario_complete' }));
} finally {
  await login?.close();
  await context.close();
  await browser.close();
}
```

На Windows выбирается установленный `msedge` либо Chrome; собственный
Playwright runner может иметь другой штатный способ создания headed context.
Не заменяй прежнюю живую вкладку новой ради входа и не закрывай браузер после
каждого промежуточного шага. Не открывай задачу в новом агенте ради этой схемы:
два локальных процесса можно координировать в текущем разговоре.

## Границы и ошибки

- Runtime хранит телефон, optional username, пароль и optional TOTP seed в
  прежнем encrypted vault с OS-protected key. Seed/key не передаются клиенту;
  телефон/password и сгенерированный TOTP проходят через private RAM для ввода
  только в bound T‑ID document.
- Российский телефон вводится без уже показанного формой `+7`. Private adapter
  сверяет итоговые цифры внутри bound input до submit и при сдвиге/обрезании
  возвращает только `auth_phone_input_mismatch`, не значение номера. Если
  Т‑БКИ не даёт кнопке-стрелке текстового имени, submit выполняется Enter из
  этого же повторно проверенного поля без выбора безымянной иконки.
- Шестиячеечный TOTP текущего T-ID остаётся автоматическим, когда default
  `type=text` не записан в DOM, а OTP `autocomplete`/`inputmode` есть только на
  первой ячейке. Остальные пять могут быть обычными disabled inputs без этих
  атрибутов. Структура всё равно обязана состоять ровно из шести ячеек: первая
  доступна, остальные последовательно включает сам банк.
- После submit телефона, пароля, сохранённого TOTP либо отказа от optional quick
  PIN T‑ID может кратко заменить форму пустым same-origin document. Authorizer
  в течение ограниченного интервала ждёт следующую распознанную форму или
  проверенный callback. Sent guards остаются выставленными, поэтому неизвестный
  переход не вызывает повторный ввод или submit credential.
- Прямой кабинет и delegated authorizer используют общую нормализацию телефона
  и одну проверку segmented TOTP. Безымянная primary button после password
  обрабатывается первым Enter из exact password input; optional quick PIN может
  показать «Не сейчас» как кнопку либо ссылку.
- Произвольный caller-код обладает полным browser context и технически может
  наблюдать cookies, auth fields и сеть. Прежняя изоляция от этого кода не
  заявляется. Auth DOM/скриншоты, cookies, password/OTP и сетевые тела нельзя
  помещать в stdout, prompt, логи, Workspace или Git.
- Клиент не сохраняет и не переносит browser profile. Используй отдельный
  непостоянный context, не plaintext persistent profile/storageState export.
  Скачанные по поручению документы принадлежат сценарию и сохраняются по
  правилам задачи; helper не обещает шифрование произвольных файлов.
- Native deadline до 30 минут ограничивает доступ помощника к данным входа.
  Перед каждым секретным символом/action выполняется private native permit.
  `login.close()` отключает только auth-помощник; браузер и черновик сохраняются.
  Их закрывает создавший сценарий в `finally`; lifecycle собственного браузера
  обычного `start` остаётся прежним, с independent native cleanup.
- При CAPTCHA, SMS/push, выборе передаваемых данных или неизвестном экране
  пользователь продолжает в той же вкладке. Runtime не принимает consent и не
  читает текущий код. `show` вызывается только по явной просьбе показать окно.
  `user_required.reason` различает фиксированную безопасную причину; пустой
  document сразу после submit не выдаётся за ручной шаг. `status`/`resume`
  работают с **auth session ID**, который
  вернул `authorize`, а не с browser session ID из `login.request`.
- При `credentials_required` используй отдельный штатный setup Т‑Банка только
  по соответствующему запросу; не собирай пароль через сценарий/чат. Повреждённый
  vault и transport failure не разрешают повторную настройку.
- Helper поддерживает same-page и новый direct-popup OAuth code flow с exact
  callback/state на исходном origin. Уже открытое до helper-а окно, `noopener`,
  вложенный popup, второй auth popup, form-post callback или другой callback
  origin не принимаются автоматически и требуют отдельного разбора.
  Старую начатую transaction нельзя восстановить новым helper-ом: он должен
  наблюдать её с первого request. Не пересоздавай форму ради такого восстановления.
  Не считай timeout доказательством неуспеха сайта и не повторяй его подачу.
- `.request` и `.authenticated` отклоняются при cancellation/expiry/ошибке;
  обрабатывай их через `try/finally`. Runtime не повторяет credential submit
  после неизвестного результата. Crash клиента может оставить просроченную
  owner-only capability; она не содержит provider secrets и не принимается
  новым authorizer. Её нельзя использовать для восстановления старого входа.

Полные guarantees и release gates: [secure-runtime.md](secure-runtime.md).
