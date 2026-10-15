/** Ascard proxy pool, adapted for bounded input and value-free diagnostics.
 * Keep a real inventory: sampling next() lost random entries and mutated the
 * active strategy upstream. A selection counts once per document navigation. */
import fs from 'node:fs/promises';
import { ScraperError, type ProxyConfig, type ProxyRotationStrategy, type ProxyStats } from './types.js';
import type { IProxyRotationStrategy } from '../plugins/proxy/base.js';
import { SequentialRotation } from '../plugins/proxy/sequential.js';
import { RandomRotation } from '../plugins/proxy/random.js';
import { RoundRobinRotation } from '../plugins/proxy/round-robin.js';
export function parseProxy(value: string, allowCredentials = false): ProxyConfig {
  try {
    const url = new URL(value);
    const type = url.protocol.slice(0, -1);
    const port = Number(url.port || ({ http: 80, https: 443 } as Record<string, number>)[type]);
    if (!['http','https','socks4','socks5'].includes(type) || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535 ||
        (url.pathname && url.pathname !== '/') || url.search || url.hash || Boolean(url.username) !== Boolean(url.password) ||
        (!allowCredentials && (url.username || url.password))) throw new Error();
    return { type: type as ProxyConfig['type'], host: url.hostname, port,
      ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) };
  } catch { throw new ScraperError('Некорректный прокси; credentials допустимы только через protected secret transport', 'PROXY_INPUT_INVALID'); }
}
export class ProxyManager {
  private strategy!: IProxyRotationStrategy;
  private proxies: ProxyConfig[] = [];
  private currentProxy: ProxyConfig | null = null;
  private requestCount = 0;
  constructor(proxies: ProxyConfig[] = [], private rotation: ProxyRotationStrategy = 'sequential', private rotateEveryN = 0) {
    if (!Number.isSafeInteger(rotateEveryN) || rotateEveryN < 0 || rotateEveryN > 1000) throw new ScraperError('Некорректный интервал ротации', 'INVALID_INPUT');
    this.setRotationStrategy(rotation, proxies);
  }
  async loadFromFile(file: string): Promise<number> {
    // Files remain useful for credential-free proxy endpoints. Personal proxy
    // passwords must not become plaintext files or argv. Secret checkout injects
    // a pool in process memory; it uses parseProxy(..., true) instead.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new ScraperError('Недопустимый файл прокси', 'PROXY_INPUT_INVALID');
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (!lines.length || lines.length > 100) throw new ScraperError('Нужны 1–100 прокси', 'PROXY_INPUT_INVALID');
    this.setRotationStrategy(this.rotation, lines.map(line => parseProxy(line)));
    return this.proxies.length;
  }
  getProxy(forceRotate = false): ProxyConfig | null {
    if (forceRotate || !this.currentProxy || (this.rotateEveryN > 0 && this.requestCount >= this.rotateEveryN)) {
      this.currentProxy = this.strategy.next(); this.requestCount = 0;
    }
    this.requestCount++;
    return this.currentProxy;
  }
  markFailed(): void { if (this.currentProxy) this.strategy.markFailed(this.currentProxy); this.currentProxy = null; this.requestCount = 0; }
  markSuccess(): void { if (this.currentProxy) this.strategy.markSuccess(this.currentProxy); }
  getStats(): ProxyStats {
    const active = this.strategy.getAvailableCount();
    // No proxy host, username or URL is exported in stats/logs.
    const rates = this.strategy instanceof RoundRobinRotation ? this.strategy.getStats() : {};
    const successRate:Record<string,number> = {};
    this.proxies.forEach((proxy,index) => {
      const rate=rates[`${proxy.type}://${proxy.host}:${proxy.port}`]?.successRate;
      if(typeof rate==='number')successRate[`proxy_${index+1}`]=rate;
    });
    return { total: this.proxies.length, active, failed: this.proxies.length - active, successRate };
  }
  reset(): void { this.strategy.reset(); this.currentProxy = null; this.requestCount = 0; }
  setRotationStrategy(rotation: ProxyRotationStrategy, proxies = this.proxies): void {
    if (!['sequential','random','round-robin'].includes(rotation) || proxies.length > 100) throw new ScraperError('Некорректная ротация прокси', 'INVALID_INPUT');
    this.rotation = rotation; this.proxies = [...proxies];
    this.strategy = rotation === 'random' ? new RandomRotation(this.proxies) : rotation === 'round-robin' ? new RoundRobinRotation(this.proxies) : new SequentialRotation(this.proxies);
    this.currentProxy = null; this.requestCount = 0;
  }
}
