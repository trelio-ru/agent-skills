# Runtime и данные локальной расшифровки

## Архитектура

Подписанный Node entrypoint работает на штатном Node Trelio и использует
только literal argv с `shell=false`. Контрольный слой не требует Python.
GigaAM inference source закреплён на commit
`7447938d791c4f3e643386ee22c33777004293a5` официального
`salute-developers/GigaAM`; оригинальные файлы и MIT notice входят в package.
Свой `load_model` сначала проверяет SHA-256 checkpoint и только затем
читает официальный PyTorch checkpoint. Пользовательские веса и remote code
не принимаются. ONNX-конвертация/Type не используются.

## Согласие и установка

`doctor` и `setup` без `--approve` не скачивают ничего. `downloadPlan.planHash`
связывает точную платформу/каталог, model artifacts с размерами/хешами,
uv/Python version и dependency lock. Пользователь одобряет именно этот план.
Агент вправе передать `--approve` только после такого согласия; request на
транскрипцию сам по себе его не даёт. Внутренний `__setup` – worker protocol,
не доступная агенту альтернатива.

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

URL резервной модели содержит её полный SHA-256 и входит в подписанный
`artifacts.json` и новый download plan. Нет URL override из модели/env/CLI,
выбора других весов или автоматической установки при source ASR. Завершённая
установка прежнего точного плана с теми же моделью, dependencies, платформой и
каталогом остаётся готовой: добавление зеркала не требует переустановки и не
переписывает согласие. Новый setup всё равно требует полного текущего плана;
согласие на другую модель не принимается.

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
согласие, пока модель, зависимости и условия плана не изменились.

## Длинные записи и восстановление

`start --input FILE --output-dir NEW_EMPTY_DIR` создаёт отдельную job и сразу
возвращает её папку. Фоновый worker держит настоящий OS file lock. Нельзя
запускать два inference workers для одной job; PID из state никогда не
используется как разрешение убить произвольный процесс.

Исходник читается FFmpeg по локальному пути, только первая звуковая дорожка.
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

Обновление модели не меняет уже сохранённые фрагменты. Node launcher и Python
worker отдельно отклоняют несовпадение `job.model` с моделью signed package
до нового inference (`AUDIO_JOB_MODEL_MISMATCH`). Старые job и результаты
сохраняются; `status` читает их с исходным именем модели. Для новой модели
создаётся отдельная job и новая пустая папка, а не смешанный transcript.
Изменившийся model artifact меняет download plan: прежнее согласие на E2E-веса
не разрешает незаметно скачать RNNT. Уже загруженные файлы не удаляются.

## Защищённый оригинал входящего голосового

`source-original` доступен только fixed host profile с process-only
`TRELIO_ASSISTANT_SOURCE_AUDIO=1`, без дополнительного argv. Обычный CLI не
получает такой команды. Единственный <=8KiB private stdin содержит nonce,
путь/размер/SHA-256 оригинала и fixed job directory в уже закрытой папке host.
Нативные owner/source/intake/recipient права проверяет host/backend, а provider
повторно проверяет целые локальные bytes, EOF, identity, права и отсутствие
symlink/junction/hardlink. Windows использует read-only native attributes/ACL
helper, а не несуществующее поле FileAttributes в Node Stats.
Его отказ сохраняет только закрытую стадию IDENTITY/PATH/KIND/ACL/OWNER/AUDIENCE;
пути, SID, ACL и native exception не выдаются. Стадия не разрешает repair/replay.

Offline doctor не устанавливает зависимости/модель. Если среда не готова,
`setup_required` сохраняет требование настоящего download-plan consent. Если
готова, exclusive fsynced `.source-attempt.json` предшествует одному ordinary
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

`status` возвращает только readiness/progress/coverage и пути результатов;
audio/transcript не печатаются в runtime stdout. `completed` означает, что
декодер дошёл до EOF без ошибки и исходник не изменился. Размеры/длительность
записи сами по себе не доказывают качество распознавания.
Terminal state публикуется после готовых файлов; snapshot `completed` уже
показывает JSON с `complete=true`.

JSON содержит startSample/endSample и raw text официальной `v3_rnnt`.
Слова выдаются без встроенной пунктуации; обязательной постобработки нет.
Только по отдельной просьбе агент создаёт оформленную копию, сохраняя исходные
TXT/SRT/JSON. Последовательность слов и чисел должна совпасть с raw text без
учёта только пунктуации и регистра; форматирование не исправляет ASR-ошибки.
SRT и TXT используют таймкоды
сегментов; diarization, identification speakers и word alignment не обещаются.
Не превращай ASR в проверенный протокол разговора без сверки. Для сравнения
моделей нужен независимый ручной эталон; межмодельное расхождение не является WER.

Поддерживаемые targets: darwin-arm64 (macOS 11+), win32-x64
(Windows 10+), linux-x64 (glibc 2.28+). Другие architectures возвращают
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

Локальная ASR не открывает право последующей публикации. Task/Workspace/meeting
выбираются и сохраняются отдельными обычными инструментами, с сохранением
company/E2EE/источниковых ACL. Сам навык не содержит Trelio credentials и не
делает внешних mutations.
