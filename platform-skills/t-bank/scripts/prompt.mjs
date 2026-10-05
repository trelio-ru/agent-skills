import http from 'node:http';
import crypto from 'node:crypto';
import { LEASE_MS, normalizeCredentials, requireThat, RuntimeError } from './core.mjs';

export const SAVE_WARNING = 'Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».';
export const TOTP_HELP = 'Необязательно. Если ваш аккаунт использует TOTP, сначала самостоятельно включите этот способ входа в Т‑Банке. Навык не включает его за вас. Введите секретный ключ Base32 или otpauth://totp (SHA1, 6 цифр, 30 секунд), а не текущий код. При запросе банка введите код из SMS или приложения прямо в окне Т‑Банка. Сохранение пароля и ключа TOTP вместе снижает независимость двух факторов.';

export function promptHtml(scriptNonce) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trelio – вход в Т‑Банк</title><style nonce="${scriptNonce}">
:root{color-scheme:light dark;--bg:#f4f6fa;--surface:#fff;--text:#182235;--muted:#475467;--line:#667085;--accent:#234bcc;--error:#9c182a}
@media(prefers-color-scheme:dark){:root{--bg:#151a24;--surface:#202836;--text:#f1f4fa;--muted:#bdc7d9;--line:#8491a8;--accent:#aec2ff;--error:#ffacb8}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}
main{max-width:640px;margin:24px auto;padding:clamp(20px,5vw,40px);border-radius:16px;background:var(--surface)}h1{font-size:26px;line-height:1.25}p{color:var(--muted)}
label{display:block;font-weight:600;margin-top:20px}input{width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit}
small{display:block;color:var(--muted);font-size:14px;line-height:1.6;margin-top:8px}button{min-height:48px;padding:10px 20px;cursor:pointer;font:inherit;border:1px solid var(--accent);border-radius:8px;color:var(--accent);background:var(--surface)}
button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}#error{color:var(--error)}[hidden]{display:none!important}
</style><main><h1>Вход в Т‑Банк</h1><p>Локальная страница Trelio. Данные не передаются агенту или серверу Trelio. Сессия ограничена 30 минутами, включая ожидание подтверждений.</p>
<p id="status" role="status" aria-live="polite">Подготовка…</p><p id="error" role="alert"></p>
<form id="form" autocomplete="off" hidden>
<section id="credentials" hidden><label for="login">Телефон Т‑Банка</label><input id="login" type="tel" autocomplete="off" maxlength="24">
<label for="username">Логин – если банк спрашивает его отдельно</label><input id="username" type="text" autocomplete="off" maxlength="256"><small>Необязательно. Оставьте пустым, если входите по телефону.</small>
<label for="password">Пароль Т‑Банка</label><input id="password" type="password" autocomplete="off" maxlength="256" aria-describedby="password-help"><small id="password-help">${SAVE_WARNING}</small>
<label for="totp">Секрет TOTP – необязательно</label><input id="totp" type="password" autocomplete="off" maxlength="2048" aria-describedby="totp-help totp-save"><small id="totp-help">${TOTP_HELP}</small><small id="totp-save">${SAVE_WARNING}</small></section>
<div class="actions"><button id="submit" type="submit">Продолжить</button><button id="cancel" type="button">Отмена</button></div></form></main>
<script nonce="${scriptNonce}">
const base=location.pathname, form=document.getElementById('form'), status=document.getElementById('status'), error=document.getElementById('error');
let revision=0, stage='waiting', busy=false, closed=false;
const field=id=>document.getElementById(id);
function clearSecrets(){for(const id of ['login','username','password','totp'])field(id).value=''}
function ended(){closed=true;clearSecrets();form.hidden=true;status.textContent='Локальный ввод завершён или срок ожидания истёк. Эту вкладку можно закрыть.'}
function render(state){if(state.revision===revision)return;revision=state.revision;stage=state.stage;clearSecrets();error.textContent='';
form.hidden=false;field('submit').hidden=stage!=='credentials';field('credentials').hidden=stage!=='credentials';
status.textContent=stage==='credentials'?'Укажите данные один раз. Они будут сохранены локально в зашифрованном виде.':'Ожидаем завершения настройки. Код входа вводится в окне Т‑Банка.';
for(const id of ['login','password'])field(id).required=stage==='credentials';
if(stage==='credentials')field('login').focus();}
async function poll(){if(closed)return;try{const r=await fetch(base+'/state',{cache:'no-store'});if(!r.ok)return ended();render(await r.json())}catch{ended()}if(!closed)setTimeout(poll,1000)}
async function submit(action){if(busy||closed)return;busy=true;field('submit').disabled=true;error.textContent='';
let values=action==='cancel'?{}:{login:field('login').value,username:field('username').value,password:field('password').value,totp:field('totp').value};
try{const r=await fetch(base+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,action,values})});values=null;clearSecrets();
if(r.status===422){error.textContent='Проверьте формат телефона, пароля или TOTP. TOTP можно оставить пустым.'}else if(!r.ok){ended()}else if(action==='cancel'){ended()}else{revision=0;render(await r.json())}}
catch{values=null;ended()}finally{busy=false;field('submit').disabled=false}}
form.addEventListener('submit',e=>{e.preventDefault();submit('submit')});field('cancel').addEventListener('click',()=>submit('cancel'));poll();
</script></html>`;
}

export async function boundedJson(request, maximum = 8192) {
  requireThat(request.headers['content-type'] === 'application/json', 'invalid_content_type');
  requireThat(!request.headers['content-encoding'] && Number(request.headers['content-length'] || 0) <= maximum, 'body_too_large');
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length; requireThat(length <= maximum, 'body_too_large'); chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  try { return JSON.parse(buffer.toString('utf8')); }
  finally { buffer.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
}

// One listener is one credential setup flow, never a proxy for bank OTP input.
// It has no credential read API: state reports only stage/revision.
// The opening callback is private
// to the worker, never returned through the CLI or MCP.
export async function createPrompt({ open, timeoutMs = 300000, deadlineMs = timeoutMs, onCancel = () => {} }) {
  requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= LEASE_MS &&
    Number.isFinite(deadlineMs) && deadlineMs > 0 && deadlineMs <= LEASE_MS, 'input_timeout_invalid');
  const nonce = crypto.randomBytes(32).toString('hex'), scriptNonce = crypto.randomBytes(24).toString('base64');
  const route = `/${nonce}`;
  let origin, loaded = false, closed = false, current = null, revision = 1, stage = 'waiting', inputTimer;
  const state = () => ({ stage, revision });
  const sockets = new Set();
  function settleError(code) { current?.reject(new RuntimeError(code)); current = null; }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const respond = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      requireThat(!closed && req.socket.remoteAddress === '127.0.0.1' && req.socket.localAddress === '127.0.0.1' &&
        req.headers.host === new URL(origin).host && !req.headers['x-forwarded-host'], 'request_rejected');
      if (req.method === 'GET' && req.url === route) {
        requireThat(!loaded && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' &&
          ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'request_rejected');
        loaded = true;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(promptHtml(scriptNonce)); return;
      }
      requireThat(loaded && req.headers['sec-fetch-site'] === 'same-origin', 'request_rejected');
      if (req.method === 'GET' && req.url === `${route}/state`) { respond(200, state()); return; }
      requireThat(req.method === 'POST' && req.url === `${route}/submit` && req.headers.origin === origin, 'request_rejected');
      const packet = await boundedJson(req);
      requireThat(packet && Object.keys(packet).sort().join() === 'action,revision,values' &&
        packet.revision === revision, 'stale_submit');
      if (packet.action === 'cancel') {
        respond(200, { stage: 'done' }); settleError('user_cancelled'); onCancel('user_cancelled'); setImmediate(() => close()); return;
      }
      requireThat(packet.action === 'submit' && current, 'request_rejected');
      let value;
      try {
        requireThat(stage === 'credentials');
        value = normalizeCredentials(packet.values);
      } catch { respond(422, { error: 'input_invalid' }); return; }
      const submitted = current; current = null; stage = 'waiting'; revision++;
      // The answer has been consumed. Keeping its five-minute timer alive
      // would cancel the unrelated bank redirect/manual check, even though
      // the user has already completed the requested local input.
      clearTimeout(inputTimer); inputTimer = null;
      respond(200, state()); submitted.resolve(value);
    } catch { if (!res.headersSent) respond(403, { error: 'request_rejected' }); else res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('connection', socket => { sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    if (closed) return; closed = true; clearTimeout(deadlineTimer); clearTimeout(inputTimer); settleError('local_input_closed');
    server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy();
  };
  const expire = () => { settleError('input_timeout'); close(); onCancel('input_timeout'); };
  // This timer is never rearmed. The worker passes the remaining original
  // lease, and its native guardian independently enforces that same deadline
  // even if JavaScript hangs or the OS sleeps. This setup has its own short
  // input wait; the bank's subsequent challenges do not reuse this listener.
  const deadlineTimer = setTimeout(expire, deadlineMs);
  try { await open(`${origin}${route}`); } catch { close(); throw new RuntimeError('local_page_open_failed'); }
  return {
    ask(next) {
      requireThat(!closed && !current && next === 'credentials', 'input_busy');
      stage = next; revision++;
      inputTimer = setTimeout(expire, timeoutMs);
      return new Promise((resolve, reject) => { current = { resolve, reject }; });
    },
    close,
  };
}
