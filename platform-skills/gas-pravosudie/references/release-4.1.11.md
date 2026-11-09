# ГАС «Правосудие» 4.1.11

Новый immutable package с runtime 1.0.16 выпускает параллельные сессии после
активации общего host 3.31.0. Каталожная 4.1.10 уже была опубликована и затем
откачена из-за недоступной тогда зависимости host; её tag и bytes сохраняются.
Повторная публикация не переиспользует историческую runtime version.

Поведение и обязательные документы 4.1.10 сохранены. Меняются только release
metadata и runtime identity; namespace входа, auth/CAS, owner isolation, сроки,
проверка приложений и отдельная authority судебной подачи прежние.
Exact native provider gate на трёх OS и tagged artifact проверяются заново.
Совместимость общего parallel core подтверждает сохранённый native full stand
backend 1cc0a234 с runtime 572120ef и provider f1c2273; эти общие inputs не меняются
данным patch. Это не утверждение о полном тестировании нового состава стенда.
