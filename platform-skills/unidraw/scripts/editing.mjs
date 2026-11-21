import { isDeepStrictEqual } from 'node:util';
import { exportBoard, verifyImport, viewport } from './browser.mjs';
import { canonicalBoardUrl, plainText, readScene, UniDrawError } from './model.mjs';

const WAIT = { timeout: 9_000 };
const exact = name => ({ name, exact: true });
const stop = code => { throw new UniDrawError(code); };
export const validElementId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value);
const CONNECTABLE = new Set(['shape', 'sticker', 'text']);
const COPY_LINK = 'Скопировать ссылку на объект';
const POSITION_MARGIN = 2;

function elementHref(board, id) {
  if (!validElementId(id)) stop('INVALID_ELEMENT_ID');
  const result = new URL(canonicalBoardUrl(board));
  result.searchParams.set('elementId', id);
  return result.href;
}

function requireBoard(url, board) {
  if (canonicalBoardUrl(url) !== board) stop('BOARD_CHANGED');
}

export function exactElement(scene, id) {
  const element = readScene(scene).byId.get(id);
  if (!element) stop('ELEMENT_NOT_FOUND');
  return element;
}

const centerOf = item => ({
  x: item.position.x + item.size.width / 2,
  y: item.position.y + item.size.height / 2,
});

export function projectPoint(view, origin, point) {
  return [
    Math.round(view.left + view.width / 2 + (point.x - origin.x) * view.scale),
    Math.round(view.top + view.height / 2 + (point.y - origin.y) * view.scale),
  ];
}

function safePoint([x, y], view) {
  return x >= view.left + 72 && x <= view.left + view.width - 72 &&
    y >= view.top + 112 && y <= view.top + view.height - 76;
}

async function onCanvas(ui, [x, y]) {
  return ui.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', { x, y });
}

async function stableViewport(browser) {
  // The deep link animates a zoom after the canvas mounts. Sample the settled
  // zoom before translating exported world coordinates into screen coordinates.
  let before = await viewport(browser);
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 80));
    const after = await viewport(browser);
    stable = before.scale === after.scale ? stable + 1 : 0;
    if (stable === 4) return after;
    before = after;
  }
  stop('CANVAS_NOT_STABLE');
}

async function focusElement(browser, board, element, points) {
  const href = elementHref(board, element.id);
  if (await browser.url() === href) await browser.reload();
  else await browser.navigate(href);
  await browser.ui.getByTestId('elements-search-button').waitFor({ state: 'visible', ...WAIT });
  await browser.ui.locator('canvas:visible').first().waitFor({ state: 'visible', ...WAIT });
  requireBoard(await browser.url(), board);

  const origin = centerOf(element);
  let view = await stableViewport(browser);
  // 100% avoids the integer rounding of other displayed zoom levels. Use
  // further bounded zoom-out only when the requested points do not fit.
  if (view.scale !== 1) {
    await browser.ui.getByTestId('elements-rezet-zoom-button').click(WAIT);
    view = await stableViewport(browser);
  }
  const projected = () => points.map(point => projectPoint(view, origin, point));
  while (!projected().every(point => safePoint(point, view))) {
    const previous = view.scale;
    await browser.ui.getByTestId('elements-zoom-out-button').click(WAIT);
    view = await stableViewport(browser);
    if (view.scale >= previous) stop('PLACEMENT_OUTSIDE_VIEW');
  }
  return { view, origin, points: projected() };
}

function sameLink(value, board, id) {
  try {
    const given = new URL(value);
    return canonicalBoardUrl(given.href) === board &&
      given.searchParams.getAll('elementId').length === 1 &&
      given.searchParams.get('elementId') === id;
  } catch {
    return false;
  }
}

async function confirmAt(browser, board, element, point) {
  // A deep link centers the viewport but does not select the object. Require
  // the context menu's own link to match the export ID before any canvas edit.
  if (!await onCanvas(browser.ui, point)) return false;
  await browser.clickPoint(point);
  await browser.contextPoint(point);
  const link = browser.ui.getByText(COPY_LINK, exact(COPY_LINK));
  try {
    await link.waitFor({ state: 'visible', timeout: 1100 });
  } catch {
    await browser.press('Escape');
    return false;
  }
  const copied = await browser.captureNativeClipboard(() => link.click(WAIT), 'text');
  await link.waitFor({ state: 'hidden', ...WAIT });
  requireBoard(await browser.url(), board);
  return sameLink(copied, board, element.id);
}

async function verifiedSelection(browser, board, element, frame, candidates) {
  for (const candidate of candidates) {
    const xy = projectPoint(frame.view, frame.origin, candidate);
    if (safePoint(xy, frame.view) && await confirmAt(browser, board, element, xy)) return xy;
  }
  stop('ELEMENT_SELECTION_NOT_VERIFIED');
}

// The board's native Copy action emits this HTML envelope. A constant byte
// rotation wraps UTF-8 JSON. The payload contains only compiler-produced
// objects, never clipboard contents, provider user data or arbitrary HTML.
export function branchClipboard(board, scene) {
  const boardId = new URL(canonicalBoardUrl(board)).pathname.split('/').at(-1);
  const data = Buffer.from(JSON.stringify({
    type: 'unidraw/clipboard', boardId, elements: readScene(scene).elements,
  }), 'utf8');
  if (data.length > 640 * 1024) stop('BRANCH_PAYLOAD_TOO_LARGE');
  const payload = Buffer.from(data.map(byte => (byte + 59) & 255)).toString('base64');
  return '<span data-unidraw="&lt;--(unidraw-data-v1)' + payload + '(/unidraw-data-v1)--&gt;"></span>';
}

function bounds(elements) {
  const x = Math.min(...elements.map(item => item.position.x));
  const y = Math.min(...elements.map(item => item.position.y));
  return {
    x, y,
    right: Math.max(...elements.map(item => item.position.x + item.size.width)),
    bottom: Math.max(...elements.map(item => item.position.y + item.size.height)),
  };
}

function boundsCenter(box) {
  return { x: (box.x + box.right) / 2, y: (box.y + box.bottom) / 2 };
}

export function editableState(element) {
  // Revision and actor metadata can change when the provider serializes an
  // otherwise untouched object. Compare all its author-visible state.
  const { position, size, groupIds, type, shape, text, style, tipPoints,
    captions, children, zIndex, rotation, points, link, isLocked, fileId } = element;
  const persistedTip = tip => {
    if (!tip?.boundToId) return tip;
    // The editor caches world endpoints. After a connected group is moved,
    // a reloaded export can still include its old cache while the endpoint
    // remains bound to the correct object's same relative port.
    const { absolutePosition: _derived, ...attachment } = tip;
    return attachment;
  };
  const bindings = tipPoints && { start: persistedTip(tipPoints.start), end: persistedTip(tipPoints.end) };
  // With automatic sticker text sizing, UniDraw recalculates the font size
  // when the client fonts finish loading. Its auto-size setting is persisted.
  const { tfs: _measuredFontSize, ...autoStyle } = style ?? {};
  return { position, size, groupIds, type, shape, text, style: style?.tfsa === true ? autoStyle : style, tipPoints: bindings,
    captions, children, zIndex, rotation, points, link, isLocked, fileId };
}

export function verifyUnaffected(before, after, allowed = new Set()) {
  const original = readScene(before);
  const current = readScene(after);
  for (const item of original.elements) {
    if (allowed.has(item.id)) continue;
    const found = current.byId.get(item.id);
    if (!found || !isDeepStrictEqual(editableState(item), editableState(found))) stop('NEIGHBOUR_CHANGED');
  }
}

function closePoint(actual, expected, tolerance) {
  return Math.abs(actual.x - expected.x) <= tolerance && Math.abs(actual.y - expected.y) <= tolerance;
}

export function verifyBranchPaste(before, after, planned, expectedCenter, tolerance = 6) {
  verifyUnaffected(before, after);
  const original = readScene(before);
  const added = readScene(after).elements.filter(item => !original.byId.has(item.id));
  verifyImport(planned, { ...after, elements: added });
  if (!closePoint(boundsCenter(bounds(added)), expectedCenter, tolerance)) stop('BRANCH_PLACEMENT_NOT_VERIFIED');

  // Paste generates new IDs. Return the current native nodes so a later
  // edit can reference the exact new object even when its label is repeated.
  const frameMembership = added.filter(item => item.type === 'frame')
    .map(item => ({ id: item.id, children: item.children ?? [] }));
  return {
    added: added.length,
    nodes: added.filter(item => item.type !== 'line').map(item => ({ id: item.id, label: plainText(item.text) })),
    links: added.filter(item => item.type === 'line').map(item => item.id),
    ...(frameMembership.length ? { frameMembership } : {}),
  };
}

export async function insertBranch(browser, board, { anchorId, dx, dy, compiled }, onWrite) {
  const before = await exportBoard(browser, board);
  const anchor = exactElement(before, anchorId);
  if (!CONNECTABLE.has(anchor.type)) stop('BRANCH_ANCHOR_NOT_SUPPORTED');
  const origin = centerOf(anchor);
  const target = { x: origin.x + dx, y: origin.y + dy };
  const planned = compiled.scene;
  const items = readScene(planned).elements;
  const relative = bounds(items);
  const middle = boundsCenter(relative);
  const shifted = {
    x: relative.x + target.x - middle.x, right: relative.right + target.x - middle.x,
    y: relative.y + target.y - middle.y, bottom: relative.bottom + target.y - middle.y,
  };
  // Overlapping with a frame background is intentional. Overlapping an
  // existing element makes the branch unreadable and hides its ID hit area.
  if (readScene(before).elements.some(item => {
    if (item.type === 'frame' || item.type === 'line') return false;
    const box = bounds([item]);
    return shifted.x < box.right + 10 && shifted.right > box.x - 10 &&
      shifted.y < box.bottom + 10 && shifted.bottom > box.y - 10;
  })) stop('BRANCH_OVERLAPS_EXISTING_ELEMENT');

  const frame = await focusElement(browser, board, anchor, [target]);
  await verifiedSelection(browser, board, anchor, frame, [origin]);
  const [position] = frame.points;
  if (!await onCanvas(browser.ui, position)) stop('PLACEMENT_NOT_ON_CANVAS');
  const html = branchClipboard(board, planned);
  requireBoard(await browser.url(), board);
  await onWrite();
  await browser.pasteBranch(position, html);
  const tolerance = Math.max(6, Math.max(Math.abs(dx), Math.abs(dy)) * .025);
  const result = verifyBranchPaste(before, await exportBoard(browser, board), planned, target, tolerance);
  const nativeToKey = new Map(Object.entries(compiled.nodes).map(([key, id]) => [id, key]));
  const keyByLabel = new Map(items.filter(item => item.type !== 'line' && item.type !== 'freedraw')
    .map(item => [plainText(item.text), nativeToKey.get(item.id)]));
  // Labels may repeat on the board. They are unique inside this just-added
  // fragment, whose own IDs and positions have already been verified.
  return { ...result, nodes: result.nodes.map(({ label, id }) => ({ id, key: keyByLabel.get(label) })) };
}

export function verifyReconnection(before, after, { edgeId, end, targetId }) {
  const original = exactElement(before, edgeId);
  const updated = exactElement(after, edgeId);
  const fixed = end === 'start' ? 'end' : 'start';
  if (updated.type !== 'line' || updated.tipPoints?.[end]?.boundToId !== targetId ||
      !isDeepStrictEqual(updated.tipPoints?.[fixed], original.tipPoints?.[fixed]) ||
      !isDeepStrictEqual(updated.captions, original.captions) ||
      !isDeepStrictEqual(updated.style, original.style) ||
      !isDeepStrictEqual(updated.groupIds, original.groupIds)) stop('RECONNECTION_NOT_VERIFIED');
  if (readScene(after).elements.length !== readScene(before).elements.length) stop('NEIGHBOUR_CHANGED');
  verifyUnaffected(before, after, new Set([edgeId]));
  return { id: edgeId, from: updated.tipPoints.start.boundToId, to: updated.tipPoints.end.boundToId };
}

function targetPort(target, cursor) {
  const center = centerOf(target);
  const x = (cursor.x - center.x) / target.size.width;
  const y = (cursor.y - center.y) / target.size.height;
  return Math.abs(x) >= Math.abs(y)
    ? { x: center.x + Math.sign(x || 1) * (target.size.width / 2 - POSITION_MARGIN), y: center.y }
    : { x: center.x, y: center.y + Math.sign(y) * (target.size.height / 2 - POSITION_MARGIN) };
}

function lineHitCandidates(edge) {
  const start = edge.tipPoints.start;
  const end = edge.tipPoints.end;
  const a = start.absolutePosition;
  const b = end.absolutePosition;
  // Curves leave both binding ports along their outward normals. These are
  // only hit-test candidates. The exact native link remains the selector.
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const straight = [.12, .24, .76, .88].map(t => ({
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  }));
  const curves = [0.38, 0.55, 0.25].flatMap(ratio =>
    [.25, .75, .4, .6].map(t => {
      const s = 1 - t;
      const first = 3 * s * s * t * distance * ratio;
      const second = 3 * s * t * t * distance * ratio;
      return {
        x: (s ** 3 + 3 * s * s * t) * a.x + (t ** 3 + 3 * s * t * t) * b.x +
          first * (start.normal?.x ?? 0) + second * (end.normal?.x ?? 0),
        y: (s ** 3 + 3 * s * s * t) * a.y + (t ** 3 + 3 * s * t * t) * b.y +
          first * (start.normal?.y ?? 0) + second * (end.normal?.y ?? 0),
      };
    }));
  return [centerOf(edge), ...(edge.style?.lt === 'a' ? [...straight, ...curves] : [...curves, ...straight])];
}

export async function reconnectLine(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const edge = exactElement(before, spec.edgeId);
  const target = exactElement(before, spec.targetId);
  const moving = edge.tipPoints?.[spec.end];
  const fixed = edge.tipPoints?.[spec.end === 'start' ? 'end' : 'start'];
  if (edge.type !== 'line' || edge.isLocked || edge.groupIds?.length ||
      !moving?.absolutePosition || !fixed?.absolutePosition || !CONNECTABLE.has(target.type) ||
      target.isLocked || target.rotation ||
      !target.size.width || !target.size.height || target.id === fixed.boundToId ||
      target.id === moving.boundToId || (moving.boundToId ?? null) !== spec.expectedTargetId) {
    stop('RECONNECTION_PREFLIGHT_FAILED');
  }
  const start = moving.absolutePosition;
  const destination = targetPort(target, start);
  const frame = await focusElement(browser, board, edge, [start, destination]);
  await verifiedSelection(browser, board, edge, frame, lineHitCandidates(edge));
  const [from, to] = frame.points;
  if (!await onCanvas(browser.ui, from) || !await onCanvas(browser.ui, to)) stop('RECONNECTION_OCCLUDED');
  requireBoard(await browser.url(), board);
  await onWrite();
  await browser.drag(from, to);
  return verifyReconnection(before, await exportBoard(browser, board), spec);
}

async function prepareSingle(browser, board, scene, id, points) {
  const element = exactElement(scene, id);
  if (element.isLocked || element.rotation || element.groupIds?.length) stop('SINGLE_ELEMENT_REQUIRED');
  const origin = centerOf(element);
  const frame = await focusElement(browser, board, element, points);
  await verifiedSelection(browser, board, element, frame,
    element.type === 'line' && element.tipPoints?.start?.absolutePosition && element.tipPoints?.end?.absolutePosition
      ? lineHitCandidates(element) : [origin]);
  return frame;
}

function verifyOnlyEdited(before, after, id) {
  if (readScene(before).elements.length !== readScene(after).elements.length) stop('NEIGHBOUR_CHANGED');
  verifyUnaffected(before, after, new Set([id]));
  return exactElement(after, id);
}

export async function renameById(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const item = exactElement(before, spec.id);
  const label = plainText(item.text);
  if (!CONNECTABLE.has(item.type) || label !== spec.expectedLabel || label === spec.label) stop('RENAME_PREFLIGHT_FAILED');
  const center = centerOf(item);
  const frame = await prepareSingle(browser, board, before, spec.id, [center]);
  await browser.clickPoint(frame.points[0], 2);
  const editor = browser.ui.locator('[contenteditable="true"]:visible');
  await editor.waitFor({ state: 'visible', ...WAIT });
  if (await editor.innerText(WAIT) !== label) stop('FIGURE_EDITOR_MISMATCH');
  await onWrite();
  await editor.fill(spec.label, WAIT);
  await browser.press('Escape');
  const changed = verifyOnlyEdited(before, await exportBoard(browser, board), item.id);
  if (plainText(changed.text) !== spec.label || !closePoint(changed.position, item.position, .5)) stop('RENAME_NOT_VERIFIED');
  return { id: item.id, changed: 1 };
}

export async function setFill(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const item = exactElement(before, spec.id);
  if (!['shape', 'sticker'].includes(item.type) ||
      item.style?.fc?.toLowerCase() !== spec.expectedColor.toLowerCase()) stop('FILL_PREFLIGHT_FAILED');
  await prepareSingle(browser, board, before, spec.id, [centerOf(item)]);
  await browser.ui.getByRole('button', exact('Фон')).click(WAIT);
  const input = browser.ui.getByRole('textbox', exact('hex'));
  await input.waitFor({ state: 'visible', ...WAIT });
  await onWrite();
  await input.fill(spec.color.slice(1).toUpperCase(), WAIT);
  await input.press('Enter', WAIT);
  const changed = verifyOnlyEdited(before, await exportBoard(browser, board), item.id);
  const expected = editableState(item);
  if (changed.style?.fc?.toLowerCase() !== spec.color.toLowerCase() ||
      !isDeepStrictEqual({ ...expected, style: { ...expected.style, fc: changed.style.fc } },
        editableState(changed))) stop('FILL_NOT_VERIFIED');
  return { id: item.id, changed: 1 };
}

function incidentLines(scene, id) {
  return readScene(scene).elements.filter(item => item.type === 'line' &&
    [item.tipPoints?.start?.boundToId, item.tipPoints?.end?.boundToId].includes(id));
}

export async function removeElement(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const item = exactElement(before, spec.id);
  if (item.type !== spec.expectedType || plainText(item.text) !== spec.expectedLabel ||
      item.children?.length || incidentLines(before, item.id).length ||
      readScene(before).elements.some(candidate => candidate.children?.includes(item.id))) stop('REMOVE_PREFLIGHT_FAILED');
  await prepareSingle(browser, board, before, spec.id, [centerOf(item)]);
  await onWrite();
  await browser.press('Delete');
  const after = await exportBoard(browser, board);
  const current = readScene(after);
  verifyUnaffected(before, after, new Set([item.id]));
  if (current.byId.has(item.id) || current.elements.length !== readScene(before).elements.length - 1) stop('REMOVE_NOT_VERIFIED');
  return { id: item.id, removed: 1 };
}

export async function resizeElement(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const item = exactElement(before, spec.id);
  if (item.type !== 'shape' || Math.abs(item.size.width - spec.expectedWidth) > .5 ||
      Math.abs(item.size.height - spec.expectedHeight) > .5) stop('RESIZE_PREFLIGHT_FAILED');
  const corner = { x: item.position.x + item.size.width, y: item.position.y + item.size.height };
  const target = { x: item.position.x + spec.width, y: item.position.y + spec.height };
  const frame = await prepareSingle(browser, board, before, spec.id, [corner, target]);
  const [from, to] = frame.points;
  if (!await onCanvas(browser.ui, from) || !await onCanvas(browser.ui, to)) stop('RESIZE_OCCLUDED');
  await onWrite();
  await browser.drag(from, to);
  const after = await exportBoard(browser, board);
  const allowed = new Set([item.id]);
  for (const original of incidentLines(before, item.id)) {
    const line = exactElement(after, original.id);
    for (const end of ['start', 'end']) {
      if (line.tipPoints?.[end]?.boundToId !== original.tipPoints?.[end]?.boundToId) stop('RESIZE_NOT_VERIFIED');
    }
    if (!isDeepStrictEqual(line.captions, original.captions) || !isDeepStrictEqual(line.style, original.style)) {
      stop('RESIZE_NOT_VERIFIED');
    }
    allowed.add(original.id);
  }
  const updated = exactElement(after, item.id);
  if (readScene(after).elements.length !== readScene(before).elements.length ||
      !closePoint(updated.position, item.position, 1) ||
      !closePoint({ x: updated.size.width, y: updated.size.height }, { x: spec.width, y: spec.height }, 5) ||
      !isDeepStrictEqual({ ...editableState(item), size: updated.size }, editableState(updated))) stop('RESIZE_NOT_VERIFIED');
  verifyUnaffected(before, after, allowed);
  return { id: item.id, width: updated.size.width, height: updated.size.height };
}

const SIDES = {
  left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1],
};

export async function connectElements(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const source = exactElement(before, spec.sourceId);
  const target = exactElement(before, spec.targetId);
  if (source.type !== 'shape' || !CONNECTABLE.has(target.type) || target.isLocked || target.rotation ||
      source.id === target.id || incidentLines(before, source.id).some(item =>
        item.tipPoints?.start?.boundToId === source.id && item.tipPoints?.end?.boundToId === target.id)) {
    stop('CONNECT_PREFLIGHT_FAILED');
  }
  const origin = centerOf(source);
  const end = targetPort(target, origin);
  const toward = centerOf(target);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  const side = spec.sourceSide ?? (Math.abs(dx) >= Math.abs(dy)
    ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top'));
  const [ax, ay] = SIDES[side];
  const edge = {
    x: origin.x + ax * source.size.width / 2,
    y: origin.y + ay * source.size.height / 2,
  };
  const frame = await prepareSingle(browser, board, before, source.id, [edge, end]);
  await browser.ui.getByRole('button', exact('Фон')).waitFor({ state: 'visible', ...WAIT });
  // UniDraw exposes the four quick-connector dots 21 CSS pixels outside a
  // selected shape. This offset is screen-space, independent of board zoom.
  const [[x, y], to] = frame.points;
  const from = [x + ax * 21, y + ay * 21];
  if (!safePoint(from, frame.view) || !await onCanvas(browser.ui, from) || !await onCanvas(browser.ui, to)) {
    stop('CONNECTION_OCCLUDED');
  }
  await onWrite();
  await browser.drag(from, to);
  const after = await exportBoard(browser, board);
  const original = readScene(before);
  const added = readScene(after).elements.filter(item => !original.byId.has(item.id));
  verifyUnaffected(before, after);
  if (added.length !== 1 || added[0].type !== 'line' ||
      added[0].tipPoints?.start?.boundToId !== source.id || added[0].tipPoints?.end?.boundToId !== target.id) {
    stop('CONNECTION_NOT_VERIFIED');
  }
  return { id: added[0].id, from: source.id, to: target.id };
}

function clipboardSelection(html, board) {
  if (typeof html !== 'string' || html.length > 900_000) stop('NATIVE_SELECTION_NOT_VERIFIED');
  const payload = html.match(/data-unidraw="&lt;--\(unidraw-data-v1\)([A-Za-z0-9+/=]+)\(\/unidraw-data-v1\)--&gt;"/)?.[1];
  if (!payload) stop('NATIVE_SELECTION_NOT_VERIFIED');
  const bytes = Buffer.from(payload, 'base64');
  let data;
  try { data = JSON.parse(Buffer.from(bytes.map(byte => (byte - 59 + 256) & 255)).toString('utf8')); }
  catch { stop('NATIVE_SELECTION_NOT_VERIFIED'); }
  if (data.type !== 'unidraw/clipboard' || data.boardId !== new URL(board).pathname.split('/').at(-1)) {
    stop('NATIVE_SELECTION_NOT_VERIFIED');
  }
  return readScene({ type: 'unidraw', version: 1, elements: data.elements }).elements;
}

function selectionKey(item) {
  return JSON.stringify([
    item.type, item.shape, item.position.x, item.position.y, item.size.width, item.size.height,
    plainText(item.text), item.captions?.map(caption => plainText(caption.text)), item.rotation,
  ]);
}

async function proveSelection(browser, board, point, expected, scene) {
  // A native clipboard copy recycles IDs and stack indices. It preserves
  // typed geometry and labels. Prove every selected member against a unique
  // match across the exact board, and refuse coincident indistinguishable items.
  if (!await onCanvas(browser.ui, point)) stop('NATIVE_SELECTION_NOT_VERIFIED');
  const counts = new Map();
  for (const item of readScene(scene).elements) {
    const key = selectionKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = expected.map(selectionKey);
  if (keys.some(key => counts.get(key) !== 1)) stop('NATIVE_SELECTION_AMBIGUOUS');
  await browser.contextPoint(point);
  const copy = browser.ui.getByText('Скопировать', { exact: true });
  await copy.waitFor({ state: 'visible', ...WAIT });
  const html = await browser.captureNativeClipboard(() => copy.click(WAIT), 'html');
  await copy.waitFor({ state: 'hidden', ...WAIT });
  const selected = clipboardSelection(html, board).map(selectionKey).sort();
  if (!isDeepStrictEqual(selected, keys.sort())) stop('NATIVE_SELECTION_NOT_VERIFIED');
  requireBoard(await browser.url(), board);
}

async function groupContext(browser, board, items, scene) {
  const anchor = items.find(item => CONNECTABLE.has(item.type));
  if (!anchor) stop('GROUP_ANCHOR_NOT_SUPPORTED');
  const center = centerOf(anchor);
  const frame = await focusElement(browser, board, anchor, [center]);
  const [point] = frame.points;
  if (!await onCanvas(browser.ui, point)) stop('NATIVE_SELECTION_NOT_VERIFIED');
  await browser.clickPoint(point);
  await proveSelection(browser, board, point, items, scene);
  return point;
}

async function contextWrite(browser, board, point, title, onWrite) {
  requireBoard(await browser.url(), board);
  await browser.contextPoint(point);
  const action = browser.ui.getByText(title, { exact: true });
  await action.waitFor({ state: 'visible', ...WAIT });
  await onWrite();
  await action.click(WAIT);
}

function resolveGroup(before, anchorId, expectedMembers) {
  const anchor = exactElement(before, anchorId);
  const group = anchor.groupIds?.[0];
  if (!group) stop('NO_NATIVE_GROUP');
  const items = readScene(before).elements.filter(item => item.groupIds?.includes(group));
  if (!isDeepStrictEqual(items.map(item => item.id).sort(), [...expectedMembers].sort()) ||
      items.some(item => item.isLocked || item.groupIds?.[0] !== group)) stop('GROUP_MEMBERS_CHANGED');
  return { group, items };
}

export async function changeGrouping(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const ungroup = spec.type === 'ungroup-elements';
  let items;
  let expectedGroup;
  let hit;
  if (ungroup) {
    ({ group: expectedGroup, items } = resolveGroup(before, spec.anchorId, spec.ids));
    hit = await groupContext(browser, board, items, before);
  } else {
    items = spec.ids.map(id => exactElement(before, id));
    if (items.some(item => !CONNECTABLE.has(item.type) || item.rotation || item.isLocked || item.groupIds?.length)) {
      stop('GROUP_TARGET_NOT_SUPPORTED');
    }
    const frame = await focusElement(browser, board, items[0], items.map(centerOf));
    for (const [index, point] of frame.points.entries()) {
      if (!await onCanvas(browser.ui, point)) stop('NATIVE_SELECTION_NOT_VERIFIED');
      await browser.clickPoint(point, 1, index ? 'Shift' : undefined);
    }
    hit = frame.points[0];
    await proveSelection(browser, board, hit, items, before);
  }
  await contextWrite(browser, board, hit, ungroup ? 'Разгруппировать' : 'Сгруппировать', onWrite);
  const after = await exportBoard(browser, board);
  if (readScene(after).elements.length !== readScene(before).elements.length) stop('GROUP_NOT_VERIFIED');
  verifyUnaffected(before, after, new Set(spec.ids));
  const newGroup = ungroup ? null : exactElement(after, items[0].id).groupIds?.[0];
  if (!ungroup && (!newGroup || readScene(after).elements.some(item =>
    item.groupIds?.includes(newGroup) && !spec.ids.includes(item.id)))) stop('GROUP_NOT_VERIFIED');
  for (const item of items) {
    const changed = exactElement(after, item.id);
    const expected = ungroup ? item.groupIds.filter(id => id !== expectedGroup) : [newGroup];
    // Grouping brings members into a common stacking range; all properties
    // other than the group and the local stack index are verified.
    if (!isDeepStrictEqual({ ...editableState(item), groupIds: expected, zIndex: changed.zIndex },
      editableState(changed))) stop('GROUP_NOT_VERIFIED');
  }
  return { ids: spec.ids, group: newGroup };
}

export async function duplicateSelection(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const origin = exactElement(before, spec.anchorId);
  const members = origin.groupIds?.length ? resolveGroup(before, spec.anchorId, spec.ids).items : [origin];
  if ((!origin.groupIds?.length && (spec.ids.length !== 1 || spec.ids[0] !== origin.id)) ||
      members.some(member => member.isLocked || !['shape','text','sticker','line','freedraw'].includes(member.type))) {
    stop('DUPLICATE_TARGET_NOT_SUPPORTED');
  }
  const ids = new Set(spec.ids);
  if (members.some(member => member.type === 'line' &&
    (!ids.has(member.tipPoints?.start?.boundToId) || !ids.has(member.tipPoints?.end?.boundToId)))) {
    stop('DUPLICATE_EXTERNAL_BINDINGS');
  }
  const point = await groupContext(browser, board, members, before);
  await contextWrite(browser, board, point, 'Дублировать', onWrite);
  const after = await exportBoard(browser, board);
  verifyUnaffected(before, after);
  const original = readScene(before);
  const added = readScene(after).elements.filter(item => !original.byId.has(item.id));
  verifyImport({ ...before, elements: members }, { ...after, elements: added });
  return { ids: added.map(item => item.id), duplicated: added.length };
}

export async function moveSelection(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const anchor = exactElement(before, spec.anchorId);
  if (!CONNECTABLE.has(anchor.type)) stop('MOVE_TARGET_NOT_SUPPORTED');
  const origin = centerOf(anchor);
  const destination = { x: origin.x + spec.dx, y: origin.y + spec.dy };
  const items = spec.ids ? resolveGroup(before, anchor.id, spec.ids).items : [anchor];
  let frame;
  if (spec.ids) {
    frame = await focusElement(browser, board, anchor, [origin, destination]);
    const [hit] = frame.points;
    if (!await onCanvas(browser.ui, hit)) stop('MOVE_TARGET_NOT_SUPPORTED');
    await browser.clickPoint(hit);
    await proveSelection(browser, board, hit, items, before);
  } else {
    frame = await prepareSingle(browser, board, before, anchor.id, [origin, destination]);
  }
  const [from, to] = frame.points;
  if (!await onCanvas(browser.ui, to)) stop('MOVE_OCCLUDED');
  requireBoard(await browser.url(), board);
  await onWrite();
  await browser.drag(from, to);
  const after = await exportBoard(browser, board);
  if (readScene(after).elements.length !== readScene(before).elements.length) stop('MOVE_NOT_VERIFIED');
  const moving = items.filter(item => item.type !== 'line');
  const permitted = new Set(items.map(item => item.id));
  const tolerance = Math.max(5, Math.max(Math.abs(spec.dx), Math.abs(spec.dy)) * .025);
  for (const item of moving) {
    const changed = exactElement(after, item.id);
    if (!closePoint(changed.position, { x: item.position.x + spec.dx, y: item.position.y + spec.dy }, tolerance) ||
        !isDeepStrictEqual({ ...editableState(item), position: changed.position }, editableState(changed))) {
      stop('MOVE_NOT_VERIFIED');
    }
    for (const line of incidentLines(before, item.id)) permitted.add(line.id);
  }
  const movingLines = new Set(items.filter(item => item.type === 'line').map(item => item.id));
  for (const line of readScene(before).elements.filter(item => item.type === 'line' && permitted.has(item.id))) {
    const original = editableState(line);
    const updated = editableState(exactElement(after, line.id));
    // The route of a bound line can be recomputed. Its bindings and
    // appearance remain unchanged. An explicitly grouped unbound stroke
    // has its world geometry translated as part of the group.
    if (movingLines.has(line.id) && !line.tipPoints?.start?.boundToId && !line.tipPoints?.end?.boundToId) {
      if (!closePoint(updated.position, { x: original.position.x + spec.dx, y: original.position.y + spec.dy }, tolerance)) {
        stop('MOVE_NOT_VERIFIED');
      }
      original.tipPoints = updated.tipPoints;
    }
    if (!isDeepStrictEqual({ ...original, position: updated.position, size: updated.size, points: updated.points }, updated)) {
      stop('MOVE_NOT_VERIFIED');
    }
  }
  verifyUnaffected(before, after, permitted);
  return { ids: items.map(item => item.id), changed: moving.length };
}

export async function setLayer(browser, board, spec, onWrite) {
  const before = await exportBoard(browser, board);
  const item = exactElement(before, spec.id);
  if (item.type !== 'shape' || item.zIndex !== spec.expectedIndex) stop('LAYER_PREFLIGHT_FAILED');
  const frame = await prepareSingle(browser, board, before, item.id, [centerOf(item)]);
  const front = spec.placement === 'front';
  await contextWrite(browser, board, frame.points[0], front ? 'На передний план' : 'На задний план', onWrite);
  const after = await exportBoard(browser, board);
  const current = exactElement(after, item.id);
  const neighbours = readScene(after).elements.filter(element => element.type !== 'frame' && element.id !== item.id);
  if (readScene(after).elements.length !== readScene(before).elements.length ||
      (front ? neighbours.some(element => element.zIndex > current.zIndex) :
        neighbours.some(element => element.zIndex < current.zIndex)) ||
      !isDeepStrictEqual({ ...editableState(item), zIndex: current.zIndex }, editableState(current))) {
    stop('LAYER_NOT_VERIFIED');
  }
  verifyUnaffected(before, after, new Set([item.id]));
  return { id: item.id, zIndex: current.zIndex };
}
