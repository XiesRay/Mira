/**
 * 确定性逐帧渲染入口。同一 frame + 同一输入必产出同一画面：
 * 不依赖 performance.now() / Date.now() / 真实播放时间。
 *
 * 绘制顺序（复刻 Composition.MyComposition 的堆叠）：
 *   1. 主题背景（纯色回退；插画场景使用每页不透明底色，实际覆盖主题背景/overlay/全局背景图，
 *      故 spotlight/grid/glow/vignette/背景图在导出中不可见，记为已知无差异跳过）
 *   2. 场景层（TransitionSeries，z10；含转场重叠与字幕）
 *   3. 顶部进度条（z100；hideProgressBar 时不绘制）
 */
import fs from 'fs';
import {GlobalFonts, type SKRSContext2D} from '@napi-rs/canvas';
import {getFrameState} from './timeline.js';
import {renderSceneLayer} from './sceneRenderer.js';
import type {RenderFrameArgs} from './types';

/** 主题背景纯色回退（插画页面底色会覆盖，仅防止极端情况下的空隙）。 */
const THEME_BG_FALLBACK: Record<string, string> = {
  'tech-dark': '#454035',
  dhl: '#d40511',
  apple: '#f5f5f7',
  'tech-purple': '#0b1020',
  'morning-daily': '#fff7ed',
  'aurora-night': '#020617',
  'claude-warm': '#2a211c',
};

/** 进度条填充色 + 辉光，来自 themes 的 progressClass。 */
const PROGRESS_FILL: Record<string, {color: string; glow: string; blur: number}> = {
  'tech-dark': {color: '#fbbf24', glow: 'rgba(251,191,36,0.50)', blur: 28},
  dhl: {color: '#ffcc00', glow: 'rgba(255,204,0,0.48)', blur: 18},
  apple: {color: '#0066cc', glow: 'rgba(0,102,204,0.26)', blur: 14},
  'tech-purple': {color: '#c084fc', glow: 'rgba(192,132,252,0.32)', blur: 18},
  'morning-daily': {color: '#f97316', glow: 'rgba(245,158,11,0.28)', blur: 14},
  'aurora-night': {color: '#fdba74', glow: 'rgba(125,211,252,0.32)', blur: 18},
  'claude-warm': {color: '#d97757', glow: 'rgba(217,119,87,0.32)', blur: 16},
};

const CJK_FONT_CANDIDATES: {path: string; family: string}[] = [
  {path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC'},
  {path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB'},
  {path: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'Heiti TC'},
  {path: '/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB'},
];

let fontsRegistered = false;

/** 幂等注册 CJK 字体，确保中文测量/绘制可用。渲染前调用一次。 */
export function ensureFontsRegistered(): void {
  if (fontsRegistered) return;
  fontsRegistered = true;
  for (const {path, family} of CJK_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(path)) GlobalFonts.registerFromPath(path, family);
    } catch {
      // 单个字体注册失败不阻断（后续 fallback sans-serif 仍可测量 CJK）。
    }
  }
}

function drawProgressBar(ctx: SKRSContext2D, progress: number, theme: string, width: number): void {
  const barHeight = 12; // h-3
  ctx.save();
  // 轨道 bg-black/20。
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(0, 0, width, barHeight);
  // 填充。
  const fill = PROGRESS_FILL[theme] ?? PROGRESS_FILL['tech-dark'];
  const fillWidth = (Math.max(0, Math.min(100, progress)) / 100) * width;
  if (fillWidth > 0) {
    ctx.shadowColor = fill.glow;
    ctx.shadowBlur = fill.blur;
    ctx.fillStyle = fill.color;
    ctx.fillRect(0, 0, fillWidth, barHeight);
  }
  ctx.restore();
}

/** 逐帧渲染入口。 */
export function renderFrame(args: RenderFrameArgs): void {
  const {ctx, frame, fps, width, height, videoData, assets, timeline} = args;
  const theme = videoData.theme || 'tech-dark';

  // 1. 主题背景纯色回退。
  ctx.save();
  ctx.fillStyle = THEME_BG_FALLBACK[theme] ?? '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // 2. 场景层（含转场与字幕）。
  const state = getFrameState(timeline, frame, {theme, width, height});
  for (const layer of state.layers) {
    renderSceneLayer(ctx, layer, videoData, assets, width, height, fps);
  }

  // 3. 顶部进度条。
  if (!videoData.hideProgressBar) {
    drawProgressBar(ctx, state.progress, theme, width);
  }
}
