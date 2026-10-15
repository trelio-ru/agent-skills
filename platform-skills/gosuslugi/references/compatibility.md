## Совместимость

Secure runtime рассчитан на macOS с Command Line Tools/Swift и Chrome, Windows 10/11 x64 с .NET Framework/Windows PowerShell и Edge. Node.js >=22 с npm; optional `start --channel chrome|msedge` выбирает установленный браузер, не скачивает его. Linux и cloud-only завершаются fail-closed.

Старые `snapshot`/`page` ограничены HTTPS `gosuslugi.ru`/поддоменами; `gu-st.ru` разрешён отдельно только для статических ресурсов. Для свободного сценария используй описанный Playwright-клиент: его обычные API поддерживают произвольный код, upload/download и переходы. `authorize` обслуживает только ЕСИА и не исполняет сайтовые сценарии. Не смешивай владение: `stop` закрывает собственный браузер обычного `start`, а браузер Playwright-сценария закрывает сам сценарий. Госключ по-прежнему требует ручного действия на телефоне. Шифруется состояние авторизации, а не весь диск; память активного процесса, OS swap/crash dumps и действия вредоносного процесса владельца вне гарантии. Подробности и release gates – [контракт runtime](secure-runtime.md).

После pending выполняй `continuation.arguments` того же localAction: wait
наблюдает результат без сообщения «заполнил». Правила – в references.
