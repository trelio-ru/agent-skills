# Windows native bootstrap

Контракт действует для всех общих и приватных навыков с PowerShell helper.
Навык без PowerShell не добавляет его ради этого правила. Новые приватные навыки
получают ту же policy через backend-managed
`get_company_private_agent_skill_authoring_contract` до подготовки draft/package.

Запускай только фиксированный helper из проверенного подписанного package либо
фиксированный inline-код runtime. Executable выбирается по проверенному абсолютному
системному пути; аргументы передаются отдельным argv с `shell=false`. Для каждого
дочернего процесса явно указывай `-NoProfile -NonInteractive -ExecutionPolicy Bypass`
перед `-File` или `-Command`. Это Process scope, без изменения политики пользователя
или машины. `MachinePolicy`/`UserPolicy` сохраняют приоритет; запрет организации
является blocker и не разрешает обход.

Не вызывай `Set-ExecutionPolicy`, не меняй registry/GPO и не проси ослабить постоянную
policy. Не полагайся на `PSExecutionPolicyPreference` родителя: защищённый child
environment вправе отфильтровать её. Пользовательский текст, сетевой ответ, путь
и credential не становятся кодом. Пути остаются данными; credentials идут только
через разрешённый защищённый транспорт.

До записи private material проверяй owner, DACL и отсутствие reparse/symlink.
Policy/ACL failure не подавляется и не возвращает успешный setup. Диагностика
сообщает стадию и безопасный код, не raw stderr, input или private path.

Перед публикацией проверь первый запуск без native cache: родительский Process
scope `Restricted`, отфильтрованный `PSExecutionPolicyPreference`, owner-only cache
и повторное чтение ACL. Постоянные policy до/после должны совпасть. Отдельный GPO
blocker не засчитывается как успешный bootstrap. Windows native gate обязателен;
успех macOS/Linux его не заменяет.

`node platform-skills/tools/check-windows-bootstrap.mjs` обходит production source
всех provider-ов, включая корпоративные в private checkout, и ловит забытый flag,
bare executable и изменение постоянной policy. Статический gate дополняет Windows
native regression; он не доказывает безопасность произвольного dynamic spawn,
integrity package или ACL сам по себе.
