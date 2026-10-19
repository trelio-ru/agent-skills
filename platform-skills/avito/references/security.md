# Защита локальной авторизации

Модель получает только изображение текущего окна и закрытые технические поля:
frame/session IDs, размеры, направления прокрутки и фазу ручного шага.
API не возвращает HTML, DOM/AX, JS сайта, extracted text, cookies, headers,
network response bodies, произвольные файлы или clipboard.

Для авторизации используется один собственный headed Chromium под абсолютной
lease host. Ручной вход, ожидание пользователя и обычные команды входят в ту же
lease; новый tool call её не продлевает. Фоновые страницы не активируют чужие
приложения. Завершение закрывает только принадлежащие runtime поверхности.

Host запускает обычный managed Chromium без remote-debugging pipe/port,
`--enable-automation` и fingerprint spoof. Локальный extension использует
фиксированные Page/Input команды внутреннего debugger API. Только raster и
закрытые metadata переходят к модели. Browser binary обновляется закреплённым
host release, без отдельного обслуживания администратора компании.

Фиксированный isolated link adapter локально обрабатывает href exact trusted
координатного click, чтобы открыть target-blank ссылку в той же вкладке без
активации приложения. HTML/DOM/код и URL из этого внутреннего канала не выдаются
модели. Произвольного scripting/evaluate API нет. Поддержка anchor не доказывает
поддержку любого site popup/iframe: неизвестный результат не повторяют.

Во время работы owned профиль находится на диске в частном каталоге host.
После нормальной остановки auth stores (cookies, localStorage, IndexedDB,
sessionStorage/WebStorage и необходимые browser preferences/Local State)
сохраняются bounded AEAD архивом, а plaintext каталог удаляется. History,
Login Data, обычный cache и downloads в архив не входят. Crash не доказывает
сохранение и не перезаписывает предыдущий durable snapshot.
Ключ хранится в Keychain на macOS, Windows Credential Manager под текущим
пользователем или desktop Linux Secret Service. Недоступное/заблокированное
хранилище – явный отказ, plaintext fallback нет. Готовность входа устанавливается
по изображению после восстановления, а не наличию snapshot.

Снимок привязан к Trelio origin, skill и UUID личного аккаунта. Каталог аккаунтов
и company binding обслуживает host. Отображаемое имя, компания или версия runtime
не меняют encryption identity. Аккаунты и активные сеансы не смешиваются.
Состояние другого аккаунта, повреждённый snapshot и потерянный ключ не создают
новый пустой store и не перезаписывают прежнюю рабочую копию.

Вход и private storage serialization происходят локально. Во время human handoff
нет model-visible screenshot или agent input. Локальное сохранение snapshot
не раскрывает его полей в prompt, MCP, argv, environment, логах или отчёте CI.
После «готово» runtime сохраняет snapshot и закрывает окна ввода до снятия
блокировки изображений. Закрытие окна также сохраняет snapshot; новую авторизацию
считает проверенной только после отдельного чтения изображения кабинета.

OS store и AEAD не защищают от активного процесса того же OS user, администратора,
дампа памяти или компрометации устройства. Для строгой изоляции модели нужны
отдельная системная среда и отключение обходных инструментов. Ограничение этого
API само по себе не является OS sandbox или network firewall.

Удаление подключения требует прямого поручения. Оно удаляет только локальный
snapshot и его ключ, не отзывает сессию на стороне Avito. Logout/expiry у Avito
не скрываются; новый вход требует обычного ручного flow без replay действий.
