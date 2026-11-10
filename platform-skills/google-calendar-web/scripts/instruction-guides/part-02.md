# Программные сценарии Google Календаря

Сначала используй готовую команду для поддерживаемой обычной операции. Она
работает через те же text/input primitives Trelio и не использует screenshots,
selectors, DOM/AX, HTTP или Google API. Текущие координаты берутся из fresh
semantic controls: roles, labels и состояния checkbox/option. Положение элемента,
CSS-классы и порядок соседних кнопок не являются его идентичностью.

Команды не являются idempotent. После неизвестного Save/Delete нельзя запускать
их заново, создавать новый request или менять browser/account. Нужен read-back
и решение по фактическому состоянию. Только внутренние read-only readiness polls
могут повторяться; каждый input и финальная запись отправляются один раз.

## Входные данные

`commands` выдаёт точные CLI flags. Для сценариев передавай один literal
`--spec JSON` как отдельный argument штатного local action, без shell expansion.
Не вставляй user text в исполняемый код. Calendar name не заменяет host account
binding: до работы проверь выбранный Google-аккаунт в UI. Сценарий сохраняет
его видимую identity и останавливается при её изменении после navigation.

- `list-calendars [--spec '{"offset":0}']` — имена и selected state календарей
  текущего видимого sidebar. Это не обещание полного каталога: свёрнутые группы,
  scroll и скрытые записи остаются явным ограничением `coverage.scope`.
- `read-day --spec JSON`: `calendar`, `date` (`YYYY-MM-DD`), `timeZone` (IANA),
  optional `offset`. Возвращает bounded event summaries выбранного календаря.
- `find-events --spec JSON`: `calendar`, `from`, `to`, `timeZone`, `query`,
  optional `offset`. Период — не больше семи календарных дней включительно.
  Для следующей недели сделай отдельный read-only запрос, не увеличивай scope.
- `free-slots --spec JSON`: `calendar`, `date`, `timeZone`, `fromTime`, `toTime`
  (`HH:mm`), `durationMinutes`, optional `offset`. Читает доступные карточки;
  unknown/private availability считается занятой, не свободной. При
  `coverage.conservative=true` результат безопасный, но не исчерпывающий.

Перед чтением сценарий проверяет primary display timezone через Settings,
не меняя настройку. Пояс должен совпадать с timeZone; mismatch требует agent
flow, а не интерпретации отображаемого wall clock в другом поясе.

Время задаётся в указанном поясе. Невозможное время при DST и повторяющийся
локальный час останавливаются до UI writes; offset не выбирается догадкой.
`free-slots` не является проверкой календарей других участников и не даёт
права создать встречу. All-day события блокируют день консервативно, пока
их доступность не проверена через обычный agent flow.

## Создание

`create-event --spec JSON` принимает:

- обязательные `calendar`, `date`, `timeZone`, `title`, `startTime`, `endTime`;
- `availability`: `busy` или `free`; omission сохраняет default формы;
- `notifications: []` только для отдельно порученного отсутствия уведомлений;
  omission сохраняет default календаря;
- `guests: []` либо omission; ненулевой список пока требует agent flow с
  независимой проверкой exact recipients и Send/Don't send;
- optional plain `description` и `location` до 512 символов после нормализации
  whitespace; большее значение требует agent flow, без обрезания.

Пример синтетических данных:

```json
{"calendar":"Демонстрационный","date":"2030-05-12","timeZone":"Europe/Moscow","title":"Синтетическая проверка","startTime":"12:00","endTime":"12:05","availability":"free","notifications":[],"guests":[]}
```

Версия сценария поддерживает обычное timed, nonrecurring событие в пределах
одного дня. Для all-day, серии, нескольких дней, guests, нестандартных
notifications и неподдерживаемого timezone picker используй agent flow той же
сессии с первоначальной sending/deletion authority. Не упрощай поручение,
не удаляй такие поля из spec ради успешной команды.

Picker знает city labels: Europe/Moscow, UTC, Europe/London, Europe/Berlin,
Europe/Paris, Asia/Dubai, Asia/Tbilisi, Asia/Yerevan, Asia/Almaty, Asia/Bangkok,
Asia/Tokyo, America/New_York, America/Los_Angeles. Другой IANA timezone валиден
как понятие, но его UI label требует проверки агентом; самовольной подмены нет.

Сценарий сначала проверяет полный доступный day/календарь и отсутствие title
conflict. Затем открывает Event, полный editor, выбирает calendar/zone, вводит
даты/время, сохраняет остальные defaults и отдельно заданные опции. Default
event timezone должен уже совпадать с поручением: неоднозначный поиск города
не выбирает первый вариант. Изменение такого default требует agent flow.
Перед Save host приватно сравнивает принятые даты, время, title, calendar,
availability и заданные короткие description/location; гости должны быть пусты,
а видеоконференция не добавлена. Возвращаются только enums сравнения, без
значений полей. Unknown/missing/ambiguous останавливает форму. Save — один.
Проверка заново открывает день и exact карточку. Toast или закрытие формы не
являются достаточным подтверждением. Возвращённый `event` — tuple для UI
повторного поиска, не придуманный Google event ID или URL.

## Перенос и удаление

`target` содержит exact `calendar`, `date`, `timeZone`, `title`, `startTime`,
`endTime` из проверенного ordinary события. Название без остальных полей
недостаточно. Одинаковые candidates, неполное чтение, recurring/all-day scope
и неизвестное право изменения требуют agent flow, а не выбора первого совпадения.

`move-event --spec JSON`: `target`, новая `date`, `startTime`, optional
`endTime`. Без endTime сохраняется прежняя длительность, если она остаётся
в том же дне. Перед изменением перечитываются exact карточка и repeat/all-day;
меняются только даты/время, остальные настройки сохраняются. Save один, затем
fresh day/card read-back. Смена event timezone — отдельный agent flow.

`delete-event --spec '{"target":{...}}'` требует прямого поручения удалить
этот exact target. Оно не выводится из завершённой задачи или полезности очистки.
Для автоматического Trash read-back title ограничен 80 символами; длиннее —
agent flow до записи. Сценарий проверяет ordinary scope, отправляет Delete один раз, повторно читает
день и проверяет карточку в корзине выбранного календаря. Empty trash/permanent
Delete не входят в сценарий. Дубликаты в корзине или неполное evidence не
подтверждают exact удаление и не разрешают повторную запись.

## Полнота, восстановление и ошибки

`coverage.complete` нельзя читать как true при partial result. Rows выдаются
страницами до десяти с JSON budget 8000 bytes: `page.nextOffset` передаётся в
следующий spec того же read-only запроса. `page.observationHash` — проверка
неизменности прочитанного набора между страницами, не native revision и не
mutation authority. Если hash изменился, пересобери чтение; не склеивай старые
и новые страницы. `sourceComplete` отдельно описывает исходный UI scan.

Неизвестная грамматика, разница между count и распознанными rows, virtualised
список и scan limits не превращаются в пустое расписание. При неполноте
мутации не начинаются. Версия распознаёт русский/английский обычный интерфейс;
другой язык или новое состояние требует свежего agent observation.

`CALENDAR_UI_UNSUPPORTED`, `CALENDAR_UI_AMBIGUOUS`, `CALENDAR_TARGET_AMBIGUOUS`,
`CALENDAR_COVERAGE_INCOMPLETE` и специальные `*_REQUIRES_AGENT` прекращают recipe.
Агент продолжает через свежие controls/PNG той же допущенной сессии. Отдельное
согласие на смену способа управления не нужно; scope и ограничения сохраняются.
Существующий несохранённый editor не уничтожается ради нового сценария.

`CALENDAR_ACTION_UNKNOWN` сохраняет uncertain outcome после финального dispatch
или непроверенного read-back. Только чтение, без повторного Save/Delete,
смены transport или нового create. Ошибки не содержат raw exception/page text.
После подтверждённого дефекта предложи безопасный Trelio report с проверкой
дубликатов, описанием recovery и отдельной human publication. Календарь,
участники, private URLs и screenshots не попадают в публичный отчёт.
