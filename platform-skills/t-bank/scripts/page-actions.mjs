import { authOrigin, bankPageUrl, officialUrl, requireThat } from './core.mjs';

// This is a per-call assertion by the agent, not stored consent and not a
// substitute for the user's instruction. Nothing here enables a writable
// session: omitting confirm on the next action restores the read-only gate.
export function validatedPagePacket(packet) {
  const fields = {
    navigate: ['url'], click: ['ref'], fill: ['ref', 'text'],
    select: ['ref', 'value'], check: ['ref', 'checked'], press: ['ref', 'key'],
  };
  requireThat(packet && !Array.isArray(packet) && Object.hasOwn(fields, packet.action), 'page_input_invalid');
  const keys = fields[packet.action];
  requireThat(Object.keys(packet).every(key => ['action', 'confirm', 'dryRun', ...keys].includes(key)) &&
    (packet.confirm === undefined || typeof packet.confirm === 'boolean') &&
    (packet.dryRun === undefined || typeof packet.dryRun === 'boolean'), 'page_input_invalid');
  if (packet.action === 'navigate') requireThat(typeof packet.url === 'string' && packet.url.length <= 4096 &&
    workingPageUrl(packet.url), 'provider_url_rejected');
  else requireThat(typeof packet.ref === 'string' && /^\d+:\d+$/.test(packet.ref), 'page_input_invalid');
  if (packet.action === 'fill') requireThat(typeof packet.text === 'string' && packet.text.length <= 10000 &&
    !packet.text.includes('\0'), 'page_input_invalid');
  if (packet.action === 'select') requireThat(typeof packet.value === 'string' && packet.value.length <= 2000, 'page_input_invalid');
  if (packet.action === 'check') requireThat(typeof packet.checked === 'boolean', 'page_input_invalid');
  // Restrict keyboard transport to UI keys. Arbitrary chords, JS and CDP are
  // unnecessary for sending a chat or completing a native bank form.
  if (packet.action === 'press') requireThat(['Enter', 'Tab', 'Escape', 'Space', 'ArrowDown', 'ArrowUp'].includes(packet.key), 'page_input_invalid');
  return packet;
}

export function workingPageUrl(value) {
  try { return officialUrl(value) && new URL(value).hostname === 'www.tbank.ru' && !authOrigin(value); }
  catch { return false; }
}

export function readOnlyNavigation(value) {
  if (!bankPageUrl(value)) return false;
  const url = new URL(value);
  // Keep the old read surface, but do not infer that an arbitrary bank URL or
  // an action-bearing query is harmless merely because it uses HTTPS.
  return !/payment|transfer|security|settings|requisites|card-details|credit|invest|product|order|apply|open|close|delete|confirm|send|sign/i
    .test(`${url.pathname}${url.search}${url.hash}`);
}

// Executed in the page by Playwright. Only metadata is returned: never input
// values, form data, cookies, script bodies or the contents of a chat draft.
export function describeControl(node) {
  const editable = node.isContentEditable;
  return {
    tag: node.tagName.toLowerCase(), type: node.getAttribute('type') || '',
    role: node.getAttribute('role') || '', editable,
    label: (node.getAttribute('aria-label') || node.labels?.[0]?.textContent ||
      node.getAttribute('placeholder') || (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || editable ? '' : node.textContent) || '').trim().slice(0, 160),
    name: node.getAttribute('name') || '', autocomplete: node.getAttribute('autocomplete') || '',
    href: node.tagName === 'A' ? node.href : '',
    options: node.tagName === 'SELECT' ? [...node.options].slice(0, 100).map(option => ({
      value: option.value, label: option.label.slice(0, 160), disabled: option.disabled,
    })) : null,
    submits: (node.tagName === 'BUTTON' && node.type === 'submit' && Boolean(node.form)) ||
      (node.tagName === 'INPUT' && ['submit', 'image'].includes(node.type)),
  };
}

export function protectedControl(meta) {
  return /^(password|hidden|file)$/i.test(meta.type) ||
    /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\s|$)/i.test(meta.autocomplete) ||
    /парол|одноразов|TOTP|SMS|смс|CVC|CVV|секретный код|код подтверждения|показать.*реквизит/i.test(`${meta.label} ${meta.name}`) ||
    /^(?:otp|code|pin|verificationCode|confirmationCode)$/i.test(meta.name);
}

export function needsAuthorization(packet, meta) {
  if (packet.action === 'navigate') return !readOnlyNavigation(packet.url);
  // Filters are the only writable DOM inputs allowed by a reading request.
  if (packet.action === 'fill') return !(meta.type === 'search' || meta.role === 'searchbox' ||
    /^(?:поиск|найти|фильтр)(?:\s|$)/i.test(meta.label));
  if (packet.action !== 'click') return true;
  if (meta.submits || ['submit', 'image'].includes(meta.type)) return true;
  if (/отправ|подпис|оплат|перев[ео]|плат[её]ж|повтор|вернуть|оспор|измен|подключ|отключ|закры|продукт|подат|заказ|удал|подтверд|соглас|войти|выйти|оформ|открыть/i.test(meta.label)) return true;
  if (meta.tag === 'a') return !readOnlyNavigation(meta.href);
  // Unknown/anonymous buttons may mutate too. A small read-control vocabulary
  // is a fallback for existing account UI, not a universal semantic classifier.
  return !/^(?:операции|баланс|счета|карты|документы|выписки|история|детали|подробнее|поиск|найти|фильтр|назад|чат|поддержка|кэшбэк и бонусы)$/i.test(meta.label);
}
