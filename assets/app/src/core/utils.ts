import type {CSSProperties} from 'react';
import type {IllustrationRegion, NormalizedPoint, NormalizedRect} from './types';
import {getRegionAnimationState, wipeClipPathCss} from './regionAnimation';

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const getPointsBounds = (points: NormalizedPoint[]): NormalizedRect => {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return normalizeRect({x: minX, y: minY, width: maxX - minX, height: maxY - minY});
};

export const simplifyPoints = (points: NormalizedPoint[], maxPoints = 96) => {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index === 0 || index === points.length - 1 || index % step === 0);
};

export const roundTime = (value: number) => Math.round(value * 100) / 100;

export const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const hundredths = Math.floor((safe % 1) * 100);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
};

export const getRegionAnimationStyle = (
  region: IllustrationRegion,
  currentTime: number,
): CSSProperties => {
  const state = getRegionAnimationState(region, currentTime);
  if (state.hidden) return {display: 'none'};
  if (!state.active) return {opacity: 0, pointerEvents: 'none'};
  if (region.effect === 'wipe' && state.wipeProgress !== null) {
    return {opacity: 1, clipPath: wipeClipPathCss(region.direction, state.wipeProgress)};
  }

  const style: CSSProperties = {opacity: state.opacity};
  const transforms: string[] = [];
  if (state.translateX !== 0) transforms.push(`translateX(${state.translateX}px)`);
  if (state.translateY !== 0) transforms.push(`translateY(${state.translateY}px)`);
  if (state.scale !== 1) transforms.push(`scale(${state.scale})`);
  if (transforms.length > 0) style.transform = transforms.join(' ');
  return style;
};

export const normalizeRect = (rect: NormalizedRect): NormalizedRect => {
  const x = clamp(rect.x, 0, 0.98);
  const y = clamp(rect.y, 0, 0.98);
  return {
    x,
    y,
    width: clamp(rect.width, 0.02, 1 - x),
    height: clamp(rect.height, 0.02, 1 - y),
  };
};

export const translatePolygonEdge = (
  points: NormalizedPoint[],
  edgeIndex: number,
  requestedDx: number,
  requestedDy: number,
): NormalizedPoint[] => {
  if (points.length < 3 || edgeIndex < 0 || edgeIndex >= points.length) return points;
  const nextIndex = (edgeIndex + 1) % points.length;
  const left = points[edgeIndex];
  const right = points[nextIndex];
  const dx = clamp(requestedDx, -Math.min(left.x, right.x), 1 - Math.max(left.x, right.x));
  const dy = clamp(requestedDy, -Math.min(left.y, right.y), 1 - Math.max(left.y, right.y));
  return points.map((point, index) =>
    index === edgeIndex || index === nextIndex
      ? {x: point.x + dx, y: point.y + dy}
      : point);
};
