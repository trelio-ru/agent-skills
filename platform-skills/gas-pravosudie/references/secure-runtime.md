# Защищённый browser runtime ГАС «Правосудие»

## Граница и lifecycle

Release 4.0.5 объявляет host `browserSession` v1 класса `protected-snapshot`,
30-минутный absolute lease и `manualAssist=false`. Runtime рассчитан только на
macOS/Windows и всегда запускает headed Chrome/Edge. Chromium, worker и control
plane принадлежат native guardian; он использует continuous clock и закрывает
свою process group/Windows Job при expiry, crash, потере worker или зависании.
Повторная команда и сон компьютера не продлевают исходный срок.

Окно и первая вкладка создаются через exact CDP target с `background=true` и
`focus=false`. Восстановление origin storage использует отдельную owned
background-tab без сетевого запроса. `status`, `snapshot`, `page`, `script` и
сохранение состояния не активируют и не сворачивают окно. Единственные штатные
пути активации – explicit `show`, `page.bringToFront()` доверенного сценария и
helper Госуслуг при реальном ручном auth challenge.

## Хранилище

Browser context всегда ephemeral. Durable state – только cookies и origin
storage официальных `sudrf.ru`, сериализованные pinned Playwright codec и
зашифрованные AES-256-GCM. AAD включает immutable skill/company/member identity.
На macOS 32-byte key хранится в login Keychain с отключённым UI для операций
runtime; на Windows key зашифрован DPAPI CurrentUser и exact owner-only DACL.
Plaintext profile/storageState fallback, перенос из другого навыка и миграция
ЕСИА cookies запрещены.

ГАС классифицирован как нефинансовый runtime: Keychain/DPAPI защищают ключ от
другой OS identity, но каждый `start` не вызывает LocalAuthentication, Touch ID
или CredUI. Locked/unavailable Keychain fail-closed возвращает bounded код. Не
разблокировать, не сбрасывать и не пересоздавать существующий системный store
автоматически. Госуслуги остаются отдельным sensitive runtime и сами применяют
Touch ID/пароль ОС при доступе к сохранённым ЕСИА credentials.

На Windows создание приватного compiler cache запускает только проверенный
package script `private-directory.ps1` с process-only `-ExecutionPolicy Bypass`.
Он принимает один путь каталога, без credentials. Постоянная политика пользователя
или машины не меняется; Group Policy сохраняет приоритет. Native owner/DACL
проверки остаются обязательными до использования helper-а.

## Сеть и авторизация

В обычной фазе browser policy принимает только официальные HTTPS `sudrf.ru` и
поддомены. Во время exact helper transaction дополнительно разрешаются
официальные HTTPS `gosuslugi.ru` и фиксированные static-only ресурсы `gu-st.ru`.
`gu-st.ru` не становится navigation/auth origin и не сохраняется в vault.

`prepare-sign-in` до клика проверяет одну известную форму: один видимый
`#iAgree`, одна ссылка `/info/useragreement` с названием пользовательского
соглашения, одна штатная кнопка «Войти» и отсутствие другого видимого checkbox.
Только этот exact checkbox отмечается автоматически. Любое расхождение даёт
`court_consent_changed` до запуска ЕСИА.

Фоновое окно может получить компактную ширину, при которой live-сайт прячет
точную ссылку «Вход» в штатное свёрнутое меню. Runtime раскрывает только один
видимый `button.navbar-toggle` с подписью «Показать меню», повторно проверяет
единственную ссылку `a[title="Вход"]` и лишь затем нажимает её. Раскрытие меню и
клик не активируют вкладку и не заменяются прямой отправкой скрытой формы.

Helper импортируется только из exact `modulePath`, возвращённого текущей
verified командой `client` Госуслуг. Он создаётся до login click и связывает
реальный OAuth request/callback с исходными page/context. GAS runtime получает
только opaque request IDs/arguments; пароль, TOTP seed, текущий код и ESIA state
не сохраняются в GAS vault. Новый helper не восстанавливает уже начатую
transaction и login click после неизвестного результата не повторяется.

Если обычный runtime Госуслуг уже находится в `ready`, exact `authorize`
передаёт transaction его существующему защищённому worker. Повторная системная
разблокировка и отдельный auth-only lease не нужны; текущая страница Госуслуг
остаётся открытой, а после callback worker снова возвращается в `ready`.
Профильный навык ГАС выбирает этот маршрут сам: пользователю не нужно отдельно
напоминать агенту про вход через Госуслуги или подтверждать обычный login ещё раз.

Ожидающий helper сохраняет `authorization_required`/`authorization_pending` и
запрещает вторую попытку. Ошибка helper-а, несовпавший context/page или неверный
возврат завершают попытку: helper закрывается, worker фиксирует
`authorization_failed`, исходный безопасный код и отдельный следующий шаг.
Ошибка не закрывает caller browser и не повторяет click/authorize. CLI сохраняет
этот код и фиксированные recovery metadata без raw message, auth URL или DOM.

В `authorization_failed` обычные `snapshot`, `page` и `script` остаются закрыты,
чтобы оставшаяся страница ЕСИА не стала рабочей поверхностью ГАС. Только отдельный
разрешённый `prepare-sign-in --confirm` возвращает ту же открытую страницу в
том же context на фиксированный `https://ej.sudrf.ru/`, заново проверяет форму
соглашения и создаёт helper до нового click. Ни helper, ни вкладка не
восстанавливаются автоматически после неизвестного исхода. Recovery проверяет
native permit и исходную страницу; context, foreground state и deadline не
меняются. Проверенный callback переводит worker в `ready` до сохранения
encrypted snapshot: ошибка storage после него не превращается в повтор входа.

## Полный Playwright context

`script` получает настоящие `context`/`page` и потому технически способен читать
DOM, сеть и cookies. Это доверенный agent code, а не sandbox; границы поручения
и необратимых действий остаются поведенческими. Source компилируется до выдачи
context, ограничен 128 KiB, результат – 48 KiB, console – 8 KiB. Код и входные
JSON передаются owner-only файлами вне Git/Workspace. Auth artifacts нельзя
возвращать даже если Playwright может их прочитать. Отмена активного caller
закрывает всю сессию, чтобы сценарий не продолжил внешнюю mutation невидимо.

## Обязательные проверки релиза

- deterministic runtime package и точное совпадение skill/runtime versions;
- AEAD roundtrip/tamper/identity binding и запрет чужих origins в snapshot;
- parse/authority contract: нет headless, secret argv, TTL/extend и скрытого
  согласия; `prepare-sign-in --confirm` принимает только private verified client;
- standard agreement auto-check и fail-closed при дополнительном checkbox;
- background target создаётся до навигации без foreground restore;
- реальный Keychain/DPAPI, owner ACL и native process cleanup на macOS/Windows;
- делегированный ЕСИА helper не переносит state в GAS vault и сохраняет exact
  caller page/context после callback;
- terminal helper error/cancel, context/page mismatch и неверный return очищают
  helper и фиксируют неудачную фазу; pending не очищается, отдельный retry
  сохраняет страницу/context/deadline без автоматического login или foreground;
- local HTTP/CLI error сохраняет только безопасный код и проверенные recovery
  metadata; ошибка snapshot после callback оставляет worker в `ready`;
- status/stop завершённого guardian не обращается к stale control port.

## Безопасная диагностика HTTP-ошибок

`service_http_error` сохраняет `httpStatus` (целое 400–599) и `httpOrigin`
(только canonical HTTPS origin) наблюдённого main-frame ответа. Путь, query,
OAuth code/state, headers, сетевое тело и auth DOM не входят в ошибку. Metadata
проверяется заново на каждом private HTTP/CLI и межпроцессном переходе. Первый
ответ с ошибкой не заменяется последующим шумом; asset/XHR, subframe и чужая
вкладка не доказывают отказ текущего документа. Успешный callback и readiness
при такой ошибке не объявляются.

503 означает недоступность сервиса на указанном origin, а не отказ credentials.
Причина технических работ этим кодом не доказана. Ошибка не разрешает reset
хранилища, повтор setup, автоматический новый вход или повтор отправки.

ГАС также проверяет собственный документ до соглашения и login click, после
перехода в форму и callback. Начальная ошибка сохраняется в failed/closed
status; делегированная – в authorization_failed. HTTP evidence относится
к exact Page и текущей навигации и не снимает запрет на чтение auth DOM.

До начала ЕСИА стандартная публичная форма `https://ej.sudrf.ru` может иметь
HTTP 401. Только initial/recovery navigation и подготовка входа допускают этот
ответ после полной проверки единственного известного checkbox, exact подписи
согласия, ссылки пользовательского соглашения и единственной кнопки «Войти».
Это та же проверка, которая повторяется перед согласием и созданием helper-а;
не отдельный упрощённый признак страницы. При смене Page/URL или начале
авторизации во время проверки исключение не применяется. Изменённая форма,
другой origin/status, обычный рабочий документ и callback сохраняют HTTP-ошибку.
Исключение позволяет начать вход, но не доказывает готовность кабинета.

HTTP-ошибка рабочего документа блокирует его snapshot, полный script и действия
с controls, но не explicit `page --navigate` на проверенный read-only `sudrf.ru`
URL. Такой переход не требует DOM snapshot неработающей страницы. Он сохраняет
exact page/context, lease, auth-origin/password/OTP/active-helper guards и после
goto заново проверяет HTTP/status и auth boundary назначения. Writable navigation
сохраняет обычные snapshot/confirm gates. Ошибка не вызывает автоматический
переход, новый вход, повтор подачи или focus. После успешного перехода ordinary
script/snapshot снова доступен. 404 не доказывает удаления дела или отсутствия акта.
