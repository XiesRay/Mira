/** sceneMotion.ts 的确定性镜头、转场与区域编排测试。 */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {
  getSceneCameraState,
  getSceneTransitionState,
  selectRegionMotion,
  selectSceneTransition,
} from '../src/core/sceneMotion.js';
import type {IllustrationRegion} from '../src/core/types.js';

const region = (rect: IllustrationRegion['rect']): IllustrationRegion => ({
  id: 'region',
  name: '区域',
  selectionType: 'rectangle',
  alwaysHidden: false,
  points: [],
  rect,
  effect: 'fade',
  direction: 'left-to-right',
  startTime: 0,
  duration: 0.6,
  initialVisible: false,
  keepVisible: true,
  zIndex: 10,
  locked: false,
  visible: true,
});

test('镜头运动由场景序号和时间确定', () => {
  assert.deepEqual(getSceneCameraState(0, 0, 6), getSceneCameraState(0, 0, 6));
  assert.notDeepEqual(getSceneCameraState(0, 0, 6), getSceneCameraState(0, 6, 6));
  assert.notDeepEqual(getSceneCameraState(0, 3, 6), getSceneCameraState(1, 3, 6));
});

test('转场保留首场景 cut，并让尾场景使用 zoom', () => {
  assert.equal(selectSceneTransition(0, 5), 'cut');
  assert.equal(selectSceneTransition(2, 5), 'push-right');
  assert.equal(selectSceneTransition(4, 5), 'zoom');
});

test('push-left 的预览和导出共享归一化层状态', () => {
  const state = getSceneTransitionState('push-left', 0.5);
  assert.equal(state.outgoing.translateX, -0.5);
  assert.equal(state.incoming.translateX, 0.5);
  assert.equal(state.incoming.opacity, 1);
});

test('cut 不绘制出场层', () => {
  const state = getSceneTransitionState('cut', 0);
  assert.equal(state.outgoing.visible, false);
  assert.equal(state.incoming.visible, true);
});

test('横向区域使用方向 wipe', () => {
  assert.deepEqual(
    selectRegionMotion(region({x: 0.05, y: 0.3, width: 0.4, height: 0.1}), 0),
    {effect: 'wipe', direction: 'left-to-right'},
  );
});

test('画面两侧的小区域统一从左侧滑入', () => {
  assert.equal(
    selectRegionMotion(region({x: 0.05, y: 0.2, width: 0.12, height: 0.15}), 0).effect,
    'slide-left',
  );
  assert.equal(
    selectRegionMotion(region({x: 0.78, y: 0.2, width: 0.12, height: 0.15}), 0).effect,
    'slide-left',
  );
});
