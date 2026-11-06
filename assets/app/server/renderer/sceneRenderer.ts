/**
 * 场景层合成：将 timeline 计算出的每个 FrameLayer 绘制到目标 ctx。
 * - opacity===1：直接绘制（正常帧 / push 出入场，支持位移和缩放）
 * - opacity<1：先绘制到离屏画布，再以组透明度整体 drawImage（正确复刻 CSS 组透明度，
 *   避免图层内重叠元素在淡入时出现接缝）
 * 插画内容应用场景镜头，字幕保持在画布坐标内；两者再随场景层完成转场。
 */
import {createCanvas, type SKRSContext2D} from '@napi-rs/canvas';
import {DEFAULT_SCENE_DURATION} from '../../src/core/videoConfig.js';
import {getSceneCameraState} from '../../src/core/sceneMotion.js';
import {renderIllustration} from './regionRenderer.js';
import type {FrameLayer, RenderAssets, VideoData} from './types';

export function renderSceneLayer(
  ctx: SKRSContext2D,
  layer: FrameLayer,
  videoData: VideoData,
  assets: RenderAssets,
  width: number,
  height: number,
  fps: number,
): void {
  const scene = videoData.scenes[layer.sceneIndex];
  if (!scene) return;

  const isCoverCapture = Boolean(videoData.isCoverCapture);
  const currentTime = layer.localFrame / fps;
  const baseDuration = scene.durationInFrames || DEFAULT_SCENE_DURATION;

  const drawContent = (target: SKRSContext2D) => {
    const camera = isCoverCapture
      ? {translateX: 0, translateY: 0, scale: 1}
      : getSceneCameraState(layer.sceneIndex, currentTime, baseDuration / fps);
    target.save();
    target.translate(camera.translateX * width, camera.translateY * height);
    target.translate(width / 2, height / 2);
    target.scale(camera.scale, camera.scale);
    target.translate(-width / 2, -height / 2);
    renderIllustration(target, scene, assets, width, height, currentTime, layer.sceneIndex);
    target.restore();
  };

  const applyLayerTransform = (target: SKRSContext2D) => {
    if (layer.offsetX !== 0 || layer.offsetY !== 0) target.translate(layer.offsetX, layer.offsetY);
    if (layer.scale !== 1) {
      target.translate(width / 2, height / 2);
      target.scale(layer.scale, layer.scale);
      target.translate(-width / 2, -height / 2);
    }
  };

  if (layer.opacity >= 1) {
    ctx.save();
    applyLayerTransform(ctx);
    drawContent(ctx);
    ctx.restore();
    return;
  }

  // 组透明度：离屏满不透明绘制后整体合成。
  const off = createCanvas(width, height);
  const offCtx = off.getContext('2d');
  drawContent(offCtx);

  ctx.save();
  applyLayerTransform(ctx);
  ctx.globalAlpha = layer.opacity;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}
