# MAX 2.13.1

Исправлено скачивание фотографий и альбомов, когда сообщения имеют одинаковое
время и MAX не показывает их идентификаторы.

Свежий read возвращает отдельный downloadRef для каждого однозначно
распознанного фото. Он связан с аккаунтом, чатом, сообщением и проверенными
thumbnail bytes, поэтому ротация подписанного CDN URL не меняет выбор.
Скачивание открывает exact фото и проверяет просмотрщик перед получением
оригинала штатной кнопкой MAX. Размер, SHA-256, приватный output и запрет
перезаписи сохраняются. Ref не разрешает мутации, assist или ACK.

Проверки: synthetic same-minute/album/ref-scope/CDN/viewer regressions,
существующие document-download regressions и read-only live скачивание трёх
JPEG originals с нулём forwarded read receipts. Обязательный release gate –
GitHub-hosted MAX suites на Linux, macOS и Windows. Minimum host – 3.18.0.
