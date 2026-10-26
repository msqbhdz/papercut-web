import { createBoard } from './draw.v3.js';
import { exportPNG, exportSVG } from './export.v3.js';

const MIN_WIDTH = 0.004;
const MAX_WIDTH = 0.02;
const DEFAULT_FOLDS = 6;
const PNG_SIZE = 2048;
const SVG_SIZE = 1024;
const TOAST_MS = 2200;

const canvas = document.querySelector('#board');
const foldGroup = document.querySelector('#foldGroup');
const brushSlider = document.querySelector('#brushSize');
const undoButton = document.querySelector('#undo');
const redoButton = document.querySelector('#redo');
const clearButton = document.querySelector('#clear');
const finishButton = document.querySelector('#finish');
const restartButton = document.querySelector('#restart');
const pngButton = document.querySelector('#exportPng');
const svgButton = document.querySelector('#exportSvg');
const hint = document.querySelector('#hint');
const toast = document.querySelector('#toast');
const installButton = document.querySelector('#install');

const foldButtons = foldGroup ? Array.from(foldGroup.querySelectorAll('[data-fold]')) : [];
const state = { folds: DEFAULT_FOLDS, mode: 'folded' };

let board = null;
let toastTimer = 0;
let installPrompt = null;

function brushWidth(sliderValue) {
  const ratio = Math.min(Math.max(Number(sliderValue), 0), 100) / 100;
  return Math.round((MIN_WIDTH + ratio * (MAX_WIDTH - MIN_WIDTH)) * 1e4) / 1e4;
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

// 唯一的状态出口：mode 驱动两组控件的显隐，历史栈驱动按钮禁用。
function syncUI() {
  if (!board) return;
  const mode = board.getMode();
  const folded = mode === 'folded';
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const button of foldButtons) {
    const active = Number(button.dataset.fold) === state.folds;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = !folded;
  }
  brushSlider.disabled = !folded;
  undoButton.disabled = !board.canUndo();
  redoButton.disabled = !board.canRedo();
  clearButton.disabled = !board.canUndo();
  finishButton.disabled = board.getStrokes().length === 0;
}

function selectFold(folds) {
  if (!board || state.mode !== 'folded') return;
  state.folds = folds;
  board.setFold(folds);
  syncUI();
}

function handleFinish() {
  if (!board) return;
  if (!board.finish()) {
    showToast('先画几笔再完成');
    return;
  }
  fadeHint();
}

function handleRestart() {
  if (!board) return;
  board.restart();
  showToast('笔迹已保留，继续画');
}

async function handleExportPng() {
  const spec = board.exportSpec();
  if (spec.strokes.length === 0) {
    showToast('还没有笔迹可以保存');
    return;
  }
  pngButton.disabled = true;
  try {
    await exportPNG({ strokes: spec.strokes, folds: spec.folds, size: PNG_SIZE });
    showToast('PNG 已保存');
  } catch {
    showToast('PNG 导出失败，请再试一次');
  } finally {
    pngButton.disabled = false;
  }
}

function handleExportSvg() {
  const spec = board.exportSpec();
  if (spec.strokes.length === 0) {
    showToast('还没有笔迹可以保存');
    return;
  }
  try {
    exportSVG({ strokes: spec.strokes, folds: spec.folds, size: SVG_SIZE });
    showToast('SVG 已保存');
  } catch {
    showToast('SVG 导出失败，请再试一次');
  }
}

function handleShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (!board || state.mode !== 'folded') return;
  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) board.redo();
    else board.undo();
    syncUI();
  } else if (key === 'y') {
    event.preventDefault();
    board.redo();
    syncUI();
  }
}

function registerServiceWorker() {
  if (!/^https?:$/.test(location.protocol)) return;
  if (!('serviceWorker' in navigator)) return;
  // 旧版 Service Worker 会把旧页面钉在缓存里。新 SW 接管（controllerchange）后自动重载一次，
  // 用户不必自己清缓存；用一个标记防止来回刷新。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    let reloaded = false;
    try {
      reloaded = window.sessionStorage.getItem('papercut_sw_reload') === '1';
      window.sessionStorage.setItem('papercut_sw_reload', '1');
    } catch (error) {
      reloaded = true;
    }
    if (reloaded) return;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.v4.js').catch(() => {
      showToast('离线缓存未启用');
    });
  });
}

board = createBoard(canvas, {
  folds: state.folds,
  width: brushWidth(brushSlider.value),
  onChange: syncUI
});
board.onStateChange = syncUI;

foldGroup.addEventListener('click', (event) => {
  const button = event.target.closest('[data-fold]');
  if (button) selectFold(Number(button.dataset.fold));
});

brushSlider.addEventListener('input', () => {
  board.setWidth(brushWidth(brushSlider.value));
});

undoButton.addEventListener('click', () => {
  board.undo();
  syncUI();
});

redoButton.addEventListener('click', () => {
  board.redo();
  syncUI();
});

clearButton.addEventListener('click', () => {
  board.clear();
  syncUI();
});

finishButton.addEventListener('click', handleFinish);
restartButton.addEventListener('click', handleRestart);
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

syncUI();
registerServiceWorker();
window.__papercutBooted = true;
