import { randomBytes, randomInt } from 'node:crypto';

const ORIGIN = 'https://unidraw.io';
const FONT = 'Neue Haas Unica, Segoe UI Emoji';
const ZONE = { left: 100, top: 110, dx: 320, dy: 140 };
const PALETTES = [
  { fill: '#E7EDFF', ink: '#25377A', stroke: '#A6B8EA' },
  { fill: '#DCF4EE', ink: '#115B53', stroke: '#83C9B9' },
  { fill: '#FCEBDF', ink: '#743B19', stroke: '#E9AF89' },
  { fill: '#EFE7FA', ink: '#573378', stroke: '#C9AFE1' },
  { fill: '#FFF2C9', ink: '#654B09', stroke: '#DFC572' },
];
const KINDS = new Set(['process', 'decision', 'terminal', 'topic', 'note', 'heading',
  'sticker', 'text', 'frame', 'freedraw']);
const MAX_TEXT = 360;

export class UniDrawError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UniDrawError';
    this.code = code;
  }
}

const fail = code => { throw new UniDrawError(code); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value);
const string = (value, max) => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const color = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const nativeId = () => randomBytes(16).toString('base64url').slice(0, 21);
const optArray = value => Array.isArray(value) ? value : [];

// Board text is user data. The file format takes rich-text HTML, so render
// plain text yourself rather than passing model-authored markup to the site.
export const boardText = text => '<p>' + text.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]) + '</p>';

export function plainText(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) =>
    ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[entity]);
}

export function canonicalBoardUrl(value) {
  if (typeof value !== 'string') fail('INVALID_BOARD_URL');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_BOARD_URL'); }
  if (url.origin !== ORIGIN || url.username || url.password ||
      !/^\/app\/board\/[A-Za-z0-9_-]{8,60}\/?$/.test(url.pathname)) fail('INVALID_BOARD_URL');
  return ORIGIN + url.pathname.replace(/\/$/, '');
}

function normalizePlan(input) {
  if (!input || !string(input.title, 120) || !['flowchart','mindmap','free'].includes(input.layout) ||
      !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 160 ||
      !Array.isArray(input.edges) || input.edges.length > 320) fail('INVALID_PLAN');
  const ids = new Set();
  const labels = new Set();
  const nodes = input.nodes.map(node => {
    if (!node || !identifier(node.id) || ids.has(node.id) ||
        (node.kind==='freedraw' ? node.label!==undefined : !string(node.label, MAX_TEXT) || labels.has(node.label)) ||
        (node.kind !== undefined && !KINDS.has(node.kind)) ||
        (node.group !== undefined && !identifier(node.group)) ||
        (node.accent !== undefined && !integer(node.accent, 0, PALETTES.length - 1)) ||
        (node.color !== undefined && !color(node.color)) ||
        (node.column !== undefined && !integer(node.column, 0, 60)) ||
        (node.lane !== undefined && !integer(node.lane, 0, 40)) ||
        (node.position !== undefined && (!integer(node.position?.x, -25_000, 25_000) ||
          !integer(node.position?.y, -25_000, 25_000))) ||
        (input.layout === 'free' && node.position === undefined) ||
        (node.width !== undefined && !integer(node.width, 100, 1400)) ||
        (node.height !== undefined && !integer(node.height, 18, 2400)) ||
        (node.fontSize !== undefined && !integer(node.fontSize, 10, 85)) ||
        (node.kind==='freedraw' && (
          !node.position || !Array.isArray(node.points) || node.points.length<2 || node.points.length>450 ||
          node.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!integer(v,0,1500)))))
    ) fail('INVALID_NODE');
    ids.add(node.id);
    labels.add(node.label);
    return { ...node, kind: node.kind ?? (input.layout === 'mindmap' ? 'topic' : 'process') };
  });
  const byId=new Map(nodes.map(node=>[node.id,node]));
  for(const node of nodes) {
    if(node.frame!==undefined && (node.frame===node.id || byId.get(node.frame)?.kind!=='frame')) fail('INVALID_NODE_FRAME');
    // Broken nesting may prevent the editor from opening the board. Bound
    // the hierarchy and reject cycles independently of line relationships.
    const frames=new Set([node.id]);
    for(let parent=node.frame; parent!==undefined; parent=byId.get(parent)?.frame) {
      if(frames.has(parent)||frames.size>=8) fail('INVALID_NODE_FRAME');
      frames.add(parent);
    }
  }
  const edges = input.edges.map(edge => {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to ||
        [edge.from,edge.to].some(id=>['frame','freedraw'].includes(byId.get(id).kind)) ||
        (edge.label !== undefined && !string(edge.label, 150)) ||
        (edge.group !== undefined && !identifier(edge.group)) ||
        (edge.color !== undefined && !color(edge.color))) fail('INVALID_EDGE');
    return edge;
  });
  if (input.layout === 'mindmap' && !ids.has(input.root)) fail('INVALID_MINDMAP_ROOT');
  return { title: input.title, layout: input.layout, root: input.root, nodes, edges };
}

function nodeSize(node) {
  if(node.kind==='freedraw') return {
    width:Math.max(2,...node.points.map(p=>p[0]))+2,height:Math.max(2,...node.points.map(p=>p[1]))+2,
  };
  if(node.kind==='frame') return {width:node.width??550,height:node.height??300};
  if(node.kind==='sticker') return {width:node.width??160,height:node.height??160};
  const isDecision = node.kind === 'decision';
  const width = node.width ?? (isDecision ? 202 : 225);
  // A fixed width lets adjacent levels align. Increase height for multiline
  // labels so source text does not disappear inside a small bounding box.
  const lettersPerLine = Math.max(9, Math.floor(width / (isDecision ? 18 : 9)));
  const lines = Math.max(1, Math.ceil(node.label.length / lettersPerLine));
  const height = node.height ?? (isDecision
    ? Math.max(116, 38 + lines * 24)
    : node.kind==='text' ? Math.max(23,lines*((node.fontSize??18)+5))
      : Math.max(60, 27 + lines * 22));
  return { width, height };
}

function flowPositions(plan) {
  const byId = new Map(plan.nodes.map(n => [n.id, n]));
  const columns = new Map(plan.nodes.map(node => [node.id, node.column ?? 0]));
  const allowed = plan.edges.filter(edge => !edge.feedback);
  const pending = new Set(plan.nodes.map(n => n.id));
  // Relax only processed predecessors. Cycles keep stable input order and
  // can be marked as feedback explicitly for intentional return flows.
  while (pending.size) {
    const next = [...pending].find(id => !allowed.some(edge => edge.to === id && pending.has(edge.from)))
      ?? pending.values().next().value;
    pending.delete(next);
    for (const edge of allowed) {
      if (edge.from === next && pending.has(edge.to) && byId.get(edge.to).column === undefined) {
        columns.set(edge.to, Math.max(columns.get(edge.to), columns.get(next) + 1));
      }
    }
  }
  const cells = new Map();
  const columnWidths = [];
  const laneHeights = [];
  for (const n of plan.nodes) {
    if (n.position) continue;
    const column = columns.get(n.id);
    let lane = n.lane ?? 0;
    while (cells.has(`${column}:${lane}`)) lane++;
    cells.set(`${column}:${lane}`, n);
    const size = nodeSize(n);
    columnWidths[column] = Math.max(columnWidths[column] ?? ZONE.dx, size.width + 95);
    laneHeights[lane] = Math.max(laneHeights[lane] ?? ZONE.dy, size.height + 65);
  }
  const prefix = (values, index, fallback) => {
    let length = 0;
    for (let i = 0; i < index; i++) length += values[i] ?? fallback;
    return length;
  };
  const positions = new Map();
  for (const [key, n] of cells) {
    const [column, lane] = key.split(':').map(Number);
    positions.set(n.id, { x: ZONE.left + prefix(columnWidths,column,ZONE.dx), y: ZONE.top + prefix(laneHeights,lane,ZONE.dy) });
  }
  return positions;
}

function mindPositions(plan) {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const children = new Map(plan.nodes.map(node => [node.id, []]));
  const parents = new Set();
  for (const edge of plan.edges.filter(edge => !edge.crossLink)) {
    if (edge.to === plan.root || parents.has(edge.to)) fail('INVALID_MINDMAP_TREE');
    parents.add(edge.to);
    children.get(edge.from).push(edge.to);
  }
  const seen = new Set();
  const measure = id => {
    if (seen.has(id)) fail('INVALID_MINDMAP_TREE');
    seen.add(id);
    const descendants = children.get(id).map(measure);
    const { height } = nodeSize(nodes.get(id));
    return { id, descendants, span: Math.max(height + 38, descendants.reduce((sum, child) => sum + child.span, 0)) };
  };
  const tree = measure(plan.root);
  if (seen.size !== plan.nodes.length) fail('INVALID_MINDMAP_TREE');
  const sides = [{ span: 0, trees: [] }, { span: 0, trees: [] }];
  for (const branch of [...tree.descendants].sort((a,b) => b.span-a.span)) {
    const side = sides[0].span <= sides[1].span ? sides[0] : sides[1];
    side.trees.push(branch);
    side.span += branch.span;
  }
  const stride = Math.max(ZONE.dx, ...plan.nodes.map(node => nodeSize(node).width + 95));
  const center = Math.max(...sides.map(side => side.span / 2)) + ZONE.top;
  const depthOf = item => 1 + Math.max(0, ...item.descendants.map(depthOf));
  const rootX = ZONE.left + stride * Math.max(0,...sides[0].trees.map(depthOf));
  const positions = new Map();
  const place = (item, depth, side, y) => {
    const size = nodeSize(nodes.get(item.id));
    const mid = y + item.span / 2;
    positions.set(item.id,{x:rootX + depth*stride*side, y:mid-size.height/2});
    let offset = mid - item.descendants.reduce((sum,child) => sum + child.span,0)/2;
    for (const child of item.descendants) {
      place(child,depth+1,side,offset);
      offset += child.span;
    }
  };
  positions.set(plan.root,{x:rootX,y:center-nodeSize(nodes.get(plan.root)).height/2});
  sides.forEach((side,index) => {
    let y = center - side.span/2;
    for (const branch of side.trees) {
      place(branch,1,index === 0 ? -1 : 1,y);
      y += branch.span;
    }
  });
  return positions;
}

function common(id, type, zIndex, position, size, groupIds, now) {
  return {
    id, type, schema:2, position, size, version:1, versionNonce:randomInt(1,2**30),
    createdAt:now, updatedAt:now, alpha:100, zIndex, rotation:0,
    groupIds, isLocked:false, isDeleted:false, isDTO:true,
  };
}

function makePort(element, position, normal) {
  return {
    boundToId:element.id, snappedToEdge:true, position, normal,
    absolutePosition:{
      x:element.position.x + element.size.width * position.x,
      y:element.position.y + element.size.height * position.y,
    },
  };
}

function makePorts(source, target) {
  const dx = target.position.x + target.size.width/2 - source.position.x - source.size.width/2;
  const dy = target.position.y + target.size.height/2 - source.position.y - source.size.height/2;
  const horizontal = Math.abs(dx) > Math.abs(dy) * 0.85;
  const unit = horizontal ? {x:Math.sign(dx),y:0} : {x:0,y:Math.sign(dy) || 1};
  return {
    start: makePort(source,{x:(1+unit.x)/2,y:(1+unit.y)/2},unit),
    end: makePort(target,{x:(1-unit.x)/2,y:(1-unit.y)/2},{x:-unit.x,y:-unit.y}),
  };
}

function makeNode(node,nodes,z,position,groupIds,now) {
  const ink=PALETTES[node.accent??0];
  const dark=node.kind==='heading';
  const tone=node.color??(dark?'#203049':ink.fill);
  const nativeType=['frame','text','sticker','freedraw'].includes(node.kind)?node.kind:'shape';
  const base=common(nodes.get(node.id),nativeType,z,position,nodeSize(node),groupIds,now);
  const textStyle={tc:dark?'#FFFFFF':ink.ink,tff:FONT,tfs:node.fontSize??(dark?20:16),ta:'m',tva:'m'};
  const stroke={ss:'s',sc:ink.stroke,sw:1};
  if(nativeType==='freedraw') return {...base, points:node.points, lastCommittedPoint:node.points.at(-1),
    viewType:'curve',style:{sc:node.color??ink.ink,sw:2,ss:'s',fc:'transparent',fs:'s'}};
  const text=boardText(node.label);
  if(nativeType==='frame') return {...base,zIndex:-1,text,isExposed:true,
    // Filled with exact remapped children after every node has a stable ID.
    children:[],style:{tc:ink.ink,tfs:node.fontSize??13,tff:FONT,...stroke,
      fc:node.color??'#FFFFFF',fs:'s'}};
  if(nativeType==='text') return {...base,text,style:{tc:node.color??ink.ink,
    tff:FONT,tfs:node.fontSize??18,ta:'s'}};
  if(nativeType==='sticker') return {...base,text,isAuthorVisible:false,
    style:{...textStyle,tfs:node.fontSize??22,tfsa:node.fontSize===undefined,fc:tone,fs:'s'}};
  const rounded=!['process','decision'].includes(node.kind);
  return {...base,shape:node.kind==='decision'?'3':'1',text,seed:randomInt(1,2**30),roughness:0,
    style:{...textStyle,...stroke,fc:tone,fs:'s',sc:dark?tone:ink.stroke,
      ...(rounded?{sr:[16,16,16,16]}:{})}};
}

export function compileBoard(input) {
  const plan = normalizePlan(input);
  const positions = plan.layout === 'mindmap' ? mindPositions(plan) : flowPositions(plan);
  const groups = new Map();
  const groupIds = group => {
    if (!group) return [];
    if (!groups.has(group)) groups.set(group,nativeId());
    return [groups.get(group)];
  };
  const now = Date.now();
  const ids=new Map(plan.nodes.map(node=>[node.id,nativeId()]));
  const shapes=new Map(plan.nodes.map((node,index)=>[node.id,makeNode(node,ids,plan.edges.length+index+1,
    node.position??positions.get(node.id),groupIds(node.group),now)]));
  for(const node of plan.nodes) {
    if(node.frame!==undefined) shapes.get(node.frame).children.push(ids.get(node.id));
  }
  const lines = plan.edges.map((edge,index) => {
    const tipPoints = makePorts(shapes.get(edge.from),shapes.get(edge.to));
    const {start,end} = tipPoints;
    const a = start.absolutePosition;
    const b = end.absolutePosition;
    const stroke = edge.color ?? '#526480';
    const position = {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y)};
    const size = {width:Math.max(0.01,Math.abs(a.x-b.x)),height:Math.max(0.01,Math.abs(a.y-b.y))};
    return { ...common(nativeId(),'line',index+1,position,size,groupIds(edge.group),now),
      link:null,points:[],tipPoints,
      style:{ss:edge.feedback || edge.crossLink ? 'da' : 's',sc:stroke,sw:2,fc:'transparent',fs:'h',
        lst:0,let:2,lt:edge.straight ? 'a' : 'c',lsc:1},
      ...(edge.label ? {captions:[{text:boardText(edge.label),relativePosition:0.5,relativeOffset:0.5,
        style:{tc:stroke,tfs:14,tff:FONT,ta:'s'}}]} : {}),
    };
  });
  return {
    title:plan.title, scene:{type:'unidraw',version:1,source:ORIGIN,elements:[...lines,...shapes.values()],files:{}},
    nodes:Object.fromEntries([...shapes].map(([id,e]) => [id,e.id])),
    groups:Object.fromEntries(groups),
  };
}

const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);

export function readScene(document) {
  if (!document || document.type !== 'unidraw' || document.version !== 1 || !Array.isArray(document.elements) ||
      document.elements.length > 20_000) fail('UNRECOGNIZED_EXPORT');
  const elements = document.elements.filter(el => el?.isDeleted !== true);
  const byId = new Map();
  for (const element of elements) {
    if (!identifier(element?.id) || byId.has(element.id) || !point(element.position) ||
        !Number.isFinite(element.size?.width) || !Number.isFinite(element.size?.height)) fail('UNRECOGNIZED_EXPORT');
    byId.set(element.id,element);
  }
  return {elements,byId};
}

export function projectScene(document) {
  const {elements} = readScene(document);
  return elements.map(element => ({
    id:element.id, type:element.type, label:plainText(element.text).slice(0,MAX_TEXT),
    position:element.position, size:element.size, groups:optArray(element.groupIds),
    ...(element.type === 'line' ? {from:element.tipPoints?.start?.boundToId ?? null,
      to:element.tipPoints?.end?.boundToId ?? null,
      label:optArray(element.captions).map(caption=>plainText(caption.text)).join(' ').slice(0,MAX_TEXT)} : {}),
  }));
}
