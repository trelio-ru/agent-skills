- `TELEGRAM_WINDOWS_NATIVE_FAILURE` означает аварийное завершение локального
  Python process с `0xC0000005`, а не отказ Telegram или ограничение read-only.
  Укажи безопасные code/stage; не угадывай компонент, не сбрасывай вход или
  policy и не повторяй mutation автоматически. Неполный stdout не является
  полученной перепиской.
- `export` может работать дольше одного окна command host. Если host вернул
  descriptor живого процесса, например Codex `session_id`, дочитывай тот же
  process штатным continuation primitive. В Codex используй `write_stdin` с
  exact `session_id` и накапливай stdout chunks по порядку. Пустой или
  промежуточный chunk – не JSON-результат и не ошибка.
- Разбирай JSON только после завершения исходного процесса с нулевым exit code
  и полным непустым stdout. Ошибка разбора промежуточного chunk не разрешает
  потерять descriptor или начать новую команду.
- Пока процесс жив или результат не установлен, не запускай второй Telegram
  process для той же identity/session и не повторяй export из-за timeout.
  `This Telegram session is already used by another process` означает, что
  нужно дождаться владельца session lock.
- Исчезновение PID не доказывает успех. Нужны zero exit, валидный полный JSON и
  completeness-поля. Если descriptor потерян, сначала установи завершение
  исходного process; blind retry запрещён даже для read-only команды.

## Экспорт периода

- Для чтения всех неархивированных облачных чатов за период используй
  `export --all-dialogs --archive-scope active --since YYYY-MM-DD
  --until YYYY-MM-DD --timezone Europe/Moscow`. Exact выборка – повторяемый
  `--chat ID_OR_USERNAME`; архивная область также проверяется до history
  для сохранённого ID. `--archive-scope all|active|archived` по умолчанию all;
  `--chat-type group|channel|user|bot` дополнительно сужает область.
  `daily-export` – совместимый alias.
- Период полуоткрытый: `since <= message.date < until`. Передавай явную
  IANA timezone. Продолжай через `--cursor` из `coverage.nextCursor`, сохраняя
  selection, период, archive/type и link/chronological mode. Лимиты действуют
  на один вызов; инвентарь более 1000 чатов не имеет общего потолка.
- `coverage.inventory` отдельно показывает scan/verify метаданных;
  verification pages могут не содержать сообщений. Каждая история имеет
  `coverage.complete`, `nextBeforeId`, `unreadInterval`. Открытые чаты и
  причины перечислены в `incomplete_chats`. Только финальное
  `coverage.complete=true` подтверждает завершённый обход. Старые flags
  `hit_dialog_limit`, `hit_per_chat_limit`, `hit_scan_limit`,
  `hit_total_message_limit`, `hit_output_byte_limit` описывают текущую страницу
  и сами по себе не доказывают полноту совокупности.
- Cursor защищён от изменения, привязан к device/connection/account и
  запросу и живёт 12 часов без продления. Завершённые участки не перечитываются;
  exclusive ID сохраняет сообщения с одинаковым временем. Дедуплицируй
  накопленные страницы по marked peer ID + message ID. `--chronological`
  упорядочивает текущую страницу, для общей хронологии сортируй совокупность.
  Ошибка/истечение cursor требует нового обзора; повтор без продвижения –
  конкретный blocker, а не повод бесконечно повторять запрос.
- При `inventory_changed`, недоступном чате или metadata failure назови
  неполную область. `snapshotAtomic=false`: не обещай снимок всего Telegram
  на один момент и восстановление уже удалённых сообщений. При изменившемся
  архиве не обходи исключение чтением по exact ID.
- URL entities включаются через `--include-links`. Export не дочитывает
  reply/context за пределами выбранной истории. Вложения возвращаются только
  как metadata: `attachmentsContentRead=false`, `contentRead=0`. Отделяй
  полноту сообщений от прочитанности файлов/аудио/видео; `textComplete=false`
  означает обрезанный текст. Обзор не меняет read receipts, архив и настройки.
- CLI всегда возвращает JSON. Не собирай период страницами через `read`
  и не обходи runtime прямым MTProto/UI-доступом. Крупный экспорт используй
  как временный источник анализа; сырой текст не сохраняй в Workspace,
  комментарии или Git без отдельной необходимости и проверки аудитории.
