import {
  DISK_INSET,
  PALETTE,
  expandMatrices,
  renderFinal,
  toPathCommands,
  toSvgPathD,
} from './symmetry.v2.js';

const DEFAULT_PNG_SIZE = 2048;
const DEFAULT_SVG_SIZE = 1024;
const MIN_SIZE = 1;
const MAX_SIZE = 4096;
const DEFAULT_FOLDS = 6;
// 固定 id：buildSVG 必须是纯函数，同入参两次输出要全等，故不能带自增计数器。
const CLIP_ID = 'papercut-disk';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  // 抹掉 -0，避免 d 里出现 "-0"。
  return rounded === 0 ? 0 : rounded;
}

function clampSize(size, fallback) {
  const value = Math.round(Number(size));
  return Number.isFinite(value) ? clamp(value, MIN_SIZE, MAX_SIZE) : fallback;
}

function normalizeFolds(folds) {
  const value = Math.round(Number(folds));
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_FOLDS;
}

function resolveSpec({ strokes, folds, size } = {}, fallbackSize) {
  return {
    strokes: Array.isArray(strokes) ? strokes : [],
    folds: normalizeFolds(folds),
    size: clampSize(size === undefined || size === null ? fallbackSize : size, fallbackSize),
  };
}

// 成品态相机，与 renderFinal 的 finalCamera 完全等价：screen = design * size * DISK_INSET + size * (1 - DISK_INSET) / 2。
function diskCamera(size) {
  const scale = size * DISK_INSET;
  return { size, scale, offset: (size - scale) / 2 };
}

// 与 PNG 同一套矩阵与同一套相机：先过展开矩阵，再按 diskCamera 缩放到像素。
// 坐标收进 [0, size] 只为抹掉浮点毛刺（红盘外的一切最终由 clipPath / renderFinal 裁掉）。
function projectCommand(command, matrix, camera) {
  const { size, scale, offset } = camera;
  const px = (x, y) => ({
    x: clamp(round2((matrix.a * x + matrix.c * y + matrix.e) * scale + offset), 0, size),
    y: clamp(round2((matrix.b * x + matrix.d * y + matrix.f) * scale + offset), 0, size),
  });
  const point = px(command.x, command.y);
  if (command.op !== 'Q') return { op: command.op, x: point.x, y: point.y };
  const control = px(command.cx, command.cy);
  return { op: 'Q', x: point.x, y: point.y, cx: control.x, cy: control.y };
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${day}-${clock}`;
}

function fileName(folds, extension) {
  return `papercut-${folds}fold-${stamp(new Date())}.${extension}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // iOS Safari 在 click 同步返回后立即 revoke 会取消掉待开始的下载，故延后一拍释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

export function buildSVG({ strokes, folds, size } = {}) {
  const spec = resolveSpec({ strokes, folds, size }, DEFAULT_SVG_SIZE);
  const { size: side } = spec;
  const half = side / 2;
  const camera = diskCamera(side);
  // 红盘半径 = 0.5 设计半径 × 0.94 = 0.47 × size；clipPath 与红盘必须是同一个圆。
  const diskRadius = round2((DISK_INSET * side) / 2);
  const matrices = expandMatrices(spec.folds, true);
  const cut = PALETTE.inkCut;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">`,
    `<defs><clipPath id="${CLIP_ID}"><circle cx="${half}" cy="${half}" r="${diskRadius}"/></clipPath></defs>`,
    `<rect x="0" y="0" width="${side}" height="${side}" fill="${PALETTE.paperBg}"/>`,
    `<circle cx="${half}" cy="${half}" r="${diskRadius}" fill="${PALETTE.paper}"/>`,
    `<g clip-path="url(#${CLIP_ID})">`,
  ];
  for (const stroke of spec.strokes) {
    const commands = toPathCommands(stroke?.points ?? []);
    if (commands.length === 0) continue;
    if (commands.length === 1) {
      // 单点的实心圆同样跟着内缩，半径 = width/2 × size × 0.94。
      const radius = clamp(round2(((stroke.width ?? 0) * side * DISK_INSET) / 2), 0, side);
      for (const matrix of matrices) {
        const dot = projectCommand(commands[0], matrix, camera);
        parts.push(`<circle cx="${dot.x}" cy="${dot.y}" r="${radius}" fill="${cut}"/>`);
      }
      continue;
    }
    // 笔宽与屏幕同源：canvas 里同样由相机缩放，故一并乘 DISK_INSET。
    const width = clamp(round2((stroke.width ?? 0) * side * DISK_INSET), 0, side);
    const attrs = `fill="none" stroke="${cut}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
    for (const matrix of matrices) {
      const d = toSvgPathD(commands.map((command) => projectCommand(command, matrix, camera)));
      parts.push(`<path ${attrs} d="${d}"/>`);
    }
  }
  parts.push('</g>', '</svg>');
  return parts.join('\n');
}

export async function exportPNG({ strokes, folds, size = DEFAULT_PNG_SIZE } = {}) {
  const spec = resolveSpec({ strokes, folds, size }, DEFAULT_PNG_SIZE);
  const canvas = document.createElement('canvas');
  canvas.width = spec.size;
  canvas.height = spec.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  // renderFinal 自己清屏、铺米白底并画红盘，这里不再重复铺底。
  renderFinal(ctx, spec.strokes, { folds: spec.folds, size: spec.size });
  const blob = await canvasToBlob(canvas);
  download(blob, fileName(spec.folds, 'png'));
}

export function exportSVG({ strokes, folds, size = DEFAULT_SVG_SIZE } = {}) {
  const spec = resolveSpec({ strokes, folds, size }, DEFAULT_SVG_SIZE);
  const svg = buildSVG(spec);
  download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), fileName(spec.folds, 'svg'));
}
