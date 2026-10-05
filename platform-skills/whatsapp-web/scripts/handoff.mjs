import http from 'node:http';
import crypto from 'node:crypto';
import { requireThat, RuntimeError, LEASE_MS } from './core.mjs';

export async function boundedJson(request, maximum = 65536) {
  requireThat(request.headers['content-type'] === 'application/json' && !request.headers['content-encoding'], 'invalid_content_type');
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; requireThat(length <= maximum, 'body_too_large'); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);
  try { return JSON.parse(buffer.toString()); }
  finally { buffer.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
}

// QR is a pairing credential. It exists only in this worker and its owned
// browser, never in the agent's state API, logs, screenshots or disk cache.
export async function createHandoff({ open, qrcode, remainingMs, onCancel, onRefresh }) {
  requireThat(remainingMs > 0 && remainingMs <= LEASE_MS, 'handoff_deadline_invalid');
  const route = `/${crypto.randomBytes(32).toString('hex')}`, nonce = crypto.randomBytes(24).toString('base64');
  let origin, loaded = false, closed = false, qr = null, revision = 0, phase = 'waiting';
  let refreshTimer, nextRefreshAt = 0;
  const canRefresh = () => !closed && phase !== 'ready' && phase !== 'refreshing' &&
    typeof onRefresh === 'function' && Date.now() >= nextRefreshAt;
  // A click invalidates in-flight page polls as well as hiding the image. An
  // older state response cannot paint the retired QR back during refresh.
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trelio – WhatsApp</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;padding:24px;background:#f2f6f4;color:#172b23;font:17px/1.6 system-ui}main{max-width:570px;margin:6vh auto;padding:32px;border-radius:20px;background:white}h1{font-size:28px}#qr{width:min(100%,300px);display:block;margin:24px auto}button{padding:12px 20px;background:white;border:1px solid #53645c;border-radius:8px;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #008567;outline-offset:4px}[hidden]{display:none!important}</style>
<main><h1>Подключить WhatsApp</h1><p>На телефоне откройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте QR-код.</p><p>Это отдельное устройство Trelio. Код используется только для привязки; отправлять его в чат не нужно.</p><p id="status" role="status" aria-live="polite">Готовим QR-код…</p><img id="qr" alt="QR-код для привязки WhatsApp" hidden><button id="refresh" type="button" disabled>Обновить QR-код</button> <button id="cancel" type="button">Отмена</button></main>
<script nonce="${nonce}">const base=location.pathname,status=document.getElementById('status'),img=document.getElementById('qr'),refresh=document.getElementById('refresh');let revision=-1,closed=false,requesting=false,pollEpoch=0;
function end(){closed=true;img.hidden=true;img.removeAttribute('src');status.textContent='Вход завершён или сессия закрыта. Эту вкладку можно закрыть.';document.getElementById('cancel').hidden=true;refresh.hidden=true}
async function poll(){const epoch=pollEpoch;try{const r=await fetch(base+'/state',{cache:'no-store'});if(!r.ok)return end();const v=await r.json();if(v.phase==='ready')return end();if(epoch===pollEpoch&&!requesting){refresh.disabled=requesting||!v.canRefresh;if(v.revision!==revision){revision=v.revision;img.hidden=!v.hasQr;if(v.hasQr)img.src=base+'/qr?v='+revision;else img.removeAttribute('src');status.textContent=v.hasQr?'Отсканируйте код камерой WhatsApp на телефоне.':v.phase==='refreshing'?'Обновляем QR-код…':v.phase==='refresh_failed'?'Не удалось обновить код. Нажмите «Обновить QR-код», чтобы попробовать снова.':'Подключаем устройство…'}}}catch{return end()}if(!closed)setTimeout(poll,1000)}
refresh.onclick=async()=>{if(requesting||closed)return;requesting=true;pollEpoch++;refresh.disabled=true;img.hidden=true;img.removeAttribute('src');status.textContent='Обновляем QR-код…';const displayedRevision=revision;revision=-1;try{await fetch(base+'/refresh?v='+displayedRevision,{method:'POST'})}catch{if(!closed)status.textContent='Не удалось связаться с окном входа.'}finally{requesting=false}};
document.getElementById('cancel').onclick=async()=>{try{await fetch(base+'/cancel',{method:'POST'})}finally{end()}};poll();</script></html>`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    try {
      requireThat(!closed && req.socket.localAddress === '127.0.0.1' && req.socket.remoteAddress === '127.0.0.1' &&
        req.headers.host === new URL(origin).host && !req.headers['x-forwarded-host'], 'handoff_rejected');
      if (req.method === 'GET' && req.url === route) {
        requireThat(!loaded && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document' &&
          ['none','same-origin'].includes(req.headers['sec-fetch-site']), 'handoff_rejected');
        loaded = true; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
      }
      requireThat(loaded && req.headers['sec-fetch-site'] === 'same-origin', 'handoff_rejected');
      if (req.method === 'GET' && req.url === `${route}/state`) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ phase, revision, hasQr: Boolean(qr), canRefresh: canRefresh() })); return;
      }
      if (req.method === 'GET' && req.url === `${route}/qr?v=${revision}` && qr) {
        const renderedRevision = revision;
        const svg = await qrcode.toString(qr, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
        requireThat(!closed && qr && revision === renderedRevision, 'handoff_rejected');
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svg); return;
      }
      if (req.method === 'POST' && req.url === `${route}/refresh?v=${revision}`) {
        requireThat(req.headers.origin === origin && canRefresh(), 'handoff_rejected');
        // Claim this displayed revision before asynchronous work. Double clicks
        // and replay cannot restart two sockets; the old QR is unusable here.
        qr = null; phase = 'refreshing'; revision++; nextRefreshAt = Date.now()+5000;
        const refreshRevision = revision;
        const failRefresh = () => { if (!closed && phase === 'refreshing' && revision === refreshRevision) { clearTimeout(refreshTimer); phase='refresh_failed'; revision++; } };
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(failRefresh,30000);
        res.writeHead(202); res.end();
        Promise.resolve().then(()=>onRefresh()).catch(failRefresh);
        return;
      }
      requireThat(req.method === 'POST' && req.url === `${route}/cancel` && req.headers.origin === origin, 'handoff_rejected');
      res.writeHead(200); res.end(); setImmediate(() => { close(); onCancel('user_cancelled'); });
    } catch { res.writeHead(403); res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.on('connection', socket => socket.setTimeout(5000, () => socket.destroy()));
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => { if (closed) return; closed = true; qr = null; clearTimeout(timer); clearTimeout(refreshTimer); server.close(); server.closeAllConnections(); };
  const timer = setTimeout(() => { close(); onCancel('handoff_expired'); }, remainingMs);
  try { await open(`${origin}${route}`); } catch { close(); throw new RuntimeError('handoff_open_failed'); }
  return { update(value) { requireThat(!closed && phase !== 'ready' && typeof value === 'string' && value.length <= 8192, 'qr_invalid'); clearTimeout(refreshTimer); qr = value; phase='waiting'; revision++; },
    ready() { clearTimeout(refreshTimer); qr = null; phase = 'ready'; revision++; }, close };
}
