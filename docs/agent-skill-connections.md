# Личные подключения

Подключения, реальные credentials и sessions находятся на устройстве пользователя
либо в защищённом company secret storage. Они не являются частью этого source.
Настройка выполняется штатным verified runtime через защищённую локальную
форму либо явный one-use Agent Secret checkout в поддержанном ниже сценарии;
пароль, OTP, token и cookie не вводятся через чат или GitHub.

<a id="email-device-storage"></a>

## Хранение почты на устройстве

Почтовые подключения одного пользователя используют общий набор ящиков на
его устройстве. Company assignment не создаёт вторую копию его паролей.
На macOS ключ защищает Keychain, на Windows – DPAPI CurrentUser; файлы
credentials шифруются и имеют owner-only permissions. Linux credential storage
проходит собственную fail-closed проверку runtime. Импорт legacy layout не
удаляет прежние данные после неоднозначной ошибки. Browser configure и личное
подключение не требуют фиктивного рабочего Agent Run.

Временные коды, полные message bodies и личные данные нельзя переносить в
package, отчёт CI, traceback или Git. Рабочий результат раскрывается только в
разрешённой пользователем аудитории. Отправка остаётся отдельным разрешённым
действием; сохранённый connection сам по себе её не разрешает.

## Режим почты только для отправки

Email configure предлагает `imap_smtp` (по умолчанию для прежних настроек)
и явный `smtp_only`; CLI `configure --smtp-only` выбирает второй режим в форме.
В SMTP-only сохраняются SMTP TLS/STARTTLS, один защищённый пароль, подпись
и sending policy. IMAP-поля не обязательны и очищаются при сохранении;
неизвестный mode отклоняется. Пустой IMAP-host либо сетевой сбой сами по себе
не включают этот режим. Browser/terminal reconnect сохраняет выбранный mode.

`doctor` не подключается к IMAP и честно возвращает `imap=null`,
`imapStatus=disabled`. Чтение/папки/вложения входящих/reply fail-closed до
native unlock, а внутренний IMAP connector также проверяет режим. Отправка
не сохраняет копий в Sent или локально. Существующие IMAP/SMTP-аккаунты
сохраняют прежний контракт копирования; настройка SMTP-only одного аккаунта
не меняет другие и не привязывает пересланный Gmail. Это capability, а не
расширение разрешения отправки или read-only policy.

### Подключение SMTP-only из Agent Secret

Явное `configure --smtp-only --from-agent-secret` использует только существующий
Run-bound checkout поля password с logical executable `trelio-workspace`,
delivery=file и handoff в exact live-resolved `skill run`. SMTP/email/user/name
передаются как проверенные несекретные CLI-параметры; password flags нет.
Без активного подходящего Run используется обычная форма, фиктивный Run запрещён.
Нужны отдельные обычные secret ACL и поручение настроить этот локальный ящик.

Bridge владеет one-use grant и temporary file cleanup; signed provider не
обращается к vault API сам. В публичный process поступает только reference
TRELIO_SECRET_FILE, не значение. Native owner переносит путь через private
protocol; worker читает bounded UTF-8 после permit и owner/file/parent checks.
Reference не наследуется compiler/guardian/worker через ambient env. Временный
файл не копируется в config, Git, Workspace, logs либо native protocol. Пароль
сохраняется существующим Keychain/DPAPI writer; режим/подпись других ящиков,
bindings и sending policy сохраняются. Ошибка не открывает browser fallback
и не разрешает повторное потребление. Свежий doctor устанавливает результат;
успех storage не означает доставку сообщения.

## Общий каталог личных аккаунтов

Почта, Telegram MTProto/Web, MAX, WhatsApp, Госуслуги, ВК Реклама и факсимиле объявляют signed
`local-accounts-v1` и minimum host `3.7.0`. Каталог, UUID, названия (120 символов),
подробные комментарии (2000 символов), optimistic revisions и привязки к компаниям
обслуживает generic runtime. Provider реализует вход, storage reference,
изолированный рабочий процесс и проверку результата. Это не один provider
credential store: Telegram Web и MTProto сохраняют разные авторизации.
Факсимиле используют тот же каталог для локальных PNG с обязательным ФИО;
условия выбора каждого варианта находятся в общем комментарии аккаунта.
Настройка изображения не разрешает самостоятельно подписывать документы.
ВК Реклама хранит credentials/token и receipts локально под account UUID;
Client Secret вводится защищённой формой, создавать кампании и менять расход
разрешает отдельное поручение на exact operation, а не company binding.
macOS использует Keychain + AES-GCM, Windows – DPAPI CurrentUser;
Linux credential flow в этой версии fail-closed. Полный контракт – в
[security.md](../platform-skills/vk-ads/references/security.md).

Браузерные Авито (minimum host 3.11.0) и ВКонтакте (3.17.0) используют тот же
каталог, собственный `protected-snapshot` и ручной вход. Snapshot VK принадлежит
skill `vk`; общий VK ID не переносит авторизацию из `vk-ads` и не даёт доступ
к рекламным credentials. Вход ВКонтакте обязателен до рабочих действий;
проверяется после восстановления соцсети,
не по записи account или странице VK ID. Разделы внутри HTTPS vk.ru/vk.com
с поддоменами и exact vk.me выбираются по поручению пользователя, без
provider-запретов по названию. Недостающая команда/неподдержанный control
сообщаются отдельно от наличия сессии. Контракты:
[VK workflow](../platform-skills/vk/references/workflow.md),
[VK security](../platform-skills/vk/references/security.md),
[исходящие файлы](../platform-skills/vk/references/uploads.md).

В пределах одного origin Trelio и OS user `account list` показывает accounts
этого навыка, включая ещё не включённые в текущей компании. Агент предлагает
существующий либо новый; `account bind` требует выбора пользователя. New create
включает аккаунт в текущей компании. Update меняет общие метаданные; unbind/default
относятся только к текущему company/member. Явный `--local-account UUID` передаётся
host-у с обычной командой. Глобального переключателя active-account нет. Результат
list не раскрывает перечень компаний, их правила или credential locator.

`TRELIO_SKILL_ACCOUNT_JSON` поступает только из verified host после проверок
scope/assignment/package. Поля id/providerRef/companyBinding задают storage и
точную область активной сессии; живые company/member env остаются неизменными.
Имена/комментарии не участвуют в key, filesystem path или разрешении отправки.
Подтверждение операции связано с выбранным account/company; рабочая сессия
другой компании не получает управление по повторно используемому входу.

Новые browser/SDK accounts используют UUID. `providerRef` импортированного
аккаунта сохраняет точные прежние identity/AAD/OS-key locators и session files:
переименование и привязка к другой компании не переносят ключи или cookies.
Email сохраняет внутреннее имя ящика из TOML для encrypted password lookup,
а отображаемые name/comment читает из общего каталога. Его description в форме
configure показан только для чтения; меняется общим account update.

Legacy entry `skill-personal-accounts-v1` находится в product registry. Signed
фиксированный `__trelio_accounts_import` читает только bounded metadata в exact
scope; не открывает credentials, SQLite, браузер или внешний API. Host атомарно
импортирует результат один раз, без слияния по email/телефону/названию. Прежний
company profile сохраняет свою company binding; другие старые scopes будут
обнаружены при первом обращении к ним. Email device list импортируется один раз;
в следующих компаниях предлагается явное включение. Ошибки не ставят marker и
не стирают файлы; unbind не отменяется повторным импортом.

После шести месяцев production доступности разработчик может удалить importer
в следующем release; таймера и постоянного отдельного конвертера нет. Поздний
пользователь настраивает аккаунт с нуля. Уже импортированные opaque storage
references остаются полноценным новым форматом, исходные файлы не удаляются.
Synthetic contract tests: `platform-skills/tools/local-accounts.test.mjs`,
Python mailbox/Telegram tests и ESIA authorization tests. Реальные credentials
в migration fixtures не используются; OS/browser gates остаются обязательными.


<a id="assistant-command-policy"></a>

## Команды цифрового ассистента

Provider включает `trelio-assistant-execution.json` в обычный signed package
как файл с проверенными bytes/SHA-256. Формат v1 содержит только
`schemaVersion:1` и `taskCommands`: 1–64 literal positional prefixes из 1–3
CLI-токенов `[a-z][a-z0-9-]{0,63}` без повторов. Общий host, а не инструкция
модели, проверяет этот файл до account selection и повторно перед запуском
того же process engine. Нет файла/неизвестная версия/неизвестная команда –
закрытый отказ, без попытки legacy provider или human authorization.

Prefix должен однозначно задавать действие в настоящем parser provider-а;
global options перед ним, wildcard/regex, option-skipping и shell отсутствуют.
Например, `["policy","show"]` разрешает только просмотр, а `["policy"]`
ошибочно открыл бы и изменение. Новая CLI-подкоманда не становится доступной
ассистенту автоматически. Provider tests проверяют реальные parser choices;
host composition отдельно проверяет отказ до bootstrap/credentials.

Email разрешает task-у чтение, сохранение выбранных источников и обычные
send/reply с прежними независимыми основаниями. Configure, policy/signature
изменения, importer, passive monitor и exact ACK не включены. Protected source
configure и model-free monitor идут по отдельным native owner/source admissions,
ACK требует committed processing/read proof/lease. Host account list/CRUD имеют
собственные прежние guards. Подпись файла не разрешает отправку, не заменяет
согласование владельца и не ослабляет read-only/unknown-outcome правила.
Обычные human calls сохраняют прежний CLI и не требуют этого opt-in; файл
ограничивает dedicated task execution, не создаёт новый executor или vault.

Policy v2 сохраняет `taskCommands` и требует `deniedOptions`: 1–32 уникальных
literal long options `--[a-z][a-z0-9-]{0,63}`. Тот же guard отклоняет отдельный
токен и форму `--flag=value` до account/bootstrap. Например, MAX разрешает
human `read --chrome PATH`, но task descriptor запрещает browser executable,
режим окна и budget overrides. Provider обязан проверить собственные aliases/
abbreviations: host не угадывает их по имени флага. Forbidden-looking значение
данных также даёт fail-closed отказ. V1 не игнорирует v2 поля; неизвестная версия
закрыта, без legacy fallback. Обычный human CLI не меняется. Общий enforcing
runtime и exact provider/native tests должны быть проверены до task rollout;
сам файл не включает автономную работу или source intake.

<a id="signed-human-input-setup"></a>

## Подписанное объявление ручного входа

Новые packages Telegram MTProto 2.13.2, почты 2.7.3 и MAX 2.11.1 включают
`trelio-secret-setup.json` v2 и требуют host >=3.18.0. Старые immutable artifacts
не получают эту capability задним числом. До подписанного выпуска provider/host
наличие source JSON не подтверждает доступность managed setup.

`commands` остаётся обязательным массивом Secret-backed команд с прежним
`secret-checkout`. Здесь он пуст: отдельный непустой `humanInputCommands` требует
`local-session`, не разрешает Secret delivery. Каждая запись содержит только
уникальные `id`, `purpose=authenticate_existing`, literal `arguments` (до восьми
токенов) и optional `maximumDurationMs` от 60 000 до 600 000. IDs и полные argv
уникальны среди обоих массивов. Unknown поля/версии закрыты у общего host parser;
пустые оба массива не объявляют setup. Provider не вводит второй parser/исполнитель.

| Provider | commandId | Подписанный argv | Проверка результата |
| --- | --- | --- | --- |
| Telegram MTProto | `login` | `login --qr` | Existing runtime подтверждает native authorization; QR/2FA остаются в одноразовой локальной странице |
| Почта | `configure` | `configure` | После protected submit выполняется отдельный `doctor`; сохранение не доказывает вход или доставку |
| MAX | `login` | `login --headed` | Человек сам выбирает фоновое окно и закрывает его после входа; затем обязателен один свежий `probe` |

Host выбирает точный account UUID в прежнем изолированном managed каталоге и
передаёт `--local-account UUID` только своему селектору, вне immutable provider
argv. Почтовый CLI сам получает внутренний mailbox locator из native host
binding; модель не добавляет `--account`, endpoint, пароль или другие значения.
Новый пустой локальный slot нужен для авторизации уже существующего внешнего
аккаунта; это не signup, импорт human credentials/session или копирование source
account. Полномочия на owner setup, company binding и работу task проверяются
независимо. Обычный `taskCommands` по-прежнему не включает login/configure.

Человек вводит все факторы в прежнюю protected form/окно. Нет нового provider,
vault, UI, terminal prompts или автоматизации входа; факторы не доставляются
через env, Secret checkout или model values. Native host identity/account binding сохраняются.
Лимит команды не продлевает исходную lease. Cancel, expiry и неизвестный outcome
сохраняют прежний запрет blind retry; сначала exact readiness/read-back. Setup
не разрешает sending, ACK или другие внешние mutations.

<a id="human-input-completion"></a>

## Продолжение после ввода

Platform и company-private skills возвращают безопасный проверенный результат
protected form, OS unlock, OAuth, QR и ручного входа. Уже разрешённая работа
продолжается без обязательного сообщения «заполнил»/«готово». Закрытие окна само
по себе не доказывает успех; cancel/error/process loss различаются. Предпочтителен
ожидающий вызов; detached runtime выдаёт exact operation/session, phase,
requiredAction и готовый read-only wait/status continuation. Один wait ограничен
30 секундами; смена шага возвращается сразу, timeout сохраняет pending. Исходные
account/scope и lease не меняются, receipt сохраняется после cleanup. Wait не
читает secret fields/QR/callback, не делает submit/resume/login и replay.
Configured требует отдельной provider readiness/business проверки. Новый consent,
роль, отправка, платёж, подпись и восстановление сохраняют самостоятельные основания.
Нельзя обещать wakeup законченного чата без поддерживаемого host event. Недоступное
наблюдение обозначается явно; chat acknowledgement может возобновить ход, но успех
устанавливает safe read-back. Авторы приватных навыков получают правило и behavioral
checklist через backend-managed MCP authoring contract.


<a id="first-outgoing-routing"></a>

## Первая исходящая переписка

В новых source packages Telegram MTProto 2.13.3, почты 2.7.4 и MAX 2.11.2
`send --conversation-reference` дополнительно возвращает
`conversationReference:{available:true,conversationKey}` либо закрытый
`available:false/code`. Это явный opt-in того же авторизованного send; host
не дописывает argv и не меняет согласованную отправку. Прежний CLI без flag
сохраняет прежние provider calls/output. Новые версии требуют host >=3.18.0;
immutable ранее выпущенные artifacts не переиздаются.

Telegram использует существующий account-cloud monitor binding, marked peer
из native resolved entity и прежний private cursor HMAC с отдельным purpose.
MAX использует тот же native monitor scope для фактически открытого canonical
chat и требует наблюдённую native history этого чата. Нет hash по имени/тексту,
второго SDK/browser/HTTP executor, прямого socket запроса либо нового хранилища.
Email до SMTP делает только два readonly EXAMINE входящего INBOX, сверяет его
UIDVALIDITY и использует свой generated Message-ID через прежний thread parser.
Sent UID/folder не заменяют incoming scope. IMAP error/cleanup/смена UIDVALIDITY
дают unavailable; SMTP-only не открывает IMAP и возвращает unavailable явно.

Будущий native monitor event вычисляет тот же key в том же selected account и
company binding. Hint не является доказательством sender/owner, чтения,
processing, delivery/business success или разрешением новой задачи/ACK.
Dedicated host после captured signed provider output получает только current
owner-selected native source candidates exact account/company/device/project;
обычный native bind отдельно проверяет task/source/assignment generations,
свежий task snapshot и конфликт маршрута. Источник/провайдер/ключ не угадываются.

Hint failure не отменяет положительный send result, не повторяет отправку и
не вызывает fallback/login. Если key/source/context unavailable, привязка
ответа остаётся незавершённой; отправлять сообщение ещё раз ради hint запрещено.
Отсутствующие References у ответа и смена INBOX UIDVALIDITY не обещают match.
Source merge и синтетические fixtures не доказывают live Windows business E2E.


## Удаление локального аккаунта

Host >=3.25.0 обслуживает `account remove --id UUID --expected-revision N --confirm`.
Telegram MTProto >=2.15.1 включает signed `trelio-account-removal.json`; прежние
providers без marker остаются недоступны для этой операции. Тот же executor
выполняет fixed `__trelio_account_remove`, проверяет exact value-free receipt и
лишь затем удаляет metadata/bindings/defaults. Чужая company/member binding
требует `--all-companies` и явного решения пользователя. Unbind сохраняет вход.
Provider удаляет только свой bounded local tree под native session lock,
без SDK/network/bootstrap. Безопасный tombstone и import keys сохраняются против
stale selection/reimport; I/O failure оставляет запись для восстановления.
Удаление локального подключения не удаляет внешний Telegram account/историю,
не отзывает другие устройства и не подменяет отключение server source refs.

Удаление проверяет symbolic/reparse ancestors до lock и каждого unlink.
NTFS junction не считается обычной папкой; native Windows regression проверяет
как вложенную junction, так и заменённый ancestor, без изменения target.
