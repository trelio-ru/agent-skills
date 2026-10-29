# Госуслуги 4.5.10

Исправлен делегированный вход, при котором сайт отправляет параметры OAuth
в теле HTML POST-формы, а не в адресе. Такой начальный запрос использует
интернет-приёмная Банка России. Helper наблюдает исходный запрос без замены
на GET, повторного клика или создания нового окна.

Поддерживается только `application/x-www-form-urlencoded` с ограниченным
body. Дубликаты параметров между query/body, подмена transaction, callback
или state и replay отклоняются. Callback остаётся GET; POST callback, SAML,
implicit/hybrid OAuth и обход page/opener проверки этим патчем не добавляются.
OAuth values и тела запросов остаются только в private caller RAM.

Регрессии проверяют body-only request, дубликаты/encoding/bounds, early popup,
непригодные frame/XHR/page и настоящий browser form POST для same-page
password/TOTP и direct-popup SSO. Синтетический CI не доказывает успешную
авторизацию реального аккаунта или подачу обращения.

Skill 4.5.10, runtime 3.5.10, minimum host 3.7.1. Native unlock, хранение,
credentials, согласия и host/plugin ABI сохраняются.
