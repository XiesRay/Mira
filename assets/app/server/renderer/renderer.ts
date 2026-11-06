/**
 * 渲染编排：串联字体注册 → 素材预加载 → 时间轴 → 逐帧 Canvas 绘制 → FFmpeg 编码。
 * 产出 1x base 视频，倍速由调用方（server.ts）复用现有 postProcessVideo 处理。
 *
 * 两种模式：
 * - renderVideoQuick：Canvas 帧经 rawvideo 管道直传 FFmpeg（快速导出，不落盘 JPEG）
 * - renderFramesToDir：Canvas 帧写入 JPEG 序列（批量 / 断点续渲），再由 encodeFrameFilesToVideo 编码
 */
import fs from 'fs';
import path from 'path';
import {once} from 'events';
import {type Canvas, createCanvas} from '@napi-rs/canvas';
import {loadRenderAssets} from './assetLoader.js';
import {ensureFontsRegistered, renderFrame} from './canvasRenderer.js';
import {encodeRawFramesToVideo} from './ffmpegEncoder.js';
import {buildTimeline} from './timeline.js';
import type {RenderAssets, Timeline, VideoData} from './types';

export interface RenderContext {
  width: number;
  height: number;
  fps: number;
  videoData: VideoData;
  publicDir: string;
  timeline: Timeline;
  assets: RenderAssets;
  totalFrames: number;
}

/** 预备渲染上下文：注册字体、预加载素材、构建时间轴。 */
export async function prepareRenderContext(
  videoData: VideoData,
  options: {width: number; height: number; fps: number; publicDir: string},
): Promise<RenderContext> {
  ensureFontsRegistered();
  const scenes = Array.isArray(videoData.scenes) ? videoData.scenes : [];
  const timeline = buildTimeline(scenes, options.fps);
  const assets = await loadRenderAssets(videoData, {publicDir: options.publicDir});
  return {
    ...options,
    videoData,
    timeline,
    assets,
    totalFrames: timeline.totalDuration,
  };
}

function drawFrameInto(canvas: Canvas, ctx: RenderContext, frame: number): void {
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  renderFrame({
    ctx: context,
    frame,
    fps: ctx.fps,
    width: ctx.width,
    height: ctx.height,
    videoData: ctx.videoData,
    assets: ctx.assets,
    timeline: ctx.timeline,
  });
}

export interface RenderHooks {
  /** 返回 true 时中止渲染并清理资源。 */
  shouldCancel?: () => boolean;
  /** 进度回调（已完成帧数 / 总帧数）。 */
  onProgress?: (done: number, total: number) => void;
}

/** 快速导出：逐帧 rawvideo 管道直传 FFmpeg。 */
export async function renderVideoQuick(
  render: RenderContext,
  outputPath: string,
  hooks: RenderHooks = {},
): Promise<void> {
  const canvas = createCanvas(render.width, render.height);
  const encoder = await encodeRawFramesToVideo({
    width: render.width,
    height: render.height,
    fps: render.fps,
    totalFrames: render.totalFrames,
    outputPath,
    videoData: render.videoData,
    timeline: render.timeline,
    publicDir: render.publicDir,
  });

  try {
    for (let frame = 0; frame < render.totalFrames; frame++) {
      if (hooks.shouldCancel?.()) {
        encoder.cancel();
        throw new Error('渲染已取消');
      }
      drawFrameInto(canvas, render, frame);
      const buffer = canvas.data(); // RGBA 原始像素
      const ok = encoder.frameStream.write(buffer);
      if (!ok) await Promise.race([
        once(encoder.frameStream, 'drain'),
        encoder.done.then(() => {throw new Error('编码器提前结束');}),
      ]);
      hooks.onProgress?.(frame + 1, render.totalFrames);
    }
    await encoder.finish();
  } catch (err) {
    encoder.cancel();
    throw err;
  }
}

/**
 * 批量 / 断点续渲：逐帧写 JPEG 到 framesDir（element-%04d.jpeg，0 基）。
 * startFrame 支持断点续渲（只补齐缺失帧）。返回实际渲染的帧区间。
 */
export async function renderFramesToDir(
  render: RenderContext,
  framesDir: string,
  options: {startFrame?: number; jpegQuality?: number; hooks?: RenderHooks} = {},
): Promise<{from: number; to: number}> {
  const {startFrame = 0, jpegQuality = 90, hooks = {}} = options;
  fs.mkdirSync(framesDir, {recursive: true});
  const canvas = createCanvas(render.width, render.height);

  for (let frame = startFrame; frame < render.totalFrames; frame++) {
    if (hooks.shouldCancel?.()) {
      throw new Error('渲染已取消');
    }
    drawFrameInto(canvas, render, frame);
    const buffer = await canvas.encode('jpeg', jpegQuality);
    const name = `element-${String(frame).padStart(4, '0')}.jpeg`;
    // 子进程可能随时取消；只有写完整的帧才参与下次断点续渲。
    const target = path.join(framesDir, name);
    const temporary = path.join(framesDir, `.${name}.${process.pid}.tmp`);
    try {
      await fs.promises.writeFile(temporary, buffer);
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, {force: true});
    }
    hooks.onProgress?.(frame - startFrame + 1, render.totalFrames - startFrame);
  }
  return {from: startFrame, to: render.totalFrames - 1};
}
