# 4.1.5

Исправлен `gosuslugi_client_invalid` при входе через выбранный локальный аккаунт
Госуслуг. Runtime ГАС принимает optional UUID `accountId` из verified descriptor
и передаёт его helper-у ЕСИА без изменения. Legacy descriptor с `company` и
`member` остаётся совместимым; неизвестные поля и неверный явный account binding
отклоняются до браузера, согласия и обращения к данным входа.

Runtime 1.0.10 имеет отдельную immutable version; minimum host остаётся 2.4.0.
Регрессии проверяют передачу аккаунта через production sign-in flow до callback,
legacy вход, отсутствие browser/helper side effects при неверном descriptor
и сохранение прежних auth, consent и replay guards.
