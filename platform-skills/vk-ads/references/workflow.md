# VK Ads API и сценарии

Runtime 1.0.3, Node >=22, macOS/Windows. Фиксированный origin
`https://ads.vk.com`, redirect:error, v2 REST. Старый социальный VK API не
используется. Иерархия: UI кампания = ad_plan, группа = ad_group (либо campaign
в режиме совместимости), объявление = banner. Режим задаёт человек при
подключении; все операции текущего аккаунта используют одну выбранную структуру.

## Источники и границы подтверждения

Схемы сопоставлены с исходниками
[BugzBunnyViber](https://github.com/BugzBunnyViber/vk-ads-skill),
[askads](https://github.com/askads/mcp-vk-ads),
[ai-hub-open](https://github.com/ai-hub-open/vk-ads-manager) и
[снимком документации](https://github.com/metapeka/vk-ads-api-docs).
Сторонний код в runtime не скопирован, зависимости/MCP servers не установлены.
Снимок документации – secondary источник, не гарантия текущего API.
Официальный источник: [VK Ads API](https://ads.vk.com/doc/api).

Создание баннеров отдельным POST и методы обновления расходятся в community
реализациях. Этот runtime использует описанные в снимке nested banners и POST
обновления; не пробует альтернативную запись после ошибки. Синтетические
регрессии подтверждают логику runtime, но не доступность этих методов в
реальном кабинете. Перед platform publication обязателен live smoke с
тестовым кабинетом: чтение → approved создание paused дерева → read-back →
approved обновление → read-back → approved очистка. Production keys/данные
не входят в tests/source/package. Запуск с расходом не нужен для smoke.

## Команды

Аргументы ниже добавляются в подписанную localAction, не shell command.

| Команда | Результат |
| --- | --- |
| `doctor` | configured/ready и точная структура групп |
| `configure` | одна локальная форма, safe operation/status continuation |
| `setup-status --operation UUID --wait-ms 30000` | read-only наблюдение текущего setup |
| `list --entity plans --limit 1000 --status blocked` | максимум 5000, страницы 200, `count/truncated` |
| `list --entity groups --parent 123` | группы одной кампании |
| `list --entity banners --parent 456` | объявления одной группы |
| `get --entity plans --id 123 --fields id,name,status,budget_limit_day` | выбранные поля exact объекта |
| `catalog --name packages` | первая страница штатного размера API; не полный каталог |
| `catalog --name patterns` | форматы объявлений |
| `catalog --name fields` | роли/ограничения полей |
| `catalog --name regions` / `interests` | справочники targeting |
| `stats --entity plans --ids 123 --from 2026-01-01 --to 2026-01-31` | daily base, до 200 ID, период до 365 дней |
| `plan --file /absolute/spec.json` | exact scoped hash; срок 30 минут |
| `apply --plan UUID --hash HASH --operation stable-operation-id` | один dispatch, persisted receipt, read-back |
| `receipt --operation stable-operation-id` | сохранённый результат без новой записи/API |
| `reconcile --operation stable-operation-id` | только чтение для неизвестной записи/непроверенного результата |
| `accept-unknown --operation … --confirm keep-result-without-replay` | отдельное человеческое принятие unverified; сохраняет историю |
| `recover-lock --confirm recover-dead-process` | проверка мёртвого PID, cleanup без replay |
| `reset --confirm delete-local-credentials` | удаление локальных credentials, сохранение receipts |

Каждый справочник задаёт собственный максимальный размер страницы. Runtime
не передаёт campaign-list limit=200 в справочники, а получает одну страницу
с размером по умолчанию конкретного endpoint. Не выдавай её за полный каталог;
для вывода о полноте сравни items и count, если count возвращён API.
Справочники/статистика зависят от прав и версии API конкретного кабинета;
404/405 возвращаются как blocker. Чтение catalog не утверждает completeness.
Поля `ad_groups`/`campaigns` – create-only children и не запрашиваются как
обычные scalar fields. Баннеры существующей группы перечисляются отдельно.
В v1 нет счетов, пополнений, платежей, refunds, автоматического бюджета,
audience CRUD, PII лидов, пикселей, генерации изображений или фонового scheduler.

## Спецификации

Создать paused дерево (package/content/url IDs возьми из текущего кабинета):

```json
{
  "kind": "create",
  "entity": "plans",
  "payload": {
    "name": "Название кампании",
    "objective": "traffic",
    "budget_limit_day": "1000",
    "ad_groups": [{
      "name": "Название группы",
      "package_id": 1,
      "targetings": {},
      "banners": [{
        "name": "Название объявления",
        "content": {"primary": {"id": 1}},
        "urls": {"primary": {"id": 1}},
        "textblocks": {"title": {"text": "Согласованный текст"}}
      }]
    }]
  }
}
```

Пример показывает форму, а не пригодные для реального кабинета значения.
Цель, package, roles, targeting и required поля берутся из текущего API.
В legacy режиме используется `campaigns` вместо `ad_groups`. Создание новой
группы в существующей кампании: `entity:groups`, обязательные `ad_plan_id`,
`package_id`, `name`, `banners`. Баннеры – create-only, обновление списка
баннеров существующей группы запрещено.

```json
{"kind":"update","entity":"plans","id":123,"payload":{"budget_limit_day":"1200"}}
```

`update` поддерживает name/status/dates/budgets/autobidding; groups добавляют
package_id/ad_plan_id/targetings/price/mixing/age_restrictions/frequency/UTM;
banners – name/status/content/urls/textblocks. Вложенные sections заменяются
VK целиком, поэтому перед patch сохрани все нужные роли исходной секции.
Положительные budgets/price до 100000000; -1/unlimited запрещены. Currency
и реалистичный верхний предел согласуются по кабинету/брифу, без конвертации.
Запуск/остановка/удаление: update `status:active|blocked|deleted`. API policy
финально проверяет допустимость полей/перехода; ошибка не вызывает fallback.

```json
{"kind":"url","url":"https://example.com/offer"}
```

Создание и чтение `/api/v2/urls/{id}.json`. Пустой url_types означает, что
проверка VK ещё не завершена; `verified` не является одобрением URL.

```json
{"kind":"upload","file":"/absolute/creative.png","width":1080,"height":1080}
```

Локальные PNG/JPEG/GIF/MP4, sniff bytes, максимум 100 MiB, dimensions 1–20000.
Upload: multipart file + data {width,height} на content/static или content/video.
План сохраняет hash/size/type файла; apply перечитывает и проверяет hash.
Remote URL download/HTML5 upload не реализованы. Ответ content upload не
имеет отдельного GET в этом контракте: `uploaded_unverified`, затем проверка
content ID в объявлении. Изменение файла требует нового плана.

## Отказ и конкуренция

GET повторяется до трёх попыток с паузами 500/1000 мс при network/429/5xx.
Advertising POST никогда не повторяется автоматически. OAuth token сохраняется
зашифрованно до expires_at, новый выдаётся при expiry; 401 не вызывает
автоматическое изменение credential. 403 не трактуется как logout.
Receipt сохраняет безопасные `errorDetails.httpStatus` и до 32 кодов
`errorDetails.fields`, когда API их вернул. Raw message/body, credentials и
произвольные строки не сохраняются и не выводятся. Код поля объясняет отказ,
но не разрешает fallback или повтор записи. Исторический receipt без деталей
не восстанавливает причину; не повторяй POST лишь ради диагностики.

Apply сохраняет `unknown` до сети, затем object ID/ответ до read-back. Crash,
timeout или malformed response не стирают receipt. Один operation ID и один
planHash не отправляются повторно, даже после restart или с другим ID.
`unknown` и `written_unverified` блокируют новую запись всего аккаунта.
Ответ создания может называть группы `campaigns` при настроенном `ad_groups`:
это только alias ответа, структура запросов не меняется. Если ответ не вернул
ID дочерних объектов, сверка читает полный bounded список лишь внутри exact
созданного родителя с известным ID. Каждый ребёнок проверяется по своей связи
с родителем и всем запрошенным scalar полям. Порядок списка не угадывается:
неоднозначность, лишние дети, duplicate IDs и truncated сохраняют blocker.
Успешная сверка сохраняет exact дерево child IDs в receipt.children.
`reconcile`
не ищет похожие объекты для lost create ID и не повторяет POST. Человек может
отдельно принять unknown, сохраняя явное отсутствие evidence.

Scope включает host company/member/account/companyBinding; подтверждение
другой компании не используется. На одном account одновременно одна запись;
живой lock не сбрасывается. PID reuse блокирует recovery консервативно.
Сравнение before перед update не atomic CAS VK: конкурентное изменение после
preflight всё ещё возможно; runtime не обещает транзакционную изоляцию сервиса.
