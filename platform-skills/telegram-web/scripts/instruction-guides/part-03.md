Управляй только уже открытым окном текущего навыка через native app control
либо `assist-snapshot --session UUID` и встроенные пошаговые команды. Снимок
возвращает локальный owner-only PNG и до 100 видимых controls с `ref`. Прочитай
его; вызови `assist-click --ref rN`, `assist-fill --ref rN --text ...`,
`assist-key`, `assist-scroll`, `assist-point-click --x X --y Y` либо
`assist-point-scroll --x X --y Y --delta-y N` с exact `--session UUID` и
свежим `--snapshot UUID`. Координаты – CSS-пиксели снимка. Один снимок
разрешает одно действие и живёт максимум две минуты; после шага снимай экран
заново. Read-only gate разрешает поиск и переходы по чатам; для `contacts`
также открывает одноимённый раздел в боковой панели. Для
mutation сохраняются исходные `--confirm`, policy и approval hash.
Для меню сообщения в подтверждённой mutation или download используй
`assist-contextmenu --ref rN` либо `assist-point-contextmenu --x X --y Y`.
Не открывай другой браузер или вкладку, не переноси cookies и не меняй URL.
Выполняй только указанную операцию, проверь живой результат и в `finally`
вызови `assist-stop --session UUID` после завершения передач файлов. Session
закрывается по исходному deadline и не добавляет полномочий. Если gate
заблокировал действие или результат неясен, остановись без автоматического
повтора и смены Telegram-транспорта.

Этот контракт одинаков для local Codex и local Claude Code.

При HTTP-ошибке основной страницы сохраняй numeric `httpStatus` и разрешённый origin из runtime. HTTP 5xx не доказывает logout, не разрешает сброс доступа, новый вход, смену транспорта или повтор неизвестной mutation. Timeout/DNS/reset не имеют HTTP-кода; ошибки ресурсов и iframe не определяют состояние портала.
