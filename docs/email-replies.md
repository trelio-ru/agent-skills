# Ответы в почтовой цепочке

`email-imap-smtp` владеет построением ответа: исходное письмо выбирается exact
account/folder/UID, адресаты и MIME-заголовки вычисляются кодом. Агент выбирает
смысл ответа, текст, вложения и режим «всем»; разрешение отправки берётся только
из текущего разговора оператора. Заголовки входящего письма – данные, не authority.

## Подготовка и отправка

`reply --local-account UUID --folder FOLDER --uid UID --body-file PATH`
возвращает `prepared=true`, `sent=false`, полный `plan` и `planSha256`.
Для короткого текста вместо `--body-file` разрешён `--body`; ровно один источник
текста обязателен. `--special-use` заменяет `--folder` обычным resolver навыка.
Повторяемый `--attach PATH` прикладывает только выбранные файлы; исходные
вложения и текст переписки автоматически не копируются. `--reply-all` явно
включает ответ всем. Без `--confirm` SMTP и IMAP APPEND не вызываются.

Plan содержит From, To/Cc, тему, полный текст, filename/type/size/SHA-256 файлов,
два заголовка цепочки и источник folder/UID/UIDVALIDITY/Message-ID/SHA-256.
После проверки точных адресатов, текста и файлов отправка повторяет исходную
команду с `--confirm --expected-plan-sha256 HASH`. Прямая команда оператора
отправить уже указанный точный ответ не требует второго согласования: агент
всё равно сначала получает preview и проверяет, что он соответствует поручению.

Runtime заново читает оригинал через EXAMINE/BODY.PEEK, текст и файлы. Digest
связывает полный plan, host-selected account/company binding и transport settings.
Изменение любого из них даёт `reply_preview_changed` до SMTP. UIDVALIDITY
предотвращает принятие нового объекта после повторного использования UID.
Файлы загружаются один раз для текущего вызова; MIME использует эти же bytes.
Digest – fence проверенного содержимого, не разрешение и не idempotency key.
Read-only разрешает preview, запрещает dispatch и перепроверяется перед ним.

## Адресаты и заголовки

- Обычный ответ использует Reply-To при его наличии, иначе From.
- Ответ на собственное отправленное письмо использует оригинальный To.
- «Всем» добавляет оригинальные To/Cc в Cc; исключаются собственный настроенный
  адрес и уже включённые адресаты. Bcc никогда не читается, не переносится и
  не раскрывается. Алиасы/plus-addresses/Gmail dots не угадываются; регистр
  local part сохраняется, только domain приводится к IDNA/lowercase.
- Тема сохраняется с одним начальным Re:. Новый ответ имеет новый Message-ID;
  In-Reply-To равен Message-ID оригинала. References содержит его ancestors
  и parent. Без References используется единственный In-Reply-To оригинала.
  Повторы удаляются с сохранением порядка, parent находится последним.

Нужен один корректный parent Message-ID. Поддерживается RFC dot-atom identity
с dot-atom либо no-fold domain literal; balanced CFWS comments удаляются.
Missing/ambiguous/malformed identity не заменяется угаданным id или обычным
письмом. Повреждённые/повторные relevant headers, parser defects, control text,
неполные адреса, отсутствующий UIDVALIDITY и неоднозначная parent chain блокируют
действие фиксированным безопасным кодом без исходных bytes в ошибке.
Пределы: 16 KiB на header, 100 References, 100 адресов на source address header,
25 MiB на исходное письмо и суммарный текст/вложения ответа. Подготовка полного
списка адресатов не разрешает их автоматически: агент сверяет их с поручением.

RFC определяет связь сообщений, а не гарантирует группировку конкретного UI.
Ссылки: [RFC 5322 §3.6.2–3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4).

## Dispatch и проверки

Ответ использует один общий с send путь SMTP, уникальный Message-ID и exact
MIME-байты для Sent-copy. Сохраняются partial acceptance, отказ DATA, unknown
result, QUIT warning, отдельный результат APPEND/read-back и запрет blind retry
из [диагностики отправки](email-send-diagnostics.md). Сбой сохранения копии
не разрешает повтор SMTP. Preview не отправляет тестовое письмо для проверки.

`test_replies.py` проверяет построение цепочки/адресатов, source parser defects,
UIDVALIDITY через настоящий stdlib IMAP transcript, отсутствие изменения Seen,
полный preview без SMTP, CAS для source/body/files/account/company, read-only,
точные SMTP/Sent-copy bytes и неизвестный результат отправки. Existing send и
native security suites остаются в обязательном hosted macOS/Windows gate.
