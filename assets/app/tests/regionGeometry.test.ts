import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSmoothClosedCurve,
  getSmoothClosedCurvePath,
  MAX_CLOSED_POLYGON_POINTS,
  sanitizeClosedPolygon,
  sampleSmoothClosedCurve,
} from '../src/core/regionGeometry';

const square = [
  {x: 0, y: 0},
  {x: 1, y: 0},
  {x: 1, y: 1},
  {x: 0, y: 1},
];

test('闭合平滑曲线只在拐角附近圆滑并保留边线主体', () => {
  const curve = getSmoothClosedCurve(square);
  assert.deepEqual(curve?.start, {x: 0, y: 0.03});
  assert.deepEqual(curve?.segments.map((segment) => segment.end), [
    {x: 0.03, y: 0},
    {x: 1, y: 0.03},
    {x: 0.97, y: 1},
    {x: 0, y: 0.97},
  ]);
});

test('SVG 路径使用闭合二次贝塞尔命令', () => {
  const path = getSmoothClosedCurvePath(square);
  assert.match(path, /^M 0 0\.03 Q /);
  assert.equal(path.match(/Q /g)?.length, square.length);
  assert.equal(path.match(/L /g)?.length, square.length - 1);
  assert.match(path, / Z$/);
});

test('曲线采样数量稳定且所有点都位于控制点边界内', () => {
  const sampled = sampleSmoothClosedCurve(square, 4);
  assert.equal(sampled.length, 20);
  assert.ok(sampled.every((point) => (
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
  )));
});

test('重复顶点和折返支线自动退化为外接框', () => {
  const folded = [
    {x: 0.1, y: 0.1},
    {x: 0.9, y: 0.1},
    {x: 0.8, y: 0.4},
    {x: 0.9, y: 0.1},
    {x: 0.9, y: 0.9},
    {x: 0.1, y: 0.9},
  ];

  assert.deepEqual(sanitizeClosedPolygon(folded), [
    {x: 0.9, y: 0.1},
    {x: 0.9, y: 0.9},
    {x: 0.1, y: 0.9},
    {x: 0.1, y: 0.1},
  ]);
  assert.equal(getSmoothClosedCurve(folded)?.segments.length, 4);
});

test('密集闭合轮廓保留外形并限制为固定点数', () => {
  const dense = Array.from({length: 1100}, (_, index) => {
    const angle = (index / 1100) * Math.PI * 2;
    const radius = 0.3 + 0.035 * Math.sin(angle * 4);
    return {
      x: 0.5 + radius * Math.cos(angle),
      y: 0.5 + radius * Math.sin(angle),
    };
  });
  const simplified = sanitizeClosedPolygon(dense);
  const denseArea = dense.reduce((sum, point, index) => {
    const next = dense[(index + 1) % dense.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const simplifiedArea = simplified.reduce((sum, point, index) => {
    const next = simplified[(index + 1) % simplified.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  assert.ok(simplified.length >= 3);
  assert.ok(simplified.length <= MAX_CLOSED_POLYGON_POINTS);
  assert.ok(simplified.every((point) =>
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  assert.ok(Math.sign(simplifiedArea) === Math.sign(denseArea));
  assert.ok(Math.abs(simplifiedArea) > Math.abs(denseArea) * 0.98);
});

test('小三角形保留三个点并将坐标限制在归一化范围', () => {
  const triangle = [
    {x: -0.2, y: 0.2},
    {x: 0.4, y: 0.2},
    {x: 0.1, y: 1.2},
  ];

  assert.deepEqual(sanitizeClosedPolygon(triangle), [
    {x: 0, y: 0.2},
    {x: 0.4, y: 0.2},
    {x: 0.1, y: 1},
  ]);
});
