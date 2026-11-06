/**
 * 场景时间轴：用纯数学替换 Remotion 的 TransitionSeries / Sequence。
 * - frame → 当前激活场景层（含转场重叠区间）
 * - frame → 全局进度
 * 转场变换与编辑器预览共用 sceneMotion 的确定性公式。
 */
import {calculateTotalDuration, DEFAULT_SCENE_DURATION, TRANSITION_DURATION} from '../../src/core/videoConfig.js';
import {getSceneTransitionState} from '../../src/core/sceneMotion.js';
import type {ThemeType} from '../videoTypes';
import {interpolate} from './math.js';
import type {FrameLayer, FrameState, SceneInput, SceneTiming, Timeline} from './types';

/** 旧场景未携带转场时保留原主题行为。 */
function transitionKind(
  transition: SceneTiming['transition'],
  theme: ThemeType,
): NonNullable<SceneTiming['transition']> {
  return transition ?? 'fade';
}

/**
 * 构建时间轴。start_i = Σ_{j<i} base_j；sequenceDuration_i = base_i + τ；
 * total = Σ base + τ（与 calculateTotalDuration 一致）。
 */
export function buildTimeline(scenes: readonly SceneInput[], fps: number): Timeline {
  let cursor = 0;
  const timings = scenes.map((scene, index) => {
    const baseDuration = scene.durationInFrames || DEFAULT_SCENE_DURATION;
    const timing = {
      index,
      transition: scene.transition,
      baseDuration,
      sequenceDuration: baseDuration + TRANSITION_DURATION,
      startFrame: cursor,
    };
    cursor += baseDuration;
    return timing;
  });
  return {
    scenes: timings,
    totalDuration: calculateTotalDuration(scenes),
    fps,
  };
}

interface FrameStateOptions {
  theme: ThemeType;
  width: number;
  height: number;
}

/**
 * 计算某一全局帧的场景层与进度。
 * 正常区间只有 1 层；转场重叠区间通常有 2 层，cut 只保留入场层。
 */
export function getFrameState(timeline: Timeline, frame: number, options: FrameStateOptions): FrameState {
  const {theme, width, height} = options;
  const {scenes, totalDuration} = timeline;

  const progress = interpolate(frame, [0, Math.max(1, totalDuration)], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 收集所有 localFrame ∈ [0, sequenceDuration) 的候选场景。
  const candidates = scenes.filter((s) => {
    const local = frame - s.startFrame;
    return local >= 0 && local < s.sequenceDuration;
  });

  if (candidates.length === 0) {
    return {layers: [], progress};
  }

  if (candidates.length === 1) {
    const s = candidates[0];
    return {
      layers: [{sceneIndex: s.index, localFrame: frame - s.startFrame, opacity: 1, offsetX: 0, offsetY: 0, scale: 1}],
      progress,
    };
  }

  // 转场重叠：candidates = [出场景 i, 入场景 i+1]。
  const outgoing = candidates[0];
  const incoming = candidates[1];
  // 转场本地帧 = frame - 入场景起点（0..τ）。
  const transitionFrame = frame - incoming.startFrame;
  const kind = transitionKind(incoming.transition, theme);
  const transition = getSceneTransitionState(kind, transitionFrame / TRANSITION_DURATION);
  const layers: FrameLayer[] = [];
  if (transition.outgoing.visible) {
    layers.push({
      sceneIndex: outgoing.index,
      localFrame: frame - outgoing.startFrame,
      opacity: transition.outgoing.opacity,
      offsetX: transition.outgoing.translateX * width,
      offsetY: transition.outgoing.translateY * height,
      scale: transition.outgoing.scale,
    });
  }
  if (transition.incoming.visible) {
    layers.push({
      sceneIndex: incoming.index,
      localFrame: transitionFrame,
      opacity: transition.incoming.opacity,
      offsetX: transition.incoming.translateX * width,
      offsetY: transition.incoming.translateY * height,
      scale: transition.incoming.scale,
    });
  }

  return {layers, progress};
}
