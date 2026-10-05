# Госуслуги 2.1.0

## Исправления

Стартовый `/lk` переводил живой портал на `/404`. Runtime открывает главную
и один раз использует штатную кнопку «Войти», которая формирует переход ЕСИА.
Публичная страница с кнопкой входа и оформленная ошибка «ничего не нашлось»
не считаются личным кабинетом. Synthetic regression включает тот же переход,
CSS/JavaScript и misleading footer с упоминанием документов.
Текущая авторизованная главная распознаётся по реальной ветке
`lib-header-auth` с кнопкой «Меню пользователя». Отсутствие старой подписи
«Мои документы» или скрытый logout больше не оставляют успешный вход в ожидании.

Живая ЕСИА после пароля показывает шесть ячеек TOTP. Runtime поддерживает
одно поле, native `maxlength=1` и фактически наблюдённый controlled layout
из шести enabled/editable `tel`/`one-time-code` полей без maxlength/inputmode.
Проверка layout предшествует первому символу и sent-флагу; после auto-submit
нет дополнительного click. SMS/отсутствующий seed остаются ручными, одна вкладка и исходный native
deadline сохраняются.

Source-only live diagnostic runner позволяет проверить исправление с явного
разрешения владельца на его сохранённом подключении под штатным OS unlock
и guardian. Он возвращает только fixed evidence/counts/source hash, без
auth text, labels, screenshots, input values, URL и сетевых тел. Resume
проверенного source сохраняет context и однократность отправки.

Synthetic GUI gate имеет native лимит одна минута: прежние 25 секунд были
короче допустимых 30 секунд одного Chrome launch. Fixed stage checkpoints
объясняют timeout без чтения auth данных; native expiry/crash tests сохраняются.

## Выбор роли

Физическое лицо выбирается по умолчанию по явной подписи типа в единственной
карточке ЕСИА. По прямому указанию оператора `start --role manual`, `roles`
и одноразовый `choose-role --ref ... --confirm` позволяют агенту выбрать
нужную организацию/ИП без раскрытия формы авторизации. Неоднозначные варианты
требуют уточнения, старые ссылки и повтор отправленной карточки блокируются.
Override относится только к текущей процедуре и не даёт согласия на подачу,
платёж, подпись или иные юридически значимые действия.

Native deadline может завершить JS до удаления control files. В таком случае
`status`/`stop` подтверждают `closed` по отсутствию guardian, не обращаясь к
потенциально переиспользованному порту и не удаляя ciphertext.

## Совместимость

Runtime 1.1.0, minimum host 1.6.17. Native Keychain/DPAPI helper, AEAD envelope,
namespace, connection settings и plugin policy не меняются. В encrypted record
добавлен optional признак `storageRole=personal`; старая запись читается без
потери credentials, но неизвестная роль cookies не переиспользуется. Сохранённые
credentials не вводятся заново из-за этой версии. Активная прежняя сессия
завершается штатным stop перед переходом на новый runtime.

## Приёмка

Обязательны native/security и headed browser regressions на macOS/Windows,
один exact tagged package и guarded publication. Fresh get_agent_skill должен
вернуть 2.1.0/runtime 1.1.0 с ожидаемым digest, а signed doctor – безопасное
состояние подключения.

Живой smoke проверяет штатный переход главная → ЕСИА, reuse сохранённых
данных, code challenge, автовыбор физлица и ограниченный explicit выбор роли, фактическое открытие
личного кабинета и штатный stop/read-back closed. Synthetic form и rendered
bootstrap сами по себе не доказывают успешный вход в настоящий аккаунт.

## Rollback

Guarded rollback выбирает прежний неотозванный release с exact current CAS.
Immutable tags и packages не меняются. Откат к 2.0.2 возвращает дефекты
стартового перехода и неподдерживаемых шести ячеек кода.
