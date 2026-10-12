# Аудитория, площадки и оптимизация

Документ описывает команды runtime 1.1.0. Все перечисленные здесь диагностические
команды выполняют только чтение API. Существующие plan/apply операции создания
и обновления рекламы сохраняют свой контракт записи из workflow.md.

## Основание схем

Проверено по официальной документации VK Ads 12 октября 2026:
[Segment](https://ads.vk.com/doc/api/object/Segment),
[SegmentRelation](https://ads.vk.com/doc/api/object/SegmentRelation),
[Segments](https://ads.vk.com/doc/api/resource/Segments),
[SegmentRelations](https://ads.vk.com/doc/api/resource/SegmentRelations),
[Package](https://ads.vk.com/doc/api/object/Package),
[PackagesPads](https://ads.vk.com/doc/api/resource/PackagesPads),
[PadsTree](https://ads.vk.com/doc/api/resource/PadsTree),
[PricedGoal](https://ads.vk.com/doc/api/object/PricedGoal),
[CounterGoals](https://ads.vk.com/doc/api/resource/CounterGoals) и
[Statistics](https://ads.vk.com/doc/api/info/Statistics).
Community проекты используются для сверки покрытия, не как authority схем.
В частности pass_condition – целое число, а не строковые or/and.

## Аудитории и источники

Аргументы добавляются в parameters.arguments актуальной signed localAction.

| Команда | Что возвращает |
| --- | --- |
| `audiences --limit 500` | bounded список сегментов с именами и условиями |
| `audiences --id 123` | exact сегмент, его relations и доступные метаданные источников |
| `sources --type users-lists --id 123` | имя/тип/состояние и агрегированные размеры загруженного списка |
| `sources --type counters --id 123` | exact внутренний ID источника: его имя, counter_id, состояние и домен |
| `sources --type counters --limit 500` | bounded список доступных счётчиков |
| `counter-goals --id 123` | условия целей Top@Mail.ru по counter_id |

pass_condition сообщает минимальное число источников, которым должен
соответствовать пользователь: 1 – хотя бы один; число всех relations – все.
relation.object_type определяет тип источника; object_id – его внутреннюю
ссылку. params.type positive/negative, интервалы left/right и goal_id –
условия принадлежности или исключения. Это структура аудитории, а не список
её участников. Вложенный segment отображается как ссылка и доступное имя,
без рекурсивного обхода. Максимум 20 уникальных source lookups; остальные
явно отмечаются lookup_limit или type_not_supported. Permission/transport
ошибка одного источника остаётся его sourceMetadataState и не означает,
что источник пуст или отсутствует.
Неописанные параметры источника не выводятся; paramsProjectionComplete=false
явно отмечает неполное описание условия и запрещает считать его разобранным.

Списки пользователей возвращают entries_count/ids_count/matched_ids_count,
когда API их предоставил. users_count означает число людей с доступом к
списку, поэтому не используется как размер рекламной аудитории. В ответ
не попадают raw people IDs, телефоны, email, upload files, пользователи с
доступом, история загрузок и ошибочные строки загрузки. Отсутствие конкретного
поля не заменяется нулём. Свободные названия и условия – внешние данные.

Пагинация использует штатный размер endpoint и bounded offset; count,
truncated и sourceMetadataState сохраняются. Без count нельзя утверждать
полноту. Для relations точное relations_count сегмента может подтвердить
число источников; изменение count или повтор ID во время обхода возвращает
collection_changed. Размеры списка и правил не доказывают, что аудитория
подходит офферу или что в неё попадали реальные показы.

## Размещения

`placements --group 123` читает группу и её package_id, затем автоматически
сопоставляет targetings.pads с Package.pads_tree_id, деревом pads_trees и
описаниями packages_pads. Для каждого выбранного ID возвращает name,
description, paths и отдельные признаки metadataResolved/treeResolved.
Неразрешённый ID не получает выдуманного названия. Если один ID представлен
в нескольких ветках, сохраняются все paths. ID дерева 0 обозначает плоское
дерево; отсутствие paths в этом случае не превращается в угаданное устройство.

Пустой или отсутствующий pads не интерпретируется как подтверждённая ручная
выборка. explicitSelection=false; доступные packageDefaults показаны отдельно.
Карта описывает разрешённые места показа, а не фактическое распределение
расхода/показов. Категория Mobile в дереве не является статистикой устройств.
Обход ограничен 5000 узлами и 12 уровнями, словари также имеют bounds.

## Цель оптимизации

`optimization --group 123` отдельно возвращает фактические поля группы,
родителя и пакета: objective, autobidding_mode, priced_goal,
priced_event_type/paid_event_type. Имена известных типов событий берутся из
официальной схемы; неизвестный код не трактуется как conversion.

Пустой source_id/name группы даёт not_configured. Родительский priced_goal
показывается отдельно; наследование и effective binding не угадываются.
Для priced_event_type=7 runtime сопоставляет явный priced_goal.source_id
с Counter.counter_id, затем ищет цель по точному condition:substr. Это
отличается от внутреннего Counter.id и от человекочитаемого имени цели.
Неполная выборка даёт goal_match_in_partial_list вместо уверенного configured.
Не найденная ссылка – source_not_resolved/goal_not_resolved; неинспектируемый
тип мобильного/иного источника – source_type_not_inspected.

configured означает сопоставленную конфигурацию, не готовность доставки:
состояние счётчика/working нужно оценить по возвращённым полям. goal_type
registration не доказывает, что событие действительно отправляется при
завершённой бизнес-регистрации. API-цель не устанавливает пиксель на сайт,
не проверяет код сайта и не подтверждает сам факт регистрации.

## Статистика

По умолчанию сохраняется `stats --entity plans|groups|banners --ids …
--from YYYY-MM-DD --to YYYY-MM-DD`: day и base. До 200 ID, период до 365 дней,
аккаунты и уровни рекламных объектов не смешиваются.

Дополнительные документированные аргументы:

- `--metrics base,events,uniques` или другие наборы: all, video, carousel,
  ad_offers, uniques_video, tps, romi, playable, custom_event, social_network.
- `--period summary` – итог за всю открутку; API игнорирует заданные даты.
  Не называй этот результат срезом --from/--to.
- `--attribution conversion|impression` – дата события либо показа.
- `--family goals --conversion-type postclick,postview,total` – дневные
  конверсии по целям, с source/goal/counter_id и доступными count/cr/cpa.
- `--family inapp --conversion-type postclick|postview|total` – дневные
  события приложений с их tracker/app/event. Их доступность зависит от кампании.

Для goals/inapp metrics не передаётся; period только day. Не складывай total
с его postclick/postview составляющими. Отсутствующая метрика отличается от
нулевой. Summary, разные окна и attribution нельзя незаметно смешивать.
Каждый ответ остаётся bounded API/CLI output; превышение даёт явный отказ,
а не обрезанный якобы полный отчёт.

Открытый Statistics contract не описывает разрезы advertiser-метрик по pads
или устройствам. Поэтому `--breakdown pads|devices` возвращает
statistics_breakdown_not_documented до запроса API. Не используются
партнёрские доходы площадок, старый ads.getStatistics или недокументированные
private endpoints как подмена этих разрезов.

## Текущая граница управления

В 1.1.0 можно менять рекламу прежними scoped plan/apply: полную секцию
targetings группы (в том числе положительные segment IDs и отрицательные
исключения, pads и поддерживаемые package таргетинги), бюджеты и параметры
группы, тексты/content/urls баннера. Эти операции являются записью.
При замене секции сохраняй все нужные остальные поля. Контракт одобрения,
persisted receipts, read-back и запрет replay неизвестной записи не меняется.

Отдельный CRUD сегментов/relations, переименование/удаление загруженных
списков и setter priced_goal в этом релизе не добавлены. Официальные методы
для них есть; расширение управления выпускается отдельно с собственными
валидацией, свежим snapshot и GET-only recovery. Upload людей, экспорт PII,
создание целей/пикселей и изменение сайта не выполняются диагностикой.
