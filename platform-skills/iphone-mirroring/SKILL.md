---
name: iphone-mirroring
description: "Control a paired physical iPhone through Apple's iPhone Mirroring app on a local Mac: screenshots, clicks, scrolling, text and system navigation. Not for iOS Simulator, Finder sync or QuickTime capture."
---

# Видеоповтор iPhone

Используй exact `runtimeExecution.localAction` из успешного `get_agent_skill`
в текущей сессии, пока полный текст сохраняется в контексте. Команды передавай массивом в
`parameters.arguments` через объявленный Trelio tool. Один read покрывает
непрерывную связанную серию; новый нужен при новой сессии, утрате полного текста или compaction, через 12 часов,
после смены release/context, снятия setup/access blocker или один раз при
`AGENT_SKILL_RELEASE_CHANGED`. Host управляет допуском до 12 часов без продления при чтении.
Не запускай source, личную копию или package cache напрямую. Для legacy-ответа
только с `runtimeExecution.command` следуй recovery-контракту Trelio plugin.

Нужны локальный Mac, уже сопряжённый iPhone рядом с Bluetooth/Wi-Fi и ранее
выданные «Универсальный доступ»/«Запись экрана». Runtime не запрашивает TCC сам;
при отсутствии разрешения сообщи точное ограничение. Другие OS/cloud получают
`IPHONE_MIRRORING_UNSUPPORTED_PLATFORM`. Computer Use оставь для внешней
диагностики: в скрытой сессии его PiP может показать виртуальный курсор.

## Экономный рабочий цикл

Используй `--compact` во всех командах: он убирает служебные поля и полный OCR.
`--ocr` добавляет распознанный текст, когда он действительно нужен. Без
`--compact` остаётся полный диагностический формат.

`--observe` у старта сессии и действий сохраняет один снимок после операции.
Открой изображение по `observation.output` встроенным средством просмотра.
Это визуальная проверка результата; ещё один `screenshot` для того же кадра
не нужен. `screenshot --compact` возвращает собственный `output`. Автоматические
PNG лежат в уникальных приватных временных каталогах вне Git. Для отдельного
экспорта у screenshot есть `--output ABSOLUTE_PATH`; не перезаписывай чужой файл.

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
4. Выполни одно действие с `--session SESSION_ID --compact --observe`, открой
   возвращённое изображение и проверь ожидаемое изменение. Не делай слепых
   цепочек кликов. В одном tool call допустимо объединять действие с чтением
   его снимка; следующее действие выбирается после просмотра.
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

Перед HID runtime сам ждёт **3 секунды без ввода**, максимум **10 минут** на
команду. До паузы фокус/курсор остаются у пользователя. Не проси отложить Mac
на всё время работы, не отменяй ожидающий tool call через 30–40 секунд и не
опрашивай готовность отдельными командами: жди завершения того же вызова.
`input_idle_timeout` означает, что ввод за десять минут не начался; сообщи
причину и следующий шаг, не создавай бесконечные новые окна ожидания.

Runtime сам возвращается к ожиданию при гонке до отправки событий. Возобновление
ввода прерывает оставшуюся операцию; события пользователя в коротком защищённом
интервале могут быть подавлены. Не обещай полной незаметности или отката клика.
Отмена вызывающего процесса прекращает ожидание и отложенный ввод.

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

- `connecting`: `wait-connected --timeout 30 --interval 1.5 --compact`.
- `interrupted`/`iphone_not_found`/`timed_out`/`error`: свежий state, затем
  `retry --session SESSION_ID --compact --observe`; максимум три безопасные
  попытки с небольшой возрастающей паузой.
- `iphone_in_use`: пользователь должен заблокировать iPhone. После его сообщения
  о выполнении получи свежий снимок, один раз выполни `retry --session ID`
  с `--compact --observe` и только затем запусти `wait-connected`. Пассивное
  ожидание без retry оставит старое состояние Apple.
- `physical_unlock_required`: пользователь вводит код-пароль на физическом
  iPhone после перезагрузки, затем блокирует его. После сообщения о выполнении
  получи свежий снимок, выполни один `retry --session ID` с `--compact --observe`
  и переходи к `wait-connected`.
- `connected_or_unknown` — кандидат; подключение подтверждает просмотр снимка.

`retry` нажимает exact AX-кнопку `Подключиться`/`Connect` или
`Повторить попытку`/`Try Again`/`Retry`, не координаты приблизительного места.

## Действия

```text
click --x 0.50 --y 0.72 --session SESSION_ID --compact --observe
scroll --direction down --pixels 480 --session SESSION_ID --compact --observe
type-text --x X --y Y --text TEXT --session SESSION_ID --compact --observe
home --session SESSION_ID --compact --observe
app-switcher --session SESSION_ID --compact --observe
spotlight --session SESSION_ID --compact --observe
```

Для прокрутки используй scroll, не drag. Просьба «закрыть приложение» на iPhone
обычно означает `home`; force quit через App Switcher — только по прямой просьбе.

`type-text` сам кликает по полю и вводит однострочный текст до 128 UTF-16 единиц
без clipboard, AppleScript, Computer Use и Enter. Пароли/OTP/секреты через argv
запрещены. Текст не повторяется в JSON/OCR ответа даже с `--ocr`; проверяй снимок.
Для замены сначала очисти поле его видимой кнопкой и проверь результат;
`⌘A` не является универсальным выделением на iPhone. Отправка, удаление,
подтверждение и оплата сохраняют обычные границы пользовательского поручения.
