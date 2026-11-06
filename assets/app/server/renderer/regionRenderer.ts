/**
 * 区域渲染：在 Canvas 上还原 IllustrationLayout 的插画画面。
 * - 页面底色 → base 图(object-contain) → 底色遮罩 → 区域副本(object-cover, 动画)
 * - 始终隐藏遮罩位于所有区域副本之上，避免交叉框选时被重新盖回
 * - 矩形 / 自由多边形 / wipe 六方向裁剪
 * - 容器 transform（绕窗口中心的 translate/scale）
 * - 按 (zIndex asc, DOM 顺序) 绘制
 * 动画数值统一来自 regionAnimation.getRegionAnimationState。
 */
import type {Image, SKRSContext2D} from '@napi-rs/canvas';
import {getRegionAnimationState} from '../../src/core/regionAnimation.js';
import {getSmoothClosedCurve} from '../../src/core/regionGeometry.js';
import type {RegionInput, RenderAssets, SceneInput} from './types';

/** object-contain：等比缩放至完全容纳于目标框，居中，可能留白。 */
export function drawImageContain(
  ctx: SKRSContext2D,
  img: Image,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const scale = Math.min(dw / img.width, dh / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/** object-cover：等比缩放至完全覆盖目标框，居中，可能裁剪。 */
export function drawImageCover(
  ctx: SKRSContext2D,
  img: Image,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const scale = Math.max(dw / img.width, dh / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

const clampLocal = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 自由曲线裁剪路径（场景坐标），与编辑器中的二次贝塞尔曲线一致。 */
function clipFreehand(
  ctx: SKRSContext2D,
  region: RegionInput,
  width: number,
  height: number,
): void {
  const rx = region.rect.x * width;
  const ry = region.rect.y * height;
  const rw = region.rect.width * width;
  const rh = region.rect.height * height;
  const curve = getSmoothClosedCurve(region.points.map((point) => ({
    x: clampLocal(point.x * width, rx, rx + rw),
    y: clampLocal(point.y * height, ry, ry + rh),
  })));
  if (!curve) return;
  ctx.beginPath();
  ctx.moveTo(curve.start.x, curve.start.y);
  curve.segments.forEach(({start, control, end}, index) => {
    if (index > 0) ctx.lineTo(start.x, start.y);
    ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  });
  ctx.closePath();
  ctx.clip();
}

/** wipe 裁剪（场景坐标），映射 6 个方向；amount=round(wipeProgress*100)。 */
function clipWipe(
  ctx: SKRSContext2D,
  region: RegionInput,
  wipeProgress: number,
  width: number,
  height: number,
): void {
  const rx = region.rect.x * width;
  const ry = region.rect.y * height;
  const rw = region.rect.width * width;
  const rh = region.rect.height * height;
  const a = Math.round(wipeProgress * 100) / 100;
  ctx.beginPath();
  switch (region.direction) {
    case 'left-to-right':
      ctx.rect(rx, ry, rw * a, rh);
      break;
    case 'right-to-left':
      ctx.rect(rx + rw * (1 - a), ry, rw * a, rh);
      break;
    case 'top-to-bottom':
      ctx.rect(rx, ry, rw, rh * a);
      break;
    case 'bottom-to-top':
      ctx.rect(rx, ry + rh * (1 - a), rw, rh * a);
      break;
    case 'top-left-to-bottom-right':
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx + rw * a, ry);
      ctx.lineTo(rx, ry + rh * a);
      ctx.closePath();
      break;
    case 'bottom-left-to-top-right':
      ctx.moveTo(rx, ry + rh);
      ctx.lineTo(rx + rw * a, ry + rh);
      ctx.lineTo(rx, ry + rh * (1 - a));
      ctx.closePath();
      break;
  }
  ctx.clip();
}

/** 单个可绘制单元，按 (z, seq) 排序后依次绘制。 */
interface Drawable {
  z: number;
  seq: number;
  draw: () => void;
}

/**
 * 在场景坐标 (0,0,width,height) 内绘制一个插画场景。
 * currentTime：相对场景起点的秒数（= localFrame / fps）。
 */
export function renderIllustration(
  ctx: SKRSContext2D,
  scene: SceneInput,
  assets: RenderAssets,
  width: number,
  height: number,
  currentTime: number,
  sceneIndex: number,
): void {
  const backgroundColor = scene.backgroundColor || '#ffffff';

  // 每页插画使用从图片边缘估算的底色。
  ctx.save();
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const baseSrc = scene.images?.[0];
  const image = baseSrc ? assets.images.get(baseSrc) : undefined;
  if (baseSrc && !image) {
    throw new Error(`区域渲染失败 [场景#${sceneIndex}]：base 图未预加载 src="${baseSrc}"`);
  }

  const activeRegions = (scene.regions || []).filter((r) => r.visible);
  const drawables: Drawable[] = [];
  let seq = 0;

  // base 图（object-contain），z=0。
  if (image) {
    drawables.push({
      z: 0,
      seq: seq++,
      draw: () => drawImageContain(ctx, image, 0, 0, width, height),
    });
  }

  // 普通底色遮罩位于 z=1；始终隐藏遮罩最终绘制，确保不会被区域副本盖回。
  activeRegions.forEach((region) => {
    drawables.push({
      z: region.alwaysHidden ? 99999 : 1,
      seq: seq++,
      draw: () => {
        const rx = region.rect.x * width;
        const ry = region.rect.y * height;
        const rw = region.rect.width * width;
        const rh = region.rect.height * height;
        ctx.save();
        if (region.selectionType === 'freehand' && region.points.length >= 3) {
          clipFreehand(ctx, region, width, height);
        }
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.restore();
      },
    });
  });

  // 区域副本（object-cover，动画），z=region.zIndex。仅在有 base 图时绘制。
  if (image) {
    activeRegions.filter((region) => !region.alwaysHidden).forEach((region) => {
      drawables.push({
        z: region.zIndex,
        seq: seq++,
        draw: () => drawRegionCopy(ctx, region, image, width, height, currentTime),
      });
    });
  }

  // 稳定排序：z 升序，seq 升序（复刻 CSS 定位元素同栈绘制顺序）。
  drawables
    .map((d, i) => ({d, i}))
    .sort((a, b) => (a.d.z - b.d.z) || (a.d.seq - b.d.seq) || (a.i - b.i))
    .forEach(({d}) => d.draw());
}

function drawRegionCopy(
  ctx: SKRSContext2D,
  region: RegionInput,
  image: Image,
  width: number,
  height: number,
  currentTime: number,
): void {
  const state = getRegionAnimationState(region, currentTime);
  if (state.hidden || !state.active || state.opacity <= 0) return;

  const rx = region.rect.x * width;
  const ry = region.rect.y * height;
  const rw = region.rect.width * width;
  const rh = region.rect.height * height;
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;

  ctx.save();
  // 容器 transform：translate 偏移 + 绕窗口中心缩放（与 CSS transformOrigin:center 等价）。
  if (state.translateX !== 0 || state.translateY !== 0) {
    ctx.translate(state.translateX, state.translateY);
  }
  if (state.scale !== 1) {
    ctx.translate(cx, cy);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-cx, -cy);
  }

  // 裁剪：rect 窗口始终生效；wipe 覆盖 freehand（spread 顺序）。
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  if (region.effect === 'wipe' && state.wipeProgress !== null) {
    clipWipe(ctx, region, state.wipeProgress, width, height);
  } else if (region.selectionType === 'freehand' && region.points.length >= 3) {
    clipFreehand(ctx, region, width, height);
  }

  ctx.globalAlpha *= state.opacity;
  // 副本图以 object-cover 铺满整个场景 (0,0,W,H)，再由上面的裁剪限定到窗口内。
  drawImageCover(ctx, image, 0, 0, width, height);
  ctx.restore();
}
