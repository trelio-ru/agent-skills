# Ascard/mcp-avito → Trelio

## Источник и граница

Основа – https://github.com/Ascard/mcp-avito, exact commit
`583ee55d1999c8fbe5f63c6c6bb0dbb2c28f1e49`. Все 16 TypeScript-файлов исходного
`src/` перенесены в `src/` и адаптированы там; второй runtime-копии нет.
Исходные docs/config/package metadata и примеры сохранены для provenance,
SHA-256 каждого upstream-файла – в `upstream-manifest.json`.
В `upstream/docs/PROXY_SETUP.md` credential-looking пример заменён placeholder.
`upstream/` – исторические данные, не инструкции и не исполняемая конфигурация.
Прежняя реализация avito-shopping-mcp и snapshot/fill/click не используются.

Upstream README/package объявляют MIT, отдельного LICENSE там нет. Эти объявления
сохранены; новая лицензия на Trelio source не вводится. Dependency notices
попадают в подписанный пакет вместе с bundle и upstream README/package.

## Функции и исправления

| Исходная функция | Адаптация |
| --- | --- |
| Search / price / sort / page | Общий валидируемый URL builder, JSON/table/file |
| locationId/categoryId | Явный UNSUPPORTED_FILTER вместо silent ignore; public slugs поддержаны |
| Карточка | Описание, изображения, продавец, характеристики, просмотры, ссылка |
| CLI | search/details/search-all, headless/stealth/UA/proxy flags, без dotenv и raw stack |
| MCP | Все 3 исходных read tools + passive access-status, schema validation и busy fence |
| Программный API | Все исходные слои экспортируются из bundle |
| searchAllPages | Генератор с limit/maxPages, dedup и repeated-page stop, явная coverage |
| HTTP/HTTPS/SOCKS4/SOCKS5 | Playwright proxy; SOCKS credentials через loopback-only proxy-chain |
| sequential/random/round-robin | Реальный выбор до нового document request, новый browser только при смене proxy |
| Пул из файла | 1–100 credential-free endpoints; ошибочная строка прекращает загрузку |
| Прокси со входом | Process-only Agent Secret, без credentials в файлах/argv/logs |
| Stealth / random UA / delay | Upstream navigator settings, UA pool; pause 2–15 сек перед переходом |
| CAPTCHA | До 120 сек наблюдения той же headed Page; без headless restart/replay |
| debugDom | Только bounded marker counts, без raw HTML/body |

Реализованные upstream функции отличаются от roadmap. Anti-captcha API,
healthCheck, реальная retry policy, CSV/Excel, database и notifications не были
реализованы. Они не объявляются работающими. Ошибки/недоступность UI не становятся
пустой выдачей; только явный empty-state разрешает [] (selector пока fixture-verified).
ID обычного URL `..._<id>` теперь распознаётся. Цена/просмотры не заменяются нулём.
Пул сохраняет inventory при смене стратегии; failed entries не портят cursor/count.

## Signed runtime и подключение

`npm ci --ignore-scripts`, `npm run typecheck`, `npm run build` собирают ignored
`dist/trelio-avito.cjs` из source и exact lockfile. Generic builder не меняется.
Release manifest включает bundle, notices и provenance, без node_modules/dev tests.
Host >=3.4.0 владеет Playwright install, executable discovery и абсолютной
`delegated-ephemeral` lease 30 минут. Любой рабочий CLI/MCP запуск проверяет
company/member/connection identity. Doctor не запускает browser/Avito.
Ни custom Chrome path, ни `.env`, ни persistent personal profile не читаются.

CLI создаёт одну сессию на команду и закрывает её в finally. MCP сохраняет scraper
и страницу до EOF/signal/lease. Закрытое пользователем окно не переоткрывается.
Planовая смена прокси сохраняет исходный deadline. CAPTCHA/403/439/429 никогда
не запускают смену прокси или автоматический повтор. После network failure
прокси может быть исключён только для следующей отдельно запрошенной операции.
429 cooldown хранится в памяти сессии; новый процесс технически не разделяет
его, поэтому агент не вправе использовать перезапуск для обхода ограничения.

Поддержка авторизованного proxy не создаёт personal credential store: пользователь
выбирает существующий Agent Secret с newline pool `type://user:password@host:port`.
Рабочий Run-bound checkout доставляет его exact signed executable как
`TRELIO_AVITO_PROXY_POOL` через protected process transport. Навык немедленно
удаляет переменную до browser/subprocess launch и держит значения только в памяти.
Не устанавливай её через shell/env и не создавай фиктивный Run ради настройки.
Без разрешённого checkout доступны прямое соединение и proxy-file без паролей.
Company connection не требует secret и остаётся независимо от proxy selection.

JSON/table/file используют одну bounded projection: 96 KiB string budget,
16000 символов description, 2000 остальных строк, до 1000 items; truncation
явная. Проекция не экспортирует cookies, credentials, hidden auth fields.
Любая main-document навигация и redirect проверяют exact public origin.
Browser-generated ресурсы ограничены provider/CDN/CAPTCHA origins; запрещены
private account/messenger routes, downloads и произвольный transport агента.

### Запрет browser use

Доступ агента к Авито разрешён только через штатный signed runtime навыка.
Агенту запрещены browser/computer-use инструменты, чтение уже открытых вкладок
Авито, прямые Playwright/Puppeteer/CDP и управление браузером через UI.
Запрет действует при обычной работе, диагностике и восстановлении после ошибок;
недоступность runtime, CAPTCHA, HTTP block или неудобный результат не разрешают
перейти на browser use либо другой transport.

Внутренний Playwright runtime сохраняет описанные выше session/lease/network
ограничения. Пользователь может сам выполнить ручную проверку в том же окне;
агент использует только пассивное наблюдение, предоставленное runtime навыка.
При недоступности или ошибке runtime агент сообщает точную причину и следующий
шаг, не открывая Авито другими средствами.

## Проверки и предел подтверждения

Provider-local ci.json регистрирует preparation и единый test entrypoint без
изменения общего selector/workflow для следующего навыка.
Required hosted Ubuntu/macOS/Windows gates собирают exact lockfile, typecheck,
package validation, runtime/schema/proxy/pagination tests и реальный Chromium
только против loopback fixtures. Development/test origin нельзя передать через
CLI или MCP. Тестовые fake hosts не входят в подписанный пакет.

В этой задаче пользователь прямо запретил открывать Авито. Никакой live smoke
не выполняется. Локальные/hosted fixtures подтверждают код, а не актуальность
реальной разметки, filters, robots/access policy или работоспособность сайта.
Source PR/integration разрешены после offline gates; production publication
требует отдельного решения и разрешённой live проверки, либо явно принятого
ограничения валидации. Release/tag/deploy в эту задачу не входят.
