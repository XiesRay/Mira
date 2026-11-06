import {useCallback, useEffect, useRef, useState} from 'react';
import {createPlaybackTimeStore} from './PlaybackPreview';
import {clamp} from '../core/utils';
import {TARGET_FPS, TRANSITION_DURATION} from '../core/videoConfig';
import type {IllustrationScene} from '../core/types';

export function usePlayback(scenes: IllustrationScene[]) {
  const [store] = useState(() => createPlaybackTimeStore());
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState('');
  const origin = useRef({time: 0, wall: 0});
  const lastScene = scenes.at(-1);
  const total = lastScene ? lastScene.startTime + lastScene.duration + TRANSITION_DURATION / TARGET_FPS : 0;
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((time: number) => {
    const next = clamp(time, 0, total);
    origin.current = {time: next, wall: performance.now()};
    store.set(next);
    const scene = [...scenes].reverse().find((scene) => next >= scene.startTime) ?? scenes[0];
    setActiveSceneId(scene?.id ?? '');
  }, [scenes, total, store]);

  useEffect(() => {
    pause();
    seek(Math.min(store.getSnapshot(), total));
  }, [total, seek, pause, store]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    origin.current = {time: store.getSnapshot(), wall: performance.now()};
    const tick = (now: number) => {
      const next = Math.min(total, origin.current.time + (now - origin.current.wall) / 1000);
      store.set(next);
      const scene = [...scenes].reverse().find((scene) => next >= scene.startTime) ?? scenes[0];
      setActiveSceneId((previous) => previous === scene?.id ? previous : scene?.id ?? '');
      if (next >= total) {pause(); return;}
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const hidden = () => {if (document.hidden) pause();};
    document.addEventListener('visibilitychange', hidden);
    return () => {cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', hidden);};
  }, [playing, scenes, total, store, pause]);

  const play = useCallback(() => {
    if (!scenes.length) return;
    if (store.getSnapshot() >= total - 0.01) store.set(0);
    setPreview(true);
    setPlaying(true);
  }, [scenes.length, store, total]);

  return {store, playing, preview, setPreview, activeSceneId, total, pause, seek, play};
}
