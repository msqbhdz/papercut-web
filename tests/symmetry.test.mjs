import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLD_OPTIONS,
  sectorAngle,
  inSector,
  clampToSector,
  expandMatrices,
  toPathCommands,
  toSvgPathD,
  renderDesign,
} from '../js/symmetry.js';

const CENTER = { x: 0.5, y: 0.5 };
const AXIS = -Math.PI / 2;

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

function matrixAt(matrices, k, m) {
  const found = matrices.find((matrix) => matrix.k === k && matrix.m === m);
  assert.ok(found, 'missing matrix k=' + k + ' m=' + m);
  return found;
}

function createFakeCtx() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
  };
  const ctx = { calls };
  const methods = [
    'save',
    'restore',
    'setTransform',
    'transform',
    'beginPath',
    'moveTo',
    'lineTo',
    'quadraticCurveTo',
    'arc',
    'fill',
    'stroke',
    'setLineDash',
    'clearRect',
  ];
  for (const name of methods) ctx[name] = record(name);
  ctx.count = (name) => calls.filter((call) => call.name === name).length;
  return ctx;
}

test('FOLD_OPTIONS 与 sectorAngle', () => {
  assert.deepEqual(FOLD_OPTIONS, [2, 4, 8, 12]);
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
  assert.equal(expandMatrices(12, true).length, 24);
  assert.equal(expandMatrices(12, false).length, 12);
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

test('反射：n=4 时 k=0,m=-1 沿竖直轴把 x 映为 -x', () => {
  const matrix = matrixAt(expandMatrices(4, true), 0, -1);
  assertClose(matrix.a, -1, 'a');
  assertClose(matrix.b, 0, 'b');
  assertClose(matrix.c, 0, 'c');
  assertClose(matrix.d, 1, 'd');
  assertClose(matrix.e, 1, 'e');
  assertClose(matrix.f, 0, 'f');
  const p = { x: 0.62, y: 0.31 };
  const mapped = applyMatrix(matrix, p);
  assertClose(mapped.x, 0.5 - (p.x - 0.5), 'mirrored x');
  assertClose(mapped.y, p.y, 'mirrored y');
  for (let i = 0; i < 8; i += 1) {
    const sample = { x: 0.5 + 0.06 * Math.cos(i), y: 0.5 - 0.09 * Math.sin(i) };
    const out = applyMatrix(matrix, sample);
    assertClose(out.x, 0.5 - (sample.x - 0.5), 'mirror sample ' + i + ' x');
    assertClose(out.y, sample.y, 'mirror sample ' + i + ' y');
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
  }
  for (const folds of [4, 8, 12]) {
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

test('renderDesign：save/restore 配平、副本数正确、不 clearRect', () => {
  const strokes = [
    { color: '#c8102e', width: 0.008, points: [{ x: 0.5, y: 0.2 }, { x: 0.55, y: 0.3 }, { x: 0.48, y: 0.38 }] },
    { color: '#1f6feb', width: 0.012, points: [{ x: 0.44, y: 0.22 }, { x: 0.5, y: 0.3 }] },
  ];
  const folds = 12;
  const size = 800;
  const ctx = createFakeCtx();
  renderDesign(ctx, strokes, { folds, size });

  assert.equal(ctx.count('save'), ctx.count('restore'));
  assert.ok(ctx.count('save') >= 1);
  assert.deepEqual(ctx.calls.find((call) => call.name === 'setTransform').args, [size, 0, 0, size, 0, 0]);
  assert.equal(ctx.count('clearRect'), 0);
  assert.equal(ctx.count('transform'), 2 * folds * strokes.length);
  assert.equal(ctx.count('stroke'), 2 * folds * strokes.length);
  assert.equal(ctx.count('setLineDash'), 0);
  assert.equal(ctx.count('quadraticCurveTo'), 2 * folds);

  const firstMoveTo = ctx.calls.find((call) => call.name === 'moveTo');
  assert.deepEqual(firstMoveTo.args, [0.5, 0.2]);

  const plain = createFakeCtx();
  renderDesign(plain, strokes, { folds, size, mirror: false });
  assert.equal(plain.count('save'), plain.count('restore'));
  assert.equal(plain.count('transform'), folds * strokes.length);
  assert.equal(plain.count('stroke'), folds * strokes.length);
});

test('renderDesign：drawGuides 增加引导路径、单点笔迹画实心圆', () => {
  const strokes = [
    { color: '#c8102e', width: 0.008, points: [{ x: 0.5, y: 0.2 }, { x: 0.55, y: 0.3 }, { x: 0.48, y: 0.38 }] },
  ];
  const folds = 4;
  const plain = createFakeCtx();
  renderDesign(plain, strokes, { folds, size: 400 });
  const guided = createFakeCtx();
  renderDesign(guided, strokes, { folds, size: 400, drawGuides: true });

  assert.equal(guided.count('save'), guided.count('restore'));
  assert.ok(guided.count('stroke') > plain.count('stroke'), 'guides add paths');
  assert.equal(guided.count('stroke'), plain.count('stroke') + 2);
  assert.equal(guided.count('beginPath') - plain.count('beginPath'), 3);
  assert.equal(guided.count('setLineDash'), 2);
  assert.equal(guided.count('arc'), plain.count('arc') + 2);
  assert.equal(guided.count('moveTo') - plain.count('moveTo'), 2);

  const dotStrokes = [{ color: '#c8102e', width: 0.02, points: [{ x: 0.5, y: 0.25 }] }];
  const dotCtx = createFakeCtx();
  renderDesign(dotCtx, dotStrokes, { folds: 4, size: 400 });
  assert.equal(dotCtx.count('fill'), 2 * folds);
  assert.equal(dotCtx.count('stroke'), 0);
  assert.equal(dotCtx.count('arc'), 2 * folds);
  assert.deepEqual(dotCtx.calls.find((call) => call.name === 'arc').args, [0.5, 0.25, 0.01, 0, 2 * Math.PI]);
  assert.equal(dotCtx.count('save'), dotCtx.count('restore'));

  const empty = createFakeCtx();
  renderDesign(empty, [], { folds: 8, size: 400, drawGuides: true });
  assert.equal(empty.count('save'), empty.count('restore'));
  assert.equal(empty.count('transform'), 0);
  assert.equal(empty.count('stroke'), 2);
});
