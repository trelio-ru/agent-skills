# Защита и личные параметры

API credentials принадлежат локальному оператору, не компании Trelio.
Company connection отсутствует. Общий host хранит UUID/название/комментарий,
default и binding; provider не копирует этот каталог и личные Markdown rules.
Режим доступа `client|agency`, Client ID/Secret, точный agency_client и
`ad_groups|campaigns` задаются одной локальной формой. Название/комментарий
меняются штатным host account update. Параметры обязательны кроме agency_client
в режиме client; секрет 1–4096 символов, Client ID 1–256, без CR/LF/NUL.

Форма принимает только exact loopback Host, случайный route, same-origin
Origin/Sec-Fetch, один page load/submit, JSON до 12000 bytes. CSP отключает
внешние ресурсы/frame embedding. Нет read endpoint credentials и вывода URI
формы агенту; системный opener получает локальный URI внутри runtime.
Сервер закрывается при success/cancel/expiry/failure; секреты не логируются.
API diagnostics содержат только HTTP status и до 32 top-level или вложенных пар path/code
из канонических токенов до 80 символов. Вложенный путь ограничен 8 частями,
400 символами и индексами 0–9999; обход – 256 узлами/64 элементами контейнера.
Разбираются лишь validation `fields/items/errors`, никогда message, URL,
request body или произвольный JSON. Stored paths повторно проверяются перед
receipt persistence; дополнительная диагностика не отменяет write fence.
Credential-поля и отражённые secret/token
значения исключаются; raw response/message/URL не сохраняются в receipt.
Read-back mismatch сообщает лишь static field code с уровнем объекта, без
запрошенных/прочитанных значений; malformed stored keys не попадают в diagnostic.
Настройка detached: operation/pid/phase/expiry сохраняются, статус наблюдается
в пределах первоначального account/scope, один wait <=30s. Вкладка без submit
не является success. Credentials сохраняются после submit до auth probe,
поэтому offline даёт failed probe и не теряет уже сохранённый ввод.
Явная замена сохраняет старое подключение до валидного submit; cancel его
не меняет. Pending setup блокирует рабочие команды, двойную форму и reset.

Stable namespace:
`<TRELIO_CONFIG_HOME>/integrations/vk-ads/accounts/<host-account-UUID>/state.enc`.
Runtime version не входит в key. Credentials, reusable access token/expiry,
operation plans/receipts/setup state находятся в одном encrypted envelope.
Запись атомарна; unknown receipt сохраняется до network dispatch. Максимум
100 plans/1000 receipts и 4 MiB ciphertext; автоматического удаления pending
или unknown evidence нет. При лимите требуется отдельное maintenance решение,
не очистка history ради следующей mutation.

macOS: AES-256-GCM, random 12-byte IV, AAD `trelio/vk-ads/v1/<account>`,
32-byte random key в Keychain (`trelio.vk-ads.vault.v1`),
WhenUnlockedThisDeviceOnly. Keychain lookup/создание идут через фиксированный
Swift helper; bytes только по приватным stdin/stdout pipes. Никакой fresh
runtime OS-auth prompt не добавляется; штатные Keychain prompts сохраняются.
Swift compiler – fixed `/usr/bin/swiftc`, owner-only content-hashed cache.

Windows: DPAPI CurrentUser с account-bound entropy; plaintext/key на диск не
записываются. Фиксированный PowerShell helper запускается абсолютным системным
путём, shell=false, `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.
MachinePolicy/UserPolicy не меняются и сохраняют приоритет. Чувствительные
файлы/каталоги создаются с owner-only explicit DACL; чтение проверяет owner,
ACL и reparse points. GPO/native policy failure блокирует работу.
JSON, файловые атрибуты и ACL обрабатываются прямыми Framework APIs без
повторного discovery PowerShell cmdlets. Все пять уровней storage проверяются
в одном helper вызове; guards не кэшируются. Write helper проверяет новый
файл после explicit DACL создания до atomic rename.
Private pipes явно используют UTF-8 без BOM; native fixture включает Unicode
в path оператора и не зависит от интерактивной Windows code page.

POSIX: dirs700/files600, owner и symlink guards. Linux возвращает
secure_storage_unsupported, plaintext fallback отсутствует. Защита дисковых
файлов не является sandbox от malware того же OS user/администратора.
Публичный package не содержит application identity, credentials/real fixtures,
телеметрии или third-party hosted service; только свой клиент фиксированного VK API.

Классификация: marketing campaign management/performance; runtime не читает
банковские счета, balance/billing, платежи, зарплаты, налоговые/инвестиционные
сведения. Данные расхода рекламы – метрики согласованного размещения. Добавление
финансового account/payment flow требует отдельной классификации и fresh OS
unlock по общему контракту, а не флага для отключения проверки.

Reset удаляет credentials/token, сохраняя encrypted receipts и их исходные plans;
OS key нужен для оставшейся history. Он не отзывает VK client secret/token.
Замена credentials тоже сохраняет receipts и их plans; неприменённые планы
удаляются, поскольку были подготовлены для прежнего подключения.
Для отзыва нужен штатный интерфейс VK. Перенос между устройствами и импорт
старых stores не реализованы: новый UUID требует настройки; совместимый runtime
повторно использует прежний account envelope. Имена, комментарии, personalRules
и binding компании не меняют storage key, но scope hash операций меняется.

Синтетические tests выполняются на Linux/macOS/Windows; native tests реально
проверяют Keychain/DPAPI, wrong account и ACL; Windows negative test открывает
inheritance synthetic файла и проверяет отказ до расшифровки. Fixture codec доступен только
через constructor в tests, отсутствует в CLI/env. До платформенной публикации
нужны зелёный exact hosted gate и отдельный реальный VK API smoke.
Windows fixture bootstrap имеет отдельный watchdog 120 секунд и сообщает
только фиксированную стадию: зависание не превращается в бесконечный CI job,
private paths, packets и native stderr в diagnostic не включаются.
Отдельный native control за 10 секунд проверяет private stdin/EOF штатного
PowerShell процесса до ACL/DPAPI; observer выдаёт только фиксированные имена
стадий и не позволяет пропустить guards. Observation tests используют полный
30-секундный wait и lease 120 секунд, чтобы проверять переход, а не скорость OS.
