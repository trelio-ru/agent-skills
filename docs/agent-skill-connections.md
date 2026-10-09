# Личные подключения

Подключения, реальные credentials и sessions находятся на устройстве пользователя
либо в защищённом company secret storage. Они не являются частью этого source.
Настройка выполняется только штатным verified runtime и защищённой локальной
формой; пароль, OTP, token и cookie не вводятся через чат или GitHub.

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

## Общий каталог личных аккаунтов

Почта, Telegram MTProto/Web, MAX, WhatsApp и Госуслуги объявляют signed
`local-accounts-v1` и minimum host `3.7.0`. Каталог, UUID, названия (120 символов),
подробные комментарии (2000 символов), optimistic revisions и привязки к компаниям
обслуживает generic runtime. Provider реализует вход, storage reference,
изолированный рабочий процесс и проверку результата. Это не один provider
credential store: Telegram Web и MTProto сохраняют разные авторизации.

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
