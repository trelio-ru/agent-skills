# DodoStats / DrinkitStats Agent Skill

## Контур

`dodostats-drinkitstats` – единый platform Remote MCP навык. Оба публичных
endpoint-а `https://dodostats.ru/mcp` и `https://drinkitstats.ru/mcp` отдают
один server `dodostats-drinkitstats-revenue` с одинаковой версией протокола и
инструкцией. Публикуется один endpoint
`https://dodostats.ru/mcp`; второй домен не является runtime fallback.

Навык не содержит `.skillpkg`, исполняемого provider-кода, company connection
или credential. HTTPS, DNS/IP guard, MCP lifecycle и динамический строгий
read-only отбор исполняет общий trusted Remote MCP host Trelio. Изменение
endpoint, protocol, authentication, headers либо policy требует новой
immutable версии навыка; новый корректно размеченный read-only tool – нет.

## Возможности

Навык читает сохранённые снимки выручки DodoStats и DrinkitStats:

- доступность, покрытие, свежесть и quality reasons;
- поиск стран, городов и точек;
- сводку выручки за месяц;
- месячную динамику;
- рейтинг стран, городов или точек;
- сравнение до 25 явно выбранных локаций.

Host при каждом doctor/call получает актуальный `tools/list` и допускает только
tools с `readOnlyHint=true`, `destructiveHint=false` и безопасным именем.
Write-like и неполностью размеченные tools игнорируются отдельно и не отключают
существующие безопасные чтения. Навык не читает транзакции, не меняет данные и
не конвертирует валюты.

## Канонические файлы

- `platform-skills/dodostats-drinkitstats/SKILL.md` – runtime-инструкция агента;
- `platform-skills/dodostats-drinkitstats/remote-mcp.json` – catalog metadata и
  immutable Remote MCP declaration версии `1.1.0`;
- `platform-skills/dodostats-drinkitstats/tests/remote-mcp-contract.test.mjs` –
  детерминированный source contract;
- `platform-skills/dodostats-drinkitstats/development/probe_remote_mcp_live.mjs`
  – bounded read-only проверка живого provider contract перед публикацией и
  после неё.

## Проверка

```bash
node --test \
  platform-skills/dodostats-drinkitstats/tests/remote-mcp-contract.test.mjs
node platform-skills/dodostats-drinkitstats/development/probe_remote_mcp_live.mjs
```

Live probe перед публикацией подтверждает protocol `2025-03-26`, отсутствие
авторизации и строгие read-only annotations каждого актуального tool. Список
ниже – наблюдавшийся набор на 2026-08-23, а не versioned allowlist:

- `compare_revenue`;
- `get_available_revenue_data`;
- `get_revenue_summary`;
- `get_revenue_timeseries`;
- `rank_revenue`;
- `search_locations`.

Production smoke после публикации выполняется только через свежий
`get_agent_skill`, текущий `doctor_remote_agent_skill` и один безопасный
`get_available_revenue_data` через `call_remote_agent_skill_tool`.

Release tag имеет вид `skill-dodostats-drinkitstats-vX.Y.Z`. Общий workflow
проверяет provider source и сохраняет exact `remote-mcp.json`; `.skillpkg` для
этого декларативного навыка намеренно не создаётся.
