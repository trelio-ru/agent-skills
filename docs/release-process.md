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

В `release.json` новая публикация также содержит проверенное издателем
`release.routingSummary`: одно английское предложение о возможностях, 12–180
ASCII-символов без URL и переносов. Publisher связывает его с plan/CAS и
проверяет read-back; title, description и keywords не служат fallback. Старый
immutable tag без этого поля не переписывается – нужен новый patch release.

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

## Instruction-only навыки

Навыки, использующие существующий browser tool без своего executable, проходят
exact hosted source/instruction gate и реальный browser smoke. Они не получают
фиктивный runtime manifest или `.skillpkg` ради общего package workflow.
Новая версия публикуется через штатный `/internal-admin/skills/`: создание
catalog item, затем instruction-only release с exact current-release CAS.
Название и описание берутся из explicit source metadata, основная инструкция —
из канонической проекции без display-only полей; routingSummary проверяется
издателем отдельно. В summary фиксируются repository, exact integrated commit,
PR и проверенное поведение. После публикации проверяются current version,
инструкция, routingSummary, отсутствие runtime и реальный browser-сценарий.
Публикация не назначает навык компаниям и не меняет их подключения.

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

### Выбор межкомпонентного стенда до выпуска

До enqueue один раз проверь полный diff от последнего опубликованного provider
tag до candidate, включая manifest, инструкции, зависимости и обе стороны
rename. В результате review запиши exact base/head, изменённые контракты и
выбранный набор проверок. Название «диагностика», patch SemVer и небольшой diff
сами по себе не доказывают низкий риск. Неизвестное влияние требует полного
межкомпонентного стенда, а не предположения о совместимости.

| Влияние изменения | Обязательные проверки |
| --- | --- |
| Только текст/карточка либо безопасная проекция диагностики; прежние success/failure, доступ, side effects и recovery сохраняются | Targeted regression изменённого пути, штатный provider gate на всех обязательных OS, instruction/package/source-boundary checks, tagged artifact и live smoke изменённого поведения |
| Поведение одного provider внутри прежнего host ABI: parser, чтение/отправка через уже допущенную команду, локальное завершение собственных дочерних процессов | Те же native provider gates, содержательные regressions фактического поведения и профильный live smoke; затронутый межкомпонентный сценарий добавляется, если provider tests не покрывают его границу с host |
| Новые/изменённые host ABI, signed command admission, account/session authorization или namespace, scopes/ACL, ACK/cursor/reference, unknown-outcome/replay, original-file identity или encrypted delivery; совместная правка backend/host; неясное влияние | Native gates изменённых компонентов и полный cold/fault question-system stand из канонического backend checkout с exact source pins |

Первая строка не разрешает менять семантику отказа под видом новой ошибки.
Например, retry вместо uncertain, успешный ответ вместо отказа или смена
порядка lock/auth/IO относятся к соответствующему опасному контракту. Изменение
только фиксированного diagnostic code/stage при прежнем отказе не требует
повторять 3000-file backend fixture, если полный review подтвердил отсутствие
таких изменений. Реальные pipes и native session contention при этом проверяет
provider regression на каждой обязательной OS.

Локальный process cleanup во второй строке требует реальных native fault tests:
аварийный уход host, kill/timeout launcher, отсутствие surviving child/native lock
и сохранение отдельного unrelated процесса. Проверяется прежний результат при
обычном завершении и отказ до provider IO при недоступной изоляции. Это не
разрешает расширять timeout, обходить host policy либо менять смысл unknown
после прерванной записи. Если меняется эта общая граница, нужна третья строка.
Стенд другой OS, который не исполняет изменённый native путь, не заменяет эти
tests и не добавляется лишь ради его размера или длительности.

Совместимый provider-only release не требует нового backend commit, обновления
его question-system fixture pin, product tag/deploy или нового host release
только ради очередной версии provider. Используй уже опубликованный совместимый
backend/host; проверь actual readiness и exact опубликованный package до smoke.
Если новая возможность требует их изменения, сначала выпусти и проверь нужную
зависимость обычным flow. Full product release в backend сохраняет свой full
gate; эта таблица его не сокращает.

Не дублируй уже успешный обязательный gate того же SHA/OS/плана локальным full
прогоном. Tag job проверяет exact PR evidence и строит artifact; signing/CAS и
read-back остаются самостоятельными шагами. Успех старого SHA не становится
проверкой нового candidate. Для неизменившегося компонента можно сослаться на
его exact baseline как на подтверждение совместимости, но не объявлять новый
состав компонентов полностью протестированным. После нового изменения повтори
review и только затронутые обязательные gates, сохранив evidence остальных
неизменившихся inputs. Failed/skipped/unknown обязательный результат блокирует
выпуск; другой runner, сокращённый timeout или новый release не обходят отказ.

Live smoke проверяет конкретное изменённое поведение, а не просто exit 0 или
версию. Для исходящих нужны обычная sending authority и exact read-back;
неизвестный исход сначала устанавливается без повторной отправки. Ошибка
readiness либо занятая личная сессия требует диагностики своего владельца,
а не нового full stand, сброса входа, удаления lock или серии одинаковых probes.
Зелёный synthetic stand не считается ответом реального ассистента.


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
