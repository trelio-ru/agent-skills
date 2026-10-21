  `coverage.complete=false` и `hasMore=null` означают, что Telegram не даёт
  доказательства исчерпывающего поиска: пустая выдача не доказывает отсутствие
  чата. Для полного обзора используй metadata-инвентарь
  `dialogs --archive-scope active --limit 100`, затем продолжай exact
  `coverage.nextCursor` через `--cursor`. На verify-страницах список пуст,
  но требуется продолжение до `verificationComplete=true`. Только
  `coverage.complete=true` подтверждает совпавшие проходы; при
  `inventory_changed` обзор неполон. `snapshotAtomic=false` сохраняет
  отсутствие транзакционного снимка. Строки показывают `archived`, `folderId`,
  marked `id` и `lastMessageAt`; прочитанность не сужает обзор. Не подменяй
  инвентарь поиском названий. Для поиска с ограничением архива также доступен
  `--archive-scope active|archived`, но search не становится исчерпывающим.
- Ошибка `TELEGRAM_CHAT_RESOLUTION_FAILED` не доказывает отсутствие чата или
  запрет доступа. Выполни её exact `nextAction`: найди чат через
  `dialogs --query` по видимому названию либо username, затем повтори исходную
  команду с exact `dialogs[].id` или `@username`. Не добавляй и не удаляй
  `-` / `-100`, чтобы угадать Telegram peer type; пустой поиск также не
  превращай в доказательство отсутствия.
- Для поиска по автору внутри exact чата добавляй `--from ID_OR_USERNAME`
  (включая `me`). `--since`, `--until`, `--timezone` и
  `--media-type any|photo|video|document|voice|round-video|audio|url` работают
  во всех областях. Даты задают полуоткрытый период
  `since <= date < until`; дата без offset использует выбранную IANA timezone
  (`Europe/Moscow` по умолчанию), UTC-границы возвращаются в `filters`.
  Например: `search --chat EXACT --from @USERNAME --media-type document
  --since 2026-08-01 --until 2026-09-01 --timezone Europe/Moscow`.
  Global API не поддерживает автора: `--global --from` отклоняется, а не
  подменяется неполным поиском только по личным чатам. `--from` поддерживается
  для выбранных чатов и пользовательской папки. Для нескольких чатов повторяй
  `--chat`, например `search --chat @TEAM --chat @LEGAL --query "договор"
  --since 2026-08-01 --until 2026-09-01`.
  В личных чатах и при сочетании автора с типом файла Telegram не умеет
  надёжно применить оба условия на сервере. Runtime проверяет автора по
  результатам узкого серверного поиска; `coverage.authorFilter=bounded_local`
  (для нескольких чатов – `coverage.chats[].authorFilter`)
  явно обозначает это. Одна логическая страница проверяет до 1000 native hits,
  общий потолок выбранных чатов – 10 000 на вызов. Пустая промежуточная
  страница с offset продолжается автоматически. Границы дат
  в exact-chat выдаче дополнительно проверяются локально.
- `--pages 1..10` (по умолчанию 3) ограничивает автоматическое продолжение для
  каждого чата либо global scope; `--page-size 1..200` (по умолчанию 100) –
  совпадения страницы, а `--limit` – весь ответ. Если есть `nextCursor`,
  продолжай с ним тот же query, references и normalized filters. Для одного
  exact чата также допустим `--before-id` из `nextBeforeId`; не смешивай его
  с cursor и не используй для folder/multiple/global scope. При
  `cursorLimitReached=true` сузь запрос. Не редактируй tokens и не подменяй
  недоступный чат другим. Проверяй `coverage.status`, `summary`, `complete`
  и `incompleteReasons`: только `absenceProven=true` позволяет сказать,
  что совпадений нет. Пустая partial/unavailable выдача этого не доказывает;
  `hasMore=null` означает неизвестное продолжение. Отдельная страница
  продолжения не доказывает полноту всего запроса.
- Global search выполняется Telegram server-side, не требует заранее знать
  чат и не подменяется перебором `dialogs`. Secret chats в него не входят.
  Каждый элемент `messages[]` содержит безопасный `chat`. Если
  `coverage.hasMore=true`, продолжай тот же нормализованный запрос exact
  `--cursor` из `coverage.nextCursor`, сохраняя query и все фильтры;
  не редактируй и не смешивай cursor разных запросов. На каждой странице учитывай `pageComplete`,
  `cursorLimitReached`, `incompleteReason`, `seenBefore` и `seenThrough`.
  Дедуплицируй временную совокупность страниц по `chat.id + message id`, потому
  что `snapshotStable=false`; не создавай постоянный индекс переписки.
- Если цель – понять ход обсуждения по теме, а не только найти упоминания,
  используй `search ... --limit 1..10 --context 10`. Runtime для каждого
  результата возвращает `context.groupIndex`, `matchIndex` и отдельный
  `context.coverage`. Хронологические сообщения находятся в
  `contextGroups[groupIndex].messages[]`: пересекающиеся окна одного чата
  объединены, все найденные реплики отмечены `isMatch=true` и перечислены в
  `matchIds`. Одинаковые IDs разных чатов не объединяются. Контекст
  разворачивается только для текущего ответа; при
  `contextCoverage.complete=false` либо per-hit `coverage.complete=false`
  прямо назови недоступную сторону окна.
  `--context 0..10` работает во всех областях поиска. Exact
  `read --context` сохраняет отдельное `context.messages[]`.
- Чтобы узнать количество подписчиков канала либо участников группы/супергруппы,
  используй `audience-count --chat ID_OR_USERNAME`. Команда читает свежую
  metadata exact чата, не выгружает список людей, не читает историю, не вступает
  в канал и не отправляет read receipts. `audience=subscribers` означает
  подписчиков, `audience=members` – участников. `count` – целое число на момент
  `observedAt` (UTC), `countSource` указывает поле Telegram. `count=0` при
  `available=true` – известный ноль; `available=false`, `count=null` и `reason`
  означают недоступный счётчик. Не вычисляй его по длине `members`, просмотрам
  или cached entity и не обходи отказ через Telegram Web/UI. Скрытый список
  подписчиков сам по себе не означает, что общий счётчик недоступен.
  Это текущий размер аудитории, без истории роста/отписок или списка людей.
- Для просмотра состава exact группы, супергруппы или канала используй
  `members --chat ID_OR_USERNAME`; при необходимости добавь поиск по видимому
  имени либо username через `--query` и bounded `--limit 1..200`.
  `audience=members`
  означает участников группы, `audience=subscribers` – подписчиков канала.
