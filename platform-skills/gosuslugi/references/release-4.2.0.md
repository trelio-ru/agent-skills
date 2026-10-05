# Госуслуги 4.2.0

## Что вошло в релиз

Runtime 3.2.0 подключён к общему host `browser-session-v1`. Signed package
объявляет class `protected-snapshot`, fixed lease 30 минут и
`manualAssist=false`; minimum host поднят до 2.4.0.

Изменение унифицирует host binding и внешний process deadline с другими
browser skills, но не меняет защиту Госуслуг. AES-256-GCM, Keychain/DPAPI,
fresh OS unlock, native guardian, continuous-clock permits и encrypted
storage snapshot остаются внутри provider runtime. Обычный persistent
Chromium profile и generic manual fallback по-прежнему запрещены.

## Миграции

Повторный setup, перенос vault, DB migration и новые env не нужны. Existing
ciphertext и connection namespace сохраняются. Старый host не запускает новый
package из-за `minimumHostVersion=2.4.0`.

## Что проверить после публикации

- каталог возвращает skill 4.2.0, runtime 3.2.0 и minimum host 2.4.0;
- `doctor`, `configure`, `start`, `status`, `resume` и `stop` получают exact
  host policy `protected-snapshot` с deadline 30 минут;
- macOS/Windows regressions сохраняют native expiry, fresh unlock, encrypted
  restore и fail-closed поведение после sleep/crash;
- попытка generic manual assist отклоняется до открытия окна.

## Rollback

Выпустить новый immutable runtime с исправлением. Не переносить tags, не
понижать storage class до `messenger-profile` и не стирать encrypted vault.
