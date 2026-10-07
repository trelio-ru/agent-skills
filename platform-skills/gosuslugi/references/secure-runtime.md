# Защищённый runtime Госуслуг

Runtime 3.3.18 объявляет signed host browser-session class
`protected-snapshot`, fixed lease 1 800 000 ms и `manualAssist=false`. Общий
host contract задаёт внешний absolute process deadline, но не заменяет и не
ослабляет описанные ниже AES-GCM, Keychain/DPAPI, native guardian,
continuous-clock barrier и fresh OS unlock. Plain Chromium profile остаётся
запрещённым.

## Граница хранения

`vault.json` – единственный persistent credential/session record: JSON envelope
с AES-256-GCM ciphertext, случайным 96-bit nonce, 128-bit tag и AAD для exact
skill/company/member/connection identity. Версии runtime и задачи не меняют
namespace. В plaintext не записываются телефон, пароль, TOTP seed, текущий
код, cookies, localStorage или IndexedDB. Новый record атомарно заменяет старый
после fsync; повреждённый/чужой envelope не запускает повторный setup.

Optional `authGate` в том же ciphertext содержит schema 1, фиксированную причину
`account_temporarily_blocked`/`credentials_rejected`, `observedAt` и `retryAt`.
Текст ESIA, account identity и диагностические сообщения не сохраняются.
Deadline выводится только из наблюдённого обещания разблокировки на 1–168 часов;
без него `retryAt=null`. Повторный просмотр блокировки не переносит deadline.
До него либо ручного восстановления новый процесс/request не вводит credentials,
не выбирает QR/password и не запускает login entry автоматически.
Неверная структура gate завершается `auth_gate_invalid`, а не сбрасывает защиту.
Для распознанного ограничения живой и закрытый status возвращают `accountRecovery`
с фиксированной `url=https://www.gosuslugi.ru/679557/1/form`,
`requiresUserAction=true` и инструкцией самостоятельной проверки. Это публичная
подсказка из trusted source, а не новая capability и не сохранённые данные формы.
Closed projection заново строит её по валидной причине; URL/text из старого
status либо ESIA page не копируются. Та же projection применяется после обычного
cleanup при отсутствии lease/control, включая receipts прежнего runtime; старый
live phase не подтверждает живую сессию, неизвестные поля исключаются.
Агент явно показывает пользователю ссылку
и просит сообщить о снятии ограничения; сам не проходит проверку/биометрию и
не создаёт auth transaction ради проверки формы. Доступ к самому порталу не
исключает ограничения ЕСИА-входа во внешние сервисы. Подсказка не обещает
разблокировку и не меняет deadline/gate или sent-флаги.
Credentials/cookies, `storageRole` и неизвестные legacy поля сохраняются;
авторизатор внешнего сайта не меняет роль сохранённого портала.

Verified внешний callback снимает gate. Живой cookie/header собственного портала
этого не доказывает и gate не очищает. Прямое сообщение оператора о снятии
блокировки представляется `--account-recovered --confirm` у start/authorize/resume:
это явное основание для одной следующей попытки, не вывод runtime об успешной
биометрии. Флаг снимает только account-block gate; sent-флаги сохраняются.
На живой exact сессии применяется resume; повторный start остаётся идемпотентным
и с этим флагом возвращает `account_recovery_requires_resume`.
Explicit configure снимает rejected-credentials gate, сохраняя account block.
Expiry разрешает следующую явно запрошенную попытку, но не запускает её сам.

Телефон и пароль нужны для повторного ЕСИА-входа после отзыва/истечения cookies.
Seed необязателен, сохраняется только после ввода пользователем; runtime
принимает Base32 или `otpauth://totp` SHA1/6/30. Режим TOTP включается самим
пользователем на Госуслугах. Пустой seed и SMS challenge приводят к локальному
ручному вводу только после реального запроса портала. OTP никогда не входит в
record. Хранение обоих факторов вместе ослабляет их независимость.

В том же ciphertext хранится optional `storageRole=personal`, только если
runtime выбрал физическое лицо либо переиспользовал ранее подтверждённую
личную сессию. Старые записи без поля читаются без миграции credentials;
их cookies не доказывают роль и не переиспользуются автоматически. Выбор
другой роли относится к текущему intent и не сохраняет постоянный override.

macOS: 256-bit key хранится в file-based login Keychain, access ACL доверяет
создавшему helper-у; каждое обычное чтение/create/delete требует отдельного
`LAContext.deviceOwnerAuthentication` с reuse interval 0. Исполняемый файл
macOS называется `Trelio`, чтобы системное окно показывало имя приложения.
Runtime сначала читает точное название текущего чата из локального Codex App
Server по `CODEX_THREAD_ID` и сверяет возвращённый ID. Для Codex значение
`--request-title` не переопределяет этот результат; при недоступном exact чтении
runtime может использовать короткую тему, переданную вызывающим клиентом.
Без обоих значений native prompt остаётся нейтральным. Title-aware key helper получает выбранный текст через
stdin, показывает его в системном prompt и не сохраняет. Его source и
content-addressed executable identity заморожены отдельно от guardian/browser
runtime, поэтому обычное обновление JS не меняет trusted application ACL.
Data Protection Keychain с provisioning entitlement не заявлен.

Существующий `trelio.gosuslugi.vault.v1` не читается изменённым бинарником.
При первом запуске с прежним ciphertext новый helper без UI проверяет только
наличие v2 item, а прежний побайтно совместимый helper после одного обычного
owner confirmation читает exact v1 key. Ключ передаётся новому helper-у через
private stdin и создаёт `trelio.gosuslugi.vault.v2`; ciphertext не
перешифровывается, credentials не запрашиваются повторно. Import не читает
Keychain и не заменяет существующий v2 item. Все следующие запуски читают v2 и
показывают название разговора. Старый v1 item остаётся только для совместимого
rollback; явный `forget` удаляет оба item и потому после миграции может показать
два последовательных системных подтверждения. Обычный start/reuse этого не
делает и password prompt login Keychain не вызывает.

Windows 10/11 x64: key дополнительно шифруется DPAPI CurrentUser, namespace
используется как entropy. `key.dpapi` и control/vault files создаются с exact
user SID и owner-only DACL сразу, включая elevated Windows token: наследования
прав папки недостаточно, default owner может быть Administrators. Перед
create/read/delete CredUI запрашивает пароль текущей Windows-учётной записи;
его caption остаётся `Trelio – Госуслуги`, а message содержит bounded название
текущего разговора и объясняет запрос пароля. LogonUser должен вернуть exact SID
владельца.
PIN/Windows Hello не заявлены.
Нет автоматического DPAPI-only unlock, LocalMachine protector или plaintext
fallback. Учётная запись без работающего password-provider останавливается
fail-closed. Системный пароль не сохраняется; unmanaged buffers очищаются.

Local directory mode 0700/file 0600 либо проверенный Windows DACL; symlink/
reparse point и неизвестные права блокируются. Keychain/DPAPI зависят от
учётной записи ОС: её потеря/сброс могут сделать запись невосстановимой.
`forget --confirm` – локальное криптостирание ключа и ciphertext, не отзыв
доступа у Госуслуг. Автоматической миграции из lichnoe, env или другого профиля
нет. Если первичная запись прервалась между созданием OS key и первым
ciphertext, runtime не заменяет ключ сам: нужен явный local forget/setup.

## Процедура и срок

Short-lived CLI общается с одним detached worker по exact loopback endpoint и
случайному owner-only bearer из `control.json`. Этот bearer не выводится агенту
и не является provider token. Новый `start` возвращает прежний `sessionId` до
terminal state; `status`, размышление и команды не открывают новый браузер.
Если автоматические распознаватели за bounded срок не доказали следующий шаг,
runtime возвращает `review_required`, а не выдуманный ручной challenge. В этом
состоянии status сначала отдаёт только `pageKind` и HTTPS origin без path/query;
для `official_public` snapshot отдаёт модели только редактированный текст
публичной не-auth страницы и bounded controls; окно остаётся в фоне. После точного
разрешённого `page`-действия агент вызывает `resume`. Лишь конкретно
распознанный CAPTCHA/SMS/push, выбор роли, consent или ошибка credentials может
стать `user_required`/`code_required` и показать связанное окно пользователю.
Делегированный `user_required` возвращает только bounded `manualReason` из
фиксированного enum; текст auth page, scopes, идентичность и поля формы наружу
не выходят.
Одна и та же неизвестная публичная страница передаётся модели после короткой
стабилизации, а не после общего 90-секундного auth timeout. Сезонные баннеры и
новые промежуточные страницы поэтому не требуют обновления selector-ов: модель
выбирает действие по текущему snapshot, не расширяя origin policy.
`lease.json` связывает session ID, native guardian PID и абсолютный deadline;
stale cleanup убирает только disposable control files, когда supervisor уже
не существует. Если PID существует, runtime не угадывает его принадлежность и
не убивает его по номеру из старого файла.

Одна процедура имеет максимум 1 800 000 ms от start; setup/OS unlock уже входят
в этот срок. Нативный guardian запускается отдельно от агента и JS worker.
macOS использует `mach_continuous_time` и записанную identity собственных
browser/worker process groups. Windows – `QueryInterruptTime` и Job Object с
`KILL_ON_JOB_CLOSE`; worker не запускает детей до назначения Job. Native
deadline barrier проверяется перед рабочими операциями. При зависании worker
native timer завершает его и браузер; при worker exit cleanup выполняется
сразу. Потеря guardian закрывает здоровый worker через EOF; Windows также
закрывает Job автоматически. Это не гарантия против принудительной остановки
всех процессов/ОС, системных сбоев, администратора или same-user malware.

Во сне код не выполняется. Continuous clocks учитывают сон; после пробуждения
просроченная команда не получает native permit. OS scheduling не позволяет
обещать физическое завершение ровно в заданную миллисекунду. JS-таймеры не
являются единственной защитой и не продлевают lease при переводе часов.
Native guard принимает меньший срок для synthetic regression, но отклоняет
любой срок больше 30 минут; production CLI не предоставляет настройки TTL.
Guardian сокращает continuous budget до исходного `expiresAt`: медленный
запуск helper-а или запись lease не начинают новые 30 минут.
На Windows `QueryInterruptTime` загружается из системного `KernelBase.dll`;
`probe` реально вызывает часы, а не только возвращает название механизма.

После нормального finish `stop --session ID` закрывает browser и подтверждает
исчезновение guardian. Ciphertext остаётся зашифрованным; расшифрованный key
очищается. JS strings/память браузера не обещают гарантированного zeroization.
Если native deadline завершил worker раньше очистки control files,
`status`/`stop` exact сессии проверяют отсутствие guardian и возвращают
`closed`, не отправляя старый bearer на потенциально переиспользованный порт.

## Браузер и форма

Первый launch только headed Chrome/Edge. Вкладка создаётся через внутренний
`Target.createTarget` с `background=true`, `focus=false` в проверенном exact
BrowserContext. Нативное окно остаётся обычного размера без активации и без
анимации сворачивания. Нет краткого foreground launch с последующим скрытием,
headless или действий над чужим приложением. Context/page creation сериализован,
browser/context/target/window IDs остаются только в RAM. Реальный manual challenge
либо локальный ввод показывают exact owned window при смене фазы; status, snapshot,
ready и polling не активируют и не сворачивают его. Автоматический click
отклоняет ссылку `target=_blank` до отправки. В owned page и её фреймах
`window.open` блокируется также для отложенных обработчиков: Chromium иначе
активирует новое окно ещё до закрытия unowned page. Синхронная попытка
открыть popup из click handler возвращает `popup_requires_manual`;
самостоятельный переход на exact official HTTPS URL остаётся отдельным
действием. Настройки Keychain/DPAPI не меняются.
Native guardian подтверждает
принадлежность PID до передачи браузеру каких-либо credentials. Используются
непостоянные Playwright BrowserContexts: browsing data не записываются в
launcher profile, snapshot состояния шифруется напрямую из памяти, без
plaintext `storageState({path})`. Это encrypted state vault, не APFS/BitLocker
volume и не обещание шифрования OS swap или crash dumps.

`newContext` получает только cookies, без `origins`; `BrowserContext.storageState`
и его автоматические foreground storage pages не используются. Origin storage
переносится в явно созданной неактивной вкладке существующего окна/context.
Вкладка получает только synthetic origin documents: её page route никогда не
делает continue/fallback, исполняемый provider script и внешний HTTP отсутствуют.
Основная страница входа/работы остаётся на месте. Копия Apache-2.0 codec из
Playwright 1.60.0 сохраняет прежний формат localStorage/IndexedDB, в том числе
encoded значения; source и license лежат в `development/vendor/playwright`,
`development/build-storage-codec.mjs` воспроизводит generated runtime module без
сети. Ошибка переноса возвращает fixed code без browser error/значений и не
заменяет существующий ciphertext. Scope по-прежнему проверяется до restore и
после collect; общий предел vault – 4 MiB. Smoke проверяет два origin и
IndexedDB round-trip, отсутствие лишних вкладок и foreground PID после storage.

Local setup context отделён от portal context, но принадлежит тому же
browser process. Одна связанная login-настройка сохраняет одну вкладку и один
listener, включая SMS. CSP без внешних ресурсов, exact Host/socket/Origin,
256-bit nonce, фактический GET формы, revision-bound one-use submit,
bounded body/timeouts, no-store/no-referrer. Agent не получает setup URL,
значения, CDP endpoint или raw errors. Cancel/timeout/error/success закрывают
listener/sockets. Focus меняется только при реальном human-input step.

Windows bootstrap запускает входящий в проверенный package скрипт создания
private directory с `-NoProfile -NonInteractive -ExecutionPolicy Bypass` только
для этого дочернего процесса. Стандартный `Restricted` не требует менять
постоянную политику пользователя/машины; Group Policy сохраняет приоритет.
Скрипт принимает только путь и не получает credentials. Проверки exact owner,
DACL и native executable после bootstrap остаются обязательными.

Native ошибки возвращают только фиксированные безопасные коды; текст OS
exceptions/компилятора не раскрывается. Отмена, недоступность и timeout OS unlock
отделены от ошибок чтения/создания ключа. `native_keychain_auth_failed`
соответствует `errSecAuthFailed`, а не ошибке пароля Госуслуг. macOS `doctor`
и новый `start`/`configure` до Touch ID проверяют `SecKeychainCopySettings`
с запрещённым UI: флаг «unlocked» сам по себе не доказывает доступность Keychain.
Preflight не читает items или ключ и не меняет содержимое связки; Windows
возвращает `keychain.status=not_applicable`. При отказе `doctor` возвращает
`keychain.status=action_required` и точный safe error, а новый `start` не создаёт
lease/окно. Существующая активная сессия переиспользуется по прежним правилам.
Автоматические lock/unlock общей login Keychain, reset, удаление и повторный
ввод provider credentials не являются восстановлением после этой ошибки.

Detached Windows guardian использует
прямые UTF-8 pipes без изменения console code page и без открытия консоли;
первый JSON packet принимает необязательный BOM от .NET Framework writer-а.

Все Portal commands ограничены official HTTPS Gosuslugi origins.
Делегированный `authorize` не расширяет область этих старых команд.
Полный Playwright-клиент работает в отдельном контексте вызывающего сценария:
там доступны arbitrary scripts/CDP, uploads и downloads по контракту ниже. Ресурсы exact `https://gu-st.ru` имеют
отдельную request policy: только GET/HEAD без навигации для script, stylesheet,
image и font. Для XHR/fetch допустимы только статические HTML внутри
`/htdocs/tpl/`, versioned JSON переводов приложений `*-st` внутри
`assets/i18n/` и `lib-assets/i18n/`, включая один feature-подкаталог в
`assets/i18n/` для словаря результата ФССП, а также
exact `/widget-minimax/config.json`;
query/fragment для этих исключений запрещены. Browser type `other` разрешён
только для `/htdocs/img/favicon-<hex>.ico` и `/portal-st/favicon.ico|svg`.
HTTP, чужие/соседние hosts, userinfo и нестандартные порты отклоняются.
CDN не становится official/auth origin: страницы, формы, POST, произвольные
API и сохранение CDN cookies/origins в vault остаются запрещены.

Начальный переход идёт на публичную главную `https://www.gosuslugi.ru/`.
С неё либо с `/404` runtime один раз нажимает единственный видимый button/link
с точным именем «Войти». Href, если он есть, обязан вести на official HTTPS
origin; до click повторно проверяются native permit и неизменность страницы.
Runtime не конструирует OAuth URL и не повторяет неоднозначный click при resume.
Страница `/404`, текст «Похоже, ничего не нашлось» и публичная кнопка входа
исключают ready даже при словах «Мои документы» в footer. Credentials вводятся
только после штатного перехода на разрешённый ESIA origin.

Ready подтверждается видимой enabled кнопкой «Меню пользователя» внутри
`lib-header-auth` с классом `authorized-user` либо одним точным logout control
на рабочей странице. В [публичном компоненте портала](https://gu-st.ru/portal-st/5541.6a15a6b29630cec1.js)
первая кнопка рендерится только при `user.authorized`; альтернативная ветка
показывает login-button. Ошибка, публичная кнопка входа и auth inputs всегда
исключают ready. Текст footer, имена/аватары и реклама биометрии не используются
как доказательство входа; личные данные компонента не считываются.

Нераспознанные проверки и неподдерживаемая композиция страницы
требуют участия человека либо отдельной доработки, без расширения allowlist вживую. Определение SMS/TOTP
учитывает наличие настоящего code input, а не рекламу входа по коду рядом с
телефоном. Credentials печатаются в ESIA по символам; после ambiguous submit
нет слепого повтора. Transport error не стирает vault и не доказывает logout.

На QR-экране наличие единственной видимой кнопки «Логин и пароль» вместе с
отсутствием полей credentials/кода, checkbox и отдельного блокера разрешает
однократный переход к парольной форме до классификации текста всей страницы.
Перечисленные ниже биометрия и другие способы входа сами по себе не являются
активной проверкой. CAPTCHA, SMS/push, consent, recovery и выбор роли
останавливают автоматический вход; неоднозначный результат клика не повторяется.

Код вводится в одно поле либо шесть проверенных ячеек: native `maxlength=1`
или observed controlled layout с шестью enabled/editable `type=tel`,
`autocomplete=one-time-code`, без maxlength и inputmode. Произвольный набор
полей блокируется до первого символа и до sent-флага. После ожидания нового
TOTP окна либо человека повторно проверяются origin, challenge и число полей.
Native permit проверяется перед каждым вводом. Наблюдение только факта
official navigation/POST во время ввода предотвращает повторный submit даже
при всё ещё видимой форме; URL, headers и body не сохраняются. Без такой
отправки допустима одна точная enabled кнопка подтверждения. Выбор роли после
TOTP не сбрасывает submission guards.

## Делегированная авторизация ЕСИА и полный Playwright context

Клиент `scripts/playwright-client.mjs` входит в подписанный пакет Госуслуг.
Verified команда `client` возвращает exact materialized module path и nonsecret
company/member/configHome. Это разрешённый client-side import проверенного
пакета; импорт repository source или старого materialized release запрещён.
Сам клиент не открывает vault, не читает OS key и не запускает браузер.

Вызывающий сценарий создаёт обычный headed Playwright browser/context/page и
владеет всеми сайтовыми действиями. Предпочтителен отдельный непостоянный
context; plaintext persistent profile, export cookies/storageState в файл и
копирование пользовательского профиля не входят в этот flow. Клиент не
сохраняет session storage ни в старом vault, ни в новом каталоге. Прежний
`serviceSessions` ciphertext не используется и не удаляется.

`createEsiaAuthorization(page, { company, member, configHome, origin, confirm })`
регистрируется на exact исходном HTTPS origin до первого штатного входа.
Реальный запрос ЕСИА в этой Page либо новом direct popup определяет callback:
любой внешний HTTPS origin без userinfo/нестандартного порта, exact path/fixed
query и state. Нет provider-specific карты внешних callback/кабинетов или
caller-supplied allowlist. Ни начало на другом broker origin, ни его outer
OAuth/SSO не дают новой capability: допускается только один наблюдённый ESIA
request в exact связанном окне. Credentials всё равно вводятся только на
официальных ESIA origins под прежним native permit.

Callback code/state/fixed query, GET, отсутствие fragment/token payload,
дубликатов и replay проверяются до первого return proof. Отказ возвращается
фиксированным `service_callback_rejected_target|method|fragment|state|query`,
без URL/значений. После принятого callback сайт может выдать собственные
параметры и токены на другом пути/origin в exact HTTP redirect chain.
Связь сохраняется по Request object ancestry, а не по URL или token name.
Новая несвязанная навигация до commit не заменяет callback. Внешний HTTPS
document commit именно этого callback/chain завершает ответственность helper-а:
listeners немедленно отключаются, credentials уже отозваны. В буферизованном
popup batch наблюдение также останавливается на первом verified return.
Дальнейшая авторизация, routing, данные, ошибки и кабинет сайта – у caller.
`authenticated` возвращает те же context/page и `serviceResponse` только с
`httpStatus`/`httpOrigin` committed документа; raw URL/query/fragment отсутствуют.
Даже HTTP 401/403/500/503 на внешнем callback не превращает verified ответ
ЕСИА в provider refusal. Ошибка документа ЕСИА/официального role chooser
остаётся `service_http_error`. Helper не доказывает обмен code внешним сайтом,
готовность кабинета или успех бизнес-действия; это проверяет вызывающий агент.

Без `confirm=true` нет browser inspection или native bootstrap. Разрешение
проверяется в текущем разговоре; уже данное на этот сайт не спрашивается повторно.
Подача, подпись, платёж и consent не включаются в разрешение на вход.

`observeEsiaAuthorization(login, {requestWaitMs: 15000})` подписывается на
request/authenticated вне очереди caller-команд. Синхронный `snapshot()`
возвращает только фазу, копию публичного request/CLI arguments либо safe error
и bounded HTTP evidence; browser objects и auth data не возвращаются.
Промежуточная modal после первого click не блокирует state и второй разрешённый
login click в той же Page/helper. Через диагностические 15 секунд без request
фаза `esia_request_not_observed` требует проверки публичного промежуточного
экрана и command channel. Это monotonic advisory wait (целые 1–60000 ms),
не отказ ЕСИА и не основание для нового helper, повторного входа или выдуманного
manual challenge. Поздний request той же попытки принимается; observer не
отменяет, не повторяет и не продлевает native lease. Terminal failure сохраняется,
а late cleanup rejection не заменяет verified callback. Пример долгоживущего
caller в playwright-client.md возвращается после click и выдаёт результаты
promises независимыми событиями; await внутри command queue запрещён.

Клиент наблюдает main-frame запросы/ответы и document commit в исходной странице
либо в новом direct popup с exact исходной Page как opener в том же context.
Context listeners устанавливаются до клика: событие `popup` само по себе
приходит слишком поздно для первого OAuth request. Early request без готового
frame/page удерживается в bounded RAM queue до доказанной связи того же
Request; сопоставления по похожему URL нет. Opener проверяется до публикации
capability, а request/response/commit/close сохраняют свой порядок.
Пустой URL/about:blank при создании popup не является document proof: ранний
placeholder игнорируется до фактического HTTP document commit, без URL parse failure.
Клиент не маршрутизирует, не блокирует и не исполняет произвольный
сайтовый код. Exact redirect origin/path/fixed query, state, client identity и отсутствие
replay проверяются transaction contract; внешние HTTP ответы остаются у caller.
Existing/`noopener`/вложенный popup не получает credentials; второй auth popup
или новая transaction прерывают помощник без переноса ввода. Только
после реального bound request создаётся одноразовый owner-only descriptor
с opaque IDs, port и случайным bearer; stdout/model получает IDs/origin/arguments,
а OAuth URL/code/state и bearer остаются приватными.

Каталог `integrations/gosuslugi-handoffs/<SHA-256 identity/session>/` содержит
только временную authorization capability. Full SHA сохраняет exact identity
без переполнения native Windows paths. Symlink/reparse и чужие ACL не принимаются;
native primitives остаются теми же, что для Госуслуг/Т-Банка. Это не новый
навык браузера и не отдельное постоянное хранилище личного доступа.

`authorize --browser-session UUID --request UUID --origin HTTPS_ORIGIN --confirm`
проверяет exact company/member/session/request/origin/deadline до claim и OS key
read. Нужен существующий vault: setup и перенос старого env/profile не запускаются.
Native guardian ограничивает доступ authorizer к credentials исходным бюджетом,
не больше 30 минут; ожидание уже входит в срок. Для каждого символа и auth action
private adapter вызывает `authorization-permit` у того же worker, который
получает свежий native permit. Callback не предоставляет process ownership,
не открывает vault и не начинает новую авторизацию. После потери worker/guardian
ввод прекращается; стеновые часы и живой stale PID не заменяют native barrier.

Если обычный worker уже жив и находится в `ready`, CLI не создаёт отдельный
lease и не читает OS key повторно. Exact owner-only command передаёт ему один
заново проверенный authorization descriptor; worker повторно сверяет company,
member, HTTPS origin, IDs, deadline, broker PID, loopback port и bearer, после
чего временный `EsiaAuthorizer` использует уже расшифрованные credentials в RAM.
Обычный browser/context, его текущая страница и несохранённая форма не закрываются
и не меняются. После verified callback временный authorizer удаляется, а прежняя
сессия возвращается в `ready`. `authorization` сохраняет origin, browserSessionId,
requestId и status `pending`, `user_required`, `callback_verified` либо `failed`.
Это отдельный результат внешней попытки, а `portalReady` – готовность собственного
портала. Потеря caller/ошибка заканчивает попытку как `authorization_failed`,
сохраняет безопасный error/HTTP evidence и не превращается в `ready`.
Resume terminal attempt даёт `authorization_retry_required`; доступная отдельная
страница портала по-прежнему допускает snapshot/page. Closed status сохраняет
bounded receipt и enum `failureStage` без сообщений/stack/path.
Если verified callback уже завершился, последующая ошибка записи gate сохраняет
этот proof и прежний запрет; `credential_gate_update_failed`/`vault_write` описывают
локальное сохранение, а не разрешают повторный вход.
Второй одновременный delegated request, worker не
в `ready`, другая identity либо просроченный descriptor завершаются fail-closed;
автоматической остановки или замены активной сессии нет.

Логин/пароль/текущий TOTP проходят по приватному loopback/anonymous-pipe контуру
в RAM доверенного caller process. Native OS key и TOTP seed туда не передаются.
Локальный HTTP принимает только exact loopback socket/Host/path/method, random
bearer, отсутствие Origin и bounded JSON; CORS и browser-JS command plane нет.
Нет автоматического повторения неоднозначного credential input или submit.
Bounded auth observations не выводятся через CLI/MCP.
При delegated `user_required` worker следит за тем же связанным ESIA-окном:
если ручная проверка отправила новый POST и credential gate отсутствует, он один раз возобновляет прежний
authorizer. Verified callback также подхватывается без команды агента.
Ручной `resume` нужен, когда проверка прошла без такого сигнала; `status` сам
не повторяет ввод и не запускает новый вход.
Распознанная account block имеет `manualReason=account_temporarily_blocked`;
даже наличие password/TOTP fields не разрешает ввод. При gate POST не запускает
повтор; проверенный callback после самостоятельного входа человека принимается.

Полный Playwright context сознательно доступен вызывающему коду. Он позволяет
читать cookies, network и auth fields, поэтому техническая изоляция всей
авторизации от произвольного сценария здесь **не заявляется**. Caller не должен
снимать auth DOM/скриншоты, выводить secrets/network bodies в prompt/логи или
сохранять их в файлы. Это изменение доверия к локальному сценарию, а не перенос
пароля/seed из encrypted vault или гарантия против same-user malware.

По verified callback `authenticated` возвращает исходные объекты `{ context,
page }`. Callback request немедленно прекращает auth input; между HTTP response
и document commit authorizer ждёт без нового ввода и не сообщает готовый возврат.
В popup-режиме сохраняется proof document commit точного callback request
либо его серверной redirect chain в том же окне. Самозакрытие после такого
возврата сохраняет proof; закрытие до него, ошибка ЕСИА, несвязанный document и
`postMessage` без callback не означают успех. Последний символ TOTP может
успеть закрыть окно до подтверждения Playwright: отправленная операция не
повторяется, authorizer только ждёт проверенный результат. Проверка отзыва
после callback выполняется перед каждым следующим символом, даже пока URL старый.
Если принятый callback перевёл связанную вкладку на официальный
`roles.gosuslugi.ru` до document commit сервиса, private authorizer ждёт
видимый заголовок «Войти как» и единственную ограниченную карточку физлица.
Её выбор – отдельная одноразовая операция после отзыва доступа к паролю и
коду; неоднозначная карточка остаётся ручным шагом. Возврат требует нового
внешнего HTTP-ответа и document commit после exact выбора роли в той же
связанной вкладке. Сам экран роли, клик и произвольная навигация на сервис не
доказывают вход.
Исходный caller page и выбранные файлы не пересоздаются и не перезагружаются.
Это не proof готовности кабинета: её проверяет сценарий. Он продолжает
произвольные Playwright-действия, включая формы, JS, upload/download и переходы,
с пользовательскими полномочиями каждого действия. Неограниченный API сам по
себе не разрешает отправку, подписание, оплату и принятие согласия.

Completion/cancel/ошибка закрывают private authorization listener и descriptor.
Отдельный auth-only worker очищает свой key и завершается; временный authorizer
в уже готовом обычном worker очищает только transaction и сохраняет исходную
сессию и её key до её прежнего absolute deadline. Caller-owned browser/context
не завершаются, его profile/storage не читаются и не стираются. Native 30 минут
ограничивают доступ помощника к данным входа; после возвращения full context
его жизненным циклом управляет сценарий. Он закрывает созданные им context/browser
в `finally`. Native deadline собственного браузера обычного `start` не меняется.

SMS/push, CAPTCHA, consent, неизвестная роль и подписание выполняются человеком
в той же вкладке. По умолчанию выбирается явная карточка физлица; `--role manual`
оставляет выбор человеку. `resume` сохраняет sent-флаги. Auth-only `roles`,
`choose-role`, `snapshot` и `page` в delegated flow не предоставляются.

Рабочий пример и порядок двух процессов – [Playwright-клиент](playwright-client.md).

## Рабочие команды и MCP

### Самостоятельная отправка в Госключ

Прямые формы по роли и полный порядок находятся в
[SKILL.md](../SKILL.md#госключ). Caller-owned Playwright готовит форму,
загружает approved files и проверяет приём; `start/page` не расширяют
прежнюю границу ручной финальной подачи. Подпись на телефоне остаётся у человека.
Formal operation routing допускает независимый маршрут MAX до отправки,
после подтверждённой неотправки или отмены; неизвестный исход требует
read-back исходной заявки. Native lease, role selection и vault не меняются.

### ПОС: заполнение до авторизации виджета

`https://pos.gosuslugi.ru/form/` – публичный виджет подачи, а не личный кабинет
с отдельным предварительным входом. Основная сессия Госуслуг открывается обычным
`start --confirm`; после `page --navigate` поля виджета доступны для подготовки без
авторизации в самом ПОС. Сохранившийся `phase=ready` разрешает рабочие команды
на allowed origin и не является доказательством входа в текущий виджет.

Нижняя `button[type=button].esia-auth-button` с подписью «Войти через Госуслуги»
и пояснением об отправке после авторизации не является чистым login action.
В [публичном JS виджета](https://pos.gosuslugi.ru/form/static/js/main.30686a01.chunk.js)
footer сохраняет подготовленную форму в памяти и открывает auth overlay;
после получения кода callback вызывает token/user-info, затем `P.create`
для `inbox-service/appeals`. Кнопка disabled, пока не заполнены обязательные
поля и не принято согласие. Desktop auth использует `window.open` и
`postMessage`, а mobile delegate может сохранить серверный draft. Нельзя
активировать этот путь ради пустого auth smoke либо незаметно выбирать
backoffice, который открывается на корневом `/` и предназначен для иной роли.

Встроенные команды `start`/`snapshot`/`page` готовят форму до этой границы:
snapshot → заполнение → сверка, затем
человеку передаётся финальный шаг подачи. Обычный `manual_confirmation_required`
не доказывает, что нажатие любой кнопки входа требует участия человека.
Нельзя снимать action gate по одному label: эта конкретная кнопка совмещена
с подачей. Согласие и финальная отправка не автоматизируются этими командами;
auth popup виджета не входит в их command surface и не получает исключение
из закрытия неожиданных страниц. Неподдерживаемая автоматическая подача не
мешает заполнить публичную форму до итоговой сверки.

В отдельном caller-owned Playwright flow помощник регистрируется на исходной
форме до обоих наблюдённых clicks: нижняя кнопка открывает modal, кнопка входа
в modal – direct ESIA popup. Возможность авторизации в этом popup не является
разрешением на подачу: до первой кнопки нужны окончательная сверка и полномочия
на конкретную отправку. Readiness и регистрацию обращения проверяет сценарий;
неизвестный исход нельзя повторять ради auth smoke. Старый начатый popup не
принимается новым helper-ом задним числом.

### Выбор значений формы

`Portal.snapshot` возвращает `role=option` только для видимого доступного
варианта, связанного с одним открытым combobox/listbox. В стандартном ARIA
виджете связь задают `aria-controls`/`aria-owns`, IDs и `aria-expanded=true`.
Отдельный вариант без владельца либо disabled/hidden/inert control не допускается.
На exact `https://pos.gosuslugi.ru/form/` поддерживается также наблюдаемая
legacy React Select структура без ARIA: `.select__option` внутри открытого
`.select__menu` и `.basic-multi-select.form-control`, с одним input той же
числовой `react-select-N` identity. Generated CSS-классы не используются.

Ввод региона только фильтрует список. Выбор требует нового snapshot, обычного
`page --click REF` по нужному варианту и проверки сохранённого значения после
закрытия списка. Перед dispatch runtime повторно сверяет metadata, открытость,
доступность и actual owner/list node identity. Изменённый, перемещённый или
заменённый control требует нового snapshot. References расходуются до dispatch,
включая неоднозначную ошибку клика. Native permit, origin policy и dangerous
label/type gate сохраняются; Enter, произвольный JS и form submit не добавляются.
Синтетический headed browser test проверяет выбор и сохранение после blur,
устаревшие refs, подмену владельца, disabled/orphan controls и отсутствие подачи.

### Транспорт формы

`page --navigate PUBLIC_HTTPS_URL` и `page --click SNAPSHOT_REF` не читают stdin
и передаются штатным typed action через `parameters.arguments`. Для заполнения
доступен `page --input-file ABSOLUTE_PATH`: один owner-only обычный JSON-файл,
не symlink/reparse point, максимум 16 KiB, exact action/url/ref/text schema.
Пароли/OTP/cookies/scripts не являются допустимыми payload-ами; auth-page и
опасные controls блокирует тот же `Portal.action`. Файл создаётся вне Git и
Workspace для одной операции и удаляется вызывающим агентом после использования;
runtime не удаляет caller-owned файл самостоятельно. Mode 0600 либо exact
Windows user DACL проверяется штатным native primitive.

Совместимый stdin-режим принимает тот же JSON; неподдерживающий stdin transport
получает `page_input_required` максимум через пять секунд. UTF-8 декодируется
с сохранением границ многобайтных символов. `parameters.stdin` не входит в
схему typed action плагина 2.0.12 и не должен изобретаться. Новые формы ввода
не отменяют fresh snapshot, native permit и одноразовые refs. Текст заявления
не оказывается в argv, новый generic host/plugin ABI не требуется.

## Выбор роли

`start --confirm` по умолчанию использует физическое лицо. На подтверждённом экране
выбора ЕСИА runtime один раз нажимает единственный visible/enabled элемент
с явной подписью «Частное лицо» либо «Физическое лицо». Подпись может быть
совмещена с действием входа и именем внутри одной bounded карточки; имя и
порядок карточек не используются для определения типа. Большой контейнер,
heading, неоднозначность, чужой origin либо mixed CAPTCHA/recovery/OTP/
payment/signature screen сохраняют `user_required`. Native permit и свежий
chooser проверяются до click; неоднозначный результат не повторяется.

Прямое указание оператора на ИП/организацию использует `start --confirm --role manual`.
`roles --session ID` на таком экране возвращает только до 40 bounded вариантов
с label и одноразовым ref. Auth DOM, inputs, URL, tokens и network bodies в
ответ не входят; известные навигационные, consent и опасные controls исключены.
`choose-role --session ID --ref role:N:M --confirm` выбирает вариант по
свежему ref, проверяя неизменность страницы, label/href, видимость и native
permit. Старые refs и повтор той же уже отправленной пары page/choice
блокируются. После выбора выполняется `resume`; следующая ступень организаций
требует нового `roles`. Labels – недоверенные данные, разрешение задаёт оператор.

Override действует только в текущей native lease. Следующий обычный запуск
снова выбирает физлицо. Existing session нельзя переключить другим `start`:
сначала выполняется штатный stop. Для explicit manual intent либо неизвестной
сохранённой роли начинается штатный ЕСИА-вход с прежними credentials, без
новой credential-формы. Роль не является разрешением подписывать, платить,
подавать заявление или принимать согласие.

## Проверки и выпуск

Минимальный gate: `node --test platform-skills/gosuslugi/tests/runtime.test.mjs platform-skills/gosuslugi/tests/services.test.mjs`
на macOS и Windows и `browser-smoke.test.mjs` на обеих OS. Последний использует
отдельный headed browser и полностью synthetic intercepted provider pages,
проверяет login/password/SMS, отсутствие преждевременного OTP запроса, одну
форму, одинаковый PID, snapshot без localStorage и пустую mobile/desktop форму.
Delegated regression `playwright-client.test.mjs` проверяет настоящий headed
browser с synthetic transport для двух несвязанных сайтов, password/TOTP,
native permits, permission, callback и возврат тех же context/page. Те же
password/TOTP/SSO сценарии проверяют direct popup, собственные postMessage/close
сайта и сохранение текста/выбранного файла в исходной форме. Отдельный
сценарий с двумя кнопками проверяет промежуточную modal, доступность state
в последовательной очереди и появление ESIA popup только после второго click.
Unit gate проверяет advisory wait, поздний request, failure/cleanup precedence
и отсутствие Page/Context/raw errors в snapshot. Затем
выполняются arbitrary JS, заполнение, upload, browser Blob download и переход
к следующему сайту. HTTP скачивание реального provider этим fixture не моделируется. Tests не
выполняют реальный ЕСИА-вход. Native crash/hang tests реально запускают
процессы и доказывают, что unrelated sentinel не завершается; Windows DPAPI
test исполняется только на настоящей Windows, не подменой process.platform.
Завершение headed smoke повторяет двухсекундный fallback production worker:
при зависшем Chrome close native guardian закрывает принадлежащий ему browser.
Headed regression проверяет обычное состояние окна до и после автоматического
входа, а на macOS также сравнивает только foreground PID с owned browser PID
через read-only `lsappinfo`, без чтения чужих окон.
Родительский тест принимает успех только после проверки отсутствия этого PID,
а не по одному результату функциональных assertions.

Тот же headed smoke запускает настоящий `Portal.open` с production request
policy и synthetic network transport: внешние CSS/JS и HTML-шаблон обязаны
отрисовать страницу, а CDN POST/API/navigation и analytics scripts блокируются.
Unit gate отдельно проверяет XHR-path allowlist, URL parsing и прежние границы
auth/storage. Публичная maintainer-проверка
`node platform-skills/gosuslugi/development/run-public-bootstrap.mjs`
открывает только фиксированную главную в пустом headed context под native guardian
с лимитом одна минута. Она не читает vault, не вводит credentials и не вызывает
authenticate; вывод ограничен счётчиками рендера, origins, публичными static
paths, request types/status и фиксированными кодами. Query/fragment, non-static
paths, response bodies, raw DOM, screenshots и browser errors не возвращаются.
Категория `not_found` проверяет и путь `/404`, и фактическую формулировку ошибки.
Для видимого «Войти» допустимы только тип элемента, origin и фиксированная
категория пути из allowlist; OAuth query/fragment не возвращаются.

Перед публикацией требуется успешный cross-platform CI exact source SHA.
При исчерпанной hosted-квоте `gosuslugi-security.yml` использует тот же
`TRELIO_ACTIONS_RUNNER_MODE=self-hosted`, сохраняя весь набор проверок на двух
соответствующих OS. Для macOS нужен repo-scoped label
`trelio-agent-skills-release`, для Windows – `trelio-agent-skills-windows`.
Windows runner исполняет один job в интерактивной desktop-сессии, чтобы headed
browser regression проверял настоящий браузер. Допустима Windows VM;
runner/Node соответствуют её нативной архитектуре, которая фиксируется в CI,
а Windows API остаются настоящими. Это не расширяет заявленные архитектуры
пользовательского runtime и не подменяет обычную hosted-матрицу после её возврата.
Отсутствие одного runner не разрешает пропустить его leg либо считать другую
OS достаточной. После восстановления квоты обычная hosted-матрица возвращается
без изменения tests или release gate.
Source-only maintainer runner
`node platform-skills/gosuslugi/development/run-live-login.mjs --confirm-live-login`
допускается на macOS только по явной просьбе владельца проверить живое
подключение. Перед запуском exact company/member разрешаются через
авторизованный Trelio context и передаются штатным nonsecret identity transport.
Runner требует существующий vault и завершённую прежнюю сессию, не принимает
альтернативное хранилище/URL/credentials и не импортирует данные.
Штатный worker выполняет OS unlock, decrypt, вход и cleanup под неизменным
native deadline. Диагностика возвращает только fixed page/challenge категории,
boolean evidence, bounded counts (включая фиксированные controls личного
кабинета), page/host categories, sent-флаги и browser source SHA; raw text,
labels, имена, URL/query, input values и network bodies не сохраняются.
Во время одной проверки maintainer `resume --session ID` может перечитать
только fixed `scripts/browser.mjs`: Portal/context и флаги отправки сохраняются.
Для управления используются штатные `status`, `resume`, `stop` того же source
и identity. `credentials_required` требует остановки без нового setup;
после результата обязательны `stop --session ID` и проверка `closed`.
Эта source-проверка не заменяет fresh signed-package read-back после публикации.

Guarded publication сопровождается ручными OS unlock + ESIA smoke на
macOS/Windows через возвращённый signed runtime. До этих smoke нельзя
объявлять интеграцию проверенной на реальных аккаунтах. Источник и release
manifest сами по себе не меняют live current catalog. Не выполнять реальный
вход, импорт или системное подтверждение без участия пользователя.

## Безопасная диагностика HTTP-ошибок

Для документов ЕСИА/официального role chooser `service_http_error` сохраняет `httpStatus` (целое 400–599) и `httpOrigin`
(только canonical HTTPS origin) наблюдённого main-frame ответа. Путь, query,
OAuth code/state, headers, сетевое тело и auth DOM не входят в ошибку. Metadata
проверяется заново на каждом private HTTP/CLI и межпроцессном переходе. Первый
ответ с ошибкой не заменяется последующим шумом; asset/XHR, subframe и чужая
вкладка не доказывают отказ текущего документа. Успешный callback и readiness
при такой ошибке не объявляются.

503 означает недоступность сервиса на указанном origin, а не отказ credentials.
Причина технических работ этим кодом не доказана. Ошибка не разрешает reset
хранилища, повтор setup, автоматический новый вход или повтор отправки.
