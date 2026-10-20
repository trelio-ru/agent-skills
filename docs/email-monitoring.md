# Пассивный IMAP источник

`monitor` подготавливает provider read primitive для model-free диспетчера.
Один вызов идёт через прежний signed host, выбранный local account, native guardian
и credential lease. Worker исполняет тот же parsed handler; второго credential
store, raw SDK entrypoint или изменения sending policy нет. SMTP-only блокируется
до native worker/Keychain/DPAPI и повторно самим handler.

Checkpoint привязан к native IMAP host/port/login, storage account, company/member
binding и фактически выбранной папке. Он содержит scope SHA-256, UIDVALIDITY и
последний проверенный UID. Это обычные read parameters, не криптографическая
подпись или capability: настоящую позицию хранит private host journal, принимает
только результат штатного provider и коммитит её с событиями. Модель/входящее письмо
не меняют этот журнал. Пароль не участвует в digest. Account display name,
комментарий, подпись и темы писем не являются scope/authority.

Первый вызов возвращает `baselineOnly=true`, `lastUid=UIDNEXT-1`. Это точка начала,
не доказательство обработанной истории/unread очереди. Initial backfill, source
lease и включение фонового цикла остаются самостоятельными host gates. Следующая
страница читает EXAMINE metadata и конечный UID SEARCH range до 10 000 slots,
без UNSEEN, `n:*`, FETCH body/headers, writable SELECT, STORE, EXPUNGE или SMTP.
До 100 refs/page; при превышении позиция только на последнем возвращённом UID.
Если всё поместилось, можно продвинуться до конца проверенного диапазона.

UIDVALIDITY/UIDNEXT проверяются повторным readonly EXAMINE до выдачи результата.
Изменившаяся UIDVALIDITY не обнуляет cursor, а даёт typed review/backfill failure.
Противоречивые счётчики, чужие/повторные UID, невалидные и oversized ответы не
превращаются в пустую страницу. Raw server/native exceptions не отражаются.
Ошибка cleanup не создаёт успешную страницу. Новые UID после первого EXAMINE
остаются за пределом прочитанной позиции. Отсутствует обещание atomic snapshot.

Событие содержит immutable UID/UIDVALIDITY, ID и digest; без папки, адресов, тем,
body, паролей либо результатов SMTP. Source binding выбирает папку вне SQLite
содержимого. Poll не отмечает письмо прочитанным и не создаёт задач. Flags,
EXPUNGE и перезапись тела сервером при прежнем UID не заявлены как поддержанные
события. После source claim точное содержимое читается в отдельном разрешённом
контексте с проверкой аудитории. Read refs не разрешают disclosure/owner command.

`test_assistant_monitor.py` использует настоящий stdlib IMAP encoder/parser
и синтетический socket stream: EXAMINE/UID SEARCH wire, sparse/partial pages,
concurrent arrivals, replay, UIDVALIDITY/scope changes, malformed/foreign UID,
private error canaries, SMTP-only admission и отсутствие native unlock на
синтаксически неверном cursor. Реальных accounts, credentials и сети нет.
Обычные/native Windows/macOS gates остаются обязательными до публикации;
source merge не устанавливает монитор и не меняет подключённые ящики.

Нормативные границы: [UID/UIDNEXT/UIDVALIDITY](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1),
[EXAMINE](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.3.3).
