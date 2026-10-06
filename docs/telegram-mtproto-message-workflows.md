# Telegram MTProto: сообщения, поиск и очередь

Канонический source – `platform-skills/telegram-mtproto/`. Skill `2.3.7`
публикует runtime `2.3.5`, требует Telethon `>=1.44,<2` и сохраняет
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
`dialogs` без query сохраняет прежний bounded recent-list режим.

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

## Фильтры поиска сообщений

`search --chat EXACT --from ID_OR_USERNAME` использует server-side from_id
для текстового поиска в группе. В личных чатах Telegram игнорирует from_id;
его сочетание с media filter также может вызывать provider RPC failure.
В этих случаях runtime оставляет native text/media/date search, а exact author
проверяет по его bounded result stream. coverage.authorFilter=bounded_local
отличает это от server / none. Условие автора никогда не отбрасывается.
Фильтры `--since`, `--until`, `--timezone` и `--media-type` доступны также
в global scope. Типы: any, photo, video, document, voice, round-video, audio,
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

Filtered exact-chat search читает до 1000 native hits / 10 provider pages
по максимум 100 и возвращает до 200 совпадений. Даты проверяются также локально:
Telegram может игнорировать max_date у media-only request. Look-ahead и
provider exhaustion определяют hasMore; scanLimitReached не считается концом
поиска. Даже пустая partial page содержит nextBeforeId и позволяет продолжить.
Если есть выбранные совпадения, cursor остаётся на последнем возвращённом,
чтобы остаток provider page не был потерян.

Продолжение – `--before-id` из nextBeforeId; повторяющийся либо неубывающий
provider offset отклоняется. Scanned/scanLimit, authorFilter и incompleteReasons
явно описывают локальную проверку. Provider inexact flag, недоступный author/date
и продолжение не позволяют утверждать complete. Context по-прежнему
ограничивает выдачу десятью hits.

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
