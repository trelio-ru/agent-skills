---
name: iphone-mirroring
description: "Control a paired physical iPhone through Apple's iPhone Mirroring app on a local Mac: screenshots, clicks, long presses, scrolling, text and system navigation. Not for iOS Simulator, Finder sync or QuickTime capture."
---

# Видеоповтор iPhone

Используй exact `runtimeExecution.localAction` из успешного `get_agent_skill`,
команды — массивом в `parameters.arguments` через объявленный Trelio tool.
Read действует до новой сессии/compaction/утраты текста, 12 часов, смены
release/context, снятия setup/access blocker или `AGENT_SKILL_RELEASE_CHANGED`.
Host admission не продлевается чтением. Source/личная копия/cache запрещены;
legacy `runtimeExecution.command` требует recovery по контракту plugin.

Нужны локальный Mac, уже сопряжённый iPhone рядом с Bluetooth/Wi-Fi и ранее
выданные «Универсальный доступ»/«Запись экрана». Runtime не запрашивает TCC сам;
при отсутствии разрешения сообщи точное ограничение. Другие OS/cloud получают
`IPHONE_MIRRORING_UNSUPPORTED_PLATFORM`. Computer Use оставь для внешней
диагностики: в скрытой сессии его PiP может показать виртуальный курсор.

## Экономный рабочий цикл

Используй `--compact`; `--ocr` добавляй только для чтения текста.
Без `--compact` остаётся полный диагностический формат.

`--observe` сохраняет итоговый снимок в `observation.output`; открой встроенным
просмотрщиком, без повторного screenshot того же кадра. `screenshot --compact`
возвращает `output`. PNG — приватные временные файлы вне Git. Для экспорта:
`--output ABSOLUTE_PATH`, без перезаписи чужих файлов.

1. Начни с `status --compact --no-ocr`. Для одного read-only снимка достаточно
   `screenshot --compact`; серия действий требует скрытую сессию.
2. Выполни `session start --compact --observe`, сохрани точный `sessionID`
   и открой снимок. При исходном `app_not_running` запускай `session start`
   напрямую: не вызывай перед ним `focus` или `center`. Ожидаются
   `mirrorWasRunning=false`, `mirrorLaunchedBySupervisor=true`.
3. Каждое действие выбирай по свежему проверенному изображению. Снимок после
   предыдущего шага может быть исходным кадром следующего в непрерывной серии.
   После паузы, смены окна или неожиданного состояния получи новый
   `screenshot --session SESSION_ID --compact`. Координаты — доли рабочего
   окна 0...1, а не старые экранные пиксели. AX обычно видит только внешнее окно.
4. Одно действие: `--session SESSION_ID --compact --observe`, затем просмотр
   и проверка изменения. Действие и просмотр можно объединить в tool call;
   следующее выбирай после просмотра, без слепых цепочек.
5. После завершения или отмены поручения выполни
   `session stop --session SESSION_ID --compact`, затем `session status --compact`.
   Требуются `active=false`, `exitReason=explicit_stop`. Если сессия сама
   запустила Видеоповтор, дополнительно вызови `status --compact --no-ocr`
   и проверь `app_running=false`. Уже работавшее до сессии приложение
   возвращается на прежнее место и остаётся открытым.

`--session` обязателен для управления. `focus --visible` и `center --visible`
допустимы только вне hidden session по прямому запросу видимой диагностики.
Ошибка скрытого режима не разрешает visible/Computer Use fallback или остановку
lease ради клика. Не закрывай и не активируй посторонние приложения ради доступа.

## Ожидание и сессия

Перед HID runtime ждёт **3 секунды без ввода**, максимум **10 минут**, сохраняя
фокус/курсор пользователя. Жди тот же tool call: без отдельного polling,
отмены через 30–40 секунд или просьбы отложить Mac на всё время работы.
`input_idle_timeout`: ввод не начался; сообщи причину/следующий шаг, без
бесконечных новых ожиданий.

Гонка до отправки возвращает runtime к ожиданию. Ввод пользователя прерывает
операцию; в коротком защищённом интервале его события могут подавляться.
Не обещай незаметности/отката. Отмена caller прекращает ожидание и отложенный ввод.

Простой сессии по умолчанию — **30 минут**. Команды и
`session keepalive --session SESSION_ID --compact` продлевают его; `session status`
не продлевает. Сохраняй одну сессию между шагами, keepalive нужен лишь при долгой
паузе продолжающейся работы. **Два часа** — непродлеваемый срок одной сессии.
Если поручение не закончено, создай новую и получи свежий снимок; повторного
разрешения на ту же работу не требуется. Завершённую задачу keepalive не поддерживает.
Lock/sleep, изменение дисплеев, потеря приложения и авария также завершают lease.

## Результат и ошибки

- `ok=true`/`events_posted=true` доказывают отправку, а не выполнение на iPhone.
  `verification_required=true` требует просмотра результата. Частичный ввод,
  ошибка, crash или отсутствие этих полей не разрешают слепой повтор.
- `observation_error` означает сбой снимка; исходные сведения о вводе остаются
  действительными. Получи только новый screenshot. Не повторяй действие ради
  картинки. Неизменный экран сам по себе не доказывает успех нажатия.
- `input_not_idle`/`input_user_active` в окончательном ответе — операция, которую
  runtime не смог безопасно вернуть к ожиданию; проверь экран.
- `input_target_changed`, `input_focus_unavailable`, `input_window_not_ready`,
  `input_handoff_expired`, `input_focus_restore_failed`, `input_guard_interrupted`
  требуют read-back. Ошибки `input_guard_unavailable`/`input_guard_disabled`
  запрещают ввод без защиты. `AXError -25205` означает неподдерживаемый атрибут,
  а не доказанную потерю TCC.
- `session_runtime_changed`: останови exact старую сессию, проверь cleanup,
  создай новую. Истёкшая lease не разрешает повтор неизвестного результата.

## Подключение

`session start`, `retry`, `wait-connected` сами ждут: минимум **3 секунды**,
два кадра с доступной AX-навигацией, общий предел **30 секунд**. `--observe`
возвращает итоговый кадр. `connection_candidate=true` требует его просмотра;
одного `connected_or_unknown` из обычного OCR недостаточно. Серый кадр/фон
Apple не доказывает успех; тёмный фон подключённого приложения допустим.

`connection_outcome`: `candidate` — проверь кадр; `blocked` — причина Apple;
`timed_out`/`observation_failed` — причина в `connection_error`. Не повторяй
start/retry ради снимка; сохрани `sessionID` для cleanup. Неизвестный результат
не разрешает слепой повтор, тайм-аут — бесконечные новые ожидания.

- `connecting` вне завершённого ожидания:
  `wait-connected --session SESSION_ID --compact --observe` (без нажатия).
- `interrupted`/`iphone_not_found`/`timed_out`/`error`: свежий state,
  `retry --session SESSION_ID --compact --observe`; он сам ждёт результат.
  Максимум три безопасные попытки после новых подтверждённых ошибок Apple.
- `iphone_in_use`: пользователь должен заблокировать iPhone. После его сообщения
  о выполнении получи свежий снимок, один раз выполни `retry --session ID`
  с `--compact --observe` и проверь его итоговый кадр и `connection_outcome`.
  Пассивное ожидание без retry оставит старое состояние Apple.
- `physical_unlock_required`: пользователь вводит код-пароль на физическом
  iPhone после перезагрузки, затем блокирует его. После сообщения о выполнении
  получи свежий снимок, выполни один `retry --session ID` с `--compact --observe`
  и проверь итоговый кадр и `connection_outcome`.
- `connected_or_unknown`: проверь готовность и снимок, как описано выше.

`retry` нажимает exact AX-кнопку `Подключиться`/`Connect` или
`Повторить попытку`/`Try Again`/`Retry`, не координаты приблизительного места.

## Действия

```text
click --x 0.50 --y 0.72 --session SESSION_ID --compact --observe
long-press --x 0.50 --y 0.72 --duration-ms 800 --session SESSION_ID --compact --observe
scroll --direction down --pixels 480 --session SESSION_ID --compact --observe
type-text --x X --y Y --text TEXT --session SESSION_ID --compact --observe
home --session SESSION_ID --compact --observe
app-switcher --session SESSION_ID --compact --observe
spotlight --session SESSION_ID --compact --observe
```

Для прокрутки используй scroll, не drag. Просьба «закрыть приложение» на iPhone
обычно означает `home`; force quit через App Switcher — только по прямой просьбе.

`long-press`: одна точка, 800 мс по умолчанию; `--duration-ms` — целое 500...1000.
Только скрытая сессия, без `--count`. Handoff остаётся двухсекундным, отмена
отпускает кнопку. `duration_ms` — запрос, не доказательство исполнения.
Проверь изменение по снимку; после прерывания также нельзя повторять вслепую.

`type-text` сам кликает по полю и вводит однострочный текст до 128 UTF-16 единиц
без clipboard, AppleScript, Computer Use и Enter. Пароли/OTP/секреты через argv
запрещены. Текст не повторяется в JSON/OCR ответа даже с `--ocr`; проверяй снимок.
Для замены сначала очисти поле его видимой кнопкой и проверь результат;
`⌘A` не является универсальным выделением на iPhone. Отправка, удаление,
подтверждение и оплата сохраняют обычные границы пользовательского поручения.
