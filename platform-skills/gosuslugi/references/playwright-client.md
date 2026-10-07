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
4. Сценарий выводит request отдельным событием `login.request.then(...)`: opaque session и
   request IDs, origin, expiresAt и готовый массив CLI arguments. Агент передаёт
   `arguments` тому же verified runtime, не запускает repository source и
   не подменяет identity. Во время этого вызова браузерный процесс остаётся живым.
5. `login.authenticated` возвращает `{ context, page, serviceResponse }`
   после точного callback/state и document commit внешнего ответа либо его
   наблюдённой HTTP redirect chain. Это возврат из ЕСИА, а не проверка кабинета.
   `serviceResponse` содержит только `httpStatus`/`httpOrigin`; HTTP-ошибка
   внешнего callback/сайта не является отказом ЕСИА. Агент отдельно разбирает
   её и проверяет результат нужного сайта. Если возврат ещё ведёт на официальный
   экран «Войти как», runtime один раз выбирает единственную карточку физлица
   и ждёт внешнего document commit. Fast SSO до чтения vault/OS key не требует
   новых credentials.

Callback берётся из реального запроса ЕСИА в exact странице или её новом direct
popup. Он может находиться на отдельном HTTPS broker origin; никакого каталога
внешних сайтов и callback-путей нет. Хост/path/fixed query и state этого callback
проверяются точно. Helper создаётся **до первого login click**, а не после
перехода на broker; утраченная transaction не восстанавливается задним числом.
После verified external document return listeners сразу отключаются. Дальнейшие
outer OAuth/SSO, JS-переходы, токены, ошибки и закрытие popup принадлежат вызывающему
сценарию и не отзывают завершённый ответ ЕСИА. Доступ к credentials уже закрыт.

Используй обычный живой процесс Node.js для модуля клиента. В Codex VM
`node_repl` успешный `import()` ещё не доказывает работоспособность: вызов
клиента может завершиться `process is not defined`. Не подменяй globals и не
меняй проверенный package; запускай долгоживущий Node caller с управляющим
каналом, проверенным до входа. Авторизация и отдельный browser-шаг не должны
закрывать этот caller. В примере ниже cleanup выполняется отдельной командой
`finish` после окончания всего сценария.

Popup поддерживается тем же вызовом, без нового helper-а на второй странице.
Помощник заранее слушает context и связывает первый реальный OAuth request
с новым direct popup. Исходные форма и выбранные файлы остаются в первой
странице. Callback может штатно отправить `postMessage` и закрыть popup:
возврат требует exact callback/state, наблюдённого HTTP ответа и document commit
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
средствами среды вызывающего агента, а не новым Agent Skill. Для пошаговой
работы используй приведённую очередь: `authorize` создаёт один helper и
заканчивается после первого click. Следующий `click_login` проходит наблюдённую
промежуточную кнопку в той же странице. Request появляется независимым событием,
после которого агент вызывает verified `authorize`. Не добавляй ожидание
request/authenticated в `handle`: оно заблокирует `state` и второй click.

```js
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// client.json — точный nonsecret ответ verified команды client.
const client = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { createEsiaAuthorization, observeEsiaAuthorization, safeAuthorizationFailure } =
  await import(pathToFileURL(client.modulePath).href);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const origin = 'https://service.example.org';
await page.goto(origin);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let login, observer, stopped = false;
async function handle(command) {
  if (stopped) return;
  if (command.action === 'state') return emit(observer?.snapshot() ?? { phase: 'caller_ready' });
  if (command.action === 'finish') {
    stopped = true;
    await login?.close();
    await context.close();
    await browser.close();
    lines.close();
    return emit({ phase: 'caller_closed' });
  }
  // Only inspected, authorized login controls on the public source page.
  // Do not use this command to inspect/click auth fields or accept consent.
  if (new URL(page.url()).origin !== origin) throw new Error('public_page_required');
  if (command.action === 'authorize' && !login) {
    login = await createEsiaAuthorization(page, {
      ...client.options,
      configHome: client.configHome,
      origin,
      confirm: true, // Разрешение пользователя уже проверено агентом.
    });
    observer = observeEsiaAuthorization(login);
    login.request.then(request => emit({ phase: 'esia_authorization_required', request }),
      error => emit({ phase: 'authorization_failed', ...safeAuthorizationFailure(error) }));
    login.authenticated.then(() => emit(observer.snapshot()),
      error => emit({ phase: 'authorization_failed', ...safeAuthorizationFailure(error) }));
  } else if (command.action !== 'click_login' || !observer ||
    !['esia_request_pending', 'esia_request_not_observed'].includes(observer.snapshot().phase)) {
    throw new Error('login_step_not_available');
  }
  await page.locator(command.selector).click();
  emit(observer.snapshot()); // Не await request: modal ещё может требовать click.
}
const lines = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
lines.on('line', line => {
  queue = queue.then(() => handle(JSON.parse(line))).catch(error =>
    emit({ phase: 'caller_action_failed', ...safeAuthorizationFailure(error) }));
});
emit({ phase: 'caller_ready' });
// After verified callback, add the site's business steps to handle() and check
// its actual result. Only finish closes this caller's context/browser.
```

На Windows выбирается установленный `msedge` либо Chrome; собственный
Playwright runner может иметь другой штатный способ создания headed context.
Не заменяй прежнюю живую вкладку новой ради входа и не закрывай браузер после
каждого промежуточного шага. Не открывай задачу в новом агенте ради этой схемы:
два локальных процесса можно координировать в текущем разговоре.

`observeEsiaAuthorization(login, { requestWaitMs: 15000 })` только наблюдает
promises, не делает browser/credential actions. `snapshot()` синхронный:
`esia_request_pending` → `esia_request_not_observed` при отсутствии request;
поздний request той же попытки переводит его в `esia_authorization_required`.
Диагностический бюджет допускает целые 1–60000 ms и не меняет native lease.
После 15 секунд проверь доступность command channel и текущий промежуточный
экран на публичном origin. Не снимай ЕСИА auth DOM/screenshot; распознанный
challenge разбирается по штатному безопасному `status`. Обычная modal-кнопка
сама по себе не означает CAPTCHA/SMS/consent и не требует передачи управления
человеку. Совмещённая с отправкой кнопка требует права на конкретную подачу.
`esia_callback_verified` содержит только optional `serviceResponse`, не Page/
Context; `authorization_failed` сохраняет точный безопасный error и HTTP
evidence. Verified callback проверяется ещё на сайте. Состояние копируется,
его изменение не меняет handoff. Terminal failure сохраняется; поздний cleanup
не отменяет verified callback. Observer не повторяет и не закрывает helper.

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
После принятого callback внешняя HTTP redirect chain может содержать собственные
параметры/токены сайта и перейти на другой HTTPS origin. Привязка строится по
exact Request objects, а не по списку token names, похожему URL или бренду сайта.
Новая несвязанная навигация до document return не создаёт proof. Исходный callback
по-прежнему требует exact path/fixed query/state и не допускает replay, fragment,
дубликаты code/state либо token payload вместо ответа ЕСИА.

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
  HTTPS callback/state из наблюдённого запроса, включая отдельный broker origin.
  Дальнейший protocol внешнего сайта не реализуется внутри Госуслуг. Уже открытое
  до helper-а окно, `noopener`, вложенный/второй popup или form-post ESIA callback
  не принимаются автоматически; причина требует отдельного разбора.
- `service_http_error` содержит `httpStatus` (400–599) и `httpOrigin` из ошибки
  документа ЕСИА/официального role chooser. Path/query/code/state, headers, тело
  и auth DOM остаются приватными. HTTP-ответ внешнего документа после verified
  ESIA callback возвращается отдельно через `serviceResponse`, включая ошибки;
  он не разрешает повторный вход или повтор внешней подачи.
- `.request` и `.authenticated` отклоняются при cancellation/expiry/ошибке;
  обрабатывай их через `try/finally`. Runtime не повторяет credential submit
  после неизвестного результата. Crash клиента может оставить просроченную
  owner-only capability; она не содержит provider secrets и не принимается
  новым authorizer. Её нельзя использовать для восстановления старого входа.

Полные guarantees и release gates: [secure-runtime.md](secure-runtime.md).
