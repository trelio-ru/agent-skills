# Работа с общими Agent Skills

Этот репозиторий содержит только общие provider-инструкции, runtime-код,
синтетические тесты и безопасные инструменты разработки. Корпоративные навыки,
реальные данные компаний, credentials, sessions, application identity и signing
keys сюда не добавляются. Перед правкой прочитай README.md и полный контракт
из references/ затронутого навыка; для релиза – docs/release-process.md.

Канонический main остаётся чистым. Новая работа выполняется в отдельном
физическом worktree и ветке codex/* от свежего origin/main. Перед правкой:
git fetch --prune origin, git status -sb, сравнение HEAD с upstream.
Не перезаписывай чужие изменения и не дели node_modules между worktree.

Комментируй неочевидные инварианты, права, состояния, retries и восстановление.
Изменение поведения одновременно обновляет контракт и содержательные тесты.
Проверки идут через GitHub-hosted CI на нужных OS. Локальные full gates и VM не
заменяют CI без доказанного billing/quota blocker и отдельного решения о VM.

Теги skill-<skill-id>-vX.Y.Z и выпущенные package bytes неизменяемы.
Provider-релиз не повышает версию Trelio, plugin или generic host.
Signing остаётся на production backend. Публикация – guarded plan/apply с exact
artifact, digest, CAS и read-back. Сетевые ошибки: минимум три безопасных повтора;
перед повтором неоднозначной записи сначала проверь фактическое состояние.

До commit: узкие проверки, git diff --check, полный diff и аудит публичности.
Commit на русском, только файлы задачи. Опубликуй ветку, дождись exact зелёного
CI и интегрируй через PR. Затем обнови чистый canonical main и удали только свой
clean merged worktree и ветку. Новая лицензия без решения пользователя не вводится.
