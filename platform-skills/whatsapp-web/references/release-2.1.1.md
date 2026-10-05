# whatsapp-web 2.1.1

HTTP-ошибка основной страницы сохраняет числовой код и безопасный origin.
Она обнаруживается до определения входа и не маскируется под неизвестный UI.
Ответы ресурсов и iframe не подменяют состояние основной страницы.
Для общего observer требуется host runtime 3.4.0; локальное подключение,
credentials, profile namespace и native deadline сохраняются.

На Windows временный `EBUSY` при записи управляющего файла Edge ожидается
внутри прежнего deadline того же процесса. Permissions/format errors остаются
блокирующими; новый браузер, профиль или вход не запускаются.

Проверки: GitHub-hosted regression текущего provider-а и exact runtime contract;
синтетические HTTP 401/403/404/429/500/503 без входа и внешних mutations.
