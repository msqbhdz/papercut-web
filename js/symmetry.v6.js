// v5 折叠-展开模型：纯几何 + 三态渲染。顶层零 DOM 依赖，只用 Math 与标准 Canvas 2D。
// 笔迹分两种工具：draw 画金线（刻线，纸还在），cut 用底色挖掉一条带（露出底盘）；
// cut 绕回起点成闭环时改挖整块，那一笔就等于「剪下来」。
// 「剪」永远最后生效：红纸 + 全部 draw 先构造成一张完整的纸，所有 cut 再统一当遮罩扣掉，
// 因此先剪后画也不会把颜色涂在已经剪掉的空气里（见 paintStrokes 的两遍）。

const TAU = Math.PI * 2;
const CENTER = { x: 0.5, y: 0.5 };
const MAX_RADIUS = 0.5;
// 成品态内缩：红盘直径只占画布 94%，四周各留 3% 白边，盘边才不会被画布圆角/边缘切平。
export const DISK_INSET = 0.94;
// canvas 的 y 轴向下，正上方因此是 -π/2。
const AXIS = -Math.PI / 2;
const EPS = 1e-9;

// 折叠态相机：顶点落在画布 88% 高处，外弧距顶点 0.86 倍画布高，最宽处不超过画布 92% 宽。
const FOLD_VERTEX_Y = 0.88;
const FOLD_REACH = 0.86;
const FOLD_WIDTH_FILL = 0.92;

// 低于这个 alpha 的层直接跳过，省下一次没人看得见的绘制。
const MIN_ALPHA = 0.01;

// 镜像片是压在下面的那几层：折着时完全被盖住，展开到 0.25 才全部露出。
const UNDER_REVEAL = 0.25;

// 拖影层：先画刻得最深的那一层。
const TRAIL_LAGS = [0.12, 0.06];
const TRAIL_ALPHAS = [0.1, 0.22];

const FALLBACK_FOLDS = 6;

export const FOLD_OPTIONS = [4, 6, 8];
export const FOLD_LABELS = { 4: '四角', 6: '六角', 8: '八角' };
export const PALETTE = {
  paperBg: '#E9EBE8',
  paper: '#BE2428',
  inkFolded: '#D98B3F',
  inkCut: '#FFFFFF',
};

export function sectorAngle(folds) {
  return TAU / folds;
}

function signedAngle(angle) {
  let offset = angle % TAU;
  if (offset > Math.PI) offset -= TAU;
  if (offset <= -Math.PI) offset += TAU;
  return offset;
}

function offsetFromAxis(p) {
  return signedAngle(Math.atan2(p.y - CENTER.y, p.x - CENTER.x) - AXIS);
}

export function inSector(p, folds) {
  if (p.x === CENTER.x && p.y === CENTER.y) return true;
  return Math.abs(offsetFromAxis(p)) <= sectorAngle(folds) / 2 + EPS;
}

export function clampToSector(p, folds) {
  const vx = p.x - CENTER.x;
  const vy = p.y - CENTER.y;
  const radius = Math.min(Math.hypot(vx, vy), MAX_RADIUS);
  if (radius === 0) return { x: CENTER.x, y: CENTER.y };
  const half = sectorAngle(folds) / 2;
  const offset = offsetFromAxis(p);
  const edge = offset > half ? half : offset < -half ? -half : offset;
  const angle = AXIS + edge;
  return {
    x: CENTER.x + radius * Math.cos(angle),
    y: CENTER.y + radius * Math.sin(angle),
  };
}

export function expandMatrices(folds, mirror = true) {
  const delta = sectorAngle(folds);
  const axis = 2 * AXIS;
  const fx = Math.cos(axis);
  const fy = Math.sin(axis);
  const reflections = mirror ? [1, -1] : [1];
  const matrices = [];
  for (let k = 0; k < folds; k += 1) {
    const cos = Math.cos(k * delta);
    const sin = Math.sin(k * delta);
    for (const m of reflections) {
      const [l00, l01, l10, l11] = m === -1 ? [fx, fy, fy, -fx] : [1, 0, 0, 1];
      const a = cos * l00 - sin * l10;
      const b = sin * l00 + cos * l10;
      const c = cos * l01 - sin * l11;
      const d = sin * l01 + cos * l11;
      matrices.push({
        a,
        b,
        c,
        d,
        e: CENTER.x - (a * CENTER.x + c * CENTER.y),
        f: CENTER.y - (b * CENTER.x + d * CENTER.y),
        k,
        m,
      });
    }
  }
  return matrices;
}

export function toPathCommands(points) {
  if (!points || points.length === 0) return [];
  const { x: x0, y: y0 } = points[0];
  if (points.length === 1) return [{ op: 'M', x: x0, y: y0 }];
  const commands = [{ op: 'M', x: x0, y: y0 }];
  if (points.length === 2) {
    commands.push({ op: 'L', x: points[1].x, y: points[1].y });
    return commands;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const control = points[i];
    const next = points[i + 1];
    commands.push({
      op: 'Q',
      x: (control.x + next.x) / 2,
      y: (control.y + next.y) / 2,
      cx: control.x,
      cy: control.y,
    });
  }
  const last = points[points.length - 1];
  commands.push({ op: 'L', x: last.x, y: last.y });
  return commands;
}

function fixed(value) {
  const text = value.toFixed(5).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

export function toSvgPathD(commands) {
  const parts = [];
  for (const command of commands) {
    if (command.op === 'Q') {
      parts.push('Q ' + fixed(command.cx) + ' ' + fixed(command.cy) + ' ' + fixed(command.x) + ' ' + fixed(command.y));
    } else {
      parts.push(command.op + ' ' + fixed(command.x) + ' ' + fixed(command.y));
    }
  }
  return parts.join(' ');
}

// screen = design * scale + t：顶点居中于画布宽、落在 88% 高处，scale 取竖直/水平两个约束的较小值。
export function foldedCamera(folds, size) {
  const extent = Number(size) || 0;
  const half = sectorAngle(folds) / 2;
  const vertical = 2 * FOLD_REACH * extent;
  const horizontal = half > 0 && half < Math.PI / 2
    ? (FOLD_WIDTH_FILL * extent) / Math.sin(half)
    : vertical;
  const scale = Math.min(vertical, horizontal);
  return {
    scale,
    tx: extent / 2 - CENTER.x * scale,
    ty: FOLD_VERTEX_Y * extent - CENTER.y * scale,
  };
}

// 成品态相机：screen = design * size * DISK_INSET + size * (1 - DISK_INSET) / 2，即居中内缩。
// renderUnfold 的收尾相机与 renderFinal 必须共用它，否则动画最后一帧会跳一下再落到成品位置。
function finalCamera(size) {
  const scale = size * DISK_INSET;
  const offset = (size * (1 - DISK_INSET)) / 2;
  return { scale, tx: offset, ty: offset };
}

function clamp01(value) {
  const t = Number(value);
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function easeOutCubic(t) {
  const rest = 1 - t;
  return 1 - rest * rest * rest;
}

function lerpCamera(from, to, t) {
  return {
    scale: from.scale + (to.scale - from.scale) * t,
    tx: from.tx + (to.tx - from.tx) * t,
    ty: from.ty + (to.ty - from.ty) * t,
  };
}

function hexToRgb(hex) {
  const text = String(hex).replace('#', '');
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text;
  const value = parseInt(full, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

// 颜色插值：t=0 两端分别取 from / to。
function mixHex(from, to, t) {
  const k = clamp01(t);
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const r = Math.round(a.r + (b.r - a.r) * k);
  const g = Math.round(a.g + (b.g - a.g) * k);
  const bl = Math.round(a.b + (b.b - a.b) * k);
  return 'rgb(' + r + ', ' + g + ', ' + bl + ')';
}

// 笔迹金色→白色的分界：p < 0.65 一直是金色，最后 35% 才过渡到白色，动画前半段笔迹不发灰。
const INK_WHITE_START = 0.65;

function inkColor(progress) {
  return mixHex(PALETTE.inkFolded, PALETTE.inkCut, clamp01((progress - INK_WHITE_START) / (1 - INK_WHITE_START)));
}

// 每片纸的变换：Rot(k·Δ·progress)，镜像片再右乘 Reflect(θ0)；progress=0 时镜像片与原片重合。
function sectorMatrixArgs(k, m, delta, progress) {
  const angle = k * delta * progress;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const a = m === 1 ? cos : -cos;
  const b = m === 1 ? sin : -sin;
  const c = -sin;
  const d = cos;
  return [a, b, c, d, CENTER.x - (a * CENTER.x + c * CENTER.y), CENTER.y - (b * CENTER.x + d * CENTER.y)];
}

function fanSectors(folds, progress) {
  const delta = sectorAngle(folds);
  const sectors = [];
  for (let k = 0; k < folds; k += 1) {
    sectors.push({ m: 1, args: sectorMatrixArgs(k, 1, delta, progress) });
    sectors.push({ m: -1, args: sectorMatrixArgs(k, -1, delta, progress) });
  }
  return sectors;
}

// 只追加子路径，不 beginPath：n 片楔形攒成一条路径一次 fill。
function addWedgePath(ctx, folds) {
  const half = sectorAngle(folds) / 2;
  ctx.moveTo(CENTER.x, CENTER.y);
  ctx.arc(CENTER.x, CENTER.y, MAX_RADIUS, AXIS - half, AXIS + half);
  ctx.closePath();
}

function tracePath(ctx, commands) {
  for (const command of commands) {
    if (command.op === 'M') ctx.moveTo(command.x, command.y);
    else if (command.op === 'L') ctx.lineTo(command.x, command.y);
    else ctx.quadraticCurveTo(command.cx, command.cy, command.x, command.y);
  }
}

// closed=true：先用同一颜色把圈内整块填掉，再沿闭合路径描一圈。
// 填充让圈内塌成底色，描边让剪口边缘落在笔迹外沿、首尾接缝看不出来。
function paintStroke(ctx, commands, width, color, closed = false) {
  if (commands.length === 1) {
    ctx.beginPath();
    ctx.arc(commands[0].x, commands[0].y, width / 2, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  tracePath(ctx, commands);
  if (closed) {
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function paintBackground(ctx, size) {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = PALETTE.paperBg;
  ctx.fillRect(0, 0, size, size);
}

function resolveSize(ctx, opts) {
  if (Number.isFinite(opts.size) && opts.size > 0) return opts.size;
  const canvas = ctx.canvas;
  if (canvas && Number.isFinite(canvas.width) && canvas.width > 0) return canvas.width;
  return 0;
}

function resolveFolds(opts) {
  const folds = Number(opts.folds);
  return Number.isFinite(folds) && folds > 1 ? folds : FALLBACK_FOLDS;
}

// 剪刀笔迹在所有渲染态里都用底色画（把纸挖掉），不参与任何金→白插值。
function isCut(stroke) {
  return Boolean(stroke) && stroke.tool === 'cut';
}

// 闭环判定的容差：细笔吃 0.035 的下限，粗笔按笔宽放大，剪口外沿才不会留一截缝。
function closedGap(width) {
  return Math.max(0.035, width * 2.5);
}

// 闭环剪刀：首尾回到起点附近就整块挖掉，没绕回来的仍只挖一条带。
// 判定留在渲染层而不是 draw.js，正在画的那一笔因此也实时生效。
export function isClosedCut(stroke) {
  if (!isCut(stroke)) return false;
  const points = Array.isArray(stroke.points) ? stroke.points : [];
  if (points.length < 4) return false;
  const first = points[0];
  const last = points[points.length - 1];
  const width = Number(stroke.width);
  const gap = closedGap(Number.isFinite(width) ? width : 0);
  return Math.hypot(last.x - first.x, last.y - first.y) <= gap;
}

// 两遍画：先把所有 draw 按数组相对顺序画完，再把所有 cut 按数组相对顺序统一扣掉。
// 剪刀是最后才落的遮罩，不是按时序叠上去的一笔——纸被挖走以后，再画的线也落不回那块空地。
function paintStrokes(ctx, strokes, color) {
  for (const cutPass of [false, true]) {
    for (const stroke of strokes) {
      if (isCut(stroke) !== cutPass) continue;
      const commands = toPathCommands(stroke.points);
      if (commands.length === 0) continue;
      paintStroke(ctx, commands, stroke.width, cutPass ? PALETTE.paperBg : color, cutPass && isClosedCut(stroke));
    }
  }
}

// 展开中的一帧：纸只用 m=1 的 n 片楔形旋转 k·Δ·progress 拼成整圆，一次 fill 一次 clip。
// 镜像片（det=-1）作用在楔形这个形状上与 m=1 的那片逐点重合、绕向相反，
// 若一起进同一条路径，nonzero 规则下两块互相抵消成空，纸与裁切区都会是空的。
function paintFan(ctx, strokes, folds, progress, cam, options) {
  const sectors = fanSectors(folds, progress);
  const paper = sectors.filter((sector) => sector.m === 1);
  ctx.save();
  ctx.transform(cam.scale, 0, 0, cam.scale, cam.tx, cam.ty);
  ctx.globalAlpha = options.alpha;
  ctx.beginPath();
  for (const sector of paper) {
    ctx.save();
    ctx.transform(sector.args[0], sector.args[1], sector.args[2], sector.args[3], sector.args[4], sector.args[5]);
    addWedgePath(ctx, folds);
    ctx.restore();
  }
  ctx.fillStyle = PALETTE.paper;
  ctx.fill();
  ctx.clip();
  const under = Math.min(1, progress / UNDER_REVEAL);
  for (const sector of sectors) {
    const alpha = sector.m === 1 ? 1 : under;
    if (alpha < MIN_ALPHA) continue;
    ctx.save();
    ctx.globalAlpha = options.alpha * alpha;
    ctx.transform(sector.args[0], sector.args[1], sector.args[2], sector.args[3], sector.args[4], sector.args[5]);
    paintStrokes(ctx, strokes, options.ink);
    ctx.restore();
  }
  ctx.restore();
}

export function renderFolded(ctx, strokes, opts = {}) {
  const folds = resolveFolds(opts);
  const size = resolveSize(ctx, opts);
  const cam = opts.camera || foldedCamera(folds, size);
  ctx.save();
  paintBackground(ctx, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.transform(cam.scale, 0, 0, cam.scale, cam.tx, cam.ty);
  ctx.beginPath();
  addWedgePath(ctx, folds);
  ctx.fillStyle = PALETTE.paper;
  ctx.fill();
  ctx.clip();
  paintStrokes(ctx, strokes || [], PALETTE.inkFolded);
  ctx.restore();
}

export function renderUnfold(ctx, strokes, opts = {}, progress = 0) {
  const folds = resolveFolds(opts);
  const size = resolveSize(ctx, opts);
  const p = clamp01(progress);
  const from = opts.camera || foldedCamera(folds, size);
  const to = finalCamera(size);
  ctx.save();
  paintBackground(ctx, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < TRAIL_LAGS.length; i += 1) {
    const lag = p - TRAIL_LAGS[i];
    const alpha = TRAIL_ALPHAS[i] * (1 - p);
    if (lag < 0 || alpha <= MIN_ALPHA) continue;
    paintFan(ctx, strokes || [], folds, lag, lerpCamera(from, to, easeOutCubic(lag)), {
      alpha,
      ink: inkColor(lag),
    });
  }
  paintFan(ctx, strokes || [], folds, p, lerpCamera(from, to, easeOutCubic(p)), {
    alpha: 1,
    ink: inkColor(p),
  });
  ctx.restore();
}

export function renderFinal(ctx, strokes, opts = {}) {
  const folds = resolveFolds(opts);
  const size = resolveSize(ctx, opts);
  const cam = finalCamera(size);
  const matrices = expandMatrices(folds, true);
  ctx.save();
  paintBackground(ctx, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.transform(cam.scale, 0, 0, cam.scale, cam.tx, cam.ty);
  ctx.beginPath();
  ctx.arc(CENTER.x, CENTER.y, MAX_RADIUS, 0, TAU);
  ctx.fillStyle = PALETTE.paper;
  ctx.fill();
  ctx.clip();
  for (const matrix of matrices) {
    ctx.save();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    paintStrokes(ctx, strokes || [], PALETTE.inkCut);
    ctx.restore();
  }
  ctx.restore();
}
