/**
 * regionAnimation.ts 单元测试：区域动画公式（预览端与 Canvas 导出端共用的唯一来源）。
 * 任何取整/缓动差异都会导致预览与导出不一致，这是本次迁移的核心红线。
 */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {
  getRegionAnimationState,
  wipeClipPathCss,
  type RegionAnimationInput,
} from '../src/core/regionAnimation.js';

const region = (over: Partial<RegionAnimationInput>): RegionAnimationInput => ({
  visible: true,
  startTime: 1,
  duration: 2,
  initialVisible: false,
  keepVisible: true,
  effect: 'fade',
  ...over,
});

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

test('visible=false 完全隐藏', () => {
  const s = getRegionAnimationState(region({visible: false}), 5);
  assert.equal(s.hidden, true);
  assert.equal(s.active, false);
});

test('尚未开始且非 initialVisible → 未激活', () => {
  const s = getRegionAnimationState(region({initialVisible: false}), 0); // rawProgress<0
  assert.equal(s.active, false);
  assert.equal(s.opacity, 0);
});

test('initialVisible 在开始前保持完全可见', () => {
  const s = getRegionAnimationState(region({initialVisible: true}), 0);
  assert.equal(s.active, true);
  assert.equal(s.opacity, 1);
});

test('已过期且不保留 → 未激活', () => {
  const s = getRegionAnimationState(region({keepVisible: false}), 100); // rawProgress>1
  assert.equal(s.active, false);
});

test('fade：中点 opacity=easeOutQuad(0.5)=0.75', () => {
  const s = getRegionAnimationState(region({effect: 'fade'}), 2); // progress 0.5
  assert.equal(s.active, true);
  close(s.opacity, 0.75);
});

test('appear：进度>0 立即 opacity=1', () => {
  const s = getRegionAnimationState(region({effect: 'appear'}), 2);
  assert.equal(s.opacity, 1);
});

test('pop：中点使用轻微回弹缩放', () => {
  const s = getRegionAnimationState(region({effect: 'pop'}), 2);
  close(s.scale, 0.9 + 0.1 * (1 + 2.35 * Math.pow(-0.5, 3) + 1.35 * Math.pow(-0.5, 2)));
  close(s.opacity, 0.75);
});

test('slide-left：使用三次缓动并伴随轻微缩放', () => {
  const s = getRegionAnimationState(region({effect: 'slide-left'}), 2);
  const easedCubic = 0.875;
  close(s.translateX, (1 - easedCubic) * -36);
  close(s.scale, 0.985 + 0.015 * easedCubic);
});

test('wipe：opacity=1 且 wipeProgress=smoothstep', () => {
  const s = getRegionAnimationState(region({effect: 'wipe'}), 2);
  assert.equal(s.opacity, 1);
  close(s.wipeProgress!, 0.5);
});

test('wipeClipPathCss 方向映射与整数百分比', () => {
  assert.equal(wipeClipPathCss('left-to-right', 0.75), 'inset(0 25% 0 0)');
  assert.equal(wipeClipPathCss('right-to-left', 0.75), 'inset(0 0 0 25%)');
  assert.equal(wipeClipPathCss('top-to-bottom', 0.5), 'inset(0 0 50% 0)');
});
