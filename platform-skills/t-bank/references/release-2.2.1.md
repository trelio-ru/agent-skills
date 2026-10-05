# Т‑Банк 2.2.1

## Что исправлено

Runtime 1.2.1 не принимает промежуточный same-origin переход со `state` за
OAuth callback. Это сохраняет T‑ID flow на сайтах вроде Т‑БКИ, которые переносят
коррелятор через собственный login bootstrap до реального возврата с `code`.

`state` остаётся обязательной fail-closed проверкой фактического callback.
Origin, path, fixed query, GET, успешный HTTP response, document commit, запрет
fragment/form-post, token response, второй transaction и replay не ослаблены.

## Миграции и env

Повторный setup, перенос vault, DB migration и новые env не нужны. Minimum host –
1.6.17. Версия skill – 2.2.1, runtime – 1.2.1.

## Что проверить после публикации

Каталог должен вернуть 2.2.1/runtime 1.2.1 и новый exact package digest.
Синтетический regression проверяет state-only промежуточный маршрут в bound
popup и последующий exact callback. Реальный smoke Т‑БКИ требует отдельного
явного разрешения пользователя и ручного участия в T‑ID.

## Rollback

Завершить helper без закрытия caller-owned browser и выпустить новый immutable
runtime. Не переносить tags, не стирать encrypted vault и не повторять действие
внешнего сайта после неизвестного результата.
