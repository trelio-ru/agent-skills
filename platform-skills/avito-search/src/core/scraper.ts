/** Ascard scraper orchestration. No blind retries: a missing document, HTTP
 * block and CAPTCHA are different outcomes. Pagination has finite budgets,
 * deduplicates real IDs and reports partial coverage instead of looping on a
 * repeated page forever. CLI and MCP share exactly this implementation. */
import type { Page } from 'playwright';
import { BrowserManager } from './browser.js';
import { AvitoParser } from './parser.js';
import { ProxyManager } from './proxy-manager.js';
import { buildSearchUrl, itemUrl, publicUrl } from '../utils/url-builder.js';
import { randomSleep } from '../utils/delays.js';
import { ScraperError, type SearchFilters, type SearchResult, type ItemDetails, type ScraperOptions } from './types.js';
export class AvitoScraper {
  private browser: BrowserManager;
  private parser: AvitoParser;
  private options: ScraperOptions;
  private proxyManager: ProxyManager | null;
  private loaded = false;
  private busy = false;
  private blockedUntil = 0;
  private manualPage: Page | null = null;
  lastCoverage = {pages:0, complete:false, stopReason:'not_started'};
  constructor(options: ScraperOptions = {}, dependencies: {browser?:BrowserManager;parser?:AvitoParser} = {}) {
    this.options = {headless:false, timeout:30000, delayMs:[2000,15000], maxPages:10, limit:200,
      captchaTimeoutMs:120000, captchaPollMs:3000, manualCaptchaFallback:true,...options};
    if (!Number.isSafeInteger(this.options.timeout) || this.options.timeout! < 100 || this.options.timeout! > 60000 ||
        !this.options.delayMs?.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 30000) ||
        this.options.delayMs.length !== 2 || this.options.delayMs[0] > this.options.delayMs[1] ||
        !Number.isSafeInteger(this.options.captchaTimeoutMs) || this.options.captchaTimeoutMs! < 0 || this.options.captchaTimeoutMs! > 120000 ||
        !Number.isSafeInteger(this.options.captchaPollMs) || this.options.captchaPollMs! < 100 || this.options.captchaPollMs! > 30000) {
      throw new ScraperError('Некорректные настройки runtime', 'INVALID_INPUT');
    }
    if (options.retries !== undefined || options.proxy?.maxRetries !== undefined || options.proxy?.healthCheck) {
      throw new ScraperError('Retry/healthCheck не реализованы upstream и не разрешают автоматические попытки', 'UNSUPPORTED_OPTION');
    }
    this.browser = dependencies.browser || new BrowserManager(this.options);
    this.parser = dependencies.parser || new AvitoParser();
    this.proxyManager = options.proxy?.enabled ? new ProxyManager(options.proxy.proxies || [],options.proxy.rotation,options.proxy.rotateEveryN) : null;
  }
  async initialize(): Promise<void> {
    if (this.proxyManager && !this.loaded) {
      if (this.options.proxy?.listFile) await this.proxyManager.loadFromFile(this.options.proxy.listFile);
      if (!this.proxyManager.getStats().total) throw new ScraperError('Пул прокси пуст', 'PROXY_POOL_EMPTY');
      this.loaded = true;
    }
  }
  private async exclusive<T>(work:() => Promise<T>): Promise<T> {
    if (this.busy) throw new ScraperError('В этой сессии уже выполняется операция', 'AVITO_BUSY');
    this.busy = true; try { return await work(); } finally { this.busy = false; }
  }
  private now(): number { return (this.options.now || Date.now)(); }
  private async navigate(url:string): Promise<Page> {
    publicUrl(url);
    if (this.now() < this.blockedUntil) throw new ScraperError('Дождитесь окончания 20-минутной паузы', 'AVITO_RATE_LIMITED');
    if (this.manualPage) throw new ScraperError('Сначала проверьте завершение ручной проверки через access-status', 'AVITO_MANUAL_REQUIRED');
    await this.initialize();
    if (this.options.wait) await this.options.wait(0); else await randomSleep(...this.options.delayMs!);
    const proxy = this.proxyManager?.getProxy();
    if (this.proxyManager && !proxy) throw new ScraperError('Рабочих прокси нет', 'PROXY_POOL_UNAVAILABLE');
    await this.browser.useProxy(proxy || undefined);
    const page = await this.browser.getPage();
    let response;
    try { response = await page.goto(url,{waitUntil:'domcontentloaded',timeout:this.options.timeout}); }
    catch {
      if (this.options.proxy?.rotateOnError) this.proxyManager?.markFailed();
      throw new ScraperError('Переход не подтверждён; автоматического повтора нет', 'AVITO_NAVIGATION_FAILED');
    }
    this.browser.assertLease(); publicUrl(page.url());
    if (!response) throw new ScraperError('Нет подтверждённого документа', 'AVITO_CONTENT_UNAVAILABLE');
    const status = response.status();
    if (status === 429) { this.blockedUntil = this.now()+1200000; throw new ScraperError('Авито ограничило доступ на 20 минут', 'AVITO_RATE_LIMITED'); }
    if ([401,403,439].includes(status) || await this.parser.detectCaptcha(page) || await this.parser.isBlocked(page)) {
      this.manualPage = page;
      // Keep the original page visible for up to the configured bounded handoff.
      // No headless restart, proxy switch or second navigation is synthesized.
      if(!this.options.headless && this.options.manualCaptchaFallback) {
        const until=this.now()+this.options.captchaTimeoutMs!;
        while(this.now()<until) {
          this.browser.assertLease();
          if((await this.accessStatus()).ready) {this.proxyManager?.markSuccess();return page;}
          await (this.options.wait || (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(this.options.captchaPollMs!);
        }
      }
      throw new ScraperError('Нужна ручная проверка в текущем окне; запрос не повторяется', 'AVITO_MANUAL_REQUIRED');
    }
    if (status >= 400) throw new ScraperError('Публичная страница недоступна', 'AVITO_HTTP_ERROR');
    this.proxyManager?.markSuccess(); return page;
  }
  async accessStatus(): Promise<{ready:boolean}> {
    if (!this.manualPage) return {ready:this.now() >= this.blockedUntil};
    this.browser.assertLease(); publicUrl(this.manualPage.url());
    // Observation only: never click a CAPTCHA, refresh, switch proxy, restart
    // headless or repeat the blocked navigation after a human completes it.
    if (this.browser.getDocumentStatus() !== 200 || await this.parser.detectCaptcha(this.manualPage) || await this.parser.isBlocked(this.manualPage)) return {ready:false};
    this.manualPage = null; return {ready:this.now() >= this.blockedUntil};
  }
  private async searchPage(filters:SearchFilters): Promise<SearchResult[]> {
    const page = await this.navigate(buildSearchUrl(filters));
    let ready;
    try { ready = await this.parser.waitForResults(page,this.options.timeout); }
    catch { throw new ScraperError('Выдача не распознана; это не доказательство отсутствия объявлений', 'AVITO_CONTENT_UNAVAILABLE'); }
    if (!ready) return [];
    const rows = await this.parser.parseSearchResults(page);
    if (!rows.length) throw new ScraperError('Разметка объявлений не распознана', 'AVITO_CONTENT_UNAVAILABLE');
    return rows;
  }
  async search(filters:SearchFilters): Promise<SearchResult[]> { buildSearchUrl(filters); return this.exclusive(() => this.searchPage(filters)); }
  async getItemDetails(url:string): Promise<ItemDetails> {
    const target = itemUrl(url);
    return this.exclusive(async () => this.parser.parseItemDetails(await this.navigate(target)));
  }
  async *searchAllPages(filters:SearchFilters, budgets:{maxPages?:number;limit?:number} = {}): AsyncGenerator<SearchResult,void,undefined> {
    buildSearchUrl(filters);
    if (this.busy) throw new ScraperError('В этой сессии уже выполняется операция', 'AVITO_BUSY');
    const maxPages = budgets.maxPages ?? this.options.maxPages!, limit = budgets.limit ?? this.options.limit!;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ScraperError('Нужны maxPages 1–100 и limit 1–1000', 'INVALID_INPUT');
    this.busy = true; const seen = new Set<string>();
    this.lastCoverage = {pages:0,complete:false,stopReason:'max_pages'};
    try {
      for (let offset=0;offset<maxPages;offset++) {
        const page = (filters.page ?? 1)+offset;
        if (page > 100) { this.lastCoverage.stopReason='page_bound'; return; }
        const rows = await this.searchPage({...filters,page});
        this.lastCoverage.pages++;
        if (!rows.length) { this.lastCoverage.complete=true;this.lastCoverage.stopReason='empty_page';return; }
        let fresh = 0;
        for (const row of rows) {
          const key = row.id || row.url;
          if (seen.has(key)) continue;
          seen.add(key);fresh++;yield row;
          if (seen.size >= limit) { this.lastCoverage.stopReason='limit';return; }
        }
        if (!fresh) { this.lastCoverage.stopReason='repeated_page'; return; }
      }
    } catch(error) { this.lastCoverage.stopReason='error'; throw error; }
    finally {this.busy=false;}
  }
  /** Safe diagnostic equivalent of upstream debugDom: marker counts only;
   * raw HTML/body/private contact information never enters a technical report. */
  async debugDom(url:string): Promise<unknown> {
    publicUrl(url);
    return this.exclusive(async () => {
      const page = await this.navigate(url);
      return page.evaluate(() => {
        const counts:Record<string,number> = Object.create(null);
        for (const el of Array.from(document.querySelectorAll('[data-marker]')).slice(0,10000)) {
          const marker=el.getAttribute('data-marker') || '';
          // Return only fixed public selector families, not arbitrary site text.
          if (/^(?:item|search-results)(?:$|[/-][a-z-]+$)/u.test(marker)) counts[marker]=(counts[marker]||0)+1;
        }
        return {markerCounts:counts};
      });
    });
  }
  getProxyStats() { return this.proxyManager?.getStats() ?? {total:0,active:0,failed:0,successRate:{}}; }
  resetProxyStats(): void { this.proxyManager?.reset(); }
  async close(): Promise<void> { await this.browser.close(); }
  isInitialized(): boolean { return this.browser.isInitialized(); }
  setHeadless(headless:boolean): void {
    if (this.isInitialized()) throw new ScraperError('Режим выбирается до запуска сессии', 'INVALID_INPUT');
    this.options.headless=headless;
  }
}
