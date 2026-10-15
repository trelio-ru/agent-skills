/** DOM selectors and result shapes originate in Ascard/mcp-avito.
 * No response JSON, hydration scripts, private contacts or browser storage is
 * read. Missing price/views/rating stay unknown instead of invented zeroes. */
import type { Page } from 'playwright';
import { ScraperError, type SearchResult, type ItemDetails } from './types.js';
import { extractItemId, itemUrl } from '../utils/url-builder.js';
export class AvitoParser {
  async parseSearchResults(page: Page): Promise<SearchResult[]> {
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-marker="item"]')).slice(0,100).map(element => {
      const text = (selector: string) => Array.from(element.querySelectorAll<HTMLElement>(selector)).map(el=>el.innerText?.trim()).find(Boolean) || '';
      const priceEl = element.querySelector('[itemprop="price"]');
      const raw = priceEl?.getAttribute('content');
      const number = raw && /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) : null;
      return {
        id: element.getAttribute('data-item-id') || '',
        title: text('[itemprop="name"], [data-marker="item-title"]'),
        price: number !== null && Number.isFinite(number) ? number : null,
        priceText: text('[data-marker="item-price"], [itemprop="price"]'),
        currency: 'RUB', location: text('[data-geo-name], [data-marker="item-address"]'),
        url: element.querySelector('a[itemprop="url"], a[data-marker="item-title"]')?.getAttribute('href') || '',
        imageUrl: element.querySelector('img[itemprop="image"], img')?.getAttribute('src') || '',
        description: text('[class*="description"], [data-marker="item-description"]'),
        publishedAt: text('[data-marker="item-date"]'),
      };
    }));
    const seen = new Set<string>();
    return rows.flatMap(row => {
      try {
        const url = itemUrl(row.url), id = extractItemId(url)!;
        if (!row.title || seen.has(id)) return [];
        seen.add(id); return [{ ...row, id, url }];
      } catch { return []; }
    });
  }
  async parseItemDetails(page: Page): Promise<ItemDetails> {
    const url = itemUrl(page.url());
    const details = await page.evaluate(() => {
      const text = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector)).map(el=>el.innerText?.trim()).find(Boolean) || '';
      const raw = document.querySelector('[itemprop="price"]')?.getAttribute('content');
      const price = raw && /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) : null;
      const fullDescription = text('[itemprop="description"], [data-marker="item-view/item-description"]');
      const images = Array.from(document.querySelectorAll('[data-marker="image-frame/image-wrapper"] img')).slice(0,40)
        .map(img => img.getAttribute('src') || img.getAttribute('data-src') || '').filter(Boolean);
      const specifications: Record<string,string> = Object.create(null);
      for (const element of Array.from(document.querySelectorAll('[data-marker="item-view/item-params"] li')).slice(0,60)) {
        const value = (element as HTMLElement).innerText || '', separator = value.indexOf(':');
        if (separator > 0) specifications[value.slice(0,separator).trim()] = value.slice(separator+1).trim();
      }
      const views = text('[data-marker="item-view/total-views"]');
      const rating = text('[data-marker="seller-info/rating"]');
      const ratingNumber = /^\d(?:[.,]\d+)?$/u.test(rating) ? Number(rating.replace(',','.')) : undefined;
      return { title: text('[data-marker="item-view/title-info"], h1[itemprop="name"]'), price,
        priceText: text('[data-marker="item-view/item-price"], [itemprop="price"]'), currency:'RUB',
        location:text('[itemprop="address"]'), fullDescription, description:fullDescription.slice(0,200), images, imageUrl:images[0] || '',
        seller:{name:text('[data-marker="seller-info/name"]'), ...(ratingNumber === undefined ? {} : {rating:ratingNumber}),
          registeredAt:text('[data-marker="seller-info/registered"]')}, specifications,
        ...(views && /\d/u.test(views) ? {viewsCount:Number(views.replace(/\D/gu,''))} : {}) };
    });
    if (!details.title) throw new ScraperError('Карточка объявления не распознана', 'AVITO_CONTENT_UNAVAILABLE');
    return {...details, url, id:extractItemId(url)!};
  }
  async detectCaptcha(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const visible = (el: Element) => Boolean(el.getClientRects().length);
      return Array.from(document.querySelectorAll('iframe[src*="captcha"], [data-marker="captcha"], #captcha, [data-marker="shield"]')).some(visible)
        || /captcha|доступ ограничен|проблема с IP/iu.test(document.title)
        || /Доступ ограничен|проблема с IP/u.test(document.body?.innerText || '');
    });
  }
  async isBlocked(page: Page): Promise<boolean> {
    return /\/(blocked|error)(\/|$)/u.test(new URL(page.url()).pathname) || /blocked|access denied|доступ ограничен/iu.test(await page.title());
  }
  async waitForResults(page: Page, timeout = 10000): Promise<boolean> {
    // A broken selector is not proof of an empty marketplace. Only an explicit
    // empty-state marker permits []; otherwise callers receive a typed error.
    await page.waitForSelector('[data-marker="item"], [data-marker="search-results/no-results"]', {timeout});
    if (await page.locator('[data-marker="item"]').count()) return true;
    return false;
  }
}
