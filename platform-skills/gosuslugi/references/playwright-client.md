# Полный Playwright context и защищённый вход ЕСИА

Это API существующего signed package Госуслуг, не отдельный навык браузера.
Клиент принимает обычный `Page` и возвращает те же `page`/`context`; сценарий
не ограничен каталогом команд `snapshot`/`page` и остаётся у вызывающего агента.

## Два живых процесса

1. Агент получает текущий навык Госуслуг и выполняет verified команду `client`.
   В ответе находятся `modulePath`, `options` с exact company/member и
   `configHome`. Секретов, browser endpoint и OAuth URL в ответе нет.
2. Обычный Node.js Playwright-сценарий импортирует клиент по возвращённому пути,
   создаёт свой headed browser/context и открывает публичный сайт. Сценарий
   должен продолжать работать, пока отдельный auth-вызов находится в ожидании.
3. До штатного входа он создаёт `createEsiaAuthorization(page, options)`,
   затем сам выполняет наблюдённый login click. Создание помощника требует
   проверенное разрешение на вход и `confirm: true`. В Codex заголовок чата
   читает сам runtime; `requestTitle` остаётся необязательной короткой темой
   поручения и используется лишь когда точное чтение недоступно. ЕСИА может открыться
   в этой странице либо в новом popup с этой exact страницей как opener.
4. Сценарий выводит только результат `await login.request`: opaque session и
   request IDs, origin, expiresAt и готовый массив CLI arguments. Агент передаёт
   `arguments` тому же verified runtime, не запускает repository source и
   не подменяет identity. Во время этого вызова браузерный процесс остаётся живым.
5. `await login.authenticated` возвращает исходные объекты после проверенного
   callback и document commit сервиса. Если принятый callback открыл в связанном
   окне официальный экран «Войти как», runtime один раз выбирает единственную
   карточку физлица и ждёт возврата в сервис; экран роли сам по себе не означает
   успех. Для `https://zakaznoe.pochta.ru` подписанный клиент также принимает
   exact callback `https://passport.pochta.ru`; вход всё равно начинается на
   `zakaznoe.pochta.ru`. Если вход начинается на `passport.pochta.ru`, проверенный
   возврат может открыть `pochta.ru/account` или `www.pochta.ru/account`; это не доказывает готовность
   кабинета заказных писем. Сценарий проверяет его отдельно и продолжает код.
   Fast SSO с прежними cookies завершается до чтения vault/OS key и не требует
   новых credentials. Сам callback не равен готовности кабинета.

Для отслеживания Почты helper создаётся на `https://www.pochta.ru` **до первого
клика «Войти»**, с этим же `origin`. Он должен наблюдать внешний Post ID request
и его exact callback `https://www.pochta.ru/api/auth/callback`, затем отдельную
ЕСИА-транзакцию на Passport. Создание helper-а после перехода на форму Passport
теряет внешнюю привязку и приводит к `service_callback_rejected`. Не исправляй
это отключением state checks. Если первая transaction уже утрачена, начни новую
штатную попытку в том же context с helper-ом, подключённым вовремя.

Используй обычный живой процесс Node.js для модуля клиента. В Codex VM
`node_repl` успешный `import()` ещё не доказывает работоспособность: вызов
клиента может завершиться `process is not defined`. Не подменяй globals и не
меняй проверенный package; запускай долгоживущий Node caller с управляющим
каналом, проверенным до входа. Авторизация и отдельный browser-шаг не должны
закрывать этот caller. `finally` в примере ниже завершает **весь сценарий**;
для пошаговой работы cleanup выполняется отдельной командой после её окончания.

Popup поддерживается тем же вызовом, без нового helper-а на второй странице.
Помощник заранее слушает context и связывает первый реальный OAuth request
с новым direct popup. Исходные форма и выбранные файлы остаются в первой
странице. Callback может штатно отправить `postMessage` и закрыть popup:
успех требует exact callback/state, успешного HTTP ответа и document commit
именно в связанном окне. Одни сообщение или закрытие окна не доказывают вход.
Сценарий проверяет кабинет/номер обращения на исходной странице самостоятельно.
Помощник не отправляет сообщения окну, не повторяет login click/submit и не
закрывает страницы. Ручной challenge показывается в том же связанном ESIA popup.

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
const { createEsiaAuthorization, safeAuthorizationFailure } = await import(pathToFileURL(client.modulePath).href);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
let login;
try {
  await page.goto('https://service.example.org/');
  login = await createEsiaAuthorization(page, {
    ...client.options,
    configHome: client.configHome,
    origin: 'https://service.example.org',
    confirm: true, // Разрешение пользователя уже проверено агентом.
  });
  await page.getByRole('link', { name: 'Вход через ЕСИА' }).click();
  console.log(JSON.stringify({ phase: 'esia_authorization_required', ...await login.request }));
  // Здесь агент запускает отдельный verified authorize с выданными arguments.
  const session = await login.authenticated;
  if (session.page !== page || session.context !== context) throw new Error('context_changed');

  // Обычный произвольный Playwright-код в пределах поручения:
  // await page.locator(...).fill(...);
  // await page.locator('input[type=file]').setInputFiles(approvedFiles);
  // const downloaded = page.waitForEvent('download'); ...
  // await page.evaluate(...); await page.goto(nextApprovedUrl);
  console.log(JSON.stringify({ phase: 'scenario_complete' }));
} catch (error) {
  console.log(JSON.stringify({ phase: 'authorization_failed', ...safeAuthorizationFailure(error) }));
  // Не повторять вход и не выводить message/stack/URL. Сначала проверить
  // exact status и состояние вызывающего сценария.
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

`authorization.status` относится к exact origin/browserSessionId/requestId:
`pending`/`user_required` не доказывают вход, `callback_verified` требует ещё
проверки кабинета, `failed` сохраняет неуспех. `portalReady` и ready отдельной
Госуслуги-сессии не заменяют этот результат. После `authorization_failed`
resume не возвращается к собственному порталу и не сбрасывает ошибку.
В долгоживущем caller сохраняй исход `authenticated` как отдельный settled result
с `safeAuthorizationFailure(error)`, а не только boolean/`auth_not_completed`.
Не выводи произвольные exception properties. После terminal failure новый helper
возможен только после разбора причины и нового основания для попытки.
Для обычного OAuth callback коды `service_callback_rejected_target|method|fragment|state|query`
называют точный нарушенный invariant, не раскрывая URL, параметры либо значения
сравнения. Ни один из них не разрешает ослабить привязку или считать вход пройденным.

При `account_temporarily_blocked` пароль, TOTP и смена метода входа остановлены.
Ограничение может касаться внешнего ЕСИА-входа при работающем портале Госуслуг.
Агент явно сообщает пользователю ссылку на самостоятельную
[проверку для разблокировки доступа](https://www.gosuslugi.ru/679557/1/form)
и просит сообщить о снятии ограничения. Runtime возвращает фиксированную
подсказку `accountRecovery` и после закрытия попытки, в том числе по старому
receipt без lease/control после обновления runtime. Она не разрешает агенту
пройти биометрию, принять согласие либо начать ещё один вход ради проверки.
Причина/известный deadline сохраняются в encrypted vault; новый request не
обнуляет запрет. После прямого сообщения оператора о разблокировке используй
`resume --session AUTH_SESSION_ID --account-recovered --confirm` для живой
попытки. При истёкшей lease/caller нужна одна новая штатная transaction в том
же сохранённом caller context, если он ещё доступен, и `--account-recovered`
у verified authorize. Одни чистая login form, истечение caller lease, transport
failure или готовность собственного портала не означают снятия блокировки.
Не нажимай биометрию, не сбрасывай vault и не повторяй ввод за пользователя.
`credentials_rejected` – отдельный gate без выдуманного срока; восстановление
аккаунта не меняет пароль/TOTP и не снимает этот gate.

- Runtime хранит пароль и optional TOTP seed в прежнем encrypted vault с
  OS-protected key. Seed/key не передаются клиенту; login/password/текущий код
  проходят через его private RAM для ввода только в bound ESIA document.
- Произвольный caller-код обладает полным browser context и технически может
  наблюдать cookies, auth fields и сеть. Прежняя изоляция от этого кода не
  заявляется. Auth DOM/скриншоты, cookies, password/OTP и сетевые тела нельзя
  помещать в stdout, prompt, логи, Workspace или Git.
- Клиент не сохраняет и не переносит browser profile. Используй отдельный
  непостоянный context, не plaintext persistent profile/storageState export.
  Скачанные по поручению документы принадлежат сценарию и сохраняются по
  правилам задачи; helper не обещает шифрование произвольных файлов.
- Native deadline до 30 минут ограничивает доступ Госуслуг к данным входа.
  Перед каждым секретным символом/action выполняется private native permit.
  `login.close()` отключает только auth-помощник; браузер и черновик сохраняются.
  Их закрывает создавший сценарий в `finally`; lifecycle собственного браузера
  обычного `start` остаётся прежним, с independent native cleanup.
- При CAPTCHA, SMS/push, consent или неожиданной роли пользователь продолжает
  в той же вкладке. `status`/`resume` работают с **auth session ID**, который
  вернул `authorize`, а не с browser session ID из `login.request`.
- При `credentials_required` используй отдельный штатный setup Госуслуг только
  по соответствующему запросу; не собирай пароль через сценарий/чат. Повреждённый
  vault и transport failure не разрешают повторную настройку.
- Helper поддерживает same-page и новый direct-popup OAuth code flow с exact
  callback/state. По умолчанию callback остаётся на исходном origin. Только для
  `zakaznoe.pochta.ru` и `www.pochta.ru` signed runtime допускает наблюдённый callback на
  `passport.pochta.ru`; origin проверяются как точные HTTPS-хосты. Почта
  сначала проводит отдельную Post ID транзакцию через
  `passport.pochta.ru/oauth2/authorize` и `zakaznoe.pochta.ru/oauth2/cb`;
  для tracking внешний callback – `www.pochta.ru/api/auth/callback`.
  Её state проверяется отдельно от ЕСИА. Требуются оба успешных callback и
  commit внешнего возврата; промежуточная страница Passport этого не доказывает.
  После callback связанная redirect chain может закончиться на `pochta.ru`
  либо `www.pochta.ru`:
  это только proof завершения входа, не proof входа в сервис писем. Уже
  открытое до helper-а окно, `noopener`, вложенный popup, второй auth popup,
  form-post callback или иной callback origin не принимаются автоматически и
  требуют отдельного разбора.
  Старую начатую transaction нельзя восстановить новым helper-ом: он должен
  наблюдать её с первого request. Не пересоздавай форму ради такого восстановления.
  Не считай timeout доказательством неуспеха сайта и не повторяй его подачу.
- `service_http_error` содержит `httpStatus` (400–599) и `httpOrigin` из
  наблюдённого main-frame ответа, включая 503 до OAuth, на ЕСИА и callback.
  Только status/origin разрешено перенести в результат; path/query/code/state,
  headers, тело и auth DOM остаются приватными. Код не доказывает неверные
  credentials или технические работы и не разрешает автоматический повтор входа.
- `.request` и `.authenticated` отклоняются при cancellation/expiry/ошибке;
  обрабатывай их через `try/finally`. Runtime не повторяет credential submit
  после неизвестного результата. Crash клиента может оставить просроченную
  owner-only capability; она не содержит provider secrets и не принимается
  новым authorizer. Её нельзя использовать для восстановления старого входа.

Полные guarantees и release gates: [secure-runtime.md](secure-runtime.md).
