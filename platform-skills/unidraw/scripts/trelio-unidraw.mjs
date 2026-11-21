#!/usr/bin/env node
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertBoardTitleAvailable, attachAsset, exportBoard, findImportedBoard, importBackups, moveElement,
  renameFigure, verifyImport,
} from './browser.mjs';
import { canonicalBoardUrl, compileBoard, projectScene, UniDrawError } from './model.mjs';

const SKILL = 'unidraw';
const VERSION = '0.1.0';
const ORIGIN = 'https://unidraw.io';
const DASHBOARD = ORIGIN+'/app';
const MAX_SPEC_BYTES = 192 * 1024;
const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = new Set(['.svg','.png','.jpg','.jpeg','.gif','.webp']);
const FILE_EXT = new Set(['.txt','.csv','.pdf','.xlsx','.docx','.pptx','.zip']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REQUEST = /^[a-zA-Z0-9_-]{16,96}$/;
const SPEC_OPS = new Set(['create-board','inspect-board','apply-board-changes','verify-operation']);
const OPERATIONS = new Set([...SPEC_OPS,'commands','doctor','setup','ready']);
const error = code => { throw new UniDrawError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');

// The caller names a local file. Neither the plan nor content from the
// provider is put in argv, the process environment, or diagnostics.
async function readLocal(filename, limit) {
  if (typeof filename!=='string' || !isAbsolute(filename)) error('INVALID_LOCAL_INPUT');
  const handle = await open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size<1 || stat.size>limit) error('INVALID_LOCAL_INPUT');
    const bytes = Buffer.alloc(stat.size+1);
    const {bytesRead} = await handle.read({buffer:bytes,length:bytes.length,position:0});
    if (bytesRead!==stat.size) error('INVALID_LOCAL_INPUT');
    return bytes.subarray(0,bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson(filename,limit) {
  const bytes=await readLocal(filename,limit);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { error('INVALID_LOCAL_JSON'); }
}

export function parseCommand([operation,...args]) {
  if (!OPERATIONS.has(operation)) error('INVALID_COMMAND');
  if (SPEC_OPS.has(operation)) {
    if (args.length!==2 || args[0]!=='--spec-file' || !isAbsolute(args[1])) error('INVALID_COMMAND');
    return {operation,specFile:args[1]};
  }
  if (args.length) error('INVALID_COMMAND');
  return {operation};
}

async function browserHost(env) {
  if (env.TRELIO_SKILL_ID!==SKILL ||
      !UUID.test(env.TRELIO_SKILL_COMPANY_ID??'') ||
      !UUID.test(env.TRELIO_SKILL_MEMBER_ID??'')) error('HOST_BINDING_REQUIRED');
  const route = env.TRELIO_BROWSER_SESSION_MODULE_URL;
  if (typeof route!=='string' || !route.startsWith('file:')) error('HOST_BINDING_REQUIRED');
  const host = await import(route);
  if (host.BROWSER_EXECUTION_SESSIONS_API!=='trelio.browser-execution-sessions/v1' ||
      typeof host.withPersistentBrowserSession!=='function') error('HOST_UPGRADE_REQUIRED');
  host.readBrowserSessionBinding({environment:env,expectedSessionClass:'messenger-profile'});
  let account;
  try { account=JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON??'null'); }
  catch { error('ACCOUNT_BINDING_REQUIRED'); }
  if (!UUID.test(account?.id??'') || !/^[0-9a-f]{64}$/i.test(account?.companyBinding??'') ||
      account.providerRef!==null) error('ACCOUNT_BINDING_REQUIRED');
  // The exact host-supplied account and company/member protect each profile.
  // A provider or unrelated Chrome profile is never accepted as an input.
  const accountDirectory=join(host.browserConfigHome(env),'unidraw',
    env.TRELIO_SKILL_COMPANY_ID.toLowerCase(),env.TRELIO_SKILL_MEMBER_ID.toLowerCase(),account.id.toLowerCase());
  return {host, accountDirectory};
}

async function privateDirectory(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const stat=await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory)!==resolve(directory) ||
      (typeof process.getuid==='function' && stat.uid!==process.getuid())) error('PRIVATE_DIRECTORY_INVALID');
  if (process.platform!=='win32') await chmod(directory,0o700);
}

export function createPlaywrightDriver(page,scratch) {
  return {
    ui:page, url:async()=>page.url(), title:()=>page.title(),
    navigate:url=>page.goto(url,{waitUntil:'domcontentloaded',timeout:20_000}),
    reload:()=>page.reload({waitUntil:'domcontentloaded',timeout:20_000}),
    clickPoint:([x,y],n=1)=>page.mouse.click(x,y,{clickCount:n}),
    contextPoint:([x,y])=>page.mouse.click(x,y,{button:'right'}),
    press:key=>page.keyboard.press(key),
    async drag([x,y],[toX,toY]) {
      await page.mouse.move(x,y);
      await page.mouse.down();
      try { await page.mouse.move(toX,toY,{steps:14}); }
      finally { await page.mouse.up(); }
    },
    async chooseFiles(click,paths) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser',{timeout:12_000}),click()]);
      await chooser.setFiles(paths);
    },
    async downloadScene(click) {
      const [download] = await Promise.all([page.waitForEvent('download',{timeout:14_000}),click()]);
      const file = join(scratch,'export.unidraw');
      try {
        await download.saveAs(file);
        if (process.platform!=='win32') await chmod(file,0o600);
        return await readJson(file,MAX_BACKUP_BYTES);
      } finally {
        await rm(file,{force:true});
        await download.delete().catch(()=>{});
      }
    },
  };
}

function allowedName(title) {
  // The dashboard takes the board name from the local filename. Fail closed
  // on OS-reserved names and separators instead of silently renaming output.
  if (typeof title!=='string' || title.length>108 || /[\\/:*?"<>|]/.test(title) ||
      /\.$/.test(title) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) error('INVALID_BOARD_NAME');
  return title;
}

function patchOperations(value) {
  if (!Array.isArray(value) || value.length<1 || value.length>12) error('INVALID_BOARD_CHANGE');
  for (const op of value) {
    if (!op || !['rename','move-group','move-element','attach-file'].includes(op.type)) error('INVALID_BOARD_CHANGE');
    if (op.type==='rename') {
      if (typeof op.expectedLabel!=='string' || !op.expectedLabel || op.expectedLabel.length>360 ||
          typeof op.label!=='string' || !op.label.trim() || op.label.trim()!==op.label || op.label.length>360 ||
          op.label===op.expectedLabel || /[\u0000-\u001f\u007f]/.test(op.label)) error('INVALID_BOARD_CHANGE');
    } else if (typeof op.anchorLabel!=='string' || !op.anchorLabel || op.anchorLabel.length>360 ||
      !Number.isInteger(op.dx) || !Number.isInteger(op.dy) || Math.max(Math.abs(op.dx),Math.abs(op.dy))>4000 ||
      Math.max(Math.abs(op.dx),Math.abs(op.dy))<8) error('INVALID_BOARD_CHANGE');
    if(op.type==='attach-file' && (typeof op.file!=='string'||!isAbsolute(op.file)||
      ![IMAGE_EXT,FILE_EXT].some(set=>set.has(extname(op.file).toLowerCase())))) error('INVALID_LOCAL_INPUT');
  }
  return value;
}

async function stageAsset(file,scratch,index) {
  const name=allowedName(basename(file));
  const bytes=await readLocal(file,MAX_ASSET_BYTES);
  const directory=join(scratch,'asset-'+index);
  await mkdir(directory,{mode:0o700});
  const path=join(directory,name);
  await writeFile(path,bytes,{mode:0o600,flag:'wx'});
  return {path,name,bytes:bytes.length,kind:IMAGE_EXT.has(extname(name).toLowerCase())?'image':'file'};
}

const sceneFingerprint = scene => hash(JSON.stringify(projectScene(scene)
  .map(e=>[e.id,e.type,e.label,e.position.x,e.position.y,e.size.width,e.size.height,e.groups,e.from??null,e.to??null])
  .sort((a,b)=>a[0].localeCompare(b[0]))));

export function prepareSpec(operation,spec) {
  if (!spec || typeof spec!=='object' || Array.isArray(spec)) error('INVALID_SPECIFICATION');
  if (operation==='verify-operation') {
    if (!REQUEST.test(spec.requestId??'')) error('REQUEST_ID_REQUIRED');
    return {requestId:spec.requestId};
  }
  if (operation==='inspect-board') {
    const offset=spec.offset??0, limit=spec.limit??20, query=spec.query??'';
    if (!Number.isInteger(offset)||offset<0||offset>20_000||!Number.isInteger(limit)||limit<1||limit>30||
        typeof query!=='string'||query.length>120) error('INVALID_INSPECT_RANGE');
    return {board:canonicalBoardUrl(spec.board),offset,limit,query};
  }
  if (!REQUEST.test(spec.requestId??'')) error('REQUEST_ID_REQUIRED');
  const digest=hash(JSON.stringify(spec));
  if (operation==='create-board') {
    const compiled=compileBoard(spec.plan);
    allowedName(compiled.title);
    return {requestId:spec.requestId,digest,compiled};
  }
  return {requestId:spec.requestId,digest,board:canonicalBoardUrl(spec.board),operations:patchOperations(spec.operations)};
}

async function verifyReady(page) {
  // Positive dashboard controls distinguish a signed-in browser from an
  // intermediate redirect, login form, maintenance page or stale profile.
  return page.getByRole('button',{name:'Импортировать',exact:true})
    .waitFor({state:'visible',timeout:4500}).then(()=>true,()=>false);
}

async function executeOnBoard(browser,operation,prepared,scratch,onProgress) {
  if (operation==='create-board') {
    const {compiled} = prepared;
    const file=join(scratch,compiled.title+'.unidraw');
    await writeFile(file,JSON.stringify(compiled.scene),{mode:0o600,flag:'wx'});
    await assertBoardTitleAvailable(browser,compiled.title);
    if (!await verifyReady(browser.ui)) error('LOGIN_OR_DASHBOARD_REQUIRED');
    await onProgress({stage:'import'});
    await importBackups(browser,[file]);
    const board=await findImportedBoard(browser,compiled.title);
    await onProgress({stage:'read_back',board});
    if (await browser.url()!==board) await browser.navigate(board);
    const expected=verifyImport(compiled.scene,await exportBoard(browser,board));
    await browser.reload();
    return {board,title:compiled.title,...expected,...verifyImport(compiled.scene,await exportBoard(browser,board))};
  }
  const {board} = prepared;
  await browser.navigate(board);
  if (operation==='inspect-board') {
    const elements=projectScene(await exportBoard(browser,board));
    const found=elements.filter(e=>e.label.toLowerCase().includes(prepared.query.toLowerCase()));
    return {board,total:found.length,offset:prepared.offset,elements:found.slice(prepared.offset,prepared.offset+prepared.limit),
      nextOffset:prepared.offset+prepared.limit<found.length?prepared.offset+prepared.limit:null};
  }
  const changes=[];
  // Freeze local bytes before any edits. A changed or missing attachment
  // cannot leave an otherwise valid batch half applied on preflight.
  const assets=new Map();
  for(const [index,change] of prepared.operations.entries()) if(change.type==='attach-file') {
    assets.set(change,await stageAsset(change.file,scratch,index));
  }
  for (const change of prepared.operations) {
    await onProgress({stage:'apply',board});
    switch(change.type) {
      case 'rename': changes.push(await renameFigure(browser,board,change)); break;
      case 'attach-file': changes.push(await attachAsset(browser,board,{...change,...assets.get(change)})); break;
      default: changes.push(await moveElement(browser,board,change,change.type==='move-group'));
    }
    await onProgress({stage:'read_back',board,changes});
  }
  const expected=sceneFingerprint(await exportBoard(browser,board));
  await browser.reload();
  if (expected!==sceneFingerprint(await exportBoard(browser,board))) error('SAVED_BOARD_NOT_VERIFIED');
  return {board,changes};
}

async function receiptAt(file) {
  try { return await readJson(file,128*1024); }
  catch (e) { if(e.code==='ENOENT') return null; throw e; }
}

async function replaceReceipt(file,receipt) {
  const next=file+'.'+process.pid+'.next';
  await writeFile(next,JSON.stringify(receipt),{mode:0o600,flag:'wx'});
  try { await rename(next,file); }
  finally { await rm(next,{force:true}); }
}

export async function runUniDraw(argv,env=process.env) {
  let operation='parse', stage='preflight', outcome='not_dispatched', receipt=null, receiptFile;
  try {
    if (argv.length===1&&argv[0]==='__trelio_accounts_import') return {schemaVersion:1,accounts:[]};
    const parsed=parseCommand(argv);
    operation=parsed.operation;
    if (operation==='commands') return {schemaVersion:1,operations:[...OPERATIONS],specFileOperations:[...SPEC_OPS]};
    if (operation==='doctor') return {schemaVersion:1,state:'ready',skillVersion:VERSION,browser:'not_checked',connection:'not_checked'};
    const prepared=parsed.specFile?prepareSpec(operation,await readJson(parsed.specFile,MAX_SPEC_BYTES)):null;
    const {host,accountDirectory}=await browserHost(env);
    if (operation==='verify-operation') {
      const observed=await receiptAt(join(accountDirectory,'operations',hash(prepared.requestId)+'.json'));
      return {schemaVersion:1,state:'ready',receipt:observed??null};
    }
    if (prepared?.requestId) {
      const receipts=join(accountDirectory,'operations');
      await privateDirectory(receipts);
      receiptFile=join(receipts,hash(prepared.requestId)+'.json');
      const retained=await receiptAt(receiptFile);
      if (retained) {
        if (retained.digest!==prepared.digest || retained.operation!==operation) error('REQUEST_ID_REUSED');
        return {schemaVersion:1,state:retained.outcome==='confirmed_succeeded'?'ready':'error',receipt:retained,reused:true};
      }
    }
    const runtime=host.inspectBrowserRuntime();
    if (!runtime.runtimeReady) await host.bootstrapPlaywright();
    await privateDirectory(accountDirectory);
    const scratch=await mkdtemp(join(accountDirectory,'transfer-'));
    try {
      const result=await host.withPersistentBrowserSession({
        label:'UniDraw',profileDirectory:join(accountDirectory,'profile'),lockPath:join(accountDirectory,'browser.lock'),
        downloadsDirectory:scratch,headed:operation==='setup',startInBackground:operation!=='setup',
        async prepareContext(context) {
          // The package may select a dashboard or one exact first-party
          // board. Form values cannot navigate the authenticated profile to
          // unrelated origins. Subresources use the browser's own CSP.
          await context.route('**/*',route=>{
            const r=route.request();
            if (r.isNavigationRequest() && new URL(r.url()).origin!==ORIGIN) return route.abort();
            return route.fallback();
          });
        },
      }, async (page,_value,lease)=>{
        const browser=createPlaywrightDriver(page,scratch);
        if (operation==='setup'||operation==='ready') {
          await browser.navigate(DASHBOARD);
          if (operation==='ready') return {connected:await verifyReady(page)};
          while (Date.now()<lease.deadlineAt-1500&&!page.isClosed()) {
            if (await verifyReady(page)) return {connected:true};
            await new Promise(resolve=>setTimeout(resolve,850));
          }
          error('LOGIN_NOT_COMPLETED');
        }
        if (!receiptFile) return executeOnBoard(browser,operation,prepared,scratch,()=>{});
        return executeOnBoard(browser,operation,prepared,scratch,async progress=>{
          stage=progress.stage;
          if(!receipt) {
            // Persist the claim before the first possible provider write.
            // An interrupted run or second process cannot repeat a mutation.
            const next={schemaVersion:1,operation,digest:prepared.digest,outcome:'unknown',...progress};
            try { await writeFile(receiptFile,JSON.stringify(next),{mode:0o600,flag:'wx'}); }
            catch(e) { if(e.code==='EEXIST') error('OPERATION_ALREADY_CLAIMED'); throw e; }
            receipt=next;
            outcome='unknown';
          } else {
            receipt={...receipt,...progress};
            await replaceReceipt(receiptFile,receipt);
          }
        });
      });
      if(receipt) {
        const {title:_title,...structuralResult}=result;
        await replaceReceipt(receiptFile,{...receipt,outcome:'confirmed_succeeded',stage:'completed',...structuralResult});
      }
      return {schemaVersion:1,state:'ready',...result};
    } finally {
      await rm(scratch,{recursive:true,force:true});
    }
  } catch (cause) {
    // Browser errors may contain URLs, selectors, export paths and board
    // labels. Keep a fixed diagnostic code, never forward raw error messages.
    return {schemaVersion:1,state:'error',operation,stage,outcome,
      code:cause instanceof UniDrawError?cause.code:'UNIDRAW_RUNTIME_ERROR',
      ...(receipt?.board?{board:receipt.board}:{}),
      ...(receipt?.changes?{changes:receipt.changes}:{}),
    };
  }
}

if (process.argv[1]&&await realpath(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await runUniDraw(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.state==='error') process.exitCode=1;
}
