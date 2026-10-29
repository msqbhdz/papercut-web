import test from 'node:test';
import assert from 'node:assert/strict';
import { __remapPointsForTest } from '../js/draw.v10.js';

const CENTER = { x: 0.5, y: 0.5 };
const AXIS = -Math.PI / 2;
const TAU = Math.PI * 2;

function polarPoint(offsetDegrees, radius) {
  const angle = AXIS + (offsetDegrees * Math.PI) / 180;
  return { x: CENTER.x + radius * Math.cos(angle), y: CENTER.y + radius * Math.sin(angle) };
}

function offsetDegreesOf(p) {
  let offset = (Math.atan2(p.y - CENTER.y, p.x - CENTER.x) - AXIS) % TAU;
  if (offset > Math.PI) offset -= TAU;
  if (offset <= -Math.PI) offset += TAU;
  return (offset * 180) / Math.PI;
}

function radiusOf(p) {
  return Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
}

function assertClose(actual, expected, message, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, message + ': ' + actual + ' != ' + expected);
}

test('remapPoints：2→12 把 80° 偏差角等比缩到约 13.333°', () => {
  const [mapped] = __remapPointsForTest([polarPoint(80, 0.3)], 2, 12);
  const offset = offsetDegreesOf(mapped);
  assertClose(offset, 80 / 6, '2→12 offset');
  assert.ok(Math.abs(offset) <= 15, 'inside 12-fold sector: ' + offset);
});

test('remapPoints：2→12→2 可逆，坐标最大偏差 < 1e-9', () => {
  let worst = 0;
  for (const degrees of [-89.9, -60, -45, -13.3, 0, 7.7, 30, 60, 89.9]) {
    const start = polarPoint(degrees, 0.42);
    const back = __remapPointsForTest(__remapPointsForTest([start], 2, 12), 12, 2)[0];
    worst = Math.max(worst, Math.abs(back.x - start.x), Math.abs(back.y - start.y));
  }
  assert.ok(worst < 1e-9, 'max coordinate drift: ' + worst);
});

test('remapPoints：半径保持不变、超界夹到 0.5、圆心点仍是圆心', () => {
  const [kept] = __remapPointsForTest([polarPoint(50, 0.3)], 2, 12);
  assertClose(radiusOf(kept), 0.3, 'radius kept');
  const [shrunk] = __remapPointsForTest([polarPoint(30, 0.8)], 2, 12);
  assertClose(radiusOf(shrunk), 0.5, 'radius clamped');
  assertClose(radiusOf(__remapPointsForTest([polarPoint(-30, 0.5000001)], 12, 2)[0]), 0.5, 'radius clamped upward');
  assert.deepEqual(__remapPointsForTest([CENTER], 2, 12), [CENTER]);
  assert.deepEqual(__remapPointsForTest([CENTER], 12, 2), [CENTER]);
});

test('remapPoints：越界偏差角 -170° 经 12 折夹到 -15° 最近边界', () => {
  const [mapped] = __remapPointsForTest([polarPoint(-170, 0.4)], 2, 12);
  assertClose(offsetDegreesOf(mapped), -15, 'clamped offset');
  assertClose(radiusOf(mapped), 0.4, 'radius kept while clamping');
});

test('remapPoints：空数组与单点数组的退化输入', () => {
  assert.deepEqual(__remapPointsForTest([], 4, 8), []);
  const single = __remapPointsForTest([polarPoint(10, 0.2)], 12, 2);
  assert.equal(single.length, 1);
  assert.ok(Number.isFinite(single[0].x) && Number.isFinite(single[0].y), 'finite coordinates');
});

test('remapPoints：返回全新数组与点对象，不修改输入', () => {
  const points = [polarPoint(80, 0.3), polarPoint(40, 0.25), CENTER];
  const snapshot = points.map((p) => ({ x: p.x, y: p.y }));
  const mapped = __remapPointsForTest(points, 2, 12);
  assert.notEqual(mapped, points, 'new array');
  assert.equal(mapped.length, points.length);
  for (let i = 0; i < points.length; i += 1) {
    assert.notEqual(mapped[i], points[i], 'new point object ' + i);
  }
  assert.deepEqual(points, snapshot, 'input points untouched');
});
