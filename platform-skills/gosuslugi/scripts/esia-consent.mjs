// This is the standard ESIA profile disclosure within an already authorized
// login, not a generic consent-click API. The broker binds its recipient to
// the one observed OAuth transaction; no external-site names or routes belong
// here. Unknown scopes and every business action keep their separate authority.
const heading = 'Разрешение на действия с персональными данными';
const system = 'Информационная система, которая запрашивает разрешение';
const actions = 'Запрашиваемые действия';
const agreement = 'Согласие на выдачу разрешения';
const grant = 'Выдать разрешение';
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const profileAction = /^Просмотр (?:списка ваших организаций|вашей фамилии, имени и отчества|вашего адреса электронной почты|вашего СНИЛС|вашего номера (?:мобильного )?телефона|вашей даты рождения|вашего пола|данных документа, удостоверяющего вашу личность|вашего адреса регистрации|вашего адреса проживания)$/u;

export function isLoginConsent(text) {
  // Never classify a truncated page as a complete disclosure. Section titles
  // must each occur once, in order, with a nonempty requesting-system label.
  if (typeof text !== 'string' || text.length > 16000) return false;
  const value = normalize(text), markers = [heading, system, actions, agreement];
  const positions = markers.map(marker => value.indexOf(marker));
  if (positions.some((position, index) => position < 0 ||
    value.indexOf(markers[index], position + 1) !== -1 || index > 0 && position <= positions[index - 1])) return false;
  const recipient = value.slice(positions[1] + system.length, positions[2]).trim();
  if (!recipient || recipient.length > 500) return false;
  const requested = value.slice(positions[2] + actions.length, positions[3]).trim();
  const scopes = requested.split(/\s+(?=Просмотр )/u);
  if (!scopes.length || scopes.length > 10 || new Set(scopes).size !== scopes.length ||
    !scopes.every(scope => profileAction.test(scope))) return false;
  // Mixed challenge/legal/payment screens must not inherit the login grant,
  // even when they copy the standard headings or contain a matching button.
  return !/captcha|капч|робот|восстановлен|смен[аи] пароля|биометри|смс|\bsms\b|push|подпис[аьы]|оплат|плат[её]ж|отправ.{0,40}(заявлен|обращен)/iu.test(value);
}

export async function grantLoginConsent(page, { permit, unchanged, consume }) {
  const button = page.getByRole('button', { name: grant, exact: true }).filter({ visible: true });
  const inputs = page.locator('input,textarea,select').filter({ visible: true });
  const text = await page.locator('body').innerText();
  if (!isLoginConsent(text) || await inputs.count() !== 0 || await button.count() !== 1 ||
    !await button.isEnabled()) return { granted: false };
  const element = await button.elementHandle();
  if (!element) return { granted: false };
  try {
    // Recheck the complete disclosure and the exact node after the last native
    // permit. A changed recipient/scope/document never reuses the old review,
    // and a locator must not retry against a new page after dispatch.
    await permit(); unchanged();
    if (normalize(await page.locator('body').innerText()) !== normalize(text) ||
      await inputs.count() !== 0 || await button.count() !== 1 ||
      !await element.isVisible() || !await element.isEnabled() ||
      !await element.evaluate(node => node.isConnected && node.tagName === 'BUTTON' &&
        node.textContent.trim() === 'Выдать разрешение')) return { granted: false };
    unchanged();
    consume(); // One shot before click: timeout or lost acknowledgement cannot replay disclosure.
    await element.click();
    return { granted: true };
  } finally { await element.dispose().catch(() => {}); }
}
