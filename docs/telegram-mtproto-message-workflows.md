# Telegram MTProto: сообщения, поиск и очередь

Канонический source – `platform-skills/telegram-mtproto/`. Skill `2.5.1`
публикует runtime `2.5.1`, требует Telethon `>=1.44,<2` и сохраняет
minimum host `1.11.0`,
connection definition, package credential и namespace личной сессии.
`bootstrap` обновляет зависимость существующего локального runtime без нового
входа. Чтение не отправляет Telegram read receipts; исходящие действия
следуют [единому контракту согласования](agent-skill-connections.md#sending-authorization):
подтверждение отдельного вызова, `read-only` как запрет, без постоянного
разрешения на автономную отправку.

Инструкция запускает все команды через возвращённый backend-ом
`runtimeExecution.localAction`, добавляя provider argv в structured
`parameters.arguments`, без shell и PATH. `runtimeExecution.command` остаётся
только совместимым fallback ответа, в котором structured action отсутствует.
Согласие на отправку даёт оператор в текущем разговоре; permission profile,
sandbox и approval mode клиента его не выдают и не заменяют. Runtime
patch не меняет backend, plugin, connection или minimum host.

## Кодировка CLI

CLI задаёт UTF-8 для stdout и stderr до разбора аргументов и исполнения команды.
Кодовая страница Windows console/pipe и `PYTHONIOENCODING` не меняют кодировку
результата. Названия чатов, текст сообщений и безопасные ошибки сохраняют
кириллицу, эмодзи, сочетания с ZWJ и остальные Unicode-символы без потери текста.
Ожидаемые runtime errors остаются JSON с exit code `2`; parser diagnostics
также выводятся в UTF-8. stdin и системная locale не меняются.

JSON сохраняет `ensure_ascii=False`; `export` / `daily-export` остаются
compact UTF-8, чтобы прежний `--max-output-bytes` учитывал те же байты.
`tests/test_cli_output.py` проверяет реальные subprocess pipes с принудительными
`cp1251`, `cp1252` и `ascii`, без аккаунта, сессии и сети. Эти regressions входят
в существующий Python provider gate на Windows, macOS и Linux.

## Переход в локальный Python

Команды сессии переходят из системного Python host-а в прежний provider venv.
На Windows это `subprocess.run` с отдельным argv, `shell=False`, наследуемыми
потоками и ожиданием завершения. CRT exec overlay не используется: он может
завершиться с `0xC0000005` до запуска команды и не сохраняет quoting аргументов.
Поисковые фразы с пробелами, кавычками и Unicode передаются как один аргумент;
пустые значения и trailing backslash также сохраняются. Parent не продолжает
исполнение команды после child, ненулевой результат не объявляется успехом.
На POSIX сохраняется настоящий `execve`. Оба пути сохраняют `-I -B` host-а.

Если уже запущенный Windows venv process завершился с `0xC0000005`, launcher
возвращает JSON `TELEGRAM_WINDOWS_NATIVE_FAILURE` с exit code `2`, closed stage
`venv_process` и исходным numeric NTSTATUS. Это не доказательство отказа Telegram,
logout или причины в конкретной библиотеке; без read-back mutation не повторяют.
Private paths, argv, session и содержимое сообщений в diagnostic не добавляются.
`tests/test_runtime_handoff.py` создаёт одноразовый venv без зависимостей/аккаунта/
сети и проверяет argv, isolated startup, ожидание и failure через реальные pipes.
Windows NTSTATUS моделируется завершением test process, без invalid memory access.

## Состав группы или канала

`members` без `--query` сопоставляет нефильтрованную выдачу с provider total.
Когда `returned == reportedTotal`, `hasMore=false` и
`limitReached=false`, runtime возвращает
`providerMayLimitResults=false`: тип Telegram `Channel` сам по себе не
является доказательством обрезки. Несовпавший или отсутствующий total,
достигнутый лимит и access failure сохраняют неопределённость.

При `--query` Telethon может вернуть в `TotalList.total` общий размер
чата, а не число совпадений. Runtime не выдаёт его как
`reportedTotal`: фильтрованная выдача канала остаётся потенциально
ограниченной и не доказывает отсутствие участника.

## Поиск своих чатов

`dialogs --query TEXT --limit 1..100` вызывает `contacts.search`. Членство в
результате определяется только `my_results`: `results` являются публичной
выдачей и никогда не примешиваются. `users`/`chats` используются только как
словари сущностей для разрешения перечисленных own peers.

Ни `iter_dialogs`, ни первые 100/500 диалогов не определяют область поиска.
Старые группы участвуют в server-side поиске независимо от давности последнего
сообщения. `--limit` ограничивает возвращаемые результаты. Сохраняются поля
`dialogs[].id`, `title`, `unreadCount`, `entity`; exact metadata-запрос
`messages.getPeerDialogs` получает unread count только для выбранных peers.
Недоступный счётчик равен `null`, а не нулю. Metadata failure не отменяет
доказанный own result.

`coverage` содержит source `contacts.search`, scope `my_results`, returned,
limit, limitReached, publicResultsIncluded=false и unreadCountsComplete.
Telegram не возвращает доказуемое общее число совпадений либо continuation
этого поиска: complete всегда false, hasMore=null,
incompleteReasons включает provider_search_not_exhaustive. Достижение лимита
и неразрешённые own peers отмечаются отдельно. Пустой ответ не доказывает
отсутствие чата; transport failure не превращается в пустую выдачу.
`dialogs` без query возвращает страницу metadata-инвентаря по контракту ниже.
В поиске `--archive-scope active|archived` фильтрует только exact own results
после чтения метаданных; неизвестная принадлежность не допускается в выдачу.
`--query` не совместим с inventory cursor; исчерпывающий обзор не строится
через `contacts.search`.

Если exact reference не разрешается локальной Telegram-сессией, runtime
возвращает agent-visible code `TELEGRAM_CHAT_RESOLUTION_FAILED`, безопасный
`details` и exact `nextAction` с `dialogs --query`. Ошибка не утверждает, что
чат отсутствует или что доступ запрещён. Агент ищет чат по видимому названию
либо username и повторяет исходную команду только с exact `dialogs[].id` или
`@username`; угадывать peer type добавлением или удалением `-` / `-100`
запрещено. Ожидаемые `ChatIdInvalidError` и родственные peer-resolution ошибки
не выводят traceback либо raw RPC diagnostics. Timeout, reset и другие
transport failures сохраняют отдельную семантику и не переименовываются в
ошибку chat reference.

## Инвентарь чатов и обзор периода

`dialogs --archive-scope all|active|archived --limit 1..100` возвращает
ограниченную страницу метаданных, без текста preview/history. `active` –
все неархивированные облачные диалоги, независимо от прочитанности;
`archived` – только архив, `all` (default) – оба списка. Custom folders не
подставляются в native archive IDs. Каждая строка содержит marked `id`,
безопасную entity, `chatType`, `unreadCount`, `archived`, `folderId`,
`pinned`, `topMessageId` и `lastMessageAt`. Недоступные метаданные не
превращаются в фиктивное отсутствие чата или доказанную принадлежность.
Native `DialogFolder` – сводная строка архива: её `peer` и `top_message`
относятся к preview папки. Она исключается до проверки folder metadata,
не влияет на pagination/digest и не разрешает exact history. Обычный dialog
без `folder_id` по-прежнему оставляет область недоступной.
Native limit допускает одну дополнительную строку в пределах 100, поскольку
summary может занимать слот. Выдача и offset учитывают только возвращённые
чаты; summary-only Slice без безопасного offset не доказывает конец списка.

Продолжение – exact `coverage.nextCursor` в `--cursor` с той же областью.
Лимит ограничивает одну страницу, не весь аккаунт; больше 1000 диалогов
можно пройти последовательностью вызовов. В каждом native запросе максимум
100 ordinary dialogs. Закреплённые чаты перечисляются отдельно в каждом
archive scope; их произвольный порядок не используется как date offset
обычного списка. Native Slice не считается концом даже при короткой странице.

Первый проход перечисляет чаты, второй независимо проверяет полный digest
метаданных: peer, archive/pin state, latest message ID/date и порядок.
Account update position проверяется до и после каждой страницы и между
продолжениями. `coverage.enumerationComplete` описывает завершение первого
прохода, `verificationComplete` – второго; только matching metadata passes
без обнаруженных изменений дают `coverage.complete=true`. В verify phase
`dialogs=[]`, но cursor нужно продолжать. `inventory_changed` сохраняет
неполноту и требует нового обзора. Account position проверяется консервативно:
даже посторонние изменения могут потребовать повторного обхода.
`snapshotAtomic=false` всегда: API не предоставляет транзакционный снимок,
и даже совпавшие наблюдения не восстанавливают удалённые/изменённые сообщения.

`export` / `daily-export` используют тот же инвентарь для `--all-dialogs`;
`--dialog-limit 1..1000` ограничивает batch одной страницы. Можно вместо
этого выбрать exact чаты повторяемым `--chat` (до 1000 references).
`--archive-scope active` применяется до history также для сохранённых ID:
на каждой странице runtime заново читает exact live folder metadata.
Неизвестные данные оставляют чат открытым, а перенесённый в архив чат
исключается с `archive_scope_changed`, без чтения его истории.

Период фиксируется как `since <= date < until` с IANA timezone. `--cursor`
продолжает ту же selection, normalized UTC boundaries, archive/type filters,
link/chronological mode, текущий аккаунт и connection. Бюджеты можно менять,
чтобы увеличить размер следующей страницы. Token подписан локальным ключом
в owner-only connection namespace, имеет абсолютный TTL 12 часов без
продления и содержит только bounded offsets/digests/counters, без text,
preview, credentials или access hashes. Другой device/account/scope,
изменение token либо истечение TTL требуют начала заново; cursor не выдаёт
доступа и не является постоянным индексом переписки.

Каждый unfinished chat имеет exclusive message-ID offset, поэтому сообщения
с одинаковым timestamp не пропадают. Offset продвигается только после
возвращённой строки либо явно проверенного сообщения вне периода.
Обрезка по bytes/total/per-chat/scan не закрывает участок; завершённые чаты
удаляются из pending batch и не перечитываются при продолжении.
`--scan-limit` ограничивает все history reads одного вызова, а не произведение
per-chat ceilings. `--chronological` упорядочивает только текущую страницу;
совокупность страниц анализируется с дедупликацией по marked peer ID + message
ID и при необходимости общей сортировкой. Архив/read state не меняются.

`coverage.inventory` отделяет список чатов от сообщений. Каждый чат содержит
`coverage.complete`, `textComplete`, `nextBeforeId` и точный `unreadInterval` с before-ID;
`incomplete_chats` перечисляет текущие незакрытые области и причины.
`coverage.completedChats` / `returnedMessages` – cumulative counters;
`coverage.nextCursor` описывает remaining batch либо очередную страницу
scan/verify. Только финальное `coverage.complete=true` разрешает назвать
обход выбранной доступной истории завершённым. Блокированные/недоступные
чаты, ошибки и лимиты не выдаются за отсутствие сообщений. Если continuation
не продвигается, агент сообщает конкретный blocker и прекращает повтор цикла.

Export не dereference-ит replies: такие дополнительные reads могли бы выйти
за период/чат либо попасть в архивный discussion. `replyContext=null`;
exact reply/context читается отдельным явно scoped запросом при необходимости.
Media возвращается как metadata. `attachments.returnedMetadata`, `contentRead=0`
и `coverage.attachmentsContentRead=false` отдельно показывают, что файлы,
голосовые и видео не прочитаны. `textTruncated` делает `textComplete=false`
и сохраняет неполноту текста. Никаких receipts, отправок, реакций, переносов
в архив, скачиваний или изменений настроек обзор не выполняет.

## Точное сообщение и ветка

`read --link URL` и `read --chat EXACT --message-id ID` читают одно сообщение
без прохода по recent history. `--context 0..10` добавляет хронологическое окно
с явным per-side coverage. `read --chat EXACT --limit N` сохраняет прежний
контракт последних сообщений.

Парсер принимает public/private t.me/telegram.me message links, форму с topic
ID в path либо thread в query, comment ID и соответствующие tg://resolve /
tg://privatepost. Он не выполняет HTTP navigation, не открывает invite или
bot-start URL, не допускает дублирующие/conflicting selectors и проверяет
peer/message/thread до действия.

Для channel comment сначала вызывается getDiscussionMessage. Runtime доказывает
forwarded origin через exact channel peer и channel_post, выбирает связанную
группу по peer identity и проверяет принадлежность комментария этому root.
Числовой минимум среди IDs разных чатов не является доказательством связи.

`thread --link URL --limit 1..100` либо exact chat/message читает replies
супергруппы или комментарии поста канала. Root возвращается отдельно, страница
имеет хронологический порядок. `coverage.nextBeforeId` – exclusive cursor
следующей страницы; `--before-id` не меняет target. Полная 100-row provider
page не считается концом ветки. Любая чужая thread/peer row вызывает отказ.
Для private dialog применяется обычное окно `read --context`.

`public_message` дополнительно возвращает mediaType и threadId;
`public_messages` – nullable message link. User dialogs не получают
выдуманную t.me/username/message ссылку.

`reply --link URL --message TEXT` либо exact chat/message сохраняет исходный
reply ID и topic. При reply на channel post runtime отправляет комментарий в
доказанную discussion group. Поддерживаются message-file, один file,
schedule-at и обычная send-policy. Provider result обязан подтвердить peer,
outgoing, точный текст, reply target, известный topic и requested schedule.
После начала отправки любой failure считается ambiguous; retry и fallback
не выполняются автоматически. Встроенные RPC-повторы Telethon и автоматическое
ожидание FloodWait отключены для send/edit/reply, queue mutations и
transcription; чтение сохраняет обычную retry policy библиотеки.

## Область поиска сообщений

`search` требует ровно одну область: повторяемый `--chat EXACT` (до 20
references), `--folder NAME_OR_ID` либо `--global`. Exact references разрешаются
через личную сессию; aliases одного peer читаются один раз. Совпадающие message
IDs разных peers остаются разными сообщениями. `--limit 1..200` (default 20)
ограничивает весь результат, а не каждый чат. Перед заполнением общего лимита
runtime даёт каждому выбранному чату долю; при лимите меньше числа чатов часть
области может остаться непрочитанной. Итог отсортирован по дате найденных
сообщений, но bounded sample не обещает глобально самые новые совпадения.
`coverage.chats[]` отдельно описывает каждый проверенный, отложенный либо
недоступный чат. Ошибка одного чата сохраняет результаты остальных и не
превращается в доказательство отсутствия.

Global scope использует native `messages.searchGlobal`, без перебора диалогов.
`--chat-type user|group|channel` передаёт соответственно `users_only`,
`groups_only`, `broadcasts_only`; `user` включает личные диалоги с ботами.
`--folder-id` принимает только `0` (основной список) либо `1` (архив).
Telegram custom folders имеют другое пространство IDs и не передаются в это
поле. Global filters входят в binding cursor; query-only tokens совместимы.

`folders` читает live `messages.getDialogFilters` и возвращает только безопасные
ID/title пользовательских папок. `--folder` принимает exact ID либо однозначное
имя; одинаковые названия требуют ID. Поддерживаются `DialogFilter` и
`DialogFilterChatlist`. Explicit include/pinned peers входят в область,
exclude peers исключаются, а explicit include переопределяет динамические
ограничения прочитанности, архива и mute. Статическая папка без `--chat-type`
не требует просмотра recent dialogs. Динамическая папка проверяется по
metadata максимум 1000 диалогов, с look-ahead для обнаружения ограничения;
history на этом шаге не сериализуется. Неизвестные category/read/mute metadata
не расширяют область и отмечаются `folder_membership_unavailable`.
Inherited mute settings не приравниваются к unmuted.

Folder scope выбирает до 20 чатов и использует тот же поиск, что repeated
`--chat`. `--chat-type` дополнительно сужает папку. Exact include peers вне
bounded dialog response сохраняются; chat/dialog ceilings отмечаются отдельно
в `folder.coverage` и общем `coverage`. При продолжении live folder definition
и разрешённый набор peers должны совпасть с cursor. Изменение папки требует
нового поиска. Raw include lists, access hashes и session credentials не
попадают в ответ или token.
Для exact include peers используются InputPeers текущей folder definition,
даже если numeric peer ещё не известен session cache; приватные access данные
остаются только внутри локального вызова. Разрешённая сущность обязана
подтвердить тот же marked peer ID.

## Фильтры поиска сообщений

`search --chat EXACT --from ID_OR_USERNAME` использует server-side from_id
для текстового поиска в группе. В личных чатах Telegram игнорирует from_id;
его сочетание с media filter также может вызывать provider RPC failure.
В этих случаях runtime оставляет native text/media/date search, а exact author
проверяет по его bounded result stream. coverage.authorFilter=bounded_local
отличает это от server / none. Условие автора никогда не отбрасывается.
Фильтры `--since`, `--until`, `--timezone` и `--media-type` доступны во всех
областях; `--from` также доступен для selected chats и custom folder.
Типы: any, photo, video, document, voice, round-video, audio,
url. Без query нужен хотя бы один явный sender/date/media filter; global scope
требует текст либо media filter и не принимает только даты.

Период полуоткрытый: since <= date < until. Дата без offset интерпретируется
в explicit IANA timezone, по умолчанию Europe/Moscow; normalized UTC-границы
возвращаются в filters. Дробные границы округляются вверх до секундной точности
Telegram; для inclusive since используется provider min_date на секунду раньше
этого округления. Invalid/reversed period и даты вне 32-bit timestamp диапазона
отклоняются, чтобы библиотека не перенесла границы в другой период.

Global messages.searchGlobal не поддерживает from_id. `--global --from`
отклоняется: подстановка messages.search(InputPeerEmpty) потеряла бы
supergroups/channels и нарушила scope. Global cursor связывает исходный query
со всем набором normalized filters. Query-only cursor остаётся совместимым.

Filtered exact-chat search за одну логическую страницу читает до 1000 native
hits / 10 provider batches по максимум 100. Даты проверяются также локально:
Telegram может игнорировать max_date у media-only request. Look-ahead и
provider exhaustion определяют hasMore; scanLimitReached не считается концом
поиска. Даже пустая partial page содержит nextBeforeId и позволяет продолжить.
Если есть выбранные совпадения, cursor остаётся на последнем возвращённом,
чтобы остаток provider page не был потерян.

## Продолжение и полнота поиска

`--pages 1..10` (default 3) автоматически продолжает логические страницы каждого
выбранного чата либо global scope. `--page-size 1..200` (default 100)
ограничивает совпадения одной страницы; общий `--limit` действует раньше.
Selected/folder search имеет общий потолок 10 000 native hits на вызов,
включая bounded local verification, look-ahead и строки, полученные до сбоя
или отказа при проверке страницы. Ошибка не обнуляет общий scan budget.
Пустая промежуточная страница
с безопасным offset продолжается автоматически. В global scope одна
логическая страница может читать несколько native batches максимум по 100.
Повторяющийся offset не разрешает бесконечный цикл или фиктивную полноту.
Дубликаты и изменившийся provider count требуют явного provider exhaustion.

Продолжение всех областей – `--cursor` из `coverage.nextCursor` с теми же query,
references и normalized filters. Для одного exact чата сохраняется
`--before-id` из `coverage.nextBeforeId`; его нельзя смешивать с cursor,
multiple chats, folder или global scope. Selected token содержит только
query/scope digest, numeric peer/message offsets и состояние страниц. На
каждом продолжении peers разрешаются заново; cursor не расширяет доступ.
Совокупность cursor ограничена 10 000 результатов; по достижении потолка
`cursorLimitReached=true`, `nextCursor=null`, требуется сузить запрос.
Страницы не являются стабильным snapshot: при накоплении результатов нужно
дедуплицировать временную выборку по peer identity + message ID.

`coverage.status` равен `complete`, `partial` либо `unavailable`; `summary`
кратко описывает результат. Только `absenceProven=true` доказывает отсутствие
совпадений в проверенной области. Пустая partial/unavailable выдача не означает
«сообщений нет». Scanned/scanLimit, pagesRead, authorFilter и incompleteReasons
явно описывают границы проверки. `hasMore=null` означает неизвестное
продолжение недоступной области, а не конец. Provider inexact flag,
недоступный author/date, обрезанная область папки и отдельно полученное
продолжение не позволяют утверждать complete для всего запроса.

## Объединённый контекст поиска

`--context 0..10` сохраняет максимум 10 hits и последовательные bounded history
reads. Пересекающиеся окна одного peer объединяются транзитивно в
`contextGroups[].messages[]`: каждое сообщение возвращается один раз в группе,
порядок хронологический, все найденные сообщения имеют `isMatch=true`,
`matchIds` перечисляет их IDs. Одинаковые IDs разных peers не объединяются.
Каждый hit содержит компактный `context.groupIndex`, `matchIndex` и собственный
per-side `coverage`, без копии окна. Group coverage и `contextCoverage` сохраняют
любую недоступную сторону; объединение не превращает неполный read в полный.
Foreign peer, неверная сторона окна или превышенный bound делают сторону
недоступной; такие строки не цитируются и не попадают в объединённую группу.
Точный `read --context` сохраняет прежнее отдельное `context.messages[]`.

## Расшифровка

`transcribe --link URL` либо exact chat/message допускает только voice и
round-video. Runtime вызывает native messages.transcribeAudio один раз и
подписывается на UpdateTranscribedAudio до request, чтобы не терять раннее
событие. Принимаются только exact peer, message ID и returned transcription ID;
buffer ранних событий ограничен четырьмя IDs.

`--wait-seconds 0..30`, default 20, ждёт события этого запроса без повторной
подачи. Результат содержит available, pending, complete, bounded text,
textTruncated, nullable quota/reset и source identity. Финальный текст
ограничен 65 536 символами; обрезанный и pending результат не являются полными.
Known Premium/quota/length/flood failures имеют безопасную причину; raw provider
diagnostics не выводятся. После unknown result автоматическая повторная заявка
запрещена. Сторонняя транскрибация, скачивание всего чата и автоматическое
создание задач не являются частью команды.

## Изменение очереди

`scheduled-edit`, `scheduled-cancel`, `scheduled-send-now` выбирают exact chat
и message ID из `scheduled`. Все они сначала требуют --dry-run, затем
--confirm --approval-hash, независимо от разрешения на переписку. Read-only
разрешает preview, но запрещает execute.

Approval – случайный одноразовый token с TTL 300 секунд. Owner-only local
record в config/message-operation-approval.json содержит только token,
operation/account digests и expiry, без текста либо credentials. Exact
connection namespace, account, runtimeVersion и свежий queue snapshot должны
совпадать. Новый preview заменяет старый; execute погашает token до provider
mutation. Неоднозначная ошибка не восстанавливает approval.

Snapshot связывает текст, formatting, media, buttons, reply, дату и повторение.
Raw TL values хешируются только в памяти; file_reference исключается из
content digest как обновляемый transport credential. В public payload нет
raw TL, file refs или access hashes.

`scheduled-edit` принимает replacement body, новую schedule date либо оба
значения. При изменении только даты message/entities не отправляются, а
существующий repeat period сохраняется. Даже body-only edit всегда передаёт
schedule_date: числовой ID обычного сообщения может совпадать с ID очереди.
Перед execute повторяется минимум 60 секунд до доставки. Post-read должен
подтвердить дату и все ожидаемые content fields. Новые repeat/online-only
schedules не создаются этим контрактом.

Cancel требует отсутствия entry и exact UpdateDeleteScheduledMessages без
sent_messages. Если естественная доставка опередила отмену, результат
ambiguous. Send-now дополнительно требует provider mapping queue ID → normal
message ID, exact history read и совпадение доставленного содержимого.
Одно исчезновение записи из очереди не доказывает успешную отмену/отправку.

## Проверка

`tests/test_inventory_workflows.py` проверяет >1000 peers, pinned/ordinary
pagination, metadata-only archive scope, generation/list changes,
native `DialogFolder` с peer (включая совпадение с обычным dialog и native limit),
cursor integrity/account/scope/expiry, equal timestamps, caps/resumption, closed-chat
reuse, access/metadata failures, attachment distinction и отсутствие reply
lookups/исходящих действий. Fixtures синтетические, без аккаунта и сети.

`tests/test_search_workflows.py` проверяет multi-chat scope, aliases и независимые
peer ID spaces, общий result/scan budget, автоматическое продолжение, cursor
binding, native global flags, live custom folders, partial failures и
транзитивное объединение контекста через синтетический provider без аккаунта
или сети. Те же regressions исполняются на Linux, macOS и Windows.

`tests/test_message_workflows.py` проверяет observable scope, старые группы,
public/own разделение, provider page ceilings, link/topic/comment resolution,
reply proof, transcription pending/quota и queue/history collisions, approval
expiry/replay/account/content changes и delivery races. Existing Python tests,
release-contract, cadence и package checks остаются обязательными. Live smoke
после публикации использует fresh signed runtime и read-only операции; тестовая
отправка требует отдельного прямого пользовательского поручения.

API-источники: [message links](https://core.telegram.org/api/links),
[поиск чатов](https://core.telegram.org/method/contacts.search),
[поиск сообщений](https://core.telegram.org/method/messages.search),
[транскрибация](https://core.telegram.org/api/transcribe),
[очередь отправки](https://core.telegram.org/api/scheduled-messages).
