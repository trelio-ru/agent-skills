# Подпись почтового ящика

`email-imap-smtp` хранит необязательную подпись отдельно для каждого настроенного
ящика. Настройка относится к его локальному provider account, сохраняется при
переименовании общего аккаунта, смене company binding и переподключении.
Она не синхронизируется между устройствами и не задаёт общее правило компании.
Все компании, в которых пользователь включил один и тот же ящик на этом
устройстве, используют его одну подпись.

## Настройка и хранение

В browser `configure` есть многострочное поле «Подпись в конце письма».
Существующий текст показан в поле; пустое отправленное поле очищает настройку.
Если старый caller не передал новое поле, прежняя подпись сохраняется.
Opt-in terminal configure также сохраняет её без нового обязательного prompt.

Без повторного входа, обращения к паролю или внешнему API доступны команды:

```text
signature show --local-account UUID
signature set --local-account UUID --text 'С уважением, Имя'
signature set --local-account UUID --text-file PATH
signature clear --local-account UUID
```

Set принимает ровно один источник текста. Show/set/clear возвращают `signature`
и `signatureSha256`, при host route – выбранный account UUID. Неизвестный или
чужой выбранному host аккаунт не создаётся и не изменяется.

Подпись – ordinary outgoing plain text до 16384 байт UTF-8 после нормализации
CRLF/CR в LF и удаления внешнего whitespace. Нулевые/управляющие символы кроме
LF/tab, DEL, invalid UTF-8 и превышение лимита отклоняются без цитирования текста.
Файл читается bounded; HTML остаётся буквальным текстом и экранируется в форме.

Storage – additive `signature` в существующем локальном `accounts.toml` с теми же
private permissions, что у metadata ящика; это не encrypted credential store.
Не хранить здесь секреты или закрытый company context. Поле отсутствовало у
старых ящиков: read даёт пустой текст без записи, обычный следующий write
сохраняет его. Rewrite сохраняет подписи остальных ящиков; credentials, адрес,
имя отправителя, общий account comment и sending policy не меняются.

## Подготовка и отправка

Один helper добавляет подпись в конце новых писем и ответов после пустой строки.
Пустая подпись сохраняет body без изменений; пустой body с подписью содержит
только подпись. Уже присутствующий полный exact последний абзац не дублируется,
включая исходный CRLF. Совпадение внутри prose/истории не заменяет последний блок.
Агент не добавляет подпись повторно. `--no-signature` явно отключает добавление
для одного send/reply и не удаляет предоставленный пользователем текст.

Перед обычным send агент читает `signature show`, проверяет полный текст с
подписью и передаёт `--expected-signature-sha256 HASH`. При непустой effective
подписи hash обязателен; missing даёт `signature_review_required`, mismatch –
`signature_changed`, invalid hash – `invalid_signature_sha256`, до SMTP.
Передавать hash полезно и для пустой настройки: её появление до отправки также
становится явным конфликтом. `--no-signature` не требует hash для unused default.

Reply включает итоговый body, effective signature hash и opt-out в полный
`planSha256`. Смена/очистка подписи или смена opt-out после preview блокирует
SMTP через `reply_preview_changed`. MIME и Sent-copy используют один уже
проверенный body; на нижнем send path подпись повторно не добавляется.

Настройка и hash не предоставляют разрешение отправки. Сохраняются exact
согласование полного письма в текущем разговоре, `--confirm`, `read-only`,
отдельный результат SMTP/Sent-copy и запрет blind retry неизвестного результата.

## Проверки

`test_signatures.py` проверяет реальный временный TOML, upgrade default,
независимость ящиков, reconnect, неизменность credentials/policy, Unicode/limits,
host-selected route без native credential session, browser escaping/clear,
полный SMTP body и exact Sent-copy bytes, missing/stale hash и per-letter opt-out.
`test_replies.py` проверяет подпись в preview/MIME и конфликт перед dispatch.
Обязательный hosted email gate выполняет весь suite на macOS и Windows.
