# max-web 2.8.15

MAX показывает профиль нового контакта в основной области без role=dialog
и profile-класса. Runtime распознаёт routed layout-inner, исключает историю
и доступный composer и читает только явное поле телефона. Числа из сообщений
и бокового списка не участвуют в проверке адресата.

Проверки: routed профиль с вложенными span, исключение sidebar, composer
и message wrapper; полная MAX regression на Linux/macOS/Windows.
Минимальная версия host остаётся 3.4.0.
