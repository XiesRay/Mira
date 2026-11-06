import {memo, useSyncExternalStore} from 'react';
import {formatTime} from '../core/utils';
import type {PlaybackTimeStore} from './PlaybackPreview';

export const PlaybackControls = memo(({store, total, playing, onSeek, onToggle}: {
  store: PlaybackTimeStore;
  total: number;
  playing: boolean;
  onSeek: (time: number) => void;
  onToggle: () => void;
}) => {
  const time = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <div className="playback-controls">
    <button className="primary" disabled={!total} onClick={onToggle}>{playing ? '暂停' : '播放'}</button>
    <input type="range" aria-label="播放进度" min="0" max={total || 1} step="0.01" value={time} onChange={(event) => onSeek(Number(event.target.value))} />
    <output>{formatTime(time)} <span>/ {formatTime(total)}</span></output>
  </div>;
});
