export type RegionEffect = 'appear' | 'fade' | 'pop' | 'slide-left' | 'slide-right' | 'slide-up' | 'wipe';
export type ExportFormat = 'mp4' | 'gif';
export type SceneTransition = 'cut' | 'fade' | 'push-left' | 'push-right' | 'zoom';
export type ArrowDirection = 'left-to-right' | 'right-to-left' | 'top-to-bottom' | 'bottom-to-top'
  | 'top-left-to-bottom-right' | 'bottom-left-to-top-right';

export interface NormalizedPoint {x: number; y: number}
export interface NormalizedRect extends NormalizedPoint {width: number; height: number}

export interface IllustrationRegion {
  id: string;
  name: string;
  isAutoLast?: boolean;
  selectionType: 'rectangle' | 'freehand';
  alwaysHidden: boolean;
  points: NormalizedPoint[];
  rect: NormalizedRect;
  effect: RegionEffect;
  direction: ArrowDirection;
  startTime: number;
  duration: number;
  initialVisible: boolean;
  keepVisible: boolean;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export interface IllustrationScene {
  id: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  backgroundColor: string;
  startTime: number;
  duration: number;
  transition: SceneTransition;
  regions: IllustrationRegion[];
}

export interface Project {
  format: 'mira' | 'region-motion';
  version: 1;
  name: string;
  scenes: IllustrationScene[];
}
