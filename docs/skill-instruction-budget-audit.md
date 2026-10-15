# Аудит основных инструкций навыков

Дата: 15 октября 2026 года. Проверены все 17 общих provider source в
`platform-skills/`. База до правки – `fc058bc`; размеры UTF-8 после publication
`trim`, предел – 16 384 байта. Проверка не читает credentials, не открывает
сервисы и не изменяет опубликованные версии. Это аудит source; корпоративные
и historical snapshots и live production catalog в него не включены.

| Навык | До, байт | После, байт | Результат |
| --- | ---: | ---: | --- |
| 1c-edo | 13 218 | 13 218 | В пределах |
| avito-search | 5 692 | 5 692 | В пределах |
| consultant-plus | 17 535 | 17 535 | Требует переработки перед публикацией |
| document-facsimile | 11 520 | 11 520 | В пределах |
| dodostats-drinkitstats | 7 834 | 7 834 | В пределах |
| email-imap-smtp | 28 177 | 28 177 | Требует переработки перед публикацией |
| gas-pravosudie | 20 999 | 20 999 | Требует переработки перед публикацией |
| gosuslugi | 55 922 | 8 561 | Переработан |
| iphone-mirroring | 13 662 | 13 662 | В пределах |
| max-web | 46 369 | 46 369 | Требует переработки перед публикацией |
| ozon-buyer-search | 8 792 | 8 792 | В пределах |
| russian-post-registered-mail | 30 206 | 30 206 | Требует переработки перед публикацией |
| t-bank | 15 497 | 15 497 | В пределах |
| telegram-mtproto | 42 226 | 42 226 | Требует переработки перед публикацией |
| telegram-web | 17 865 | 17 865 | Требует переработки перед публикацией |
| vk-ads | 12 204 | 12 204 | В пределах |
| whatsapp-web | 21 168 | 21 168 | Требует переработки перед публикацией |

До переработки было 9 превышений, после – 8. Их текст в этой задаче не менялся.
Новая oversized publication отклоняется; существующие immutable releases
сохраняются. Ограничение основной инструкции само по себе не доказывает,
что полный ответ с manifest, personal rules и JSON escaping помещается в
40 000 байт: этот независимый guard действует на окончательном MCP envelope.

В Госуслугах все 13 исходных частей сохранены; operational sections доступны
через `guides` из того же signed package. Обязательные общие документы и
сценарии ЕСИА, ПОС и Госключа читаются до действия. `instruction-map.json`
и regression восстанавливают исходный SHA-256; учитываются только необходимые
изменения относительных ссылок при переносе файлов. Account/OS unlock,
callback/state, approvals, manual consent/signing, replay fences и lease
не изменялись.

Повторная проверка:

```sh
node platform-skills/tools/report-instruction-budget.mjs
node --test platform-skills/gosuslugi/tests/instruction-guides.test.mjs
```
