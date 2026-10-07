# max-web 2.8.19

Read-only assist разрешает точную кнопку «Найти по номеру» / «Find by phone»
на главной search surface. Cold контакт открывается в том же guarded профиле
при подготовке чтения. Host semantic gate и browser event fence согласованы;
composer, отправка, generic Continue, bot callbacks и внешние ссылки не
получают новых полномочий.

Нераспознанный результат phone lookup возвращает `MAX_UI_UNSUPPORTED` с
безопасной причиной, вместо generic worker failure. Для read-only подготовки
это сохраняет fenced окно с `preparationIssue`, без утверждения о найденном
адресате. Transport/HTTP ошибки не становятся UI recovery.

Включено распознавание `direct-chat-empty` из 2.8.18. Проверки воспроизводят
отменённый browser gate click, открытие cold контакта, неизвестный результат
и запрет мутаций; MAX regression на Linux/macOS/Windows.
Minimum host остаётся 3.4.0.
