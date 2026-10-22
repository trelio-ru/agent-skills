# Email-код для защищённого браузера

`browser_mail_auth.py` — общий provider adapter к host
`trelio.protected-browser-mail-auth/v1`. Здесь нет URL/селекторов внешних сайтов
или собственного credential store. Штатный signed executor, выбранный bound
account, native guardian и OS-backed IMAP credential остаются обязательны.
Source/синтетический тест не подтверждают production publication или live вход.

`authentication-browser --request HANDLE` сначала обращается к exact host
module из `TRELIO_BROWSER_MAIL_MODULE_URL` через прежний host-selected Node:
`shell=false`, private stdin/stdout, без значений в argv/env. Host сверяет
company/member/mail skill/account и существующий browser attempt. Handle —
locator, не capability. Без API не использовать ordinary read или другой connector.

До browser password/method input runtime делает два readonly EXAMINE текущей
папки и передаёт scope/UIDVALIDITY/UIDNEXT−1. Host сохраняет baseline и только
затем продолжает браузер. Search ограничен новыми UID до текущего UIDNEXT−1,
максимум 500 slots/20 sender candidates; без UNSEEN. BODY.PEEK не меняет flags.
Повторная UIDVALIDITY проверяется перед выдачей. Sender/recipient, INTERNALDATE,
literal anchors, MIME и единственный 6/8-значный код сверяются приватно.
Старый UID/changed source/несколько кодов дают отказ, без выбора первого письма.

После доставки host повторяет document/challenge проверку и сохраняет fence
до fill/submit. Только положительный browser selector разрешает отдельно
авторизованную `--mark-read-after-success`. Она переиспользует прежний
`command_ack_reference`: exact UID/UIDVALIDITY/full RFC822 SHA, additive Seen,
native FLAGS read-back, без снятия других flags/SMTP/receipts/EXPUNGE.
One-write fence находится у host в прежнем encrypted attempt; mail не создаёт
второй journal. Потерянный ответ допускает только `--verify-only`; seen=false
не разрешает новый STORE. Успех входа сохраняется отдельно от ошибки пометки.

`authentication-profile --brand BRAND` предназначен для отдельно порученного
authoring/live verification. Он читает bounded PEEK candidates по TEXT brand
в последних 500 UID slots. Возвращаются только sender, фактически совпавшие
literal anchors из brand/фиксированного словаря и длина единственного кода;
тема/тело/OTP/auth URL исключены. Ничего не помечается прочитанным. Такой
результат не является signed matcher, входом или mutation authority.
ASCII brand идёт без CHARSET, Unicode — одним synchronizing literal с CHARSET
UTF-8 до ENABLE UTF8=ACCEPT и без CHARSET после него. В обоих случаях incoming
metadata ограничена до allocation. Ошибка profile возвращает только fixed этап
`EMAIL_BROWSER_AUTH_PROFILE_<STAGE>_UNAVAILABLE`, без raw IMAP/адреса/UID/текста.
Этап помогает локализовать отказ, но не доказывает отсутствие письма или доступа.

Tests используют реальный stdlib IMAP encoder/parser и synthetic socket stream:
baseline до запроса, PEEK, exact recipient/sender, stale/ambiguous/missing mail,
UIDVALIDITY/scope/content checks, private code/closed output, verified login
до ACK, неизменные другие flags и verify-only после неизвестного ответа.
Все OS/native gates и actual private pipe остаются обязательными до выпуска.
