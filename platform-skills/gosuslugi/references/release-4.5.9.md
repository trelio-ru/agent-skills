# Госуслуги 4.5.9

Делегированный ESIA helper распознаёт ASCII-регистр четырёх букв
`response_type=code` в реальном запросе того же связанного окна. Сам запрос не
переписывается. Это совместимость authorization-code flow, а не поддержка
implicit или hybrid modes.

Пробелы, переводы строк, повторное percent-encoding, неизвестные режимы и
дубликаты по-прежнему отклоняются. HTTPS, GET, exact callback/fixed query,
state, отзыв credential capability и запрет replay остаются независимыми.
Синтетические регрессии проверяют все 16 ASCII-вариантов, небезопасные значения
и возврат через тот же browser observer с обязательным document commit.

Skill 4.5.9, runtime 3.5.9, minimum host 3.7.1. Storage, native unlock,
credentials, consent и host/plugin ABI не меняются. CI не доказывает успешный
вход на конкретный внешний сервис: после публикации нужен отдельный signed
runtime read-back и разрешённая живая проверка.
