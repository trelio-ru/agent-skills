# Т‑Банк 2.3.1

## Что добавлено

Runtime 1.3.1 принимает bounded название текущего разговора для новых
`start`, `authorize`, `configure` и `forget`. На macOS системный Touch ID/пароль
prompt, а на Windows CredUI показывают, какой чат запросил защищённую сессию
Т‑Банка. Если клиент не передал название, остаётся прежний общий текст.

Название служит только пояснением и не даёт полномочий. Runtime принимает его
только из caller context, отклоняет пустые, управляющие/bidi и слишком длинные
значения, не сохраняет в vault, lease, status или Keychain metadata и передаёт
native helper-у через bounded stdin, а не argv/env. Delegated T‑ID получает то
же название через `createTIdAuthorization(..., { requestTitle })` и возвращает
готовые verified `authorize` arguments.

## Совместимая миграция Keychain

Старый guardian/v1 helper остаётся побайтно совместимым с опубликованным runtime
1.2.7. Новый отдельно замороженный key-only helper использует v2 Keychain
service. При наличии прежнего vault старый доверенный helper один раз читает v1
key после обычного Touch ID и передаёт его новому через private stdin;
изменённый бинарник никогда не читает v1 item, поэтому запрос пароля login
Keychain не появляется. Все последующие запуски используют v2 с названием
разговора. V1 остаётся для rollback и удаляется вместе с v2 только явным
`forget`.

Ciphertext, browser snapshot, credentials и env не меняются. Повторный setup и
DB migration не нужны. Windows продолжает использовать тот же DPAPI record и
передаёт название разговора CredUI через stdin. Minimum host остаётся 1.6.17.
Версия skill – 2.3.1, runtime – 1.3.1.

## Проверка после публикации

На macOS и Windows обязательны deterministic package check и полный T‑Bank
security gate exact source SHA. Первый migration unlock на macOS не должен
открывать password dialog Keychain, следующий `start` должен показать exact
название тестового чата. Windows показывает его сразу в CredUI. Title не
сохраняется в runtime state.

## Rollback

Остановить незавершённую сессию и выпустить новый immutable runtime. Не
переносить tag, не стирать encrypted vault и не повторять login/TOTP submit
после неизвестного результата.
