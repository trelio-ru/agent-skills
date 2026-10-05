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

Его общий код и синтетические тесты публичны. Реальная Telegram application
identity не переносится в этот репозиторий, его secrets или публичные artifacts.
Public tag не собирает пакет с таким input. Production artifact по-прежнему
собирается в приватном release-контуре из проверенного снимка общего source;
guarded publication явно указывает исходный приватный repository. Это отдельная
сборочная граница, а не разрешение вести две независимо изменяемые реализации.
Перед release сверяются файлы runtime, инструкции и manifest с exact public SHA.

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
