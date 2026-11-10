# Координация интеграции и версий

## Фоновое ожидание

При ожидании очереди или CI использовать `npm run git:integrate -- --background`
(для уже разрешённого релиза добавить `--tag <exact-tag>`). Worker сам продолжает
FIFO; launcher возвращает JSON только после сохранённого admission. Повторный
запуск той же живой задачи переиспользует ticket. Пустая очередь не доказывает
успех: `npm run git:integrate -- --status <ticket>` читает активный ticket либо
сохранённый terminal result с исходным/rebased SHA и private log path.

Агент сохраняет один heartbeat этого же чата раз в 15 минут, точный ticket,
canonical/task paths и оставшиеся шаги. При активном ожидании он заканчивает
проверку без уведомления; после success проверяет remote и выполняет штатный
cleanup и остальные уже разрешённые действия. Ошибка/unknown сначала требуют
проверки фактического результата, без blind retry и удаления чужих locks.
После завершения heartbeat отключается; при необходимом решении человека –
приостанавливается. Без подтверждённого scheduler нельзя обещать возврат.
Подробный [общий flow](https://github.com/trelio-ru/agent-workspaces-runtime/blob/6cdbf5d2123711c7345ea1bda31ef0395b1d54d1/docs/git-coordination.md#background-integration-and-chat-follow-up)
поставляется с той же exact maintainer revision. Компьютер и Codex desktop app
должны оставаться включёнными; CI/transport и release authority не расширяются.

## Инварианты интеграции

После commit запустить `npm run git:integrate`. Общая FIFO всех linked worktree
занимается до fresh fetch/rebase, публикации task branch/PR, финального exact
hosted CI и guarded main push/read-back. Не менять ожидающие HEAD/files.
Для разрешённого релиза: `npm run git:integrate -- --tag <exact-tag>`.
Версия проверяется до CI; занятая версия останавливает кандидата без перезаписи.
Подготовить source/manifest version до enqueue. Артефакт, подпись, activation/CAS
и production read-back сохраняют отдельные правила владельца репозитория.

`--status` показывает очередь; `--recover <ticket>` снимает только exact ticket
своего host после смерти owner и всей isolated process group. Возраст не даёт
права забрать очередь; живые grandchildren после SIGKILL остаются блокировкой.
Failed CI/rebase сохраняет работу. Внешний clone не входит в локальную очередь:
remote advance останавливает push, без автоматического rebase/retest.
Transport до remote mutation проверяет, что clean canonical main является
предком verified source, иначе останавливается без изменения remote.
Canonical hook проверяет live ancestry, exact worktree/branch/SHA/tag и verified
state; boolean, raw push и старый wrapper допуска не дают.

Единственная реализация – maintainer devDependency `@trelio/git-coordinator`
из exact Git commit `trelio-ru/agent-workspaces-runtime`, закреплённого lockfile.
После checkout выполнить `npm ci --ignore-scripts`; node_modules не делить.
Репозиторий владеет своими policy, CI adapter, hooks и transport. Общий код не
копируется, пакет не включается в plugin/runtime/provider artifacts и не меняет
их version/minimum policy. Обновление infrastructure не означает выпуск продукта.

Обычный FF main использует exact PR evidence и не запускает тот же gate заново.
Канонический pre-push продолжает проверять каждый protected push. Tag jobs
сохраняют собственные прежние release-проверки и publication/read-back.

<a id="active-turn-cwd"></a>

## Завершение worktree и рабочая папка hooks

Clean merged worktree нельзя удалять, пока он является `cwd` текущего хода
или primary checkout чата. Командные hooks запускаются из cwd сессии
([контракт Codex](https://learn.chatgpt.com/docs/hooks#config-shape)). При удалённой
папке ОС может отказать ещё до запуска hook; защищённый MCP-вызов тогда получает
`TRELIO_RUNTIME_HOOK_REQUIRED: missing`, хотя plugin, trust и runtime сохранны.

Явный `workdir` shell-команды в canonical main не переносит cwd hook.
Новая папка, показанная в карточке чата, также не доказывает смену контекста
уже идущего хода. Перед cleanup сравни exact target с cwd из текущего
`environment_context`/`turn_context`, а не только с `pwd` команды удаления.
При совпадении сохрани папку до завершения хода; удали её штатным helper только
из нового хода с подтверждённым другим cwd и без защиты primary checkout.
Не обходи отказ native cleanup другой командой удаления.

Если работу нужно целиком закончить и убрать в одном ходе, заранее используй
дополнительный task-worktree, который не меняет primary/cwd этого чата.
При `missing` после cleanup сначала проверь наличие cwd хода и реальные
PreToolUse/results. Новый вход OAuth, сброс pairing, изменение hook trust и
ручное добавление proof не являются исправлением удалённой рабочей папки.
