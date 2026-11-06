import {sanitizeClosedPolygon} from './regionGeometry';
import {scheduleRegionPlaybackTimes} from './regionTiming';
import {selectRegionMotion} from './sceneMotion';
import {clamp, getPointsBounds, normalizeRect} from './utils';
import type {IllustrationRegion, IllustrationScene, NormalizedPoint, NormalizedRect, Project} from './types';

export const emptyProject = (): Project => ({format: 'mira', version: 1, name: '未命名项目', scenes: []});
export const MAX_SCENES = 30;
export const MAX_REGIONS = 100;
export const MAX_PROJECT_BYTES = 80 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export function arrangeScenes(scenes: IllustrationScene[]): IllustrationScene[] {
  let startTime = 0;
  return scenes.map((scene) => {
    const delta = startTime - scene.startTime;
    const next = {...scene, startTime,
      regions: scene.regions.map((region) => ({...region, startTime: region.startTime + delta})),
    };
    startTime += scene.duration;
    return next;
  });
}

export function makeRegion(rect: NormalizedRect, points: NormalizedPoint[] = [], alwaysHidden = false): IllustrationRegion {
  return {id: crypto.randomUUID(), name: alwaysHidden ? '隐藏区域' : '新区域',
    selectionType: points.length >= 3 ? 'freehand' : 'rectangle', alwaysHidden,
    points: points.length >= 3 ? sanitizeClosedPolygon(points) : [], rect: normalizeRect(rect),
    effect: 'fade', direction: 'left-to-right', startTime: 0.2, duration: 0.6,
    initialVisible: false, keepVisible: true, zIndex: 10, locked: false, visible: true};
}

/** 与原项目一致：整图末位区域固定在最后。 */
export function keepAutoLastRegionLast(regions: IllustrationRegion[]): IllustrationRegion[] {
  const autoLast = [...regions].reverse().find((region) => region.isAutoLast);
  if (!autoLast) return regions;
  return [...regions.filter((region) => !region.isAutoLast && region.id !== autoLast.id), autoLast];
}

export function markAutoLastRegion(regions: IllustrationRegion[]): IllustrationRegion[] {
  return regions.map((region, index) => ({...region, isAutoLast: index === regions.length - 1}));
}

export function scheduleScene(scene: IllustrationScene): IllustrationScene {
  const ordered = keepAutoLastRegionLast(scene.regions);
  const count = ordered.filter((region) => !region.alwaysHidden).length;
  const times = scheduleRegionPlaybackTimes(scene.duration,
    ordered.filter((region) => !region.alwaysHidden).map((region, index) =>
      index === count - 1 ? 'appear' : selectRegionMotion(region, index).effect), scene.startTime);
  let index = 0;
  return {...scene, regions: ordered.map((region) => {
    if (region.alwaysHidden) return {...region, name: '始终隐藏', initialVisible: false, keepVisible: false, visible: true, locked: false};
    const position = index++;
    const motion = position === count - 1 ? {effect: 'appear' as const, direction: 'left-to-right' as const}
      : selectRegionMotion(region, position);
    return {...region, ...motion, ...times[position], name: `区域 ${position + 1}`,
      initialVisible: false, keepVisible: true, visible: true, locked: false, zIndex: 10 + position};
  })};
}

export function addRegions(scene: IllustrationScene, regions: IllustrationRegion[]): IllustrationScene {
  const ordered = keepAutoLastRegionLast(scene.regions);
  const lastIndex = ordered.findIndex((region) => region.isAutoLast);
  const insertionIndex = lastIndex < 0 ? ordered.length : lastIndex;
  return scheduleScene({...scene, regions: [...ordered.slice(0, insertionIndex), ...regions, ...ordered.slice(insertionIndex)]});
}

export function readFile(file: File): Promise<string> {
  if (file.size > MAX_MEDIA_BYTES) throw new Error('单个素材不能超过 20 MB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export async function readImage(file: File): Promise<IllustrationScene> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  }
  const imageUrl = await readFile(file);
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('图片不能超过 4000 万像素');
  return {id: crypto.randomUUID(), name: file.name, imageUrl, width: image.naturalWidth, height: image.naturalHeight,
    backgroundColor: '#ffffff', startTime: 0, duration: 6, transition: 'fade', regions: []};
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目字段格式不正确');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('项目文字字段格式不正确');
  return value;
};
const number = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error('项目数值超出允许范围');
  }
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('项目开关字段格式不正确');
  return value;
};
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (!values.includes(value as T)) throw new Error('项目含不支持的动画或方向');
  return value as T;
};
const list = (value: unknown, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error('项目列表超出允许范围');
  return value;
};

function parseRegion(value: unknown): IllustrationRegion {
  const raw = record(value);
  const box = record(raw.rect);
  const x = number(box.x, 0, 1);
  const y = number(box.y, 0, 1);
  const rect = {x, y, width: number(box.width, 0.001, 1), height: number(box.height, 0.001, 1)};
  if (rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) throw new Error('区域超出图片边界');
  const selectionType = oneOf(raw.selectionType, ['rectangle', 'freehand']);
  const points = sanitizeClosedPolygon(list(raw.points, 64).map((point) => {
    const p = record(point);
    return {x: number(p.x, 0, 1), y: number(p.y, 0, 1)};
  }));
  if (selectionType === 'freehand' && points.length < 3) throw new Error('自由选区至少需要 3 个点');
  return {id: crypto.randomUUID(), name: string(raw.name), selectionType,
    isAutoLast: raw.isAutoLast === true,
    rect: selectionType === 'freehand' ? getPointsBounds(points) : rect, points,
    effect: oneOf(raw.effect, ['appear', 'fade', 'pop', 'slide-left', 'slide-right', 'slide-up', 'wipe']),
    direction: oneOf(raw.direction, ['left-to-right', 'right-to-left', 'top-to-bottom', 'bottom-to-top',
      'top-left-to-bottom-right', 'bottom-left-to-top-right']),
    startTime: number(raw.startTime, 0, 108000), duration: number(raw.duration, 0.05, 3600),
    alwaysHidden: boolean(raw.alwaysHidden), initialVisible: boolean(raw.initialVisible),
    keepVisible: boolean(raw.keepVisible), locked: boolean(raw.locked), visible: boolean(raw.visible),
    zIndex: number(raw.zIndex, 2, 1000)};
}

/** 只接收自包含本地素材，导入项目不会加载远程 URL。 */
export function parseProject(value: unknown): Project {
  const raw = record(value);
  if (!['mira', 'region-motion'].includes(String(raw.format)) || raw.version !== 1) throw new Error('请选择 Mira 项目文件');
  const scenes = list(raw.scenes, MAX_SCENES).map((value): IllustrationScene => {
    const scene = record(value);
    const imageUrl = string(scene.imageUrl, 30_000_000);
    if (!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(imageUrl)) throw new Error('项目图片必须为内嵌 PNG、JPEG 或 WebP');
    const backgroundColor = string(scene.backgroundColor);
    if (!/^#[0-9a-fA-F]{6}$/.test(backgroundColor)) throw new Error('项目背景色格式不正确');
    const width = number(scene.width, 1, 40000);
    const height = number(scene.height, 1, 40000);
    if (width * height > 40_000_000) throw new Error('图片不能超过 4000 万像素');
    return {id: crypto.randomUUID(), name: string(scene.name), imageUrl, width, height, backgroundColor,
      startTime: number(scene.startTime, 0, 108000), duration: number(scene.duration, 0.5, 3600),
      transition: oneOf(scene.transition, ['cut', 'fade', 'push-left', 'push-right', 'zoom']),
      regions: list(scene.regions, MAX_REGIONS).map(parseRegion),
    };
  });
  return {format: 'mira', version: 1, name: string(raw.name), scenes: arrangeScenes(scenes)};
}

export function downloadProject(project: Project): void {
  const content = JSON.stringify(project, null, 2);
  const blob = new Blob([content], {type: 'application/json'});
  if (blob.size > MAX_PROJECT_BYTES) throw new Error('项目超过 80 MB，请减少图片或压缩图片后保存');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'project'}.mira.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 以浏览器实际显示的像素制作导出副本，避免素材的容器或元数据与原生解码器不兼容。 */
export async function prepareExportProject(project: Project): Promise<Project> {
  const scenes: IllustrationScene[] = [];
  for (const scene of project.scenes) {
    const image = new Image();
    image.src = scene.imageUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法准备导出图片');
    context.drawImage(image, 0, 0);
    const imageUrl = canvas.toDataURL('image/png');
    if (imageUrl.length * 0.75 > MAX_MEDIA_BYTES) throw new Error('图片转换为 PNG 后超过 20 MB，请先缩小图片再导出');
    scenes.push({...scene, imageUrl, width: image.naturalWidth, height: image.naturalHeight});
  }
  const prepared = {...project, scenes};
  if (new Blob([JSON.stringify(prepared)]).size > MAX_PROJECT_BYTES) throw new Error('导出图片总量超过 80 MB，请减少图片或拆分项目');
  return prepared;
}

export function moveRegion(region: IllustrationRegion, dx: number, dy: number): IllustrationRegion {
  const x = clamp(region.rect.x + dx, 0, 1 - region.rect.width);
  const y = clamp(region.rect.y + dy, 0, 1 - region.rect.height);
  return {...region, rect: {...region.rect, x, y}, points: region.points.map((point) => ({
    x: point.x + x - region.rect.x, y: point.y + y - region.rect.y,
  }))};
}
