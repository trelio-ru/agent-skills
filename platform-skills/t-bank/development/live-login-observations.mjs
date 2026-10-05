// Only bounded authentication copy and structural facts may leave the worker.
// Never accept an input value, HTML, URL query, request body, cookie, screenshot,
// raw error or arbitrary object. Credentials are used only as redaction needles
// inside the protected process and never included in the returned object.
export function safeAuthLabels(labels, secrets) {
  return labels.slice(0, 30).map(value => {
    let text = String(value).replace(/\s+/g, ' ').trim();
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[скрыто]');
    text = text.replace(/https?:\/\/\S+/gi, '[ссылка]').replace(/\d/g, '•');
    return text.length <= 180 && /^(?:Введите|Ввод|Код|Пароль|Вход|Войти|Подтверд|Подтвержд|Телефон|Логин|Номер|Выберите|Придумайте|Создайте)/i.test(text) ? text : null;
  }).filter(Boolean).slice(0, 8);
}

export function authEvidence(text) {
  // Fixed witnesses explain which part of the real page activated a rule. They
  // cannot copy arbitrary provider content or a currently generated code.
  return {
    generator: /генератор(?:а|е|ом)?\s+одноразовых\s+паролей/i.test(text),
    authenticator: /TOTP|аутентификатор/i.test(text),
    authenticationApp: /приложени[ея]\s+для\s+аутентификации/i.test(text),
    sms: /смс|sms|сообщени[ея].*(номер|телефон)/i.test(text),
    explicitCode: /введите.{0,60}код|подтвердите вход/i.test(text),
    rejected: /неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(text),
    logout: /Выйти/i.test(text),
  };
}
