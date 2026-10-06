# max-web 2.8.16

Ручной режим MAX ждёт последовательную загрузку Chrome, главной страницы и
точного контакта до 45 секунд в пределах существующей lease.

Остановка подтверждается закрытием browser context и освобождением profile
lock, даже если процесс Node ещё сохраняет служебные handles. Private receipt
связан с exact session UUID/PID и не содержит control token или port.
Отсутствующая либо чужая запись не доказывает закрытие.

Проверки: cold startup deadline, exact closure при живом PID, отказ для чужой
и failed session, приватность receipt и сохранение новой сессии; MAX regression
на Linux/macOS/Windows. Minimum host остаётся 3.4.0.
