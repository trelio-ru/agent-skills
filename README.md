# Trelio Agent Skills

Публичный репозиторий общих provider Agent Skills Trelio.
Инструкции, runtime-код, тесты и инструменты сборки публикуются отдельно от
корпоративных навыков, личных подключений и production signing.

В `platform-skills/` опубликованы 14 общих навыков: 1С ЭДО, КонсультантПлюс,
DodoStats / DrinkitStats, почта, ГАС «Правосудие», Госуслуги, iPhone Mirroring,
MAX, поиск Ozon, заказные письма Почты России, Т-Банк, Telegram MTProto,
Telegram Web и WhatsApp. Для конкретного provider читай его `SKILL.md`.

Корпоративные 1С и устаревший Telegram-пилот сюда не входят. История начинается
с отобранного source snapshot; исторические release tags сохраняют первоначальную
provenance. Текущие опубликованные версии и подключения Trelio не меняются от
переноса исходников. Новый tag не создаётся только ради изменения repository.

`platform-skills/tools/` содержит детерминированный builder и регрессии.
Проверки идут на Linux/macOS/Windows через GitHub Actions. Быстрый локальный gate:

```sh
node --test platform-skills/tools/*.test.mjs
node platform-skills/tools/check-public-source.mjs
```

[Порядок выпуска](docs/release-process.md) сохраняет production signing на
backend. Telegram application identity и сборка содержащего её artifact остаются
в приватном release-контуре. Корпоративные source и старые artifacts сохраняются
приватными. Лицензии сторонних компонентов лежат рядом с их исходниками;
отдельная новая лицензия на весь проект этим переносом не вводится.
