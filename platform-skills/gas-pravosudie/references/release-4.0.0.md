# ГАС «Правосудие» 4.0.0

## Что вошло в релиз

Навык получил собственный signed runtime на общем host browser-session contract
`protected-snapshot`. Headed окно создаётся без активации и живёт одну связанную
процедуру; команды, snapshot и сохранение сессии не забирают фокус.

Состояние `sudrf.ru` переиспользуется через AES-256-GCM snapshot с ключом
текущей OS identity. ГАС не запрашивает Touch ID/CredUI при обычном старте.
Делегированный вход через current verified Госуслуги остаётся отдельной
защищённой процедурой и может запросить Touch ID/пароль ОС.

Точная известная форма пользовательского соглашения проверяется и отмечается
runtime автоматически до штатного «Войти». Отдельное подтверждение обычного
входа не запрашивается, если поручение уже требует личный кабинет. Изменённое
либо дополнительное согласие останавливает процедуру fail-closed.

## Миграции и env

Это первый runtime package навыка: runtime version `1.0.0`, minimum host
`2.4.0`, skill version `4.0.0`. Connection/secret migration и DB migration не
нужны. Старый непостоянный Playwright context автоматически не переносится;
первая новая сессия создаёт отдельный encrypted snapshot.

## Что проверить после деплоя

Проверить `doctor`, background `start`, повторное использование exact сессии,
`snapshot`/`script`, automatic standard agreement, делегированный
`client` → `prepare-sign-in` → Госуслуги `authorize` → GAS `resume`, а затем
`stop`/closed. На macOS и Windows подтвердить отсутствие OS prompt при обычном
GAS start и сохранение штатного Touch ID/пароля только в Госуслугах.

## Rollback

Остановить активную runtime session и вернуть назначение на предыдущий immutable
release. Новый encrypted GAS snapshot можно оставить: старый instruction-only
release его не читает. Не переносить ciphertext, key или cookies в другой skill.
