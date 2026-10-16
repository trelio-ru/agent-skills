# Аудитория, площадки и оптимизация

Документ описывает команды runtime 1.4.1. Все перечисленные здесь диагностические
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
[CounterGoals](https://ads.vk.com/doc/api/resource/CounterGoals),
[SearchPhrases](https://ads.vk.com/doc/api/info/SearchPhrases) и
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
| `sources --type search-phrases --id 123` | exact список поисковых фраз с положительными и минус-фразами |
| `vk-groups --query example_group` | справочник публичных групп, exact shortname/ID и отдельный resolved |
| `sources --type vk-groups --id 123` | exact внутренний источник, публичный object_id, загрузка и агрегированный размер |

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

VK-группы используют три разные ссылки: VkGroup.id и
RemarketingVkGroup.object_id – публичный ID; RemarketingVkGroup.id и
relation.object_id – внутренний источник кабинета; relation.id – сама связь.
params.source_id ссылается на публичный ID, поэтому его нельзя подменять
внутренним id. Диагностика relation читает exact внутренний источник и
отмечает vk_group_source_reference_mismatch при конфликте с params.source_id.
Поиск сравнивает только exact shortname/ID; одно название не разрешает выбор.
`--limit` ограничивает сканирование. В items показываются максимум 20 кандидатов
в пределах 14 000 bytes всего ответа; resolved сохраняет exact совпадение даже
после этих первых результатов. scannedCount/scanTruncated описывают просмотренную
выдачу; truncated независимо отмечает сокращение items. При resolved=null и
scanTruncated=true сначала увеличь --limit, не выбирая похожий shortname.
Пагинация и отсутствие count сохраняют truncated. Readiness показывает только
явные status/loaded_users_count, без людей и вывода о готовности показа.
Детали происхождения схем, размеров, регистрации и удаления находятся в
[source contract](audience-management.md#источник-подписчиков-vk-сообщества).

Для remarketing_search_phrases используется params.source_id списка v3,
а не внутренний relation.object_id. Без валидного source_id возвращается
source_reference_invalid; ID и условия не угадываются по названию сегмента.
Команда сначала получает метаданные через search_phrases.json?ids=ID,
затем содержимое exact списка и повторно проверяет те же метаданные.
Изменившийся snapshot даёт collection_changed. Atomic snapshot API не обещает.

items содержит точные phrase и stop_phrases на уровне каждой фразы,
исходные expires, fading, sub и price_coeff, когда они возвращены.
Отсутствующий stop_phrases не превращается в подтверждённый пустой список.
expiresUnit=not_established_by_read_contract: официальный read-пример не
определяет единицу expires. Не пересчитывай число в дни. expansionState=
not_documented: неописанные поля, название, fading или sub не устанавливают
переключатель расширения. Unknown поля отмечают ruleProjectionComplete=false
и не экспортируются. relation.paramsProjectionComplete независимо сохраняет
неполноту условий связи; прочитанные фразы сами по себе её не устраняют.

До 500 правил выводится из ответа не более 5000 items. returnedCount,
itemCountMatchesMetadata и truncated сохраняют границу: несовпадение с
phrases_cnt или отсутствие счётчика не доказывают полноту. errorsCount –
только количество ошибок, без исходных строк. errors=1, CSV, raw error lines
и пользователи не запрашиваются. Список метаданных без ID получает одну
bounded страницу: offset/limit не описаны этим endpoint и не подставляются.

Общие исключения источника читаются отдельно: globalStopPhrases содержит
только строковый root stop_phrases exact ответа того же GET, если поле вернулось.
Это поле объявлено JSON-схемой списка для записи; read-пример показывает лишь
per-phrase stops, поэтому отсутствие root поля не заменяется догадкой о новом
endpoint или словами из имени. Пустые stop_phrases у всех items не доказывают,
что общих исключений нет. declaredStopPhraseCount сохраняет метаданные списка.

globalStopPhrasesState=resolved и globalStopPhraseCoverageComplete=true требуют
точного совпадения с объявленным количеством и отсутствия обрезания.
not_returned даёт null; representation_not_supported скрывает неописанные
объекты/идентификаторы; metadata_count_mismatch, returned_without_count и bounded
оставляют покрытие неполным. До 500 общих строк из массива до 5000;
bounded устанавливает truncated=true. globalStopPhraseScope=source_list_as_returned
отделён от stopPhraseScope=per_phrase_as_returned. Обычный truncated описывает
границу коллекций; сам по себе он не означает разобранные все правила.
Unknown поля и relation.paramsProjectionComplete остаются независимыми.

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
Если дерево пакета не возвращено словарём, treeComplete=false и treeState
отмечает отсутствие либо частичный словарь. Доступные имена площадок всё равно
читаются независимо. Неизвестный формат необязательных patterns не скрывает имя
и не выводится как произвольная вложенная структура.

## Цель оптимизации

`optimization --group 123` отдельно возвращает фактические поля группы,
родителя и пакета: objective, autobidding_mode, priced_goal,
priced_event_type/paid_event_type. Имена известных типов событий берутся из
официальной схемы; неизвестный код не трактуется как conversion.
optimizedEvent имеет явный optimizedEventScope=package_priced_event_type:
это характеристика пакета, не установленная effective стратегия группы.
paidEvent отдельно описывает документированный код оплачиваемого события;
неизвестное значение, включая недокументированный -1, остаётся unknown.
strategy показывает реально прочитанные autobidding_mode группы/родителя.
Эффективная цель не устанавливается только по тарифу или коду пакета.

Пустой source_id/name группы даёт not_configured. Родительский priced_goal
показывается отдельно; наследование и effective binding не угадываются.
Если API вообще не вернул поле priced_goal группы, состояние
group_goal_not_returned означает пробел чтения, а не доказанную пустую настройку.
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

Можно менять рекламу прежними scoped plan/apply: полную секцию
targetings группы (в том числе положительные segment IDs и отрицательные
исключения, pads и поддерживаемые package таргетинги), бюджеты и параметры
группы, тексты/content/urls баннера. Эти операции являются записью.
При замене секции сохраняй все нужные остальные поля. Контракт одобрения,
persisted receipts, read-back и запрет replay неизвестной записи не меняется.

Отдельный scoped CRUD сегментов/relations, переименование/удаление загруженных
списков и setter Top priced_goal описаны в [управлении аудиторией](audience-management.md).
Для них нужны собственный план/authority, свежий snapshot, persisted receipt
и GET-only recovery. Это write-операции, отдельные от чтения диагностики.
Upload людей, экспорт PII, создание целей/пикселей и изменение сайта не выполняются.
