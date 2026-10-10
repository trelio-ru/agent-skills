import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { privateProcess } from './storage.mjs';
import { check, credentials, Fault } from './core.mjs';

export async function openBrowser(url) {
  if (process.platform === 'darwin') return privateProcess('/usr/bin/open', [url]);
  check(process.platform === 'win32', 'secure_storage_unsupported');
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  check(root && path.isAbsolute(root), 'local_page_open_failed');
  return privateProcess(path.join(root, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]);
}
export function html(nonce) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trelio – ВК Реклама</title>
<style nonce="${nonce}">body{font:16px/1.6 system-ui;margin:24px;background:#f5f6fa;color:#182235}main{max-width:620px;margin:auto;padding:28px;background:white;border-radius:16px}label{display:block;margin-top:18px}input,select,button{font:inherit;padding:12px;box-sizing:border-box;min-height:48px}input,select{width:100%}button{margin-top:20px;cursor:pointer}:focus-visible{outline:3px solid #234bcc;outline-offset:3px}</style>
<main><h1>ВК Реклама</h1><p>Укажите API credentials из настроек вашего рекламного кабинета. Данные останутся на этом устройстве в защищённом хранилище. Не сохраняйте их в браузере и не отправляйте в чат.</p>
<form id="form" autocomplete="off"><label for="mode">Доступ</label><select id="mode"><option value="client">Свой кабинет</option><option value="agency">Клиент агентства</option></select>
<label for="client_id">Client ID</label><input id="client_id" required maxlength="256" autocomplete="off">
<label for="client_secret">Client Secret</label><input id="client_secret" type="password" required maxlength="4096" autocomplete="off">
<label for="agency_client">Логин клиента агентства – только для агентского доступа</label><input id="agency_client" maxlength="256" autocomplete="off">
<label for="groups">Версия структуры групп в вашем API</label><select id="groups"><option value="ad_groups">ad_groups – новый API</option><option value="campaigns">campaigns – совместимость myTarget</option></select>
<p>Выбранная структура проверяется чтением. При ошибке навык не переключает методы записи автоматически.</p>
<button id="submit" type="submit">Сохранить и проверить</button> <button id="cancel" type="button">Отмена</button></form><p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">const form=document.getElementById('form'),status=document.getElementById('status');let busy=false;
async function send(action){if(busy)return;busy=true;document.getElementById('submit').disabled=true;let values={};if(action==='save')for(const id of ['mode','client_id','client_secret','agency_client','groups'])values[id]=document.getElementById(id).value;
try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,values})});values=null;for(const id of ['client_id','client_secret','agency_client'])document.getElementById(id).value='';
if(response.status===422){status.textContent='Проверьте поля подключения';busy=false;document.getElementById('submit').disabled=false;return}form.hidden=true;status.textContent=response.ok?'Ввод завершён. Результат проверки появится в Trelio. Эту вкладку можно закрыть.':'Ввод не завершён. Проверьте результат в Trelio.'}
catch{values=null;form.hidden=true;status.textContent='Соединение с локальной формой потеряно. Проверьте результат в Trelio.'}}
form.addEventListener('submit',e=>{e.preventDefault();send('save')});document.getElementById('cancel').addEventListener('click',()=>send('cancel'));</script></html>`;
}
export async function input({ open = openBrowser, timeout = 300000 } = {}) {
  const route = `/${crypto.randomBytes(32).toString('hex')}`, nonce = crypto.randomBytes(24).toString('base64');
  let origin, loaded = false, consumed = false, resolve, reject;
  const submitted = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Install a handler before opening: an early browser/opener failure must not
  // create an unhandled rejection or print a secret-bearing request exception.
  submitted.catch(() => {});
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    try {
      check(!consumed && req.socket.remoteAddress === '127.0.0.1' && req.headers.host === new URL(origin).host &&
        !req.headers['x-forwarded-host'] && req.url === route, 'request_rejected');
      if (req.method === 'GET') {
        check(!loaded && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' &&
          ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'request_rejected');
        loaded = true; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html(nonce)); return;
      }
      check(loaded && req.method === 'POST' && req.headers.origin === origin && req.headers['sec-fetch-site'] === 'same-origin' &&
        req.headers['content-type'] === 'application/json' && !req.headers['content-encoding'], 'request_rejected');
      const chunks = []; let size = 0; let packet;
      try {
        for await (const chunk of req) { size += chunk.length; check(size <= 12000, 'body_too_large'); chunks.push(chunk); }
        packet = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { chunks.forEach(c => c.fill(0)); }
      check(packet && Object.keys(packet).sort().join() === 'action,values', 'request_rejected');
      if (packet.action === 'cancel') { consumed = true; reply(200, { phase: 'cancelled' }); reject(new Fault('user_cancelled')); return; }
      check(packet.action === 'save', 'request_rejected');
      let value; try { value = credentials(packet.values); } catch { reply(422, { error: 'credentials_invalid' }); return; }
      consumed = true; reply(200, { phase: 'submitted' }); resolve(value);
    } catch { if (!res.headersSent) reply(403, { error: 'request_rejected' }); else res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => reject(new Fault('input_timeout')), timeout);
  try { await open(`${origin}${route}`); return await submitted; }
  catch (error) { throw error instanceof Fault ? error : new Fault('local_page_open_failed'); }
  finally { clearTimeout(timer); server.close(); server.closeAllConnections(); }
}
