# Browser smoke Google Календаря

Дата: 2026-11-10. Это maintainer-проверка нового source, не подтверждение
публикации, назначения компании или готовности установленного stable host.
Аккаунт, cookies, screenshots, calendar/event URLs и данные встреч не входят
в репозиторий. Личная авторизация остаётся в device-local protected snapshot.

## Компоненты и обязательные gates

Provider: `google-calendar-web` 0.1.0; новая реализация без прежнего provider tag.
Host baseline: `4e466e5d38753448b140be643d3c007dea7d629d`, candidate содержит
signed `trelio.visual-presentation/v1`, `trelio.visual-semantic-controls/v1`,
`trelio.visual-form-checks/v1`, скрытую работу и видимый setup.
Backend recovery default интегрирован: `1ce86cb6a3f475f7cceb435aaa30311feaf304a2`.
Его exact hosted run был остановлен billing gate; coordinator выполнил
разрешённый focused local fallback. Это не успешный hosted CI и не deploy.
Требуемые presentation/semantic/form-checks API входят в опубликованный host
3.31.4 (release commit a72ce3fa32a340241cc38927a232d8bbe7eab2e6). Минимум
manifest/doctor приведён к этой фактической версии до первого provider release.

Изменяется общий host ABI, поэтому перед выпуском комбинации нужны native
host/provider gates на macOS/Windows/Linux и полный cold/fault question-system
stand с exact integrated source pins по docs/release-process.md. Targeted
локальные проверки и этот smoke не заменяют hosted evidence и native OS gates.

## Выполнено локально

- Parser, отказ до identity/browser I/O, пустой account import, отказ старого
  host, signed hidden/text/origin policy, deterministic materialized CLI package.
- Unknown inputs, timeout/process failure, malformed reply, access/5xx и safe
  diagnostics: один dispatch, никакого replay и утечки exception/page content.
- Native Chromium: text/PNG/input/scroll, auth snapshot, hidden → visible setup
  → hidden, session и persistent cookies, исходные lease/session/frame guards.
- Legacy manual close/ready, explicit logout и crash preserving previous snapshot.
- Общий browser recovery default доставляется final compact MCP skill read;
  отдельные ограничения навыка и human/security gates остаются обязательными.

## Живая проверка Google

Используется управляемый Chromium Trelio, без IAB/личного Chrome, Google API,
импорта чужого профиля и password/CAPTCHA automation. Вход выполняет человек.

Новая Google-сессия сначала открывала публичный Workspace landing. Его Sign in
создаёт новую вкладку с ранним headerless redirect, который останавливает MIME
guard. Setup исправлен на штатный Calendar ServiceLogin в исходной защищённой
вкладке. Точные observed auth origins включают accounts.youtube.com и
accounts.google.ru. Родительские origin scopes заданы явно для session cookies,
без wildcard доступа. [Google подтверждает эти семейства auth hosts](https://support.google.com/work/android/answer/10513641?hl=en).

Пользователь подтвердил открытие самого Calendar с сеткой и календарями.
Первый restore возвращал account chooser в hidden и headed режиме. После
отключения обоих browser-level Chromium sign-in preferences
(`signin.allowed=false` и `signin.allowed_on_next_startup=false`) вход сохраняется
при обычном stop/save/hidden restore. Это проверено несколько раз; персональный
Chrome, Google API и OS/Bluetooth settings не менялись. Одного `allowed=false`
оказалось недостаточно: Chromium переносит next-startup preference при запуске.

Выполнен разрешённый CRUD smoke синтетического будущего события: выбранные
calendar/timezone, без гостей/Meet/notifications, Free. После Save повторно
открыты день и exact карточка; после переноса проверены новые начало/конец и
прежняя длительность; после Delete подтверждены отсутствие в дне и Trash entry.
Корзина не очищалась, permanent delete не выполнялся.

Затем проверены сами программные recipes: список sidebar календарей, полное
чтение выбранного пустого дня, создание и перенос с fresh reload/card read-back,
расчёт свободного интервала. Delete recipe отправил ровно один Delete и
подтвердил day absence, но корректно оставил unknown для automatic Trash
verification: в корзине два одинаковых экземпляра от разрешённых smoke.
Отдельное чтение SAME UI подтвердило два test entries вместо прежнего одного;
повторной записи не было. Это реальная проверка bounded fallback, не заявление
об автоматическом разрешении неоднозначности. Активных test events нет.

Semantic fixtures проверяют сдвиг геометрии, длинный toolbar/pagination,
одинаковые labels, styled native checkbox и private form comparison. Stateful
recipe fixtures моделируют фактически выполненный Save/Delete с потерянным
ответом: один dispatch, unknown, без replay. Изменённое принятое значение формы
и recurring scope останавливаются до Save. Эти fixtures не заменяют Google
smoke, проверку всех языков/поясов и обязательные native OS/combined gates.

Последняя source-проверка коротких description/location, пустых guests и
отсутствия Meet дошла до fully validated Save. Maintainer-обёртка намеренно
заблокировала сам Save: это dry-run формы, не третье созданное событие. Свой
черновик отменён. Финальный find-events по test anchor подтвердил полный пустой
выбранный день. Все обычные чтения/recipes выполнялись без screenshots.
