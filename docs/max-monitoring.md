# Пассивное чтение MAX для цифрового ассистента

## Отдельная поверхность task-команд

Source 2.10.2 включает `trelio-assistant-execution.json` в прежний signed package.
Policy v2 сохраняет literal task prefixes и добавляет provider-owned
`deniedOptions`. MAX перечисляет `--chrome`, `--headed`, `--headless`, `--hold-ms`,
`--timeout-ms`: обычный human parser поддерживает эти overrides, но task не может
подменить browser executable, открыть окно либо задавать собственный budget.
Общий host должен отклонять отдельный токен и форму `--flag=value` до account/
browser I/O, включая malformed/unknown policy. Unknown v2 на старом host означает
отказ, не fallback. Human CLI и fixed native source profiles не меняются.

Task surface ограничена чтением/metadata, скачиванием выбранного файла и
обычными send/reply с прежней sending authority. Login/bootstrap, policy writes,
assist/manual-control, watch/monitor, admin/chat mutations и ACK не включены.
Новый parser command не получает доступ автоматически. Это классификация,
не новый browser/vault/executor, owner proof или разрешение отправки.
Generic host v2 enforcement и реальный Windows business E2E остаются отдельными
gates до активации. `ownerIdentityAvailable=false` не меняется: новые задачи по
display name/username/forward по-прежнему запрещены.

## Пассивный источник

Source `max-web` 2.10.0 добавляет bounded read primitive `monitor`, а не готовый
глобальный crawler. Он использует обычный dedicated browser, protected session,
host account selection и WebSocket read guard. Отдельного входа, credentials
store и headless browser transport нет. Полный исполняемый контракт находится
в [обязательной части 09](../platform-skills/max-web/scripts/instruction-guides/part-09.md).

Источник заранее привязан к одному canonical chat URL. Компания, участник,
connection, account и company binding входят в scope hash. Cursor содержит
только scope, последний native message ID и его revision; это обычные read
parameters, не authorization token. Они принадлежат private host state, не
модели, task text или публичным отчётам. Shared host обязан атомарно сохранять
events с nextCursor и дедуплицировать повторный poll.

Первое чтение только устанавливает baseline. Продолжение требует overlap native
ID в текущем bounded DOM window. Pagination не перескакивает через оставшиеся
сообщения; edit последнего anchor учитывается отдельно. Ранние edits/deletions,
первая история после пустого baseline и вытесненный anchor требуют review,
никакого silent reset. Unread badge не является checkpoint. Без реальных IDs
нет text-hash fallback. Body, author display name, quoted text и attachment URL
не выдаются в queue/cursor; semantic hash не даёт права отвечать или раскрывать
информацию. Ни metadata polling, ни durable enqueue не отправляют read receipt.

Native author ID сейчас не извлекается. Значение `ownerIdentityAvailable=false`
не заменяется догадкой по display name, username, forward или chat URL. Поэтому
новые задачи из MAX остаются закрыты; это требование подтверждённой owner
identity, а не ограничение обычного чтения уже привязанной переписки.

Source tests используют synthetic DOM и настоящий общий main-document HTTP
observer pinned v3.4.0. Они проверяют overlap, replay, partial pages, edits,
gap, binding changes, bounded projection и отсутствие receipt/body leakage.
Hosted Linux/macOS/Windows gate проверяет runtime/package contract. Активация
model-free worker, source registration/lease, native owner intake, message ACK
и live MAX smoke — отдельные зависимости; их готовность этими тестами не заявляется.

## Точное чтение наблюдаемой ссылки

Source `2.10.1` добавляет `read-reference --chat CANONICAL_URL --message-id ID
--expected-revision SHA256 --expected-scope SHA256`. Scope берётся из сохранённого
monitor checkpoint, принадлежит тому же private host state и не задаётся входящим
текстом. Ни scope, ни semantic digest не являются authorization capability.
Malformed input, cursor, history/discovery/mutation/file/context arguments
отклоняются до browser I/O. Один вызов читает только текущее bounded окно, без
неявного backfill, pagination или reset при отсутствующем ID.

Monitor и exact read используют общий native snapshot validator, scope hash и
semantic digest, а не две копии определения сообщения. Сверяются настоящий chat
reference, account/company binding, ID, текущие text/reply/media metadata.
Изменение source scope/сообщения даёт `MAX_REFERENCE_CHANGED`; отсутствие ID либо
недоступный источник – `MAX_REFERENCE_UNAVAILABLE`. Один возвращаемый message
не включает соседние строки, display author, transient signed file href или
предполагаемый owner ID. Размер полной проекции ограничен 256 КиБ без усечения;
превышение даёт `MAX_REFERENCE_INCOMPLETE`.

Source-режим общего DOM reader не скрывает duplicate ID и обрезанные media rows:
такие снимки не подтверждают exact reference. Для обычного human `read`
сохраняются прежние numeric/optional limit ABI и dedup. Все режимы используют
тот же browser, private session и установленный до навигации passive read guard.
Нет read receipts, файлового download, quote fetch, отправки либо ACK. Ошибки
проецируются в static code; общая HTTP диагностика сохраняет только status/origin.

`max-message-read/v1` явно различает полную **отрисованную** text projection и
содержимое, которого нет в DOM: `renderedTextComplete=true`,
`hiddenContentIncluded=false`, `attachmentsContentRead=false`. Это не обещание
полного native server body или анализа файла. `ownerIdentityAvailable=false`
сохраняется; чтение не разрешает intake новых задач. Host отдельно проверяет
task mapping/аудиторию и committed processing перед независимым ACK. Синтетические
pure/DOM regressions и source merge не активируют source, службу или live MAX.


## Native history и committed ACK в 2.11.0

Новый opt-in source protocol и точный ACK описаны в обязательной части09.
Legacy v1 остаётся пассивным и без native owner identity. Новый v2 checkpoint
имеет отдельный scope, exact numeric chat selection и native unread bootstrap;
ни reset, ни перенос legacy position не допускаются. Публичный первичный source
`https://web.max.ru/_app/immutable/chunks/C018QTHD.js` (web 26.10.6, изучен23.10.2026)
определяет native history49, read-state50 и sender; текущий public asset URL может
измениться. Исходники сайта не копируются в package или fixtures.

SAME browser observer читает bounded v10/LZ4/MessagePack ответы только с fixed
vendor websocket. Header неизвестной версии не подтверждает identity; opcode50
остаётся blocked даже при неизвестном/compressed payload. Ни auth envelope,
ни message body/packet archive не сохраняются. Положительный native user ID
сопоставляется exact selected chat/message/полной text projection. Sender namespace
`max_user_id` не является username или owner consent. Новые задачи остаются
независимым server-owned intake gate.

Queued revision берётся из native content fields, включая body/link/attachment
metadata; views/reactions не превращаются в body edit. Полный invocation-only
native equality hash дополнительно защищает reload перед ACK. Общий SQLite
журнал по-прежнему должен хранить только refs/positions/read slots/receipts.
Source emits и signed native child tests не объявляются live end-to-end.

ACK проверяет весь native unread interval и exact committed covered prefix;
все equal-time rows также должны быть covered. IDs не считаются time ordering.
Grant расходуется перед единственным browser-emitted frame; только native
correlated response или independent native history дают positive read-back.
Unknown допускает только verify-only, не replay. Read-only source/task admission
не открывает этот отдельный native committed-receipt путь.

Release blockers: фактический native history/DOM join и guard в настроенном
аккаунте, source registration с exact selector, общий host/body/processing/ACK
composition, а затем настоящий Windows business E2E. Отсутствующий login
требует штатного owner handoff, не создания/импорта human session.


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
