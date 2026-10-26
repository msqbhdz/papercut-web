import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISK_INSET,
  FOLD_OPTIONS,
  FOLD_LABELS,
  PALETTE,
  sectorAngle,
  inSector,
  clampToSector,
  expandMatrices,
  toPathCommands,
  toSvgPathD,
  foldedCamera,
  renderFolded,
  renderUnfold,
  renderFinal,
} from '../js/symmetry.v3.js';
import { buildSVG } from '../js/export.v3.js';

const CENTER = { x: 0.5, y: 0.5 };
const AXIS = -Math.PI / 2;
const TAU = Math.PI * 2;

const STROKES = [
  { width: 0.008, points: [{ x: 0.5, y: 0.2 }, { x: 0.55, y: 0.3 }, { x: 0.48, y: 0.38 }] },
  { width: 0.012, points: [{ x: 0.44, y: 0.22 }, { x: 0.5, y: 0.3 }] },
];

function applyMatrix(matrix, p) {
  return {
    x: matrix.a * p.x + matrix.c * p.y + matrix.e,
    y: matrix.b * p.x + matrix.d * p.y + matrix.f,
  };
}

function multiply(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

function rotationAbout(angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: CENTER.x - (cos * CENTER.x - sin * CENTER.y),
    f: CENTER.y - (sin * CENTER.x + cos * CENTER.y),
  };
}

function assertClose(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, message + ': ' + actual + ' != ' + expected);
}

function assertMatrixClose(actual, expected, message, tolerance = 1e-9) {
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assertClose(actual[key], expected[key], message + '[' + key + ']', tolerance);
  }
}

// 成品态相机（与 symmetry.js 的 finalCamera 同一公式）：居中内缩 DISK_INSET。
function finalCam(size) {
  const scale = size * DISK_INSET;
  const offset = (size * (1 - DISK_INSET)) / 2;
  return [scale, 0, 0, scale, offset, offset];
}

// 相机是 6 个数的向量，逐分量按容差比较（lerpCamera 收尾处有末位浮点噪声）。
function assertCamClose(actual, expected, message) {
  assert.equal(actual.length, expected.length, message + ' 分量个数');
  for (let i = 0; i < expected.length; i += 1) assertClose(actual[i], expected[i], message + '[' + i + ']');
}

function matrixAt(matrices, k, m) {
  const found = matrices.find((matrix) => matrix.k === k && matrix.m === m);
  assert.ok(found, 'missing matrix k=' + k + ' m=' + m);
  return found;
}

const CTX_METHODS = [
  'save',
  'restore',
  'setTransform',
  'transform',
  'beginPath',
  'moveTo',
  'lineTo',
  'quadraticCurveTo',
  'arc',
  'closePath',
  'clip',
  'fill',
  'stroke',
  'setLineDash',
  'clearRect',
  'fillRect',
];

const CTX_STYLE_KEYS = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'lineCap', 'lineJoin'];

function createFakeCtx() {
  const calls = [];
  const style = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
  };
  const ctx = { calls };
  const stack = [];
  for (const name of CTX_METHODS) {
    ctx[name] = (...args) => {
      calls.push({ name, args, style: { ...style } });
      if (name === 'save') stack.push({ ...style });
      if (name === 'restore') Object.assign(style, stack.pop() || style);
    };
  }
  for (const key of CTX_STYLE_KEYS) {
    Object.defineProperty(ctx, key, {
      get() {
        return style[key];
      },
      set(next) {
        style[key] = next;
        calls.push({ name: 'set:' + key, args: [next], style: { ...style } });
      },
    });
  }
  ctx.count = (name) => calls.filter((call) => call.name === name).length;
  ctx.named = (name) => calls.filter((call) => call.name === name);
  return ctx;
}

function strokeCalls(ctx) {
  return ctx.named('stroke');
}

// 红纸上的白装饰纹当初就是拿 PALETTE.inkCut 描的；折叠/展开态的笔迹走 PALETTE.inkFolded
// 与 mixHex 生成的 rgb(...) 字符串，所以「没有任何 stroke 用这个颜色」= 没有任何装饰纹。
function whiteDecoStrokes(ctx) {
  return strokeCalls(ctx).filter((call) => call.style.strokeStyle === PALETTE.inkCut);
}

function paintedColors(ctx) {
  const colors = new Set();
  for (const call of ctx.calls) {
    if (call.name === 'set:fillStyle' || call.name === 'set:strokeStyle') colors.add(call.args[0]);
  }
  return [...colors].sort();
}

// 纯旋转（无反射）的 transform 调用：c = -b 且 d = a。
function pureRotations(ctx) {
  const angles = [];
  for (const call of ctx.named('transform')) {
    const [a, b, c, d] = call.args;
    if (Math.abs(c + b) > 1e-9 || Math.abs(d - a) > 1e-9) continue;
    const angle = Math.atan2(b, a);
    angles.push(angle < -1e-9 ? angle + TAU : angle);
  }
  return angles;
}

// 从记录到的路径命令里采样出设计坐标点，用来验证几何都落在楔形内。
function pathSamples(ctx) {
  const samples = [];
  for (const call of ctx.calls) {
    const args = call.args;
    if (call.name === 'moveTo' || call.name === 'lineTo') {
      samples.push({ x: args[0], y: args[1] });
    } else if (call.name === 'quadraticCurveTo') {
      samples.push({ x: args[0], y: args[1] });
      samples.push({ x: args[2], y: args[3] });
    } else if (call.name === 'arc') {
      const [cx, cy, radius, from, to, ccw] = args;
      let sweep = to - from;
      if (ccw) {
        while (sweep > 0) sweep -= TAU;
      } else {
        while (sweep < 0) sweep += TAU;
      }
      samples.push({ x: cx, y: cy });
      for (let i = 0; i <= 8; i += 1) {
        const angle = from + (sweep * i) / 8;
        samples.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      }
    }
  }
  return samples;
}

test('常量：FOLD_OPTIONS / FOLD_LABELS / PALETTE / sectorAngle', () => {
  assert.deepEqual(FOLD_OPTIONS, [4, 6, 8]);
  assert.deepEqual(FOLD_LABELS, { 4: '四角', 6: '六角', 8: '八角' });
  assert.deepEqual(PALETTE, {
    paperBg: '#E9EBE8',
    paper: '#BE2428',
    inkFolded: '#D98B3F',
    inkCut: '#FFFFFF',
  });
  for (const folds of FOLD_OPTIONS) {
    assertClose(sectorAngle(folds), (2 * Math.PI) / folds, 'sectorAngle ' + folds);
  }
});

test('expandMatrices 副本数：mirror 开启 2n，关闭 n', () => {
  for (const folds of FOLD_OPTIONS) {
    const mirrored = expandMatrices(folds, true);
    const plain = expandMatrices(folds, false);
    assert.equal(mirrored.length, 2 * folds, 'folds=' + folds + ' mirrored');
    assert.equal(plain.length, folds, 'folds=' + folds + ' plain');
    assert.deepEqual([...new Set(mirrored.map((matrix) => matrix.m))].sort(), [-1, 1]);
    for (let k = 0; k < folds; k += 1) {
      assert.equal(matrixAt(mirrored, k, 1).k, k);
      assert.equal(matrixAt(mirrored, k, -1).k, k);
      assert.equal(matrixAt(plain, k, 1).k, k);
    }
  }
  assert.equal(expandMatrices(8, true).length, 16);
  assert.equal(expandMatrices(8, false).length, 8);
});

test('k=0,m=+1 是恒等变换', () => {
  const points = [
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.2 },
    { x: 0.62, y: 0.31 },
    { x: 0.11, y: 0.93 },
  ];
  for (const folds of FOLD_OPTIONS) {
    const identity = matrixAt(expandMatrices(folds, true), 0, 1);
    assert.equal(identity.a, 1);
    assert.equal(identity.b, 0);
    assert.equal(identity.c, 0);
    assert.equal(identity.d, 1);
    assert.equal(identity.e, 0);
    assert.equal(identity.f, 0);
    for (const p of points) {
      const mapped = applyMatrix(identity, p);
      assertClose(mapped.x, p.x, 'identity x');
      assertClose(mapped.y, p.y, 'identity y');
    }
  }
});

test('旋转闭合：k 份 = k=1 份绕心再转 (k-1)Δ', () => {
  for (const folds of FOLD_OPTIONS) {
    const delta = sectorAngle(folds);
    for (const mirror of [true, false]) {
      const matrices = expandMatrices(folds, mirror);
      for (let k = 0; k < folds; k += 1) {
        const rotated = multiply(rotationAbout((k - 1) * delta), matrixAt(matrices, 1, 1));
        assertMatrixClose(rotated, matrixAt(matrices, k, 1), 'folds=' + folds + ' mirror=' + mirror + ' k=' + k + ' m=+1');
        if (!mirror) continue;
        const rotatedMirror = multiply(rotationAbout((k - 1) * delta), matrixAt(matrices, 1, -1));
        assertMatrixClose(rotatedMirror, matrixAt(matrices, k, -1), 'folds=' + folds + ' k=' + k + ' m=-1');
      }
    }
  }
});

test('反射：k=0,m=-1 沿竖直轴把 x 映为 -x', () => {
  for (const folds of FOLD_OPTIONS) {
    const matrix = matrixAt(expandMatrices(folds, true), 0, -1);
    assertClose(matrix.a, -1, 'a');
    assertClose(matrix.b, 0, 'b');
    assertClose(matrix.c, 0, 'c');
    assertClose(matrix.d, 1, 'd');
    assertClose(matrix.e, 1, 'e');
    assertClose(matrix.f, 0, 'f');
    for (let i = 0; i < 8; i += 1) {
      const sample = { x: 0.5 + 0.06 * Math.cos(i), y: 0.5 - 0.09 * Math.sin(i) };
      const out = applyMatrix(matrix, sample);
      assertClose(out.x, 0.5 - (sample.x - 0.5), 'mirror sample ' + i + ' x');
      assertClose(out.y, sample.y, 'mirror sample ' + i + ' y');
      assert.equal(inSector(out, folds), inSector(sample, folds), 'mirror keeps the wedge folds=' + folds);
    }
  }
});

test('inSector：正上方在内、正下方在外、边界判 true', () => {
  const up = { x: 0.5, y: 0.2 };
  const down = { x: 0.5, y: 0.8 };
  for (const folds of FOLD_OPTIONS) {
    assert.equal(inSector(up, folds), true, 'up folds=' + folds);
    assert.equal(inSector(CENTER, folds), true, 'center folds=' + folds);
    const half = sectorAngle(folds) / 2;
    for (const edge of [AXIS - half, AXIS + half]) {
      const boundary = { x: CENTER.x + 0.3 * Math.cos(edge), y: CENTER.y + 0.3 * Math.sin(edge) };
      assert.equal(inSector(boundary, folds), true, 'boundary ' + edge + ' folds=' + folds);
    }
    assert.equal(inSector(down, folds), false, 'down folds=' + folds);
  }
  assert.equal(inSector({ x: 0.2, y: 0.5 }, 8), false);
  assert.equal(inSector({ x: 0.8, y: 0.5 }, 8), false);
});

test('clampToSector：夹到最近径向边、半径夹到 0.5', () => {
  const folds = 8;
  const half = sectorAngle(folds) / 2;
  const outside = {
    x: CENTER.x + 0.3 * Math.cos(AXIS + Math.PI / 4),
    y: CENTER.y + 0.3 * Math.sin(AXIS + Math.PI / 4),
  };
  const clamped = clampToSector(outside, folds);
  assertClose(clamped.x, CENTER.x + 0.3 * Math.cos(AXIS + half), 'clamped x');
  assertClose(clamped.y, CENTER.y + 0.3 * Math.sin(AXIS + half), 'clamped y');
  assertClose(Math.hypot(clamped.x - CENTER.x, clamped.y - CENTER.y), 0.3, 'radius kept');

  const outsideLeft = {
    x: CENTER.x + 0.3 * Math.cos(AXIS - Math.PI / 3),
    y: CENTER.y + 0.3 * Math.sin(AXIS - Math.PI / 3),
  };
  const clampedLeft = clampToSector(outsideLeft, folds);
  assertClose(Math.atan2(clampedLeft.y - CENTER.y, clampedLeft.x - CENTER.x), AXIS - half, 'clamped left angle');

  const inside = { x: CENTER.x + 0.2 * Math.cos(AXIS + 0.1), y: CENTER.y + 0.2 * Math.sin(AXIS + 0.1) };
  const kept = clampToSector(inside, folds);
  assertClose(kept.x, inside.x, 'inside x');
  assertClose(kept.y, inside.y, 'inside y');

  const far = { x: 0.5, y: -0.5 };
  const shrunk = clampToSector(far, folds);
  assertClose(shrunk.x, 0.5, 'shrunk x');
  assertClose(shrunk.y, 0, 'shrunk y');
  assertClose(Math.hypot(shrunk.x - CENTER.x, shrunk.y - CENTER.y), 0.5, 'shrunk radius');

  const farOutside = {
    x: CENTER.x + 0.9 * Math.cos(AXIS + Math.PI),
    y: CENTER.y + 0.9 * Math.sin(AXIS + Math.PI),
  };
  const both = clampToSector(farOutside, folds);
  assertClose(Math.hypot(both.x - CENTER.x, both.y - CENTER.y), 0.5, 'both radius');
  assert.equal(inSector(both, folds), true);

  assert.deepEqual(clampToSector({ x: 0.5, y: 0.5 }, folds), CENTER);
});

test('toPathCommands：1 / 2 / >=3 点三个分支', () => {
  const p0 = { x: 0.5, y: 0.2 };
  const p1 = { x: 0.6, y: 0.3 };
  const p2 = { x: 0.55, y: 0.42 };
  const p3 = { x: 0.44, y: 0.4 };

  assert.deepEqual(toPathCommands([]), []);
  assert.deepEqual(toPathCommands([p0]), [{ op: 'M', x: 0.5, y: 0.2 }]);
  assert.deepEqual(toPathCommands([p0, p1]), [
    { op: 'M', x: 0.5, y: 0.2 },
    { op: 'L', x: 0.6, y: 0.3 },
  ]);

  assert.deepEqual(toPathCommands([p0, p1, p2]), [
    { op: 'M', x: 0.5, y: 0.2 },
    { op: 'Q', x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, cx: p1.x, cy: p1.y },
    { op: 'L', x: 0.55, y: 0.42 },
  ]);

  const points = [p0, p1, p2, p3];
  const four = toPathCommands(points);
  assert.deepEqual(four.map((command) => command.op), ['M', 'Q', 'Q', 'L']);
  for (let i = 1; i < points.length - 1; i += 1) {
    const command = four[i];
    assert.equal(command.cx, points[i].x);
    assert.equal(command.cy, points[i].y);
    assertClose(command.x, (points[i].x + points[i + 1].x) / 2, 'q' + i + ' x');
    assertClose(command.y, (points[i].y + points[i + 1].y) / 2, 'q' + i + ' y');
  }
  assert.deepEqual(four[four.length - 1], { op: 'L', x: p3.x, y: p3.y });
  assert.deepEqual(points[0], p0, 'input not mutated');
});

test('toSvgPathD：固定 5 位小数格式', () => {
  assert.equal(toSvgPathD([]), '');
  assert.equal(toSvgPathD([{ op: 'M', x: 0.5, y: 0.2 }]), 'M 0.5 0.2');
  assert.equal(
    toSvgPathD([
      { op: 'M', x: 0.5, y: 0.2 },
      { op: 'L', x: 1 / 3, y: 0.25 },
      { op: 'Q', x: 0.5, y: 0.75, cx: 0.4, cy: 0.6 },
    ]),
    'M 0.5 0.2 L 0.33333 0.25 Q 0.4 0.6 0.5 0.75',
  );
  assert.equal(toSvgPathD([{ op: 'M', x: -0.0000001, y: 1 }]), 'M 0 1');
  const d = toSvgPathD(
    toPathCommands([
      { x: 0.12345678, y: 0.9 },
      { x: 0.2, y: 0.3 },
      { x: 0.7, y: 0.4 },
    ]),
  );
  for (const token of d.split(' ')) {
    if ('MLQ'.includes(token)) continue;
    assert.match(token, /^-?\d+(\.\d{1,5})?$/, 'bad number token ' + token);
  }
  assert.ok(!/0{6}/.test(d), 'no zero padding beyond 5 decimals');
});

test('foldedCamera：顶点落在画布 85%~92% 高处，楔形最宽处不越界', () => {
  for (const size of [366, 800]) {
    for (const folds of FOLD_OPTIONS) {
      const cam = foldedCamera(folds, size);
      const tag = 'size=' + size + ' folds=' + folds;
      assert.ok(Number.isFinite(cam.scale), 'scale finite ' + tag);
      assert.ok(Number.isFinite(cam.tx), 'tx finite ' + tag);
      assert.ok(Number.isFinite(cam.ty), 'ty finite ' + tag);
      assert.ok(cam.scale > 0, 'scale positive ' + tag);

      const vertexY = CENTER.y * cam.scale + cam.ty;
      const centerX = CENTER.x * cam.scale + cam.tx;
      assert.ok(vertexY >= size * 0.85 && vertexY <= size * 0.92, 'vertex y ' + vertexY + ' ' + tag);
      assertClose(centerX, size / 2, 'wedge centered ' + tag);

      const half = sectorAngle(folds) / 2;
      const widest = 0.5 * Math.sin(half) * cam.scale;
      assert.ok(centerX - widest >= 0, 'wedge left edge ' + (centerX - widest) + ' ' + tag);
      assert.ok(centerX + widest <= size, 'wedge right edge ' + (centerX + widest) + ' ' + tag);

      const arcTop = vertexY - 0.5 * cam.scale;
      assert.ok(arcTop >= 0, 'arc top ' + arcTop + ' ' + tag);
      assert.ok(0.5 * cam.scale <= size * 0.87, 'arc reach ' + 0.5 * cam.scale + ' ' + tag);
    }
  }
  const identityCam = foldedCamera(6, 366);
  assert.deepEqual(Object.keys(identityCam).sort(), ['scale', 'tx', 'ty']);
});

test('renderFolded：只画一份笔迹、铺背景，没有任何装饰纹', () => {
  const folds = 6;
  const size = 366;
  const ctx = createFakeCtx();
  renderFolded(ctx, STROKES, { folds, size });

  assert.equal(ctx.count('save'), ctx.count('restore'));
  assert.equal(ctx.count('clearRect'), 1);
  assert.equal(ctx.count('fillRect'), 1);
  assert.equal(ctx.named('fillRect')[0].style.fillStyle, PALETTE.paperBg);
  assert.equal(ctx.count('clip'), 1, '笔迹裁在楔形内');

  const cam = foldedCamera(folds, size);
  assert.deepEqual(ctx.named('transform')[0].args, [cam.scale, 0, 0, cam.scale, cam.tx, cam.ty]);

  const ink = strokeCalls(ctx);
  assert.equal(ink.length, STROKES.length, '只画这一片，不复制');
  assert.ok(ink.length < 2 * folds * STROKES.length);
  for (const call of ink) assert.equal(call.style.strokeStyle, PALETTE.inkFolded);

  // 折叠态只剩「红楔形 + 金色笔迹」：没有白纹，也没有第二条 path。
  assert.equal(ctx.count('fill'), 1, '红楔形一次 fill，此外无填充');
  assert.equal(whiteDecoStrokes(ctx).length, 0, '白色装饰线已全删');
  assert.deepEqual(paintedColors(ctx), [PALETTE.inkFolded, PALETTE.paper, PALETTE.paperBg].sort(), '只出现背景/红纸/金笔三种颜色');
  assert.equal(
    ctx.count('quadraticCurveTo'),
    STROKES.filter((stroke) => stroke.points.length >= 3).length,
    '二次曲线只来自笔迹（>=3 点的那条走 Q）',
  );

  const empty = createFakeCtx();
  renderFolded(empty, [], { folds, size });
  assert.equal(empty.count('stroke'), 0, '无笔迹时一次 stroke 都不该有');
  assert.equal(empty.count('quadraticCurveTo'), 0, '无笔迹时没有任何装饰曲线');
  assert.equal(empty.count('lineTo'), 0, '也没有折线');
  assert.equal(whiteDecoStrokes(empty).length, 0);
  assert.deepEqual(paintedColors(empty), [PALETTE.paper, PALETTE.paperBg].sort(), '只剩背景与红纸');
});

test('renderFolded：无笔迹时只画楔形本体，一条装饰几何都不产生', () => {
  for (const folds of FOLD_OPTIONS) {
    const tag = 'folds=' + folds;
    const ctx = createFakeCtx();
    renderFolded(ctx, [], { folds, size: 400 });
    assert.equal(ctx.count('moveTo'), 1, '只有楔形顶点一个 moveTo: ' + tag);
    assert.equal(ctx.count('arc'), 1, '只有楔形外弧一条 arc: ' + tag);
    assert.equal(ctx.count('closePath'), 1, '楔形闭合一次: ' + tag);
    assert.equal(ctx.count('quadraticCurveTo'), 0, '云纹那组二次曲线已删除: ' + tag);
    assert.equal(ctx.count('lineTo'), 0, '没有任何折线: ' + tag);
    assert.equal(ctx.count('stroke'), 0, '既没有笔迹也没有装饰纹: ' + tag);
    assert.equal(ctx.count('fill'), 1, '只填红楔形本体: ' + tag);

    // 剩下的几何就是楔形自身：顶点与半径 0.5 的外弧，全部落在楔形内。
    const samples = pathSamples(ctx);
    assert.ok(samples.length >= 10, '楔形自身的采样点: ' + tag);
    for (const point of samples) {
      const radius = Math.hypot(point.x - CENTER.x, point.y - CENTER.y);
      assert.ok(radius <= 0.5 + 1e-9, 'radius ' + radius + ' ' + tag);
      assert.ok(inSector(point, folds), 'outside wedge (' + point.x + ',' + point.y + ') ' + tag);
    }
  }
});

test('renderFinal：2n 份白色刻线、红盘、无装饰纹', () => {
  const folds = 6;
  const size = 400;
  const ctx = createFakeCtx();
  renderFinal(ctx, STROKES, { folds, size });

  assert.equal(ctx.count('save'), ctx.count('restore'));
  assert.equal(ctx.count('clearRect'), 1);
  assert.equal(ctx.named('fillRect')[0].style.fillStyle, PALETTE.paperBg);
  assert.equal(ctx.count('stroke'), 2 * folds * STROKES.length);
  assert.equal(strokeCalls(ctx).length, 2 * folds * STROKES.length);
  for (const call of ctx.named('stroke')) assert.equal(call.style.strokeStyle, PALETTE.inkCut);

  const fills = ctx.named('fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].style.fillStyle, PALETTE.paper);
  assert.ok(ctx.count('clip') >= 1, '刻线裁在红盘内');

  // 成品态相机：居中内缩，红盘按设计半径 0.5 画，于是屏幕半径 = 0.5 × 0.94 = 0.47 × size。
  const cam = finalCam(size);
  assert.deepEqual(ctx.named('transform')[0].args, cam, '红盘相机是居中内缩');
  assert.equal(ctx.named('arc')[0].args[2], 0.5, '红盘仍按设计半径 0.5 画');
  const screenRadius = 0.5 * cam[0];
  assertClose(screenRadius, 0.47 * size, '屏幕半径 0.47×size');
  const centerScreen = CENTER.x * cam[0] + cam[4];
  assertClose(centerScreen, size / 2, '盘心仍在画布中心');
  const leftGap = centerScreen - screenRadius;
  const rightGap = size - (centerScreen + screenRadius);
  assertClose(leftGap, 0.03 * size, '盘左留白 0.03×size');
  assertClose(rightGap, 0.03 * size, '盘右留白 0.03×size');
  assert.ok(leftGap > 0 && rightGap > 0, '整圆落在画布内，盘边不顶到画布边');

  assert.deepEqual(paintedColors(ctx), [PALETTE.inkCut, PALETTE.paper, PALETTE.paperBg].sort());
  for (const call of ctx.calls) assert.equal(call.style.globalAlpha, 1, '成品态没有任何半透明装饰纹');
  assert.equal(ctx.count('quadraticCurveTo'), 2 * folds * (STROKES[0].points.length - 2));

  const dot = [{ width: 0.02, points: [{ x: 0.5, y: 0.25 }] }];
  const dotCtx = createFakeCtx();
  renderFinal(dotCtx, dot, { folds: 4, size: 400 });
  assert.equal(dotCtx.count('fill'), 1 + 2 * 4, '红盘 + 2n 个实心圆点');
  assert.equal(dotCtx.count('stroke'), 0);
  assert.equal(dotCtx.named('arc')[1].args[2], 0.01);
});

test('renderUnfold：拖影层数与 progress 的关系', () => {
  const folds = 6;
  const size = 400;
  const single = 2 * folds * STROKES.length;
  const at = (progress) => {
    const ctx = createFakeCtx();
    renderUnfold(ctx, STROKES, { folds, size }, progress);
    return ctx;
  };

  const start = at(0);
  const middle = at(0.5);
  const end = at(1);

  assert.equal(start.count('save'), start.count('restore'));
  assert.equal(middle.count('save'), middle.count('restore'));
  assert.equal(end.count('save'), end.count('restore'));

  assert.equal(strokeCalls(end).length, single, 'progress=1 是单帧 2n 份');
  assert.equal(strokeCalls(start).length, folds * STROKES.length, 'progress=0 只露最上面一层，镜像片被压住');
  assert.equal(strokeCalls(start).filter((call) => call.style.globalAlpha !== 1).length, 0, 'progress=0 笔迹全不透明');
  assert.equal(
    strokeCalls(at(0.5)).filter((call) => call.style.globalAlpha === 1).length,
    single,
    'progress>=0.25 镜像片已全露出',
  );
  assert.equal(start.count('stroke'), folds * STROKES.length, 'progress=0 除笔迹外没有任何额外路径');
  assert.equal(whiteDecoStrokes(start).length, 0, '展开首帧没有白色装饰线');
  assert.equal(whiteDecoStrokes(end).length, 0, 'progress=1 仍然没有装饰纹');

  assert.equal(strokeCalls(middle).length, 3 * single, 'progress=0.5 有 2 层拖影 + 主体');
  assert.ok(middle.count('stroke') > end.count('stroke'), '拖影让绘制次数变多');
  assert.equal(middle.count('stroke'), 3 * single, '每层只有笔迹，没有装饰纹那条额外路径');
  const trailAlphas = middle.named('stroke').map((call) => call.style.globalAlpha);
  assert.ok(trailAlphas.includes(0.11), 'lag 0.06 的拖影 alpha 0.22*(1-0.5)');
  assert.ok(trailAlphas.includes(0.05), 'lag 0.12 的拖影 alpha 0.10*(1-0.5)');

  assert.equal(start.named('fillRect')[0].style.fillStyle, PALETTE.paperBg);
  // 收尾相机由 lerpCamera 在 t=1 处算出，末位有浮点噪声，故按 1e-9 比较。
  assertCamClose(end.named('transform')[0].args, finalCam(size), 'progress=1 相机就是 renderFinal 的内缩相机');
  const cam = foldedCamera(folds, size);
  assert.deepEqual(start.named('transform')[0].args, [cam.scale, 0, 0, cam.scale, cam.tx, cam.ty]);
});

test('renderUnfold：笔迹颜色 p<0.65 保持金色，p∈[0.65,1] 才金→白过渡', () => {
  const at = (progress) => {
    const ctx = createFakeCtx();
    renderUnfold(ctx, STROKES, { folds: 6, size: 400 }, progress);
    return strokeCalls(ctx).map((call) => call.style.strokeStyle);
  };
  const gold = 'rgb(217, 139, 63)';
  assert.equal(at(0)[0], gold);
  assert.equal(at(1)[0], 'rgb(255, 255, 255)');
  assert.equal(at(0.3)[0], gold, '动画前半段笔迹不变白');
  assert.equal(at(0.649)[0], gold, '分界之前仍是金色');
  assert.equal(at(0.65)[0], gold, '分界点插值因子为 0');
  assert.deepEqual([...new Set(at(0.5))], [gold], 'progress=0.5 拖影与主体全是金色');

  // p=0.825 → 插值因子 (0.825-0.65)/0.35 = 0.5，金白中点。
  const middle = at(0.825);
  assert.equal(middle[middle.length - 1], 'rgb(236, 197, 159)', 'progress=0.825 的主体色是金白中点');
  assert.equal(middle[0], 'rgb(223, 157, 93)', '拖影 lag=0.705 用自己那一层的进度色');
  assert.ok(middle.includes('rgb(229, 177, 126)'), '拖影 lag=0.765 用自己那一层的进度色');
  assert.equal(new Set(middle).size, 3, '拖影 + 主体三层各不相同');
});

test('renderUnfold：progress=0 时镜像片与原片完全重合', () => {
  for (const folds of FOLD_OPTIONS) {
    const ctx = createFakeCtx();
    renderUnfold(ctx, STROKES, { folds, size: 400 }, 0);
    const cam = foldedCamera(folds, 400);
    const transforms = ctx.named('transform').map((call) => call.args);
    assert.deepEqual(transforms[0], [cam.scale, 0, 0, cam.scale, cam.tx, cam.ty], '相机在 premultiply 之前');
    assert.ok(transforms.length - 1 >= 2 * folds, '至少 2n 片纸');
    for (const args of transforms.slice(1)) {
      const identity = [1, 0, 0, 1, 0, 0];
      const mirror = [-1, 0, 0, 1, 1, 0];
      const isIdentity = args.every((value, index) => Math.abs(value - identity[index]) < 1e-9);
      const isMirror = args.every((value, index) => Math.abs(value - mirror[index]) < 1e-9);
      assert.ok(isIdentity || isMirror, 'progress=0 只允许原片与竖直镜像: ' + args.join(','));
    }
    const wedgePoints = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.02 },
      { x: 0.5 - 0.3 * Math.sin(sectorAngle(folds) / 2), y: 0.5 - 0.3 * Math.cos(sectorAngle(folds) / 2) },
    ];
    for (const point of wedgePoints) {
      const mirrored = applyMatrix({ a: -1, b: 0, c: 0, d: 1, e: 1, f: 0 }, point);
      assertClose(mirrored.x, 1 - point.x, 'mirror x');
      assertClose(mirrored.y, point.y, 'mirror y');
      assert.equal(inSector(mirrored, folds), true, '镜像后仍在同一楔形内');
    }
  }
});

test('renderUnfold：progress 推进时旋转角 k·Δ·progress 递增', () => {
  const folds = 8;
  const delta = sectorAngle(folds);
  let previous = -1;
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const ctx = createFakeCtx();
    renderUnfold(ctx, STROKES, { folds, size: 400 }, progress);
    const angles = pureRotations(ctx);
    const max = Math.max(...angles);
    assertClose(max, (folds - 1) * delta * progress, 'progress=' + progress, 1e-9);
    assert.ok(max > previous, '旋转角随 progress 递增 progress=' + progress);
    previous = max;
  }

  const ctx = createFakeCtx();
  renderUnfold(ctx, STROKES, { folds, size: 400 }, 0.05);
  const expected = [];
  for (let k = 0; k < folds; k += 1) expected.push(k * delta * 0.05);
  const seen = [...new Set(pureRotations(ctx).sort((a, b) => a - b))];
  assert.equal(seen.length, folds, '只有 k=0..n-1 这几片（progress=0.05 还没有拖影）');
  for (let k = 0; k < folds; k += 1) assertClose(seen[k], expected[k], 'k=' + k, 1e-9);
});

// 楔形路径的顶点采样：轴两侧成对的角偏移，反射 θ0 后这组点原样映回自己。
function wedgeSamples(folds, steps) {
  const half = sectorAngle(folds) / 2;
  const samples = [{ x: CENTER.x, y: CENTER.y }];
  for (let i = 0; i <= steps; i += 1) {
    const offset = AXIS - half + (2 * half * i) / steps;
    for (const radius of [0.18, 0.34, 0.5]) {
      samples.push({ x: CENTER.x + radius * Math.cos(offset), y: CENTER.y + radius * Math.sin(offset) });
    }
  }
  return samples;
}

function samePointSet(left, right, tolerance = 1e-9) {
  return (
    left.length === right.length &&
    left.every((p) => right.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance))
  );
}

function fillCalls(ctx) {
  const indexes = [];
  for (let i = 0; i < ctx.calls.length; i += 1) if (ctx.calls[i].name === 'fill') indexes.push(i);
  return indexes;
}

// 某次 fill 之前、最近一次 beginPath 之后加入的内容：就是这一次要填充的那条路径。
function pathBeforeFill(ctx, fillIndex) {
  let begin = -1;
  for (let i = fillIndex - 1; i >= 0; i -= 1) {
    if (ctx.calls[i].name === 'beginPath') {
      begin = i;
      break;
    }
  }
  assert.ok(begin >= 0, 'fill 之前必须有 beginPath');
  const slice = ctx.calls.slice(begin + 1, fillIndex);
  const count = (name) => slice.filter((call) => call.name === name).length;
  return {
    moveTo: count('moveTo'),
    arc: count('arc'),
    closePath: count('closePath'),
    transforms: slice.filter((call) => call.name === 'transform').map((call) => call.args),
  };
}

test('楔形自对称：Rot(kΔ) 与 Rot(kΔ)·Reflect(θ0) 把楔形顶点映成同一组点', () => {
  for (const folds of FOLD_OPTIONS) {
    const delta = sectorAngle(folds);
    const matrices = expandMatrices(folds, true);
    const samples = wedgeSamples(folds, 8);
    for (let k = 0; k < folds; k += 1) {
      const rotation = rotationAbout(k * delta);
      const reflected = multiply(rotation, matrixAt(matrices, 0, -1));
      const tag = 'folds=' + folds + ' k=' + k;
      assertMatrixClose(reflected, matrixAt(matrices, k, -1), 'Rot(kΔ)·Reflect(θ0) 就是第 k 片镜像: ' + tag);

      const rotatedPoints = samples.map((point) => applyMatrix(rotation, point));
      const reflectedPoints = samples.map((point) => applyMatrix(reflected, point));
      assert.equal(samePointSet(rotatedPoints, reflectedPoints), true, '镜像片与原片逐点重合: ' + tag);
      assert.equal(samePointSet(reflectedPoints, rotatedPoints), true, '重合是双向的: ' + tag);

      const detRotation = rotation.a * rotation.d - rotation.b * rotation.c;
      const detReflected = reflected.a * reflected.d - reflected.b * reflected.c;
      assert.ok(detRotation > 0, '原片不翻转绕向: ' + tag);
      assert.ok(detReflected < 0, '镜像片翻转绕向（这就是 nonzero 抵消的那一半）: ' + tag);
      assertClose(Math.abs(detReflected), Math.abs(detRotation), '翻折只改符号不改面积: ' + tag);
    }
  }
});

test('renderUnfold：纸的路径只用 n 片楔形，笔迹仍按 2n 份复制', () => {
  for (const folds of FOLD_OPTIONS) {
    for (const progress of [0.5, 1]) {
      const tag = 'folds=' + folds + ' progress=' + progress;
      const ctx = createFakeCtx();
      renderUnfold(ctx, STROKES, { folds, size: 400 }, progress);
      const fills = fillCalls(ctx);
      assert.ok(fills.length >= 1, '至少填一次纸: ' + tag);
      for (const index of fills) {
        const path = pathBeforeFill(ctx, index);
        assert.equal(path.moveTo, folds, '纸的楔形子路径数是 n 而不是 2n: ' + tag);
        assert.equal(path.arc, folds, '每片楔形一条外弧: ' + tag);
        assert.equal(path.closePath, folds, '每片楔形都要闭合: ' + tag);
        assert.equal(path.transforms.length, folds, '纸只经过 n 次扇区变换: ' + tag);
        for (const args of path.transforms) {
          const det = args[0] * args[3] - args[1] * args[2];
          assert.ok(det > 0, '纸的路径不能含翻转片（会与重叠片互相抵消）: ' + tag);
        }
      }
      const layers = progress === 1 ? 1 : 3;
      assert.equal(strokeCalls(ctx).length, layers * 2 * folds * STROKES.length, '每层笔迹仍复制 2n 份: ' + tag);
      assert.equal(whiteDecoStrokes(ctx).length, 0, '任何一层纸都没有装饰纹: ' + tag);
    }
  }
});

test('renderUnfold：progress=0.5 每一层纸都真的填了楔形子路径', () => {
  const ctx = createFakeCtx();
  renderUnfold(ctx, STROKES, { folds: 6, size: 400 }, 0.5);
  const fills = fillCalls(ctx);
  assert.ok(fills.length >= 1, 'progress=0.5 至少产生 1 次 fill');
  for (const index of fills) {
    const path = pathBeforeFill(ctx, index);
    assert.ok(path.moveTo >= 1 && path.arc >= 1, 'fill 之前必须有楔形子路径，否则填的是一条空路径');
    assert.equal(path.moveTo, path.arc, '每个 moveTo 配一条弧');
    assert.equal(ctx.calls[index].style.fillStyle, PALETTE.paper, '填的是纸色');
  }
  const strokedAt = ctx.named('stroke');
  assert.ok(strokedAt.length > 0, '笔迹照常画');
});

test('renderUnfold：progress 在 (0,1) 内任意取值都不会画出空纸', () => {
  for (const folds of FOLD_OPTIONS) {
    for (const progress of [0.05, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 0.99]) {
      const tag = 'folds=' + folds + ' progress=' + progress;
      const ctx = createFakeCtx();
      renderUnfold(ctx, STROKES, { folds, size: 400 }, progress);
      const fills = fillCalls(ctx);
      assert.ok(fills.length >= 1, '至少一层纸: ' + tag);
      for (const index of fills) {
        const path = pathBeforeFill(ctx, index);
        assert.equal(path.moveTo, folds, '每层纸都是 n 片楔形: ' + tag);
        assert.ok(path.arc === folds && path.closePath === folds, '楔形子路径完整: ' + tag);
      }
    }
  }
});

// SVG 里的数字直接抽出来比对：证明 buildSVG 的投影公式与 renderFinal 的相机等价。
function svgNumbers(text) {
  return text.match(/-?\d+(?:\.\d+)?/g).map(Number);
}

function svgCircles(svg) {
  return [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((match) =>
    match.slice(1).map(Number),
  );
}

test('buildSVG：红盘与 clipPath 同一圆，path 坐标与 renderFinal 相机逐点一致', () => {
  const size = 512;
  const folds = 6;
  const stroke = {
    width: 0.008,
    points: [{ x: 0.5, y: 0.2 }, { x: 0.55, y: 0.3 }, { x: 0.48, y: 0.38 }],
  };
  const svg = buildSVG({ strokes: [stroke], folds, size });
  const cam = finalCam(size);

  // 红盘与 clipPath 是同一个圆：r = 0.47 × size = 240.64，盘外白边 0.03 × size = 15.36。
  const circles = svgCircles(svg);
  assert.equal(circles.length, 2, 'clipPath 一个圆 + 红盘一个圆');
  for (const [cx, cy, r] of circles) {
    assert.equal(cx, size / 2, '圆心在画布中心 x');
    assert.equal(cy, size / 2, '圆心在画布中心 y');
    assertClose(r, (DISK_INSET * size) / 2, 'r = 0.47×size', 0.01);
  }
  assertClose(size / 2 - circles[1][2], 0.03 * size, '盘外白边 0.03×size', 0.01);

  // 每条 path 的坐标 = design * 0.94 * size + 0.03 * size，也就是 renderFinal 相机作用后的值。
  const paths = [...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((match) => match[1]);
  const matrices = expandMatrices(folds, true);
  assert.equal(paths.length, 2 * folds, '2n 份白色刻线');
  const commands = toPathCommands(stroke.points);
  assert.equal(commands.length, 3, 'M / Q / L');
  for (let i = 0; i < paths.length; i += 1) {
    const matrix = matrices[i];
    const project = (x, y) => ({
      x: (matrix.a * x + matrix.c * y + matrix.e) * cam[0] + cam[4],
      y: (matrix.b * x + matrix.d * y + matrix.f) * cam[3] + cam[5],
    });
    const expected = [];
    for (const command of commands) {
      if (command.op === 'Q') {
        const control = project(command.cx, command.cy);
        expected.push(control.x, control.y);
      }
      const point = project(command.x, command.y);
      expected.push(point.x, point.y);
    }
    const actual = svgNumbers(paths[i]);
    assert.equal(actual.length, expected.length, 'M/Q/L 的数字个数 ' + i);
    for (let j = 0; j < expected.length; j += 1) {
      // SVG 坐标按 2 位小数写出，容差 0.011 只覆盖这一步取整。
      assertClose(actual[j], expected[j], 'path ' + i + ' 第 ' + j + ' 个数', 0.011);
    }
  }

  // 单点笔迹：cx/cy 同样内缩，r = width/2 × size × 0.94。
  const dotSvg = buildSVG({ strokes: [{ width: 0.02, points: [{ x: 0.5, y: 0.25 }] }], folds: 4, size });
  const dots = svgCircles(dotSvg);
  assert.equal(dots.length, 2 + 2 * 4, 'clipPath + 红盘 + 2n 个实心圆点');
  for (const [, , r] of dots.slice(2)) {
    assertClose(r, ((0.02 * size) / 2) * DISK_INSET, '点半径 width/2×size×0.94', 0.01);
  }
  assertClose(dots[2][0], cam[0] * 0.5 + cam[4], '第一个点的 cx 已经内缩', 0.01);
  assertClose(dots[2][1], cam[0] * 0.25 + cam[4], '第一个点的 cy 已经内缩', 0.01);
});
