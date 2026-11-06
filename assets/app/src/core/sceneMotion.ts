/** 预览与 Canvas 导出共用的确定性镜头、区域和转场选择。 */
import type {IllustrationRegion, SceneTransition} from './types';

/** 场景镜头状态；预览使用归一化位移，Canvas 导出按画布尺寸换算为像素。 */
export interface SceneCameraState {
  /** 相对场景宽度的水平位移。 */
  translateX: number;
  /** 相对场景高度的垂直位移。 */
  translateY: number;
  /** 绕场景中心缩放的倍率。 */
  scale: number;
}

/** 单个场景层在转场中的可见性与归一化变换。 */
export interface SceneTransitionLayerState {
  /** false 时该层不参与当前帧绘制。 */
  visible: boolean;
  /** 场景层整体不透明度。 */
  opacity: number;
  /** 相对场景宽度的水平位移。 */
  translateX: number;
  /** 相对场景高度的垂直位移。 */
  translateY: number;
  /** 绕场景中心缩放的倍率。 */
  scale: number;
}

/** 转场中出场与入场两个场景层的状态。 */
export interface SceneTransitionState {
  outgoing: SceneTransitionLayerState;
  incoming: SceneTransitionLayerState;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
};
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;
const assertNever = (value: never): never => {
  throw new Error(`不支持的场景转场：${String(value)}`);
};

/**
 * 按场景序号生成稳定的轻镜头运动。
 *
 * @param sceneIndex 场景在项目中的零基序号。
 * @param currentTime 当前场景内的播放秒数。
 * @param duration 场景持续秒数。
 * @returns 可同时用于 CSS 与 Canvas 的归一化镜头状态。
 */
export function getSceneCameraState(
  sceneIndex: number,
  currentTime: number,
  duration: number,
): SceneCameraState {
  const progress = smoothstep(currentTime / Math.max(0.05, duration));
  switch (Math.abs(sceneIndex) % 4) {
    case 0:
      return {
        translateX: 0,
        translateY: mix(0.004, -0.004, progress),
        scale: mix(1.016, 1.046, progress),
      };
    case 1:
      return {
        translateX: mix(0.012, -0.012, progress),
        translateY: mix(-0.003, 0.003, progress),
        scale: 1.044,
      };
    case 2:
      return {
        translateX: mix(-0.004, 0.004, progress),
        translateY: mix(-0.006, 0.004, progress),
        scale: mix(1.054, 1.022, progress),
      };
    default:
      return {
        translateX: mix(-0.012, 0.012, progress),
        translateY: mix(0.003, -0.003, progress),
        scale: 1.044,
      };
  }
}

/**
 * 为进入当前场景的转场选择确定性节奏。
 *
 * @param sceneIndex 当前场景序号；首场景没有入场转场。
 * @param sceneCount 项目场景总数。
 * @returns 当前场景的入场转场。
 */
export function selectSceneTransition(sceneIndex: number, sceneCount: number): SceneTransition {
  if (sceneIndex <= 0) return 'cut';
  if (sceneIndex === sceneCount - 1) return 'zoom';
  return 'push-right';
}

/**
 * 计算预览与导出共用的场景转场状态。
 *
 * @param transition 当前入场景选择的转场。
 * @param rawProgress 转场归一化进度；函数会限制到 0..1。
 * @returns 出场与入场场景层的可见性和变换。
 */
export function getSceneTransitionState(
  transition: SceneTransition,
  rawProgress: number,
): SceneTransitionState {
  const progress = smoothstep(rawProgress);
  const still: SceneTransitionLayerState = {
    visible: true,
    opacity: 1,
    translateX: 0,
    translateY: 0,
    scale: 1,
  };

  switch (transition) {
    case 'cut':
      return {
        outgoing: {...still, visible: false, opacity: 0},
        incoming: still,
      };
    case 'push-left':
      return {
        outgoing: {...still, translateX: -progress},
        incoming: {...still, translateX: 1 - progress},
      };
    case 'push-right':
      return {
        outgoing: {...still, translateX: progress},
        incoming: {...still, translateX: progress - 1},
      };
    case 'zoom':
      return {
        outgoing: {...still, scale: 1 - 0.025 * progress},
        incoming: {
          ...still,
          opacity: progress,
          scale: 1.06 - 0.06 * progress,
        },
      };
    case 'fade':
      return {
        outgoing: still,
        incoming: {...still, opacity: progress},
      };
    default:
      return assertNever(transition);
  }
}

/**
 * 依据区域几何特征选择稳定的入场效果和方向。
 *
 * @param region 待编排的区域。
 * @param index 区域在当前场景动画序列中的序号。
 * @returns 区域入场效果和方向。
 */
export function selectRegionMotion(region: IllustrationRegion, index: number): Pick<
  IllustrationRegion,
  'effect' | 'direction'
> {
  const {width, height, x, y} = region.rect;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const area = width * height;

  if (width >= height * 2.2) {
    return {
      effect: 'wipe',
      direction: 'left-to-right',
    };
  }
  if (height >= width * 2.4) {
    return {
      effect: 'wipe',
      direction: 'left-to-right',
    };
  }
  if (area >= 0.11 || (centerX >= 0.38 && centerX <= 0.62 && centerY <= 0.62)) {
    return {effect: 'pop', direction: 'left-to-right'};
  }
  if (centerX < 0.36 || centerX > 0.64) {
    return {effect: 'slide-left', direction: 'left-to-right'};
  }
  if (centerY > 0.58) return {effect: 'slide-up', direction: 'left-to-right'};
  return {effect: index % 2 === 0 ? 'fade' : 'pop', direction: 'left-to-right'};
}
