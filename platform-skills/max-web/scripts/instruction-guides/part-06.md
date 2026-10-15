1. Через тот же exact `runtimeExecution.localAction` запусти `assist-start` с
   `--fallback-for COMMAND`, всеми exact аргументами выбранной операции и при
   необходимости `--hold-ms`; значение по умолчанию и максимум – `1800000`
   миллисекунд. Для любой mutation обязательно передай `--confirm`. Для
   `edit`, `delete`, `forward`, `create-direct`, `create-group`, `member-add`,
   `member-remove` и `chat-update` сначала выполни обычный `--dry-run`, покажи
   оператору exact payload и передай неизменённый `--approval-hash`. Локальная
   policy `read-only` продолжает блокировать любые изменения.
2. Runtime привязывает session к SHA-256 exact операции, открывает неактивное окно
   в том же dedicated-профиле, сохраняет блокировку
   `READ_MESSAGE`/`READ_REACTION` и возвращает exact `sessionId`, `appName`,
   `interactionMode`, `mutationAuthorized` и `authorizationHash`. Другая
   операция не может переиспользовать активную session.
   Запуск может занять до 45 секунд из-за последовательной загрузки Chrome,
   главной страницы и exact контакта; абсолютный срок session не продлевается.
3. Сразу вызови `assist-status --session UUID`. Для чтения продолжай только при
   `phase=active`, `interactionMode=read-only`, `runtimeReadOnly=true` и
   `interactionGate.installed=true`. Для `members`, `download` и mutation
   продолжай только при `phase=active`, `interactionMode=manual-control`,
   `interactionGate.mode=manual-control`; у mutation дополнительно требуется
   `mutationAuthorized=true`.
4. Управляй уже открытым окном `appName` через native app/computer control
   либо встроенные команды `assist-*`. Session с exact чатом заранее открывает
   его; для действия над сообщением также открывает меню этого сообщения;
   `forward` открывает окно выбора адресата, `chat-update` – форму настроек.
   Если native control не адресует окно или селектор не распознал UI, в любой
   разрешённой операции вызови `assist-snapshot --session UUID` и прочитай
   локальный owner-only PNG. Он показывает до 100 видимых controls с `ref`;
   при открытой форме refs относятся только к ней. Для одного exact шага
   используй `assist-click --ref rN`, `assist-fill --ref rN --text ...`,
   `assist-key`, `assist-scroll` либо визуальные `assist-point-click --x X
   --y Y` и `assist-point-scroll --x X --y Y --delta-y N`. Координаты –
   CSS-пиксели снимка. Каждый вызов требует `--session UUID` и свежий
   `--snapshot UUID`. Read-only gate допускает поиск и переходы по чатам;
   для `contacts` также открывает раздел контактов, а для `profile` – заголовок
   уже выбранного exact чата. Остальные действия чтения не получают mutation
   полномочий. Mutation требует исходного `--confirm` и approval hash, где нужен.
   Для меню сообщения в разрешённой mutation или download используй
   `assist-contextmenu --ref rN` либо `assist-point-contextmenu --x X --y Y`.
   Для `members` session уже открыла exact чат и детали. Если ответ содержит
   `inspectionMode=visual`, разметка панели не распознана, но снимок доступен.
   При `preparationIssue` визуальный click может сначала открыть только
   заголовок exact чата. Затем `assist-point-click` открывает «Участники», а
   `assist-point-scroll` прокручивает видимый список; не называй его полным без
   проверки конца. `member-add` уже открыл exact чат и picker. Snapshot живёт
   не более двух минут, привязан к текущему DOM/геометрии и расходуется одним
   действием. После каждого действия получай новый снимок. Если строка не
   доказывает identity exact бота, не нажимай финальное «Добавить». Не создавай
   browser tab, не подключайся к другой browser session и не меняй URL. Выполни
   только exact разрешённую операцию и не осматривай несвязанные диалоги.
   Дополнительные окна и уход с
   `web.max.ru` runtime блокирует. Для `--file`/`--avatar` runtime подставляет в
   file chooser только exact заранее разрешённые локальные файлы. Для
   `download` он сохраняет только один файл в exact новый `--output`, не
   перезаписывает существующий путь и возвращает размер и SHA-256.
   Внутренняя ссылка файлового сервера обрабатывается только разрешённым
   download transfer. `MAX_ASSIST_ACTION_BLOCKED` означает, что gate остановил
   действие; сначала проверь свежий live-state, не считай click успешным.
   Снимок download связан с выбранным сообщением: refs и point-click доступны
   только его файловым кнопкам. Обновления других чатов не мешают проверке;
   замена сообщения возвращает `MAX_ASSIST_DOWNLOAD_TARGET_CHANGED`.
   В этом режиме ввод текста запрещён, из клавиш доступен только Escape.
   При `MAX_ASSIST_SNAPSHOT_STALE` либо `MAX_ASSIST_TARGET_INVALID` получи новый
   `assist-snapshot` в той же session и заново выбери ref или координаты по нему.
   Старый ref/точку не переноси на новый снимок и не повторяй прежний пакет.
   `actionApplied=false` относится только к отвергнутому шагу до UI-действия:
   это не доказательство результата предыдущей отправки. Если отказ повторился
   после свежего снимка, проверь `assist-status`, текущую surface и оставшийся
   срок session; не зацикливай click и не расширяй полномочия. При неоднозначной
   отправке сначала проверь exact чат – не отправляй повторно без проверки.
5. После действия проверь live-state. Не повторяй mutation автоматически при
   неоднозначном результате. Перед остановкой дождись
   `transfersPending=0`; для download проверь returned metadata. В `finally`
   всегда вызови `assist-stop --session UUID`; он удаляет снимки. Если native
   control недоступен и in-session control не может безопасно выполнить exact
   действие, gate блокирует его, окно ушло с `web.max.ru` либо результат остался
   неоднозначным – останови session и сообщи ограничение без другого обхода.
