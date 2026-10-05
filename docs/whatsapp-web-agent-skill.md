# WhatsApp Web runtime

Канонический source – `platform-skills/whatsapp-web/`. Подход MAX применяется к
chat-only границе, exact target, policy и preview; транспорт отдельный:
Baileys 7.0.0-rc14 работает по протоколу WhatsApp Web как связанное устройство.
Отдельный browser mode управляет `web.whatsapp.com` через screenshot/ref/координаты.
Протокольное устройство и browser имеют независимые QR-привязки; переноса
cookies или auth keys между ними либо из пользовательского Chrome нет.

## Хранение и срок

`session.json` – AES-256-GCM envelope с 96-bit random nonce, 128-bit tag и AAD для
exact skill/company/member/connection. Внутри находятся Signal credentials,
keys, ограниченная история, контакты, policy и журнал исходящих requests.
SDK BufferJSON сохраняет бинарные keys. `keys.set` ждёт атомарную encrypted
запись; последовательная очередь не допускает поздней перезаписи новым снимком
старого состояния. В protocol mode plaintext session/profile, `useMultiFileAuthState`, secret
env/argv/logging и экспорт сырого SDK state отсутствуют.
Worker изолирует console/stdout/stderr до загрузки SDK: вывод libsignal
отбрасывается без форматирования объектов, а отдельный закрытый writer
передаёт native guardian только permit/own с числовыми id/pid. Диагностика
не интерпретируется как guardian protocol и не переносится в логи.

Native primitives адаптированы из Т‑Банка с отдельной identity. Protocol mode
поддерживает macOS и login Keychain. Browser mode поддерживает macOS/Windows
с обычным постоянным профилем; Windows helper входит в package ради
owner-only DACL exact текущего SID и native process lifecycle. Protocol mode
на Windows остаётся недоступен и не заменяется браузером автоматически.
Windows helper использует long-path режим .NET Framework 4.6.2+ и extended
Win32 paths для UUID namespace и atomic filenames; системные настройки и ACL
не ослабляются. Ошибки длины/отсутствующего каталога возвращают безопасный код
без исходного пути.
Создание приватного compiler cache запускает только включённый в signed package
PowerShell script с `-ExecutionPolicy Bypass` для одного процесса: пользовательская
и машинная policy не меняются. Сбой этого шага возвращает фиксированный
`native_cache_create_failed` без compiler stderr или приватного пути.
WhatsApp – нефинансовый навык: отдельного LocalAuthentication/CredUI
prompt перед каждой сессией нет. Штатные запросы самой ОС на доступ к
хранилищу не обходятся. macOS key создаётся в собственном namespace с
доступом процессов текущего пользователя без per-app confirmation; runtime
отключает Keychain UI и при недоступности хранилища возвращает ошибку.
Это не защита от других процессов того же OS user. ACL существующих записей
не меняется; другие форматы/прототипы не читаются и не мигрируются автоматически. Native guardian
применяет mach_continuous_time / QueryInterruptTime и owned-process cleanup /
Job Object. Предел 30 минут включает открытие хранилища и QR-вход; reconnect его не меняет.
Linux не поддерживается. Тесты на другой OS не заменяют настоящую OS-проверку.

Связанное устройство переиспользуется до отзыва WhatsApp или explicit local
forget. Forget стирает local key/ciphertext; устройство отдельно отзывается
в приложении WhatsApp. Same-user malware, administrator, OS swap и crash dumps
не входят в обещание локального шифрования.

QR-handoff открывается самим worker в одном headed browser с временным
in-memory context. Loopback listener проверяет exact Host/socket/Origin,
Fetch Metadata, одноразовую навигацию/nonce, deadline и CSP без сторонних
ресурсов. QR передаётся только этой странице, не CLI/status. Success очищает
код; stop/cancel/expiry закрывают listener и owned browser. Cookies страницы
не являются WhatsApp credentials. SDK-сессия работает в native-supervised worker.

Кнопка «Обновить QR-код» заменяет только ещё не привязанный SDK transport.
Старый QR сразу скрывается; новый приходит от WhatsApp в ту же страницу.
POST проверяет Origin и текущую revision; одновременные/повторные запросы
отклоняются. Ошибка оставляет возможность повторить обновление, а успешная
привязка запрещает refresh в runtime. Deadline, encrypted state и браузер
сохраняются; запоздавшие события старого socket игнорируются.

## Чтение и изменения

Чтение использует локально синхронизированное ограниченное окно, не создаёт
свой полнотекстовый постоянный индекс и не вызывает readMessages/read receipts.
`markOnlineOnConnect=false`. Partial coverage возвращается всегда; limit и
короткий результат не доказывают полноту аккаунта. Unread неизвестного чата –
null, не ноль. Group participants читаются живым metadata-запросом.

Message projection исключает media URLs/keys, credentials, device identity и
raw protobuf. View-once attachments не экспортируются. Одинаковые имена
сохраняются для ambiguity checks; LID не преобразуется в телефон догадкой.

`me` проецирует только нормализованный individual chat ID текущего
authenticated socket и `isSelf=true`, без device suffix, credentials и raw
user object. Отсутствующий/невалидный ID и disconnected state fail closed.
Exact собственный ID допускается для read/send без записи в partial history;
Для нового номера `resolve` проверяет exact E.164 через onWhatsApp и даёт
десятиминутный per-session proof для возвращённого ID без записи в адресную
книгу. Остальные адресаты требуют existing synced-chat ambiguity guard.
Имена контактов и локальный профиль не служат доказательством своего аккаунта.

Каждая mutation требует preview exact target/body/file hash и one-use approval
в той же сессии не старше пяти минут. `confirm:true` подтверждает полномочия
текущего вызова по [единому контракту](agent-skill-connections.md#sending-authorization),
а не сохраняет разрешение. Старый encrypted `autonomous` читается как
`confirm`, сохраняя credentials, history и журнал. Установить постоянный
`autonomous` нельзя; `read-only` блокирует все mutations. Runtime version в
lease блокирует исполнение через ещё живой старый worker до его штатного
stop/read-back и нового start с сохранённым аккаунтом. Журнал claim по UUID
записывается вместе с exact chatId и заранее созданным provider messageId
до provider call и переживает перезапуск. `result` сопоставляет этот ID с
исходящим сообщением после синхронизации; отсутствие ACK не доказывает
неотправку. Старые claims без ID не дополняются догадками. После ambiguous result
нельзя менять UUID ради повтора. SDK retry/recent-message resending отключены;
транспорт переподключается ограниченно без replay пользовательской операции.
Submitted не равно delivered; факт и степень проверки остаются раздельными.
Успешный `CB:ack,class:message` того же authenticated SDK socket подтверждает
приём сервером отдельно от `messages.update` о доставке/прочтении. Подтверждение
сопоставляется с exact исходящими chatId/messageId и сохраняется в encrypted
journal до ответа. PN/LID alias принимается только по локальному reverse mapping
SDK; имена и совпадение одного ID без peer не являются доказательством.
Ранний ACK/receipt не теряется из-за позднего PENDING echo, snapshots либо
перезапуска; protobuf enum names нормализуются в те же числовые статусы.
Ответ message mutation и `result` ждут ACK максимум три секунды без resend.
`serverAcknowledged`, `delivered`, `read` различают этапы; `verified` в ответе
отправки означает только приём сервером. Negative ACK даёт
`providerRejected=true`, даже при `state=submitted`; отсутствие подтверждения
остаётся unknown. Group participant receipt не выдаётся за доставку всей группе. `receipts`
показывает observations по участникам, nullable исходный состав и counts;
PN/LID связывается только existing local mapping SDK. ACK проецируется также
в status исходящего сообщения при чтении истории.
Размер страниц ограничен также encoded JSON bytes с сохранением целых тел
сообщений и курсора `read`. Unknown unread указывается отдельно. Оборванный
control response завершает команду явной ошибкой без повторной отправки.
`help` читает reference из самого подписанного пакета; private source агенту
для работы не требуется.

Пагинация dialogs/contacts/search/blocklist/receipts использует непрозрачный
cursor, связанный с командой и фильтрами. Search принимает RFC 3339 since/until.
`history-fetch`/`history-status` коррелируют on-demand страницу по provider
request ID, включая ответ до завершения RPC; timestamp в SDK передаётся в ms.
Не больше десяти дополнительных страниц по 100 сообщений сохраняются отдельно
от recent retention. Pending/unknown блокирует новые запросы одну минуту;
поздний ответ сохраняет точную корреляцию. Полный архив не обещается.

Send принимает native image/video/audio/voice/sticker/document/contact.
Формат, размер и hash проверяются до preview и исполнения, без автоконвертации.
Chat settings поддерживает archive/pin/mute, block меняет блокировку человека,
group commands – роли и invite get/info/revoke/join. Все изменения требуют
отдельного exact approval, provider permissions и явной степени read-back.
Звонки, статусы, каналы, опросы, геолокация, фон и schedule исключены.

## Browser profile и управление

Первый `start --mode browser` использует headed Chrome/Edge. После успешного
входа explicit `--headless` переиспользует тот же профиль в новой сессии;
обычные команды не пересоздают browser. `browser_loading` не является
доказательством logout. Видимый QR/security input даёт login required;
в headless требуется stop и ручной headed-вход. Одновременно допускается
только одна lease любого режима. Общий Keychain helper остаётся стабильным;
browser lifecycle использует его существующий native supervisor без вызовов
key-store. Поэтому обычный профиль не зависит от состояния login Keychain.

Browser хранит полный native Chromium profile в обычной постоянной папке
`<connection>/state/chrome-profile`, как Telegram Web. JSON storageState не
используется: он теряет opaque IndexedDB CryptoKey, нужные для повторного входа.
Дополнительного шифрования Trelio, encrypted image, browser vault key и
Keychain/DPAPI-вызовов нет. POSIX mode/Windows ACL ограничивают доступ другими
пользователями, но не шифруют файлы и не защищают от процесса того же OS user.
`state/browser-state.json` – обычный atomic JSON journal с policy, claims и
фактом прежней авторизации. Identity binding обнаруживает ошибочно подложенный
журнал, но не является криптографической защитой. `browserStorage` честно
возвращает `mechanism=local_profile`, `encryptedByTrelio=false`.

Native supervisor сохраняет исходный continuous 30-minute deadline и владение
worker/Chrome: process group на macOS, Job Object на Windows. Штатный stop
сначала просит Chromium завершиться и сохранить профиль, затем подтверждает
закрытие; deadline ограничивает зависший процесс. Файлы остаются на диске для
reuse. `doctor --mode browser`/`bootstrap --mode browser` не проверяют Keychain
и сообщают `encryption=none`; отсутствие профиля требует первого QR-входа.
Первый headed launch на Windows использует Edge, на macOS – Chrome;
`--channel chrome|msedge` выбирает конкретный установленный браузер.

Версия 2 использует новый QR-вход без миграции старого encrypted browser store.
`browser/session.json`, `browser/profile.sparseimage` и прежний OS key не
читаются, не копируются и не удаляются. Прежний журнал не переносится: это
не разрешает повтор неизвестной отправки, её результат устанавливают в чате.
Активная старая сессия сначала останавливается штатно. `forget --mode browser
--confirm` удаляет только новый обычный профиль и журнал; protocol session и
старое browser-хранилище сохраняются. Отзыв устройства выполняется отдельно
в WhatsApp.
Блокировка файлов после остановки на Windows допускает короткие ограниченные
повторы удаления; они не продлевают lease и не повторяют browser-действия.
Полный контракт –
[локальные профили мессенджеров](agent-skill-connections.md#local-messenger-browser-profiles).

После authenticated guard browser-snapshot сохраняет приватный PNG и refs.
Guard проверяется до и после screenshot; QR/secret frame не сохраняется.
Click/type/key/upload имеют двухминутный preview, fingerprint текста/полей/
geometry, одноразовый snapshot и durable UUID claim до dispatch. UI outcome
проверяется свежим снимком; ambiguous не повторяется. Browser не экспортирует
CDP, cookies или raw auth state и не принимает произвольный JavaScript.
Разрешена только навигация exact web.whatsapp.com, popups закрываются.
Открытие чата имеет обычную WhatsApp Web read-receipt semantics. Это явно
отличается от protocol reads. Unknown protocol send никогда не повторяется
через UI. Режим не создаёт фоновые задачи или автоматический resend.

После трёх фактических несетевых ошибок одной exact protocol-операции в
текущей работе агент может перейти к ручным browser-командам. Сетевые timeout,
DNS/reset и HTTP 5xx не засчитываются; отсутствие login, ACL, разрешения на
изменение или запрет `read-only` не являются дефектом исполнения. Неоднозначную
mutation нельзя повторять ради счётчика: сначала `result` с исходным requestId
и live read-back exact чата. Достигнутый результат завершает действие, а
неизвестный разрешает в браузере только проверку. Новое исполнение через UI
допустимо после доказанного отсутствия результата, с теми же exact адресатом,
payload и полномочиями, но с новым browser snapshot, preview/claim и подтверждением
вызова. Protocol session сначала останавливают с `closed` read-back; browser
mode имеет отдельную QR-привязку и не наследует credentials, journal и
одноразовый protocol approval. Если браузер ещё не привязан,
вход выполняет владелец. В browser mode ручные команды уже доступны напрямую;
порог относится только к переходу из protocol mode по ошибке навыка.

HTTP-код основной страницы проверяется общим host observer до UI/login и
сохраняется в safe diagnostics по [общему контракту](agent-skill-connections.md#http-диагностика-браузерных-навыков).
503 не запускает recovery reload, повторный QR/login или смену транспорта.
Для общих HTTP exports требуется host runtime >=3.4.0.

На Windows `EBUSY` при чтении записываемого Edge `DevToolsActivePort` означает
ещё неготовый endpoint. Чтение повторяется только в прежнем bounded startup
loop того же owned процесса с проверкой permit/deadline. Permissions/format
errors блокируют запуск; профиль и browser process не подменяются.

## Проверки и maintainer smoke

- `npm ci --prefix platform-skills/whatsapp-web --ignore-scripts`
- `node --test platform-skills/whatsapp-web/tests/*.test.mjs`
- `node --test platform-skills/tools/agent-skill-refresh-contract.test.mjs`
- `node platform-skills/tools/build-runtime-package.mjs --skill-dir platform-skills/whatsapp-web --check`

Для явно разрешённого владельцем live login используется source-only
`development/live.mjs --confirm-live-login` с `bootstrap/start/status/request/stop`.
Он не входит в package, не вызывает MCP и не обходит catalog admission.
Отдельные fixture identities и root `trelio/development/whatsapp-web` не
представляют настоящую компанию и не читают существующее подключение.
QR-тест требует сканирования владельцем. Source smoke проверяет live список,
поиск, выбранную историю, неизменный unread и повторное использование
encrypted session. Реальная отправка требует отдельного exact разрешения.
Синтетические тесты не доказывают live login или доставку. Browser acceptance
проверяет повторный headed-вход без QR, headless reuse, snapshot/поиск/очистку
и stop/closed на реальном WhatsApp. Native/browser regressions на macOS и
Windows проверяют сохранение usable non-extractable CryptoKey и journal в
обычном профиле, повторный запуск, закрытие при потере guardian и зависании
worker до deadline. Storage tests доказывают отсутствие миграции/изменения
старого encrypted store и отдельный browser forget. Эти synthetic проверки
не доказывают настоящий QR-вход или доставку сообщения на другой OS.

После merge обычный source change не становится доступным в каталоге сам:
нужны independent skill tag, package CI и guarded публикация Trelio с read-back.
