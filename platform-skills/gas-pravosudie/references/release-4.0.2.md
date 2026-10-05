# ГАС «Правосудие» 4.0.2

## Восстановление после ошибки входа

Runtime 1.0.2 согласует фазу worker-а с завершением делегированного helper-а.
После ошибки, отмены или неверного callback сессия получает
`authorization_failed` и сохраняет исходный безопасный код вместо устаревшего
ожидания `authorize`. Это исправляет сценарий
[обращения №10](https://trelio.ru/updates/feedback/10/).

Отдельный разрешённый `prepare-sign-in --confirm` возвращает ту же вкладку
на публичный ГАС и создаёт новый helper. Ошибка сама не запускает повтор:
незавершённый helper, неизвестный результат и приватная страница ЕСИА сохраняют
свои ограничения. Browser/context, encrypted storage и native deadline не
пересоздаются. CLI передаёт фиксированный следующий шаг вместе с кодом причины.

## Проверки

Синтетический regression исполняет настоящий browser adapter и orchestration
worker-а: terminal error → failed → отдельный prepare → verified callback.
Дополнительно проверяются pending/cancel, неизвестный код, чужой context/page,
неверный return, потерянный helper, expired permit, закрытая исходная вкладка,
сбой сохранения после callback и HTTP/CLI проекция ошибки без raw auth content.
Эти проверки не устанавливают причину `initialization_failed` Госуслуг и не
подменяют реальный ЕСИА-вход.
