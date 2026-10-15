HTTP-ошибка рабочего документа не закрывает сессию. Чтобы уйти с 404 на другую
официальную страницу, используй `page --session ID --navigate URL` (либо private
JSON `action=navigate`). Для read-only URL snapshot ошибочной страницы не нужен;
затем продолжай обычный `script`/`snapshot`. Полный `script` до этого остаётся
закрыт, поскольку получает доступ к текущему ошибочному документу. Writable route,
активная ЕСИА и auth-страница не получают исключения. После перехода новая
HTTP-ошибка возвращается отдельно; новый login, browser и повтор отправки не нужны.

## Совместимость

Runtime поддерживает macOS с Chrome и Windows 10/11 x64 с Edge; нужен Node.js
>=22. `start --channel chrome|msedge` выбирает установленный браузер. Linux и
cloud-only завершаются fail-closed. Одна сессия живёт максимум 30 минут от
`start`; команды и сон не продлевают срок. Native guardian закрывает owned
browser/worker при expiry, crash или hang. Подробности –
[контракт runtime](../../references/secure-runtime.md).

После pending выполняй `continuation.arguments` того же localAction: wait
наблюдает результат без сообщения «заполнил». Правила – в references.
