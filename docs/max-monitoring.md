# Пассивное чтение MAX для цифрового ассистента

Source `max-web` 2.10.0 добавляет bounded read primitive `monitor`, а не готовый
глобальный crawler. Он использует обычный dedicated browser, protected session,
host account selection и WebSocket read guard. Отдельного входа, credentials
store и headless browser transport нет. Полный исполняемый контракт находится
в [обязательной части 09](../platform-skills/max-web/scripts/instruction-guides/part-09.md).

Источник заранее привязан к одному canonical chat URL. Компания, участник,
connection, account и company binding входят в scope hash. Cursor содержит
только scope, последний native message ID и его revision; это обычные read
parameters, не authorization token. Они принадлежат private host state, не
модели, task text или публичным отчётам. Shared host обязан атомарно сохранять
events с nextCursor и дедуплицировать повторный poll.

Первое чтение только устанавливает baseline. Продолжение требует overlap native
ID в текущем bounded DOM window. Pagination не перескакивает через оставшиеся
сообщения; edit последнего anchor учитывается отдельно. Ранние edits/deletions,
первая история после пустого baseline и вытесненный anchor требуют review,
никакого silent reset. Unread badge не является checkpoint. Без реальных IDs
нет text-hash fallback. Body, author display name, quoted text и attachment URL
не выдаются в queue/cursor; semantic hash не даёт права отвечать или раскрывать
информацию. Ни metadata polling, ни durable enqueue не отправляют read receipt.

Native author ID сейчас не извлекается. Значение `ownerIdentityAvailable=false`
не заменяется догадкой по display name, username, forward или chat URL. Поэтому
новые задачи из MAX остаются закрыты; это требование подтверждённой owner
identity, а не ограничение обычного чтения уже привязанной переписки.

Source tests используют synthetic DOM и настоящий общий main-document HTTP
observer pinned v3.4.0. Они проверяют overlap, replay, partial pages, edits,
gap, binding changes, bounded projection и отсутствие receipt/body leakage.
Hosted Linux/macOS/Windows gate проверяет runtime/package contract. Активация
model-free worker, source registration/lease, native owner intake, message ACK
и live MAX smoke — отдельные зависимости; их готовность этими тестами не заявляется.
