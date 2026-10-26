import { expandMatrices, renderDesign, toPathCommands, toSvgPathD } from './symmetry.js';

const DEFAULT_SIZE = 2048;
const MAX_SIZE = 4096;
const PAPER_COLOR = '#ffffff';

function normalizeSize(size) {
  const value = Math.round(Number(size));
  if (!Number.isFinite(value)) return DEFAULT_SIZE;
  return Math.min(Math.max(value, 1), MAX_SIZE);
}

function resolveOptions(opts) {
  const { strokes = [], folds = 8, mirror = true, size = DEFAULT_SIZE } = opts ?? {};
  return {
    strokes: Array.isArray(strokes) ? strokes : [],
    folds,
    mirror,
    size: normalizeSize(size)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function project(command, matrix, size) {
  const out = {
    op: command.op,
    x: round((matrix.a * command.x + matrix.c * command.y + matrix.e) * size),
    y: round((matrix.b * command.x + matrix.d * command.y + matrix.f) * size)
  };
  if (command.op === 'Q') {
    out.cx = round((matrix.a * command.cx + matrix.c * command.cy + matrix.e) * size);
    out.cy = round((matrix.b * command.cx + matrix.d * command.cy + matrix.f) * size);
  }
  return out;
}

function fileName(extension, folds) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const clock = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `papercut-${folds}fold-${day}-${clock}.${extension}`;
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
  // iOS Safari 在 click 同步返回后立刻 revoke 会取消掉待开始的下载，故延后一拍释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

export function renderToCanvas(opts) {
  const { strokes, folds, mirror, size } = resolveOptions(opts);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, size, size);
  renderDesign(ctx, strokes, { folds, size, mirror, drawGuides: false });
  return canvas;
}

export async function exportPNG(opts) {
  const { strokes, folds, mirror, size } = resolveOptions(opts);
  const canvas = renderToCanvas({ strokes, folds, mirror, size });
  const blob = await toBlob(canvas);
  download(blob, fileName('png', folds));
}

export function buildSVG(opts) {
  const { strokes, folds, mirror, size } = resolveOptions(opts);
  const matrices = expandMatrices(folds, mirror);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect x="0" y="0" width="${size}" height="${size}" fill="${PAPER_COLOR}"/>`
  ];
  for (const stroke of strokes) {
    const commands = toPathCommands(stroke.points ?? []);
    if (commands.length === 0) continue;
    const strokeWidth = round(stroke.width * size);
    if (commands.length === 1) {
      const radius = round(strokeWidth / 2);
      for (const matrix of matrices) {
        const dot = project(commands[0], matrix, size);
        lines.push(`<circle cx="${dot.x}" cy="${dot.y}" r="${radius}" fill="${stroke.color}"/>`);
      }
      continue;
    }
    const attrs = `fill="none" stroke="${stroke.color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
    for (const matrix of matrices) {
      const d = toSvgPathD(commands.map((command) => project(command, matrix, size)));
      lines.push(`<path ${attrs} d="${d}"/>`);
    }
  }
  lines.push('</svg>');
  return lines.join('\n');
}

export function exportSVG(opts) {
  const { folds } = resolveOptions(opts);
  const svg = buildSVG(opts);
  download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), fileName('svg', folds));
}
