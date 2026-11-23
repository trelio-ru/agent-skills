import { setTimeout as sleep } from 'node:timers/promises';

export const publicReviewUrls = Object.freeze({
  fns: 'https://egrul.nalog.ru/',
  kad: 'https://kad.arbitr.ru/',
  fedresurs: 'https://bankrot.fedresurs.ru/bankrupts',
});

// The release pins the presentation verified for each official registry.
// Callers never choose Chromium flags or change the launch policy mid-session.
export const sources = Object.freeze({
  fns: Object.freeze({ url: publicReviewUrls.fns, presentation: 'hidden' }),
  kad: Object.freeze({ url: publicReviewUrls.kad, presentation: 'windowed' }),
  fedresurs: Object.freeze({ url: 'https://bankrot.fedresurs.ru/', presentation: 'windowed' }),
});

export const kadInput = 'название, ИНН или ОГРН';
const fnsInput = 'Поисковый запрос: *';
const fedInput = 'Наименование лица, ИНН, номер дела';
const kadInitial = 'Укажите атрибуты дела для поиска';
const fedNoResults = 'По вашему запросу не найдено ни одного совпадения';
const caseNumber = /[АA]\d{1,3}-\d{1,8}\/\d{4}/gu;

export function requireCompanyInn(inn) {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  if (!/^\d{10}$/.test(inn ?? '')) throw new Error('INVALID_COMPANY_INN');
  const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(inn[index]), 0);
  if (checksum % 11 % 10 !== Number(inn[9])) throw new Error('INVALID_COMPANY_INN');
}

export class RegistryReadError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function requireReady(frame) {
  if (frame.state === 'ready') return frame;
  const reason = /^[a-z][a-z0-9_]{0,80}$/.test(frame.reason ?? '') ? frame.reason : 'browser_error';
  throw new RegistryReadError(reason, frame.httpStatus);
}

function requireText(frame, text) {
  if (!frame.text?.includes(text)) throw new RegistryReadError('expected_page_missing');
}

async function clickControl(browser, frame, role, label) {
  const matches = frame.controls?.filter(control => control.role === role && control.label === label) ?? [];
  if (matches.length !== 1) throw new RegistryReadError('control_missing_or_ambiguous');
  const [{ x, y }] = matches;
  return requireReady(await browser.call('click', { frameId: frame.frameId, x, y }));
}

async function readUntil(browser, frame, predicate, polls = 12) {
  for (let attempt = 0; attempt < polls && !predicate(frame.text ?? ''); attempt += 1) {
    await sleep(500);
    frame = requireReady(await browser.call('read-text'));
  }
  return frame;
}

async function enterInn(browser, frame, label, inn) {
  const focused = await clickControl(browser, frame, 'textbox', label);
  return requireReady(await browser.call('type-text', { frameId: focused.frameId, text: inn }));
}

async function checkFns(browser, frame, inn) {
  const filled = await enterInn(browser, frame, fnsInput, inn);
  const submitted = await clickControl(browser, filled, 'button', 'Найти');
  const exactInn = new RegExp(`ИНН:\\s*${inn}\\b`, 'u');
  const empty = /По заданным критериям поиск не дал результатов|По вашему запросу ничего не найдено/iu;
  const result = await readUntil(browser, submitted, text => exactInn.test(text) || empty.test(text));
  if (empty.test(result.text)) return { status: 'no_matches' };

  // Verify the exact INN in the rendered row before reading its adjacent
  // company name and OGRN. A page landing or delayed search is insufficient.
  const lines = (result.text ?? '').split('\n');
  const index = lines.findIndex(line => exactInn.test(line));
  const ogrn = lines[index]?.match(/ОГРН:\s*(\d{13})\b/u)?.[1];
  if (!ogrn || !lines[index - 1]?.trim()) throw new RegistryReadError('result_not_confirmed');
  return { status: 'found', name: lines[index - 1].trim(), ogrn };
}

async function checkKad(browser, frame, inn) {
  await enterInn(browser, frame, kadInput, inn);
  // Ask the host to compare the approved business field with the input.
  // The browser never exposes the actual value of the field to the caller.
  const submit = async () => {
    const verified = requireReady(await browser.call('read-text', {
      checks: [{ id: 'participant', label: kadInput, match: 'equals', values: [inn] }],
    }));
    if (verified.fieldChecks?.[0]?.state !== 'matches') throw new RegistryReadError('participant_filter_not_confirmed');
    return clickControl(browser, verified, 'button', 'Найти');
  };
  const completed = text => !text.includes(kadInitial) && /Найдено[\s\d]+дел|По вашему запросу дел не найдено/u.test(text);
  let current = await readUntil(browser, await submit(), completed, 16);
  if (current.text?.includes(kadInitial)) {
    // The search is read-only. Retry once on the unchanged initial screen
    // after rechecking the same INN. Adding a blank participant could broaden
    // the search and therefore cannot be used to make the results appear.
    current = await readUntil(browser, await submit(), completed, 24);
  }
  if (!completed(current.text ?? '')) throw new RegistryReadError('result_not_confirmed');
  if (current.text.includes('По вашему запросу дел не найдено')) return { status: 'no_matches' };

  const caseNumbers = [...new Set(current.text.match(caseNumber) ?? [])].slice(0, 4);
  if (caseNumbers.length === 0) throw new RegistryReadError('result_not_confirmed');
  return { status: 'found', caseNumbers };
}

export function parseFedresursResult(text, inn) {
  if (!text.includes(fedInput)) return null;
  if (text.includes(fedNoResults)) return { status: 'no_matches' };
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const legal = lines.indexOf('Юридические лица');
  // The initial, unfiltered listing can contain the requested INN. Require
  // the legal-entity tab's single filtered result before looking at a card.
  if (legal === -1 || lines[legal + 1] !== '1') return null;
  const index = lines.findIndex((line, i) => i > legal && line === 'ИНН' && lines[i + 1] === inn);
  if (index === -1 || lines[index + 2] !== 'ОГРН' || !/^\d{13}$/.test(lines[index + 3] ?? '')) return null;

  const date = lines[index + 5];
  const localCase = lines.slice(index + 4, index + 14);
  const caseLabel = localCase.indexOf('Номер судебного дела');
  const number = caseLabel < 0 ? null : localCase[caseLabel + 1]?.match(caseNumber)?.[0] ?? null;
  return {
    status: 'found',
    ogrn: lines[index + 3],
    ...(date && /^\d{2}\.\d{2}\.\d{4}$/.test(date) ? { stage: lines[index + 4], stageDate: date } : {}),
    ...(number ? { caseNumber: number } : {}),
  };
}

async function checkFedresurs(browser, frame, inn) {
  requireText(frame, 'Единый федеральный реестр сведений о банкротстве');
  const opened = requireReady(await browser.call('navigate', { url: publicReviewUrls.fedresurs }));
  const form = await readUntil(browser, opened, text => text.includes(fedInput) && text.includes('Юридические лица'));
  requireText(form, fedInput);
  requireText(form, 'Юридические лица');
  requireText(form, 'Сбросить настройки');

  // The provider's field has a floating label the browser does not project
  // as a semantic control. Measure from the visible breadcrumb in CSS pixels
  // and use the middle of the search box. Enter submits the same field, so
  // the icon's responsive position and screenshot scaling are irrelevant.
  const [breadcrumb, ...duplicates] = form.controls?.filter(c => c.role === 'link' && c.label === 'Главная') ?? [];
  if (!breadcrumb || duplicates.length || form.width < 1000 || breadcrumb.y + 130 >= form.height) {
    throw new RegistryReadError('layout_changed');
  }
  const located = requireReady(await browser.call('click', {
    frameId: form.frameId, x: Math.round(form.width / 2), y: breadcrumb.y + 130,
  }));
  const typed = requireReady(await browser.call('type-text', { frameId: located.frameId, text: inn }));
  const submitted = requireReady(await browser.call('key', { frameId: typed.frameId, key: 'Enter' }));
  const confirmed = text => parseFedresursResult(text, inn) !== null;
  const result = await readUntil(browser, submitted, confirmed, 20);
  const match = parseFedresursResult(result.text ?? '', inn);
  if (!match) throw new RegistryReadError('result_not_confirmed');
  return match;
}

export const checks = { fns: checkFns, kad: checkKad, fedresurs: checkFedresurs };
