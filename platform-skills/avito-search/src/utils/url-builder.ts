/** Fork of Ascard/mcp-avito. All interfaces share the exact public-origin
 * guard. Numeric IDs were silently ignored upstream; without a verified ID
 * map we reject them explicitly and accept public region/category slugs. */
import { ScraperError, type SearchFilters } from '../core/types.js';
export const AVITO_BASE_URL = 'https://www.avito.ru';
const forbidden = /^\/(?:web|api|login|auth|passport|profile|account|accounts|messenger|favorites|registration|register|additem)(?:\/|$)/iu;
export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value, AVITO_BASE_URL); }
  catch { throw new ScraperError('Некорректная ссылка Авито', 'INVALID_INPUT'); }
  if (url.origin !== AVITO_BASE_URL || url.username || url.password || forbidden.test(decodeURIComponent(url.pathname).replace(/\/+/gu,'/'))) {
    throw new ScraperError('Разрешены только публичные страницы www.avito.ru', 'INVALID_INPUT');
  }
  url.hash = '';
  return url;
}
export function buildSearchUrl(filters: SearchFilters): string {
  if (!filters || typeof filters.query !== 'string' || !filters.query.trim() || filters.query.length > 200) {
    throw new ScraperError('Нужен запрос длиной до 200 символов', 'INVALID_INPUT');
  }
  if (filters.locationId !== undefined || filters.categoryId !== undefined) {
    throw new ScraperError('Числовые ID не поддержаны upstream; используйте location/category slug', 'UNSUPPORTED_FILTER');
  }
  const slug = (value: string | undefined, fallback: string) => {
    if (value === undefined) return fallback;
    if (!/^[a-z][a-z0-9_-]{0,99}$/u.test(value)) throw new ScraperError('Некорректный slug региона или категории', 'INVALID_INPUT');
    return value;
  };
  const location = slug(filters.location, 'rossiya');
  const category = filters.category === undefined ? '' : '/' + slug(filters.category, '');
  const url = publicUrl('/' + location + category);
  url.searchParams.set('q', filters.query.trim());
  for (const [key, value] of [['pmin', filters.priceMin], ['pmax', filters.priceMax]] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new ScraperError('Цена должна быть целым неотрицательным числом', 'INVALID_INPUT');
    url.searchParams.set(key, String(value));
  }
  if (filters.priceMin !== undefined && filters.priceMax !== undefined && filters.priceMin > filters.priceMax) {
    throw new ScraperError('Минимальная цена больше максимальной', 'INVALID_INPUT');
  }
  const page = filters.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new ScraperError('Страница должна быть от 1 до 100', 'INVALID_INPUT');
  if (page > 1) url.searchParams.set('p', String(page));
  const sorts = { default: '', date: '104', price_asc: '1', price_desc: '2' };
  if (filters.sort !== undefined && !Object.hasOwn(sorts, filters.sort)) throw new ScraperError('Неизвестная сортировка', 'INVALID_INPUT');
  if (filters.sort && sorts[filters.sort]) url.searchParams.set('s', sorts[filters.sort]);
  return url.href;
}
export const normalizeItemUrl = (value: string) => publicUrl(value).href;
export function extractItemId(value: string): string | null {
  return publicUrl(value).pathname.match(/(?:_|\/)([1-9]\d{0,19})\/?$/u)?.[1] ?? null;
}
export function itemUrl(value: string): string {
  const url = publicUrl(value).href;
  if (!extractItemId(url)) throw new ScraperError('Нужна ссылка на публичное объявление', 'INVALID_INPUT');
  return url;
}
