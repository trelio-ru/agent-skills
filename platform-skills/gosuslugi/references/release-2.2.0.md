# Госуслуги 2.2.0

## Внешние сервисы и MCP

`start --service gas-pravosudie` открывает ГАС «Правосудие» и использует его
реальный переход в ЕСИА. `start --service-url` поддерживает одну явно указанную
публичную HTTPS-сторону. DNS проверяется и закрепляется до unlock; callback
связан с фактическими redirect URI/state/client ID и допускается один раз.
Пароль/TOTP остаются на ЕСИА, согласие пользователь принимает самостоятельно.
Слоты внешних сессий отделены внутри прежнего AEAD vault; credentials и основная
сессия Госуслуг сохраняются. Действуют прежние роль физлица и native deadline.

Typed MCP action плагина 2.0.12 не принимает `parameters.stdin`. Для обычной
навигации и клика добавлены `page --navigate` и `page --click`; текст формы
передаётся через один owner-only JSON `--input-file`. Старый stdin ограничен
пятью секундами ожидания. Разрешения на подачу/подпись и action gate не расширены.

## Фокус и сохранение сессии

Окно создаётся неактивным. Стандартные Playwright storage-state APIs создавали
дополнительные foreground pages для остальных origins при чтении и restore.
Runtime теперь сам создаёт background-tab существующего окна, полностью
перехватывает её synthetic documents и использует прежний Playwright 1.60.0
codec localStorage/IndexedDB. Auth/рабочая вкладка остаётся на месте, автоматическое
сворачивание не используется. Native Keychain/DPAPI и namespace не меняются.

## Проверка

Локальный headed regression проверяет production network guard с настоящим
HTTP redirect, ручную границу согласия, пароль/SMS, возврат в тот же context,
ошибки/replay и запрет выдачи OAuth code/state. Отдельно проверяется сохранение
двух origins и IndexedDB с Date, BigInt и Uint8Array, восстановление и закрытие
служебной вкладки. На macOS после запуска, действий, collect/restore и входа
проверяется foreground PID: браузер не должен перехватить фокус.

Анонимная проверка живого `https://ej.sudrf.ru/` достигает экрана согласия в
production runtime: главная отвечает 200, экран входа – 401. До OAuth такой
401 сбрасывает cached proof и допускает штатный вход; после начала транзакции
HTTP-ошибки остаются блокером. Проверка не читает vault, не принимает согласие
и сама по себе не доказывает вход в личный кабинет ГАС.

Release gate включает exact tagged package, полные provider regressions,
native/security и headed flow на macOS/Windows, guarded publication, свежий
catalog read, signed doctor и проверку рабочей процедуры через опубликованный
runtime. Runtime 1.2.0, minimum host 1.6.17. ГАС получает отдельное обновление
инструкции с маршрутом к Госуслугам 2.2.0; своего executable package у него нет.

## Откат

Только guarded выбор прежнего неотозванного release с exact current CAS.
Теги/пакеты не перезаписываются. Откат к 2.1.0 возвращает foreground storage
pages и требует прежнего stdin-транспорта, внешние сервисы в нём отсутствуют.
