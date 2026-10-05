# Госуслуги 3.0.0

## Что вошло в релиз

Runtime 2.0.0 ограничивает Госуслуги собственным порталом и авторизацией ЕСИА.
Внешние страницы, сценарии и сессии принадлежат вызывающему агенту в отдельном
secure-browser. Убраны service catalog, `start --service`/`--service-url`,
внешний DOM и сохранение новых service sessions в vault Госуслуг.

`authorize` выполняет только разрешённый пользователем вход в exact сайт,
используя одноразовый private request исходного браузера. По завершении
возвращает управление тому же browser/context, не продлевая его срок.
Сохранённые credentials и native key namespace сохраняются. Исправлен также
выбор региона ПОС через fresh option ref; Enter/submit не добавлены.

## Миграции и env

Новые переменные окружения и DB migration не нужны. Minimum host – 1.6.17.
Рабочие команды старого external mode заменяются secure-browser 1.0.0+.
Перед `start --confirm`/`authorize ... --confirm` агент проверяет разрешение
пользователя на конкретный сайт; ранее данное не спрашивает повторно.
Активные workers не обновляются на месте. Повторный ввод сохранённых данных
Госуслуг не требуется; старые external ciphertext fields не читаются/не удаляются.

## Что проверить после деплоя

Свежий каталог должен вернуть Госуслуги 3.0.0/runtime 2.0.0 и secure-browser
1.0.0/runtime 1.0.0. Проверить собственный портал, сохранение выбранного
региона ПОС и delegated flow: permission → actual ESIA → возврат того же
окна → независимая проверка кабинета вызывающим агентом. Callback не считать
доказательством входа или подачи. Проверить stop/closed и отсутствие потери vault.

Release gate включает native lifecycle/ACL на macOS и Windows, исходные
auth/role/storage regressions и headed synthetic flow на двух разных сайтах.
Реальный аккаунт требует отдельного разрешённого smoke; synthetic его не заменяет.

## Rollback

Остановить затронутые сессии и отключить delegated flow, сохранив ciphertext.
Вернуть через internal admin только проверенный immutable release с нужной
границей ответственности. Не возвращать внешние сценарии в Госуслуги и не
переписывать tags/packages. При отзыве artifact нужен новый runtime identity.
