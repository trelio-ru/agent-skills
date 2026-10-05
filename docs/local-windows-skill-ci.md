# Windows CI

Обязательный штатный gate исполняется на GitHub-hosted Windows runner.
Он проверяет реальные DPAPI CurrentUser, owner-only DACL и native lifecycle;
результат macOS либо Linux не заменяет эти проверки.

Локальная VM допустима только после подтверждённого GitHub billing/quota blocker
и отдельного прямого разрешения пользователя на этот запуск. Существующее
окружение переиспользуется: без переустановки, новой регистрации runner,
сохранения пароля ОС или изменения постоянных execution policies.
Synthetic source привязывается к exact SHA и checksum архива, тесты запускаются
в правильной учётной записи и реальной интерактивной desktop session.

Сохрани bounded результат и OS/toolchain metadata, закрой owned процессы,
удали только свои временные материалы. Выключение начинается с guest shutdown
request; принудительная остановка допустима лишь после полного timeout и
свежего подтверждения, что VM всё ещё запущена. Credentials и установленное
окружение сохраняются. Этот документ не содержит локальных VM identifiers,
user SID, machine paths или подключения конкретного оператора.
