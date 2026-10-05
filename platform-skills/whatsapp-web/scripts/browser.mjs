import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPrivateFile } from './native.mjs';
import { digest, requireThat, RuntimeError, UUID } from './core.mjs';

const ORIGIN = 'https://web.whatsapp.com';
const ACTIONS = new Set(['browser-click','browser-type','browser-key','browser-upload']);
export const BROWSER_COMMANDS = ['browser-snapshot','browser-scroll',...ACTIONS];
const KEYS = new Set(['Enter','Escape','Tab','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ControlOrMeta+A']);

export function validateBrowserRequest(packet) {
  requireThat(packet && BROWSER_COMMANDS.includes(packet.command), 'unknown_browser_command');
  const fields = new Set(['command','sessionId','snapshotId','output','x','y','deltaY','ref','text','key','file','requestId','dryRun','confirm','approvalHash']);
  requireThat(Object.keys(packet).every(key => fields.has(key)), 'unsupported_option');
  for (const name of ['snapshotId','output','ref','text','key','file','requestId','approvalHash']) if (packet[name] !== undefined)
    requireThat(typeof packet[name] === 'string' && packet[name].length <= (name === 'text' ? 20000 : 4096) && !packet[name].includes('\0'), 'invalid_input');
  for (const name of ['x','y']) if (packet[name] !== undefined) requireThat(Number.isInteger(packet[name]) && packet[name] >= 0 && packet[name] <= 10000, 'browser_coordinate_invalid');
  if (packet.deltaY !== undefined) requireThat(Number.isInteger(packet.deltaY) && Math.abs(packet.deltaY) <= 1500 && packet.deltaY !== 0, 'browser_scroll_invalid');
  for (const name of ['dryRun','confirm']) if (packet[name] !== undefined) requireThat(typeof packet[name] === 'boolean', 'invalid_input');
  if (ACTIONS.has(packet.command)) requireThat(UUID.test(packet.requestId || ''), 'request_id_required');
  return packet;
}

// Browser mode has its own ordinary persistent profile. It neither imports
// protocol keys into WhatsApp Web nor exposes cookies, IndexedDB or a CDP
// endpoint to callers. This local journal contains only policy and action
// claims; Chromium persists its native data directly, preserving CryptoKeys.
export class WhatsAppBrowser {
  constructor({ context, permit, persist, helper, saved, onPhase, onFatal }) {
    Object.assign(this, { context, permit, persist, helper, onPhase, onFatal });
    this.data = saved || { schema: 2, transport: 'browser', wasAuthenticated: false, policy: 'confirm', attempts: {} };
    requireThat(this.data.schema === 2 && this.data.transport === 'browser' && ['confirm','read-only','autonomous'].includes(this.data.policy) && this.data.attempts, 'browser_vault_invalid');
    // A stored allowance never grants permission in a different conversation.
    // Current-conversation authorization remains the agent's per-call attestation.
    if(this.data.policy==='autonomous')this.data.policy='confirm';
    this.connected = false; this.closed = false; this.approvals = new Map(); this.snapshot = null;
    this.saving = Promise.resolve();
  }
  async connect() {
    await this.permit();
    const moduleUrl = String(process.env.TRELIO_BROWSER_SESSION_MODULE_URL || '');
    requireThat(moduleUrl.startsWith('file:'), 'browser_session_host_required');
    const runtime = await import(moduleUrl);
    this.documentHttp = runtime.createDocumentHttpObserver(this.context, {
      isAllowedUrl: value => new URL(value).origin === ORIGIN,
    });
    // Message links and popups must not carry this authenticated context to an
    // unrelated site or desktop protocol. Provider subresources still load with
    // the browser's normal origin, CSP and cookie controls.
    await this.context.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && !request.url().startsWith(`${ORIGIN}/`)) return route.abort();
      return route.fallback();
    });
    const initial=this.context.pages();
    this.page = initial.find(page=>page.url()==='about:blank') || await this.context.newPage();
    for(const page of initial)if(page!==this.page)await page.close();
    this.context.on('page', page => { if (page !== this.page) void page.close(); });
    this.page.on('close', () => { if (!this.closed) this.onFatal('browser_closed'); });
    await this.page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const update = async () => {
      if (this.closed) return;
      await this.permit(); const state = await this.authState();
      if (state !== this.announced) {
        this.connected = state === 'ready'; this.announced = state;
        if (this.connected) {this.data.wasAuthenticated=true;await this.save();}
        this.onPhase(state);
      }
    };
    await update();
    this.poll = setInterval(() => { void update().catch(error => { if (!this.closed) this.onFatal(error instanceof RuntimeError ? error : new RuntimeError('browser_state_unknown')); }); }, 2000);
  }
  async authReady() { return await this.authState() === 'ready'; }
  async authState() {
    const failure = this.documentHttp?.failure(this.page);
    if (failure) throw new RuntimeError('service_http_error', { httpStatus: failure.httpStatus, httpOrigin: failure.origin });
    if (this.closed || !this.page || new URL(this.page.url()).origin !== ORIGIN) return 'browser_loading';
    return this.page.evaluate(() => {
      const visible = node => Boolean(node && node.getClientRects().length);
      const authenticated = [...document.querySelectorAll('#pane-side,[data-testid="chat-list"]')].some(visible);
      // Never return a QR, a login code, or an account-relink overlay even when
      // a stale chat list remains behind it. Checks happen before AND after a
      // screenshot; a raced image is discarded in memory before any file write.
      const sensitive = [...document.querySelectorAll('[data-ref],input[type="password"],input[autocomplete="one-time-code"],[data-testid*="qrcode"],[data-testid*="qr-code"]')].some(visible);
      // Absence of a chat list during startup is not evidence of logout.
      // Only a visible login control can request another human handoff.
      return sensitive ? 'browser_login_required' : authenticated ? 'ready' : 'browser_loading';
    });
  }
  async guard() {
    await this.permit(); requireThat(await this.authReady(), 'browser_login_or_sensitive_page');
  }
  async fingerprint() {
    await this.guard();
    const text = await this.page.evaluate(() => JSON.stringify({
      text: document.body.innerText,
      fields: [...document.querySelectorAll('input,textarea')].filter(node => node.getClientRects().length).map(node => [node.type,node.value,node.checked]),
      // A late image/layout update can move a button without changing text.
      // Bind geometry and control state as well, so old screenshot coordinates
      // cannot silently act on a different control after such an update.
      controls:[...document.querySelectorAll('button,[role="button"],a,input,textarea,[contenteditable="true"],[role="textbox"]')]
        .filter(node=>node.getClientRects().length).slice(0,500).map(node=>{
          const box=node.getBoundingClientRect();return [node.tagName,node.getAttribute('role'),node.getAttribute('aria-label'),
            node.getAttribute('aria-checked'),node.getAttribute('aria-expanded'),node.disabled,box.x,box.y,box.width,box.height];
        }),
      width: innerWidth, height: innerHeight
    }));
    requireThat(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'browser_page_too_large');
    return digest(text);
  }
  async save() {
    // Chromium persists its complete native storage directly in the profile.
    // Serializing IndexedDB through JSON would silently lose CryptoKey objects.
    const save = this.saving.then(async () => {
      await this.permit();
      const serialized = JSON.stringify(this.data);
      requireThat(Buffer.byteLength(serialized) <= 20 * 1024 * 1024, 'browser_vault_too_large');
      await this.persist(serialized);
    });
    this.saving = save.catch(() => {}); return save;
  }
  persistenceStatus() {
    return {mechanism:'local_profile',encryptedByTrelio:false,previouslyAuthenticated:this.data.wasAuthenticated===true};
  }
  async observe(output) {
    requireThat(typeof output === 'string' && path.isAbsolute(output), 'absolute_output_required');
    await this.guard();
    await this.clearSnapshot();
    const fingerprint = await this.fingerprint();
    const locator=this.page.locator('button,[role="button"],a,input,textarea,[contenteditable="true"],[role="textbox"]');
    const handles=[];
    for(let index=0,count=Math.min(await locator.count(),500);index<count;index++){
      const handle=await locator.nth(index).elementHandle();if(handle)handles.push(handle);
    }
    const controls = [], refs = new Map();
    let retained=false;
    try {
    for (const handle of handles.slice(0,500)) {
      const box = await handle.boundingBox();
      const fileInput = await handle.evaluate(node => node.matches('input[type="file"]'));
      if ((!box || box.width <= 0 || box.height <= 0) && !fileInput) {await handle.dispose();continue;}
      const details = await handle.evaluate(node => ({ role: node.getAttribute('role') || node.tagName.toLowerCase(),
        label: (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').slice(0,256),
        editable: node.matches('input:not([type="file"]),textarea,[contenteditable="true"]'),
        ...(node.matches('input[type="file"]') ? {fileInput:true,accept:node.accept||null} : {}) }));
      const ref = `r${controls.length + 1}`; refs.set(ref,handle); controls.push({ ref,...details,box });
    }
    const bytes = await this.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
    try {
      await this.guard(); requireThat(await this.fingerprint() === fingerprint, 'browser_snapshot_changed');
      await createPrivateFile(output,bytes,this.helper);
    } finally { bytes.fill(0); }
    this.snapshot = { id: randomUUID(), at: Date.now(), fingerprint, refs };
    retained=true;
    return { output, snapshotId: this.snapshot.id, controls, mode: 'browser', readReceipts: 'normal_whatsapp_web_behavior' };
    } finally {if(!retained)await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{})));}
  }
  async clearSnapshot(){const previous=this.snapshot;this.snapshot=null;await this.releaseRefs(previous);}
  async releaseRefs(snapshot){if(snapshot)await Promise.all([...snapshot.refs.values()].map(handle=>handle.dispose().catch(()=>{})));}
  async current(packet) {
    requireThat(this.snapshot && packet.snapshotId === this.snapshot.id && Date.now()-this.snapshot.at <= 120000, 'fresh_browser_snapshot_required');
    requireThat(await this.fingerprint() === this.snapshot.fingerprint, 'browser_snapshot_changed');
    return this.snapshot;
  }
  async execute(packet) {
    await this.permit();
    if (packet.command === 'policy') {
      if (packet.mode) {
        requireThat(packet.confirm === true && ['confirm','read-only'].includes(packet.mode), 'policy_confirmation_required');
        this.data.policy=packet.mode; await this.save();
      }
      return { policy:this.data.policy,mode:'browser' };
    }
    if (packet.command === 'result') {
      const result=this.data.attempts[packet.requestId];requireThat(result,'request_not_found');return result;
    }
    validateBrowserRequest(packet);
    if (packet.command === 'browser-snapshot') return this.observe(packet.output);
    const snapshot = await this.current(packet);
    if (packet.command === 'browser-scroll') {
      requireThat(Number.isInteger(packet.deltaY), 'browser_scroll_invalid');
      if (packet.x !== undefined && packet.y !== undefined) await this.page.mouse.move(packet.x,packet.y);
      await this.page.mouse.wheel(0,packet.deltaY);await this.clearSnapshot();
      return { applied:true,verification:'fresh_screenshot_required' };
    }
    requireThat(this.data.policy !== 'read-only', 'read_only_policy');
    let handle;
    if (['browser-type','browser-upload'].includes(packet.command)) {
      handle=snapshot.refs.get(packet.ref);requireThat(handle,'browser_ref_invalid');
      const kind=await handle.evaluate(node=>({editable:node.matches('input:not([type="file"]),textarea,[contenteditable="true"]'),file:node.matches('input[type="file"]')}));
      requireThat(packet.command==='browser-type'?kind.editable:kind.file,'browser_target_invalid');
    }
    if (packet.command==='browser-type') requireThat(typeof packet.text==='string','browser_text_required');
    if (packet.command==='browser-key') requireThat(KEYS.has(packet.key),'browser_key_not_allowed');
    if (packet.command==='browser-click') {
      requireThat(Number.isInteger(packet.x)&&Number.isInteger(packet.y),'browser_coordinate_invalid');
      const target=await this.page.evaluate(({x,y})=>{
        const node=document.elementFromPoint(x,y),link=node?.closest('a');
        return {exists:Boolean(node),href:link?.href||null};
      },{x:packet.x,y:packet.y});
      requireThat(target.exists && (!target.href || target.href.startsWith(`${ORIGIN}/`)), 'browser_external_navigation_forbidden');
    }
    let upload;
    if (packet.command==='browser-upload') {
      requireThat(packet.file && path.isAbsolute(packet.file), 'absolute_input_required');
      const fs=await import('node:fs/promises');const input=await fs.open(packet.file,'r');
      try{
        const stat=await input.stat(),entry=await fs.lstat(packet.file);
        requireThat(entry.isFile()&&!entry.isSymbolicLink()&&stat.ino===entry.ino&&stat.dev===entry.dev&&stat.size<=64*1024*1024,'file_invalid');
        upload=await input.readFile();requireThat(upload.length===stat.size&&upload.length<=64*1024*1024,'file_changed_during_read');
      }finally{await input.close();}
    }
    try {
      const payload={command:packet.command,snapshotId:snapshot.id,fingerprint:snapshot.fingerprint,requestId:packet.requestId,
        x:packet.x??null,y:packet.y??null,ref:packet.ref??null,text:packet.text??null,key:packet.key??null,
        fileName:packet.file?path.basename(packet.file):null,fileHash:upload?digest(upload):null};
      const hash=digest(JSON.stringify(payload));
      if(packet.dryRun){this.approvals.set(hash,Date.now()+120000);return {dryRun:true,payload,approvalHash:hash};}
      // Every click/key can send or change state. Do not let an agent label an
      // arbitrary UI operation "read-only" to bypass the same preview policy.
      requireThat(packet.confirm===true&&packet.approvalHash===hash&&(this.approvals.get(hash)||0)>Date.now(),'exact_approval_required');
      this.approvals.delete(hash);
      requireThat(!this.data.attempts[packet.requestId],'request_already_attempted');
      requireThat(Object.keys(this.data.attempts).length<5000,'request_journal_full');
      const result={requestId:packet.requestId,state:'attempted',mode:'browser',verified:false};
      this.data.attempts[packet.requestId]=result;await this.save();await this.current(packet);
      // Consume the snapshot before dispatch. A failed response can be checked
      // through result and a new observation, never by replaying the click.
      this.snapshot=null;
      try {
        if(packet.command==='browser-click')await this.page.mouse.click(packet.x,packet.y);
        else if(packet.command==='browser-type')await handle.fill(packet.text);
        else if(packet.command==='browser-key')await this.page.keyboard.press(packet.key);
        else await handle.setInputFiles({name:path.basename(packet.file),mimeType:'application/octet-stream',buffer:upload});
        result.state='applied';result.verification='ui_observation_required';await this.save();return result;
      } catch {result.state='ambiguous';await this.save();throw new RuntimeError('browser_result_ambiguous');}
      finally{await this.releaseRefs(snapshot);}
    } finally {upload?.fill(0);}
  }
  async beforeClose(){if(!this.closed)await this.save();}
  close(){this.documentHttp?.dispose();this.closed=true;this.connected=false;clearInterval(this.poll);this.snapshot=null;}
}
