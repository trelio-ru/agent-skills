#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_ID, VERSION, UUID, AvitoReader, requestAllowed, normalizeSearch, listingId, fail } from './core.mjs';
import { AvitoMcpError } from './vendor/errors.mjs';
import { classifyResponse } from './vendor/block-detection.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const PAUSE_MS = 20 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function parseArguments(argv) {
  const command = argv[0] ?? 'help';
  if (!['help', 'doctor', 'bootstrap', 'search', 'item'].includes(command)) fail('INVALID_INPUT', 'Неизвестная команда');
  const options = { command, headed: false, input: {} };
  const keys = { '--query': 'query', '--location': 'location', '--sort': 'sort', '--price-min': 'priceMin',
    '--price-max': 'priceMax', '--page': 'page', '--limit': 'limit', '--open': 'open', '--item': 'item' };
  const seen = new Set();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) fail('INVALID_INPUT', 'Повторяющийся параметр');
    seen.add(flag);
    if (flag === '--headed' && ['search', 'item'].includes(command)) { options.headed = true; continue; }
    const key = keys[flag];
    const valid = command === 'search' ? key && key !== 'item' : command === 'item' && key === 'item';
    if (!valid || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) fail('INVALID_INPUT', 'Неизвестный или пустой параметр');
    const value = argv[++index];
    options.input[key] = ['priceMin', 'priceMax', 'page', 'limit', 'open'].includes(key) ? Number(value) : value;
  }
  if (command === 'search') options.input = normalizeSearch(options.input);
  if (command === 'item') listingId(options.input.item);
  return options;
}

export function requireIdentity(environment = process.env) {
  if (environment.TRELIO_SKILL_ID !== SKILL_ID ||
      !['TRELIO_SKILL_COMPANY_ID', 'TRELIO_SKILL_MEMBER_ID', 'TRELIO_SKILL_CONNECTION_ID'].every(key => UUID.test(environment[key] || ''))) {
    fail('HOST_BINDING_REQUIRED', 'Навык запускается только через выбранное подключение Trelio');
  }
}

/** This file contains only timestamps, never queries, results or browser state.
 * One device-wide lock serializes requests across company connections sharing
 * an IP. A new CLI process cannot erase an Avito cooldown by forgetting RAM.
 */
export class RequestDiscipline {
  constructor(root, { now = Date.now, wait = sleep } = {}) {
    this.root = root; this.now = now; this.wait = wait;
    this.file = path.join(root, 'request-state.json');
    this.state = { lastRequestAt: 0, blockedUntil: 0 };
    try {
      if (fs.statSync(this.file).size > 4096) throw new Error();
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Object.keys(value).sort().join() !== 'blockedUntil,lastRequestAt' ||
          !Number.isSafeInteger(value.lastRequestAt) || value.lastRequestAt < 0 ||
          !Number.isSafeInteger(value.blockedUntil) || value.blockedUntil < 0) throw new Error();
      this.state = value;
    } catch (error) { if (error.code !== 'ENOENT') fail('LOCAL_STATE_INVALID', 'Локальное состояние запросов повреждено'); }
  }
  save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  async slot() {
    if (this.now() < this.state.blockedUntil) fail('AVITO_RATE_LIMITED', 'Авито ограничило запросы; дождитесь окончания 20-минутной паузы');
    await this.wait(Math.max(0, 5000 - (this.now() - this.state.lastRequestAt)));
    this.state.lastRequestAt = this.now();
    this.save();
  }
  block() { this.state.blockedUntil = this.now() + PAUSE_MS; this.save(); }
}

export function assertResponse(response, discipline) {
  if (!requestAllowed(response.url)) fail('AVITO_RESPONSE_INVALID', 'Авито перенаправило запрос за пределы разрешённых страниц');
  // HTTP 200 can still contain a firewall page. Do not label it an empty
  // search, and do not include that page's raw text in diagnostics.
  const verdict = response.text.includes('firewall-container') || response.text.includes('"too-many-requests"')
    ? 'rate_limited' : classifyResponse(response);
  if (verdict === 'rate_limited') { discipline.block(); fail('AVITO_RATE_LIMITED', 'Авито ограничило доступ с этого IP; запросы остановлены на 20 минут'); }
  if (verdict === 'challenge' || verdict === 'session_rejected') fail('AVITO_BLOCKED', 'Авито требует проверку доступа в браузере');
  if (verdict === 'not_found') fail('ITEM_NOT_FOUND', 'Объявление не найдено');
  if (verdict !== 'ok') fail('REQUEST_FAILED', 'Не удалось прочитать страницу Авито');
  if (Buffer.byteLength(response.text) > MAX_RESPONSE_BYTES) fail('AVITO_RESPONSE_INVALID', 'Ответ Авито слишком большой');
}

export function createTransport(page, discipline) {
  const read = async (url, accept) => {
    if (!requestAllowed(url)) fail('INVALID_INPUT', 'Недопустимый адрес запроса');
    await discipline.slot();
    let response;
    try {
      response = await page.evaluate(async ({ url: requestUrl, accept, maxBytes }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          const result = await fetch(requestUrl, { headers: { accept }, signal: controller.signal });
          const chunks = []; let size = 0;
          const reader = result.body?.getReader();
          if (reader) while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) { await reader.cancel(); return { status: 0, oversized: true, text: '', url: requestUrl }; }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return { status: result.status, text: new TextDecoder().decode(bytes), url: result.url };
        } finally { clearTimeout(timeout); }
      }, { url, accept, maxBytes: MAX_RESPONSE_BYTES });
    } catch { fail('REQUEST_FAILED', 'Не удалось выполнить запрос к Авито'); }
    if (response.oversized) fail('AVITO_RESPONSE_INVALID', 'Ответ Авито слишком большой');
    assertResponse(response, discipline);
    return response;
  };
  return { html: url => read(url, 'text/html'), json: async url => {
    const result = await read(url, 'application/json');
    try { return JSON.parse(result.text); } catch { fail('AVITO_RESPONSE_INVALID', 'Авито вернуло некорректный JSON'); }
  } };
}

export function acquireRequestLock(root) {
  const lock = path.join(root, 'request.lock');
  const ownerFile = path.join(lock, 'owner.json');
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') fail('LOCAL_STATE_INVALID', 'Не удалось защитить очередь запросов');
    // A forcibly killed process cannot run finally. Reclaim only a proven dead
    // owner; an absent/corrupt record and PID reuse remain safely busy. Neither
    // reclaim nor a new process resets the persisted rate-limit deadline.
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { fail('AVITO_BUSY', 'Другой запрос Авито ещё выполняется'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || fs.lstatSync(lock).isSymbolicLink()) fail('AVITO_BUSY', 'Очередь запросов Авито занята');
    try { process.kill(owner.pid, 0); fail('AVITO_BUSY', 'Другой запрос Авито ещё выполняется'); }
    catch (probeError) {
      if (probeError.code !== 'ESRCH') throw probeError;
    }
    fs.unlinkSync(ownerFile); fs.rmdirSync(lock);
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('AVITO_BUSY', 'Очередь запросов Авито занята'); }
  }
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  return () => { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); };
}

export async function waitForAccess(page, discipline, deadlineAt, homeStatus) {
  let latestStatus = homeStatus;
  const observe = response => {
    if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) latestStatus = response.status();
  };
  page.on('response', observe);
  const deadline = deadlineAt;
  process.stderr.write('Авито требует ручную проверку доступа. Пройдите её в открытом тестовом Chrome; вход в аккаунт не нужен.\n');
  try {
    // No CAPTCHA interaction, automatic refresh or request polling. A new main
    // document load is the only continuation signal; closing/cancelling never
    // produces a successful search. The original absolute lease is unchanged.
    while (Date.now() < deadline) {
      try { await page.waitForEvent('load', { timeout: Math.min(30000, deadline - Date.now()) }); }
      catch { if (page.isClosed()) fail('AVITO_BLOCKED', 'Окно проверки доступа закрыто'); continue; }
      if (latestStatus === 200 && requestAllowed(page.url()) && !(await page.title()).startsWith('Доступ ограничен')) {
        discipline.state.blockedUntil = 0;
        discipline.save();
        return;
      }
    }
    fail('AVITO_BLOCKED', 'Ручная проверка доступа не завершена; успешный поиск не подтверждён');
  } finally { page.off('response', observe); }
}

async function browserHost() {
  const moduleUrl = process.env.TRELIO_BROWSER_SESSION_MODULE_URL;
  if (!moduleUrl?.startsWith('file:')) fail('HOST_BINDING_REQUIRED', 'Требуется общий браузерный runtime Trelio');
  return import(moduleUrl);
}

export async function withAnonymousBrowser(host, headed, discipline, callback) {
  const binding = host.readBrowserSessionBinding({ expectedSessionClass: 'delegated-ephemeral' });
  // No login and no reusable cookies are needed for buyer-side public search.
  // The caller owns this ephemeral context; installation, discovery and the
  // absolute access lease come from the generic host rather than a new runtime.
  const { chromium } = host.loadPlaywright();
  const browser = await chromium.launch({ executablePath: host.defaultBrowserExecutable(), headless: !headed });
  const close = () => { void browser.close().catch(() => {}); };
  const timer = setTimeout(close, Math.max(1, binding.deadlineAt - Date.now())); timer.unref();
  process.once('SIGTERM', close); process.once('SIGINT', close);
  try {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, acceptDownloads: false });
    // Check every redirect before it reaches the network. Marketplace strings
    // cannot select an external host, a local socket or an authenticated page.
    let manualAssistActive = false;
    await context.route('**/*', async route => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { return route.abort(); }
      const providerHost = ['avito.ru', 'avito.st'].some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
      // The human must be able to complete the provider's own CAPTCHA in the
      // existing window. That bounded handoff permits its first-party browser
      // traffic, not new CLI endpoints or an automated CAPTCHA interaction.
      // Account/login pages remain unavailable in this anonymous context.
      if (manualAssistActive && url.origin === 'https://www.avito.ru' && !url.username && !url.password &&
          !/^\/(?:login|profile|account|messenger|favorites)(?:\/|$)/u.test(url.pathname)) return route.continue();
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !providerHost ||
          !['GET', 'HEAD'].includes(request.method()) ||
          ((request.isNavigationRequest() || ['fetch', 'xhr'].includes(request.resourceType())) && !requestAllowed(url.href))) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    // An explicit headed invocation may open the provider's manual check while
    // reads are paused. It sends no search/item request before a new successful
    // document; ordinary commands remain blocked by the durable cooldown.
    const manualRecovery = headed && Date.now() < discipline.state.blockedUntil;
    if (manualRecovery) {
      await sleep(Math.max(0, 5000 - (Date.now() - discipline.state.lastRequestAt)));
      discipline.state.lastRequestAt = Date.now(); discipline.save();
      manualAssistActive = true;
    } else await discipline.slot();
    const response = await page.goto('https://www.avito.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!response) fail('REQUEST_FAILED', 'Не удалось открыть Авито');
    const reader = new AvitoReader(createTransport(page, discipline));
    try {
      assertResponse({ status: response.status(), text: '', url: page.url() }, discipline);
      if ((await page.title()).startsWith('Доступ ограничен')) fail('AVITO_BLOCKED', 'Авито требует проверку доступа в браузере');
      manualAssistActive = false;
      return await callback(reader);
    } catch (error) {
      if (!headed || !['AVITO_BLOCKED', 'AVITO_RATE_LIMITED'].includes(error.code)) throw error;
      host.assertManualAssistAllowed();
      manualAssistActive = true;
      try { await waitForAccess(page, discipline, binding.deadlineAt, response.status()); }
      finally { manualAssistActive = false; }
      // One separately verified restoration allows one read-only retry. A
      // renewed block stops this invocation rather than reopening the browser.
      return await callback(reader);
    }
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close);
    await browser.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === 'help') return { skillId: SKILL_ID, version: VERSION, commands: ['doctor', 'bootstrap', 'search --query TEXT [--location ГОРОД] [--limit 5] [--open 1]', 'item --item URL_OR_ID'], readOnly: true };
  requireIdentity();
  const host = await browserHost();
  if (options.command === 'doctor') return { skillId: SKILL_ID, version: VERSION, runtimeReady: host.inspectBrowserRuntime().runtimeReady, anonymous: true };
  if (options.command === 'bootstrap') { host.bootstrapPlaywright(); return { skillId: SKILL_ID, version: VERSION, runtimeReady: true }; }
  const root = path.join(host.browserConfigHome(), 'integrations', SKILL_ID, 'request-discipline');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const releaseLock = acquireRequestLock(root);
  try {
    const discipline = new RequestDiscipline(root);
    return await withAnonymousBrowser(host, options.headed, discipline, reader => options.command === 'search' ? reader.search(options.input) : reader.item(options.input.item));
  } finally { releaseLock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)).catch(error => {
    // Browser/OS exceptions can carry URLs, private paths or response bodies.
    // Expose only our static provider errors; a raw stack never reaches MCP.
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof AvitoMcpError ? { code: error.code, message: error.message } : { code: 'RUNTIME_FAILED', message: 'Не удалось выполнить команду Авито' } })}\n`);
    process.exitCode = 1;
  });
}
