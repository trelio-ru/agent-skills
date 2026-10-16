# Работа с общими Agent Skills

Этот репозиторий содержит только общие provider-инструкции, runtime-код,
синтетические тесты и безопасные инструменты разработки. Корпоративные навыки,
реальные данные компаний, credentials, sessions, application identity и signing
keys сюда не добавляются. Перед правкой прочитай README.md и полный контракт
из references/ затронутого навыка; для релиза – docs/release-process.md.
Для Windows/native bootstrap прочитай полный
[windows-native-runtime.md](docs/windows-native-runtime.md). Общий статический
gate обходит все provider-ы; native gate выполняется на реальной Windows.
Для Telegram reactions, search, folder scope, cursor и context grouping читай полный
[контракт сообщений](docs/telegram-mtproto-message-workflows.md). Обзор всех чатов
использует отдельные проходы закреплённых/обычных диалогов и проверку
метаданных; export cursor продвигается только после возвращённого сообщения.
Archive scope повторно проверяется до history, включая exact сохранённый ID.
Native DialogFolder исключается по constructor до чтения peer/folder metadata:
сводная строка архива не является чатовой принадлежностью либо history target.

Для нескольких личных аккаунтов читай [общий контракт](docs/agent-skill-connections.md#общий-каталог-личных-аккаунтов): каталог и company bindings принадлежат host, protected storage и вход – provider-у.
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

Канонический main остаётся чистым. Новая работа выполняется в отдельном
физическом worktree и ветке codex/* от свежего origin/main. Перед правкой:
git fetch --prune origin, git status -sb, сравнение HEAD с upstream.
Не перезаписывай чужие изменения и не дели node_modules между worktree.

Комментируй неочевидные инварианты, права, состояния, retries и восстановление.
Изменение поведения одновременно обновляет контракт и содержательные тесты.
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
Для почтовой отправки сохраняй исходные байты вложений, различай отказ SMTP
и неизвестный результат, не выводи raw reply; читай
[контракт диагностики](docs/email-send-diagnostics.md).
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
Завершённый ESIA helper не владеет жизненным циклом browser. Следующая отдельно
разрешённая процедура может подключить новый helper к той же подготовленной Page
после verified callback и оценки прежнего бизнес-результата. Pending/failure либо
неизвестная подача не превращаются в replay; файлы/consent не пересоздаются.
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
Общий CI блокирует превышение у любого текущего provider source. Полный MCP
результат независимо ограничен 40 000 байтами на final backend/host boundary;
offline envelope fixture не заменяет live проверку personal layers при выпуске.
