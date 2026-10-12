# Управление аудиторией и явной целью

Runtime 1.3.0. Перед первой такой записью прочитай `reference --name
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
remarketing_users_list – source_id/type. Вложенный segment – object_id,
без params. Цикл по собственной ссылке отклоняется до dispatch; другие циклы
и source ACL повторно проверяет VK. Списки/вложенные сегменты читаются по
exact ID и перепроверяются до записи. Для других документированных ссылок
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
