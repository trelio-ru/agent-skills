# Platform-навык `1c-edo`

## Контур первой версии

`1c-edo` – универсальный platform Agent Skill для безопасного чтения
электронных документов 1С ЭДО. Код конкретного клиента публикуется
подписанным внутренним package, а общий package host остаётся в
`trelio-ru/agent-workspaces`.

Tagged release декларативно описывает company connection:

- базовый HTTPS URL OData;
- базовый HTTPS URL `/hs/files/`;
- лимиты строк, страниц, размера файла и таймаута;
- необязательную HTTPS-ссылку и текст для запроса личного доступа;
- общий `X-OData`, который сразу сохраняется как company-scoped Agent Secret
  binding `x_odata`.

Личный логин и пароль 1С сотрудник вводит только через локальный `connect`.
По умолчанию runtime открывает одноразовую tokenized-страницу на
`127.0.0.1` в браузере по умолчанию, требует exact loopback `Host`,
same-origin `Origin`, ограниченный form body и фактическую загрузку exact URL.
Форма и поля задают `autocomplete=off` только как best-effort hint; парольный
шаг прямо объясняет, что browser-копия не нужна, поскольку runtime отдельно
сохранит проверенное подключение на этом устройстве. Явный
`connect --terminal-prompts` допустим только в видимом TTY; автоматического
fallback в `osascript`, PowerShell или терминал нет. После ввода runtime
сначала проверяет credential фиксированным OData probe и только затем атомарно
сохраняет его вне Trelio и workspace:

```text
<trelio-config-home>/integrations/1c-edo/<company-id>/<member-id>/<connection-id>/
├── config/access.json
└── secrets/personal-basic-auth.json
```

На POSIX используются `0700/0600`, атомарная запись и запрет symlink; на
Windows – закрытый ACL текущего пользователя. Agent не читает эти файлы и
получает только нормализованный результат runtime-команд.

## Access state

Поддерживаются четыре локальных состояния:

- `unknown` – пользователь ещё не выбрал и не подключился;
- `no_access` – пользователь явно подтвердил отсутствие личного доступа;
- `connected` – credential проверен текущим endpoint;
- `needs_reconnect` – локальный credential отсутствует либо 1С вернула
  `401/403`.

State привязан к SHA-256 fingerprint всей нормализованной company connection.
При изменении endpoint или лимитов прежнее состояние становится `unknown`, а
старый credential не используется. Сеть/timeout не меняют state. `401/403` и
неверный пароль дают `needs_reconnect`, но никогда автоматически не создают
`no_access`. Последнее записывает только
`access-status set no-access --confirmed`.

## Разрешённый read-only протокол

Runtime допускает только `GET/HEAD`, запрещает redirect, повторно проверяет
HTTPS/DNS и строит URL из фиксированного allowlist:

- `Catalog_ОбъектыСтроительства`;
- `Catalog_НаправленияДеятельности`;
- `Catalog_ПодразделенияОрганизаций`;
- `Catalog_СтруктураПредприятия`;
- `Catalog_Контрагенты`;
- `Catalog_ДоговорыКонтрагентов`;
- `Document_ЭлектронныйДокументВходящийЭДО`;
- `Document_ЭлектронныйДокументИсходящийЭДО`;
- `Catalog_КэшВизуализацииДокументовЭДОПрисоединенныеФайлы`;
- `Document_СообщениеЭДО`;
- `Catalog_СообщениеЭДОПрисоединенныеФайлы`;
- файловые metadata
  `КэшВизуализацииДокументовЭДОПрисоединенныеФайлы` и
  `СообщениеЭДОПрисоединенныеФайлы`.

Новая схема получает файлы фильтром составного владельца:

```text
ВладелецФайла eq cast(guid'<document-id>', 'Document_<incoming|outgoing>')
```

Старая схема сначала получает `Document_СообщениеЭДО`:

```text
ЭлектронныйДокумент eq cast(guid'<document-id>', 'Document_<incoming|outgoing>')
```

Затем файлы каждого сообщения:

```text
ВладелецФайла_Key eq guid'<message Ref_Key>'
```

Пробелы OData query всегда кодируются как `%20`, не `+`. Произвольные entity,
filter, URL и HTTP method не принимаются аргументами. Скачивание пишет
same-directory temporary file, проверяет company size limit, вызывает
`fsync`, атомарно заменяет destination и возвращает SHA-256.

`search-documents --query TEXT` не сканирует только первые страницы карточек.
Runtime выполняет фиксированный bounded-поиск по `Description` известных
бизнес-справочников, по подтверждённым текстовым полям договоров, затем
следует только связям `Catalog_СтруктураПредприятия` →
`Подразделение_Key` или `НаправлениеДеятельности_Key` и фильтрует обе
document entity по `ДоговорКонтрагента`. `Catalog_ПодразделенияОрганизаций`
тоже участвует в поиске бизнес-объектов, но его UUID нельзя подставлять вместо
отдельного UUID `Catalog_СтруктураПредприятия`. Каталог договоров сортируется
по фактически опубликованному полю `Дата`; системное поле документов `Date`
для него не используется. Параллельно сохраняется фиксированный прямой поиск
по `Number`, `Комментарий` и `НомерДокумента`. Опция `--exact` заменяет
substring на равенство, поэтому короткий номер `16143` не совпадает с
`17-01161437452`.

Structured-фильтры `search-documents` применяются прямо на document entity:

- парный `--received-from/--received-to` – системный `Date` получения или
  отправки;
- парный `--document-date-from/--document-date-to` – `ДатаДокумента`;
- `--counterparty-id` либо `--counterparty-name`;
- `--contract-id` либо exact `--contract-number`;
- `--organization-id`;
- exact `--document-number`.

Обе даты пары обязательны, границы включительны, период ограничен 93 днями.
Имя контрагента сначала разрешается через фиксированные
`Description`/`НаименованиеПолное` каталога `Catalog_Контрагенты`, после чего
в document filter попадают только нормализованные UUID. Нулевой результат
разрешения не превращается в широкий поиск. Апостроф внутри текста удваивается
по правилу OData string literal; управляющие символы и строки длиннее 256
символов отклоняются.

`search-files --filename TEXT` выполняет отдельный bounded-поиск по
`Description` обоих каталогов вложений. В новой схеме document UUID и
направление берутся из проверенной composite-ссылки `ВладелецФайла`; в старой
схеме `ВладелецФайла_Key` сначала разрешается небольшими exact batch-запросами
к `Document_СообщениеЭДО`, и только затем к composite-ссылке
`ЭлектронныйДокумент`. После этого runtime читает только найденные document
UUID и применяет к ним те же date/counterparty/contract/organization/number
фильтры. Результат содержит file id, document id/card и для old-chain
`messageId`; недоверенные owner-поля наружу не выходят.

При HTTP/network ошибке runtime возвращает безопасные
`error.details.stage` и, если ответ получен, `error.details.httpStatus`.
`stage` выбирается только из фиксированного enum подписанного runtime. URL,
OData filter/query, response body, headers, `X-OData` и личные credentials в
ошибку не попадают.

Каждый этап имеет отдельный жёсткий cap: не больше 5 совпадений на один
бизнес-справочник, 20 бизнес-объектов, 20 контрагентов, 20 договоров,
50 документов на договор и направление, 200 документов на document search,
100 файлов на одну схему и 100 документов на file search. Более строгие
company `maxRows/maxPages` сохраняют приоритет. Серверный ответ всё равно
обрезается локально, если 1С игнорирует `$top`; записи дедуплицируются по
нормализованному UUID и наружу выходят только фиксированные scalar-поля из
`$select`.

Оба поиска возвращают `coverage`: `truncated`, `hasMore`, `newest`, `oldest`,
`truncationCause` и `truncationStages`. `hasMore=true` означает, что сервер
фактически вернул строк больше `$top`; `hasMore=null` – bounded window заполнен,
но без небезопасного дополнительного запроса нельзя доказать наличие следующей
строки. Поэтому агент больше не должен описывать пустой результат как полный,
если `coverage.truncated=true`.

## Нормализованная подпись и доступность статуса

Каждый документ в `search-documents` и `get-document` содержит:

```json
{
  "signature": {
    "isSigned": true,
    "signedAt": "2026-07-23T15:04:00",
    "basis": "document_signing_date"
  },
  "edoStatus": "Подписан",
  "statusAvailability": {
    "available": true,
    "basis": "information_register_status",
    "source": "InformationRegister_СостоянияДокументовЭДО",
    "coverage": "primary",
    "statusChangedAt": null
  },
  "isStopped": false,
  "exchangeWithoutSignature": false
}
```

`signature` строится только из опубликованной `ДатаПодписания` документа.
Пустое значение и 1С sentinel `0001-01-01T00:00:00` дают
`isSigned=false` и `signedAt=null`; валидный timestamp даёт `true` и исходное
значение. Непустая некорректная дата отклоняется как повреждённый OData
payload, чтобы runtime не сделал ложный вывод «не подписан».

Текущий workflow-статус ЭДО читается из опубликованного primary-регистра
`InformationRegister_СостоянияДокументовЭДО`. Runtime строит только
фиксированный bounded `$filter` по составному измерению
`ЭлектронныйДокумент`: UUID каждого найденного документа связывается с exact
типом `Document_ЭлектронныйДокументВходящийЭДО` или
`Document_ЭлектронныйДокументИсходящийЭДО`. `$select` содержит только
`ЭлектронныйДокумент`, `ЭлектронныйДокумент_Type` и `Состояние`.

Запросы группируются отдельно по направлению и режутся на batch не больше 20
UUID; один search запрашивает статус не более чем для 200 документов. Каждая
строка повторно проверяется локально: UUID должен входить в requested batch,
`_Type` должен точно совпасть с направлением, а дубликат или посторонняя строка
приводят к fail-closed ошибке. Поэтому сервер, игнорирующий `$filter` или
`$top`, не может присвоить документу чужой статус.

Непустой bounded ресурс `Состояние` возвращается как `edoStatus` с
`statusAvailability.available=true`,
`basis=information_register_status`, `coverage=primary` и exact `source`.
Если строки регистра нет, документ остаётся `edoStatus=unknown`,
`available=false`, `reason=status_register_no_match`; пустой ресурс использует
`reason=status_register_empty`. `statusChangedAt` остаётся `null`, потому что
подтверждённого non-deprecated ресурса даты изменения нет.

Поля карточки `УдалитьСостояниеЭДО` и
`УдалитьДатаИзмененияСостоянияЭДО` считаются deprecated: runtime больше не
включает их в `$select`, не возвращает и не использует как fallback.

`Остановлен` и `ОбменБезПодписи` нормализуются отдельно как `isStopped` и
`exchangeWithoutSignature` и не меняют `signature.isSigned`.
`file.ПодписанЭП` остаётся исходным признаком конкретного вложения. У файлов
одного документа встречаются смешанные `true/false`, поэтому этот признак
никогда не используется для подписи или статуса документа.

## Runtime-команды

```text
connect [--terminal-prompts]
doctor
access-status show
access-status set no-access --confirmed
access-status reset
search-documents --direction incoming|outgoing|both [--query TEXT]
  [--exact]
  [--received-from YYYY-MM-DD --received-to YYYY-MM-DD]
  [--document-date-from YYYY-MM-DD --document-date-to YYYY-MM-DD]
  [--counterparty-id UUID | --counterparty-name TEXT]
  [--contract-id UUID | --contract-number TEXT]
  [--organization-id UUID]
  [--document-number TEXT]
search-files --direction incoming|outgoing|both --filename TEXT
  [те же structured-фильтры и --exact]
get-document --direction incoming|outgoing --document-id UUID
list-files --direction incoming|outgoing --document-id UUID
download-file --scheme new|old --file-id UUID --output PATH
forget-credentials
```

`connect`, `connect --terminal-prompts` и `doctor` объявлены в подписанном
`trelio-secret-setup.json`. Host `>=2.0.10` выполняет их напрямую через текущий
`runtimeExecution.localAction`: получает собственный `x_odata` exact подключения после
live ACL/policy/release/connection проверки и передаёт только процессу навыка.
Задача, Workspace, Agent Run и `prepare_agent_secret_checkout` для настройки
не нужны. `access-status ...` и `forget-credentials` выполняются напрямую без
company secret, с прежними правилами пользовательского разрешения.
При несовместимом host, trust/encryption либо отсутствии прав возвращается
точный blocker; технический Run не является способом его обойти.

Для сетевых рабочих команд агент получает одноразовый checkout `x_odata` с delivery
`env`, exact env `TRELIO_1C_EDO_X_ODATA` и executable `trelio-workspace`.
Литерал секрета не входит в chat, MCP, argv, workspace, Git или логи.
Перед checkout агент обязан подготовить и открыть exact writable Run; read-only
inspection намеренно не содержит `.trelio-run.json`. Checkout исполняется через
typed `secret_exec`: его child arguments детерминированно строятся из exact
`runtimeExecution.localAction` и provider argv, без `bridge.argvPrefix`, shell
или PATH. `TRELIO_WORKSPACE_ACTIVE_RUN_REQUIRED` направляет к
`prepare_agent_workspace_run` → returned `open` → одному повтору и не является
признаком legacy layout. Последний подтверждает только отдельный
`TRELIO_WORKSPACE_LAYOUT_MIGRATION_BLOCKED` с exact blocking details.

## Публикация и проверка

`platform-skills/1c-edo/release.json` задаёт instruction-only release `1.1.1`,
который переиспользует runtime `1.1.0` и требует minimum host `2.0.10`.
Company connection definition, package digest, namespace и сохранённый личный
вход не меняются. Прежний package по-прежнему включает exact setup descriptor;
business-команды в setup-допуск не входят.

```bash
node platform-skills/tools/build-runtime-package.mjs \
  --skill-dir platform-skills/1c-edo --check
node --test platform-skills/tools/agent-skill-setup-contract.test.mjs
python3 -m unittest discover -s platform-skills/1c-edo/tests -p 'test_*.py'
```

Release `1.1.1` публикуется из `/internal-admin/skills/` как instruction-only с
exact `expectedCurrentReleaseId` и reuse текущего package, без нового tag или
artifact. После публикации обязателен catalog read-back: release version равна
`1.1.1`, runtime/package digest остались от `1.1.0`, а instruction digest
изменился. Smoke использует прямой `doctor` без Run; личный ввод не открывается
ради smoke. Новые backend/plugin release или миграция для этого provider update
не нужны.

Patch `1.0.13` возвращает самостоятельный EDO package: executable полностью
совпадает с проверенной функциональной базой skill `1.0.6` / runtime `1.0.5`,
кроме монотонного `RUNTIME_VERSION=1.0.13`. Broad handlers, capability
registry и metadata cache в package отсутствуют. Primary-регистр и все 24
регрессии release `1.0.6` сохранены.

Patch `1.0.14` заменяет платформенные `osascript`/PowerShell dialogs на
защищённую локальную browser-страницу. Tokenized path, exact `Host`/`Origin`,
bounded body/input/timeout, `no-store`, `no-referrer`, CSP и запрет framing
совпадают с проверенной границей Telegram login. Логин и пароль идут
последовательными полями с best-effort `autocomplete=off`, не возвращаются
агенту и сохраняются в прежний provider namespace только после успешного
probe. Существующие credentials и access state не мигрируются и продолжают
работать.

Patch `1.0.15` добавляет bounded retry для HTTP 429 только в идемпотентном
GET/HEAD-контуре. Runtime соблюдает валидный `Retry-After`, иначе использует
экспоненциальную задержку 1/2 секунды с jitter; выполняется не более двух
повторов и не более 30 секунд суммарного ожидания. Более длинный
`Retry-After`, исчерпание попыток и остальные HTTP-ошибки сразу возвращаются
через прежнюю безопасную диагностику без URL, headers или response body.

Patch `1.0.16` закрывает сценарий, в котором нужное допсоглашение было старше
трёх recent-страниц и не имело ожидаемой связи `ДоговорКонтрагента`.
Structured date/UUID/number filters теперь выполняются server-side, имя
контрагента разрешается в UUID, а exact mode не допускает ложное совпадение
короткого номера внутри длинного. `search-files` ищет имя PDF/DOCX напрямую в
обоих каталогах вложений и возвращает нормализованные file/document/message
идентификаторы. Coverage явно показывает ограниченное окно; лимиты 3 × 50 не
увеличены и массовый экспорт не добавлен.

Patch `1.0.17` не меняет OData, credentials или access state. Парольный шаг
browser-first формы показывает явное предупреждение о ненужной browser-копии:
`autocomplete=off` остаётся best-effort hint и не описывается как управление
policy браузера. Security boundary, terminal fallback и формат результата не
меняются.
