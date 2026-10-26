import { createBoard } from './draw.js';
import { exportPNG, exportSVG } from './export.js';

const MIN_WIDTH = 0.004;
const MAX_WIDTH = 0.02;
const DEFAULT_FOLDS = 8;
const DEFAULT_COLOR = '#c8102e';
const PNG_SIZE = 2048;
const SVG_SIZE = 1024;
const TOAST_MS = 2200;

const canvas = document.querySelector('#board');
const foldGroup = document.querySelector('#foldGroup');
const undoButton = document.querySelector('#undo');
const redoButton = document.querySelector('#redo');
const clearButton = document.querySelector('#clear');
const mirrorButton = document.querySelector('#mirror');
const colorBar = document.querySelector('#colors');
const brushSlider = document.querySelector('#brushSize');
const pngButton = document.querySelector('#exportPng');
const svgButton = document.querySelector('#exportSvg');
const hint = document.querySelector('#hint');
const toast = document.querySelector('#toast');
const installButton = document.querySelector('#install');

const state = { folds: DEFAULT_FOLDS, color: DEFAULT_COLOR, mirror: true };

let board = null;
let toastTimer = 0;
let installPrompt = null;

function brushWidth(sliderValue) {
  const ratio = Math.min(Math.max(Number(sliderValue), 0), 100) / 100;
  return Math.round((MIN_WIDTH + ratio * (MAX_WIDTH - MIN_WIDTH)) * 1e4) / 1e4;
}

function syncHistory() {
  // createBoard 可能在构造期间就回调一次状态变更，此时 board 还没赋值
  if (!board) return;
  undoButton.disabled = !board.canUndo();
  redoButton.disabled = !board.canRedo();
  clearButton.disabled = !board.canUndo();
}

function selectFold(folds) {
  state.folds = folds;
  for (const button of foldGroup.querySelectorAll('[data-fold]')) {
    const active = Number(button.dataset.fold) === folds;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  board.setFold(folds);
}

function selectColor(swatch) {
  state.color = swatch.dataset.color;
  for (const item of colorBar.querySelectorAll('.swatch')) {
    const active = item === swatch;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
  }
  board.setColor(state.color);
}

function toggleMirror() {
  state.mirror = !state.mirror;
  mirrorButton.setAttribute('aria-pressed', String(state.mirror));
  board.setMirror(state.mirror);
  syncHistory();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-on'), TOAST_MS);
}

function fadeHint() {
  hint.classList.add('is-gone');
  hint.setAttribute('aria-hidden', 'true');
}

function collectStrokes() {
  const strokes = board.getStrokes();
  if (strokes.length > 0) return strokes;
  showToast('先画几笔再导出');
  return null;
}

async function handleExportPng() {
  const strokes = collectStrokes();
  if (!strokes) return;
  pngButton.disabled = true;
  try {
    await exportPNG({ strokes, folds: state.folds, mirror: state.mirror, size: PNG_SIZE });
    showToast('PNG 已保存');
  } catch {
    showToast('PNG 导出失败，请再试一次');
  } finally {
    pngButton.disabled = false;
  }
}

function handleExportSvg() {
  const strokes = collectStrokes();
  if (!strokes) return;
  try {
    exportSVG({ strokes, folds: state.folds, mirror: state.mirror, size: SVG_SIZE });
    showToast('SVG 已保存');
  } catch {
    showToast('SVG 导出失败，请再试一次');
  }
}

function handleShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) board.redo();
    else board.undo();
    syncHistory();
  } else if (key === 'y') {
    event.preventDefault();
    board.redo();
    syncHistory();
  }
}

function registerServiceWorker() {
  if (!/^https?:$/.test(location.protocol)) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      showToast('离线缓存未启用');
    });
  });
}

board = createBoard(canvas, {
  folds: state.folds,
  color: state.color,
  width: brushWidth(brushSlider.value),
  mirror: state.mirror,
  onChange: syncHistory
});
board.onStateChange = syncHistory;

foldGroup.addEventListener('click', (event) => {
  const button = event.target.closest('[data-fold]');
  if (button) selectFold(Number(button.dataset.fold));
});

colorBar.addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (swatch) selectColor(swatch);
});

mirrorButton.addEventListener('click', toggleMirror);

brushSlider.addEventListener('input', () => {
  board.setWidth(brushWidth(brushSlider.value));
});

undoButton.addEventListener('click', () => {
  board.undo();
  syncHistory();
});

redoButton.addEventListener('click', () => {
  board.redo();
  syncHistory();
});

clearButton.addEventListener('click', () => {
  board.clear();
  syncHistory();
});

pngButton.addEventListener('click', handleExportPng);
svgButton.addEventListener('click', handleExportSvg);

canvas.addEventListener('pointerdown', fadeHint, { once: true, passive: true });
window.addEventListener('keydown', handleShortcut);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener('click', () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  installButton.hidden = true;
  prompt.prompt();
  prompt.userChoice.catch(() => {});
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
  showToast('已添加到桌面');
});

syncHistory();
registerServiceWorker();
window.__papercutBooted = true;
