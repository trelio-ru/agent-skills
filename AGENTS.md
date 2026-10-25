# Работа с общими Agent Skills

Task execution цифрового ассистента требует подписанный provider-owned
`trelio-assistant-execution.json`; общий host проверяет его до account/provider
I/O. Наличие setup/ACK CLI или account binding не открывает эти команды task-у.
Контракт – [личные подключения](docs/agent-skill-connections.md#assistant-command-policy).
Signed human-input setup uses the existing protected provider login only:
`trelio-secret-setup.json` v2, host >=3.18.0, literal argv and SAME account selector.
It never adds login to taskCommands, imports a human session or supplies secrets.
See [setup contract](docs/agent-skill-connections.md#signed-human-input-setup).

Этот репозиторий содержит только общие provider-инструкции, runtime-код,
синтетические тесты и безопасные инструменты разработки. Корпоративные навыки,
реальные данные компаний, credentials, sessions, application identity и signing
keys сюда не добавляются. Перед правкой прочитай README.md и полный контракт
из references/ затронутого навыка; для релиза – docs/release-process.md.
Для Windows/native bootstrap прочитай полный
[windows-native-runtime.md](docs/windows-native-runtime.md). Общий статический
gate обходит все provider-ы; native gate выполняется на реальной Windows.
Для Telegram views/reactions, search, folder scope, cursor и context grouping читай полный
[контракт сообщений](docs/telegram-mtproto-message-workflows.md). Обзор всех чатов
использует отдельные проходы закреплённых/обычных диалогов и проверку
метаданных; export cursor продвигается только после возвращённого сообщения.
Archive scope повторно проверяется до history, включая exact сохранённый ID.
Пассивный `monitor` хранит durable checkpoint отдельно от unread/session TTL;
initial channel `--unread-backfill` freezes the native unread interval, pages
metadata under the pre-history pts, then requires its difference catch-up.
New account hints use `--initial-account-cursor` instead: authenticate the old
account checkpoint date and include messages already read on another device.
Never use it to reset an existing cursor or claim historical edit recovery.
`read-reference` сверяет exact native ID/revision без context/ACK и требует полный текст;
`ack-reference` uses native range coverage, one non-retried write and read-back;
only committed exact refs may cover unread history. Verify-only reconciles an
unknown result without writing; generic task/source read admission never grants ACK.
First-send `--conversation-reference` uses the SAME provider monitor scope;
no hint failure may replay a positive send. [Contract](docs/agent-skill-connections.md#first-outgoing-routing).
Opaque conversation keys reuse the private cursor HMAC in a separate domain;
mapped reference reads/ACK verify the original key before body/native effects.
Keys correlate account-bound peers, never sender identity or processing authority.
baseline/gap/ACK и отдельный HMAC purpose – в том же контракте сообщений.
Task-команды Telegram отдельно перечислены в signed `trelio-assistant-execution.json`;
новые parser leaves не открываются ассистенту автоматически, login/admin/ACK
сохраняют отдельный допуск. Человеческий CLI не меняется.
Просмотры постов возвращаются как nullable `views` из полученного Message:
неизвестное значение не становится нулём, чтение не регистрирует просмотр.
`audience-count` читает число подписчиков/участников из exact live metadata,
без списка людей/истории. Missing/denied count остаётся неизвестным; cached
Channel counter не заменяет `channelFull.participants_count`.
Аналитика каналов и album/forward commands следуют тому же контракту сообщений:
фактический provider period/DC, bounded graphs без tokens и nullable counters.
Bulk preview привязан к account/source/destination/bytes; одноразовый approval
погашается до отправки. Неизвестный/частичный результат не разрешает replay.
`channel_tools.py`, `community_tools.py`, `authoring_tools.py`,
`interaction_tools.py`, `conversation_tools.py`, `inbox_tools.py` и все обязательные guides входят в signed package.
Темы/реакции/опросы/закрепы/admin commands и scheduled bulk следуют тому же
[контракту сообщений](docs/telegram-mtproto-message-workflows.md): exact peer/thread,
own choice, send-as и queue namespace проверяются отдельно. Новые metadata
writes используют existing one-use preview journal и post-read, не replay.
Исчезновение pending заявки с первой страницы не доказывает решение; approve
проверяет membership, неполная pagination не доказывает отсутствие.
Черновики – cloud mutations: exact chat/topic, fresh preflight и read-back без
обещания atomic CAS. Замена media замораживает bytes, после upload перечитывает
оригинал и сохраняет caption/entities. Invite lifecycle не ротирует permanent
links; topic lifecycle не удаляет историю. Готовые сценарии чтения сохраняют
coverage и самостоятельную sending authority.
Карточка возможностей использует fresh exact metadata без participant/history
projection. Per-call send-as выбирается из каталога exact destination и входит
в one-use preview; saved default не меняется. Delete требует personally
attributed outgoing, exact single ID и explicit scope; admin permission не
доказывает авторство. Native affected-state и exact absence проверяются вместе.
Цитата сверяется с полным оригиналом по UTF-16 offset; series парсится один раз,
сохраняет entities и останавливается после uncertain части без replay. Личные
archive/mute writes выбирают один own dialog, сохраняют прочие настройки и
проверяют fresh state; inherited mute не означает включённые уведомления.
Native DialogFolder исключается по constructor до чтения peer/folder metadata:
сводная строка архива не является чатовой принадлежностью либо history target.

Inbox reads сохраняют общий лимит и partial coverage; cloud drafts по умолчанию
возвращают metadata. Folder writes сохраняют полную native definition, shared/unknown
типы закрыты; mark-read имеет exact message boundary и отдельное согласование.
Личная unread mark не отменяет receipts. Safe diagnostics не выводят provider text
и не ослабляют unknown outcome/no-replay; новые parser leaves не открывают task ACL.

Для нескольких личных аккаунтов читай [общий контракт](docs/agent-skill-connections.md#общий-каталог-личных-аккаунтов): каталог и company bindings принадлежат host, protected storage и вход – provider-у.
Для WhatsApp discovery, recency, date-only поиска, coverage и browser fallback
читай [контракт WhatsApp](docs/whatsapp-web-agent-skill.md#поиск-последней-переписки).
Диагностика WhatsApp сохраняет только numeric disconnect и закрытые network enums;
terminal wait и doctor после cleanup сохраняют причину без raw SDK error/packets.
Protocol DNS recovery – только exact публичный endpoint, bounded DoH и обычный TLS;
system settings, other hosts, auth/mutation retries не расширяются.
Для VK Рекламы читай полный [workflow](platform-skills/vk-ads/references/workflow.md)
и [security](platform-skills/vk-ads/references/security.md): paused creation,
scoped планы, persisted receipts, read-back и запрет replay неизвестной записи.
POST/PUT и структуру групп нельзя менять как fallback после ошибки API.
Status-only recovery existing parent следует
[узкому контракту](platform-skills/vk-ads/references/status-recovery.md):
независимая launch authority, полный fresh tree/caps/dates review, один новый
dispatch active после optimistic preflight, persisted claim до сети. Outcome
первого HTTP запроса остаётся unknown; только полный read-back разрешает
связанный fence. Create, mixed patch, другие unknown и второй recovery закрыты;
GET-only reconcile новой операции не отправляет повторную запись.
VK read-back принимает campaigns как response alias ad_groups; недостающие
child IDs читает лишь под известным созданным родителем, проверяя его связь,
полные scalar значения и однозначность. Новый POST и поиск по имени запрещены.
Справочники VK используют штатный размер страницы своего endpoint, а не
campaign-list limit=200; одна страница не означает полный каталог.
VK receipts сохраняют bounded HTTP/field-code diagnostics без raw response и
credentials; вложенные path/code проходят тот же bounded projection и
повторную проверку у receipt boundary. Обход только fields/items/errors,
без message/body; причина отказа не разрешает повтор записи или fallback.
HTTP requestStage различает только oauth_token/advertising_api и задаётся
веткой запроса, не ответом VK; неизвестная причина/старый receipt не угадываются.
OAuth refresh сохраняется зашифрованно и обновляется под account lock до GET;
readiness failure не теряет выданную пару. Ошибка refresh не разрешает mint
fallback/массовый revoke. Причины – закрытые документированные codes, не message;
один403 не подтверждает token-limit, утраченный refresh не восстанавливается догадкой.
Новый max_goals проверяет дневной бюджет либо общий бюджет с конечной датой;
частичный update и package-specific availability не заменяются догадкой.
Read-back mismatch сообщает только static field identity без сравниваемых
значений; подробность diagnostic не снимает unresolved-write fence.
Только targetings.sex и targetings.geo.local_geo.loc_type допускают смену
порядка уникальных male/female и home/work при read-back и before/preflight.
Состав, duplicates, неизвестные значения, остальные массивы и полный
optimistic snapshot остаются exact. Только пустой targetings.segments и
отсутствующий ключ segments эквивалентны после очистки фильтра; null, другие
типы, непустой массив и отсутствующие остальные ключи не нормализуются.
Диагностика аудиторий/размещений следует [контракту](platform-skills/vk-ads/references/diagnostics.md):
source metadata повторно проецируется без users/upload history/идентификаторов
людей; nested segments не обходятся рекурсивно. Карта pads не доказывает
фактическую дистрибуцию. Missing count/неизвестные IDs остаются явными.
Source counter id и internal relation id различаются; priced_goal сверяется
с condition:substr, а не display name. Родительская цель не становится
предполагаемой effective целью группы. Отсутствующее поле priced_goal – пробел
чтения, не пустая настройка. Не возвращённое дерево не скрывает независимые
имена площадок; partial coverage остаётся явным. Недокументированные device/pad breakdowns
не заменяются totals и не угадываются. Existing group/banner plan/apply writes
не объявляются read-only из-за добавления диагностических команд.
Search phrase rules читаются по explicit params.source_id, не внутреннему
object_id/названию. Положительные и stop-фразы остаются per-phrase; unknown
параметры, bare expires unit и expansion не интерпретируются. Metadata snapshot
проверяется повторно, CSV/error lines не читаются; bounds и partial coverage
сохраняются по диагностическому контракту.
Общие stop_phrases источника и per-phrase stops не смешиваются; root поле
проецируется отдельно и сверяется с declared count. Empty per-phrase rows
не доказывают отсутствие общих исключений; missing/unknown/bounded coverage
сохраняет явное состояние без title inference или нового угаданного endpoint.
Audience/goal writes следуют [управлению](platform-skills/vk-ads/references/audience-management.md):
closed specs, complete parent snapshot, safe projection/opaque params digest,
один dispatch и GET-only recovery. Source IDs/goal IDs не выбираются по имени;
async deletion/403/partial list не превращаются в verified absence. Потерянный
create ID не угадывается. Hosted VK entrypoint регистрирует все отдельные
diagnostics/audience regression suites на каждой обязательной OS.
VK-сообщество разрешается только по exact public id/shortname из рекламного
справочника. `remarketing_vk_group.params.source_id` равен публичному
RemarketingVkGroup.object_id, не внутреннему id источника. relation.object_id
остаётся opaque ссылкой вложенного объекта. Diagnostic source lookup идёт по
scalar params.source_id
через полный уникальный каталог; ID/имя не подставляются при его отсутствии.
Регистрация/удаление источника используют тот же scoped journal; неполный
каталог не доказывает
отсутствие/удаление. Loading и неизвестный размер не становятся готовностью
рекламы; live совместимость нового endpoint проверяется отдельно от fixtures.
Lookup разделяет bounded сканирование и preview: exact resolved сохраняется
за пределами первых 20 кандидатов, весь ответ до 14 000 bytes. Полнота поиска
не подменяется сокращением показанного списка и наоборот.
VK Windows storage использует прямые Framework APIs и один bootstrap всех
каталогов с полными guards. Bounded watchdog и safe stages из security-контракта
не включают private paths, packets или native stderr.
Windows cold-cache bootstrap WhatsApp также использует прямые Framework APIs
без filesystem module discovery; owner/DACL до компиляции остаются обязательными.
Native regression stages показывают только fixed names, не paths или pipe data.
Для факсимиле читай [контракт](platform-skills/document-facsimile/references/workflow.md):
один account на вариант подписи, обязательное ФИО, локальный PNG, atomic CAS,
отдельное основание применения и визуальная проверка итогового документа.
Из выбранного локального PNG агент настраивает факсимиле без формы; свободный
комментарий формы завершает штатным host account update с read-back, без второй
provider-копии и без повторного сохранения PNG после catalogue conflict.

Локальная расшифровка следует [контракту](platform-skills/audio-transcription/references/workflow.md):
план установки до сети, отдельное согласие на закреплённые model/runtime bytes,
проверка SHA-256 перед загрузкой PyTorch checkpoint, закрытое локальное хранение.
Основная модель – `v3_rnnt`, raw text без обязательного восстановления пунктуации.
Отдельно запрошенное оформление сохраняет исходник и последовательность слов.
Старые job другой модели не продолжаются новым decoder-ом; mismatch проверяют
Node launcher и Python worker до inference, без изменения сохранённых результатов.
Потоковый decoder сохраняет все samples; cursor продвигается после durable
segment. Resume не теряет cancellation нового run и не меняет исходник.
Обязательны нативные first-install/inference gates на всех заявленных OS;
синтетический decoder не заменяет проверку настоящей официальной модели.

Канонический main остаётся чистым. Новая работа выполняется в отдельном
физическом worktree и ветке codex/* от свежего origin/main. Перед правкой:
git fetch --prune origin, git status -sb, сравнение HEAD с upstream.
Не перезаписывай чужие изменения и не дели node_modules между worktree.

Комментируй неочевидные инварианты, права, состояния, retries и восстановление.
Для Avito читай [визуальный контракт](platform-skills/avito/references/workflow.md)
и [защиту сессии](platform-skills/avito/references/security.md). Только
host bounded text/image/input API, без прямого HTTP, DOM/AX-дерева, code extraction
или fallback. Локальный fixed link router может обработать href exact click
для same-tab навигации; модель не получает код или DOM. Active private profile
и stopped AEAD archive различаются; crash не перезаписывает durable snapshot.
Private Cookie API host сохраняет session-only overlay в том же AEAD snapshot;
MCP его не возвращает. Explicit logout не восстанавливается, legacy snapshot
не требует сброса входа; restore выполняется до provider navigation.
Закрытие окна и «готово» сохраняют попытку в OS-protected snapshot;
`saved_unverified` требует визуальной проверки кабинета. Native совместимость
host проверяется отдельно на macOS, Windows и Linux до публичного выпуска.
Первый host account flow Avito обязан проходить реальный packaged
`__trelio_accounts_import`: отсутствие legacy store даёт пустой bounded envelope
без native/browser/credential IO, не ошибку и не сброс существующих snapshots.
Avito minimum host >=3.11.0 фиксирует bounded входящие вложения через browser
stream/local receipt, без URL/body в MCP и без popup focus; обычный navigate
файлов остаётся запрещённым. Также сохраняются безопасные headerless HTTP redirects,
text-first, pacing и лимит пяти вкладок;
старый долгоживущий bridge обновляется через signed admission до browser IO.
Диагностический minimum provider должен совпадать с release.json. Новые поиски
проходят submit-search/search-ready: тот же completion-based интервал 2–15с
с зачётом размышлений; обычное чтение и открытие источника не задерживаются.
Пять вкладок за browser lifetime, close при завершении; overflow onCreated
не обещает предотвратить transient появление popup.
ВКонтакте следует отдельным [workflow](platform-skills/vk/references/workflow.md)
и [security](platform-skills/vk/references/security.md) на том же visual host API.
Проверенный вход обязателен до рабочих действий; гостевой режим не поддерживается.
Scope включает HTTPS vk.ru/vk.com с поддоменами и exact vk.me; разделы VK
не запрещаются по названию. Hostname проверяется по DNS label, чужие lookalikes,
userinfo и нестандартные порты закрыты. Технический отказ конкретного control
не становится запретом раздела; capabilities и live готовность не выдумываются.
vk-ads и его credentials остаются отдельно. Перед записью сверяются account,
автор (профиль/сообщество), получатель и текст. Чтение диалога не обещает passive
PEEK, а synthetic dispatch не доказывает live VK compatibility.
Исходящие файлы VK требуют host >=3.17.0: signed `fileUploads`, native chooser
и frozen originals по [контракту](platform-skills/vk/references/uploads.md).
Форматы не запрещаются; source/его ACL не меняются, input не повторяется.
Изменение поведения одновременно обновляет контракт и содержательные тесты.
Google AI Search следует полному [контракту](platform-skills/google-ai-search/SKILL.md):
instruction-only browser tool, скрытая вкладка без изменения host launch policy,
уточнения в той же беседе, controller минимального случайного интервала 2–15 секунд
от получения готового ответа с учётом размышлений модели и источники текущего
ответа. Controller ждёт только остаток по монотонным часам. Проверка прототипа проходит
реальную отправку, completion, уточнение и открытие первоисточника; account/history
и session-параметры не сохраняются в публичные fixtures или отчёты.
Yandex Search следует [контракту обычного поиска](platform-skills/yandex-search/SKILL.md):
прямая выдача без Dzen/Алисы AI, самостоятельные уточнённые запросы, источники
и тот же минимальный интервал с учётом времени оператора.
Для iPhone Mirroring читай [контракт](docs/iphone-mirroring-agent-skill.md):
`long-press` проходит тот же guardian, удерживает 500–1000 мс и не увеличивает
двухсекундный handoff. Отмена всегда отпускает собственную кнопку; ошибка или
отправленные события требуют снимка перед любым повтором.
Start/retry/wait-connected используют общий алгоритм ожидания: минимум три
секунды, два кадра exact окна с доступной AX-навигацией, единый bounded deadline.
Отсутствие OCR не доказывает подключение; проверяй серые переходы и отмену
production алгоритмом с внедрёнными часами, без HID/retry в observer.
Чтение названия Codex-чата в системном prompt проверяй с ограниченным host PATH:
тест должен пройти executable discovery и реальный subprocess protocol, а не
только получить подставленный заголовок. Сохраняй exact thread ID, общий deadline
и frozen native helper identity; путь CLI разрешается без расширения PATH.
Для session-bound запуска ID чата задаёт текущая hook-сессия host >=3.7.1,
не окружение persistent MCP. Provider minimum фиксирует эту зависимость,
чтобы старый bridge обновился штатным recovery до запуска пакета.
Для MAX чтение пустого личного диалога следует разделу «Пассивное чтение»
в [SKILL.md](platform-skills/max-web/SKILL.md): найденный телефон и отсутствие
распознанных сообщений сами по себе не доказывают пустую историю.
Вложенные `.history` в MAX образуют одну routed историю; выбор единственного
внутреннего контейнера не должен скрывать загрузку внешней оболочки.
Пассивный MAX `monitor` следует [контракту](docs/max-monitoring.md): один exact чат,
перекрытие native message ID, явный gap; display name не доказывает владельца.
MAX `read-reference` сверяет native ID/revision и source scope в том же bounded DOM; source readers отклоняют дубли IDs/скрытое усечение media, обычное чтение сохраняет прежний ABI.
MAX source2.11 opt-in follows the SAME monitoring contract: native history49,
bounded v10/LZ4/MessagePack sender join and one-use browser-emitted read-state50.
Committed ACK needs full native unread coverage, including equal-time rows;
unknown outcomes are verify-only. Legacy v1 does not acquire owner identity.
No vendor source/real packet fixture, direct socket request or human session import.
MAX account discovery requires the browser's native full-sync19 + complete53 marker chain; each conversation retains its OWN cursor and original seed. Partial/unread/DOM lists never advance an account checkpoint. See [monitoring](docs/max-monitoring.md).
MAX task policy v2 additionally denies model browser executable/window/budget
overrides. Legacy host refusal is preserved until common enforcement is verified;
the descriptor alone does not prove readiness or native owner identity.
Для пассивного IMAP `monitor` читай [контракт](docs/email-monitoring.md): UIDVALIDITY, scoped checkpoint, finite readonly range; без ACK/новых задач.
Initial unread opt-in creates a separate bounded v2 stream under the original UID ceiling;
forward v1 remains independent of UNSEEN. Never reset an existing cursor or claim an atomic historical unread snapshot.
Opt-in conversation refs reuse bounded PEEK identity headers and the reply parser;
scope-bound hashes are routing hints, never sender/owner or task authority.
IMAP `read-reference` сверяет scoped identity до/после PEEK и exact UID/полный literal; общий literal budget списывается до allocation, metadata lines тоже суммарно ограничены. Отказ прекращает connection без LOGOUT; оба reader восстанавливаются, partial result не выдаётся.
IMAP exact ACK uses the same native guardian/account engine: identity/full-byte hash,
one additive Seen write, native FLAGS read-back and readonly reconciliation. Host
committed processing/ACK lease remain separate authority; see email-monitoring.
Generic browser OTP delivery follows [the protected mail contract](docs/email-browser-authentication.md).
No provider/site selectors belong in mail. Readonly UID baseline precedes any
browser input; exact sender/recipient/UIDVALIDITY and one code stay in private
pipes. Positive browser evidence and the SAME host ACK fence are required for
exact additive Seen. Lost delivery/STORE never grants replay or another mailbox.
Authoring profile uses ASCII SEARCH without CHARSET, Unicode synchronizing
literals and bounded metadata. Failures expose only implementation-selected
CONNECT/SELECT/POSITION/SEARCH/CANDIDATES/SIZE/FETCH/PARSE/VERIFY/CLOSE/RESULT stages;
never native exception text, mail content or a reason inferred from a stage.
Profile discovery validates the complete bounded UID result, then samples only
the newest 20 matches with explicit partial coverage and exact SIZE preflight.
Oversized mail is skipped without BODY; source-code delivery remains strict and
does not inherit this sampling or its relaxed evidence completeness.
Для почтовой отправки сохраняй исходные байты вложений, различай отказ SMTP
и неизвестный результат, не выводи raw reply; читай
[контракт диагностики](docs/email-send-diagnostics.md).
Явный SMTP-only режим почты задаётся в защищённой форме и сохраняется per-account:
читай [контракт подключения](docs/agent-skill-connections.md#режим-почты-только-для-отправки).
Не выводи его из ошибки IMAP; отключённые копии не являются сбоем или поводом
повторять SMTP. Чтение/reply блокируются до native unlock.
Из existing Agent Secret настройка идёт только через one-use Run-bound
secret-exec → exact signed skill-run и native-owned file reference. Значение
не добавляется в argv, ambient env, private protocol или Workspace; browser
fallback после отказа не выполняется автоматически.
Для ответов в цепочке читай [контракт reply](docs/email-replies.md): provider
вычисляет адресатов/заголовки и связывает preview с source UIDVALIDITY, точными
bytes и account/company. Digest не разрешает отправку или повтор неизвестного
SMTP-результата; malformed source не исправляется догадкой.
Подпись ящика следует [контракту](docs/email-signatures.md): полный текст
проверяется с сохранённой подписью, её изменение блокирует отправку до нового
review; настройка не меняет credentials, company bindings или sending policy.
Готовность отдельной provider-сессии не доказывает результат другой попытки
авторизации. После отказа/блокировки сохраняй точную причину и запрет replay;
перезапуск процесса или новая transaction не должны обнулять этот запрет.
Для делегированного выбора роли Госуслуг сначала используй свежий bounded
`review-role` той же auth-сессии. Загрузка карточек и ожидание после одного
клика не становятся ручным выбором; ошибка чужой command surface не доказывает
challenge. Осмотр не возвращает auth DOM/имена/поля и не повторяет вход.
Подсказка ручного восстановления должна содержать официальный маршрут из
trusted source и сохраняться в закрытом статусе; provider text не задаёт её URL.
Нормальный cleanup и аварийный выход используют одну bounded projection receipt.
Причину отказа callback уточняй фиксированным кодом, без OAuth URL/параметров.
Стандартное согласие ЕСИА на просмотр профиля входит в уже разрешённый вход
на exact сайт: используй fixed private grant с полной повторной проверкой
экрана и одноразовым dispatch, без вопроса или ручного клика пользователя.
Неизвестные права/другие согласия сохраняют отдельное основание; generic click
не расширяется. Контракт – secure-runtime.md навыка Госуслуг.
Регистр `response_type=code` у Госуслуг допускает только четыре ASCII-буквы,
без trim/повторного decode/переписывания запроса. Другие OAuth modes и все
callback/state/method/duplicate/replay guards проверяются независимо.
Делегированный helper реализует только ЕСИА: callback берётся из реального
request без карты внешних сайтов. После exact callback/state и внешнего
HTTP document commit он сразу отключает observation и возвращает те же
context/page. Request ancestry связывает redirect-параметры/токены сайта;
ошибки внешнего HTTP идут caller-у отдельно и не означают отказ ЕСИА.
Caller ГАС сохраняет optional UUID `accountId` verified Госуслуги descriptor
до helper-а; неизвестные/неверные bindings отклоняет до browser/consent IO.
Готовность кабинета проверяет вызывающий сценарий. Доступ к credentials
отзывается на callback, повтор transaction не разрешается.
Пошаговый caller Госуслуг не ждёт request/authenticated внутри очереди
browser-команд. Первый click может открыть только modal: observer сохраняет
доступность state и следующего разрешённого click в той же Page/helper.
Advisory wait без запроса требует осмотра промежуточного экрана, а не повторного
входа, нового helper или выдуманного ручного challenge.
Ошибки caller/download не проходят через `safeAuthorizationFailure` и не меняют
verified callback. Оба concurrent promise сразу наблюдаются; `saveAs` завершается
до cleanup всех собственных ресурсов даже при отказе одного close. Проверяй
исполняемый пример из playwright-client.md, включая timeout раньше click и EOF.
Завершённый ESIA helper не владеет жизненным циклом browser. Следующая отдельно
разрешённая процедура может подключить новый helper к той же подготовленной Page
после verified callback и оценки прежнего бизнес-результата. Pending/failure либо
неизвестная подача не превращаются в replay; файлы/consent не пересоздаются.
Поздний claim после наблюдённого callback Госуслуг получает только return-only
доступ: ожидание verified HTTP/document и разрешённая роль без vault/key unlock.
Callback не открывает credentials повторно; worker без record сохраняет resume
и исходную lease. Проверяй настоящий worker без vault и задержанный browser return.
Для protected input обязателен [контракт продолжения](docs/agent-skill-connections.md#human-input-completion):
безопасный result/continuation без обязательного chat acknowledgement, с исходной
lease и отдельной mutation authority; тестируется submit и cleanup.
Тесты Markdown-контрактов сравнивают смысл после нормализации LF/CRLF:
переводы строк checkout не меняют инструкции и не должны ломать Windows gate.
При правке Python CLI проверяй кодировку настоящих stdout/stderr pipes:
StringIO и UTF-8 locale не воспроизводят ошибки Windows code page. Для Telegram
действует [контракт CLI](docs/telegram-mtproto-message-workflows.md#кодировка-cli).
Переход в provider venv проверяется настоящими процессами на каждой OS:
Windows не использует CRT exec overlay; argv, ожидание и результат ребёнка
сохраняются. Для Telegram – [контракт перехода](docs/telegram-mtproto-message-workflows.md#переход-в-локальный-python).
Проверки идут через GitHub-hosted CI на нужных OS. Локальные full gates и VM не
заменяют CI без доказанного billing/quota blocker и отдельного решения о VM.

Теги skill-<skill-id>-vX.Y.Z и выпущенные package bytes неизменяемы.
Каждый release tag отправляй отдельным push и подтверждай запуск его workflow
по [контракту выпуска](docs/release-process.md).
MAX read-only assist сохраняет штатный phone lookup для cold контакта;
точная home-search кнопка проверяется и host gate, и browser event fence.
Для каждой новой signed-runtime публикации нужна уникальная runtime version,
даже при изменении только инструкций; порядок — docs/release-process.md.
Provider-релиз не повышает версию Trelio, plugin или generic host.
Signing остаётся на production backend. Публикация – guarded plan/apply с exact
artifact, digest, CAS и read-back. Сетевые ошибки: минимум три безопасных повтора;
перед повтором неоднозначной записи сначала проверь фактическое состояние.

До commit: узкие проверки, git diff --check, полный diff и аудит публичности.
Commit на русском, только файлы задачи. Опубликуй ветку, дождись exact зелёного
CI и интегрируй через PR. Затем обнови чистый canonical main и удали только свой
clean merged worktree и ветку. Новая лицензия без решения пользователя не вводится.

`Public source boundary` и check-public-source.mjs проверяют tracked snapshot
перед каждым push. Корпоративные исходники не копируются даже как fixtures.
Публикация исходников не разрешает перенос application identity; Telegram
artifact собирается только в отдельном private release-контуре.

Новый Node provider регистрирует ci.json внутри своей папки; подготовка и
полный тестовый entrypoint принадлежат provider. Изменения такой регистрации
выбирают только его OS. Изменение общего selector/workflow/executor сохраняет
полный gate; [контракт](docs/github-actions-execution.md#выбор-provider-проверок).

Основная инструкция новой публикации ограничена 16 КиБ UTF-8 после trim;
подробные сценарии остаются доступными в signed package. `guides` возвращает
точные native пути/размеры/SHA-256 до provider credential/native/browser IO;
host admission и общий выбор account выполняются отдельно. Все части обязательны
до рабочих команд, читаются отдельно и целиком. Неполный текст блокирует действие.
Gosuslugi использует сценарную карту, остальные разделённые инструкции – все
части по порядку. Регрессии реконструируют исходный SHA-256 с учётом только
переноса относительных ссылок и LF/CRLF; проверяют материализованный package
с настоящим CLI без identity/credentials, включая Python isolated mode.
Markdown-навыки без package содержат полный компактный контракт в SKILL.md;
сокращение проверяет каждый прежний safety/evidence/approval/replay сценарий.
Почта России сохраняет критерии завершения в начале SKILL.md: самопроверка всех
треков и названий после reload выполняется до смены навыка/cleanup. Непроверенное
переименование остаётся явным незавершённым шагом и переносится через checkpoint;
статус отправки либо файл не заменяют результат. Проверки текста не доказывают
выполнение этих действий живым агентом.
Общий CI блокирует превышение у любого текущего provider source. Полный MCP
результат независимо ограничен 40 000 байтами на final backend/host boundary;
offline envelope fixture не заменяет live проверку personal layers при выпуске.
