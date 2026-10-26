const TAU = Math.PI * 2;
const CENTER = { x: 0.5, y: 0.5 };
const MAX_RADIUS = 0.5;
// canvas 的 y 轴向下，正上方因此是 -π/2。
const AXIS = -Math.PI / 2;
const EPS = 1e-9;

const GUIDE_DASH = [0.02, 0.014];
const GUIDE_WIDTH = 0.004;
const GUIDE_DOT_RADIUS = 0.008;
const GUIDE_COLOR = 'rgba(0, 0, 0, 0.28)';

export const FOLD_OPTIONS = [2, 4, 8, 12];

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
      parts.push(`Q ${fixed(command.cx)} ${fixed(command.cy)} ${fixed(command.x)} ${fixed(command.y)}`);
    } else {
      parts.push(`${command.op} ${fixed(command.x)} ${fixed(command.y)}`);
    }
  }
  return parts.join(' ');
}

function tracePath(ctx, commands) {
  for (const command of commands) {
    if (command.op === 'M') ctx.moveTo(command.x, command.y);
    else if (command.op === 'L') ctx.lineTo(command.x, command.y);
    else ctx.quadraticCurveTo(command.cx, command.cy, command.x, command.y);
  }
}

function drawSectorGuides(ctx, folds) {
  const half = sectorAngle(folds) / 2;
  const from = AXIS - half;
  const to = AXIS + half;
  ctx.save();
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.fillStyle = GUIDE_COLOR;
  ctx.lineWidth = GUIDE_WIDTH;
  ctx.setLineDash(GUIDE_DASH);
  ctx.beginPath();
  ctx.moveTo(CENTER.x, CENTER.y);
  ctx.lineTo(CENTER.x + MAX_RADIUS * Math.cos(from), CENTER.y + MAX_RADIUS * Math.sin(from));
  ctx.moveTo(CENTER.x, CENTER.y);
  ctx.lineTo(CENTER.x + MAX_RADIUS * Math.cos(to), CENTER.y + MAX_RADIUS * Math.sin(to));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(CENTER.x, CENTER.y, MAX_RADIUS, from, to);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(CENTER.x, CENTER.y, GUIDE_DOT_RADIUS, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export function renderDesign(ctx, strokes, opts = {}) {
  const { folds, size, mirror = true, drawGuides = false } = opts;
  const matrices = expandMatrices(folds, mirror);
  ctx.save();
  ctx.setTransform(size, 0, 0, size, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes || []) {
    const commands = toPathCommands(stroke.points);
    if (commands.length === 0) continue;
    for (const matrix of matrices) {
      ctx.save();
      ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      if (commands.length === 1) {
        ctx.beginPath();
        ctx.arc(commands[0].x, commands[0].y, stroke.width / 2, 0, TAU);
        ctx.fill();
      } else {
        ctx.lineWidth = stroke.width;
        ctx.beginPath();
        tracePath(ctx, commands);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  if (drawGuides) drawSectorGuides(ctx, folds);
  ctx.restore();
}
