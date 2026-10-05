# Защищённый runtime Т‑Банка

## Граница хранения

`vault.json` – единственный persistent credential/session record: JSON envelope
с AES-256-GCM ciphertext, случайным 96-bit nonce, 128-bit tag и AAD для exact
skill/company/member/connection identity. Версии runtime и задачи не меняют
namespace. В plaintext не записываются телефон, пароль, TOTP seed, текущий
код, cookies, localStorage или IndexedDB. Новый record атомарно заменяет старый
после fsync; повреждённый/чужой envelope не запускает повторный setup.

Телефон (`credentials.login`) и пароль нужны для повторного входа после
отзыва/истечения cookies. Optional `username` сохраняет отдельный логин, только
если конкретная форма банка его спрашивает; это не переименование телефона.
Seed необязателен, сохраняется только после ввода пользователем; runtime
принимает Base32 или `otpauth://totp` SHA1/6/30. Режим TOTP включается самим
пользователем в Т‑Банке. Пустой seed и SMS challenge требуют ручного ввода
прямо в уже открытой вкладке банка после реального запроса. OTP никогда не входит в
record. Хранение обоих факторов вместе ослабляет их независимость.

macOS: 256-bit key хранится в file-based login Keychain, access ACL доверяет
создавшему helper-у; каждое чтение/create/delete требует отдельного
`LAContext.deviceOwnerAuthentication` с reuse interval 0. Исполняемый файл
macOS называется `Trelio`, чтобы системное окно показывало имя приложения.
Старый guardian/v1 helper остаётся побайтно совместимым с runtime 1.2.7, а
title-aware key helper использует отдельные source, content-addressed executable
identity и service `trelio.t-bank.vault.v2`. Обычное обновление JS/browser
runtime поэтому не меняет trusted application ACL ни старой, ни новой записи.
Data Protection Keychain с provisioning entitlement не заявлен.

При первом запуске с прежним ciphertext новый helper без UI проверяет только
наличие v2 item. Если его нет, старый доверенный helper после одного обычного
owner confirmation читает exact v1 key, а новый helper импортирует тот же ключ
через private stdin без второго системного prompt. Ciphertext не
перешифровывается, credentials не запрашиваются повторно, а изменённый бинарник
никогда не читает v1 item. Все следующие запуски используют v2 и показывают
название разговора. Старый v1 item остаётся для rollback; явный `forget`
удаляет оба item и после миграции может показать два последовательных owner
confirmation. Обычный start password dialog login Keychain не вызывает.

Каждый новый `start`/`authorize`/`configure`/`forget` сначала читает точное
название текущего чата по `CODEX_THREAD_ID` из локального Codex App Server и
проверяет ID ответа. Bounded `requestTitle` остаётся запасной темой от
вызывающего клиента, если exact чтение недоступно или это Claude Code. На macOS и Windows выбранный текст передаётся native
процессам только bounded JSON через stdin. Отдельный macOS key helper использует
его в `localizedReason` Touch ID/пароль prompt, а Windows – в message CredUI: `Чат «…» запрашивает
защищённую сессию Т‑Банка максимум на 30 минут`. Он не попадает в argv/env,
vault, lease, status, Keychain metadata, DPAPI record или native
ошибки и не даёт полномочий. Пустые, обрамлённые пробелами, управляющие/bidi
строки и значения длиннее 160 UTF-8 bytes отклоняются. Старый вызов без title
сохраняет общий системный текст.

Windows 10/11 x64: key дополнительно шифруется DPAPI CurrentUser, namespace
используется как entropy. `key.dpapi` и control/vault files создаются с exact
user SID и owner-only DACL сразу, включая elevated Windows token: наследования
прав папки недостаточно, default owner может быть Administrators. Перед
create/read/delete CredUI запрашивает пароль текущей Windows-учётной записи;
его caption остаётся `Trelio – Т‑Банк`, а message добавляет название чата и
просьбу подтвердить пароль. LogonUser должен вернуть exact SID владельца.
PIN/Windows Hello не заявлены.
Нет автоматического DPAPI-only unlock, LocalMachine protector или plaintext
fallback. Учётная запись без работающего password-provider останавливается
fail-closed. Системный пароль не сохраняется; unmanaged buffers очищаются.

Local directory mode 0700/file 0600 либо проверенный Windows DACL; symlink/
reparse point и неизвестные права блокируются. Keychain/DPAPI зависят от
учётной записи ОС: её потеря/сброс могут сделать запись невосстановимой.
`forget --confirm` – локальное криптостирание ключа и ciphertext, не отзыв
доступа у Т‑Банка. Автоматической миграции из lichnoe, env или другого профиля
нет. Если первичная запись прервалась между созданием OS key и первым
ciphertext, runtime не заменяет ключ сам: нужен явный local forget/setup.

## Процедура и срок

Short-lived CLI общается с одним detached worker по exact loopback endpoint и
случайному owner-only bearer из `control.json`. Этот bearer не выводится агенту
и не является provider token. Новый `start` возвращает прежний `sessionId` до
terminal state; `status`, размышление и команды не открывают новый браузер.
`lease.json` связывает session ID, native guardian PID и абсолютный deadline;
stale cleanup убирает только disposable control files, когда supervisor уже
не существует. Если PID существует, runtime не угадывает его принадлежность и
не убивает его по номеру из старого файла.

Если supervisor доказанно завершён, `status` и `stop` для exact session сразу
возвращают `closed`, даже если native cleanup оставил disposable files.
Запрос со старым control bearer на прежний loopback port не отправляется:
порт уже может принадлежать другому процессу. Сохраняется только безопасная
ошибка из status той же сессии; vault и native key не затрагиваются.

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

## Браузер и форма

Первый launch только headed Chrome/Edge. Native guardian подтверждает
принадлежность PID до передачи браузеру каких-либо credentials. Используются
непостоянные Playwright BrowserContexts: browsing data не записываются в
launcher profile, snapshot состояния шифруется напрямую из памяти, без
plaintext `storageState({path})`. Это encrypted state vault, не APFS/BitLocker
volume и не обещание шифрования OS swap или crash dumps.

Runtime создаёт headed targets через public CDP с `background:true/focus:false`;
обычные Playwright `context/page` сохраняются. Временная вкладка сохранения
принадлежит exact context, открывается в фоне и закрывается после операции.
Origin storage переносится через inert, полностью перехваченные документы
без сетевого запроса и provider JS. Формат localStorage/IndexedDB совместим
с Playwright 1.60, включая типизированные значения; codec генерируется из
канонического reviewed vendor в Госуслугах через
`development/build-storage-codec.mjs`. Runtime package самодостаточен.
Встроенные origin restore/`storageState` не используются внутренним runtime:
они создают foreground pages. Посещённые exact банковские origins сохраняются
в памяти даже после перехода; внешний state не попадает в bank vault.
Сохранение не перезагружает рабочую страницу и не теряет черновик.
Полный API остаётся у агента, который не должен вызывать методы активации
либо raw session export для обычного сценария.

Local setup context отделён от portal context, но принадлежит тому же
browser process. Одна первичная настройка сохраняемых credentials использует
одну вкладку и один listener, которые закрываются после сохранения vault,
до открытия банка. Повторный вход с готовым vault не создаёт setup context.
Локальная форма не содержит OTP-поля и отклоняет OTP submit.
CSP без внешних ресурсов, exact Host/socket/Origin,
256-bit nonce, фактический GET формы, revision-bound one-use submit,
bounded body/timeouts, no-store/no-referrer. Agent не получает setup URL,
значения, CDP endpoint или raw errors. Cancel/timeout/error/success закрывают
listener/sockets. Окно создаётся неактивным; human-input step сообщает о нужном
вводе без автоматического переключения фокуса. `show` по явному запросу
пользователя доступен и во время credentials/code/auth ожидания.

Пятиминутный таймаут действует только на локальный ввод credentials и снимается
после его успешной подачи. Код из SMS/банковского приложения либо TOTP без seed
пользователь вводит и подтверждает на странице банка. Runtime сообщает
`code_required`, оставляет текущую вкладку в фоне и наблюдает только
challenge/переход, без чтения значения поля и без собственной отправки кода.
После перехода автоматически продолжается тот же вход; `resume` для обычного
кода не нужен. Неверный код, финансовая/неизвестная проверка требуют
`user_required`, а неожиданный origin блокируется без ввода и слепого повтора.
Delegated T‑ID может кратко показать пустой same-origin document после submit
телефона, пароля, сохранённого TOTP либо optional quick PIN. Только ограниченный
post-submit интервал считается переходом: runtime ждёт следующую распознанную
форму или проверенный callback. Sent guards всё это время сохраняются, поэтому
тот же телефон, пароль или TOTP не вводится и не отправляется повторно после
неизвестного результата. Лишь после истечения этого интервала status может стать
`user_required` с фиксированным безопасным `reason`; DOM, значения полей и
секреты остаются внутри private runtime.
Ожидание ручного кода не ограничивается коротким 90-секундным ожиданием
автоматического перехода: каждый проход требует свежий native permit и
остаётся внутри исходных 30 минут, включая сон. Setup-listener уже закрыт и
не отменяет банковский шаг своим прежним таймером. Общий deadline не меняется.
При отмене или истечении ввода сохраняется исходный безопасный код, а ошибки
закрывающегося браузера не подменяют его на `provider_result_unknown`.

Windows bootstrap private directory использует process-only
`-NoProfile -NonInteractive -ExecutionPolicy Bypass` для собственного
проверенного package script. Постоянная политика пользователя/машины не
меняется; Group Policy, exact owner и DACL checks сохраняются. Native copies
синхронизируются с Госуслугами и проверяются на обеих OS. При недоступной hosted
квоте отдельный security workflow использует соответствующие локальные Mac и
Windows runner-ы по [регламенту](../../../docs/local-windows-skill-ci.md).

Native ошибки возвращают только фиксированные безопасные коды; текст OS
exceptions/компилятора не раскрывается. Отмена, недоступность и timeout OS unlock
отделены от ошибок чтения/создания ключа. `native_keychain_auth_failed`
соответствует `errSecAuthFailed`, а не ошибке банковского пароля. macOS `doctor`
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

## Передача рабочего context

После доказанного входа `script --session ID --input-file ABSOLUTE_SCRIPT`
передаёт агентскому коду настоящие `BrowserContext` и `Page` Playwright того же
браузера. Файл содержит тело async-функции с параметрами `context`, `page`,
`console`, а не список разрешённых команд. Код компилируется без исполнения
до handoff; CLI проверяет owner-only файл и передаёт exact прочитанные bytes
через private control transport. Пароль, seed, key и control/Playwright endpoint
не входят в параметры и публичный ответ. Строка JS исполняется в worker с правами
текущего OS user: это доверенный код вызывающего агента, не sandbox.

Перед первым handoff снова проверяются native permit, рабочий URL и отсутствие
видимых password/one-time-code inputs. Затем снимаются собственный auth network route, закрытие
дополнительных вкладок и отмена downloads. Реальные объекты сохраняются между
вызовами; доступны локаторы, evaluation, события, iframe, новые страницы,
файлы и переходы по поручению. Service workers остаются выключены в этом
непостоянном context. После закрытия исходной вкладки следующий script получает
последнюю оставшуюся; закрытие context/browser завершает сессию.

Handoff необратим для текущей сессии: ни `resume`, ни auth-автомат после него
не вводят сохранённый пароль/TOTP в context, где агентский код мог оставить
request listeners или init scripts. Для нового входа нужен stop/start с fresh
OS unlock. Session snapshot по-прежнему шифруется в памяти; из context с
внешними страницами в vault берутся только прежние exact банковские
cookies/origins. External session state не сохраняется для следующего запуска.

Read-only по умолчанию и полномочия на действия задаются инструкцией агента.
Полный Playwright API технически позволяет cookies/storageState/network и
mutations: runtime не анализирует произвольный код и не обещает фильтрацию
операций либо защиту от вредоносного same-user кода. Агент не экспортирует
session/секреты, не переносит их в другой браузер и не обходит deadline.
Общих запретов по продуктам, получателям и денежным лимитам нет; прямое
поручение не требует повторного согласования или флага `--confirm` у script.

Source ограничен 128 KiB, возвращаемый JSON – 48 KiB, console logs – 8 KiB.
`console.log/info/warn/error/debug` собираются в ответ, не в native stdout.
Известные credentials и карточные номера редактируются в строках результата;
это дополнительная защита, не универсальный detector произвольных secrets.
Нельзя писать в `process.stdout/stderr` или возвращать целые browser/network
объекты. Raw error message/source/stack не выводятся. При runtime exception,
ошибке сериализации или потере ответа результат операции считается неизвестным:
сначала чтение фактического состояния, без автоматического повтора script.

Каждая invocation получает native permit и остаётся в исходном deadline;
во время произвольного JS нет прокси перед каждым Playwright-методом.
Native supervisor завершает worker/browser независимо от event-loop hang.
Отмена клиентского запроса закрывает сессию, чтобы асинхронный script не
продолжал работать без вызывающего агента; синхронный hang ограничивает native
deadline. Временный файл source удаляется после вызова. Экспортированные по
поручению документы – результат задачи, а не credential/profile storage.

`snapshot/page/show` сохраняют прежний совместимый transport. Их refs связаны
с URL/metadata и погашаются до действия, `confirm` относится к одному вызову,
`dryRun` ничего не исполняет. Они не читают auth/OTP/card-secret screens и не
включают ограничений для полного `script`. Подробности и примеры – в
[контракте исполнения](payment-workflow-boundaries.md).

## Делегированная авторизация T‑ID и caller-owned Playwright context

Клиент `scripts/playwright-client.mjs` входит в подписанный пакет Т‑Банка.
Verified команда `client` возвращает exact materialized module path и nonsecret
company/member/configHome. Это разрешённый client-side import текущего
проверенного пакета; импорт repository source или старого materialized release
запрещён. Клиент сам не открывает vault, не читает OS key и не запускает браузер.

Вызывающий сценарий создаёт обычный headed Playwright browser/context/page и
владеет всеми действиями на сайте. Предпочтителен отдельный непостоянный
context; plaintext persistent profile, экспорт cookies/storageState в файл и
копирование пользовательского профиля не входят в этот flow. Клиент не
сохраняет состояние внешнего сайта в банковском vault.

`createTIdAuthorization(page, { company, member, configHome, origin, confirm })`
регистрируется до штатного нажатия входа на указанном HTTPS origin. Без
`confirm=true` нет browser inspection или native bootstrap. Разрешение на вход
проверяется в текущем разговоре; уже данное разрешение на этот сайт не
запрашивается повторно. Выбор передаваемых данных, подача, подпись и платёж не
включаются в разрешение на вход.

Клиент принимает только наблюдённый main-frame GET
`https://id.tbank.ru/auth/authorize` с `response_type=code`, отсутствующим либо
`response_mode=query` и `redirect_uri` на exact origin вызывающего сайта.
Callback обязан совпасть по origin/path/fixed query и `state`; code flow с
fragment/form-post, token response, второй transaction и replay отклоняются.
Same-origin переход только с `state` не является callback: некоторые relying
party сохраняют коррелятор на промежуточном маршруте до T‑ID. Callback-кандидат
появляется только с OAuth result (`code`, `error` или token-параметром), после
чего все прежние exact проверки применяются fail-closed.
OAuth URL/code/state/session_state не выводятся агенту и редактируются в
локальной диагностике.

Запросы, ответы и document commit наблюдаются в исходной странице либо в новом
direct popup с exact исходной Page как opener в том же context. Listeners
устанавливаются до login click: событие `popup` само по себе приходит слишком
поздно для первого OAuth request. Early request без готового frame/page
удерживается в bounded RAM queue до доказанной связи того же Request;
сопоставления по похожему URL нет. Existing/`noopener`/вложенный popup не
получает credentials; второй auth popup либо новая transaction прерывают
помощник без переноса ввода. Клиент не меняет route, не исполняет сайтовый код,
не повторяет login click и не закрывает страницы.

Только после реального bound request создаётся одноразовый owner-only descriptor
в `integrations/t-bank-handoffs/<SHA-256 identity/session>/`. Full SHA сохраняет
exact identity и укладывается в native Windows paths. Symlink/reparse и чужие
ACL не принимаются. Model получает только opaque IDs, origin, deadline и готовые
arguments; loopback port и случайный bearer остаются внутри доверенных процессов.

`authorize --browser-session UUID --request UUID --origin HTTPS_ORIGIN --confirm`
проверяет exact company/member/session/request/origin/deadline до claim и OS key
read. Нужен существующий vault: setup и перенос старого env/profile здесь не
запускаются. Fast SSO с уже существующими T‑ID cookies завершается после
проверенного callback без чтения vault/key. Обычный bank `start` и один delegated
authorizer не могут работать одновременно с одним vault; повторный вызов
переиспользует только exact активный authorization request.

Native guardian ограничивает доступ authorizer к credentials оставшимся
бюджетом исходного browser helper, не больше 30 минут. Для каждого секретного
символа и auth action private adapter вызывает `authorization-permit` у того же
worker, который получает свежий native permit. Claim callback не предоставляет
process ownership, не открывает vault и не начинает новую авторизацию. После
потери worker/guardian ввод прекращается; живой stale PID и перевод часов не
заменяют native barrier.

Телефон, optional username, пароль и сгенерированный текущий TOTP проходят по
приватному loopback/anonymous-pipe контуру в RAM доверенного caller process.
Native OS key и TOTP seed туда не передаются. Локальный HTTP принимает только
exact loopback socket/Host/path/method, random bearer, отсутствие Origin и
bounded JSON; CORS и browser-JS command plane нет. Нет автоматического повтора
неоднозначного credential input или submit. Bounded auth observations не
выводятся через CLI/MCP.

В делегированном T‑ID входе российский телефон приводится к десяти национальным
цифрам перед вводом: видимый `+7` принадлежит управляемой форме provider-а и не
дублируется из сохранённого E.164 login. Private adapter после ввода сверяет
только каноническое совпадение цифр внутри bound input и ничего не возвращает
наружу. Несовпадение завершается `auth_phone_input_mismatch` до login submit;
оно не превращается в ручной challenge и не разрешает повторный ввод.
Если первый шаг Т‑БКИ показывает только безымянную кнопку-стрелку, adapter
отправляет Enter из того же exact bound input после повторной сверки цифр.
Он не угадывает unnamed button по позиции и не может нажать кнопку очистки.

Полный Playwright context сознательно доступен вызывающему коду. Он технически
может читать cookies, network и auth fields, поэтому изоляция авторизации от
произвольного caller-кода здесь **не заявляется**. Caller не снимает auth
DOM/скриншоты, не выводит secrets/network bodies в prompt/логи и не сохраняет
их в файлы. Это изменение доверия к локальному сценарию, а не plaintext перенос
пароля/seed из encrypted vault и не гарантия против same-user malware.

Callback request немедленно прекращает auth input; между HTTP response и
document commit authorizer ждёт без нового ввода. В popup-режиме нужен commit
точного callback request либо его серверной redirect chain в том же окне.
Самозакрытие после такого возврата сохраняет proof; закрытие до него, HTTP error,
чужая страница и один `postMessage` не означают успех. Последний символ TOTP
может закрыть popup до подтверждения Playwright: отправленная операция не
повторяется, authorizer только ждёт проверенный результат.

После verified callback `authenticated` возвращает исходные `{ context, page }`.
Исходная форма, выбранные файлы и страницы не пересоздаются. Это не proof
готовности кабинета: её отдельно проверяет сайтовый сценарий. Completion,
cancel или ошибка закрывают private listener/descriptor и завершают authorizer,
но caller-owned browser/context остаются у сценария и закрываются им в `finally`.

Текущие SMS/app-коды, push, CAPTCHA, recovery, неизвестный экран и выбор
передаваемых T‑ID данных выполняются человеком в той же bound странице. Runtime
никогда не отмечает checkbox и не нажимает consent/разрешение; `resume` после
ручного шага сохраняет sent-флаги. Challenge не перехватывает фокус; `show`
доступен только по явной просьбе показать окно. `snapshot`, `page` и `script`
в auth-only сессии не предоставляются, потому что браузером владеет caller.
Порядок двух процессов и рабочий пример –
[Playwright-клиент](playwright-client.md).

## Контур автоматического входа

До handoff main-frame navigation и сетевые запросы страницы входа ограничены
exact HTTPS `www.tbank.ru`/`id.tbank.ru`; посторонние popup закрываются, downloads
отменяются. Ресурсы, XHR и iframe исходной страницы `/mybank/` разрешены уже
с первой загрузки кабинета, чтобы bootstrap чата не зависел от первого script.
Возврат на auth document сразу восстанавливает строгий ресурсный фильтр.
Это не расширяет origins для сохранённого пароля/TOTP и не даёт агенту доступ
к приватной авторизации. Автоматический reload кабинета не выполняется. Для static resources
разрешены exact `cdn.tbank.ru`, `acdn.tbank.ru`, `static.tbank.ru`,
`imgproxy.cdn-tinkoff.ru` и `sso-forms-prod.t-static.ru`, только GET/HEAD
script/style/image/font/media. Последний обслуживает код, стили и шрифты
публичной формы `id.tbank.ru`; соседние поддомены не получают разрешения:
navigation, POST, fetch/XHR на CDN не разрешены. Определение SMS/TOTP
учитывает наличие настоящего code input, а не рекламу входа по коду рядом с
телефоном. Credentials вводятся по символам только на `/auth/...` этих origins.
Для российского телефона T‑ID вводятся десять национальных цифр, после чего
private adapter принимает только их либо exact форму с provider-owned `7` и
лишь затем разрешает submit.
Readonly password активируется штатным фокусом без изменения DOM; при отсутствии
именованной кнопки первый submit возможен Enter из единственного известного
поля. TOTP допускает одно поле либо шесть ячеек. Для ячеек принимаются
`maxlength=1` или точная управляемая форма банка: default/text либо tel,
без maxlength/readonly, с `autocomplete=one-time-code`, numeric inputmode либо
tel хотя бы на одной ячейке. Остальные ячейки могут не повторять ни autocomplete,
ни inputmode. Изначально доступна первая ячейка, остальные disabled. Банк сам включает их
по мере ввода; runtime не меняет атрибуты. Проверка структуры выполняется до
погашения одноразового права отправки; guard ставится перед первой цифрой.
Автоподача не повторяется. Явные «Введите код из приложения для аутентификации»
и «код из генератора одноразовых паролей» распознаются как TOTP при настоящем
code input; переносы строк в надписи нормализуются.
Сохранённый seed применяется автоматически. При отсутствии seed остаётся
ручной ввод в банке, а SMS и sensitive-operation guards сохраняют приоритет.
Код банковского приложения без явного TOTP/аутентификатора/генератора
считается ручным кодом, не TOTP. SMS пользователь вводит прямо в форме банка;
количество и формат ручных полей определяет банк, runtime их не заполняет.
После ambiguous submit нет слепого повтора. Transport error не стирает vault
и не доказывает logout.

Direct cabinet login и delegated T‑ID сохраняют отдельные lifecycle и process
boundaries, но не отдельные правила распознавания credentials. Нормализация
телефона, классификация challenge и проверка segmented TOTP берутся из общего
`core.mjs`. Оба пути проверяют итоговую provider mask телефона; password без
именованной primary button отправляется первым Enter из exact password input.
Optional quick PIN одинаково принимает единственную кнопку либо ссылку «Не
сейчас», сохраняя остальные security prompts ручными.

Однозначное предложение «Придумайте код» для быстрого входа в личный кабинет
только в текущем браузере допускает одно автоматическое нажатие видимого
«Не сейчас». Дополнительно проверяются четыре ячейки, отсутствие password/
username и других manual/security признаков после исключения слов самого
предложения. Native permit и auth origin проверяются перед click. Runtime
не создаёт PIN и не отменяет обязательные CAPTCHA/device/recovery проверки.

Успешный вход требует exact `/mybank/`, отсутствия auth-полей/challenge и
признака раздела счетов. Дополнительно нужен видимый logout либо две точные
видимые ссылки «Операции» и «Кэшбэк и бонусы» с official `/mybank/` targets.
Это позволяет не открывать меню профиля ради logout и не читать финансовые
значения для определения готовности. Обычный одиночный input поиска или виджета
в уже доказанном кабинете не считается кодом входа: широкое распознавание OTP
действует только вместе с auth origin и классифицированным challenge. Сам URL
не доказывает авторизацию.

Код HTTP-ошибки кабинета и delegated T-ID сохраняется как `httpStatus` и
`httpOrigin` до closed status. Общий host observer >=3.4.0 ставится до
навигации кабинета; unauthenticated `/mybank/` 401 до credential submit
остаётся штатным запросом входа. T-ID callback error не доказывает успех.
Full URL/query, OAuth result и тело ответа не выдаются. Transport failure
не получает HTTP-код и не разрешает новый login/replay.

## Проверки и выпуск

Maintainer может диагностировать публичную загрузку командой
`node platform-skills/t-bank/development/run-public-bootstrap.mjs` из source
checkout. Она использует production request policy, fresh headed context и
native guardian без vault, cookies, credentials, login submit или screenshot.
Вывод ограничен структурными счётчиками, origin/type/status и public static
asset paths; query/fragment, non-static paths, body и raw errors не выводятся.
Этот probe не является входом в аккаунт или fallback для пользовательских
операций. После него сохраняется только stdout-диагностика, временный файл и
owned browser удаляются.

При явном запросе владельца диагностировать настоящий вход на macOS source-only
`node platform-skills/t-bank/development/run-live-login.mjs --confirm-live-login`
использует exact разрешённую host identity и уже настроенный vault. Импорт и
произвольный URL отсутствуют. Если vault содержит незавершённую настройку,
штатный worker может вернуть `credentials_required`: такую диагностическую
сессию нужно остановить без ввода новых данных. Production worker получает
ключ после fresh OS unlock и работает под штатным native guardian. Source-only
hooks сохраняют ограниченную owner-only диагностику: наличие TOTP/username,
обезличенные auth-заголовки, фиксированные признаки, типы/состояния полей,
количество контекстов/страниц и переходы. Значения input, raw DOM/AX/screenshot,
финансовое содержимое, request body, cookies и секреты не выводятся.
Maintainer `resume` может перечитать исправленный `browser.mjs` из того же
checkout с записью source digest, сохраняя browser, deadline и submission guards;
это не механизм обновления подписанного runtime. После проверки обязательны
`stop --session ID`, read-back `closed` и удаление временной диагностики.
Эта процедура не объявляет неопубликованный source текущей версией каталога.

Минимальный gate: `runtime.test.mjs`, `authorization.test.mjs`,
`t-id-flow.test.mjs`, `browser-smoke.test.mjs` и `playwright-client.test.mjs`
на macOS и Windows. Browser-тесты используют отдельные headed browsers и
полностью synthetic intercepted provider pages. `browser-smoke.test.mjs`
проверяет login/password/SMS, отсутствие преждевременного OTP запроса,
закрытие setup-формы/listener до входа, ручной код в единственной вкладке банка
без runtime submit, автоматическое продолжение, одинаковый PID, snapshot без
localStorage и пустую mobile/desktop форму. Формулировка «генератор одноразовых
паролей» проверяется при автоматическом вводе в одно и шесть полей и при
ручном вводе без сохранённого seed. Реальная надпись «приложения для
аутентификации» проверяется с шестью последовательно доступными ячейками,
опущенным default `type=text`, autocomplete только на первой ячейке,
сохранённым/пустым seed, пропуском optional PIN и account shell без logout.
Они не выполняют реальный банковский или T‑ID вход. Native crash/hang tests реально запускают
процессы и доказывают, что unrelated sentinel не завершается; Windows DPAPI
test исполняется только на настоящей Windows, не подменой process.platform.

Full-context regression вызывает настоящий `Portal.open`: проверяет auth
network policy до handoff, identity реальных context/page, свободный JS,
переписку, upload/download, popup, cross-origin iframe, продолжение между
вызовами и чтение после неизвестного результата без replay. External state
не попадает в bank vault, повторный saved-secret auth после handoff запрещён.
Delegated-client regression отдельно проверяет same-page/direct-popup T‑ID,
state-only промежуточный маршрут, callback/state/HTTP/commit, fast SSO, TOTP,
сохранение caller form/file и
произвольные upload/download/navigation после входа. Consent остаётся ручным.
Отдельный native-owned browser получает синхронно зависший script; реальный
guardian должен завершить и worker, и browser в исходный deadline.

Перед публикацией требуется успешный cross-platform CI exact source SHA.
Guarded publication сопровождается ручными OS unlock + bank smoke на
macOS/Windows через возвращённый signed runtime. До этих smoke нельзя
объявлять интеграцию проверенной на реальных аккаунтах. Источник и release
manifest сами по себе не меняют live current catalog. Не выполнять реальный
вход, импорт или системное подтверждение без участия пользователя.
