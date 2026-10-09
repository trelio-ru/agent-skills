# Работа с общими Agent Skills

Этот репозиторий содержит только общие provider-инструкции, runtime-код,
синтетические тесты и безопасные инструменты разработки. Корпоративные навыки,
реальные данные компаний, credentials, sessions, application identity и signing
keys сюда не добавляются. Перед правкой прочитай README.md и полный контракт
из references/ затронутого навыка; для релиза – docs/release-process.md.
Для Windows/native bootstrap прочитай полный
[windows-native-runtime.md](docs/windows-native-runtime.md). Общий статический
gate обходит все provider-ы; native gate выполняется на реальной Windows.
Для Telegram reactions, search, folder scope, cursor и context grouping читай полный
[контракт сообщений](docs/telegram-mtproto-message-workflows.md). Обзор всех чатов
использует отдельные проходы закреплённых/обычных диалогов и проверку
метаданных; export cursor продвигается только после возвращённого сообщения.
Archive scope повторно проверяется до history, включая exact сохранённый ID.
Native DialogFolder исключается по constructor до чтения peer/folder metadata:
сводная строка архива не является чатовой принадлежностью либо history target.

Канонический main остаётся чистым. Новая работа выполняется в отдельном
физическом worktree и ветке codex/* от свежего origin/main. Перед правкой:
git fetch --prune origin, git status -sb, сравнение HEAD с upstream.
Не перезаписывай чужие изменения и не дели node_modules между worktree.

Комментируй неочевидные инварианты, права, состояния, retries и восстановление.
Изменение поведения одновременно обновляет контракт и содержательные тесты.
Чтение названия Codex-чата в системном prompt проверяй с ограниченным host PATH:
тест должен пройти executable discovery и реальный subprocess protocol, а не
только получить подставленный заголовок. Сохраняй exact thread ID, общий deadline
и frozen native helper identity; путь CLI разрешается без расширения PATH.
Для session-bound запуска ID чата задаёт текущая hook-сессия host >=3.6.3,
не окружение persistent MCP. Provider minimum фиксирует эту зависимость,
чтобы старый bridge обновился штатным recovery до запуска пакета.
Для MAX чтение пустого личного диалога следует разделу «Пассивное чтение»
в [SKILL.md](platform-skills/max-web/SKILL.md): найденный телефон и отсутствие
распознанных сообщений сами по себе не доказывают пустую историю.
Вложенные `.history` в MAX образуют одну routed историю; выбор единственного
внутреннего контейнера не должен скрывать загрузку внешней оболочки.
Для почтовой отправки сохраняй исходные байты вложений, различай отказ SMTP
и неизвестный результат, не выводи raw reply; читай
[контракт диагностики](docs/email-send-diagnostics.md).
Готовность отдельной provider-сессии не доказывает результат другой попытки
авторизации. После отказа/блокировки сохраняй точную причину и запрет replay;
перезапуск процесса или новая transaction не должны обнулять этот запрет.
Подсказка ручного восстановления должна содержать официальный маршрут из
trusted source и сохраняться в закрытом статусе; provider text не задаёт её URL.
Нормальный cleanup и аварийный выход используют одну bounded projection receipt.
Причину отказа callback уточняй фиксированным кодом, без OAuth URL/параметров.
Делегированный helper реализует только ЕСИА: callback берётся из реального
request без карты внешних сайтов. После exact callback/state и внешнего
HTTP document commit он сразу отключает observation и возвращает те же
context/page. Request ancestry связывает redirect-параметры/токены сайта;
ошибки внешнего HTTP идут caller-у отдельно и не означают отказ ЕСИА.
Готовность кабинета проверяет вызывающий сценарий. Доступ к credentials
отзывается на callback, повтор transaction не разрешается.
Пошаговый caller Госуслуг не ждёт request/authenticated внутри очереди
browser-команд. Первый click может открыть только modal: observer сохраняет
доступность state и следующего разрешённого click в той же Page/helper.
Advisory wait без запроса требует осмотра промежуточного экрана, а не повторного
входа, нового helper или выдуманного ручного challenge.
Завершённый ESIA helper не владеет жизненным циклом browser. Следующая отдельно
разрешённая процедура может подключить новый helper к той же подготовленной Page
после verified callback и оценки прежнего бизнес-результата. Pending/failure либо
неизвестная подача не превращаются в replay; файлы/consent не пересоздаются.
Тесты Markdown-контрактов сравнивают смысл после нормализации LF/CRLF:
переводы строк checkout не меняют инструкции и не должны ломать Windows gate.
При правке Python CLI проверяй кодировку настоящих stdout/stderr pipes:
StringIO и UTF-8 locale не воспроизводят ошибки Windows code page. Для Telegram
действует [контракт CLI](docs/telegram-mtproto-message-workflows.md#кодировка-cli).
Переход в provider venv проверяется настоящими процессами на каждой OS:
Windows не использует CRT exec overlay; argv, ожидание и результат ребёнка
сохраняются. Для Telegram – [контракт перехода](docs/telegram-mtproto-message-workflows.md#переход-в-локальный-python).
Проверки идут через GitHub-hosted CI на нужных OS. Локальные full gates и VM не
заменяют CI без доказанного billing/quota blocker и отдельного решения о VM.

Теги skill-<skill-id>-vX.Y.Z и выпущенные package bytes неизменяемы.
MAX read-only assist сохраняет штатный phone lookup для cold контакта;
точная home-search кнопка проверяется и host gate, и browser event fence.
Для каждой новой signed-runtime публикации нужна уникальная runtime version,
даже при изменении только инструкций; порядок — docs/release-process.md.
Provider-релиз не повышает версию Trelio, plugin или generic host.
Signing остаётся на production backend. Публикация – guarded plan/apply с exact
artifact, digest, CAS и read-back. Сетевые ошибки: минимум три безопасных повтора;
перед повтором неоднозначной записи сначала проверь фактическое состояние.

До commit: узкие проверки, git diff --check, полный diff и аудит публичности.
Commit на русском, только файлы задачи. Опубликуй ветку, дождись exact зелёного
CI и интегрируй через PR. Затем обнови чистый canonical main и удали только свой
clean merged worktree и ветку. Новая лицензия без решения пользователя не вводится.

`Public source boundary` и check-public-source.mjs проверяют tracked snapshot
перед каждым push. Корпоративные исходники не копируются даже как fixtures.
Публикация исходников не разрешает перенос application identity; Telegram
artifact собирается только в отдельном private release-контуре.
