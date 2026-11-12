# Runtime и данные локальной расшифровки

## Архитектура

Подписанный Node entrypoint использует literal argv и `shell=false`. GigaAM
закреплён на commit `7447938d791c4f3e643386ee22c33777004293a5` официального
`salute-developers/GigaAM`; исходники и MIT notice в package. Перед `torch.load`
проверяется SHA-256. Произвольные веса и remote code запрещены.

Whisper Small использует hash-locked faster-whisper и CTranslate2 (CPU int8).
Commit Systran, размеры и SHA-256 в `scripts/whisper-artifacts.json`. Inference
получает PCM из общего FFmpeg и каталог проверенных весов с tokenizer.

## Работа цифрового ассистента в задаче

`trelio-assistant-execution.json` v1 допускает exact prefixes `guides`, `doctor`,
`ensure`, `setup`, `start`, `status`, `resume`, `cancel`. Host проверяет их до
account/bootstrap и исполнения. Setup готовит закреплённую среду без входа,
credentials или подтверждения от имени владельца. `cancel` требует прямой
просьбы остановить job. Unknown start – только наблюдение.

Task использует разрешённый локальный файл и пустую папку writable Run.
`source-original`, `__setup` и process-only source marker остаются вне task
policy. Native read-confirm, owner/source admission и one-start независимы.

## Модель и язык обычного файла

`start --language <код|auto>` выбирает GigaAM при `ru` (или без аргументов),
Whisper при другом коде или `auto`. `--model whisper-small` позволяет повторить
русский. GigaAM принимает только `ru`. Whisper выполняет transcription без
перевода и отклоняет неизвестный код (`AUDIO_LANGUAGE_UNSUPPORTED`).

При `auto` язык определяется по фрагментам. Шум и короткие реплики ухудшают
оценку. Повтор с другой моделью использует тот же файл и новую папку; условия
перехода см. в SKILL.md.

Whisper добавляет в JSON `modelRevision`, выбранный `language` и при `auto`
`detectedLanguage`/`languageProbability` по фрагментам с текстом. Это оценка
языка. Resume сохраняет модель, ревизию и язык.

## Автоматическая подготовка при использовании

`doctor` и `setup` без `--approve` работают без сети. Разрешённый вызов
`ensure/start/resume/source-original` готовит закреплённые bytes без вопроса.
Явный запрет загрузки действует и при смене модели.

`downloadPlan.planHash` связывает платформу, каталог, uv/Python, lock и
size/SHA-256 модели. Новый автоматический dispatch отмечен `skill-use`;
старый `download-consent.json` только читается. `__setup` сверяет plan и
receipt до сети. URL и веса из окружения, argv и чата запрещены.

Fsynced dispatch предшествует spawn; parent claim и worker lock разделены.
Polling наблюдает прежнюю попытку. Потерянный старт остаётся `unknown` даже без
живого PID. После диагностированного terminal failure и устранения причины
допустим `setup --approve <актуальный planHash>` с той же моделью.

Whisper готовится через `doctor/ensure/setup --model whisper-small`.
В закрытой папке `whisper-small` свой кеш, receipts и lock. Используются
только закреплённые wheels и примерно 486 МБ весов Hugging Face по exact revision.
Разрешены лишь отдельные cache/Xet redirects, без зеркала.

Официальный `v3_rnnt.ckpt` занимает 446 390 032 байта (около 426 МиБ).
Отдельный файл токенизатора не требуется: алфавит хранится в конфигурации модели.
Дополнительная среда может
потребовать до 1,5 ГиБ загрузки; перед началом нужен запас 4 ГиБ на диске.
uv скачивается как закреплённый binary с проверкой SHA-256. Он устанавливает
отдельный managed CPython 3.11.14 и hash-locked CPU dependencies из `uv.lock`.
Системные установки и PATH не меняются; pip/uv config и ambient credentials
не наследуются. FFmpeg берётся только из закреплённого wheel imageio-ffmpeg,
никогда из переменной окружения или случайного PATH.
Для поддерживаемого Windows x64 runtime сам задаёт маркер архитектуры
`AMD64` по архитектуре запущенного Node: общий host не передаёт ambient
`PROCESSOR_*`. Это нужно managed Python 3.11 и uv; чужой
`PROCESSOR_ARCHITEW6432` не наследуется и не меняет выбранную среду.

Источники установки: публичные GitHub releases Astral uv/Python standalone,
PyPI, CPU wheels PyTorch, официальный CDN GigaAM и резервное зеркало Trelio.
Зеркало раздаёт только тот же публичный checkpoint, без аудио пользователя.
Порядок: проверенный локальный файл → официальный источник → закреплённое
HTTPS-зеркало при недоступности сети/TLS, HTTP 404/410, 429 или 5xx. Transient
ошибки сохраняют максимум три прежних попытки на источник; один исходный
deadline охватывает все источники, redirects, ожидания и bytes. Ошибка TLS не
разрешает `--insecure`. Digest/размер/range/origin/ACL и HTTP 401/403 завершают
загрузку без переключения. `.part` можно продолжить только для тех же size/SHA;
исполнение разрешено лишь после проверки полного файла и исходного deadline.

Зеркало GigaAM входит в подписанный manifest по full SHA-256. Предыдущий
точный receipt с теми же weights/deps/платформой/каталогом остаётся валиден;
setup нового плана требует его собственный hash.

Публичное зеркало: `https://trelio.ru/media/model-artifacts/gigaam/` + SHA-256 +
`/v3_rnnt.ckpt`. Рядом доступны `LICENSE` и `provenance.json`. Это public static
media вне product releases и company storage, а не endpoint распознавания.
Maintainer публикует только проверенную копию 446 390 032 bytes с SHA-256
`6b902433bfdc707c0995f3cb94f033bddc16bd5d0a1cf3bf0ff10d6b5e36ed12` и MIT
notice GigaChat Team. Private staging под `/opt/trelio-media/.model-staging/`
проверяется целиком до атомарного create-only rename в
`/opt/trelio-media/public/model-artifacts/gigaam/<sha256>/`; прежний каталог
никогда не перезаписывается. После публикации обязательны обычный HTTPS,
Range и полное публичное size/SHA read-back. Новый checkpoint получает иной
путь и отдельную reviewed публикацию, а не замену bytes под старым URL.

Кеш на устройстве:

- macOS: `~/Library/Application Support/Trelio/audio-transcription`;
- Windows: `%LOCALAPPDATA%/Trelio/audio-transcription`;
- Linux: `$XDG_DATA_HOME/trelio/audio-transcription` либо
  `~/.local/share/trelio/audio-transcription`.

Unix directories принадлежат текущему uid и закрыты mode 0700. На Windows
до записи выполняется fixed PowerShell helper с Process-only Bypass;
owner/DACL/reparse checks обязательны, постоянные execution policies сохраняются.
Unknown/denied policy останавливает работу без fallback storage.
Windows refusal содержит только fixed stage IDENTITY/OWNER/ACL/VERIFY:
чужой owner не присваивается автоматически, даже в тестовом elevated process.

После `setup --approve HASH` возвращается `installing`, затем `doctor` показывает
`disk`, `runtime-download`, `runtime-install`, `model-download`, `ready` либо
безопасный errorCode. Сохраняй текущий setup при ожидании, не запускай много
копий. Повтор после failure использует тот же актуальный план и исходное
основание разрешённого использования, пока модель, зависимости и условия плана не изменились.

## Длинные записи и восстановление

`start --input FILE --output-dir NEW_EMPTY_DIR` создаёт отдельную job и сразу
возвращает её папку. Фоновый worker держит настоящий OS file lock. Нельзя
запускать два inference workers для одной job; PID из state никогда не
используется как разрешение убить произвольный процесс.

Исходник читается FFmpeg по локальному пути, только первая звуковая дорожка.
Поддерживаются WAV, MP3, M4A, AAC, FLAC, OGG, OPUS, AIFF, MP4, MOV, MKV и WebM
при наличии декодируемой звуковой дорожки.
Network protocols и playlist demuxers запрещены. PCM обрабатывается потоком:
не более 23 секунд mono 16 kHz в памяти segmentation. Все исходные отсчёты
сохраняются в сегментах без пропусков/перекрытий, границы выбираются по тишине
в диапазоне 16–23 секунд. В непрерывной речи остаётся жёсткая граница.

Каждый результат атомарно сохраняется до продвижения cursor. `job.json`
содержит private state, source fingerprint и готовые raw-ASR фрагменты;
`transcript.json` отдельно указывает `complete`. TXT/SRT обновляются по мере
работы, но промежуточный файл не объявляется полным результатом.

`cancel` сохраняет уже готовое. `resume` проверяет тот же source SHA-256,
размер и mtime; декодирует с начала, пропускает уже обработанные точные samples
и продолжает inference с checkpoint. Это избегает разницы codec seek/resampling.
Новый source, другой segmentation boundary или decoder failure не становятся
успешным окончанием. После `failed`/`interrupted` сначала оцени errorCode:
изменение исходника/целостности требует устранения причины, а не слепого retry.

Node и Python отклоняют чужую модель/ревизию до inference (`AUDIO_JOB_MODEL_MISMATCH`).
`status` читает старые job. Для другой модели нужна отдельная пустая папка;
receipt установки привязан к точному плану.

## Защищённый оригинал входящего голосового

`source-original` доступен только fixed host profile с process-only
`TRELIO_ASSISTANT_SOURCE_AUDIO=1`, без дополнительного argv. Обычный CLI не
получает такой команды. Единственный <=8KiB private stdin содержит nonce,
путь/размер/SHA-256 оригинала и fixed job directory в уже закрытой папке host.
Нативные owner/source/intake/recipient права проверяет host/backend, а provider
повторно проверяет целые локальные bytes, EOF, identity, права и отсутствие
symlink/junction/hardlink. Windows использует read-only native attributes/ACL
helper, а не несуществующее поле FileAttributes в Node Stats.
Windows file ownership uses the actual caller's OS token: a new file may have
its default-owner SID rather than TokenUser. That alternate owner is accepted
only for a file inside a protected directory owned by TokenUser, with the SAME
user/SYSTEM-only allowed audience on both parent and leaf. No blanket group or
administrator exception, foreign owner, ACL repair or ownership change exists;
directory ownership remains TokenUser-only. Native CI exercises genuine token-
created files, full ASR and rejection after adding an unrelated allowed reader.
Его отказ сохраняет только закрытую стадию IDENTITY/PATH/KIND/ACL/OWNER/AUDIENCE;
пути, SID, ACL и native exception не выдаются. Стадия не разрешает repair/replay.

Offline doctor не устанавливает зависимости/модель. Если среда не готова,
provider вызывает тот же `ensure` и возвращает существующее host state `queued`
до готовности. Host продолжает читать тот же intake; нет owner setup question
или нового ABI. Failed/unknown подготовка сохраняет свой отказ/неопределённость.
Atomic замена worker progress `job.json` во время его проверки даёт только
`queued` без bytes и нового start; следующий read наблюдает ту же job. ACL/link
отказ, original и terminal transcript сохраняют строгую проверку identity.
Только после ready exclusive fsynced `.source-attempt.json` предшествует одному ordinary
`start`. Повторное чтение делает только `status` той же job. До start эти же проверенные bytes один раз фиксируются
в закрытой папке job: часовой таймер исходной local-file receipt не удалит input
работающего decoder. Эта копия живёт вместе с той же job, не в новом хранилище.
Потерянный start без job остаётся `unknown`, никогда не resume/restart. Исходный source SHA/size,
модель и полные выходные файлы проверяются заново. Changed package/model/source
не разрешает второй decoder либо смешивание текста.

Receipt не содержит audio/transcript/path: только closed state и размер/hash
завершённого TXT с точной моделью. Даже completed receipt оставляет
`contentRead:false` — host самостоятельно читает и проверяет весь UTF-8 перед
передачей текста модели. ASR остаётся машинной расшифровкой. Нет Telegram quota,
облака, нового аккаунта, Task/Run/ACK или права публикации. Native CI отдельно
прогоняет этот source protocol с настоящей официальной моделью на каждой OS;
синтетические start/status tests не заменяют inference.

## Результат и ограничения

### Повторное разрешённое чтение готового оригинала

Новый host-only source request может прочитать готовую расшифровку тех же
полных bytes без ещё одного inference. Нативный host сначала заново разрешает
и читает текущий оригинал; прежний pass, job и private путь не дают доступа.
Provider проверяет только source claims в том же private scratch root:
не более 256 entries и 8 совпадений по точным SHA-256/размеру. Ordinary task
папки не участвуют. Для готового результата обязательны та же модель,
completed job и transcript JSON, целый frozen original, полный UTF-8 TXT и
все прежние owner/ACL/link/EOF guards. Несколько результатов допустимы лишь
при одинаковых текстовых bytes; выбор по времени/имени запрещён.

Результат копируется в новую закрытую папку текущего source request после его
обычного fsynced claim. Отдельный source-result receipt подтверждает только
эту копию – новая inference job/launch не создаётся. Host по-прежнему сам
проверяет и читает полный TXT. Повтор текущего unknown start остаётся
status-only даже при наличии чужого готового результата. Незавершённое,
противоречивое или повреждённое совпадение не разрешает второй decoder.
Новый native source grant и late recipient/source checks сохраняются.

Inference использует максимум четыре CPU-потока и оставляет один доступный
процессу CPU для остальных компонентов; на одном/двух CPU использует один
поток. Affinity имеет приоритет над общим числом ядер. Модель, её bytes и
результаты прежних jobs не меняются; системные priority/affinity не изменяются.
Фактическое время распознавания проверяется отдельно, лимит не обещает скорость.

`status` возвращает только readiness/progress/coverage и пути результатов;
audio/transcript не печатаются в runtime stdout. `completed` означает, что
декодер дошёл до EOF без ошибки и исходник не изменился. Размеры/длительность
записи сами по себе не доказывают качество распознавания.
Terminal state публикуется после готовых файлов; snapshot `completed` уже
показывает JSON с `complete=true`.

JSON содержит startSample/endSample и raw text выбранной модели. GigaAM
выдаёт слова без пунктуации, Whisper может выдавать пунктуацию в своём тексте.
Обязательной постобработки нет.
Только по отдельной просьбе агент создаёт оформленную копию, сохраняя исходные
TXT/SRT/JSON. Последовательность слов и чисел должна совпасть с raw text без
учёта только пунктуации и регистра; форматирование не исправляет ASR-ошибки.
SRT и TXT используют таймкоды
сегментов; diarization, identification speakers и word alignment не обещаются.
Не превращай ASR в проверенный протокол разговора без сверки. Для сравнения
моделей нужен независимый ручной эталон; межмодельное расхождение не является WER.

Поддерживаемые targets: darwin-arm64 (macOS 11+), win32-x64
(Windows 10+), linux-x64 (glibc 2.28+). Для Whisper на Apple Silicon нужен
macOS 14+ из-за PyAV wheel. Другие architectures возвращают
`AUDIO_PLATFORM_UNSUPPORTED` до сети.
CPU gate исполняется нативно на GitHub-hosted macOS/Windows/Linux, включая
first setup без ambient переменных архитектуры, реальный checkpoint и длинный
искусственный PCM stream. Windows regression отдельно проверяет настоящую
цепочку Node → managed Python с host-filtered environment.
Speech inference uses the unchanged official public `example.wav` (361324 bytes,
SHA-256 `d8aaaa18a5098d7c6de0595ae7ac1e64cacd0d4022af3595213bdaf23be77e69`).
These development-only bytes are checked before each native test and excluded
from the signed package. Provenance is in `development/fixture.json`; inference
no longer depends on the upstream CDN's sample-audio TLS availability. Real
model installation/inference, original durations and assertions remain mandatory.
Whisper uses an additional public-domain English fixture pinned in
`development/english-fixture.json` and the same Russian fixture. Native gates
check explicit English, automatic language detection and Whisper on Russian speech.

Локальная ASR не открывает право последующей публикации. Task/Workspace/meeting
выбираются и сохраняются отдельными обычными инструментами, с сохранением
company/E2EE/источниковых ACL. Сам навык не содержит Trelio credentials и не
делает внешних mutations.
