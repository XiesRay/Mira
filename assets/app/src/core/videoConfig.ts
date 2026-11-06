export const TARGET_FPS = 30;
export const DEFAULT_SCENE_DURATION = TARGET_FPS * 5;
export const TRANSITION_DURATION = Math.round(TARGET_FPS * 0.36);
export const AUDIO_BUFFER_FRAMES = Math.round(TARGET_FPS * 0.27);

export const secondsToFrames = (
  seconds: number,
  fps: number = TARGET_FPS,
): number => Math.max(1, Math.ceil(Math.max(0, seconds) * fps));

export const framesToSeconds = (
  frames: number,
  fps: number = TARGET_FPS,
): number => Math.max(0, frames) / fps;

export const calculateTotalDuration = (
  scenes: ReadonlyArray<{ durationInFrames?: number }> | undefined,
): number => {
  if (!scenes?.length) return DEFAULT_SCENE_DURATION;
  const sceneFrames = scenes.reduce(
    (total, scene) => total + (scene.durationInFrames || DEFAULT_SCENE_DURATION),
    0,
  );
  // 每个场景增加转场缓冲，相邻场景再重叠同样的帧数，最终只保留一段尾部缓冲。
  return Math.max(1, sceneFrames + TRANSITION_DURATION);
};
