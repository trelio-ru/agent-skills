# Runtime и данные локальной расшифровки

## Архитектура

Подписанный Node entrypoint работает на штатном Node Trelio и использует
только literal argv с `shell=false`. Контрольный слой не требует Python.
GigaAM inference source закреплён на commit
`7447938d791c4f3e643386ee22c33777004293a5` официального
`salute-developers/GigaAM`; оригинальные файлы и MIT notice входят в package.
Свой `load_model` сначала проверяет SHA-256 checkpoint/tokenizer и только затем
читает официальный PyTorch checkpoint. Пользовательские веса и remote code
не принимаются. ONNX-конвертация/Type не используются.

## Согласие и установка

`doctor` и `setup` без `--approve` не скачивают ничего. `downloadPlan.planHash`
связывает точную платформу/каталог, model artifacts с размерами/хешами,
uv/Python version и dependency lock. Пользователь одобряет именно этот план.
Агент вправе передать `--approve` только после такого согласия; request на
транскрипцию сам по себе его не даёт. Внутренний `__setup` – worker protocol,
не доступная агенту альтернатива.

Модель и tokenizer вместе занимают около 429 МиБ. Дополнительная среда может
потребовать до 1,5 ГиБ загрузки; перед началом нужен запас 4 ГиБ на диске.
uv скачивается как закреплённый binary с проверкой SHA-256. Он устанавливает
отдельный managed CPython 3.11.14 и hash-locked CPU dependencies из `uv.lock`.
Системные установки и PATH не меняются; pip/uv config и ambient credentials
не наследуются. FFmpeg берётся только из закреплённого wheel imageio-ffmpeg,
никогда из переменной окружения или случайного PATH.

Источники установки: публичные GitHub releases Astral uv/Python standalone,
PyPI, CPU wheels PyTorch и официальный CDN GigaAM. Все используют обычный TLS;
ошибка сертификата не разрешает `--insecure`. Hash mismatch не разрешает
исполнение. Повтор загрузки может продолжить проверяемый `.part`, но executable
или модель используются только после проверки полного файла.

Кеш на устройстве:

- macOS: `~/Library/Application Support/Trelio/audio-transcription`;
- Windows: `%LOCALAPPDATA%/Trelio/audio-transcription`;
- Linux: `$XDG_DATA_HOME/trelio/audio-transcription` либо
  `~/.local/share/trelio/audio-transcription`.

Unix directories принадлежат текущему uid и закрыты mode 0700. На Windows
до записи выполняется fixed PowerShell helper с Process-only Bypass;
owner/DACL/reparse checks обязательны, постоянные execution policies сохраняются.
Unknown/denied policy останавливает работу без fallback storage.

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

## Результат и ограничения

`status` возвращает только readiness/progress/coverage и пути результатов;
audio/transcript не печатаются в runtime stdout. `completed` означает, что
декодер дошёл до EOF без ошибки и исходник не изменился. Размеры/длительность
записи сами по себе не доказывают качество распознавания.

JSON содержит startSample/endSample и raw text. SRT и TXT используют таймкоды
сегментов; diarization, identification speakers и word alignment не обещаются.
Не превращай ASR в проверенный протокол разговора без сверки. Для сравнения
моделей нужен независимый ручной эталон; межмодельное расхождение не является WER.

Поддерживаемые targets первого выпуска: darwin-arm64, win32-x64, linux-x64
(glibc). Другие architectures возвращают `AUDIO_PLATFORM_UNSUPPORTED` до сети.
CPU gate исполняется нативно на GitHub-hosted macOS/Windows/Linux, включая
first setup, реальный checkpoint и длинный искусственный PCM stream.

Локальная ASR не открывает право последующей публикации. Task/Workspace/meeting
выбираются и сохраняются отдельными обычными инструментами, с сохранением
company/E2EE/источниковых ACL. Сам навык не содержит Trelio credentials и не
делает внешних mutations.
