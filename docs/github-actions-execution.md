# GitHub Actions

Общие provider gates исполняются на GitHub-hosted runners. Переменная
`TRELIO_ACTIONS_RUNNER_MODE=hosted` либо её отсутствие выбирает этот режим.
Обязательные OS и native gates не сокращаются из-за локальной платформы.
Зелёный exact SHA/OS не дублируется локальным полным прогоном.

Node suites с native watchdog/headed browser исполняются последовательно по
файлам (`--test-concurrency=1`) и в общей matrix, и в fallback. Они разделяют
реальный desktop и часы внутри job; параллельные browser/native fixtures не
должны искажать deadline proof. Набор assertions, тайм-ауты и native limits
при этом не ослабляются.

Tagged workflow собирает один artifact на `ubuntu-latest`; production signing
не выполняется в GitHub. Telegram MTProto имеет отдельную приватную сборочную
границу по [release-process.md](release-process.md).

Self-hosted fallback допустим только после явного GitHub quota/billing blocker
с exact run URL и diagnostic. Queue delay, 5xx и failed tests не доказывают
исчерпание лимита. Существующий repo-scoped runner запускается только на один
ожидаемый job; постоянная service и новая регистрация не требуются. Запуск
Windows VM требует отдельного прямого разрешения на конкретный запуск.
После реального успешного hosted gate возвращается `hosted` с read-back,
локальные runners остаются offline, поднятая для CI VM выключается.

Network errors проходят минимум три безопасных повтора с растущей паузой.
Перед повтором неоднозначной mutation проверяется её фактический результат.
Подмена artifact локальной сборкой, изменение immutable tag и обход CAS запрещены.

## Выбор provider проверок

Изменения внутри provider выбирают только его обязательные OS и shared
instruction/package contracts. Новые Node providers регистрируют `ci.json`
в своей папке: schemaVersion, language=node, testFile под tests/ и prepareFile
под development/. Общие selector/workflow/executor для добавления не меняются.
Регистрация не может переопределить прежний маршрут или выбрать соседний
provider, symlink, shell command либо внешний path. Preparation выполняется
exact Node argv с shell=false. Package mode не устанавливает browser fixtures.

Изменение `ci.json` или provider-owned preparation остаётся в scope этого
provider. Изменение общей логики в `platform-skills/tools/**` или общего
workflow запускает полный набор, включая новые регистрации. Это сохраняет
защиту от незаметного отключения чужих проверок без полного прогона на каждый
новый навык. Unknown provider и malformed registration завершаются fail-closed.

При полном удалении provider selector подтверждает отсутствие всего каталога
в exact Git head PR. Его удалённые suites больше не запускаются, но общие
instruction/package contracts остаются обязательными. Удаление одного ci.json
при оставшихся source не считается полным удалением и завершается fail-closed.
