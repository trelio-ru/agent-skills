/** Ascard BrowserManager adapted to the signed Trelio browser ABI.
 * The provider retains proxy/UA/stealth semantics; executable discovery,
 * Playwright installation and absolute session authority belong to the host.
 * No environment-supplied Chrome path, profile reuse or --no-sandbox flag. */
import type { Browser, BrowserContext, Page, Request } from 'playwright';
import * as ProxyChain from 'proxy-chain';
import { getRandomUserAgent } from '../utils/user-agents.js';
import { publicUrl } from '../utils/url-builder.js';
import { ScraperError, type ProxyConfig, type ScraperOptions } from './types.js';
export function requireIdentity(environment = process.env): void {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
  if (environment.TRELIO_SKILL_ID !== 'avito-search' || !['COMPANY','MEMBER','CONNECTION'].every(key => uuid.test(environment[`TRELIO_SKILL_${key}_ID`] || ''))) {
    throw new ScraperError('Запустите навык через выбранное подключение Trelio', 'HOST_BINDING_REQUIRED');
  }
}
export function requestAllowed(request: Request): boolean {
  try {
    const url = new URL(request.url());
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const main = request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame();
    if (main) { publicUrl(url.href); return request.method() === 'GET'; }
    // Only browser-generated resources; this package never synthesizes calls
    // to a private API. A CAPTCHA frame may render for a human to complete.
    return ['GET','HEAD','POST'].includes(request.method()) &&
      ['avito.ru','avito.st','hcaptcha.com','geetest.com','geevisit.com','gsensebot.com']
        .some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)) &&
      !/\/(?:login|auth|passport|profile|account|accounts|messenger|favorites|registration|register)(?:\/|$)/iu.test(decodeURIComponent(url.pathname).replace(/\/+/gu,'/'));
  } catch { return false; }
}
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tunnel: InstanceType<typeof ProxyChain.Server> | null = null;
  private proxyKey: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private deadlineAt = 0;
  private closed = false;
  private documentStatus = 0;
  private host: any;
  constructor(private options: ScraperOptions = {}) {}
  async initialize(proxy?: ProxyConfig): Promise<void> {
    if (this.closed) throw new ScraperError('Браузерная сессия закрыта', 'AVITO_SESSION_CLOSED');
    if(this.browser) await this.dispose();
    this.host ??= this.options.host || await this.loadHost();
    const binding = this.host.assertManualAssistAllowed({expectedSessionClass:'delegated-ephemeral'});
    // A later host invocation cannot extend a BrowserManager already in use.
    this.deadlineAt = this.deadlineAt ? Math.min(this.deadlineAt, binding.deadlineAt) : binding.deadlineAt;
    this.assertLease();
    const launch: any = {headless:this.options.headless ?? false, executablePath:this.host.defaultBrowserExecutable()};
    if (proxy) {
      if ((proxy.type === 'socks4' || proxy.type === 'socks5') && proxy.username) {
        const upstream = new URL(`${proxy.type}://${proxy.host}:${proxy.port}`);
        upstream.username = proxy.username; upstream.password = proxy.password || '';
        const tunnel = new ProxyChain.Server({host:'127.0.0.1', port:0, verbose:false,
          prepareRequestFunction:() => ({upstreamProxyUrl:upstream.href, requestAuthentication:false, failMsg:'Proxy transport failed'})});
        // proxy-chain diagnostics may contain upstream URLs; never forward them.
        tunnel.on('requestFailed', () => {});
        this.tunnel = tunnel;
        await tunnel.listen();
        launch.proxy = {server:`http://127.0.0.1:${tunnel.port}`};
      } else launch.proxy = {server:`${proxy.type}://${proxy.host}:${proxy.port}`, ...(proxy.username ? {username:proxy.username, password:proxy.password} : {})};
    }
    try {
      const {chromium} = this.host.loadPlaywright();
      this.browser = await chromium.launch(launch);
      this.context = await this.browser!.newContext({userAgent:this.options.userAgent || getRandomUserAgent(),
        viewport:{width:1920,height:1080}, locale:'ru-RU', timezoneId:'Europe/Moscow', acceptDownloads:false});
      await this.context!.route('**/*', route => requestAllowed(route.request()) ? route.continue() : route.abort());
      // Preserve upstream's opt-out stealth behavior without installing any
      // third-party browser extension or copying a personal browser profile.
      if (this.options.stealth !== false) await this.context!.addInitScript(() => {
        Object.defineProperty(navigator,'webdriver',{get:() => false});
        Object.defineProperty(navigator,'plugins',{get:() => [1,2,3,4,5]});
        Object.defineProperty(navigator,'languages',{get:() => ['ru-RU','ru','en-US','en']});
      });
      this.proxyKey = JSON.stringify(proxy || null);
      this.timer = setTimeout(() => { void this.close(); },Math.max(1,this.deadlineAt-Date.now()));
      this.timer.unref();
      process.once('SIGTERM',this.onSignal); process.once('SIGINT',this.onSignal);
    } catch {
      await this.dispose();
      throw new ScraperError('Не удалось запустить браузер или прокси', 'BROWSER_START_FAILED');
    }
  }
  private async loadHost(): Promise<any> {
    requireIdentity();
    const url = process.env.TRELIO_BROWSER_SESSION_MODULE_URL;
    if (!url?.startsWith('file:')) throw new ScraperError('Требуется общий браузерный runtime Trelio', 'HOST_BINDING_REQUIRED');
    return import(url);
  }
  private onSignal = () => { void this.close(); };
  assertLease(): void {
    if (this.closed || !this.deadlineAt || Date.now() >= this.deadlineAt) throw new ScraperError('Срок браузерной сессии истёк', 'AVITO_SESSION_EXPIRED');
  }
  async useProxy(proxy?: ProxyConfig): Promise<void> {
    // Reopening is allowed only for a scheduled selection before a new read,
    // never as a response to CAPTCHA/403/429. The original deadline survives.
    if (this.browser && (!this.browser.isConnected() || this.page?.isClosed())) {
      throw new ScraperError('Окно закрыто; автоматическое переоткрытие запрещено', 'AVITO_SESSION_CLOSED');
    }
    if (this.isInitialized() && this.proxyKey === JSON.stringify(proxy || null)) return;
    await this.dispose(); await this.initialize(proxy);
  }
  async getPage(): Promise<Page> {
    this.assertLease();
    if (!this.browser?.isConnected() || !this.context) throw new ScraperError('Браузер завершён; автоматический повтор не разрешён', 'AVITO_SESSION_CLOSED');
    if (this.page?.isClosed()) throw new ScraperError('Окно закрыто пользователем', 'AVITO_SESSION_CLOSED');
    if (!this.page) {
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.options.timeout ?? 30000);
      this.page.on('response', response => {
        const request=response.request();
        if(request.isNavigationRequest() && request.frame()===this.page?.mainFrame())this.documentStatus=response.status();
      });
    }
    return this.page;
  }
  getDocumentStatus(): number { return this.documentStatus; }
  private async dispose(): Promise<void> {
    clearTimeout(this.timer); process.removeListener('SIGTERM',this.onSignal); process.removeListener('SIGINT',this.onSignal);
    const browser = this.browser, tunnel = this.tunnel;
    this.page = null; this.context = null; this.browser = null; this.tunnel = null;
    // Always close the tunnel even when browser teardown itself fails.
    try { await browser?.close(); } catch {} finally { try { await tunnel?.close(true); } catch {} }
  }
  async close(): Promise<void> { this.closed = true; await this.dispose(); }
  isInitialized(): boolean { return Boolean(this.browser?.isConnected() && this.context && !this.closed); }
}
