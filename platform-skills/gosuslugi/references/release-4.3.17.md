# Госуслуги 4.3.17

Исправлен ложный отказ после принятого callback ЕСИА. Сервис может использовать
собственный routing `state` на другом пути в той же HTTP redirect chain.
Он не является вторым OAuth callback; runtime сохраняет исходный proof и ждёт
успешный document commit сервиса.

Исключение ограничено exact цепочкой Request после принятого HTTP callback,
GET без fragment, одним routing state и отсутствием code/error/access_token/
id_token. Произвольная новая навигация, исходный callback, replay и OAuth payload
проходят прежние проверки. Доступ к credentials после callback не возобновляется.

Синтетические регрессии проверяют несколько redirect hops, отсутствие успеха
до commit и отказ при подмене цепочки, HTTP proof, callback, method и payload.
Skill 4.3.17, runtime 3.3.17, minimum host 3.0.22.
