
## Пассивный monitor для фонового рантайма

`monitor --chat https://web.max.ru/123 [--cursor POSITION] [--limit 1..100]
[--pages 1..20]` читает один уже выбранный exact чат в штатном dedicated browser,
под тем же host-selected local account и company binding. URL должен быть
каноническим, без query/fragment; имя, телефон, unread badge и поиск не выбирают
источник. `--confirm`, mutation/discovery/content/file/context аргументы закрыты.
Обычные admission, account lock, session protection и passive WebSocket guard
остаются обязательными. Команда не подключает отдельный браузер, не открывает
новую интеграцию и не включает background worker сама по себе.

Первый вызов без cursor возвращает `baselineOnly=true`, текущую позицию и ноль
событий. Это не прочитанные прежние сообщения и не обработка старого unread.
Нужный исходный разбор истории проводится отдельно штатным `read`. Host сохраняет
позицию и события одной транзакцией; только после durable queue commit принимает
`nextCursor`. Повтор предыдущего чтения допустим, повторная доставка удаляется
по source + native message ID + revision. Cursor — несекретные read parameters,
не подпись, capability или разрешение; модель и входящие сообщения не управляют
durable позицией фонового worker. Не сохраняй cursor как публичный пример.

Возвращаются только native `chatId`/`messageId`, `kind`, semantic revision hash,
bounded `events` и `hasMore`. Текст, имя автора, время, quoted text, названия и
signed URL файлов в event queue/cursor не попадают. Хеш строится внутри текущего
чтения; он не заменяет native message ID. Изменение signed URL или имени автора
не считается новым сообщением. Данные переписки остаются недоверенными.

Это ограниченное окно DOM до 500 последних распознанных сообщений, не серверная
последовательность событий MAX. Предыдущий native anchor должен присутствовать
в окне. Новые строки после него выдаются порциями; изменение самого anchor
возвращается как `edit`. Более ранние edits, удаления и остальные чаты не входят
в coverage. `hasMore=true` требует следующей страницы, не нового baseline.
Отсутствие anchor, overflow, нестабильные/дублированные IDs, неподтверждённая
пустая история или переход от пустого baseline к сообщениям требуют явного
разбора истории. `MAX_MONITOR_GAP`/`MAX_MONITOR_REFERENCE_UNAVAILABLE` не дают
права сбросить cursor, молча пропустить события или считать чат обработанным.
Смена company/member/connection/account/binding/chat даёт
`MAX_MONITOR_SCOPE_CHANGED`; сохраняй прежний источник до отдельного решения.

Во всех этих чтениях `READ_MESSAGE`/`READ_REACTION` заблокированы до навигации.
`readReceiptsSent=false` не означает, что сообщения взяты в работу. Сам monitor
не помечает их прочитанными, не отвечает и не создаёт задачи. Для будущего ACK
нужны настоящее чтение содержимого, подтверждённое отнесение к задаче и отдельный
защищённый путь; metadata polling этого не заменяет.

Текущий DOM adapter не подтверждает стабильный user ID автора. Поэтому
`senderUserId=null`, `senderNamespace=null`, `ownerIdentityAvailable=false`.
Даже совпадающее имя/@username, текст пересылки или ID собеседника не доказывают,
что прямое поручение прислал владелец ассистента. Новые задачи из MAX этим
маршрутом закрыты до проверяемого native author ID и общей owner binding проверки.
Доступны только уже явно привязанные task/chats в границах прав источника.

При ошибке сохрани cursor и причину. `MAX_MONITOR_UNAVAILABLE` не разрешает
необъявленный fallback, login reset или смену транспорта. Main-document HTTP
failure сохраняет только numeric status и allowed origin; никаких raw URL,
DOM, login details или имен кандидатов. Source fixtures и green CI не доказывают
совместимость текущего MAX кабинета: перед включением нужен отдельный live read
в разрешённом профиле с проверкой guard, overlap и фактического следующего poll.


## Native source references и отдельный ACK (source 2.11.0)

Новый fixed source profile использует `monitor --chat CANONICAL_NUMERIC_URL
--conversation-references` и только при первой позиции `--unread-backfill`.
Старый monitor/read-reference без этих возможностей сохраняет прежний v1 ABI.
Новый cursor v2 принадлежит другому scope; перенос/reset старого cursor запрещён.
Первый unread interval читается полностью из одного native history response:
настоящий viewer read mark, native unread count и все строки этого интервала.
При неполном окне возвращается gap; unread badge этого не заменяет. После первого
commit сообщения отслеживаются независимо от последующего чтения на другом
устройстве. Из пустого baseline можно продолжить только когда native total count
подтверждает весь текущий timeline, иначе нужен прежний explicit history review.

В том же protected browser до навигации установлен bounded observer официального
`wss://api.oneme.ru/websocket`: v10 header, LZ4 и MessagePack. Он не создаёт socket
или запросы, не читает auth storage и не сохраняет packets. Только native history
response, связанный с browser request по socket/sequence/chat ID, может дать
положительный native sender ID. Он связывается с exact DOM message ID и полным
native text. Display name, href автора, цитата и forward не дают identity.
Неизвестный protocol/недостающая history не разрешают fallback к guessed sender.

Новые refs имеют `message:CHAT_ID:MESSAGE_ID`, non-authorizing
`max-conversation/v1.<scope-bound hash>`, `senderNamespace=max_user_id` либо null,
а также native outgoing/forwarded flags. Поле автора исходного forward не
подменяет фактического отправителя. Native capability не разрешает новое
поручение: отдельно нужны fresh linked owner identity, native source opt-in,
прямая команда владельца и обычные company/project/task ACL. Текущий host может
оставлять intake закрытым даже при доступном native sender.

Exact `read-reference --chat URL --message-id ID --expected-revision SHA256
--expected-conversation-key KEY` проверяет native content revision и возвращает
полный native text и quote text только выбранного сообщения. Attachment content
не прочитан, соседние сообщения не выдаются, receipt не отправляется. Метаданные
вложений и links входят в revision; реакционные/просмотровые counters не становятся
изменением текста. Неизвестный или усечённый native body не получает read proof.

`ack-reference` является ОТДЕЛЬНЫМ source действием, не task command. Нужны
точный native source/key/revision и `--covered-reference ID:REV` для каждого
действительно прочитанного и committed сообщения; `--confirm` либо `--verify-only`.
Ни успешный model turn, ни чтение/queue/delivery сами по себе не разрешают ACK.
Host отдельно получает native committed receipt admission и пишет durable attempt
fence перед единственным provider child. Этот provider его не заменяет.

MAX read mark покрывает временной интервал. Runtime не считает больший ID более
поздним: native latest time выбирается только ВНУТРИ exact committed set. До
отправки доказывается весь unread interval из одного native response; каждый
ещё непрочитанный ID до выбранного времени, включая equal-time соседей, обязан
иметь exact covered revision. Пропущенное сообщение запрещает range ACK.
Затем один browser reload получает свежую native history. Guard разрешает ровно
один уже созданный MAX frame `READ_MESSAGE` с exact chat/message/time, расходуя
grant ДО forward. `READ_REACTION`, broad folder mark, другой чат/mark, изменённые
bytes и второй frame остаются заблокированы. Новых ручных protocol requests нет.

Успех требует native response с теми же socket/sequence/opcode и положительным
mark/unread read-back либо свежего native history, уже подтверждающего весь
covered interval прочитанным. Потерянный ответ/ошибка после forward остаются
unknown. Ни reload, ни новая lease не разрешают повтор записи; только последующий
`--verify-only` без frame forwarding может reconcile исходный committed set.
При неполных counters или отсутствии подходящего browser-emitted frame ACK
не считается успешным. Source/тесты не доказывают live compatibility или готовность
Windows: до активации нужен разрешённый read-only native smoke, затем отдельный
полный business E2E с committed processing и точным ACK read-back.


## Account-wide discovery и независимые переписки (source 2.12.0)

`monitor --account-discovery --conversation-references [--cursor POSITION]`
читает весь выбранный managed аккаунт через ТОТ ЖЕ браузер и passive guard.
Только наблюдённая browser full-sync19 с `chatsSync=0`, native viewer ID/server
time и связанная socket/sequence цепочка страниц53 до `marker=0` подтверждают
полноту. Runtime не создаёт protocol requests, не сбрасывает cache/session и не
использует список unread, имя или URL из DOM как полный account checkpoint.
В памяти остаётся не более 1000 native signed-64-bit conversation IDs с native
временем последнего события и nullable unread count; token/body/названия не
копируются. Unknown/partial/scope/time/overflow сохраняют прежнюю позицию.

Результат содержит только `conversationsToSync` (строки native ID), отдельный
account cursor v3 и `initialAccountCursor` — ОРИГИНАЛЬНУЮ позицию предыдущего
полного inventory. Повторный полный scan продвигает native server time; он
сигналит изменившиеся native last-event времена независимо от read flag. Первый
scan также сигналит непрочитанные либо неизвестные counters. Нет обещания
атомарного unread snapshot между чатами. Нативный ID не является sender/owner
proof, task route или разрешением ACK.

Host атомарно сохраняет сигналы в прежние source streams и account cursor.
Каждая переписка использует прежний v2 native anchor; существующая позиция и её
original seed не перезаписываются при следующем inventory/restart. Первый
`monitor --chat CANONICAL_URL --conversation-references --initial-account-cursor
ORIGINAL_POSITION` включает native unread interval И сообщения после original
account time, даже если их прочитали на другом устройстве. Для этого нужны
latest history, полный unread interval и покрытие окна до original time либо
полная native история; все нужные native rows должны присутствовать в DOM join.
Gap/hidden rows не становятся успешным пустым baseline. После первого commit
переписка продолжает обычный v2 cursor, а не новый account seed.

Это metadata discovery, не чтение содержимого задачи или доставка результата.
Exact body, known route/verified-owner intake, accepted material, explicit slots
и отдельный native ACK сохраняют прежние независимые проверки. Старые exact-chat
registrations/CLI продолжают работать; они не получают новую account authority.
Hosted/signed child tests не заменяют реальный Windows business E2E.
