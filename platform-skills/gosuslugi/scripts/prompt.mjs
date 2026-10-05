import http from 'node:http';
import crypto from 'node:crypto';
import { normalizeCredentials, requireThat, RuntimeError } from './core.mjs';

export const SAVE_WARNING = 'Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».';
export const TOTP_HELP = 'Необязательно. Сначала самостоятельно включите на Госуслугах подтверждение входа одноразовым кодом из приложения (TOTP), в настройках безопасности. Навык не включает этот режим за вас. Здесь нужен секретный ключ настройки, а не текущий шестизначный код. Если оставить поле пустым, при запросе Госуслуг появится отдельное поле для кода из SMS или приложения.';

export function promptHtml(scriptNonce) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trelio – вход в Госуслуги</title><style nonce="${scriptNonce}">
:root{color-scheme:light dark;--bg:#f4f6fa;--surface:#fff;--text:#182235;--muted:#475467;--line:#667085;--accent:#234bcc;--error:#9c182a}
@media(prefers-color-scheme:dark){:root{--bg:#151a24;--surface:#202836;--text:#f1f4fa;--muted:#bdc7d9;--line:#8491a8;--accent:#aec2ff;--error:#ffacb8}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}
main{max-width:640px;margin:24px auto;padding:clamp(20px,5vw,40px);border-radius:16px;background:var(--surface)}h1{font-size:26px;line-height:1.25}p{color:var(--muted)}
label{display:block;font-weight:600;margin-top:20px}input{width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:inherit}
small{display:block;color:var(--muted);font-size:14px;line-height:1.6;margin-top:8px}button{min-height:48px;padding:10px 20px;cursor:pointer;font:inherit;border:1px solid var(--accent);border-radius:8px;color:var(--accent);background:var(--surface)}
button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}#error{color:var(--error)}[hidden]{display:none!important}
</style><main><h1>Вход в Госуслуги</h1><p>Локальная страница Trelio. Данные не передаются агенту или серверу Trelio. Сессия ограничена 30 минутами, включая ожидание подтверждений.</p>
<p id="status" role="status" aria-live="polite">Подготовка…</p><p id="error" role="alert"></p>
<form id="form" autocomplete="off" hidden>
<section id="credentials" hidden><label for="login">Телефон Госуслуг</label><input id="login" type="tel" autocomplete="off" maxlength="24">
<label for="password">Пароль Госуслуг</label><input id="password" type="password" autocomplete="off" maxlength="256" aria-describedby="password-help"><small id="password-help">${SAVE_WARNING}</small>
<label for="totp">Секрет TOTP – необязательно</label><input id="totp" type="password" autocomplete="off" maxlength="2048" aria-describedby="totp-help totp-save"><small id="totp-help">${TOTP_HELP}</small><small id="totp-save">${SAVE_WARNING}</small></section>
<section id="code-fields" hidden><label for="code">Одноразовый код, который запросили Госуслуги</label><input id="code" type="password" inputmode="numeric" autocomplete="off" minlength="6" maxlength="8" aria-describedby="code-help"><small id="code-help">Возьмите код из SMS или вашего приложения согласно запросу Госуслуг. Код используется только для текущего входа и не сохраняется.</small></section>
<div class="actions"><button id="submit" type="submit">Продолжить</button><button id="cancel" type="button">Отмена</button></div></form></main>
<script nonce="${scriptNonce}">
const base=location.pathname, form=document.getElementById('form'), status=document.getElementById('status'), error=document.getElementById('error');
let revision=0, stage='waiting', busy=false, closed=false;
const field=id=>document.getElementById(id);
function clearSecrets(){for(const id of ['login','password','totp','code'])field(id).value=''}
function ended(){closed=true;clearSecrets();form.hidden=true;status.textContent='Локальный ввод завершён или срок ожидания истёк. Эту вкладку можно закрыть.'}
function render(state){if(state.revision===revision)return;revision=state.revision;stage=state.stage;clearSecrets();error.textContent='';
form.hidden=false;field('submit').hidden=!['credentials','code'].includes(stage);field('credentials').hidden=stage!=='credentials';field('code-fields').hidden=stage!=='code';
status.textContent=stage==='credentials'?'Укажите данные один раз. Они будут сохранены локально в зашифрованном виде.':stage==='code'?'Госуслуги запросили подтверждение входа.':'Ожидаем завершения текущего шага. Не закрывайте вкладку.';
for(const id of ['login','password'])field(id).required=stage==='credentials';field('code').required=stage==='code';
if(stage==='credentials')field('login').focus();if(stage==='code')field('code').focus();}
async function poll(){if(closed)return;try{const r=await fetch(base+'/state',{cache:'no-store'});if(!r.ok)return ended();render(await r.json())}catch{ended()}if(!closed)setTimeout(poll,1000)}
async function submit(action){if(busy||closed)return;busy=true;field('submit').disabled=true;error.textContent='';
let values=action==='cancel'?{}:stage==='credentials'?{login:field('login').value,password:field('password').value,totp:field('totp').value}:{code:field('code').value};
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

// One listener is one connected human input flow. It has no credential/state
// read API: state reports only stage/revision. The opening callback is private
// to the worker, never returned through the CLI or MCP.
export async function createPrompt({ open, timeoutMs = 300000, onCancel = () => {} }) {
  const nonce = crypto.randomBytes(32).toString('hex'), scriptNonce = crypto.randomBytes(24).toString('base64');
  const route = `/${nonce}`;
  let origin, loaded = false, closed = false, current = null, revision = 1, stage = 'waiting';
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
        respond(200, { stage: 'done' }); settleError('user_cancelled'); onCancel(); setImmediate(() => close()); return;
      }
      requireThat(packet.action === 'submit' && current, 'request_rejected');
      let value;
      try {
        if (stage === 'credentials') value = normalizeCredentials(packet.values);
        else {
          requireThat(Object.keys(packet.values).join() === 'code' && /^\d{6,8}$/.test(packet.values.code));
          value = packet.values.code;
        }
      } catch { respond(422, { error: 'input_invalid' }); return; }
      const submitted = current; current = null; stage = 'waiting'; revision++;
      respond(200, state()); submitted.resolve(value);
    } catch { if (!res.headersSent) respond(403, { error: 'request_rejected' }); else res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('connection', socket => { sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    if (closed) return; closed = true; clearTimeout(timer); settleError('local_input_closed');
    server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy();
  };
  const timer = setTimeout(() => { settleError('input_timeout'); close(); onCancel(); }, timeoutMs);
  try { await open(`${origin}${route}`); } catch { close(); throw new RuntimeError('local_page_open_failed'); }
  return {
    ask(next) {
      requireThat(!closed && !current && ['credentials', 'code'].includes(next), 'input_busy');
      stage = next; revision++;
      return new Promise((resolve, reject) => { current = { resolve, reject }; });
    },
    close,
  };
}
