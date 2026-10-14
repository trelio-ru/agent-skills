# Авито: первая версия

## Область и исполнение

`avito-search` 1.0.0 читает публичную выдачу и объявления Авито.
Один текстовый поиск для любых объявлений, без разделения товаров и услуг.
Никакого входа, сообщений, избранного, телефонов, покупки, seller reviews или
мониторинга. Неофициальные endpoints могут измениться; отказ fail-closed.

`core.mjs` владеет валидацией query/город/цена/пагинация/ID, exact city matching,
парсингом, проверкой соответствия ID карточки и bounded output.
`trelio-avito.mjs` владеет read-only transport и обработкой ошибок.
Модель выбирает смысловой запрос и сравнивает прочитанные предложения:
это содержательное решение, его нельзя заменить механической сортировкой.

Common host владеет Playwright installation, browser executable discovery и
absolute lease. Signed `delegated-ephemeral` binding проверяется до запуска.
Provider как вызывающий сценарий владеет одним непостоянным browser context
текущей команды. Вход и reusable credentials отсутствуют; нет ciphertext store,
Keychain/DPAPI, plaintext session snapshot или persistent Chrome profile.
Browser closes on success, failure, SIGTERM/SIGINT and lease expiry.
Новая команда создаёт отдельный анонимный context; `search --open N` читает
карточки внутри того же context и сохраняет общую последовательную очередь.

Only HTTPS GET/HEAD on Avito/static Avito hosts are permitted. Navigations and
XHR/fetch are limited to home, public numeric/canonical item pages and the two
declared read endpoints. Credentials/ports, login/account pages, other hosts,
local sockets and writes are rejected before network dispatch. Listing input
selects a numeric ID, not the supplied URL as fetch destination. Output links
remain Avito data. No browser storage/credentials or raw errors are returned.
During an explicit headed manual-assist handoff the human may complete Avito's
own CAPTCHA using its first-party browser traffic. This does not add a CLI write
command, an automated solver or account access. The original lease remains;
after a new successful home document one read-only retry is allowed. A repeated
block stops the attempt. The window closes on timeout/cancel without success.

## Запросы и состояние

Anonymous requests go through the Avito page's `fetch`. One owner-only device
request lock prevents concurrent commands. Timestamp-only request state under
the host config root keeps five-second minimum spacing and a 20-minute cooldown
across CLI processes and company connections on that device. No query, company
content, result, URL or browser state is stored in this file.

429/firewall responses stop all further calls, including home/search probes.
439/401/403 return `AVITO_BLOCKED`. 5xx/timeouts do not claim logout or empty
results. No timer retries, secondary transport or alternate IP are used.
Streamed response bodies are capped at 8 MiB. Search returns up to 20 entries;
at most three item reads are included. Description is capped at 16000 characters,
other text at 2000 and arrays at 40, with `contentTruncated` made explicit.
The complete packet has a 64000-byte text budget, preserving Unicode code points.

## Upstream

Pure parsers/API helpers are adapted from
https://github.com/0xBADC0FFEE/avito-shopping-mcp at commit
`27857b9ee0609a4f2100e5d65baf4fdde506d18c`.
TypeScript-only annotations are removed, relative imports use `.mjs`.
URL guards additionally reject embedded credentials/ports, and invalid dates
remain unknown rather than throwing an untyped error.
Original MIT notice is retained adjacent to the adapted files and included in
the signed package. Upstream browser/session store, MCP server and dependencies
are not included; Trelio provides the host primitives.

## Проверки и публикация

Synthetic tests exercise actual parsers and CLI validation, malicious inputs,
wrong item ID, cross-origin redirects, exact city, malformed responses, missing
price, bounded text, persisted cooldown, request serialization and package
composition. CI runs the provider and package tests on Linux/macOS/Windows.

Before first publication a bounded local live smoke must search a normal public
query, read at least one returned listing in the same session, and verify its
ID/title/description/price/link. Repeat with another city or pagination to verify
real search parameters. User data, seller identifiers and raw live responses
are not committed as fixtures. Live results remain local. A 429/439 response is
blocker evidence, not a successful functional smoke. Do not publish while the
required successful reads are unverified.

After green exact PR gates and integration, tag `skill-avito-search-v1.0.0`;
retain the hosted artifact and publish with the guarded product CLI. The source
and artifact stay immutable. No product/plugin/host release is required.
