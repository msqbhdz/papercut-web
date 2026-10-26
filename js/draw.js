import { clampToSector, renderDesign, sectorAngle } from './symmetry.js';

const MIN_POINT_DISTANCE = 0.0015;
const MAX_UNDO_DEPTH = 100;
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

export function createBoard(canvas, opts = {}) {
  const {
    folds: initialFolds = 8,
    color: initialColor = '#c8102e',
    width: initialWidth = 0.008,
    mirror: initialMirror = true,
    paperColor = '#ffffff',
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

  let folds = initialFolds;
  let strokeColor = initialColor;
  let strokeWidth = initialWidth;
  let mirror = initialMirror;

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

  function paint() {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    ctx.fillStyle = paperColor;
    ctx.fillRect(0, 0, w, h);
    renderDesign(ctx, liveStroke ? [...strokes, liveStroke] : strokes, {
      folds,
      size: Math.min(w, h),
      mirror,
      drawGuides: true,
    });
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

  function render() {
    if (destroyed) return;
    if (framePending) {
      cancelFrame(frameId);
      framePending = false;
      frameId = 0;
    }
    dirty = false;
    paint();
  }

  function resize() {
    if (destroyed) return false;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);
    if (cssWidth < 1 || cssHeight < 1) return false;
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width === width && canvas.height === height) return false;
    // 改写 backing store 会清空画布，因此立刻补一帧，避免出现空白闪烁。
    canvas.width = width;
    canvas.height = height;
    if (framePending) {
      cancelFrame(frameId);
      framePending = false;
      frameId = 0;
    }
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

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function handlePointerDown(event) {
    if (destroyed || activePointer !== null) return;
    const raw = pointFrom(event);
    if (!raw) return;
    activePointer = event.pointerId;
    liveStroke = {
      color: strokeColor,
      width: strokeWidth,
      points: [clampToSector(raw, folds)],
    };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败时仍按 pointerId 追踪，事件落在 canvas 上的部分照常工作。
    }
    markDirty();
  }

  function handlePointerMove(event) {
    if (event.pointerId !== activePointer || !liveStroke) return;
    const raw = pointFrom(event);
    if (!raw) return;
    const point = clampToSector(raw, folds);
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
    if (next === folds) return;
    // 正在画的一笔按旧扇区采点，不能参与重映射，直接丢弃。
    abortActive();
    strokes = remapStrokes(strokes, folds, next);
    remapStack(undoStack, folds, next);
    remapStack(redoStack, folds, next);
    folds = next;
    markDirty();
    emit();
  }

  function setColor(next) {
    if (next === strokeColor) return;
    strokeColor = next;
    emit();
  }

  function setWidth(next) {
    if (next === strokeWidth) return;
    strokeWidth = next;
    emit();
  }

  function setMirror(next) {
    const value = Boolean(next);
    if (value === mirror) return;
    mirror = value;
    markDirty();
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

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (framePending) {
      cancelFrame(frameId);
      framePending = false;
      frameId = 0;
    }
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
    setColor,
    setWidth,
    setMirror,
    undo,
    redo,
    clear,
    getStrokes,
    loadStrokes,
    canUndo,
    canRedo,
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
