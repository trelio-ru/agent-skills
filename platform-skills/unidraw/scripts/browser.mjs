import { canonicalBoardUrl, plainText, projectScene, readScene, UniDrawError } from './model.mjs';

const DASHBOARD = 'https://unidraw.io/app';
const TEXT_TYPES = new Map([['shape','Фигура'],['sticker','Стикер'],['text','Текст']]);
const WAIT = { timeout: 9_000 };
const exact = name => ({ name, exact:true });
const stop = code => { throw new UniDrawError(code); };
const testId = (ui, name) => ui.getByTestId(name);

export async function browserStep(code, action) {
  try {
    return await action();
  } catch (cause) {
    // Native browser errors can include board URLs, labels and locator traces.
    // Keep an exact step for recovery without exposing those inputs.
    if (cause instanceof UniDrawError) throw cause;
    stop(code);
  }
}

async function openControl(button,target,code = 'EDITOR_CONTROL_NOT_AVAILABLE') {
  await browserStep(code,async()=>{
    for (let attempt=0; attempt<2 && !await target.isVisible(); attempt++) {
      await button.click(WAIT);
      try { await target.waitFor({state:'visible',timeout:900}); }
      catch { /* Opening a menu is local UI only. Try once after noisy startup. */ }
    }
    if (!await target.isVisible()) stop(code);
  });
}

function sameBoard(url, expected) {
  try { return canonicalBoardUrl(url) === expected; } catch { return false; }
}

async function boardGuard(browser, board) {
  if (!sameBoard(await browser.url(), board)) stop('BOARD_CHANGED');
  const search = testId(browser.ui,'elements-search-button');
  try { await search.waitFor({state:'visible',...WAIT}); }
  catch { stop('BOARD_NOT_EDITABLE'); }
  if (!sameBoard(await browser.url(), board)) stop('BOARD_CHANGED');
}

// Import from the dashboard creates a new board. It must never run against
// the editor, where a similarly named menu may change an existing board.
export async function importBackups(browser, files, { selectProject, onWrite } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 3) stop('INVALID_BACKUP_COUNT');
  if ((await browser.url()).replace(/\/$/,'') !== DASHBOARD) stop('WRONG_IMPORT_LOCATION');
  const { ui } = browser;
  const dialog = ui.getByRole('dialog');
  if (!await dialog.isVisible()) {
    await ui.getByRole('button',exact('Импортировать')).click(WAIT);
    await ui.getByRole('menuitem',exact('Файл доски')).click(WAIT);
  }
  if (selectProject) await selectProject(ui);
  const picker = dialog.getByRole('button',exact('Выберите .unidraw файлы или перетяните их сюда'));
  await browser.chooseFiles(() => picker.click(WAIT), files);
  const submit = dialog.getByRole('button',exact('Импортировать'));
  if (!await submit.isEnabled()) stop('BACKUP_REJECTED');
  if (onWrite) await onWrite();
  await submit.click(WAIT);
  // These two results are legitimate across Chrome builds: navigation to
  // the new board, or the corresponding exact title in the dashboard list.
  return { dispatched:true };
}

async function exactOwnBoards(ui,title) {
  const paths=await ui.evaluate(name=>[...document.querySelectorAll('tr,[role=row]')]
    .filter(row=>row.getClientRects().length&&[...row.children].some(cell=>cell.textContent.trim()===name))
    .flatMap(row=>[...row.querySelectorAll('a[href]')].map(a=>a.href)),title);
  return [...new Set(paths)].map(canonicalBoardUrl);
}

export async function assertBoardTitleAvailable(browser,title) {
  await browser.navigate(DASHBOARD+'/my-boards');
  const {ui}=browser;
  const box=ui.getByRole('combobox',exact('Поиск досок'));
  try { await box.waitFor({state:'visible',...WAIT}); }
  catch { stop('LOGIN_OR_DASHBOARD_REQUIRED'); }
  // The own-board list is small in the test account. Use all presently
  // rendered rows as a preliminary duplicate check; the post-import
  // resolver still fails closed on any ambiguity after the server reload.
  if ((await exactOwnBoards(ui,title)).length) stop('BOARD_TITLE_ALREADY_EXISTS');
  await browser.navigate(DASHBOARD);
}

export async function findImportedBoard(browser, title) {
  const { ui } = browser;
  if ((await browser.url()).replace(/\/$/,'') === DASHBOARD) {
    const dialog = ui.getByRole('dialog');
    if (await dialog.isVisible()) {
      // A disabled submit alone can also mean rejection. Only close after the
      // actual per-file success receipt has appeared.
      await dialog.getByText('Файл успешно импортирован!',{exact:true}).first()
        .waitFor({state:'visible',...WAIT});
      await dialog.getByRole('button',exact('Закрыть')).click(WAIT);
    }
    if(browser.navigate) await browser.navigate(DASHBOARD+'/my-boards');
    else await ui.getByText('Мои доски',{exact:true}).click(WAIT);
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    const url = await browser.url();
    try {
      const board = canonicalBoardUrl(url);
      if (await browser.title() === title) return board;
    } catch (error) {
      if (error.code !== 'INVALID_BOARD_URL') throw error;
    }
    if (url.replace(/\/$/,'') === DASHBOARD+'/my-boards') {
      // A dashboard row has linked cells for metadata as well as the real
      // title. Only use the row that contains the exact visible title.
      const matches = await exactOwnBoards(ui,title);
      if (matches.length > 1) stop('IMPORTED_TITLE_AMBIGUOUS');
      if (matches.length === 1) return matches[0];
    }
    await new Promise(resolve => setTimeout(resolve,250));
  }
  stop('IMPORT_OUTCOME_UNKNOWN');
}

async function readBoardBackup(browser, board) {
  const { ui } = browser;
  await boardGuard(browser,board);
  const saveMenu = ui.getByRole('menuitem',exact('Сохранить файл'));
  const format = ui.getByRole('menuitem',exact('Файл доски'));
  const save = ui.getByRole('button',exact('Сохранить бэкап на компьютер'));
  if (!await save.isVisible()) {
    // A previous export or pointer movement may have left the submenu open.
    // Start at the deepest visible control to avoid toggling its parent.
    if (!await format.isVisible()) {
      await openControl(testId(ui,'menu-button'),saveMenu,'EXPORT_MENU_NOT_OPEN');
      await openControl(saveMenu,format,'EXPORT_FORMAT_NOT_OPEN');
    }
    await openControl(format,save,'EXPORT_DIALOG_NOT_OPEN');
  }
  if (!sameBoard(await browser.url(),board)) stop('BOARD_CHANGED');
  if (await save.count() !== 1 || !await save.isEnabled()) stop('EXPORT_BUTTON_NOT_AVAILABLE');
  // The native button is keyboard-focusable. Its center can be obscured
  // while the modal opens, so use normal keyboard activation.
  const document = await browser.downloadScene(() => save.press('Enter',WAIT));
  if (!sameBoard(await browser.url(),board)) stop('BOARD_CHANGED');
  readScene(document);
  return document;
}

export async function exportBoard(browser, board) {
  try {
    return await readBoardBackup(browser, board);
  } catch (cause) {
    if (!(cause instanceof UniDrawError) || cause.code !== 'EXPORT_DOWNLOAD_EVENT_MISSING') throw cause;
  }
  // A download can fail to arrive even after the editor saved a change.
  // Reopen the same board and retry only its read. The caller still checks
  // the expected changes against this saved state. Never repeat its edit
  // or reuse a backup from another board or an earlier download.
  if (!sameBoard(await browser.url(),board)) stop('BOARD_CHANGED');
  await browserStep('EXPORT_REOPEN_FAILED',() => browser.reload());
  return readBoardBackup(browser, board);
}

export async function selectFigure(browser, board, label, type='shape') {
  await boardGuard(browser,board);
  const { ui } = browser;
  const search = ui.getByRole('combobox',exact('element-search'));
  await openControl(testId(ui,'elements-search-button'),search);
  await search.fill(label,WAIT);
  if (!TEXT_TYPES.has(type)) stop('ELEMENT_EDIT_NOT_SUPPORTED');
  const result = ui.getByRole('option',exact(label+' '+TEXT_TYPES.get(type)));
  try { await result.waitFor({state:'visible',...WAIT}); }
  catch { stop('FIGURE_NOT_UNIQUE_OR_MISSING'); }
  if (await result.count() !== 1) stop('FIGURE_NOT_UNIQUE_OR_MISSING');
  await result.click(WAIT);
}

export async function viewport(browser) {
  const measured = await browser.ui.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect());
    const bounds = canvases.sort((a,b) => b.width*b.height-a.width*a.height).at(0);
    const zoom = document.querySelector('[data-testid="elements-rezet-zoom-button"]');
    return bounds && zoom ? {
      left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height,
      zoom:zoom.textContent,
    } : null;
  });
  const scale = Number.parseFloat(measured?.zoom)/100;
  if (!measured || !Number.isFinite(scale) || scale <= 0 ||
      measured.width < 520 || measured.height < 400) stop('CANVAS_UNAVAILABLE');
  return { ...measured, scale };
}

export async function openFigureEditor(browser, board, label, type='shape') {
  await selectFigure(browser,board,label,type);
  const view = await viewport(browser);
  const center = [Math.round(view.left+view.width/2),Math.round(view.top+view.height/2)];
  const editor = browser.ui.locator('[contenteditable="true"]:visible');
  // Search centers the actual shape, but we still verify the opened editor
  // before any write. This also guards viewport shifts and group selection.
  for (let attempt = 0; attempt < 2; attempt++) {
    await browser.clickPoint(center,2);
    if (await editor.count() === 1) {
      if (await editor.innerText(WAIT) !== label) stop('FIGURE_EDITOR_MISMATCH');
      return { editor, view, center };
    }
  }
  stop('FIGURE_EDITOR_UNAVAILABLE');
}

export function findUniqueShape(document, label) {
  const matches = readScene(document).elements.filter(el => TEXT_TYPES.has(el.type) && plainText(el.text) === label);
  if (matches.length !== 1) stop('FIGURE_NOT_UNIQUE_OR_MISSING');
  return matches[0];
}

const translation = (before,after) => ({
  x:after.position.x-before.position.x, y:after.position.y-before.position.y,
});

const isMove = (delta,dx,dy,tolerance) =>
  Math.abs(delta.x-dx) <= tolerance && Math.abs(delta.y-dy) <= tolerance;

function verifyConnections(before,after) {
  const {byId} = readScene(after);
  for (const edge of projectScene(before).filter(el=>el.type==='line')) {
    const observed = byId.get(edge.id);
    if (!observed || (observed.tipPoints?.start?.boundToId ?? null)!==edge.from ||
        (observed.tipPoints?.end?.boundToId ?? null)!==edge.to) stop('CONNECTIONS_NOT_VERIFIED');
  }
}

export function verifyImport(expected, actual) {
  const received = projectScene(actual);
  const planned = projectScene(expected);
  const remaining = received.filter(el=>el.type!=='line');
  const ids = new Map();
  const styles = readScene(actual).byId;
  const original = readScene(expected).byId;
  const groups = new Map();
  let offset;
  // UniDraw may remap IDs or translate the whole import. Match the complete
  // plan by distinct labels, relative geometry, styling and typed endpoints.
  if (planned.length!==received.length) stop('IMPORT_CONTENT_NOT_VERIFIED');
  // Labelled elements establish the common translation before strokes, which
  // have no label and must be matched by their path and exact geometry.
  const nodes=planned.filter(el=>el.type!=='line').sort((a,b)=>Number(Boolean(b.label))-Number(Boolean(a.label)));
  for (const node of nodes) {
    const index=remaining.findIndex(el=>el.type===node.type && el.label===node.label &&
      (!offset || isMove(translation(node,el),offset.x,offset.y,1)) &&
      (el.type!=='freedraw' || JSON.stringify(styles.get(el.id).points)===JSON.stringify(original.get(node.id).points)));
    if (index===-1) stop('IMPORT_CONTENT_NOT_VERIFIED');
    const [got]=remaining.splice(index,1);
    ids.set(node.id,got.id);
    offset ??= translation(node,got);
    // The renderer measures native text from fonts and normalizes sticker
    // widths to its own aspect ratio. Position and content remain strict.
    const measuredSize=node.type==='text'
      ? got.size.width>0&&got.size.height>0
      : Math.abs(node.size.height-got.size.height)<=1 &&
        Math.abs(node.size.width-got.size.width)<=(node.type==='sticker'?node.size.width*0.18:1);
    if (!isMove(translation(node,got),offset.x,offset.y,1) || !measuredSize ||
        styles.get(got.id).shape!==original.get(node.id).shape ||
        styles.get(got.id).style?.fc?.toLowerCase()!==original.get(node.id).style?.fc?.toLowerCase() ||
        node.groups.length!==got.groups.length) stop('IMPORT_CONTENT_NOT_VERIFIED');
    node.groups.forEach((group,index)=>{
      if (groups.has(group) && groups.get(group)!==got.groups[index]) stop('IMPORT_GROUPS_NOT_VERIFIED');
      groups.set(group,got.groups[index]);
    });
  }
  let importedFrameLinks=0, plannedFrameLinks=0;
  for(const frame of nodes.filter(el=>el.type==='frame')) {
    const children=original.get(frame.id).children??[];
    const actualChildren=styles.get(ids.get(frame.id)).children??[];
    const expectedChildren=new Set(children.map(child=>ids.get(child)));
    if(actualChildren.some(child=>!expectedChildren.has(child))) {
      stop('IMPORT_FRAME_CONTENT_NOT_VERIFIED');
    }
    plannedFrameLinks+=children.length;
    importedFrameLinks+=actualChildren.length;
  }
  const lines = received.filter(el=>el.type==='line');
  for (const edge of planned.filter(el=>el.type==='line')) {
    const i=lines.findIndex(el=>el.from===ids.get(edge.from) && el.to===ids.get(edge.to) &&
      el.label===edge.label && el.groups.length===edge.groups.length &&
      edge.groups.every((group,index)=>groups.get(group)===el.groups[index]));
    if (i===-1) stop('IMPORT_LINKS_NOT_VERIFIED');
    lines.splice(i,1);
  }
  return {elements:received.length,shapes:received.filter(el=>el.type==='shape').length,
    links:received.length-nodes.length,types:[...new Set(received.map(el=>el.type))],
    ...(importedFrameLinks!==plannedFrameLinks?{frameMembership:{planned:plannedFrameLinks,persisted:importedFrameLinks}}:{})};
}

export async function renameFigure(browser, board, { expectedLabel, label }) {
  if (typeof label!=='string' || !label.trim() || label.trim()!==label || label.length>360 ||
      /[\u0000-\u001f\u007f]/.test(label) || label===expectedLabel) stop('INVALID_RENAME');
  const before = await exportBoard(browser,board);
  const shape = findUniqueShape(before,expectedLabel);
  if (projectScene(before).some(el=>TEXT_TYPES.has(el.type) && el.label===label)) stop('RENAME_LABEL_ALREADY_PRESENT');
  const {editor} = await openFigureEditor(browser,board,expectedLabel,shape.type);
  await boardGuard(browser,board);
  await editor.fill(label,WAIT);
  await browser.press('Escape');
  const after = await exportBoard(browser,board);
  const changed = findUniqueShape(after,label);
  if (changed.id!==shape.id || !isMove(translation(shape,changed),0,0,0.5)) stop('RENAME_NOT_VERIFIED');
  verifyConnections(before,after);
  return {changed:1};
}

export async function moveElement(browser,board,{anchorLabel,dx,dy},asGroup) {
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.max(Math.abs(dx),Math.abs(dy))>4000 ||
      Math.max(Math.abs(dx),Math.abs(dy))<8) stop('INVALID_MOVE');
  const before = await exportBoard(browser,board);
  const anchor = findUniqueShape(before,anchorLabel);
  const mainGroup = anchor.groupIds?.[0];
  if (asGroup && !mainGroup) stop('NO_NATIVE_GROUP');
  if (!asGroup && mainGroup) stop('TARGET_BELONGS_TO_GROUP');
  const {elements} = readScene(before);
  const grouped=asGroup ? elements.filter(el=>el.groupIds?.includes(mainGroup)) : [anchor];
  const moving = grouped.filter(el=>el.type!=='line');
  if (asGroup && moving.length<2) stop('NO_NATIVE_GROUP');
  await selectFigure(browser,board,anchorLabel,anchor.type);
  let view=await viewport(browser);
  const center=v=>[Math.round(v.left+v.width/2),Math.round(v.top+v.height/2)];
  const destination=(point,scale)=>[Math.round(point[0]+dx*scale),Math.round(point[1]+dy*scale)];
  const visible=([x,y],v)=>x>=v.left+80&&x<=v.left+v.width-80&&y>=v.top+150&&y<=v.top+v.height-70;
  // Search selects the native group of the matching figure. Before drag,
  // verify the complete member count and the native ungroup action. Chrome
  // hides the selection toolbar when a wide group runs offscreen, whereas
  // opening its context menu exposes both signals.
  const selection = browser.ui.getByRole('heading',exact(grouped.length+' объектов'));
  const search = browser.ui.getByRole('combobox',exact('element-search'));
  if (await search.isVisible()) {
    await browser.clickPoint(center(view),1);
    await search.waitFor({state:'hidden',...WAIT});
  }
  // A click on an already selected single shape can enter its inline text
  // editor. Escape exits that mode without submitting a content change, so
  // the next right-click reaches UniDraw rather than Chrome's text menu.
  const editor=browser.ui.locator('[contenteditable="true"]:visible');
  if(await editor.count()) {
    if(await editor.count()!==1 || await editor.innerText(WAIT)!==anchorLabel) stop('FIGURE_EDITOR_MISMATCH');
    await browser.press('Escape');
    await editor.waitFor({state:'hidden',...WAIT});
  }
  for(let i=0;i<30&&!visible(destination(center(view),view.scale),view);i++){
    const last=view.scale;
    await testId(browser.ui,'elements-zoom-out-button').click(WAIT);
    view=await viewport(browser);
    if(view.scale===last)break;
  }
  const from=center(view);
  const to=destination(from,view.scale);
  if(!visible(to,view))stop('MOVE_OUTSIDE_VIEW');
  const ungroup = browser.ui.getByText('Разгруппировать',{exact:true});
  const contextCopy=browser.ui.getByText('Скопировать',{exact:true});
  try {
    for(let i=0;i<2&&!await contextCopy.isVisible();i++){
      await browser.contextPoint(from);
      try { await contextCopy.waitFor({state:'visible',timeout:1000}); } catch { /* Preflight: no provider write. */ }
    }
    if(!await contextCopy.isVisible()) stop('GROUP_SELECTION_NOT_VERIFIED');
    if(asGroup) {
      await ungroup.waitFor({state:'visible',timeout:1500});
      await selection.waitFor({state:'visible',timeout:1500});
    } else if(await ungroup.isVisible()) stop('TARGET_BELONGS_TO_GROUP');
  } catch { stop('GROUP_SELECTION_NOT_VERIFIED'); }
  await browser.press('Escape');
  try { await contextCopy.waitFor({state:'hidden',timeout:900}); }
  catch { stop('CONTEXT_MENU_NOT_CLOSED'); }
  await boardGuard(browser,board);
  await browser.drag(from,to);
  const after = await exportBoard(browser,board);
  const {byId} = readScene(after);
  verifyConnections(before,after);
  for (const original of elements.filter(el=>el.type!=='line')) {
    const updated = byId.get(original.id);
    const inGroup = moving.includes(original);
    // The zoom control displays an integer percent. For a long drag the
    // rounded display adds bounded drift, while neighbouring elements still
    // need to remain exactly on their original positions.
    const tolerance=inGroup?Math.max(6,Math.max(Math.abs(dx),Math.abs(dy))*0.035):0.5;
    if (!updated || !isMove(translation(original,updated),inGroup?dx:0,inGroup?dy:0,tolerance)) {
      stop('MOVE_NOT_VERIFIED');
    }
  }
  return {changed:moving.length,linkedElements:grouped.length-moving.length};
}

export const moveGroup=(browser,board,spec)=>moveElement(browser,board,spec,true);

export async function attachAsset(browser,board,{anchorLabel,dx,dy,path,name,bytes,kind}) {
  const before=await exportBoard(browser,board);
  const exactAnchor=findUniqueShape(before,anchorLabel);
  await selectFigure(browser,board,anchorLabel,exactAnchor.type);
  const view=await viewport(browser);
  const at=[Math.round(view.left+view.width/2+dx*view.scale),
    Math.round(view.top+view.height/2+dy*view.scale)];
  if(at[0]<view.left+80||at[0]>view.left+view.width-80||
      at[1]<view.top+150||at[1]>view.top+view.height-70)stop('PLACEMENT_OUTSIDE_VIEW');
  await boardGuard(browser,board);
  const picker=testId(browser.ui,'fileUploader');
  await browser.chooseFiles(()=>picker.click(WAIT),[path]);
  // Choosing files leaves a pending item on the pointer. The board changes
  // once when it is placed, so never replay this click after an uncertain save.
  await boardGuard(browser,board);
  await browser.clickPoint(at,1);
  const old=readScene(before);
  for(let i=0;i<3;i++){
    const after=await exportBoard(browser,board);
    const added=readScene(after).elements.filter(el=>!old.byId.has(el.id));
    if(added.length>1)stop('ATTACHMENT_OUTCOME_UNKNOWN');
    const asset=added[0];
    if(asset?.type===kind && asset.status==='saved' && typeof asset.fileId==='string' &&
        (kind==='image' ? Boolean(after.files?.[asset.fileId]?.dataURL) :
          plainText(asset.text)===name&&asset.fileSize===bytes)) {
      verifyConnections(before,after);
      return {added:1,type:kind};
    }
  }
  stop('ATTACHMENT_OUTCOME_UNKNOWN');
}
