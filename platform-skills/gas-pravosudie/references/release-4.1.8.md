# 4.1.8

Исправлена ошибка `gosuslugi_client_invalid` при подготовке входа через текущий
навык Госуслуг. ГАС принимает его optional host-v1 `controller` как пассивные
metadata; собственные browser, guardian и исходная lease остаются у ГАС.
Прежний формат клиента и выбранный UUID `accountId` поддерживаются.

Runtime 1.0.13 имеет отдельную immutable version; minimum host остаётся 2.4.0.
Регрессии проверяют текущий producer Госуслуг, передачу аккаунта через реальный
sign-in adapter, callback и отказ на неизвестных/неверных полях до browser IO.
