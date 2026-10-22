## Приватный email-код для браузерного навыка

Общий host `trelio.protected-browser-mail-auth/v1` связывает уже разрешённый
browser-вход с явно выбранным bound IMAP-аккаунтом того же пользователя и
компании. Механизм универсален: URL, формы и matcher письма определяет signed
browser provider. Почтовый навык не принимает селекторы, код или пароль через CLI.

После value-free handle от браузерного навыка используй exact localAction:
`authentication-browser --request HANDLE --local-account UUID`.
Пользователь выбирает ящик; не перебирай другие аккаунты и не подменяй его
почтой из account comment. SMTP-only непригоден. Нужен опубликованный host с
`TRELIO_BROWSER_MAIL_MODULE_URL`; checkout исходников не заменяет runtime.

Host сначала удерживает browser input. Почтовый runtime приватно получает
matcher, читает readonly UID baseline и передаёт его обратно. Только после
этого браузер может запросить код. Извлечение использует BODY.PEEK новых UID
с точными sender/recipient, INTERNALDATE, UIDVALIDITY, literal anchors и
единственным кодом. Старое, чужое или неоднозначное письмо не подходит.
OTP/письмо/matcher идут только private pipe внутри runtime, без MCP, argv,
environment, Workspace, лога или собственного vault. Публичный ответ — статусы.

Если пользователь разрешил делать использованное письмо прочитанным, добавь
`--mark-read-after-success`. Browser сначала подтверждает положительный
признак входа; только потом host выдаёт однократный ACK exact UID/UIDVALIDITY/
SHA-256. Runtime добавляет только Seen и перечитывает FLAGS, остальные письма
и flags сохраняются. Уже прочитанное письмо — no-op. Local read-only policy
сохраняет запрет; её не меняй. Извлечение или submit сами по себе не дают ACK.
Ошибка пометки не отменяет состоявшийся вход: оцени authenticated отдельно.

После неизвестного ответа используй тот же handle и аккаунт с `--verify-only`.
Команда наблюдает прежний результат; для pending/unknown ACK допускается только
сверка FLAGS, без нового STORE или кода. Отсутствие/ошибка read-back не дают
разрешения повторить вход, resend или пометку. Исходный deadline не продлевается.
Каждое ожидание письма ограничено 30 секундами; отсутствие письма — отдельный
статус, а не отказ пароля. Потеря browser worker/lease не запускает новый вход.

Для отдельно порученной разработки provider есть readonly
`authentication-profile --brand BRAND --local-account UUID`: bounded поиск
в последних 500 UID slots возвращает только точный sender, проверенные literal
anchors и длину кода. Тема, тело, OTP и auth URL не выводятся, flags не меняются.
Результат — evidence для matcher, а не право на вход или широкое чтение почты.
Проверяются последние 20 совпадений. candidateLimitReached/sampleComplete
показывают границы выборки, oversizedSkipped — пропущенные без BODY письма
свыше 256 КиБ. Неполная выборка не доказывает отсутствие шаблона; при доставке
OTP sampling не применяется и неоднозначность по-прежнему блокирует ввод.
`EMAIL_BROWSER_AUTH_PROFILE_<STAGE>_UNAVAILABLE` сообщает только фиксированный
этап отказа. Он не доказывает отсутствие письма или потерю подключения; не
перенастраивай ящик и не используй ordinary read для обхода этой диагностики.
Не используй обычные search/read/save-message ради получения OTP через модель.
