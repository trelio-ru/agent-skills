// A fixed vocabulary lets a maintainer distinguish a provider challenge from
// a selector defect without exporting auth text, labels, URLs or input values.
// Even unexpected text containing secrets can produce only these booleans.
export function authEvidence(text) {
  return {
    qrSignIn: /Вход по\s*QR-коду/i.test(text),
    captcha: /captcha|капч|робот/i.test(text),
    recovery: /восстановлен|смен[аи] пароля|заблокирован/i.test(text),
    roleChoice: /выбор.*роли|войти как/i.test(text),
    biometricOrPush: /push|подтвердите.*(телефон|приложени)|биометри/i.test(text),
    loginRejected: /неверн.*(пароль|код)|неправильн.*(пароль|код)|слишком много/i.test(text),
    notFound: /ничего не нашлось|страница не найдена|страницу не найд|нет такой страницы/i.test(text),
  };
}
