# Работа с общими Agent Skills

Этот репозиторий содержит только общие provider-инструкции, runtime-код,
синтетические тесты и безопасные инструменты разработки. Корпоративные навыки,
реальные данные компаний, credentials, sessions, application identity и signing
keys сюда не добавляются. Перед правкой прочитай README.md и полный контракт
из references/ затронутого навыка; для релиза – docs/release-process.md.
Для Windows/native bootstrap прочитай полный
[windows-native-runtime.md](docs/windows-native-runtime.md). Общий статический
gate обходит все provider-ы; native gate выполняется на реальной Windows.

Канонический main остаётся чистым. Новая работа выполняется в отдельном
физическом worktree и ветке codex/* от свежего origin/main. Перед правкой:
git fetch --prune origin, git status -sb, сравнение HEAD с upstream.
Не перезаписывай чужие изменения и не дели node_modules между worktree.

Комментируй неочевидные инварианты, права, состояния, retries и восстановление.
Изменение поведения одновременно обновляет контракт и содержательные тесты.
Тесты Markdown-контрактов сравнивают смысл после нормализации LF/CRLF:
переводы строк checkout не меняют инструкции и не должны ломать Windows gate.
При правке Python CLI проверяй кодировку настоящих stdout/stderr pipes:
StringIO и UTF-8 locale не воспроизводят ошибки Windows code page. Для Telegram
действует [контракт CLI](docs/telegram-mtproto-message-workflows.md#кодировка-cli).
Проверки идут через GitHub-hosted CI на нужных OS. Локальные full gates и VM не
заменяют CI без доказанного billing/quota blocker и отдельного решения о VM.

Теги skill-<skill-id>-vX.Y.Z и выпущенные package bytes неизменяемы.
Для каждой новой signed-runtime публикации нужна уникальная runtime version,
даже при изменении только инструкций; порядок — docs/release-process.md.
Provider-релиз не повышает версию Trelio, plugin или generic host.
Signing остаётся на production backend. Публикация – guarded plan/apply с exact
artifact, digest, CAS и read-back. Сетевые ошибки: минимум три безопасных повтора;
перед повтором неоднозначной записи сначала проверь фактическое состояние.

До commit: узкие проверки, git diff --check, полный diff и аудит публичности.
Commit на русском, только файлы задачи. Опубликуй ветку, дождись exact зелёного
CI и интегрируй через PR. Затем обнови чистый canonical main и удали только свой
clean merged worktree и ветку. Новая лицензия без решения пользователя не вводится.

`Public source boundary` и check-public-source.mjs проверяют tracked snapshot
перед каждым push. Корпоративные исходники не копируются даже как fixtures.
Публикация исходников не разрешает перенос application identity; Telegram
artifact собирается только в отдельном private release-контуре.
