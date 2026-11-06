import type {ArrowDirection, IllustrationRegion} from './types';

/**
 * 与 React / DOM / Remotion / Canvas 均无关的区域动画纯函数。
 *
 * 编辑器预览（utils.getRegionAnimationStyle）与服务端 Canvas 导出
 * （server-renderer/regionRenderer）都必须使用这里的计算结果，
 * 保证预览与导出的动画公式完全一致。
 */
export interface RegionAnimationState {
  /** region.visible === false：该区域完全不渲染（等价 display:none）。 */
  hidden: boolean;
  /**
   * 区域是否处于"已激活"状态。
   * false 表示尚未开始 / 已过期（opacity 0，预览端 pointerEvents:none）。
   */
  active: boolean;
  /** 0..1 */
  opacity: number;
  /** 位移（合成分辨率下的像素，与 CSS translateX 数值一致）。 */
  translateX: number;
  translateY: number;
  /** 缩放倍率。 */
  scale: number;
  /** wipe 缓动进度 [0,1]；非激活 wipe 时为 null。 */
  wipeProgress: number | null;
}

const clampLocal = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const IDLE_STATE: Readonly<RegionAnimationState> = {
  hidden: false,
  active: false,
  opacity: 0,
  translateX: 0,
  translateY: 0,
  scale: 1,
  wipeProgress: null,
};

/**
 * 计算区域在 currentTime（秒，相对场景起点）时的动画状态。
 * 逐条复现原 utils.getRegionAnimationStyle / IllustrationLayout.regionAnimationStyle 的公式。
 */
/**
 * getRegionAnimationState 实际读取的字段子集。
 * 编辑器的完整 IllustrationRegion 与导出端的 LayoutData.regions 元素都满足此结构，
 * 从而让预览端与 Canvas 导出端复用同一份动画公式。
 */
export type RegionAnimationInput = Pick<
  IllustrationRegion,
  'visible' | 'startTime' | 'duration' | 'initialVisible' | 'keepVisible' | 'effect'
>;

export const getRegionAnimationState = (
  region: RegionAnimationInput,
  currentTime: number,
): RegionAnimationState => {
  if (!region.visible) return {...IDLE_STATE, hidden: true};

  const rawProgress = (currentTime - region.startTime) / Math.max(0.05, region.duration);
  const progress = clampLocal(rawProgress, 0, 1);
  const shown = region.initialVisible || rawProgress >= 0;
  const expired = !region.keepVisible && rawProgress > 1;
  if (!shown || expired) return {...IDLE_STATE};
  if (region.initialVisible && rawProgress < 0) {
    return {...IDLE_STATE, active: true, opacity: 1};
  }

  const eased = 1 - Math.pow(1 - progress, 2);
  const easedCubic = 1 - Math.pow(1 - progress, 3);
  const overshoot = 1 + 2.35 * Math.pow(progress - 1, 3) + 1.35 * Math.pow(progress - 1, 2);
  const wipeEased = progress * progress * (3 - 2 * progress);
  switch (region.effect) {
    case 'appear':
      return {...IDLE_STATE, active: true, opacity: progress > 0 ? 1 : 0};
    case 'fade':
      return {...IDLE_STATE, active: true, opacity: eased};
    case 'pop':
      return {...IDLE_STATE, active: true, opacity: eased, scale: 0.9 + 0.1 * overshoot};
    case 'slide-left':
      return {
        ...IDLE_STATE,
        active: true,
        opacity: easedCubic,
        translateX: (1 - easedCubic) * -36,
        scale: 0.985 + 0.015 * easedCubic,
      };
    case 'slide-right':
      return {
        ...IDLE_STATE,
        active: true,
        opacity: easedCubic,
        translateX: (1 - easedCubic) * 36,
        scale: 0.985 + 0.015 * easedCubic,
      };
    case 'slide-up':
      return {
        ...IDLE_STATE,
        active: true,
        opacity: easedCubic,
        translateY: (1 - easedCubic) * 32,
        scale: 0.985 + 0.015 * easedCubic,
      };
    case 'wipe':
      return {...IDLE_STATE, active: true, opacity: 1, wipeProgress: wipeEased};
    default:
      return {...IDLE_STATE, active: true, opacity: 1};
  }
};

/**
 * wipe 效果的 CSS clip-path 字符串，供编辑器预览使用。
 * 与原实现使用同一套方向映射（整数百分比）。
 */
export const wipeClipPathCss = (
  direction: ArrowDirection,
  wipeProgress: number,
): string => {
  const p = Math.round(wipeProgress * 100);
  const clips: Record<ArrowDirection, string> = {
    'left-to-right': `inset(0 ${100 - p}% 0 0)`,
    'right-to-left': `inset(0 0 0 ${100 - p}%)`,
    'top-to-bottom': `inset(0 0 ${100 - p}% 0)`,
    'bottom-to-top': `inset(${100 - p}% 0 0 0)`,
    'top-left-to-bottom-right': `polygon(0 0, ${p}% 0, 0 ${p}%)`,
    'bottom-left-to-top-right': `polygon(0 100%, ${p}% 100%, 0 ${100 - p}%)`,
  };
  return clips[direction];
};
