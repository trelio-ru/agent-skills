1. Один раз перед первой командой сессии вызови
   `get_agent_skill` и используй актуальные `releaseId`, инструкцию и exact
   `runtimeExecution.command` из ответа. Успешный ответ покрывает связанную
   непрерывную последовательность, пока не меняются exact company/project
   context, skill, implementation и intent. Переиспользуй exact command для
   следующих связанных ходов сессии; не повторяй `get_agent_skill` перед каждой
   подкомандой или после обычного `bootstrap`, `doctor` либо `probe`. Host управляет допуском до 12 часов без продления при чтении.
2. Добавляй аргументы почтового CLI после завершающего `--` в
   `runtimeExecution.command`. Не запускай исходник напрямую и не составляй
   UUID релиза вручную.
3. Переиспользуй полный текст до 12 часов. Перечитай skill при новой сессии,
   утрате полного текста или compaction, через 12 часов, после смены exact
   route/context, после снятия ранее возвращённого setup/access blocker либо
   один раз при `AGENT_SKILL_RELEASE_CHANGED`; затем используй новый exact
   command.
4. Для первичной локальной настройки используй `configure`. По умолчанию
   runtime открывает защищённую одноразовую страницу на `127.0.0.1` в системном
   браузере: адрес, логин, серверы, подпись и пароль вводятся в одной форме,
   без запросов в терминале. Неверные поля исправляются на той же странице.
   Никогда не проси пароль в чате, prompt, аргументах, environment, workspace
   или Git. `configure --terminal-prompts` допустим только по просьбе
   пользователя в видимом локальном TTY.
   До подтверждённого результата не утверждай, что форма открылась или ящик
   подключён. Ошибка открытия/загрузки/ожидания не означает потерю доступа;
   не заменяй браузерный ввод скрытым терминалом. После `configured` проверь
   соединение через `doctor`: сохранение параметров само не доказывает вход.
   Для отправителя без входящего хранилища используй `configure --smtp-only`
   и режим «Только отправка (SMTP)» в форме. IMAP-поля не требуются. Режим
   сохраняется только после полного защищённого submit и не выбирается
   автоматически из-за ошибки IMAP. Обычное переподключение сохраняет режим.
   Для SMTP-only `doctor` возвращает `imap=null`, `imapStatus=disabled` и
   проверяет SMTP без чтения папок. Это не доказывает доставку письма.
5. Не утверждай, что `autocomplete=off` запрещает password manager. Локальная
   страница честно предупреждает, что браузер может предложить сохранить
   пароль, и просит выбрать «Нет, спасибо», потому что runtime хранит
   настроенное подключение отдельно на устройстве.
6. Форма показывает ссылки и подсказки по адресу или известному серверу.
   Gmail: двухэтапная аутентификация и 16-символьный пароль приложения;
   Mail.ru: привязанный телефон и пароль внешнего приложения с доступом к Почте;
   Яндекс: разрешённые IMAP/пароли приложений и пароль типа «Почта».
   Не переноси требование Google о двухэтапной аутентификации на другие сервисы.
7. Пароли сохраняются через Keychain на macOS и DPAPI CurrentUser на Windows.
   Безопасный прежний Keychain переиспользуется без новой настройки. При
   `legacy_email_credential_requires_explicit_configure` объясни необходимость
   явной перенастройки: не читай старый password-файл и не переноси его в env.
   `previousConfigPath` указывает сохранённую прежнюю конфигурацию; старый
   password-файл автоматически не удаляется. После успешного `doctor` его
   удаление остаётся отдельным действием пользователя.
8. Рабочая команда ограничена независимым сроком до 30 минут, включая настройку
   и сон. `native_email_session_ended` не доказывает, что отправка не произошла:
   сначала проверь фактический результат, не повторяй письмо автоматически.
   Ошибка native helper/OS store не разрешает plaintext fallback или сброс Keychain.

## Безопасный порядок работы

## Настройка SMTP-only из существующего Agent Secret

Если пользователь поручил подключить этот ящик и уже выбрал подходящий
Agent Secret, используй его без повторного ручного ввода. Нужен существующий
активный Run той же задачи/области; не создавай фиктивный Run ради входа.
Без такого Run остаётся обычная защищённая форма. Перед checkout прочитай
свежие metadata exact секрета и проверь canCheckout, scope и поле password.
Разрешение хранения в локальном почтовом клиенте следует из поручения подключить
его; сам факт доступности секрета не разрешает другое назначение или отправку.

1. Возьми текущие company/project/skill/release/runtimeSessionId из exact
   `runtimeExecution.localAction`; выбери уже созданный bound account UUID.
   Проверь несекретные email, username, SMTP host/port/security по поручению
   и источнику подключения. Не угадывай endpoint и не читай password value.
2. Вызови `prepare_agent_secret_checkout`: exact runId/secretId,
   `deliveryMode=file`, `fieldKeys=[password]`, `executable=trelio-workspace`.
   Исполни только его возвращённый `bridge.action` в exact открытом workspace.
   Не меняй grant/executable и не копируй временный файл.
3. В `parameters.arguments` этого action добавь child arguments
   `skill run --company COMPANY --project PROJECT --skill email-imap-smtp
   --release RELEASE --runtime-session SESSION -- configure --smtp-only
   --from-agent-secret --email EMAIL --username USERNAME --smtp-host HOST
   --smtp-port PORT --smtp-security starttls --local-account ACCOUNT_UUID`.
   Для TLS передай `--smtp-security ssl`; необязательное имя – `--display-name`.
   COMPANY/PROJECT/RELEASE/SESSION берутся только из текущего localAction;
   optional project опускается целиком, если отсутствует. Secret-exec сам
   передаёт значение exact подписанному runtime с обычными admission/ACL;
   reserved executable не ищется в PATH. Не запускай Python/source/cache напрямую.
4. Bridge создаёт owner-only временный файл и передаёт только ссылку. Native
   guardian доставляет value-free reference owned worker-у; тот после permit
   проверяет file/parent ownership и permissions, размер/UTF-8, и сохраняет пароль
   обычным Keychain/DPAPI writer. Значение не идёт в argv, ambient env, stdout,
   Workspace или guardian protocol. Bridge удаляет свой временный файл после
   исхода. Не подменяй этот маршрут ad hoc producer/script/file.
5. `passwordInput=agent_secret_file` и `configured` подтверждают сохранение.
   Затем выполни обычный exact signed `doctor --local-account UUID`: для
   SMTP-only ожидаются smtp=true, imap=null, imapStatus=disabled. Это не отправка
   тестового письма. Grant и локальный credential не разрешают отправку.

`agent_secret_setup_file_required/invalid` означают конкретный отказ защищённого
ввода. Не печатай/читай файл для диагностики, не ослабляй ACL и не повторяй
consume вслепую. При неизвестном сохранении сначала doctor exact аккаунта.
Новая попытка после доказанного отсутствия подключения получает новый grant.
Не используй TRELIO_SECRET_FILE как обычный пользовательский env workaround: он
принимается только в explicit --from-agent-secret и исключается из окружения
compiler/guardian/worker; password отсутствует в environment в обоих режимах.
