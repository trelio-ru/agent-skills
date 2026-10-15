# Аудит основных инструкций навыков

Дата: 15 октября 2026 года. Проверены все 17 общих provider source в
`platform-skills/`. База до правки – `fc058bc`; размеры UTF-8 после publication
`trim`, предел – 16 384 байта. Проверка не читает credentials, не открывает
сервисы и не изменяет опубликованные версии. Это аудит source; корпоративные
и historical snapshots и live production catalog в него не включены.

| Навык | До, байт | После, байт | Fixture MCP, байт | Результат |
| --- | ---: | ---: | ---: | --- |
| 1c-edo | 13 218 | 13 218 | 36529 | В пределах |
| avito-search | 5 692 | 5 692 | 22466 | В пределах |
| consultant-plus | 17 535 | 10 997 | 30857 | В пределах |
| document-facsimile | 11 520 | 11 520 | 33164 | В пределах |
| dodostats-drinkitstats | 7 834 | 7 834 | 24267 | В пределах |
| email-imap-smtp | 28 177 | 6 052 | 24815 | В пределах |
| gas-pravosudie | 20 999 | 5 647 | 27057 | В пределах |
| gosuslugi | 55 922 | 8 561 | 38395 | В пределах |
| iphone-mirroring | 13 662 | 13 662 | 39383 | В пределах |
| max-web | 46 369 | 5 878 | 24171 | В пределах |
| ozon-buyer-search | 8 792 | 8 792 | 26075 | В пределах |
| russian-post-registered-mail | 30 206 | 12 376 | 33666 | В пределах |
| t-bank | 15 497 | 4 450 | 27020 | В пределах |
| telegram-mtproto | 42 226 | 5 935 | 23744 | В пределах |
| telegram-web | 17 865 | 5 252 | 21355 | В пределах |
| vk-ads | 12 204 | 12 204 | 37836 | В пределах |
| whatsapp-web | 21 168 | 5 267 | 26251 | В пределах |

Все 17 основных инструкций и их descriptor-only MCP fixtures теперь помещаются
в соответствующие лимиты; исходные превышения
устранены. В Госуслугах сохранена сценарная карта из первой переработки.
Email, ГАС, MAX, Telegram MTProto/Web, WhatsApp и Т-Банк сохраняют полный прежний текст
в signed package частями не более 16 КиБ. `guides` возвращает пути и SHA-256;
все части обязательны по порядку до рабочих команд. Tests восстанавливают
исходный SHA-256 и запускают metadata-команду из собранного artifact без account,
credentials, native store, браузера и сети, включая Python `-I -B`.

КонсультантПлюс и Почта России сохраняют полный компактный контракт непосредственно
в SKILL.md. Сверены все прежние разделы и forward-сценарии: protected handoff,
источники/аудитория, callback/живой caller, exact approvals, оплата, replay и
проверка названий/доказательств не ослаблены. Новый способ доступа не добавлен.

Это **source audit**, не обновление production. Сначала публикуются совместимые
provider releases и проверяются полные live ответы, затем общий backend/host
ограничитель. Immutable исторические releases не переписываются. Дополнительно Т-Банк переработан из-за envelope overflow при допустимом
размере основной инструкции. Fixture использует полный inventory с SHA-256
фиксированной длины и консервативным размером файла, не требует build outputs
или release inputs. Source guard
16 384 байта не доказывает общий лимит 40 000: final envelope зависит также от
manifest, personal rules, JSON escaping и text-compatible дублирования. Package
regression проверяет отдельный offline envelope с manifest и 4 КиБ запаса для
контекста; это не обещание для любого пользовательского слоя.

Повторная проверка:

```sh
node platform-skills/tools/report-instruction-budget.mjs --strict
node --test platform-skills/tools/agent-skill-refresh-contract.test.mjs
node --test platform-skills/gosuslugi/tests/instruction-guides.test.mjs
```
