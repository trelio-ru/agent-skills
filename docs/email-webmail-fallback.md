# Браузерный резерв почтового навыка

У выбранного обычного ящика есть отдельный защищённый браузерный профиль.
Резерв предлагается при первой настройке и при отказе IMAP/SMTP. Известный
сервис открывается сразу; для остальных агент находит официальный адрес
веб-почты и передаёт `webmail setup --url HTTPS_URL`. Неизвестный внутренний
адрес уточняется у владельца. `setup --edit` содержит только адрес веб-почты.

## Вход и сохранение сессии

Provider использует signed `externalNavigation: true` и `profileAuthentication:
true` общего Visual Browser host >=3.34.0. У него нет списка разрешённых сайтов,
ограничения переходов начальным доменом или обязательной подписи кнопки аккаунта.
Ручной вход выполняется обычным Chromium: extension не блокирует страницы,
redirect, пустые ответы и iframe авторизации. Пользователь не перечисляет SSO.

Session-only cookies всех сайтов собственного профиля сохраняются в private
host Cookie API overlay, включая сторонние и родительские домены и CHIPS.
Постоянные cookies, localStorage, IndexedDB, WebStorage и остальные поддержанные
auth stores сохраняются native profile archive. Всё входит в тот же AEAD
snapshot выбранного account; чужие Chrome profiles не читаются. Credentials
и cookies не выводятся модели, в argv или logs. До model-facing рабочей фазы
host восстанавливает обычные document/input guards.

Конфигурация v2 хранит mailbox и начальный URL. Старые v1 origins/accountControl
читаются без сохранения их ограничений и без удаления прежней авторизации.
Смена начального сайта у того же ящика сохраняет его профиль. При setup окна
предыдущей версии provider штатно закрывает и сохраняет его, затем один раз
переоткрывает с новой policy. Незавершённая остановка не становится новым входом.

## Работа агента

`view/read` возвращают живой интерфейс без дополнительной анкеты аккаунта.
Агент сверяет выбранный ящик по видимому интерфейсу. `follow/navigate` допускают
переходы между сайтами. `screenshot/click/type/key/scroll` используют обычные
fresh-frame controls того же host и позволяют читать, составлять и отправлять
письма. Отдельного запрета на агентскую отправку через браузер нет.
Сохраняются исходные полномочия текущего поручения, режим read-only и запрет
повторения неизвестной отправки. SMTP-only не ограничивает свой браузерный
резерв: протокольный IMAP для этого не нужен, другой ящик не подставляется.

Python entrypoint запускает только signed sibling webmail.mjs через Node того
же host, передавая команды private stdin. IMAP/SMTP password worker в этом пути
не участвует. Общие account locks, lease, encrypted snapshot/CAS и normal close
остаются у host. Профиль не переносится между аккаунтами. Browser UI не выдаёт
IMAP UID/ACK/MIME и не используется для пассивного source monitoring.

## Проверки

Provider tests исполняют настоящий sibling CLI, migration v1 → v2, known/custom
routing, отсутствие SSO/account-label формы, cross-domain links, ordinary input
и сохранение старого окна при обновлении. Python проверяет private stdio,
отсутствие password access и прежнюю read-only policy. Native host CI проверяет
SSO cookie другого домена через реальный Chromium stop/restore и ручной вход
без extension network filtering на каждой обязательной OS.
