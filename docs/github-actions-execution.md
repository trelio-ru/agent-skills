# GitHub Actions

Общие provider gates исполняются на GitHub-hosted runners. Переменная
`TRELIO_ACTIONS_RUNNER_MODE=hosted` либо её отсутствие выбирает этот режим.
Обязательные OS и native gates не сокращаются из-за локальной платформы.
Зелёный exact SHA/OS не дублируется локальным полным прогоном.

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
