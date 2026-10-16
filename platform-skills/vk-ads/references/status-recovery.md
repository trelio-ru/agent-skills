# Ограниченное восстановление установки статуса

Runtime 1.5.0. Отдельная записывающая операция через обычные plan/apply,
не автоматический HTTP retry. До подготовки прочитай этот документ и workflow.
Применима только к существующей кампании plans в режиме ad_groups: исходный
update содержал ровно status:active, исходное состояние было blocked, после
отправки остался unknown. Создание, mixed patch, удаление, бюджеты, другие
сущности, written_unverified, принятый unknown и второй recovery закрыты.

## Основание и ограничение

Официальные [AdPlan](https://ads.vk.com/doc/api/object/AdPlan) и
[ресурс AdPlan](https://ads.vk.com/doc/api/resource/AdPlan) описывают writable
status и POST изменения одного существующего ID. Создание использует другой,
коллекционный ресурс. Повторное присваивание active этому ID имеет тот же
запрошенный конечный статус и не создаёт объект. Это основание узкого
desired-state восстановления, не обещание VK об exactly-once запросе.
[HTTP semantics 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
различает семантику конкретной операции и HTTP method; само слово POST не
устанавливает допустимость повторного присваивания.

VK не объявляет idempotency key, чтение результата по transaction ID либо
atomic If-Match/CAS этого setter. Blocked не доказывает, что первый запрос
никогда не применялся. originalRequestOutcome остаётся unknown. Проверки
до/после оптимистические: конкурентная внешняя правка между GET и POST
возможна, транзакционная изоляция не обещается.

## Разрешение и свежий план

Нужно сохраняющееся прямое поручение включить именно эту кампанию в пределах
согласованного дерева, бюджетов, дат и рекламы. Не спрашивай повторно уже
данное разрешение. Разработка/публикация навыка или чтение не разрешают live
apply. Отмена запуска, новый расход, другие дети или условия требуют отдельного
решения. Путь не выбирается автоматически после любого network error.

Сначала receipt и exact GET. Если active уже возвращается, обычный GET-only
reconcile исходной операции завершает проверку без дополнительной записи.
Если blocked сохраняется, подготовь закрытый JSON с ID свежего чтения.
Числа и даты ниже синтетические:

```json
{
  "kind":"status-recovery","entity":"plans","id":10,
  "originalOperationId":"original-status-operation",
  "guard":{
    "endDate":"2030-01-03","maximumTotalBudget":"300","maximumDailyBudget":"150",
    "groups":[
      {"id":20,"status":"active","budgetLimit":"100","budgetLimitDay":"50","banners":[{"id":30,"status":"active"}]},
      {"id":21,"status":"blocked","budgetLimit":"100","budgetLimitDay":"50","banners":[{"id":31,"status":"blocked"}]},
      {"id":22,"status":"blocked","budgetLimit":"100","budgetLimitDay":"50","banners":[{"id":32,"status":"blocked"}]}
    ]
  }
}
```

Groups/banners – полный состав, включая оставленных на паузе. Общий и дневной
лимит каждой группы конечны, положительны и точно совпадают с guard; суммы
не превышают aggregate maxima. Окончание каждой группы, явно или от родителя,
не позже endDate и позже текущего UTC calendar day. В последний день этот
узкий путь закрыт из-за неоднозначности account timezone. Parent cap может
отсутствовать: каждый ребёнок имеет конечный cap, полный состав известен.
Ни один budget/date/status ребёнка не записывается.

Plan заново читает кампанию и полный bounded состав: до 20 групп/20 баннеров
в каждой. Нужны count, уникальные ID, exact parent links, ожидаемые статусы,
targeting, media IDs, landing ID/URL, тексты и разрешённая модерация активного
пути. Неполнота/403 не становятся пустым деревом. Operation.review показывает
закрытый snapshot; сравни его целиком с уже разрешённым брифом до apply.
Generated media variants/CDN derivatives не выводятся: сохраняются identity
контента, URL и text roles. Нет широкого fallback аудитории.

## Один дополнительный dispatch

Обычный apply с новым стабильным operation ID принимает только свой
account/scope и неизменённые исходные receipt/hash. План живёт 30 минут.
Другой unknown/written_unverified в аккаунте блокирует recovery. Перед
dispatch повторяется полный snapshot и timestamp родителя; изменение
отклоняется до POST. Исходные operation ID/hash не заменяются.

Под account lock новый receipt и однократная связь с исходным unknown
сохраняются до сети. Отправляется один POST существующего parent ID с телом
{status:active}. Нет nested children, URL/upload, бюджета, другого endpoint.
Новые operation/plan IDs не разрешают повторить recovery. Crash, timeout,
429/5xx и mismatch не дают второй дополнительной попытки.

GET после ответа проверяет active родителя и прежнее дерево. Только
status/updated родителя могут измениться; выбранные остальные настройки,
состав, caps/даты, targeting, media/landing IDs и тексты должны совпадать.
Успех: новый receipt verified; старый resolved_by_status_recovery с
originalRequestOutcome:unknown и currentStateVerified:true. Исходные
plan/hash/dispatchedAt/error сохраняются. Это доказанный текущий результат,
не заявление о результате первого HTTP-запроса.

При новом unknown/written_unverified выполняй только GET-only reconcile
нового operation ID. Он проверит то же дерево и свяжет результаты при успехе.
Reconcile старого operation сам по себе не снимает отдельный pending recovery.
Других apply/recovery в таком состоянии нет. Неизвестность после единственной
дополнительной попытки остаётся блокером, без бесконечных повторов.
Accept-unknown по-прежнему отдельное человеческое решение вне этого workflow.

Реальный write smoke выполняет рабочий чат с live authority. Hosted tests и
read-only plan не доказывают запуск, доставку, модерацию или ненулевую статистику.
