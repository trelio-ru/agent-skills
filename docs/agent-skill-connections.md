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
