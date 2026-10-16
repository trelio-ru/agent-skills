# Управление аудиторией и явной целью

Runtime 1.4.2. Перед первой такой записью прочитай `reference --name
audience-management` и общий workflow. Аргументы добавляются только к current
signed localAction. Все операции используют прежние `plan --file`, scoped hash,
`apply --plan --hash --operation`, encrypted receipts и GET-only reconcile.
Прямое разрешение пользователя на exact изменение сохраняется; агентский план
сначала показывается для решения. Создание/изменение аудитории может повлиять
на каждую кампанию, использующую источник: покажи читаемые campaign_ids и
условия, включая неизвестную часть. Это не разрешает запуск рекламы.

## Официальные схемы и граница

[Segment](https://ads.vk.com/doc/api/object/Segment),
[Segments](https://ads.vk.com/doc/api/resource/Segments),
[SegmentRelations](https://ads.vk.com/doc/api/resource/SegmentRelations),
[SegmentRelation](https://ads.vk.com/doc/api/resource/SegmentRelation),
[PricedGoal](https://ads.vk.com/doc/api/object/PricedGoal),
[AdGroup](https://ads.vk.com/doc/api/object/AdGroup) и v3
[RemarketingUsersList](https://ads.vk.com/doc/api/resource/RemarketingUsersList).
Методы и payload не переключаются после отказа. Реальная совместимость нового
write-пути не доказывается синтетическими регрессиями: оцени результат его
первой отдельно разрешённой операции и read-back. Без разрешения не создавай
живые объекты ради проверки. Не объявляй весь write API проверенным по GET.

Поддержано:

- сегмент: create с 1–20 источниками, update name/pass_condition, delete;
- связь: добавить один источник, обновить известные params, удалить одну связь;
- загруженный список: только переименование и удаление, без загрузки людей;
- VK-сообщество: поиск exact публичной группы, чтение зарегистрированного
  источника, отдельная регистрация и удаление;
- priced_goal кампании/группы: явная цель Top@Mail.ru по exact внутреннему
  ID источника счётчика и exact ID цели.

Создание связей поддерживает документированные remarketing_users_list,
remarketing_counter, remarketing_vk_group и segment. Новый search-phrase
источник не создаётся этим контрактом: неописанные параметры его связи не
угадываются. У существующей связи, в том числе поисковой, можно изменить
общий params.type positive/negative, если params прочитан. left/right и
goal_id обновляются только у remarketing_counter. object_type/object_id и
params.source_id не заменяются update; другая ссылка требует отдельных
удаления/создания с отдельным планом. Пользовательские IDs, телефоны, emails,
CSV, экспорт людей, источник look-alike, настройки пикселя/сайта, мобильные
трекеры и создание событий не входят в эти операции. Поисковые фразы читаются
по [диагностическому контракту](diagnostics.md); их PUT/upload не добавлен.

## Спецификации

Примеры показывают форму с синтетическими ID. ID/условия реального кабинета
возьми из свежего чтения; эти числа не подставляются автоматически.

```json
{
  "kind": "audience",
  "entity": "segments",
  "action": "create",
  "payload": {
    "name": "Согласованная аудитория",
    "pass_condition": 1,
    "relations": [
      {"object_type": "remarketing_users_list", "params": {"source_id": 100, "type": "positive"}},
      {"object_type": "segment", "object_id": 50}
    ]
  }
}
```

pass_condition – целое число от 1 до количества источников. Для нового
remarketing_counter обязательны source_id (Top counter ID), строковый goal_id,
type, left/right: целые дни 0–365, left > right. Для remarketing_vk_group и
remarketing_users_list – source_id/type. Для VK source_id является публичным
ID группы (RemarketingVkGroup.object_id), а не внутренним id источника.
Вложенный segment – object_id,
без params. Цикл по собственной ссылке отклоняется до dispatch; другие циклы
и source ACL повторно проверяет VK. Списки/вложенные сегменты читаются по
exact ID и перепроверяются до записи. VK-ссылка требует одного уже
зарегистрированного источника с этим публичным object_id в полном bounded
каталоге; его состояние загрузки остаётся явным в плане. Для других ссылок
plan показывает vk_validation_required, без выдуманного metadata endpoint.

```json
{"kind":"audience","entity":"segments","action":"update","id":10,"payload":{"name":"Новое имя","pass_condition":1}}
```

Добавление одного источника в существующий сегмент:

```json
{"kind":"audience","entity":"relations","action":"create","segmentId":10,"payload":{"object_type":"remarketing_users_list","params":{"source_id":100,"type":"negative"}}}
```

Runtime отправляет documented `{items:[payload]}`. Изменение одной связи:

```json
{"kind":"audience","entity":"relations","action":"update","segmentId":10,"id":20,"payload":{"params":{"type":"negative"}}}
```

Это patch известных params. Источник и неуказанные правила сохраняются;
неизвестные поля не выводятся и не копируются в plan. Полный opaque digest
params обнаруживает конкурентные изменения и потерю неуказанных правил при
read-back. paramsProjectionComplete=false остаётся явным: digest не означает,
что агент разобрал неизвестное условие или получил разрешение его менять.

```json
{"kind":"audience","entity":"relations","action":"delete","segmentId":10,"id":20}
{"kind":"audience","entity":"segments","action":"delete","id":10}
{"kind":"audience","entity":"users-lists","action":"update","id":100,"payload":{"name":"Новое имя списка"}}
{"kind":"audience","entity":"users-lists","action":"delete","id":100}
```

DELETE сегмента не допускается с campaign_ids или непрочитанной usage.
Удаление последней связи/связи при слишком большом pass_condition отклоняется
до dispatch. Вложенные зависимости сегмента и зависимости списка от аудитории/
look-alike проверяет VK; 409 сохраняется как отказ, без каскадной очистки.
pending_delete/deleting не является завершённым удалением и блокирует новую
запись. Сохраняется прежний operation ID; GET-only reconcile ожидает deleted
либо документированный 404 exact ранее прочитанного объекта. 403, timeout,
пропавший parent/endpoint списка связей и неполная выборка не доказывают удаления.

## Источник подписчиков VK-сообщества

Определения проверены 16 октября 2026 по официальным
[VkGroup](https://target.my.com/doc/api/ru/resource/VkGroup),
[RemarketingVkGroups](https://target.my.com/doc/api/ru/resource/RemarketingVkGroups),
[RemarketingVkGroup](https://target.my.com/doc/api/ru/object/RemarketingVkGroup) и
[SegmentParams](https://target.my.com/doc/api/ru/info/SegmentParams#vk_group).
Эти страницы используют публичный `/api/v1/documentation.json?_language=ru`.
Текущий каталог документации ads.vk.com не включает эти source resources,
хотя SegmentRelations сохраняет тип remarketing_vk_group. Это граница
документированного наследуемого API, а не доказательство доступности метода
в нынешнем кабинете VK Ads. Runtime использует только фиксированный ads.vk.com;
403/404 не разрешает переход на myTarget, cookie/browser или социальный API.

`vk-groups --query example_group` читает `/api/v2/vk_groups.json?_q=...`.
Можно передать shortname, положительный публичный ID, club/public/event-ID
или exact https://vk.com/shortname. URL разбирается локально и не открывается.
Выбирается только один exact shortname либо публичный ID. Похожее название
не выбирается. `resolved=null`/ambiguous сохраняют неопределённость; пустой
поиск не доказывает отсутствие сообщества. Старый официальный контракт
называет порог 1000 участников, но текущие ответы могут содержать меньшие
сообщества; этот порог не становится правилом допуска. Наличие строки не
означает, что источник зарегистрирован, подписчики загружены или реклама разрешена.
items показывает до 20 кандидатов, весь ответ ограничен 14 000 bytes;
resolved остаётся доступным и после preview. scannedCount/scanTruncated
описывают поиск в пределах --limit, truncated – сокращение вывода.
При неполном сканировании увеличь --limit; это не увеличивает preview.

`sources --type vk-groups` возвращает bounded зарегистрированные источники.
`--id` адресует внутренний id; exact чтение идёт через `_id__in` коллекции,
как в first-party source picker. Отдельный resource документирует DELETE,
поэтому GET на одиночный source endpoint не придумывается. Читаются только
id/object_id/name/shortname/status/loaded_users_count/users_count.

Для регистрации сначала разреши публичную группу и сверяй ссылку с выбранным
пользователем сообществом. Затем подготовь отдельный план:

```json
{"kind":"audience","entity":"vk-groups","action":"create","groupQuery":"example_group","payload":{"object_id":101}}
```

101 здесь синтетический публичный ID. Runtime повторно получает exact группу
из рекламного справочника и полный bounded список источников, запрещает
дубли и сохраняет identity digest каталога без названий чужих источников.
Перед apply проверяются те же условия. POST `/api/v2/remarketing/vk_groups.json`
содержит только object_id. Ответ даёт внутренний source id, который сохраняется
до GET read-back. `verified` означает проверенную регистрацию; это не запуск
кампании и не доказательство окончания загрузки.

readiness.state различает loading/unloaded, loaded_empty, loaded_nonempty,
loaded_size_unknown и unknown. Отсутствующий/отрицательный размер не становится
нулём. Loaded_nonempty требует status=loaded и положительного
loaded_users_count. Даже он сохраняет campaignEligibility=not_assessed:
соответствие офферу, достаточность аудитории, модерация и доставка проверяются
отдельно. Для ожидания загрузки повторяют только sources с тем же внутренним
id, не регистрацию. Автоматическое расширение на похожие сообщества отсутствует.

В опубликованном source contract status является read-only. Коллекция
документирует GET и POST регистрации, отдельный resource – DELETE; отдельная
команда начала загрузки и срок обработки не установлены. Loading означает
текущую загрузку, unloaded – отсутствие загруженного списка; unloaded сам по
себе не доказывает, что загрузка уже поставлена в очередь. Не создавай новый
источник, не угадывай /load и не активируй рекламу ради начала загрузки.
Дальнейшая безопасная проверка – sources --type vk-groups --id с тем же
registration id. Неизменный unloaded остаётся внешним ограничением VK;
причина и следующий поддерживаемый шаг уточняются в поддержке VK с exact ID.

После регистрации сегмент использует публичный object_id:

```json
{"kind":"audience","entity":"segments","action":"create","payload":{"name":"Согласованный сегмент","pass_condition":1,"relations":[{"object_type":"remarketing_vk_group","params":{"source_id":101,"type":"positive"}}]}}
```

В прочитанной связи relation.object_id – ID вложенного объекта API, а не
RemarketingVkGroup.id регистрации. Его точная внутренняя структура не
разбирается. Для метаданных runtime сопоставляет публичный params.source_id с
RemarketingVkGroup.object_id в полной уникальной выборке. Это соответствует
first-party GroupModel.isMyRelation: проверяются тип и public source_id,
не равенство relation.object_id и registration id. Отсутствие/неполнота/дубли
сохраняют явное ограничение. Никакие ID в сохранённых записях не переписываются.

Удаление источника адресует внутренний id, например:

```json
{"kind":"audience","entity":"vk-groups","action":"delete","id":901}
```

DELETE `/api/v2/remarketing/vk_groups/901.json` не выполняет каскадную очистку.
VK возвращает 409 для используемого в аудитории источника. Сначала отдельно
удаляй только согласованные тестовые связи/сегменты. Проверка удаления требует
отсутствия exact id в полной коллекции; 403/404 коллекции или missing count
оставляют результат непроверенным. При известном id reconcile делает только
GET; потерянный id создания остаётся manual без повторного POST и поиска
похожего результата. Обновление, bulk registration, тематики и выгрузка людей
этим узким source contract не реализованы.

## Явная цель Top@Mail.ru

```json
{"kind":"goal","entity":"groups","id":1,"counterSourceId":70,"goalId":3}
```

entity допускает groups или plans. counterSourceId – внутренний Counter.id;
runtime читает его exact metadata, берёт Counter.counter_id как priced_goal
source_id и находит exact goalId в целях этого Top counter. name строится как
condition:substr, не из имени цели. Частичный каталог отмечен goalsTruncated:
известная цель с точным ID может быть прочитана в нём, полнота каталога не
обещается. Неизвестная/нечитаемая цель не подменяется похожим названием.

План содержит конкретный priced_goal и состояние/working счётчика, реальные
поля цели и текущую настройку кампании/группы. working=false и goal_type не
доказывают готовность доставки или завершение бизнес-регистрации. Источник,
цель и target snapshot перепроверяются до dispatch. Записывается только
priced_goal; смены objective/package/autobidding или сайта не выполняются.
Не устанавливай «регистрацию» по package_priced_event_type, событию входа или
названию. Effective стратегия по одному тарифу не выводится. Очистка цели,
мобильный tracker и автоматический fallback на другой источник не поддержаны.

## Журнал и проверка

POST/DELETE выполняется один раз, с persisted unknown до dispatch. Известные
ID update/delete/goal доступны recovery после timeout; GET-only проверяет
точный target и поля. Потерянный ID create остаётся manual даже при известном
родителе: поиск по имени/похожему условию и повтор создания запрещены.
Mutation response сохраняется только как назначенный ID; users/history/raw
payload не попадают в receipt. Сегмент/relations требуют complete bounded
snapshot, максимум 500 связей; source lookups не рекурсивны. Соседние связи и
неуказанные правила проверяются после изменения. Эти optimistic проверки не
обещают atomic CAS API и не заменяют отдельную человеческую authority.

Таргетинг, исключения и pads уже меняются прежним groups update полной секции
targetings; сохрани остальные поля. Тексты/content/urls – прежний banners update.
Новый CRUD не расширяет разрешение менять бюджет, запускать показы либо
редактировать другие кампании.
