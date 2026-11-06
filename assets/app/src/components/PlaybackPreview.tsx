import {memo, useMemo, useSyncExternalStore, type CSSProperties, type ReactNode} from 'react';
import {TARGET_FPS, TRANSITION_DURATION} from '../core/videoConfig';
import type {IllustrationRegion, IllustrationScene} from '../core/types';
import {sampleSmoothClosedCurve} from '../core/regionGeometry';
import {getSceneCameraState, getSceneTransitionState} from '../core/sceneMotion';
import {clamp, formatTime, getRegionAnimationStyle} from '../core/utils';

export type PlaybackTimeStore = {
  getSnapshot: () => number;
  set: (time: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createPlaybackTimeStore = (initialTime = 0): PlaybackTimeStore => {
  let time = initialTime;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => time,
    set: (nextTime) => {
      if (Object.is(time, nextTime)) return;
      time = nextTime;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const usePlaybackTime = (store: PlaybackTimeStore) => useSyncExternalStore(
  store.subscribe,
  store.getSnapshot,
  store.getSnapshot,
);
const SCENE_TRANSITION_SECONDS = TRANSITION_DURATION / TARGET_FPS;

const relativeCurvePolygon = (region: IllustrationRegion) => sampleSmoothClosedCurve(region.points)
  .map((point) => {
    const x = ((point.x - region.rect.x) / region.rect.width) * 100;
    const y = ((point.y - region.rect.y) / region.rect.height) * 100;
    return `${clamp(x, 0, 100).toFixed(2)}% ${clamp(y, 0, 100).toFixed(2)}%`;
  })
  .join(', ');

type PreparedRegion = {
  region: IllustrationRegion;
  maskStyle: CSSProperties;
  cropStyle: CSSProperties;
  imageStyle: CSSProperties;
};

type PreparedRegionLayers = {
  maskRegions: PreparedRegion[];
  cropRegions: PreparedRegion[];
};

const prepareRegionLayers = (
  regions: IllustrationRegion[],
  backgroundColor: string,
): PreparedRegionLayers => {
  const maskRegions: PreparedRegion[] = [];
  const cropRegions: PreparedRegion[] = [];
  for (const region of regions) {
    const clipPath = region.selectionType === 'freehand' && region.points.length >= 3
      ? `polygon(${relativeCurvePolygon(region)})`
      : undefined;
    const boundsStyle: CSSProperties = {
      left: `${region.rect.x * 100}%`,
      top: `${region.rect.y * 100}%`,
      width: `${region.rect.width * 100}%`,
      height: `${region.rect.height * 100}%`,
    };
    const prepared: PreparedRegion = {
      region,
      maskStyle: {
        ...boundsStyle,
        zIndex: region.alwaysHidden ? 99999 : 1,
        backgroundColor,
        clipPath,
      },
      cropStyle: {
        ...boundsStyle,
        zIndex: region.zIndex,
        clipPath,
      },
      imageStyle: {
        width: `${100 / region.rect.width}%`,
        height: `${100 / region.rect.height}%`,
        left: `${(-region.rect.x / region.rect.width) * 100}%`,
        top: `${(-region.rect.y / region.rect.height) * 100}%`,
      },
    };
    if (region.visible) maskRegions.push(prepared);
    if (!region.alwaysHidden) cropRegions.push(prepared);
  }
  return {maskRegions, cropRegions};
};

export const PlaybackTimeLabel = memo(({
  store,
  totalDuration,
}: {
  store: PlaybackTimeStore;
  totalDuration: number;
}) => {
  const currentTime = usePlaybackTime(store);
  return <div className="j-simple-time">{formatTime(currentTime)} / {formatTime(totalDuration)}</div>;
});

/** 仅订阅高频播放时间并把共享镜头状态应用到画面容器。 */
export const AnimatedSceneFrame = memo(({
  children,
  enabled,
  hasPrevious,
  scene,
  sceneIndex,
  store,
  style,
}: {
  children: ReactNode;
  enabled: boolean;
  hasPrevious: boolean;
  scene: IllustrationScene;
  sceneIndex: number;
  store: PlaybackTimeStore;
  style: CSSProperties;
}) => {
  const currentTime = usePlaybackTime(store);
  const camera = getSceneCameraState(sceneIndex, currentTime - scene.startTime, scene.duration);
  const incoming = enabled && hasPrevious
    ? getSceneTransitionState(
      scene.transition,
      (currentTime - scene.startTime) / SCENE_TRANSITION_SECONDS,
    ).incoming
    : {opacity: 1, translateX: 0, translateY: 0, scale: 1};
  const cameraStyle: CSSProperties = enabled ? {
    opacity: incoming.opacity,
    transform: `translate(${(camera.translateX + incoming.translateX) * 100}%, ${(camera.translateY + incoming.translateY) * 100}%) scale(${camera.scale * incoming.scale})`,
    transformOrigin: 'center',
    willChange: 'opacity, transform',
  } : {};
  return <div className="j-image-frame" style={{...style, ...cameraStyle}}>{children}</div>;
});

/** 在场景转场期间绘制上一场景，转场结束后不保留额外 DOM。 */
export const AnimatedPreviousSceneFrame = memo(({
  enabled,
  incomingScene,
  previousScene,
  previousSceneIndex,
  contentStyle,
  store,
  style,
}: {
  enabled: boolean;
  incomingScene: IllustrationScene;
  previousScene: IllustrationScene;
  previousSceneIndex: number;
  contentStyle: CSSProperties;
  store: PlaybackTimeStore;
  style: CSSProperties;
}) => {
  const currentTime = usePlaybackTime(store);
  const transitionTime = currentTime - incomingScene.startTime;
  if (!enabled || transitionTime < 0 || transitionTime > SCENE_TRANSITION_SECONDS) return null;
  const outgoing = getSceneTransitionState(
    incomingScene.transition,
    transitionTime / SCENE_TRANSITION_SECONDS,
  ).outgoing;
  if (!outgoing.visible) return null;
  const camera = getSceneCameraState(
    previousSceneIndex,
    currentTime - previousScene.startTime,
    previousScene.duration,
  );
  const motionStyle: CSSProperties = {
    ...style,
    opacity: outgoing.opacity,
    transform: `translate(${(camera.translateX + outgoing.translateX) * 100}%, ${(camera.translateY + outgoing.translateY) * 100}%) scale(${camera.scale * outgoing.scale})`,
    transformOrigin: 'center',
    willChange: 'opacity, transform',
  };
  return (
    <div className="j-transition-scene-shell" aria-hidden="true">
      <div className="j-image-frame" style={motionStyle}>
        <div style={contentStyle}>
          <img className="j-main-image" src={previousScene.imageUrl} alt="" draggable={false} />
          <div className="j-image-overlay tool-select">
            <AnimatedRegionLayers store={store} scene={previousScene} />
          </div>
        </div>
      </div>
    </div>
  );
});

export const AnimatedRegionLayers = memo(({
  store,
  scene,
}: {
  store: PlaybackTimeStore;
  scene?: IllustrationScene;
}) => {
  const currentTime = usePlaybackTime(store);
  const regions = scene?.regions;
  const backgroundColor = scene?.backgroundColor || '#ffffff';
  const preparedRegions = useMemo(
    () => prepareRegionLayers(regions ?? [], backgroundColor),
    [backgroundColor, regions],
  );
  if (!scene) return null;
  return (
    <>
      {preparedRegions.maskRegions.map(({region, maskStyle}) => (
        <div
          key={`mask-${region.id}`}
          className="j-region-mask"
          style={maskStyle}
        />
      ))}
      {preparedRegions.cropRegions.map(({region, cropStyle, imageStyle}) => {
        const {clipPath: revealClip, ...animationStyle} = getRegionAnimationStyle(region, currentTime);
        return (
        <div
          key={region.id}
          className="j-crop-region"
          style={{...cropStyle, ...animationStyle}}
        >
          <div className="j-region-reveal" style={{clipPath: revealClip}}>
          <img
            src={scene.imageUrl}
            alt=""
            draggable={false}
            style={imageStyle}
          />
          </div>
        </div>
        );
      })}
    </>
  );
});
