# Госуслуги 4.3.9

Runtime 3.3.9 разрешает versioned JSON-словари всех приложений портала
`gu-st.ru/*-st/assets/i18n/` и `lib-assets/i18n/`, включая словарь раздела
ФССП и словари `sf-portal-st`, которыми пользуются формы обращений. Прежняя
request policy блокировала их: на результате ФССП показывались ключи вроде
`RESULT.DEBT_INFO.CURRENT_DEBT`, а форма могла остаться на загрузке.

Автоматический `page --click` теперь отклоняет `target=_blank` до отправки и
блокирует `window.open` в owned page, включая отложенные обработчики. Chromium успевал
активировать новое окно до закрытия unowned popup, перехватывая фокус.
Синхронная попытка открыть popup возвращает `popup_requires_manual`.

Разрешение ограничено exact HTTPS-хостом, GET/HEAD, XHR/fetch и путями
словарей. Навигация, POST, API-запросы и URL с query/fragment закрыты.
