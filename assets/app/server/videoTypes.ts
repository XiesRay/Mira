import type {IllustrationRegion, SceneTransition} from '../src/core/types';

export type ThemeType = 'tech-dark';
export interface LayoutData {
  type: 'illustration';
  title: string;
  backgroundColor: string;
  images: string[];
  durationInFrames: number;
  transition?: SceneTransition;
  regions: IllustrationRegion[];
}
export interface VideoData {
  theme: ThemeType;
  hideProgressBar: boolean;
  isCoverCapture?: boolean;
  backgroundImage?: string;
  scenes: LayoutData[];
}
