import type {IllustrationRegion} from './types';

const MIN_DURATION = 0.42;
const MAX_DURATION = 0.95;
const MAX_BEAT_SECONDS = 0.55;
const MAX_SEQUENCE_SECONDS = 6;
const RHYTHM = [0.82, 1.12, 0.9, 1.2] as const;

const roundTime = (value: number) => Math.round(value * 100) / 100;

/** 区域动画按固定短节拍连续出现，长口播也不会拉长区域间隔。 */
export const scheduleRegionPlaybackTimes = (
  sceneDuration: number,
  effects: IllustrationRegion['effect'][],
  sceneStartTime = 0,
) => {
  const beats = effects.map((_, index) => RHYTHM[index % RHYTHM.length]);
  const totalBeats = beats.reduce((total, beat) => total + beat, 0);
  const sequenceDuration = Math.min(MAX_SEQUENCE_SECONDS, Math.max(0, sceneDuration - 0.62));
  const beatSeconds = Math.min(MAX_BEAT_SECONDS, sequenceDuration / totalBeats);
  let elapsedBeats = 0;
  return effects.map((effect, index) => {
    const beatDuration = beatSeconds * beats[index];
    const startTime = sceneStartTime + 0.2 + beatSeconds * elapsedBeats;
    elapsedBeats += beats[index];
    const durationScale = effect === 'wipe' ? 0.82 : effect === 'pop' ? 0.72 : 0.64;
    return {
      startTime: roundTime(startTime),
      duration: roundTime(Math.min(
        MAX_DURATION,
        Math.max(MIN_DURATION, beatDuration * durationScale),
      )),
    };
  });
};

export const scheduleRegionPlayback = <T extends {startTime: number; duration: number; effect: IllustrationRegion['effect']; alwaysHidden?: boolean}>(
  regions: T[],
  sceneDuration: number,
  sceneStartTime = 0,
): T[] => {
  const times = scheduleRegionPlaybackTimes(
    sceneDuration,
    regions.filter((region) => !region.alwaysHidden).map((region) => region.effect),
    sceneStartTime,
  );
  let index = 0;
  return regions.map((region) => region.alwaysHidden ? region : {...region, ...times[index++]});
};
