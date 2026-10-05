# Команды WhatsApp

JSON передаётся через `request --session ID --input ABSOLUTE_FILE`.
`limit` – целое 1..100 (по умолчанию 20). ID чата берётся из результата
навыка (для собственного чата – `me`): телефонный `…@s.whatsapp.net`, непрозрачный `…@lid` или группа `…@g.us`.
Не конструируй телефон из LID и не приравнивай похожие имена к одному человеку.

| command | Поля |
| --- | --- |
| me | без полей; возвращает chatId подключённого аккаунта и isSelf=true |
| dialogs | optional query, limit, cursor |
| contacts | query, optional limit, cursor |
| read | chat, optional limit, before=message ID |
| unread | optional limit (не больше 20 сообщений на выбранный чат) |
| search | query, optional chat, limit, cursor, since/until=RFC 3339 с offset |
| resolve | phone=точный международный номер +…; возвращает подтверждённый chatId |
| history-fetch | chat, optional before=известный message ID, limit |
| history-status | requestId из history-fetch |
| receipts | chat группы, messageId собственного сообщения, optional limit, cursor |
| blocklist | optional limit, cursor |
| group-invite | chat группы |
| group-invite-info | invite=код либо ссылка https://chat.whatsapp.com/… |
| members | chat группы, optional limit |
| download | chat, messageId, output – новый абсолютный файл |
| result | requestId – проверка поданной операции и server acknowledgement |
| policy | без mode читает; mode=`confirm/read-only` + confirm=true меняет |
| send | chat, text; либо file + mimeType + fileName + optional mediaType, text как допустимая подпись; либо contact={name,phone} |
| reply | chat, messageId исходного сообщения, text |
| react | chat, messageId, text=emoji; пустая строка снимает реакцию |
| edit | chat, messageId собственного сообщения, text |
| delete | chat, messageId собственного сообщения |
| forward | chat источника, messageId, target=exact чат назначения |
| create-group | title, participants=[exact individual IDs] |
| member-add / member-remove / member-promote / member-demote | chat группы, participants=[exact individual IDs] |
| chat-update | chat группы, ровно одно из title / description |
| chat-settings | chat, ровно одно archive=boolean / pin=boolean / muteUntil=Unix milliseconds либо null для отмены mute |
| block | chat человека, blocked=boolean |
| group-invite-revoke | chat группы; возвращает новую ссылку |
| group-join | invite=код либо ссылка; preview проверяет группу |

`me` читает только нормализованный chat ID текущего подключённого аккаунта.
Device ID, credentials и сырой SDK-профиль не возвращаются. Без соединения или
достоверного account ID команда завершается ошибкой; контакты по имени не
используются как fallback. Этот exact ID разрешён для чтения/отправки себе
даже до появления собственного чата в локальной синхронизации.

Все mutations требуют `requestId` – новый UUID для одного логического
действия. `dryRun:true` возвращает payload и `approvalHash`; исполнение
использует исходный requestId и `confirm:true,approvalHash:HASH`.
Хеш действует пять минут в той же рабочей сессии; изменение target/body/file
отменяет подтверждение. Preview нужен для каждой mutation. `confirm:true`
подтверждает полномочия этого вызова: согласованное содержимое либо прямое
разрешение на отправку в текущем разговоре оператора с агентом. Оно не
сохраняется в policy; другие разговоры его не наследуют. Для structural
mutations требуется отдельное согласование действия. Агент не предлагает
отправку без согласования по своей инициативе.

Пример чтения: `{"command":"read","chat":"ID_FROM_DIALOGS","limit":10}`.
Пример preview: `{"command":"send","chat":"ID_FROM_DIALOGS","text":"Текст пользователя","requestId":"UUID","dryRun":true}`.
Пример исполнения: тот же JSON без dryRun, с `confirm:true,approvalHash:HASH`.

`resolve` проверяет номер у WhatsApp и сохраняет разрешение на exact chat ID
на десять минут в текущей сессии. Контакт в адресную книгу не добавляется.
Проверка не разрешает отправку сама по себе.

`mediaType` по умолчанию `document`. Поддерживаются document (64 MiB), image
(JPEG/PNG/WebP, 16 MiB), video (MP4, 64 MiB), audio (MP3/MP4/Ogg/WAV, 16 MiB),
voice (Ogg Opus, 16 MiB), sticker (WebP, 1 MiB), contact (name и phone=+…).
Runtime проверяет заголовок формата и hash содержимого; перекодирования нет.
Подпись разрешена у document/image/video. Несколько файлов отправляются
отдельными разрешёнными действиями. Download ограничен 32 MiB и не
перезаписывает файл. View-once media не экспортируются и не пересылаются.
Windows в protocol mode, Linux, звонки, статусы, каналы, опросы, геолокация, фоновые задачи и
отложенные отправки не входят в эту версию.

`submitted` означает подачу. Ответ отправки и `result` содержат отдельные
`serverAcknowledged`, `delivered`, `read`, `providerRejected` и числовой nullable
`providerStatus`: 0 – ошибка, 1 – ожидание, 2 – сервер принял, 3 – доставлено,
4 – прочитано, 5 – воспроизведено. `verified=true` в ответе отправки означает
только приём сервером. Подтверждение ожидается до трёх секунд, без повторной
отправки; timeout сохраняет неизвестный результат. Отказ не считается успехом,
даже если SDK успел вернуть `state=submitted`. Даже успешная отправка здесь не
разрешает read receipt; unread-state runtime не меняет.

`receipts` отдельно возвращает наблюдения по участникам группы, время доставки
и прочтения, известный состав на момент отправки и counts. Отсутствующий receipt
остаётся unknown; более поздний состав группы не заменяет исходный.
PN/LID объединяются только по локальному подтверждённому mapping WhatsApp.

SDK отдаёт ограниченную синхронизацию устройства. `before` листает уже имеющуюся
локальную историю, а не запрашивает произвольную старую историю у WhatsApp.
Имена, счётчики и отсутствие результатов могут отражать неполную синхронизацию.
Страницы ограничены также размером JSON без обрезания текста сообщений:
`read.coverage.nextBeforeId` продолжает предыдущую страницу. `unread` отдельно
показывает число чатов с неизвестным счётчиком и покрытие истории каждого чата.

После сбоя сначала используй `result` с исходным requestId. Новые попытки
сохраняют chatId/messageId до provider call, включая ambiguous outcome.
`serverAcknowledged` проверяется по exact исходящему сообщению в локальной
синхронизации. `false` не доказывает неотправку. Старые записи без ID остаются
неопределёнными; журнал не очищается и новый UUID ради повтора не создаётся.

`cursor` непрозрачен и связан с командой, query, chat/message и датами; передавай
его без изменений с теми же фильтрами. При изменившемся наборе возможна ошибка
курсора – начни чтение заново. `history-fetch` запрашивает у телефона страницу
старше before (по умолчанию самого старого известного сообщения). Если нет
якоря, запрос недоступен. Возвращённый requestId проверяется через history-status;
телефон может быть offline. Повтор того же pending-запроса в течение минуты
не создаёт новый; после минуты допустим новый явный запрос чтения. Хранятся
не больше десяти дополнительных страниц по 100 сообщений. Короткая страница
не доказывает начало полного архива. Для следующей используй nextBeforeId.

## Браузер

`start --mode browser` открывает отдельный связанный браузер; первый QR нужен
отдельно от протокольного устройства. Перед сменой режима выполни stop и
проверь closed. По явной просьбе после первого успешного входа допускается
`start --mode browser --headless`; профиль и исходный 30-минутный deadline
защищены так же. `browser_loading` не означает потерю авторизации. При
`browser_headed_login_required` останови сессию и выполняй ручной вход в новом
headed browser. `forget --mode browser --confirm` удаляет только браузерную
локальную привязку; обычный forget – только протокольную.

| command | Поля |
| --- | --- |
| browser-snapshot | output=новый абсолютный приватный PNG; возвращает snapshotId и controls с ref/box |
| browser-scroll | snapshotId, deltaY=-1500..1500 кроме 0, optional x/y |
| browser-click | snapshotId, x/y=координаты свежего PNG |
| browser-type | snapshotId, ref редактируемого поля, text; заменяет содержимое без Enter |
| browser-key | snapshotId, key из списка ниже |
| browser-upload | snapshotId, ref file input, file=абсолютный путь, до 64 MiB |

Допустимые key: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right,
ControlOrMeta+A. Click/type/key/upload требуют UUID requestId, dryRun preview,
затем exact confirm/approvalHash. Browser preview действует две минуты и
связан со снимком, расположением controls и содержимым страницы. Снимок
погашается действием. Изменившаяся страница требует нового наблюдения.
Посмотри PNG перед действием; не угадывай координаты. QR/login screenshot
блокируется, cookies/IndexedDB/CDP и произвольный JavaScript не выдаются.

`result` возвращает журнал этого режима. `applied` означает исполнение UI
действия, а не доказанную отправку; нужен свежий снимок. `ambiguous` не
повторяется. Смена режима не разрешает повторить неизвестную отправку.
Обычный WhatsApp Web может помечать открытые чаты прочитанными. Browser
read-only допускает только snapshot/scroll/result и чтение policy.
