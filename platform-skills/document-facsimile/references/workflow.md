# Контракт факсимиле

## Scope и данные

`document-facsimile` использует signed `local-accounts-v1`, host >=3.7.0,
`local-session` и `network` только для loopback формы. Внешнего API нет.
Имена, комментарии, UUID и company/member bindings обслуживает общий host.
Нет отдельного provider account list или глобального active account.
`__trelio_accounts_import` возвращает пустой bounded metadata результат,
не ищет прежние подписи в Workspace или на диске.

Verified host передаёт `TRELIO_SKILL_ACCOUNT_JSON` и живую skill/company/member
identity. Runtime принимает UUID и `providerRef=null`; название/комментарий
не задают путь, storage identity или разрешение подписи. ФИО хранится отдельно
и используется для проверки конкретного подписанта, не для склейки аккаунтов.
Два аккаунта с одинаковым ФИО остаются разными. При смене компании повторная
привязка не копирует изображение; допустимость применения оценивается заново.

Локальный bundle: `<Trelio config>/facsimiles/accounts/<UUID>/facsimile.json`.
Файл содержит schemaVersion, state, revision, ownerFullName, widthMm,
pixelWidth/Height, SHA-256 и PNG base64. Все эти данные локальны. Package и
backend не содержат изображения, ФИО, реальные примеры или ссылки на личные файлы.
Выход `show` – только необходимые метаданные выбранного пользователем аккаунта;
ни байты PNG, ни base64, ни private storage path не попадают в stdout/stderr.
Рабочая экспортированная копия PNG остаётся во временной локальной папке вне
Git/Workspace и удаляется после вставки. Готовый документ может включать подпись
и передаваться по прямому поручению; это не публикация исходного PNG в каталоге.

POSIX: owner-only directory 0700, file 0600, правильный uid, без symlink/hardlink.
Windows: fixed signed PowerShell helper, абсолютный системный executable,
`-NoProfile -NonInteractive -ExecutionPolicy Bypass`, current-user owner и DACL,
без reparse points. Постоянные policy не меняются; GPO failure блокирует работу.
ACL читается Framework API без поиска PowerShell modules; наследованный
PSModulePath другой PowerShell edition не меняет этот маршрут.
Runtime создаёт только собственные provider descendants, не исправляет чужие
права. New output получает owner-only ACL, исходные файлы не перезаписываются.

Save использует exclusive lock, exact revision CAS и атомарную замену одного
bundle. Clear атомарно удаляет персональное содержимое, сохраняя revision
tombstone: старая configure форма не может воскресить очищенную подпись.
После ошибки/сбоя сначала `doctor`, потом решение о повторе. Stale lock –
`storage_busy`; автоматического удаления чужого lock нет.

## Локальная форма

`configure` запускает HTTP server на 127.0.0.1 и случайном порту, открывает
одноразовый URL в локальном браузере. До 110 секунд ждёт save/cancel; окно не
закрывается принудительно. Success подтверждает сохранённый bundle, не просто
закрытое окно. Timeout возвращает `setup_timeout`; поздний submit не выполняется.
ФИО и PNG вводятся человеком в локальную форму, не через чат/MCP payload.

Форма проверяет Host, Origin, одноразовые path/nonce, content type и размер.
Запуск не вызывает DNS даже для loopback адреса.
Нет CORS, внешних ресурсов, access log, traceback или credential output.
CSP запрещает iframe и сторонние script/connect; cache и referrer отключены.
Неверный запрос не сохраняет данные. CAS отказ оставляет прежний bundle.
Отмена не меняет данные. После success/cancel/timeout сервер закрывается.

ФИО: Unicode NFC, нормализованные пробелы, минимум имя и фамилия, до 240
символов, без управляющих символов. Отчество не обязательно для людей без него.
Сравнение с явно определённым полным именем автора игнорирует регистр/пробелы;
инициалы или другая орфография автоматически не приравниваются.

PNG: до 8 MiB, до 4096 на сторону/4 млн пикселей, 8-bit RGB/gray с alpha,
без interlace/APNG. Проверяются framing, CRC, zlib, scanline filters и alpha:
должны быть видимые и прозрачные пиксели. Метаданные удаляются при нормализации.
JPEG, PDF и PNG без прозрачности требуют отдельной подготовленной копии.
Ширина 10–100 мм, default 34 мм; высота пропорциональна исходному PNG.

## Документы и ограничения

`image`/`insert-docx` требуют exact выбранный account, полное имя автора и
`--authorized` на основании прямого поручения или действующего правила.
Runtime проверяет имя; он не способен самостоятельно установить юридическое
право подписи. Комментарий аккаунта и данные документа не являются authority.

DOCX обрабатывается standard library без сетевых зависимостей. ZIP bounded:
2048 entries/64 MiB распакованного содержимого, без дубликатов/traversal,
package signatures и VBA. XML без DTD/entity/UTF-16. Поддерживается одна метка
`{{SIGNATURE}}` в direct paragraph runs (в том числе в таблицах и split runs).
Fields, hyperlinks/tracked changes и сложное место метки fail closed.
Вставка создаёт inline DrawingML image, image relationship и PNG content type.
Нумерация relationships/docPr не конфликтует с существующей. Word extension
namespace bindings сохраняются, включая `mc:Ignorable`. Никакой конвертации
документа, удаления прочего содержимого или отправки не выполняется.
Package content-types/relationships сохраняют conventional default namespace
для совместимости с LibreOffice и Word.

Output обязан быть новым локальным файлом, без symlink/reparse ancestors;
исходник никогда не перезаписывается. Неизвестный результат проверяется по
готовому файлу/digest до повтора. Любой результат требует визуального review
в доступном DOCX/PDF renderer; unit test OOXML не заменяет осмотр страницы.
Проверки runtime на Linux/macOS/Windows используют только синтетические PNG,
ФИО и документы. Реальные подписи не являются fixtures.
