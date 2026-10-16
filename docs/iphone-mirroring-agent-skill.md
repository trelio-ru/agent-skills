# Agent Skill «Видеоповтор iPhone»

`iphone-mirroring` – connection-free platform skill для управления уже
сопряжённым физическим iPhone через системное приложение macOS. Он не работает
с iOS Simulator, Finder или QuickTime и не переносит в Trelio pairing, cookies,
экран телефона либо системные разрешения.

## Runtime

Канонический source находится в `platform-skills/iphone-mirroring/`:

- `SKILL.md` задаёт обязательный status/screenshot/action/verification цикл;
- `trelio-iphone-mirroring.mjs` блокирует все non-macOS surface до запуска;
- `mirrorctl` собирает Swift CLI, supervisor и input guardian в приватном пользовательском
  temporary cache по content hash;
- Swift/Objective-C source выбирает exact окно ScreenContinuity, выполняет OCR,
  normalized HID actions и владеет единственным `CGVirtualDisplay` во время
  скрытой lease.

Package использует Node entrypoint, capability `local-session` и не содержит
company connection. На macOS wrapper запускает только `/bin/zsh` и exact helper
из materialized signed package с `shell:false` на обеих границах. Внешний PATH
не выбирает исходник навыка.

## Ответы и наблюдение после действия

Инструкция использует opt-in `--compact`: minified JSON сохраняет состояние,
lease/ownership и доказательства доставки/возврата, но исключает повторные
window/PID/topology и полный OCR. `--ocr` возвращает распознанный текст, когда
он нужен для чтения; ошибки сохраняют все исходные поля, включая неизвестные
диагностические сведения. Отсутствующие доказательства не подменяются `false`.
CLI без новых флагов сохраняет прежний полный формат и команды.

`--observe` поддерживается у `session start`, `click`, `long-press`, `scroll`, `type-text`,
`home`, `app-switcher`, `spotlight`, `retry` и `wait-connected`. После одной операции он
сохраняет итоговый захват с OCR-классификацией в PNG и возвращает
`observation.output`/`screen_state`/`captured_at` (Unix milliseconds). Вместо
удаляемого внутреннего status-снимка агент открывает этот же файл; повторный screenshot
того же кадра не требуется. Снимок после предыдущего шага пригоден как исходный
для следующего в непрерывной серии, но после паузы/смены окна/неожиданного
состояния нужен новый. Следующее действие выбирается только после просмотра.

`screenshot --compact` без `--output` также создаёт собственный PNG. OS выделяет
уникальный временный каталог с правами 0700, файл получает 0600; runtime не
выбирает имя из пользовательского текста и не перезаписывает существующий
артефакт. Явный `screenshot --output PATH` сохраняется для отдельного экспорта.
Изображения остаются локальными; путь передаётся встроенному просмотрщику агента.

После ошибки действия read-back разрешён только если команда уже вошла в
операцию. Сбой захвата добавляет `observation_error` и не заменяет/ослабляет
исходные `events_posted` и `verification_required`: новое действие ради
повторной картинки запрещено. `type-text --observe` даже с `--ocr` не возвращает
текст поля в JSON; для проверки доступен PNG. Флаги разбираются отдельно от
значений: буквальный текст `--observe` не включает снимок.

## Локальные prerequisites

- Mac с доступным `Видеоповтором iPhone` / `iPhone Mirroring`;
- уже сопряжённый iPhone рядом с включёнными Bluetooth и Wi‑Fi;
- Xcode Command Line Tools, предоставляющие `xcrun`, `swiftc` и `clang`;
- ранее выданные вызывающему приложению macOS разрешения `Универсальный доступ`
  и `Запись экрана`.

Runtime не инициирует системные permission prompts. Физический unlock после
перезагрузки iPhone и блокировка занятого телефона остаются действиями
пользователя. После такого действия terminal overlay Apple не обновляется сам:
runtime выполняет `retry`, который один раз нажимает точную AX-кнопку `Подключиться` /
`Connect` либо `Повторить попытку` / `Try Again` и сам ожидает
подключение. Пассивный `wait-connected` на старом `iphone_in_use` не считается
восстановлением.

## Готовность подключения

`session start`, `retry` и `wait-connected` используют общий алгоритм из
`scripts/connection-readiness.swift`. После создания/переиспользования скрытой
lease либо единственного AXPress runtime выдерживает минимум три секунды
до первого захвата. Затем он ждёт два последовательных кадра одного window
ID/PID без системного connection overlay. До и после каждого захвата должны
быть доступны все три exact AXMenuItem: «Экран «Домой»» / Home Screen,
«Переключатель приложений» / App Switcher и Spotlight с `AXEnabled=true`.
Серое окно и фон Apple без OCR при выключенных командах остаются `connecting`;
отсутствующее AXEnabled остаётся `readiness_unavailable`. Критерия яркости нет:
чёрный экран подключённого приложения с доступной навигацией допустим.

Общий монотонный бюджет по умолчанию равен 30 секундам, интервал между
завершёнными захватами — одной секунде. Время OCR входит в тот же бюджет,
изменение window identity или промежуточный неготовый кадр сбрасывает кандидат.
`wait-connected` позволяет явно выбрать конечный timeout `>0...120` секунд и
interval `0.25...5` секунд; бюджет короче стартовой паузы истекает без снимка.
Проверка caller/lease работает и во время паузы, ожидание не захватывает фокус,
не отправляет HID и не создаёт повторных AXPress/launch. Stop прекращает
наблюдение exact сессии без перехода к новой lease.

Ответ сохраняет исходный action/sessionID/ownership и добавляет
`connection_outcome` (`candidate`, `blocked`, `timed_out`, `observation_failed`),
`connection_candidate`, `connection_wait_seconds`, `screen_state` и
`verification_required`. `connection_candidate=true` требует визуальной
проверки содержимого. Terminal overlay Apple возвращается как `blocked`;
истечение бюджета и недоступное наблюдение сохраняют `connection_error` с
машинным кодом. Ошибка после старта не скрывает созданную lease и не заменяет
explicit stop. Неизвестный результат retry не разрешает повтор ради снимка.

Промежуточные PNG перезаписываются в одном owner-only временном каталоге,
в ответ попадает только последний кадр. `--observe` сохраняет именно его:
новый capture после ожидания не делается. Без флага внутренний файл удаляется.
Тайм-аут до первого capture не создаёт фиктивный PNG. `connected_or_unknown`
обычного screenshot/status сохраняет старый смысл OCR-кандидата и не заменяет
положительное доказательство готовности.

## Session lifecycle

Одиночный read-only снимок не требует session. Серия HID-действий начинается с
`session start`, перед каждым действием использует свежий screenshot и exact
lease ID, а после завершения либо отмены порученной работы выполняет
`session stop` плюс read-back `session status`. Между действиями сессия
сохраняется: default idle равен 1800 секундам, команды и explicit `keepalive`
продлевают его. Долгое ожидание ввода внутри живого запроса не считается
простоем. Default hard timeout одной сессии — 7200 секунд; после него
незавершённое поручение продолжается в новой сессии со свежим снимком.
Если первоначальный `status` вернул `app_not_running`, скрытая серия запускает
`session start` напрямую: предварительный `focus` забрал бы ownership у
supervisor и заставил бы cleanup вернуть окно на основной экран. При штатном
скрытом запуске ответ start содержит `mirrorWasRunning=false` и
`mirrorLaunchedBySupervisor=true`, а после explicit stop дополнительный
`status` обязан подтвердить `app_running=false`.

Supervisor сам очищает virtual display при timeout, lock/sleep, изменении
физической display topology, потере ScreenContinuity, thermal pressure или
сигнале завершения. Эти аварийные ветки не заменяют explicit stop.

`CGVirtualDisplay` является private macOS API. Поэтому каждый поддерживаемый
релиз проверяет компиляцию на macOS, а live smoke после публикации обязан
подтвердить создание и explicit cleanup скрытой session на реальном устройстве.

## Защита ввода и текст

Каждый скрытый `click`, `long-press`, `scroll` либо `type-text` выполняется отдельным
`input-guardian`. Supervisor ждёт три секунды без движения, прокрутки,
перетаскивания и клавиатурных событий, проверяя также удерживаемые кнопки и
модификаторы. Одна команда ждёт до 600 секунд с монотонным deadline без
перехвата курсора/фокуса. CLI и supervisor принимают запрос на 610 секунд,
оставляя запас для IPC и короткого действия; прежний протокол с меньшими
лимитами требует пересоздания сессии. Guardian повторяет проверку после
создания event tap до активации.
Во время handoff проходят только его собственные события; физический ввод и
события другого исполнителя отменяют оставшуюся часть действия. События,
совпавшие с коротким интервалом защиты, могут потеряться. Ввода без доступного
event tap или во время Secure Event Input нет.

Гонка до отправки событий возвращает команду в тот же цикл ожидания только
при `input_not_idle`/`input_user_active`, явных `events_posted=false`,
`verification_required=false` и доказанном возврате фокуса либо
`handoff_started=false`. Новый десятиминутный бюджет при этом не создаётся.
После любых отправленных событий, crash, неполного результата или сбоя
возврата требуется screenshot/read-back. `input_idle_timeout` отдельно
подтверждает, что за десять минут ввод не начался.

Ожидание проверяет caller, отмену сессии и health; `session stop` обслуживается
даже при ожидающем HID-запросе. Сигналы wrapper-а передаются CLI, а исчезновение
родителя, включая SIGKILL, дополнительно отменяет CLI-запрос. Ни продление
idle-сессии, ни ожидание покоя не увеличивают время владения вводом.

Foreground читается синхронно. Переход и возврат адресуют exact PID через
проверяемые Process Manager API, поэтому несколько экземпляров одного bundle
не подменяют исходный процесс. Guardian имеет deadline две секунды; supervisor
независимо убивает и reap-ит зависшего ребёнка через 2,4 секунды, затем
восстанавливает управление. Завершённый или просроченный вызывающий CLI не
оставляет отложенного ввода. Новый `inputProtocolVersion` исключает выполнение
новым клиентом HID через старый supervisor, сохраняя explicit cleanup.

`type-text --x X --y Y --text TEXT --session ID` кликает по выбранному полю и
вставляет однострочный Unicode без clipboard и без Enter. Лимит — 128 UTF-16
единиц; control characters и слишком длинные grapheme clusters отклоняются без
усечения. Секреты и OTP не передаются через аргументы. CLI помещает UTF-8 только
в owner-only FIFO, JSON-запрос содержит UUID и размер, supervisor сразу удаляет
FIFO и передаёт текст ребёнку через stdin pipe. Ответ содержит длину и сведения
о доставке, но не сам текст. Старое значение очищается видимой кнопкой поля с
отдельным read-back; автоматическое `⌘A` и внешний Computer Use не применяются.

`events_posted` доказывает отправку, а не исполнение на телефоне. Отмена после
частичной отправки требует screenshot/read-back; повтор вслепую запрещён.
Тёмный фон приложения не используется как признак ошибки захвата.

## Длительное нажатие

`long-press --x X --y Y [--duration-ms 800] --session ID --compact --observe`
отправляет одну пару leftMouseDown/leftMouseUp в неизменной normalized точке.
По умолчанию удержание равно 800 мс, допустимы целые 500...1000 мс. CLI,
supervisor и guardian валидируют длительность до ввода; отсутствующее IPC-поле
или некорректное значение завершаются `invalid_input_duration`, без короткого
клика вместо удержания. `--visible` и `--count` не поддерживаются.

Guardian остаётся владельцем алгоритма: ждёт покой, проверяет точное окно,
перед down проверяет запас времени на полное удержание и 150 мс завершения,
затем обслуживает event tap во время ожидания. Двухсекундный watchdog и внешний
предел 2,4 секунды не увеличиваются. Отмена между down/up отправляет только
завершающий up; crash cleanup остаётся у supervisor. Неизвестный результат
не разрешает повтор, после действия нужен визуальный read-back. `duration_ms`
сохраняется в compact как запрошенная длительность, а не подтверждение iPhone.
Протокол ввода 4 требует новую сессию после обновления runtime.

## Проверки

```bash
node platform-skills/tools/build-runtime-package.mjs \
  --skill-dir platform-skills/iphone-mirroring \
  --check

node --test \
  platform-skills/iphone-mirroring/tests/trelio-iphone-mirroring.test.mjs
```

На macOS тест `--help` компилирует три native binary без запуска ScreenContinuity
и без запроса TCC. Live device smoke не входит в CI: он выполняется только по
явному запросу владельца сопряжённого iPhone через свежий signed runtime.
При явно порученной разработке допускается проверка изменяемого canonical
source по maintainer route с теми же TCC/lease/cleanup ограничениями.
Deterministic connection tests исполняют production алгоритм с внедрёнными
часами, AX-сигналами и кадрами: gray/wallpaper, ready/disabled/unknown,
смена окна, terminal overlay, deadline, ошибка захвата и отмена caller.
