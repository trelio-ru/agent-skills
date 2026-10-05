# Т‑Банк 2.2.0

## Что вошло в релиз

Runtime 1.2.0 добавляет защищённый вход через T‑ID на внешних сайтах в обычном
caller-owned Playwright context. Один helper создаётся до штатного login click,
наблюдает реальный OAuth code request и поддерживает same-page либо новый direct
popup. После exact callback/state, успешного HTTP ответа и document commit он
возвращает те же context/page, сохраняя черновик формы и выбранные файлы.

Пароль и optional TOTP остаются в прежнем encrypted vault Т‑Банка. Delegated
authorizer занимает одноразовый private request до чтения OS key, а каждый
секретный символ и click требует fresh native permit. Fast SSO может завершиться
без открытия vault. Текущие SMS/app-коды, CAPTCHA, push и выбор передаваемых
данных остаются ручными; runtime не отмечает checkbox и не принимает consent.

Чужие, заранее открытые, `noopener` и вложенные окна не принимаются. Подмена
origin/path/state, второй OAuth request, fragment/form-post и callback без
HTTP/document proof прекращают helper. Неоднозначный финальный ввод не
повторяется. Caller browser никогда не закрывается authorizer-ом.

## Миграции и env

Повторный setup, перенос vault, DB migration и новые env не нужны. Minimum host –
1.6.17. Отдельный browser Agent Skill не добавляется. Клиент импортируется по
exact пути текущего verified package; уже начатая старая OAuth transaction новым
helper-ом не восстанавливается.

## Что проверить после публикации

Каталог должен вернуть 2.2.0/runtime 1.2.0 и новый exact package digest. На
macOS/Windows CI проверяются private capability, native permits, same-page и
direct-popup callback, SSO, password/TOTP, сохранение формы/файла и свободный
Playwright после возврата. Синтетический CI не доказывает реальный T‑ID вход;
ручной smoke требует отдельного явного разрешения пользователя.

## Rollback

Завершить helper без закрытия caller-owned browser и выпустить новый immutable
runtime с исправлением. Не переносить tags, не стирать encrypted vault и не
повторять действие внешнего сайта после неизвестного результата. Обычный
банковский `start` сохраняет прежний lifecycle и ограничения.
