# Выпуск общих навыков

Общие исходники живут в `trelio-ru/agent-skills`. Корпоративные навыки и
исторические artifacts остаются в отдельном приватном контуре. Этот репозиторий
начинается с проверенного снимка, без истории прежнего смешанного репозитория.
Копировать его полную историю или старые tags в публичный Git запрещено.

## Обычный provider

Изменение получает собственные skill/runtime SemVer. После exact зелёного PR
создай immutable tag `skill-<skill-id>-vX.Y.Z` на проверенном SHA, уже достижимом
из `main`. Штатный `platform-skill-runtimes.yml` сохраняет единственный artifact.
Production signing key отсутствует в GitHub и остаётся на backend Trelio.

Каждый release tag отправляй отдельным `npm run git:integrate -- --tag <exact-tag>`.
GitHub не создаёт push/create events при отправке больше трёх tags одним push,
поэтому наличие remote tag само по себе не подтверждает запуск сборки.
Проверь exact workflow run каждого tag до production publication. Если событие
не создано, immutable tag не удаляется и не переписывается: исправление получает
новую skill/runtime version и повторный exact PR gate.
Источник: [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).

Каждая новая публикация signed runtime получает ещё не выпущенную для этого
skill runtime version, в том числе когда меняются только инструкции. Backend
отклоняет повторную версию с `AGENT_SKILL_RUNTIME_VERSION_EXISTS` даже при
совпадении package bytes. Согласованно меняй release.json и runtime constant;
minimum host повышается только при новой зависимости. Не переписывай уже
созданный tag после неуспешной публикации: исправление получает новую skill
version и новый tag, затем повторный exact CI и отдельный plan/apply.

Из актуального product checkout запускается штатный guarded helper:

```sh
node ops/scripts/publish_agent_skill_release.mjs \
  --repository trelio-ru/agent-skills \
  --tag skill-<skill-id>-vX.Y.Z \
  --publisher-user-id <production-user-uuid>
```

Проверь весь plan и повтори ту же команду с `--apply <exact-plan-sha256>`.
При неоднозначной записи сначала прочитай production state. После публикации
проверь каталог и выполни точный безопасный smoke. Source, tag и runtime bytes
после выпуска не переписываются. Trelio/plugin/host release не создаётся.

## Telegram MTProto

Код и полные provider tests выполняются в этом публичном репозитории на
Linux/macOS/Windows. После зелёного exact PR SHA tagged job повторно проверяет
эти три успешных jobs и source-boundary gate, затем сохраняет один
`telegram-mtproto-<version>.skilltmpl`. Повторной private копии source и полного
provider suite не требуется; historical private tags и artifacts неизменяемы.

Builder с `--template-release-inputs` создаёт формат
`trelio-agent-skill-package-template/v1`. Он сохраняет все source-backed файлы
байт в байт и только descriptor `telegram_application_identity_v1` для exact
`telegram-app-credentials.json` (0644). Значение environment input даже не
читается. В public GitHub нет реальной пары, repository secret или готового
пакета с ней. Template не является installable/signed runtime.

Guarded backend publisher проверяет template и его исходный digest, затем в
защищённом серверном процессе добавляет application identity, проверяет обычный
`trelio-agent-skill-package/v1` и подписывает exact final bytes. План связывает
public template digest, fingerprint серверного input и final package digest;
смена любого из них требует нового плана. Модель и local publisher получают
только hashes и metadata, без identity либо materialized package bytes.
Backend должен поддерживать этот flow и иметь настроенный protected input до
первого выпуска public template. Старые installable packages и их provenance
не переписываются. Проверки materialization/signing принадлежат backend;
они не повторяют Telegram browser/native provider suites.

Application identity намеренно извлекаема получателями установленного package;
это не разрешает публиковать её в GitHub. Личные sessions, OTP, пароли и keys
никогда не входят в source или package.

## Проверки

`Public source boundary` проверяет tracked snapshot. Обычный workflow выбирает
provider-ы по exact diff и проверяет Linux/macOS/Windows. Для email, Госуслуг,
Т-Банка и WhatsApp сохраняются их отдельные native/browser workflows.
Подробности исполнения – [github-actions-execution.md](github-actions-execution.md).
Windows bootstrap следует [общему контракту](windows-native-runtime.md),
который распространяется и на приватные навыки.


## Бюджет основной инструкции

До новой публикации SKILL.md после удаления explicit полей карточки и trim
должен помещаться в 16 384 байта UTF-8. Технический description и инструкция
сохраняются; reader/projection определён в [README](../README.md#метаданные-каталога).
Tagged publisher и backend проверяют byte limit; число символов его не заменяет.
Подробные сценарии можно вынести в references только при доставке тех же файлов
в signed package и явной обязательной загрузке до соответствующего действия.
Safety/approval/replay/callback/lease rules не удаляются ради размера.
Полный MCP result отдельно ограничен 40 000 байтами после projection/hydration
и реальной сериализации клиента; большой manifest или personal layer также
могут сделать ответ слишком большим. Ответ не обрезается и не разрешает запуск.

`node platform-skills/tools/report-instruction-budget.mjs` проверяет существующие
общие source без вывода текста. `--strict` возвращает nonzero при превышениях;
его отчёт не является live read-back или разрешением переписать immutable release.
Текущий [аудит](skill-instruction-budget-audit.md) охватывает все общие source.
Release gate не допускает повторных превышений. Перед rollout общего delivery
guard сначала выпусти совместимые provider-инструкции и packages, затем проверь
полные live instructions/execution ответы (native и text-compatible), и лишь
после этого выпускай backend/host guard. Зелёный source audit не меняет live
releases. Потеря обязательного документа блокирует действие; одна ссылка на
неупакованную справку не считается доставкой.

Final CI и reservation tag выполняются внутри [общей FIFO](git-coordination.md), до publication.
