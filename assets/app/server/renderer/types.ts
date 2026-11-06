import type {Image, SKRSContext2D} from '@napi-rs/canvas';
import type {LayoutData, VideoData} from '../videoTypes';

/** 区域数据（与 LayoutData.regions 元素一致）。 */
export type RegionInput = NonNullable<LayoutData['regions']>[number];

/** 场景数据（与 LayoutData 一致）。 */
export type SceneInput = LayoutData;

export type {VideoData};

/**
 * 渲染前预加载好的素材集合。
 * - images: 以“已解析的本地路径 / URL 原始字符串”为 key。
 * - background: 全局背景图（可选）。
 */
export interface RenderAssets {
  images: Map<string, Image>;
  background?: Image;
}

/** 单个场景在时间轴上的定位。 */
export interface SceneTiming {
  index: number;
  /** 当前场景的入场转场；旧数据缺省时由主题提供回退值。 */
  transition?: NonNullable<SceneInput['transition']>;
  /** 场景本体帧数（不含转场缓冲）。 */
  baseDuration: number;
  /** TransitionSeries.Sequence 帧数 = baseDuration + TRANSITION_DURATION。 */
  sequenceDuration: number;
  /** 场景在全局时间轴上的起始帧 = Σ_{j<i} baseDuration_j。 */
  startFrame: number;
}

export interface Timeline {
  scenes: SceneTiming[];
  totalDuration: number;
  fps: number;
}

/** 某一帧上处于激活态的场景层。按绘制顺序排列（先出场景，后入场景）。 */
export interface FrameLayer {
  sceneIndex: number;
  /** 场景本地帧（frame - startFrame）。 */
  localFrame: number;
  /** 层整体不透明度（转场淡入淡出）。 */
  opacity: number;
  /** 层整体位移（转场滑动，像素）。 */
  offsetX: number;
  offsetY: number;
  /** 层整体缩放（转场缩放，1 表示原尺寸）。 */
  scale: number;
}

export interface FrameState {
  layers: FrameLayer[];
  /** 全局进度条百分比 [0,100]。 */
  progress: number;
}

/** 确定性逐帧渲染入口参数。 */
export interface RenderFrameArgs {
  ctx: SKRSContext2D;
  frame: number;
  fps: number;
  width: number;
  height: number;
  videoData: VideoData;
  assets: RenderAssets;
  timeline: Timeline;
}
