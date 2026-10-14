import { AvitoMcpError } from './vendor/errors.mjs';
import { MOSCOW, searchApiUrl, locationsApiUrl, itemPageUrl } from './vendor/avito-api.mjs';
import { parseLocations, parseSearchPage } from './vendor/parsers.mjs';
import { readBuyerItem, parseItem } from './vendor/item-page.mjs';

export const SKILL_ID = 'avito-search';
export const VERSION = '1.0.0';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SORTS = new Set(['default', 'price', 'price_desc', 'date', 'discount']);
const ITEM_PATH = /^\/(?:\d+|[^/]+\/[^/]+\/[^/]+_(\d+))\/?$/u;
export const fail = (code, message) => { throw new AvitoMcpError(code, message); };

/** Inputs select a public listing ID, never a caller-controlled fetch target.
 * Credentials, nonstandard ports and cross-origin redirects are rejected even
 * when URL.hostname happens to look like Avito. Public result links are data.
 */
export function listingId(input) {
  if (typeof input !== 'string' || input.length > 2048) fail('INVALID_ITEM', 'Передайте ссылку на объявление Авито или его ID');
  const value = input.trim();
  let id = value;
  if (!/^\d+$/u.test(value)) {
    let url;
    try { url = new URL(value); } catch { fail('INVALID_ITEM', 'Некорректная ссылка на объявление'); }
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['avito.ru', 'www.avito.ru', 'm.avito.ru'].includes(url.hostname) || !ITEM_PATH.test(url.pathname)) {
      fail('INVALID_ITEM', 'Нужна HTTPS-ссылка на объявление на avito.ru');
    }
    id = url.pathname.match(ITEM_PATH)?.[1] || url.pathname.replaceAll('/', '');
  }
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_ITEM', 'Некорректный ID объявления');
  return number;
}

export function requestAllowed(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.avito.ru' && !url.username && !url.password &&
      (url.pathname === '/' || ITEM_PATH.test(url.pathname) ||
        ['/web/1/js/items', '/web/1/slocations'].includes(url.pathname));
  } catch { return false; }
}

export function normalizeSearch(input) {
  const allowed = new Set(['query', 'location', 'sort', 'priceMin', 'priceMax', 'page', 'limit', 'open']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    fail('INVALID_INPUT', 'Неизвестные параметры поиска');
  }
  if (typeof input.query !== 'string' || (input.location !== undefined && typeof input.location !== 'string')) {
    fail('INVALID_INPUT', 'Запрос и город должны быть текстом');
  }
  const result = { query: input.query.trim(), location: input.location?.trim() || 'Москва',
    sort: input.sort ?? 'default', page: input.page ?? 1, limit: input.limit ?? 5, open: input.open ?? 0 };
  if (typeof result.query !== 'string' || result.query.length < 1 || result.query.length > 200 ||
      typeof result.location !== 'string' || result.location.length > 100 || !/\p{Script=Cyrillic}/u.test(result.location) ||
      !SORTS.has(result.sort)) fail('INVALID_INPUT', 'Проверьте запрос, город и сортировку');
  for (const [key, minimum, maximum] of [['page', 1, 100], ['limit', 1, 20], ['open', 0, 3]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) fail('INVALID_INPUT', `Некорректный параметр ${key}`);
  }
  for (const key of ['priceMin', 'priceMax']) {
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail('INVALID_INPUT', 'Цена должна быть целым неотрицательным числом');
      result[key] = input[key];
    }
  }
  if (result.priceMin > result.priceMax) fail('INVALID_INPUT', 'Минимальная цена больше максимальной');
  return result;
}

/** Only stable documented response fields cross the boundary. Bounds keep an
 * oversized listing from flooding model context; every truncation is explicit.
 * The original parsers never execute hydration JavaScript: they JSON-decode it.
 */
export function boundedResult(value) {
  let truncated = false;
  let remainingBytes = 64000;
  const visit = (entry, key = '') => {
    if (typeof entry === 'string') {
      const limit = key === 'description' ? 16000 : key === 'url' || key === 'image' || key === 'images' ? 2048 : 2000;
      let result = entry.slice(0, limit);
      // Bound the whole packet as well as each field. Splitting Unicode by
      // code point avoids emitting a broken surrogate at the byte budget.
      if (Buffer.byteLength(result) > remainingBytes) {
        const points = [];
        for (const point of result) {
          if (Buffer.byteLength(point) > remainingBytes) break;
          points.push(point); remainingBytes -= Buffer.byteLength(point);
        }
        result = points.join('');
      } else remainingBytes -= Buffer.byteLength(result);
      if (result !== entry) truncated = true;
      return result;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 40) truncated = true;
      return entry.slice(0, 40).map(item => visit(item, key));
    }
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, visit(child, name)]));
    return entry;
  };
  const projected = visit(value);
  return { ...projected, contentTruncated: truncated, retrievedAt: new Date().toISOString(), untrustedContent: true };
}

export class AvitoReader {
  constructor(transport) { this.transport = transport; }

  async search(input) {
    const options = normalizeSearch(input);
    let location = MOSCOW;
    if (options.location.toLocaleLowerCase('ru-RU') !== 'москва') {
      const candidates = parseLocations(await this.transport.json(locationsApiUrl(options.location)));
      // A similar first suggestion can silently move a search to another town.
      // Match an exact returned Russian name; ambiguity remains a user decision.
      location = candidates.find(candidate => candidate.name.toLocaleLowerCase('ru-RU') === options.location.toLocaleLowerCase('ru-RU'));
      if (!location) fail('LOCATION_NOT_FOUND', 'Авито не вернуло точного совпадения города');
    }
    const page = parseSearchPage(await this.transport.json(searchApiUrl({ ...options, locationId: location.id })), location);
    const items = page.items.slice(0, options.limit);
    const opened = [];
    for (const item of items.slice(0, options.open)) opened.push(await this.item(String(item.id)));
    return boundedResult({ query: options.query, location, sort: options.sort, page: options.page,
      totalCount: page.totalCount, count: items.length, items, ...(options.open ? { opened } : {}) });
  }

  async item(input) {
    const id = listingId(input);
    const page = await this.transport.html(itemPageUrl(id));
    const item = parseItem(readBuyerItem(page.text), page.url);
    if (item.id !== id) fail('AVITO_RESPONSE_INVALID', 'Авито вернуло другое объявление');
    return boundedResult(item);
  }
}
