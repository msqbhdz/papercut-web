import {
  clampToSector,
  foldedCamera,
  renderFinal,
  renderFolded,
  renderUnfold,
  sectorAngle,
} from './symmetry.v2.js';

const MIN_POINT_DISTANCE = 0.0015;
const MAX_UNDO_DEPTH = 100;
const UNFOLD_MS = 900;
const MIN_WIDTH = 0.004;
const MAX_WIDTH = 0.02;
const DEFAULT_FOLDS = 6;
const DEFAULT_WIDTH = 0.008;
const TAU = Math.PI * 2;
// 归一化圆心与「正上方」径向：canvas 的 y 轴向下，所以正上方是 -π/2。
const CENTER = { x: 0.5, y: 0.5 };
const AXIS = -Math.PI / 2;
const MAX_RADIUS = 0.5;

function shortestOffset(angle) {
  let offset = angle % TAU;
  if (offset > Math.PI) offset -= TAU;
  if (offset <= -Math.PI) offset += TAU;
  return offset;
}

function remapPoint(point, oldFolds, newFolds) {
  const radius = Math.min(Math.hypot(point.x - CENTER.x, point.y - CENTER.y), MAX_RADIUS);
  if (radius === 0) return { x: CENTER.x, y: CENTER.y };
  const offset = shortestOffset(Math.atan2(point.y - CENTER.y, point.x - CENTER.x) - AXIS);
  const half = sectorAngle(newFolds) / 2;
  // 偏差角按扇区角等比缩放：扇区边界正好映射到边界，因此可逆、来回切换不漂移。
  const scaled = offset * (sectorAngle(newFolds) / sectorAngle(oldFolds));
  const angle = AXIS + (scaled > half ? half : scaled < -half ? -half : scaled);
  return {
    x: CENTER.x + radius * Math.cos(angle),
    y: CENTER.y + radius * Math.sin(angle),
  };
}

function remapPoints(points, oldFolds, newFolds) {
  return points.map((point) => remapPoint(point, oldFolds, newFolds));
}

function remapStrokes(list, oldFolds, newFolds) {
  return list.map((stroke) => ({
    color: stroke.color,
    width: stroke.width,
    points: remapPoints(stroke.points, oldFolds, newFolds),
  }));
}

// 仅为临时测试脚本暴露纯数学入口，不属于 Board 对外 API。
export const __remapPointsForTest = remapPoints;

function easeOutCubic(t) {
  const rest = 1 - t;
  return 1 - rest * rest * rest;
}

function normalizeFolds(value) {
  const folds = Math.round(Number(value));
  return Number.isFinite(folds) && folds > 1 ? folds : DEFAULT_FOLDS;
}

function clampWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH);
}

export function createBoard(canvas, opts = {}) {
  const {
    folds: initialFolds = DEFAULT_FOLDS,
    width: initialWidth = DEFAULT_WIDTH,
    onChange = null,
  } = opts;

  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const hasRaf = typeof globalThis.requestAnimationFrame === 'function';
  const requestFrame = hasRaf
    ? (fn) => globalThis.requestAnimationFrame(fn)
    : (fn) => setTimeout(fn, 16);
  const cancelFrame = hasRaf
    ? (id) => globalThis.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);
  const clock = typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

  let folds = normalizeFolds(initialFolds);
  let strokeWidth = clampWidth(initialWidth);
  let mode = 'folded';
  let progress = 0;

  // 快照式历史：每次提交产生一个不可变笔迹数组，undo/redo 两栈互相搬运快照本身。
  let strokes = [];
  const undoStack = [];
  const redoStack = [];

  let activePointer = null;
  let liveStroke = null;

  let observer = null;

  let dirty = false;
  let framePending = false;
  let frameId = 0;
  let animId = 0;
  let animStart = 0;
  let destroyed = false;

  function emit() {
    const handler = board.onStateChange;
    if (typeof handler === 'function') handler();
  }

  function cloneStrokes(list) {
    return list.map((stroke) => ({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
    }));
  }

  // 画布按 CSS 像素正方向布局；渲染器自己 save/restore 并叠加相机，所以这里只负责把基准变换设成 DPR。
  function cssSide() {
    if (typeof canvas.getBoundingClientRect !== 'function') return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.min(rect.width, rect.height);
  }

  function paint() {
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    let size = cssSide();
    if (!(size > 0)) size = canvas.width / dpr;
    if (!(size > 0)) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const list = liveStroke ? [...strokes, liveStroke] : strokes;
    if (mode === 'final') {
      renderFinal(ctx, list, { folds, size });
      return;
    }
    const camera = foldedCamera(folds, size);
    if (mode === 'unfolding') renderUnfold(ctx, list, { folds, size, camera }, progress);
    else renderFolded(ctx, list, { folds, size, camera });
  }

  function markDirty() {
    dirty = true;
    if (framePending || destroyed) return;
    framePending = true;
    frameId = requestFrame(runFrame);
  }

  function runFrame() {
    framePending = false;
    frameId = 0;
    if (!dirty) return;
    dirty = false;
    paint();
  }

  function dropFrame() {
    if (!framePending) return;
    cancelFrame(frameId);
    framePending = false;
    frameId = 0;
  }

  function cancelAnim() {
    if (!animId) return;
    cancelFrame(animId);
    animId = 0;
  }

  function render() {
    if (destroyed) return;
    dropFrame();
    dirty = false;
    paint();
  }

  function resize() {
    if (destroyed) return false;
    if (typeof canvas.getBoundingClientRect !== 'function') return false;
    const rect = canvas.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (!(size >= 1)) return false;
    const dpr = globalThis.devicePixelRatio || 1;
    const side = Math.max(1, Math.round(size * dpr));
    if (canvas.width === side && canvas.height === side) return false;
    // 改写 backing store 会清空画布，因此立刻补一帧，避免出现空白闪烁。
    canvas.width = side;
    canvas.height = side;
    dropFrame();
    dirty = false;
    paint();
    return true;
  }

  function commit(next) {
    undoStack.push(strokes);
    if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
    strokes = next;
    redoStack.length = 0;
    markDirty();
    emit();
  }

  function releaseCapture(pointerId) {
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {
      // 指针已失效或捕获已由浏览器隐式释放。
    }
  }

  function abortActive() {
    const pointerId = activePointer;
    activePointer = null;
    liveStroke = null;
    if (pointerId === null) return;
    releaseCapture(pointerId);
  }

  function finishStroke() {
    const stroke = liveStroke;
    const pointerId = activePointer;
    activePointer = null;
    liveStroke = null;
    if (pointerId !== null) releaseCapture(pointerId);
    if (!stroke || stroke.points.length === 0) return;
    commit([...strokes, stroke]);
  }

  // 屏幕坐标 → 折叠态相机逆变换 → 归一化设计坐标 → 夹进扇区。
  function designFrom(event) {
    if (typeof canvas.getBoundingClientRect !== 'function') return null;
    const rect = canvas.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (!(size > 0)) return null;
    const camera = foldedCamera(folds, size);
    if (!(camera.scale > 0)) return null;
    const x = (event.clientX - rect.left - camera.tx) / camera.scale;
    const y = (event.clientY - rect.top - camera.ty) / camera.scale;
    return clampToSector({ x, y }, folds);
  }

  function handlePointerDown(event) {
    if (destroyed || mode !== 'folded' || activePointer !== null) return;
    const point = designFrom(event);
    if (!point) return;
    activePointer = event.pointerId;
    liveStroke = { width: strokeWidth, points: [point] };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时仍按 pointerId 追踪，事件落在 canvas 上的部分照常工作。
    }
    markDirty();
  }

  function handlePointerMove(event) {
    if (mode !== 'folded' || event.pointerId !== activePointer || !liveStroke) return;
    const point = designFrom(event);
    if (!point) return;
    const last = liveStroke.points[liveStroke.points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE) return;
    liveStroke.points.push(point);
    markDirty();
  }

  function handlePointerEnd(event) {
    if (event.pointerId !== activePointer) return;
    finishStroke();
  }

  // 历史快照与当前 strokes 共享旧扇区坐标，逐条换成新对象（条目数与顺序不变）。
  function remapStack(stack, oldFolds, newFolds) {
    for (let i = 0; i < stack.length; i += 1) {
      stack[i] = remapStrokes(stack[i], oldFolds, newFolds);
    }
  }

  function setFold(next) {
    if (destroyed || mode !== 'folded') return;
    const target = normalizeFolds(next);
    if (target === folds) return;
    // 正在画的一笔按旧扇区采点，不能参与重映射，直接丢弃。
    abortActive();
    strokes = remapStrokes(strokes, folds, target);
    remapStack(undoStack, folds, target);
    remapStack(redoStack, folds, target);
    folds = target;
    markDirty();
    emit();
  }

  function setWidth(next) {
    const value = clampWidth(next);
    if (value === strokeWidth) return;
    strokeWidth = value;
    emit();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    markDirty();
    emit();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(strokes);
    if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
    strokes = redoStack.pop();
    markDirty();
    emit();
  }

  function clear() {
    if (strokes.length === 0) return;
    commit([]);
  }

  function getStrokes() {
    return cloneStrokes(strokes);
  }

  function loadStrokes(list) {
    abortActive();
    strokes = Array.isArray(list) ? cloneStrokes(list) : [];
    redoStack.length = 0;
    markDirty();
    emit();
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  function getMode() {
    return mode;
  }

  function exportSpec() {
    return { strokes: getStrokes(), folds };
  }

  // 展开动画：progress 用 easeOutCubic 从 0 推到 1，收尾切 final 并只 emit 一次。
  function stepUnfold() {
    animId = 0;
    if (destroyed || mode !== 'unfolding') return;
    const elapsed = clock() - animStart;
    const t = elapsed / UNFOLD_MS;
    if (t >= 1) {
      progress = 1;
      mode = 'final';
      dirty = false;
      paint();
      emit();
      return;
    }
    progress = easeOutCubic(t > 0 ? t : 0);
    dirty = false;
    paint();
    animId = requestFrame(stepUnfold);
  }

  function finish() {
    if (destroyed || mode !== 'folded') return false;
    abortActive();
    if (strokes.length === 0) return false;
    dropFrame();
    mode = 'unfolding';
    progress = 0;
    dirty = false;
    emit();
    paint();
    animStart = clock();
    cancelAnim();
    animId = requestFrame(stepUnfold);
    return true;
  }

  function restart() {
    if (destroyed) return;
    cancelAnim();
    abortActive();
    mode = 'folded';
    progress = 0;
    markDirty();
    emit();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dropFrame();
    cancelAnim();
    dirty = false;
    abortActive();
    if (observer) observer.disconnect();
    observer = null;
    globalThis.removeEventListener('resize', resize);
    globalThis.removeEventListener('pointerup', handlePointerEnd, true);
    globalThis.removeEventListener('pointercancel', handlePointerEnd, true);
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', handlePointerEnd);
    canvas.removeEventListener('pointercancel', handlePointerEnd);
    canvas.removeEventListener('lostpointercapture', handlePointerEnd);
  }

  const board = {
    onStateChange: typeof onChange === 'function' ? onChange : null,
    setFold,
    setWidth,
    undo,
    redo,
    clear,
    canUndo,
    canRedo,
    getStrokes,
    loadStrokes,
    getMode,
    finish,
    restart,
    exportSpec,
    render,
    destroy,
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerEnd);
  canvas.addEventListener('pointercancel', handlePointerEnd);
  canvas.addEventListener('lostpointercapture', handlePointerEnd);
  // 捕获失败或事件被系统接管时 pointerup 落不到 canvas 上，window 兜底释放 activePointer，防止画板永久锁死。
  globalThis.addEventListener('pointerup', handlePointerEnd, true);
  globalThis.addEventListener('pointercancel', handlePointerEnd, true);
  // 缩放/切换屏幕只改 devicePixelRatio 而不改容器尺寸，ResizeObserver 不会触发。
  globalThis.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas.parentElement || canvas);
  }

  if (!resize()) markDirty();

  return board;
}
