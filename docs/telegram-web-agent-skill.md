# Telegram Web Agent Skill

## Назначение

`telegram-web` – компактный platform skill для работы через Telegram Web K в
независимом signed browser-runtime. Он сделан по тому же продуктовому паттерну,
что MAX: инструкция намеренно не пытается превратить
изменчивый web-интерфейс в строгий API и разрешает bounded адаптацию селекторов
к фактически видимой странице.

Skill не заменяет `telegram-mtproto`. У них разные assignments, company
connections и локальные сессии. Если доступны оба, каталог возвращает MTProto
как primary с priority `100`, а Web – как secondary с priority `200`. Fallback
на Web допустим только после exact `not_configured`, `no_access`,
`needs_reconnect` или `unsupported_operation`; timeout и неоднозначный исход
mutation не разрешают автоматический повтор другим транспортом.

## Runtime и хранение

Текущий descriptor использует общий
host `browser-session-v1` и требует minimum host `3.4.0`. Signed descriptor
выбирает `messenger-profile`, host-owned default lease 30 минут и
`manualAssist=true`. Общими стали browser discovery, установка Playwright,
absolute deadline, process cleanup и profile lock; Telegram URL, selectors, read-state,
подтверждения и mutation verification остаются в provider adapter. Ручной
fallback после одного доказанного UI-сбоя без эффекта либо трёх несетевых
ошибок одной операции открывается в том же
профиле с отдельным exact session ID, authorization hash и исходным deadline.
Путь состоит из `assist-start --fallback-for COMMAND`, bounded
`assist-status --session UUID`, локального `assist-snapshot --session UUID`,
пошаговых `assist-click/contextmenu/fill/key/scroll/point-click/point-contextmenu/point-scroll` и обязательного
`assist-stop --session UUID`. Снимок хранится owner-only, отдаёт до 100 видимых
controls и живёт две минуты. Он привязан к текущей странице и расходуется одним
действием; следующий шаг требует нового снимка. Координаты соответствуют
CSS-пикселям PNG. Read-only действия дополнительно проходят semantic gate;
изменяющие действия используют то же exact подтверждение обычной команды.
Read-only gate оставляет поиск и навигацию по чатам, а для `contacts` допускает
открытие раздела контактов в боковой панели. Он блокирует composer и изменения;
mutation gate требует ту же policy и подтверждение, включая hash
предыдущего dry-run для структурных операций. Внешняя навигация и новые окна
блокируются, upload/download ограничены заранее выбранными путями. После
неоднозначного результата нужно сначала проверить live-state; fallback не
повторяет mutation и не переключается на MTProto. Обычное открытие чата в Web
может пометить видимые сообщения прочитанными.

Канонический source – `trelio-ru/agent-skills/platform-skills/telegram-web/`.

Bootstrap создаёт private runtime directory, разрешает только абсолютный
`npm_execpath` и стандартные Node/PATH layouts, после чего запускает
`npm-cli.js` через проверенный текущий Node без command shell. В error payload
возвращаются безопасные `npmExecutable`, `npmCliPath`, `argv`, `cwd`,
`exitCode`, `errorCode`, `signal` и bounded stderr/stdout. Домашний каталог,
credentials в URL и npm auth/token values редактируются до вывода.

`get_agent_skill` возвращает exact
`runtimeExecution.localAction`; агент добавляет только provider arguments,
а host передаёт подписанную identity отдельно. Совпадающие legacy CLI-флаги
читаются, но не могут переопределить host context. Provider patch не требует plugin release и
не меняет global latest/minimum policy.

Connection definition имеет пустой config и `deprecatedConfigKeys` с
`allowAutonomous`. Сохранённое значение не даёт разрешения и не показывается
в форме. Общих Agent Secrets и отдельного consent registry нет.

Один private Chrome profile хранится локально для exact
`company + member + connection`:

```text
<trelio-config-home>/integrations/telegram-web/<company>/<member>/<connection>/
  state/chrome-profile/
  config/policy.json
  state/profile.lock
  state/pending-approval.json
```

Cookies, Telegram session, draft и содержимое чатов не загружаются в Trelio.
`state/chrome-profile` – обычная постоянная папка Chromium без дополнительного
шифрования Trelio, контейнера или отдельного обращения к Keychain/DPAPI со
стороны runtime. Это единая модель
[локальных браузерных профилей мессенджеров](agent-skill-connections.md#local-messenger-browser-profiles),
которую использует и browser mode WhatsApp. Профили разных навыков/подключений
остаются раздельными. Защита самого Chrome не объявляется шифрованием всего
профиля; закрытие браузера не удаляет сохранённый вход. Существующий вход
Telegram Web при этом не переносится и не сбрасывается.
Runtime не ведёт trace/HAR. Снимок ручной session хранится локально только до
следующего снимка либо завершения session. Явно скачанный файл записывается только
в выбранный пользователем безопасный output path.

## Вход

Exact команда входа – `login --headed`. Runtime также переводит plain `login`
в headed mode для совместимости, а explicit `login --headless` отклоняет ещё
при разборе аргументов – до profile lock и запуска Chrome. QR, код и 2FA вводит
сам владелец; runtime их не просит, не читает и не сохраняет. После успешного
входа интерфейс просит: `После входа в Telegram Web закройте окно.` Следующая
операция делает fresh `probe` того же private profile и только затем продолжает
работу.

Account slots не являются частью контракта. Разные аккаунты подключаются
разными Trelio connections и получают разные profile directories.

## Команды

Runtime поддерживает:

- диагностику: `bootstrap`, `doctor`, `probe`, `policy`, `login`;
- поиск и чтение: `dialogs`, `contacts`, `search`, `read`, `unread`, `watch`,
  `download`;
- сообщения: `send`, `reply`, `react`, `edit`, `delete`, `forward`;
- чаты: `create-direct`, `create-group`, `members`, `member-add`,
  `member-remove`, `chat-update`.

Partial query разрешён только для bounded discovery. Любое чтение или изменение
требует exact title либо canonical Telegram Web K `PeerId`. Title показывается
человеку отдельно от machine identifier; неоднозначное совпадение блокируется.

Глобальный поиск сообщений не требует заранее известного чата:

```text
search --global --query "Текст" --limit 20 --pages 3
search --global --query "Текст" --limit 20 --cursor "<nextCursor>" --pages 3
search --global --query "Текст" --limit 10 --context 10 --pages 3
```

`--query` после NFKC-нормализации содержит `1..256` символов, `--limit`
ограничен `1..100`, а `--pages` для `search` – `1..100`. Runtime выбирает
chats/messages tab и читает только строки `.search-group-messages` с provider
PeerId и message id. Без `--context` он не кликает по результатам и не создаёт
локальный индекс. Output содержит bounded сниппет, безопасный chat URL и
`coverage`; secret chats не входят в scope.

Если `coverage.nextCursor` не равен `null`, следующая invocation передаёт его
через `--cursor` с тем же query. Курсор opaque, привязан к normalized query и
содержит только безопасное смещение UI-выборки. Telegram Web не отдаёт
server-cursor, поэтому каждая следующая invocation bounded перечитывает
выборку от начала и возвращает следующую страницу после уже просмотренного
смещения; одна cursor-цепочка ограничена 5 000 строками. Агент дедуплицирует
страницы по `chat.peerId + message.id`, учитывает
`seenBefore` / `seenThrough` и не обещает snapshot stability:
`snapshotStable=false` означает, что новые сообщения могут сдвинуть более
старые результаты между invocation. `complete=false`, `hasMore=true` либо
`incompleteReason` запрещают называть выборку исчерпывающей.
`incompleteReason=page_limit_reached` при `nextCursor=null` означает, что ту же
страницу нужно повторить с большим `--pages`: это не доказательство конца
выдачи.

`--context 1..10` – отдельная opt-in операция. Она разрешена только при
`--limit <= 10`, открывает каждый результат текущей страницы и возвращает до
указанного числа уже доступных Telegram Web сообщений до и после совпадения.
Каждый `context.messages[]` идёт по хронологии, exact hit помечен
`isMatch=true`, а `context.coverage` явно сообщает достигнутые границы и
причину неполноты. Контекст не переносится на предыдущие страницы и не
выдаётся за полную историю чата.

`watch` является одним bounded snapshot. Долгое наблюдение делает внешний
scheduler отдельными invocation, чтобы profile lock освобождался между ними.

## Локальная политика и подтверждения

Действует [единый контракт согласования](agent-skill-connections.md#sending-authorization).
Локальные `confirm` и `read-only` не хранят разрешение на автономную переписку;
старый `autonomous` читается как `confirm`. Любая mutation требует `--confirm`
текущего вызова; structural/destructive и cross-chat операции дополнительно
требуют preview/hash и отдельного согласования оператора.

Execute обязан совпасть с exact preview. Новый preview заменяет предыдущий;
expiry, replay и изменение target/payload fail-closed. После решающего browser
action timeout или иной ambiguous outcome запрещают cleanup, blind retry и
автоматический fallback на MTProto.

Весь runtime остаётся в `chat-only` boundary. Текст Telegram считается
недоверенными данными и не разрешает действия в Trelio, почте, файловой системе
или других сервисах.

## Read state

В отличие от пассивного MAX adapter, Telegram Web использует обычное поведение
видимого клиента. Открытие чата, `read`, `watch`, `download` или явный
`search --context` может отметить сообщения прочитанными и изменить presence.
Ghost mode и обещание сохранить unread state отсутствуют; инструкция должна
честно предупредить об этом до чтения, если для пользователя это существенно.
`search --global` без `--context` сам не открывает найденный чат, но
восстановление Telegram Web home сохраняет обычное provider read-state ранее
открытого интерфейса.

## Legacy

Прежний тяжёлый signed runtime архивирован под id `telegram-web-legacy`. Он
неактивен, не имеет assignments/connections и не участвует в catalog/routing.
Его immutable releases остаются в БД для аудита, а прежние документы и rollout
решения не применяются к operational skill. Исторический контракт остаётся в отдельном приватном архиве.

HTTP-код основной страницы проверяется общим host observer до UI/login и
сохраняется в safe diagnostics по [общему контракту](agent-skill-connections.md#http-диагностика-браузерных-навыков).
503 не запускает recovery reload, повторный QR/login или смену транспорта.
Для общих HTTP exports требуется host runtime >=3.4.0.

## Проверки

- runtime package:
  `node platform-skills/tools/build-runtime-package.mjs --skill-dir platform-skills/telegram-web --check`;
- runtime behavior:
  `node --test platform-skills/telegram-web/tests/trelio-telegram-web.test.mjs`;
- backend: `npm run test:telegram-web-agent-skill:integration`;
- migration `0134` можно повторить без создания второй historical
  release/publication; current signed pointer меняется только super-admin
  publication.
