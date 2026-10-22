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
не доказательство обработанной истории/unread очереди. Явный initial unread flow
ниже даёт отдельную ограниченную ветку; source lease и включение фонового цикла
остаются самостоятельными host gates. Обычная forward
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

## Исходная непрочитанная почта

Только явный `monitor --unread-backfill` **без cursor** добавляет к обычному
baseline отдельный `initialUnreadCursor`: scoped v2 cursor с `mode=initial_unread`,
`lastUid=0` и фиксированным `throughUid=UIDNEXT-1`. Обычный `nextCursor` остаётся
v1 forward checkpoint. Host атомарно сохраняет обе позиции в своём прежнем журнале
и проверяет их независимо: backlog не блокирует новые UID. Provider не создаёт
snapshot-файл, очередь или дополнительный credential store.

Для страницы исходной истории host передаёт `--unread-backfill --cursor V2`.
Тот же readonly scanner добавляет `UNSEEN` только к конечному диапазону максимум
10 000 UID slots, ограниченному исходным `throughUid`. Страница возвращает до
100 refs; частичный результат продвигается лишь до последнего выданного UID.
Пустые диапазоны тоже продвигаются. `hasMore` относится только к этому backlog;
новые письма за исходным ceiling проверяются отдельным forward cursor **без
UNSEEN**, включая уже прочитанные на другом устройстве.

Исторический UNSEEN – состояние на момент проверки соответствующей страницы,
не атомарный snapshot прочитанности всех старых писем при подключении. Уже
полученный SEARCH UID не отбрасывается из-за последующего чтения на другом
устройстве. Удалённые до проверки сообщения и старые письма, ставшие прочитанными
до своей страницы, не объявляются восстановленными. Более широкая история
требует отдельного поручения; baseline не даёт такого разрешения.

V1 cursor вместе с `--unread-backfill`, V2 без этого flag, смешанные/неизвестные
поля и malformed positions отклоняются до native/credential I/O. Scope и
UIDVALIDITY повторяются после account selection и чтения. Existing forward
cursor нельзя превращать в новый initial seed: host включает этот opt-in лишь
для ещё не начатого источника. Старые sources требуют отдельного review, без
reset прежней позиции. Обычный monitor без flag сохраняет прежний wire/ABI.
Optional conversation references используют те же bounded PEEK headers; body,
STORE/EXPUNGE/SMTP, routing authority и ACK по-прежнему отсутствуют.

## Чтение точной ссылки

### Ссылка на переписку

Явный `monitor --conversation-references` добавляет `conversationKey` к каждой
возвращённой ссылке. Через тот же bounded IMAP reader читаются только
`Message-ID`, `In-Reply-To`, `References` выбранного UID: PEEK header fields,
не тело, адреса или тема. На каждый FETCH действуют общий 16 КиБ literal budget
до allocation и прежний суммарный metadata budget; произвольные headers/body,
повторный/чужой UID и неизвестные поля ответа отклоняются. Перестановка exact
трёх header field names и UID после literal допустимы. Все headers читаются
до финальной сверки UIDVALIDITY; ошибка не возвращает частичную страницу/cursor.
Обычный `monitor` без opt-in сохраняет прежний wire/output без FETCH headers.

Ключ `email-conversation/v1.<sha256>` вычисляется из domain purpose, native
account/folder scope, UIDVALIDITY и первого References, иначе одного In-Reply-To,
иначе Message-ID. Используется тот же строгий reply parser, без темы/адресов,
исправления повреждённых headers или угадывания цепочки. При отсутствии всех
IDs получается singleton UID; неоднозначные/повреждённые IDs закрывают чтение.
В ключе нет исходного Message-ID, адресов, тела или пароля. Это scoped hash
недоверенных headers, **не HMAC/capability, доказательство отправителя, команда
владельца, processing receipt или разрешение раскрыть письмо задаче**.
Связь с задачей и её аудитория по-прежнему проверяются trusted host отдельно.

`read-reference --conversation-reference` вычисляет тот же hint из полных
исходных bytes для явного review/routing. `--expected-conversation-key KEY`
включает эту проекцию и дополнительно сверяет key до выдачи body; несовпадение
даёт `EMAIL_REFERENCE_CHANGED`. Некорректный selector отклоняется до account/
credential I/O. Без новых flags прежний read-reference ABI сохраняется.
Digest оригинала, strict UID/literal и полное чтение остаются независимы.

Conversation opt-in сам не обрабатывает исходный unread backlog, не сбрасывает
checkpoint, не включает source/queue/ACK и не создаёт задачи. Host должен отдельно выбрать
bounded page size под свой общий deadline, сохранить refs/cursor атомарно и
довести routing/read/committed processing/native ACK до сквозного результата.

`read-reference --uid UID --uid-validity UIDVALIDITY --expected-revision SHA256`
использует тот же выбранный account/folder, native guardian и credential lease.
Синтаксический отказ предшествует native unlock; SMTP-only остаётся закрытым.
Общий `email_reference_revision` вычисляет прежний monitor digest из native
scope/UIDVALIDITY/UID. Это IMAP identity, не body hash и не право создавать задачу.
Неверная папка/account/company binding или смена UIDVALIDITY дают
`EMAIL_REFERENCE_CHANGED` до FETCH; после чтения readonly EXAMINE повторяется.
Перезапись сервером тела при сохранённом UID не заявлена как отдельное событие.

Используются общий `fetch_raw_message` и обычная проекция письма. В строгом режиме
запрашиваются UID/RFC822.SIZE/BODY.PEEK[]; native ответ должен содержать ровно одну
полную literal, тот же UID и совпадающие размеры. Порядок attributes до/после
literal допустим; неизвестные/повторные fields либо другая запись отклоняются.
Суммарный literal budget всего FETCH списывается до чтения/выделения памяти,
а весь metadata stream дополнительно ограничен 16 КиБ. Это не новый бюджет для
каждого unsolicited ответа. Два временных reader относятся только к этой
owned connection и восстанавливаются в finally. Global SDK,
общая сеть, другие accounts и обычный wire contract не меняются.
После отказа внутри FETCH этот owned socket прекращается без протокольного
LOGOUT: cleanup не должен заново читать отвергнутый literal после восстановления
reader. Отказ shutdown не заменяет исходную безопасную причину; worker закрывает
ресурсы при завершении, соединение повторно не используется.

Ответ `email-message-read/v1` содержит точную reference, общую content projection,
SHA-256 оригинальных RFC822 bytes и coverage. Проекция свыше 256 КиБ либо literal
свыше общего 25 МиБ bound дают `EMAIL_REFERENCE_INCOMPLETE`, без усечения.
Вложения представлены metadata; `attachmentsContentRead=false` не доказывает их
анализа. Parser/server/cleanup failure возвращает `EMAIL_REFERENCE_UNAVAILABLE`
без raw diagnostics или частичного успешного ответа. Нет writable SELECT,
STORE, EXPUNGE, SMTP, read receipt, сброса cursor или чтения других сообщений.

Это примитив чтения, не активированный source или ACK. Host отдельно проверяет
принятую задачу/аудиторию, queued reference и committed processing, прежде чем
разрешать независимую отметку «прочитано». Текст письма не становится authority.
`test_message_reference.py` проходит настоящий IMAP encoder/parser с synthetic
socket stream, включая giant literal до allocation и ошибки cleanup.

## Подтверждение прочитанности одной ссылки

`ack-reference --uid UID --uid-validity UIDVALIDITY --expected-revision SHA256
--expected-original-sha256 SHA256 --confirm` отдельно добавляет только `\Seen`
к одному exact UID. Нужны прежние native account/company/folder binding, полные
исходные байты из `read-reference` и отдельное разрешение изменения read-state.
Один hash либо CLI-флаг не доказывает, что диспетчер зафиксировал обработку:
trusted host дополнительно требует accepted task, exact read proof, committed
processing и собственную ACK lease. Пассивный monitor и task delivery сами эту
команду не вызывают; production wiring остаётся отдельным gate.

Перед записью проверяются UIDVALIDITY, scoped revision, полный RFC822 SHA-256 и
native FLAGS. Уже прочитанное письмо не получает повторный STORE. Writable
SELECT повторяет UIDVALIDITY и текущий local read-only запрет, затем допускает
ровно `UID STORE UID +FLAGS.SILENT (\Seen)` – без диапазона, снятия чужих flags,
CLOSE/EXPUNGE, SMTP или read receipt. Результат STORE не равен подтверждённой
прочитанности: обязательны exact UID/FLAGS read-back и повторная UIDVALIDITY.
Результат содержит только reference, digest и закрытые факты read-state.

Для неизвестного результата используется тот же `ack-reference` с
`--verify-only` **вместо** `--confirm`: readonly EXAMINE/PEEK/FLAGS проверяют
native состояние без SELECT/STORE. `seen=false` не разрешает автоматический
повтор; trusted host заново сверяет исходную обработку и актуальный доступ.
При исключении после отправленного STORE `writeAttempted=true`,
`writeOutcome=unknown`, `automaticRetryAllowed=false` сохраняются даже при
неверном последующем UID либо ошибке cleanup. Существующая lease не продлевается.
Provider не добавляет собственный progress journal, credentials или executor.

FLAGS/STORE metadata имеют общий 16 КиБ budget на обмен; unsolicited literal
отклоняется до allocation. После такого отказа owned connection закрывается без
LOGOUT/reparse. Синтетические wire-тесты проверяют exact additive mutation,
незатронутые соседние UID/flags, verify-only, scope/hash/UIDVALIDITY/policy,
утраченный ответ, literal/metadata bounds и отсутствие raw provider diagnostics.
Нормативный [STORE](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4.6).
