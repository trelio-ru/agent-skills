Телефон, optional username, пароль, optional TOTP и session хранятся в локальном
AES-256-GCM vault с OS-protected key. Авторизованный browser context – только
в памяти. Не показывай и не передавай credentials, OTP, cookies, tokens и
секретные карточные данные через prompt/MCP, argv, env, clipboard, Git/Workspace,
DOM/AX/screenshot. Не читай raw profile files. Полный context технически имеет
доступ к session state; это не разрешение экспортировать его или обходить срок.
Пароль/seed/vault key не передаются аргументами сценария. Передача context
не является OS sandbox или защитой от вредоносного кода текущего пользователя.

Текущие коды пользователь вводит в самом банке только после настоящего
challenge. Не проси их в чат и не читай системный messenger. Сохранённый TOTP
runtime применяет только к однозначному запросу аутентификатора/генератора
одноразовых паролей, не вместо SMS/кода банковского приложения или платёжной
проверки. CAPTCHA, push, recovery, new device и security warnings остаются
ручными. Runtime может пропустить только явно необязательный PIN быстрого
входа; обязательные проверки и создание PIN не автоматизируются.

Одна сессия живёт максимум 30 минут от start, включая setup, OS unlock,
ожидание и сон. Команды и resume не продлевают deadline. Независимый native
supervisor закрывает owned browser/worker при expiry/crash/hang; новая сессия
требует нового OS unlock. Один headed Chrome/Edge живёт всю процедуру;
окна и сохранение сессии работают в фоне. Не перехватывай фокус, в том числе
при ожидании credentials/кода: сообщи о нужном вводе и дождись пользователя.
`show --session ID` доступен также во время входа и настройки, только по явной
просьбе показать окно. Не вызывай `bringToFront`, активацию ОС или изменение
размера native window ради обычной автоматизации. Headless probe и переоткрытие
между командами не нужны. Закрывать чужой браузер нельзя.

## Настройка и технические пределы

`configure --confirm` заменяет сохраняемые данные через локальную форму;
`forget --confirm` удаляет локальный ключ и ciphertext после OS confirmation.
Для них тоже передавай необязательную `--request-title TOPIC`.
Сначала останови активную сессию. Удаление не отзывает доступ у банка.
HTTP 5xx не разрешает новый вход/reset; сохраняй `httpStatus`/`httpOrigin`.
Timeout/DNS не имеют HTTP-кода. Не повторяй неизвестную mutation.

Optional TOTP пользователь заранее включает в Т-Банке; запись seed не включает
его. Поддерживаются Base32/otpauth SHA1/6/30 и одно/шесть полей банка. Пароль и
seed рядом снижают независимость факторов. Хранилище локальное, вне
Git/Workspace; `TRELIO_CONFIG_HOME` переопределяет корень. Импорта из `lichnoe`,
env или других профилей нет.

Runtime поддерживает macOS с Chrome и Windows 10/11 x64 с Edge; нужен
Node.js >=22 с npm. `start --channel chrome|msedge` выбирает установленный
браузер. Linux/cloud-only не поддерживаются. Точные системные зависимости,
DPAPI/Keychain и пределы vault описаны в
[контракте runtime](../../references/secure-runtime.md); plaintext fallback нет.

До handoff credentials передаются только на точные auth origins банка. После
передачи context сетевой фильтр и запрет новых вкладок снимаются – не передавай
данные посторонним сайтам. External state не сохраняется в vault; service
workers выключены. Script ограничен 128 KiB, JSON-результат – 48 KiB; отмена
активного script закрывает сессию.
