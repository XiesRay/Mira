import type {NormalizedPoint, NormalizedRect} from './types';
import {limitClosedPolygonPoints, sanitizeClosedPolygon} from './regionGeometry';

export interface DetectedRegion {
  rect: NormalizedRect;
  selectionType: 'rectangle' | 'freehand';
  points: NormalizedPoint[];
}

export interface RegionDetectionOptions {
  preferredRegionCount?: number;
  requireBackgroundSafe?: boolean;
  minRegionThreshold?: number;
}

interface Component {
  cells: number[];
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  polygonSafe?: boolean;
}

interface CellGrid {
  cols: number;
  rows: number;
  blockW: number;
  blockH: number;
  r: number[];
  g: number[];
  b: number[];
  a: number[];
  luma: number[];
}

const TARGET_CELL_SIZE = 6;
const MAX_ANALYSIS_DIMENSION = 960;
const MAX_REGION_COUNT = 50;

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });

const clampInt = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const cross = (
  origin: NormalizedPoint,
  left: NormalizedPoint,
  right: NormalizedPoint,
) => (left.x - origin.x) * (right.y - origin.y)
  - (left.y - origin.y) * (right.x - origin.x);

function convexHull(points: NormalizedPoint[]): NormalizedPoint[] {
  const unique = [...new Map(points.map((point) => [
    `${point.x.toFixed(6)}:${point.y.toFixed(6)}`,
    point,
  ])).values()]
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (unique.length <= 3) return unique;

  const lower: NormalizedPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: NormalizedPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

const pointToSegmentDistance = (
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) => {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(pointX - startX, pointY - startY);
  const amount = Math.max(0, Math.min(
    1,
    ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared,
  ));
  return Math.hypot(
    pointX - (startX + amount * dx),
    pointY - (startY + amount * dy),
  );
};

const segmentStaysOnBackground = (
  start: NormalizedPoint,
  end: NormalizedPoint,
  foregroundMask: boolean[],
  cols: number,
  rows: number,
) => {
  for (let cell = 0; cell < foregroundMask.length; cell++) {
    if (!foregroundMask[cell]) continue;
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    if (pointToSegmentDistance(
      col + 0.5,
      row + 0.5,
      start.x * cols,
      start.y * rows,
      end.x * cols,
      end.y * rows,
    ) <= 0.8) return false;
  }
  return true;
};

const polygonStaysOnBackground = (
  points: NormalizedPoint[],
  foregroundMask: boolean[],
  cols: number,
  rows: number,
) => points.every((point, index) => segmentStaysOnBackground(
  point,
  points[(index + 1) % points.length],
  foregroundMask,
  cols,
  rows,
));

const pointInPolygon = (
  x: number,
  y: number,
  polygon: NormalizedPoint[],
  cols: number,
  rows: number,
) => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const currentX = currentPoint.x * cols;
    const currentY = currentPoint.y * rows;
    const previousX = previousPoint.x * cols;
    const previousY = previousPoint.y * rows;
    const crosses = (currentY > y) !== (previousY > y)
      && x < ((previousX - currentX) * (y - currentY))
        / (previousY - currentY || Number.EPSILON) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
};

interface GridEdge {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

function traceLargestBoundary(mask: boolean[], cols: number, rows: number): NormalizedPoint[] {
  const edges: GridEdge[] = [];
  const isInside = (col: number, row: number) =>
    col >= 0 && col < cols && row >= 0 && row < rows && mask[row * cols + col];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!isInside(col, row)) continue;
      if (!isInside(col, row - 1)) {
        edges.push({startX: col, startY: row, endX: col + 1, endY: row});
      }
      if (!isInside(col + 1, row)) {
        edges.push({startX: col + 1, startY: row, endX: col + 1, endY: row + 1});
      }
      if (!isInside(col, row + 1)) {
        edges.push({startX: col + 1, startY: row + 1, endX: col, endY: row + 1});
      }
      if (!isInside(col - 1, row)) {
        edges.push({startX: col, startY: row + 1, endX: col, endY: row});
      }
    }
  }

  const outgoing = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = `${edge.startX}:${edge.startY}`;
    const values = outgoing.get(key);
    if (values) values.push(index);
    else outgoing.set(key, [index]);
  });
  const visited = new Set<number>();
  const loops: Array<Array<{x: number; y: number}>> = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    if (visited.has(edgeIndex)) continue;
    const first = edges[edgeIndex];
    const loop = [{x: first.startX, y: first.startY}];
    let currentIndex = edgeIndex;
    while (!visited.has(currentIndex)) {
      visited.add(currentIndex);
      const current = edges[currentIndex];
      loop.push({x: current.endX, y: current.endY});
      const next = (outgoing.get(`${current.endX}:${current.endY}`) ?? [])
        .find((candidate) => !visited.has(candidate));
      if (next === undefined) break;
      currentIndex = next;
    }
    if (loop.length >= 4) {
      const last = loop.at(-1)!;
      if (last.x === loop[0].x && last.y === loop[0].y) loop.pop();
      loops.push(loop);
    }
  }
  const area = (loop: Array<{x: number; y: number}>) => Math.abs(loop.reduce(
    (sum, point, index) => {
      const next = loop[(index + 1) % loop.length];
      return sum + point.x * next.y - next.x * point.y;
    },
    0,
  ));
  const largest = loops.sort((left, right) => area(right) - area(left))[0] ?? [];
  const withoutCollinear = largest.filter((point, index) => {
    const previous = largest[(index - 1 + largest.length) % largest.length];
    const next = largest[(index + 1) % largest.length];
    return (point.x - previous.x) * (next.y - point.y)
      !== (point.y - previous.y) * (next.x - point.x);
  });
  return withoutCollinear.map((point) => ({
    x: point.x / cols,
    y: point.y / rows,
  }));
}

function snapBoundaryToBackground(
  boundary: NormalizedPoint[],
  foregroundMask: boolean[],
  walkableMask: boolean[],
  cols: number,
  rows: number,
): NormalizedPoint[] {
  const snapped: NormalizedPoint[] = [];
  for (const point of boundary) {
    const gridX = point.x * cols;
    const gridY = point.y * rows;
    let best: NormalizedPoint | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let radius = 0; radius <= 4; radius++) {
      const minCol = Math.max(0, Math.floor(gridX) - radius);
      const maxCol = Math.min(cols - 1, Math.floor(gridX) + radius);
      const minRow = Math.max(0, Math.floor(gridY) - radius);
      const maxRow = Math.min(rows - 1, Math.floor(gridY) + radius);
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          if (!walkableMask[row * cols + col]) continue;
          const candidate = {x: (col + 0.5) / cols, y: (row + 0.5) / rows};
          if (!segmentStaysOnBackground(
            candidate,
            candidate,
            foregroundMask,
            cols,
            rows,
          )) continue;
          const previous = snapped.at(-1);
          const score = Math.hypot(col + 0.5 - gridX, row + 0.5 - gridY)
            + (previous
              ? Math.hypot(
                candidate.x * cols - previous.x * cols,
                candidate.y * rows - previous.y * rows,
              ) * 0.02
              : 0);
          if (score < bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
      }
      if (best) break;
    }
    if (best) snapped.push(best);
  }

  const unique = snapped.filter((point, index) => {
    const previous = snapped[(index - 1 + snapped.length) % snapped.length];
    return point.x !== previous.x || point.y !== previous.y;
  });
  return unique.filter((point, index) => {
    const previous = unique[(index - 1 + unique.length) % unique.length];
    const next = unique[(index + 1) % unique.length];
    return Math.abs(cross(previous, point, next)) > 1e-8;
  });
}

function routeSegmentOnBackground(
  start: NormalizedPoint,
  end: NormalizedPoint,
  foregroundMask: boolean[],
  walkableMask: boolean[],
  cols: number,
  rows: number,
): NormalizedPoint[] {
  const direct = segmentStaysOnBackground(start, end, foregroundMask, cols, rows);
  if (direct) {
    return [start, end];
  }
  const toCell = (point: NormalizedPoint) => {
    const col = clampInt(point.x * cols - 0.5, 0, cols - 1);
    const row = clampInt(point.y * rows - 0.5, 0, rows - 1);
    return row * cols + col;
  };
  const startCell = toCell(start);
  const endCell = toCell(end);
  const parents = new Int32Array(foregroundMask.length).fill(-1);
  const queue = [startCell];
  parents[startCell] = startCell;
  for (let cursor = 0; cursor < queue.length && parents[endCell] < 0; cursor++) {
    const cell = queue[cursor];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
      const next = nextRow * cols + nextCol;
      if (parents[next] >= 0 || !walkableMask[next]) continue;
      parents[next] = cell;
      queue.push(next);
    }
  }
  if (parents[endCell] < 0) return [start, end];

  const cells: number[] = [];
  for (let cell = endCell; cell !== startCell; cell = parents[cell]) cells.push(cell);
  cells.push(startCell);
  cells.reverse();
  return cells.map((cell) => ({
    x: (cell % cols + 0.5) / cols,
    y: (Math.floor(cell / cols) + 0.5) / rows,
  }));
}

function routeBoundaryOnBackground(
  boundary: NormalizedPoint[],
  foregroundMask: boolean[],
  walkableMask: boolean[],
  cols: number,
  rows: number,
): NormalizedPoint[] {
  const routed: NormalizedPoint[] = [];
  boundary.forEach((point, index) => {
    const end = boundary[(index + 1) % boundary.length];
    const segment = routeSegmentOnBackground(
      point,
      end,
      foregroundMask,
      walkableMask,
      cols,
      rows,
    );
    routed.push(...segment.slice(0, -1));
  });
  const unique = routed.filter((point, index) => {
    const previous = routed[(index - 1 + routed.length) % routed.length];
    return point.x !== previous.x || point.y !== previous.y;
  });
  const withoutCollinear = unique.filter((point, index) => {
    const previous = unique[(index - 1 + unique.length) % unique.length];
    const next = unique[(index + 1) % unique.length];
    return Math.abs(cross(previous, point, next)) > 1e-8;
  });
  if (withoutCollinear.length <= 12) return withoutCollinear;

  const unrolled = [...withoutCollinear, withoutCollinear[0]];
  const simplified = [unrolled[0]];
  let cursor = 0;
  while (cursor < withoutCollinear.length) {
    const furthest = Math.min(withoutCollinear.length, cursor + 16);
    let nextIndex = cursor + 1;
    for (let candidate = furthest; candidate > cursor + 1; candidate--) {
      if (segmentStaysOnBackground(
        unrolled[cursor],
        unrolled[candidate],
        foregroundMask,
        cols,
        rows,
      )) {
        nextIndex = candidate;
        break;
      }
    }
    if (nextIndex < withoutCollinear.length) simplified.push(unrolled[nextIndex]);
    cursor = nextIndex;
  }
  return simplified.length >= 3
    && polygonStaysOnBackground(simplified, foregroundMask, cols, rows)
    ? simplified
    : withoutCollinear;
}

function buildExteriorBackgroundMask(
  foregroundMask: boolean[],
  cols: number,
  rows: number,
): boolean[] {
  const exterior = new Array<boolean>(foregroundMask.length).fill(false);
  const queue: number[] = [];
  const add = (col: number, row: number) => {
    const cell = row * cols + col;
    if (foregroundMask[cell] || exterior[cell]) return;
    exterior[cell] = true;
    queue.push(cell);
  };
  for (let col = 0; col < cols; col++) {
    add(col, 0);
    add(col, rows - 1);
  }
  for (let row = 1; row < rows - 1; row++) {
    add(0, row);
    add(cols - 1, row);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const cell = queue[cursor];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (nextCol >= 0 && nextCol < cols && nextRow >= 0 && nextRow < rows) {
        add(nextCol, nextRow);
      }
    }
  }
  return exterior;
}

function buildBackgroundSafeBoundary(
  hull: NormalizedPoint[],
  included: Set<number>,
  foregroundMask: boolean[],
  cols: number,
  rows: number,
  includedBuffer = 1,
  externalBuffer = 2,
): NormalizedPoint[] {
  const regionMask = new Array<boolean>(foregroundMask.length).fill(false);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      regionMask[row * cols + col] = pointInPolygon(
        col + 0.5,
        row + 0.5,
        hull,
        cols,
        rows,
      );
    }
  }
  const applyBuffer = (cell: number, radius: number, value: boolean) => {
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (nextRow >= 0 && nextRow < rows && nextCol >= 0 && nextCol < cols) {
          regionMask[nextRow * cols + nextCol] = value;
        }
      }
    }
  };

  // 先确保当前物品及其安全边距在选区内，再用更宽的外部前景缓冲挖出白色
  // 通道。外部缓冲最后执行，避免两组物品很近时边线贴到另一组的墨线上。
  included.forEach((cell) => applyBuffer(cell, includedBuffer, true));
  foregroundMask.forEach((foreground, cell) => {
    if (foreground && !included.has(cell)) applyBuffer(cell, externalBuffer, false);
  });
  const boundary = traceLargestBoundary(regionMask, cols, rows);
  const exterior = buildExteriorBackgroundMask(foregroundMask, cols, rows);
  const snapped = snapBoundaryToBackground(
    boundary,
    foregroundMask,
    exterior,
    cols,
    rows,
  );
  const routed = routeBoundaryOnBackground(
    snapped.length >= 3 ? snapped : boundary,
    foregroundMask,
    exterior,
    cols,
    rows,
  );
  return routed.length >= 3 ? routed : boundary;
}

/**
 * 用分量内全部前景格子的外扩方块计算凸包。凸包天然包含所有主体像素，再向外
 * 留出一个采样格的安全距离。构建凸包前先从已有分量出发，沿原始前景掩码
 * 补回同一物品的连续墨线；白色间隔会阻断扩散，因此不会把箭头或其他物品吞进来。
 */
function componentSafePolygon(
  component: Component,
  cols: number,
  rows: number,
  foregroundMask: boolean[],
  requireBackgroundSafe = false,
): NormalizedPoint[] {
  const included = new Set(component.cells);
  const queue = component.cells.filter((cell) => foregroundMask[cell]);
  const expansionLeft = Math.max(0, component.c0 - 2);
  const expansionTop = Math.max(0, component.r0 - 2);
  const expansionRight = Math.min(cols - 1, component.c1 + 2);
  const expansionBottom = Math.min(rows - 1, component.r1 + 2);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const cell = queue[cursor];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (
          nextRow < expansionTop
          || nextRow > expansionBottom
          || nextCol < expansionLeft
          || nextCol > expansionRight
        ) continue;
        const next = nextRow * cols + nextCol;
        if (!foregroundMask[next] || included.has(next)) continue;
        included.add(next);
        queue.push(next);
      }
    }
  }

  const buildHull = (padding: number) => convexHull([...included].flatMap((cell) => {
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    const left = clamp01((col - padding) / cols);
    const top = clamp01((row - padding) / rows);
    const right = clamp01((col + 1 + padding) / cols);
    const bottom = clamp01((row + 1 + padding) / rows);
    return [
      {x: left, y: top},
      {x: right, y: top},
      {x: right, y: bottom},
      {x: left, y: bottom},
    ];
  }));
  const hull = buildHull(1);
  if (polygonStaysOnBackground(hull, foregroundMask, cols, rows)) return hull;
  const safeBoundary = buildBackgroundSafeBoundary(
    hull,
    included,
    foregroundMask,
    cols,
    rows,
  );
  const isUsable = (points: NormalizedPoint[]) => {
    if (points.length < 3) return false;
    const boundaryX = points.map((point) => point.x * cols);
    const boundaryY = points.map((point) => point.y * rows);
    const withinEnvelope = points.every((point) =>
      point.x * cols >= component.c0 - 4
      && point.x * cols <= component.c1 + 5
      && point.y * rows >= component.r0 - 4
      && point.y * rows <= component.r1 + 5);
    const coversComponent = Math.min(...boundaryX) <= component.c0 + 2
      && Math.max(...boundaryX) >= component.c1 - 2
      && Math.min(...boundaryY) <= component.r0 + 2
      && Math.max(...boundaryY) >= component.r1 - 2;
    return withinEnvelope
      && coversComponent
      && polygonStaysOnBackground(points, foregroundMask, cols, rows);
  };
  if (isUsable(safeBoundary)) return safeBoundary;
  if (!requireBackgroundSafe) return hull;

  // 纯白底流程图常有规则的横纵留白。优先尝试在主体包围盒外寻找一圈完整
  // 背景矩形，这既能保留独立文字/箭头，也不会因为某一侧空间狭窄而吞并邻居。
  for (let padding = 1; padding <= 5; padding++) {
    const safeRectangle = [
      {
        x: clamp01((component.c0 - padding + 0.5) / cols),
        y: clamp01((component.r0 - padding + 0.5) / rows),
      },
      {
        x: clamp01((component.c1 + padding + 0.5) / cols),
        y: clamp01((component.r0 - padding + 0.5) / rows),
      },
      {
        x: clamp01((component.c1 + padding + 0.5) / cols),
        y: clamp01((component.r1 + padding + 0.5) / rows),
      },
      {
        x: clamp01((component.c0 - padding + 0.5) / cols),
        y: clamp01((component.r1 + padding + 0.5) / rows),
      },
    ];
    if (polygonStaysOnBackground(safeRectangle, foregroundMask, cols, rows)) {
      return safeRectangle;
    }
  }

  // 窄缝不足以容纳常规缓冲时，沿真实背景格中心再寻路一次。仍然执行逐边
  // 前景碰撞检查，所以收紧边距不会以切过物体为代价。
  const tightHull = buildHull(0.5);
  if (polygonStaysOnBackground(tightHull, foregroundMask, cols, rows)) return tightHull;
  const tightBoundary = buildBackgroundSafeBoundary(
    tightHull,
    included,
    foregroundMask,
    cols,
    rows,
    0,
    0,
  );
  return isUsable(tightBoundary) ? tightBoundary : [];
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clampInt((sorted.length - 1) * p, 0, sorted.length - 1)];
};

const colorDistance = (
  r: number,
  g: number,
  b: number,
  targetR: number,
  targetG: number,
  targetB: number,
) => Math.sqrt((r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2);

function buildCellGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): CellGrid {
  const cols = clampInt(width / TARGET_CELL_SIZE, 12, 160);
  const rows = clampInt(height / TARGET_CELL_SIZE, 12, 160);
  const blockW = width / cols;
  const blockH = height / rows;
  const total = cols * rows;
  const r = new Array<number>(total);
  const g = new Array<number>(total);
  const b = new Array<number>(total);
  const a = new Array<number>(total);
  const luma = new Array<number>(total);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = Math.floor(col * blockW);
      const ex = Math.min(width, Math.ceil((col + 1) * blockW));
      const sy = Math.floor(row * blockH);
      const ey = Math.min(height, Math.ceil((row + 1) * blockH));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const index = (y * width + x) * 4;
          sumR += data[index];
          sumG += data[index + 1];
          sumB += data[index + 2];
          sumA += data[index + 3];
          count++;
        }
      }
      const index = row * cols + col;
      const divisor = count || 1;
      r[index] = sumR / divisor;
      g[index] = sumG / divisor;
      b[index] = sumB / divisor;
      a[index] = sumA / divisor;
      luma[index] = 0.299 * r[index] + 0.587 * g[index] + 0.114 * b[index];
    }
  }

  return {cols, rows, blockW, blockH, r, g, b, a, luma};
}

function getBorderIndices(cols: number, rows: number): number[] {
  const indices: number[] = [];
  const band = Math.max(1, Math.min(3, Math.floor(Math.min(cols, rows) * 0.04)));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (row < band || row >= rows - band || col < band || col >= cols - band) {
        indices.push(row * cols + col);
      }
    }
  }
  return indices;
}

/**
 * 从边缘格子中寻找占比最高的量化颜色簇，避免贴边主体直接污染背景色。
 */
function estimateBackground(grid: CellGrid) {
  const borderIndices = getBorderIndices(grid.cols, grid.rows);
  const transparentRatio = borderIndices.filter((index) => grid.a[index] < 40).length
    / Math.max(1, borderIndices.length);
  const transparent = transparentRatio >= 0.6;
  if (transparent) {
    return {transparent, r: 0, g: 0, b: 0, threshold: 32};
  }

  const opaqueIndices = borderIndices.filter((index) => grid.a[index] >= 40);
  const binSize = 24;
  const bins = new Map<string, number[]>();
  for (const index of opaqueIndices) {
    const key = `${Math.floor(grid.r[index] / binSize)}:${Math.floor(grid.g[index] / binSize)}:${Math.floor(grid.b[index] / binSize)}`;
    const values = bins.get(key);
    if (values) values.push(index);
    else bins.set(key, [index]);
  }

  const dominant = [...bins.values()].sort((left, right) => right.length - left.length)[0]
    ?? opaqueIndices;
  const seedR = median(dominant.map((index) => grid.r[index]));
  const seedG = median(dominant.map((index) => grid.g[index]));
  const seedB = median(dominant.map((index) => grid.b[index]));
  const backgroundIndices = opaqueIndices.filter((index) =>
    colorDistance(grid.r[index], grid.g[index], grid.b[index], seedR, seedG, seedB) <= 52);
  const samples = backgroundIndices.length >= 4 ? backgroundIndices : dominant;
  const bgR = median(samples.map((index) => grid.r[index]));
  const bgG = median(samples.map((index) => grid.g[index]));
  const bgB = median(samples.map((index) => grid.b[index]));
  const variation = percentile(samples.map((index) =>
    colorDistance(grid.r[index], grid.g[index], grid.b[index], bgR, bgG, bgB)), 0.9);

  return {
    transparent,
    r: bgR,
    g: bgG,
    b: bgB,
    threshold: Math.max(30, Math.min(68, variation + 20)),
  };
}

const colorChannelToHex = (value: number) => clampInt(value, 0, 255)
  .toString(16)
  .padStart(2, '0');

/**
 * 从图片边缘的主颜色簇估算页面底色。透明图使用白色回退。
 */
export function estimateImageBackgroundColorFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return '#ffffff';
  const background = estimateBackground(buildCellGrid(data, width, height));
  if (background.transparent) return '#ffffff';
  return `#${colorChannelToHex(background.r)}${colorChannelToHex(background.g)}${colorChannelToHex(background.b)}`;
}

function stabilizeMask(mask: boolean[], cols: number, rows: number): boolean[] {
  const next = [...mask];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      let neighbors = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && mask[nr * cols + nc]) {
            neighbors++;
          }
        }
      }
      // 填补轮廓中的小缺口，同时移除单格噪点；不做大范围膨胀，避免相邻物体粘连。
      if (!mask[index] && neighbors >= 5) next[index] = true;
      if (mask[index] && neighbors <= 1) next[index] = false;
    }
  }
  return next;
}

function dilateMask(mask: boolean[], cols: number, rows: number, radius: number): boolean[] {
  const result = new Array<boolean>(mask.length).fill(false);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (!mask[index]) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = row + dr;
          const nc = col + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            result[nr * cols + nc] = true;
          }
        }
      }
    }
  }
  return result;
}

function connectedComponents(
  mask: boolean[],
  cols: number,
  rows: number,
  minCells: number,
): Component[] {
  const visited = new Array(cols * rows).fill(false);
  const components: Component[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = true;
    const cells: number[] = [];
    let c0 = cols;
    let r0 = rows;
    let c1 = 0;
    let r1 = 0;
    while (stack.length) {
      const index = stack.pop()!;
      const row = Math.floor(index / cols);
      const col = index % cols;
      cells.push(index);
      c0 = Math.min(c0, col);
      r0 = Math.min(r0, row);
      c1 = Math.max(c1, col);
      r1 = Math.max(r1, row);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const neighbor = nr * cols + nc;
          if (!visited[neighbor] && mask[neighbor]) {
            visited[neighbor] = true;
            stack.push(neighbor);
          }
        }
      }
    }
    const widthRatio = (c1 - c0 + 1) / cols;
    const heightRatio = (r1 - r0 + 1) / rows;
    if (cells.length >= minCells && !(widthRatio > 0.94 && heightRatio > 0.94)) {
      components.push({cells, c0, r0, c1, r1});
    }
  }
  return components;
}

const compArea = (component: Component) =>
  (component.c1 - component.c0 + 1) * (component.r1 - component.r0 + 1);

const intersectArea = (left: Component, right: Component) => {
  const width = Math.max(0, Math.min(left.c1, right.c1) - Math.max(left.c0, right.c0) + 1);
  const height = Math.max(0, Math.min(left.r1, right.r1) - Math.max(left.r0, right.r0) + 1);
  return width * height;
};

function mergeNearbyComponents(components: Component[]): Component[] {
  if (components.length < 2) return components;
  const parents = components.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let leftIndex = 0; leftIndex < components.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex++) {
      const left = components[leftIndex];
      const right = components[rightIndex];
      const gapX = Math.max(0, Math.max(left.c0, right.c0) - Math.min(left.c1, right.c1) - 1);
      const gapY = Math.max(0, Math.max(left.r0, right.r0) - Math.min(left.r1, right.r1) - 1);
      const overlapX = Math.max(0, Math.min(left.c1, right.c1) - Math.max(left.c0, right.c0) + 1);
      const overlapY = Math.max(0, Math.min(left.r1, right.r1) - Math.max(left.r0, right.r0) + 1);
      const minWidth = Math.min(left.c1 - left.c0 + 1, right.c1 - right.c0 + 1);
      const minHeight = Math.min(left.r1 - left.r0 + 1, right.r1 - right.r0 + 1);
      const horizontallyRelated = gapX <= 2 && overlapY / minHeight >= 0.35;
      const verticallyRelated = gapY <= 2 && overlapX / minWidth >= 0.35;
      const closeDiagonally = gapX <= 1 && gapY <= 1;
      if (horizontallyRelated || verticallyRelated || closeDiagonally) {
        union(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map<number, Component>();
  components.forEach((component, index) => {
    const root = find(index);
    const current = groups.get(root);
    if (!current) {
      groups.set(root, {...component, cells: [...component.cells]});
      return;
    }
    current.cells.push(...component.cells);
    current.c0 = Math.min(current.c0, component.c0);
    current.r0 = Math.min(current.r0, component.r0);
    current.c1 = Math.max(current.c1, component.c1);
    current.r1 = Math.max(current.r1, component.r1);
  });
  return [...groups.values()];
}

/**
 * 移除贯穿画面的细长辅助线。手绘场景里的桌面线、地平线常把多个本来独立的
 * 物体连成一个超大分量，但它们不应该决定动画区域的边界。
 */
function suppressLongRuns(mask: boolean[], cols: number, rows: number): boolean[] {
  const result = [...mask];
  const horizontalRuns = new Array<boolean>(mask.length).fill(false);
  const verticalRuns = new Array<boolean>(mask.length).fill(false);
  const horizontalLimit = Math.max(12, Math.round(cols * 0.22));
  const verticalLimit = Math.max(12, Math.round(rows * 0.38));

  for (let row = 0; row < rows; row++) {
    let start = 0;
    while (start < cols) {
      while (start < cols && !mask[row * cols + start]) start++;
      let end = start;
      while (end < cols && mask[row * cols + end]) end++;
      if (end - start >= horizontalLimit) {
        for (let col = start; col < end; col++) horizontalRuns[row * cols + col] = true;
      }
      start = Math.max(end, start + 1);
    }
  }

  for (let col = 0; col < cols; col++) {
    let start = 0;
    while (start < rows) {
      while (start < rows && !mask[start * cols + col]) start++;
      let end = start;
      while (end < rows && mask[end * cols + col]) end++;
      if (end - start >= verticalLimit) {
        for (let row = start; row < end; row++) verticalRuns[row * cols + col] = true;
      }
      start = Math.max(end, start + 1);
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (horizontalRuns[index]) {
        let thickness = 0;
        for (let offset = -2; offset <= 2; offset++) {
          const targetRow = row + offset;
          if (targetRow >= 0 && targetRow < rows && horizontalRuns[targetRow * cols + col]) {
            thickness++;
          }
        }
        if (thickness <= 3) result[index] = false;
      }
      if (verticalRuns[index]) {
        let thickness = 0;
        for (let offset = -2; offset <= 2; offset++) {
          const targetCol = col + offset;
          if (targetCol >= 0 && targetCol < cols && verticalRuns[row * cols + targetCol]) {
            thickness++;
          }
        }
        if (thickness <= 3) result[index] = false;
      }
    }
  }

  return result;
}

const componentCenter = (component: Component) => ({
  col: (component.c0 + component.c1) / 2,
  row: (component.r0 + component.r1) / 2,
});

const containsCenter = (component: Component, target: Component) => {
  const center = componentCenter(target);
  return center.col >= component.c0
    && center.col <= component.c1
    && center.row >= component.r0
    && center.row <= component.r1;
};

/**
 * 合并同一物体中上下或左右相邻的内部命中。例如人物的衣服、双腿常被识别成
 * 两个白色空腔，但最终应当作为同一个完整人物出现。
 */
function mergeAlignedSeeds(seeds: Component[]): Component[] {
  const result = seeds.map((seed) => ({...seed, cells: [...seed.cells]}));
  let merged = true;

  while (merged) {
    merged = false;
    outer: for (let leftIndex = 0; leftIndex < result.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < result.length; rightIndex++) {
        const left = result[leftIndex];
        const right = result[rightIndex];
        const gapX = Math.max(0, Math.max(left.c0, right.c0) - Math.min(left.c1, right.c1) - 1);
        const gapY = Math.max(0, Math.max(left.r0, right.r0) - Math.min(left.r1, right.r1) - 1);
        const overlapX = Math.max(0, Math.min(left.c1, right.c1) - Math.max(left.c0, right.c0) + 1);
        const overlapY = Math.max(0, Math.min(left.r1, right.r1) - Math.max(left.r0, right.r0) + 1);
        const minWidth = Math.min(left.c1 - left.c0 + 1, right.c1 - right.c0 + 1);
        const minHeight = Math.min(left.r1 - left.r0 + 1, right.r1 - right.r0 + 1);
        const verticallyAligned = gapY <= 10 && overlapX / minWidth >= 0.2;
        const horizontallyAligned = gapX <= 5 && overlapY / minHeight >= 0.55;
        if (!verticallyAligned && !horizontallyAligned) continue;

        result[leftIndex] = {
          cells: [...left.cells, ...right.cells],
          c0: Math.min(left.c0, right.c0),
          r0: Math.min(left.r0, right.r0),
          c1: Math.max(left.c1, right.c1),
          r1: Math.max(left.r1, right.r1),
        };
        result.splice(rightIndex, 1);
        merged = true;
        break outer;
      }
    }
  }

  return result;
}

const distanceToComponent = (col: number, row: number, component: Component) => {
  const dx = col < component.c0
    ? component.c0 - col
    : col > component.c1
      ? col - component.c1
      : 0;
  const dy = row < component.r0
    ? component.r0 - row
    : row > component.r1
      ? row - component.r1
      : 0;
  return dx * dx + dy * dy;
};

const componentGapDistance = (left: Component, right: Component) => {
  const gapX = Math.max(0, Math.max(left.c0, right.c0) - Math.min(left.c1, right.c1) - 1);
  const gapY = Math.max(0, Math.max(left.r0, right.r0) - Math.min(left.r1, right.r1) - 1);
  return Math.sqrt(gapX * gapX + gapY * gapY);
};

/**
 * 横向知识流程图通常由数个竖向主体带组成。主体列在大部分高度上都有前景，
 * 箭头只占很薄的一行，因此用“列内前景跨度”寻找主体比按包围盒最近距离可靠。
 * 同一真实连通分量若跨过多个主体带（例如电线连接两端），这些主体必须合并；
 * 否则任何闭合选区都必然切断连接线。
 */
function buildColumnBandProposals(
  foregroundMask: boolean[],
  cols: number,
  rows: number,
  minCells: number,
  preferredRegionCount: number,
): Component[] {
  const activeColumns = new Array<boolean>(cols).fill(false);
  for (let col = 0; col < cols; col++) {
    const foregroundRows: number[] = [];
    for (let row = 0; row < rows; row++) {
      if (foregroundMask[row * cols + col]) foregroundRows.push(row);
    }
    if (foregroundRows.length < 3) continue;
    const occupancy = foregroundRows.length / rows;
    const span = (foregroundRows.at(-1)! - foregroundRows[0] + 1) / rows;
    activeColumns[col] = occupancy >= 0.08 || span >= 0.18;
  }

  const minimumBandWidth = Math.max(3, Math.round(cols * 0.025));
  const bands: Array<{c0: number; c1: number}> = [];
  for (let col = 0; col < cols;) {
    while (col < cols && !activeColumns[col]) col++;
    const start = col;
    while (col < cols && activeColumns[col]) col++;
    if (col - start >= minimumBandWidth) bands.push({c0: start, c1: col - 1});
  }
  if (
    bands.length < 2
    || bands.length > MAX_REGION_COUNT
    || Math.abs(bands.length - preferredRegionCount) > 1
  ) return [];

  const foregroundComponents = connectedComponents(
    foregroundMask,
    cols,
    rows,
    Math.max(2, Math.round(minCells * 0.4)),
  );
  const parents = bands.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (const component of foregroundComponents) {
    const width = component.c1 - component.c0 + 1;
    const height = component.r1 - component.r0 + 1;
    const fill = component.cells.length / compArea(component);
    const slenderConnector = width >= cols * 0.035
      && height <= rows * 0.14
      && width / Math.max(1, height) >= 1.8
      && fill >= 0.45;
    if (slenderConnector) continue;
    const touched = bands
      .map((band, index) => ({
        index,
        count: component.cells.filter((cell) => {
          const col = cell % cols;
          return col >= band.c0 && col <= band.c1;
        }).length,
      }))
      .filter(({count}) => count >= Math.max(3, Math.round(component.cells.length * 0.025)))
      .map(({index}) => index);
    for (let index = 1; index < touched.length; index++) union(touched[0], touched[index]);
  }

  const groups = new Map<number, {bandIndexes: number[]; cells: number[]}>();
  bands.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root) ?? {bandIndexes: [], cells: []};
    group.bandIndexes.push(index);
    groups.set(root, group);
  });
  const values = [...groups.values()];

  for (const component of foregroundComponents) {
    const center = componentCenter(component).col;
    let owner = 0;
    let ownerScore = Number.NEGATIVE_INFINITY;
    values.forEach((group, groupIndex) => {
      const containedCells = component.cells.filter((cell) => group.bandIndexes.some((index) => {
        const col = cell % cols;
        return col >= bands[index].c0 && col <= bands[index].c1;
      })).length;
      const distance = Math.min(...group.bandIndexes.map((index) => {
        const band = bands[index];
        return center < band.c0 ? band.c0 - center : center > band.c1 ? center - band.c1 : 0;
      }));
      const score = containedCells * 100 - distance;
      if (score > ownerScore) {
        owner = groupIndex;
        ownerScore = score;
      }
    });
    values[owner].cells.push(...component.cells);
  }

  return values
    .filter((group) => group.cells.length >= minCells)
    .map((group): Component => {
      const cells = [...new Set(group.cells)];
      const cellCols = cells.map((cell) => cell % cols);
      const cellRows = cells.map((cell) => Math.floor(cell / cols));
      return {
        cells,
        c0: Math.min(...cellCols),
        r0: Math.min(...cellRows),
        c1: Math.max(...cellCols),
        r1: Math.max(...cellRows),
        polygonSafe: true,
      };
    })
    .sort((left, right) => left.c0 - right.c0);
}

const combineComponents = (left: Component, right: Component): Component => ({
  cells: [...new Set([...left.cells, ...right.cells])],
  c0: Math.min(left.c0, right.c0),
  r0: Math.min(left.r0, right.r0),
  c1: Math.max(left.c1, right.c1),
  r1: Math.max(left.r1, right.r1),
  polygonSafe: true,
});

/**
 * 每个候选都必须能找到完全位于背景上的闭合边界。若两个主体距离过近或由线条
 * 相连，单独圈选在几何上不可能不切线，此时合并最近的相邻主体，绝不退回矩形。
 */
function ensureBackgroundSafeComponents(
  components: Component[],
  foregroundMask: boolean[],
  cols: number,
  rows: number,
): Array<{component: Component; points: NormalizedPoint[]}> {
  const pending = components
    .map((component) => ({...component, cells: [...component.cells]}))
    .sort((left, right) => left.c0 - right.c0);

  while (pending.length > 0) {
    const boundaries = pending.map((component) => componentSafePolygon(
      component,
      cols,
      rows,
      foregroundMask,
      true,
    ));
    const invalidIndex = boundaries.findIndex((points) => points.length < 3);
    if (invalidIndex < 0) {
      return pending.map((component, index) => ({
        component,
        points: boundaries[index],
      }));
    }
    if (pending.length === 1) return [];

    const neighborIndex = invalidIndex === 0
      ? 1
      : invalidIndex === pending.length - 1
        ? invalidIndex - 1
        : componentGapDistance(pending[invalidIndex], pending[invalidIndex - 1])
          <= componentGapDistance(pending[invalidIndex], pending[invalidIndex + 1])
          ? invalidIndex - 1
          : invalidIndex + 1;
    const first = Math.min(invalidIndex, neighborIndex);
    const second = Math.max(invalidIndex, neighborIndex);
    pending[first] = combineComponents(pending[first], pending[second]);
    pending.splice(second, 1);
  }
  return [];
}

/**
 * 主体彼此分离的场景优先使用完整结构分量。大主体作为锚点，人物四肢、文件盒
 * 内部等小分量归到最近锚点；完整的横向或纵向箭头作为独立区域输出，不再过滤。
 */
function buildStructuralProposals(
  components: Component[],
  seeds: Component[],
  cols: number,
  rows: number,
): Component[] {
  const total = cols * rows;
  const largeAnchors = components
    .filter((component) => compArea(component) / total >= 0.017)
    .map((component) => ({...component, cells: [...component.cells]}));

  // 显示器等封闭物体在移除长边后可能只剩零碎线段，无法达到结构锚点阈值。
  // 使用内部封闭区域补充锚点；已落在柜体或人物中的文字/空腔不会重复建框。
  for (const seed of seeds) {
    const areaRatio = compArea(seed) / total;
    if (areaRatio < 0.02 || areaRatio > 0.2) continue;
    if (largeAnchors.some((anchor) => containsCenter(anchor, seed))) continue;
    largeAnchors.push({...seed, cells: [...seed.cells]});
  }

  // 柜体、资料架等大型物体会被长横线抑制拆成多层抽屉和一根侧边。
  // 先合并上下对齐的层，再吸收紧邻的细长侧边，避免每层各自生成一个框。
  let anchorsMerged = true;
  while (anchorsMerged) {
    anchorsMerged = false;
    outer: for (let leftIndex = 0; leftIndex < largeAnchors.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < largeAnchors.length; rightIndex++) {
        const left = largeAnchors[leftIndex];
        const right = largeAnchors[rightIndex];
        const leftWidth = left.c1 - left.c0 + 1;
        const rightWidth = right.c1 - right.c0 + 1;
        const leftHeight = left.r1 - left.r0 + 1;
        const rightHeight = right.r1 - right.r0 + 1;
        const gapX = Math.max(0, Math.max(left.c0, right.c0) - Math.min(left.c1, right.c1) - 1);
        const gapY = Math.max(0, Math.max(left.r0, right.r0) - Math.min(left.r1, right.r1) - 1);
        const overlapX = Math.max(0, Math.min(left.c1, right.c1) - Math.max(left.c0, right.c0) + 1);
        const overlapY = Math.max(0, Math.min(left.r1, right.r1) - Math.max(left.r0, right.r0) + 1);
        const centerXDistance = Math.abs(
          (left.c0 + left.c1) / 2 - (right.c0 + right.c1) / 2,
        );
        const verticallyStacked = gapY <= 4
          && overlapX / Math.min(leftWidth, rightWidth) >= 0.65
          && Math.min(leftWidth, rightWidth) / Math.max(leftWidth, rightWidth) >= 0.55
          && centerXDistance <= Math.max(leftWidth, rightWidth) * 0.3;
        const leftAspect = leftHeight / leftWidth;
        const rightAspect = rightHeight / rightWidth;
        const slenderSide = gapX <= Math.max(4, Math.round(cols * 0.06))
          && overlapY / Math.min(leftHeight, rightHeight) >= 0.65
          && (
            (leftAspect >= 4 && rightWidth >= leftWidth * 3)
            || (rightAspect >= 4 && leftWidth >= rightWidth * 3)
          );
        if (!verticallyStacked && !slenderSide) continue;

        largeAnchors[leftIndex] = {
          cells: [...left.cells, ...right.cells],
          c0: Math.min(left.c0, right.c0),
          r0: Math.min(left.r0, right.r0),
          c1: Math.max(left.c1, right.c1),
          r1: Math.max(left.r1, right.r1),
        };
        largeAnchors.splice(rightIndex, 1);
        anchorsMerged = true;
        break outer;
      }
    }
  }

  // 内部标签、抽屉空腔可能在柜体合并后仍作为小锚点残留。只要其中心和绝大部分
  // 面积已落入更大的主体，就由外层主体统一承载，不再单独生成小框。
  for (let index = largeAnchors.length - 1; index >= 0; index--) {
    const current = largeAnchors[index];
    const contained = largeAnchors.some((other, otherIndex) =>
      otherIndex !== index
      && compArea(other) > compArea(current)
      && containsCenter(other, current)
      && intersectArea(other, current) / compArea(current) >= 0.8);
    if (contained) largeAnchors.splice(index, 1);
  }

  if (largeAnchors.length < 2) return [];

  const arrowSymbols = components.filter((component) => {
    const alreadyAnchored = largeAnchors.some((anchor) =>
      component.cells.length > 0
      && component.cells.every((cell) => anchor.cells.includes(cell)));
    if (alreadyAnchored) return false;
    const width = component.c1 - component.c0 + 1;
    const height = component.r1 - component.r0 + 1;
    const fill = component.cells.length / compArea(component);
    const aspect = Math.max(width / height, height / width);
    const areaRatio = compArea(component) / total;
    const horizontal = width >= height;
    const overlapsVertically = (anchor: Component) =>
      Math.min(anchor.r1, component.r1) - Math.max(anchor.r0, component.r0) + 1 > 0;
    const overlapsHorizontally = (anchor: Component) =>
      Math.min(anchor.c1, component.c1) - Math.max(anchor.c0, component.c0) + 1 > 0;
    const insideAnchorColumn = largeAnchors.some((anchor) =>
      component.c0 >= anchor.c0 && component.c1 <= anchor.c1);
    const betweenAnchors = horizontal
      ? largeAnchors.some((anchor) =>
        anchor.c1 < component.c0 && overlapsVertically(anchor))
        && largeAnchors.some((anchor) =>
          anchor.c0 > component.c1 && overlapsVertically(anchor))
      : largeAnchors.some((anchor) =>
        anchor.r1 < component.r0 && overlapsHorizontally(anchor))
        && largeAnchors.some((anchor) =>
          anchor.r0 > component.r1 && overlapsHorizontally(anchor));
    return !insideAnchorColumn
      && betweenAnchors
      && component.cells.length >= 25
      && fill >= 0.55
      && areaRatio <= 0.05
      && Math.min(width, height) >= 3
      && Math.max(width, height) >= 8
      && aspect >= 1.2;
  });
  const reservedSymbols = new Set(arrowSymbols);
  const proposals = [
    ...largeAnchors,
    ...arrowSymbols,
  ].map((component) => ({
    ...component,
    cells: [...component.cells],
    polygonSafe: true,
  }));

  for (const component of components) {
    const alreadyAnchored = largeAnchors.some((anchor) =>
      component.cells.length > 0
      && component.cells.every((cell) => anchor.cells.includes(cell)));
    if (alreadyAnchored || reservedSymbols.has(component)) continue;
    let nearestIndex = -1;
    let nearestCenterDistance = Number.POSITIVE_INFINITY;
    const componentMid = componentCenter(component);
    for (let index = 0; index < largeAnchors.length; index++) {
      if (componentGapDistance(component, proposals[index]) > 5) continue;
      const proposalMid = componentCenter(proposals[index]);
      const centerDistance = Math.hypot(
        componentMid.col - proposalMid.col,
        componentMid.row - proposalMid.row,
      );
      if (centerDistance < nearestCenterDistance) {
        nearestCenterDistance = centerDistance;
        nearestIndex = index;
      }
    }
    if (nearestIndex < 0) continue;
    const target = proposals[nearestIndex];
    target.cells.push(...component.cells);
    target.c0 = Math.min(target.c0, component.c0);
    target.r0 = Math.min(target.r0, component.r0);
    target.c1 = Math.max(target.c1, component.c1);
    target.r1 = Math.max(target.r1, component.r1);
  }

  return proposals;
}

/**
 * 白底线稿中，封闭区域只能说明“这里属于某个物体”，不能直接当作最终框。
 * 这里把候选框作为种子，将周围墨线归到最近种子，再用归组后的完整范围输出。
 */
function expandLineArtSeeds(
  seeds: Component[],
  foregroundMask: boolean[],
  cols: number,
  rows: number,
  minCells: number,
): Component[] {
  const structuralMask = suppressLongRuns(foregroundMask, cols, rows);
  const structuralComponents = connectedComponents(structuralMask, cols, rows, minCells);
  const structuralProposals = buildStructuralProposals(
    structuralComponents,
    seeds,
    cols,
    rows,
  );
  const largestStructuralArea = structuralProposals.reduce(
    (largest, component) => Math.max(largest, compArea(component) / (cols * rows)),
    0,
  );
  if (
    structuralProposals.length >= 3
    && structuralProposals.length <= MAX_REGION_COUNT
    && largestStructuralArea <= 0.48
  ) {
    return structuralProposals;
  }
  const nextSeeds = seeds.map((seed) => ({...seed, cells: [...seed.cells]}));
  const total = cols * rows;

  // 没有内部空腔的大块独立物体（例如摊开的书）也需要成为一个种子。
  for (const component of structuralComponents) {
    const width = component.c1 - component.c0 + 1;
    const height = component.r1 - component.r0 + 1;
    const areaRatio = compArea(component) / total;
    const aspect = Math.max(width / height, height / width);
    const hasSeed = nextSeeds.some((seed) => containsCenter(component, seed));
    if (!hasSeed && areaRatio >= 0.006 && areaRatio <= 0.35 && aspect <= 8) {
      nextSeeds.push(component);
    }
  }

  if (nextSeeds.length === 0) return [];
  const mergedSeeds = mergeAlignedSeeds(nextSeeds);
  const assigned = mergedSeeds.map((seed) => ({
    cells: [] as number[],
    c0: seed.c0,
    r0: seed.r0,
    c1: seed.c1,
    r1: seed.r1,
  }));

  // 只使用与至少一个种子相关的结构分量，残留的地面线和零散噪点不会拉长框。
  const relevantComponents = structuralComponents.filter((component) =>
    mergedSeeds.some((seed) =>
      containsCenter(component, seed)
      || intersectArea(component, seed) > 0));

  const relevantMask = new Array<boolean>(foregroundMask.length).fill(false);
  for (const component of relevantComponents) {
    for (const cell of component.cells) relevantMask[cell] = true;
  }

  // 沿墨线做多源扩散，比直线距离更能保持同一物体的细长结构。例如台灯的
  // 灯罩、弯曲灯臂和底座会沿自身轮廓归到一起，不会被旁边的电脑抢走。
  const owner = new Int16Array(foregroundMask.length).fill(-1);
  const distance = new Int32Array(foregroundMask.length).fill(0x3fffffff);
  const queue: number[] = [];
  for (let cell = 0; cell < relevantMask.length; cell++) {
    if (!relevantMask[cell]) continue;
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < mergedSeeds.length; index++) {
      const seedDistance = distanceToComponent(col, row, mergedSeeds[index]);
      if (seedDistance < nearestDistance) {
        nearestDistance = seedDistance;
        nearestIndex = index;
      }
    }
    if (nearestDistance <= 4) {
      owner[cell] = nearestIndex;
      distance[cell] = 0;
      queue.push(cell);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const cell = queue[cursor];
    const row = Math.floor(cell / cols);
    const col = cell % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) continue;
        const next = nextRow * cols + nextCol;
        if (!relevantMask[next] || distance[next] <= distance[cell] + 1) continue;
        owner[next] = owner[cell];
        distance[next] = distance[cell] + 1;
        queue.push(next);
      }
    }
  }

  for (const component of relevantComponents) {
    for (const cell of component.cells) {
      const row = Math.floor(cell / cols);
      const col = cell % cols;
      let nearestIndex = owner[cell];
      if (nearestIndex < 0) {
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < mergedSeeds.length; index++) {
          const seedDistance = distanceToComponent(col, row, mergedSeeds[index]);
          if (seedDistance < nearestDistance) {
            nearestDistance = seedDistance;
            nearestIndex = index;
          }
        }
      }
      const target = assigned[nearestIndex];
      target.cells.push(cell);
      target.c0 = Math.min(target.c0, col);
      target.r0 = Math.min(target.r0, row);
      target.c1 = Math.max(target.c1, col);
      target.r1 = Math.max(target.r1, row);
    }
  }

  return assigned
    .filter((component) => component.cells.length >= minCells)
    .filter((component) => {
      const areaRatio = compArea(component) / total;
      return areaRatio >= 0.003 && areaRatio <= 0.72;
    });
}

/**
 * 对 RGBA 像素执行纯本地区域检测。独立导出以便使用合成图片做回归测试。
 */
export function detectRegionsFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: RegionDetectionOptions = {},
): DetectedRegion[] {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return [];

  const grid = buildCellGrid(data, width, height);
  const total = grid.cols * grid.rows;
  const background = estimateBackground(grid);
  const foregroundRatio = new Array<number>(total).fill(0);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const sx = Math.floor(col * grid.blockW);
      const ex = Math.min(width, Math.ceil((col + 1) * grid.blockW));
      const sy = Math.floor(row * grid.blockH);
      const ey = Math.min(height, Math.ceil((row + 1) * grid.blockH));
      let foregroundPixels = 0;
      let count = 0;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const index = (y * width + x) * 4;
          const foreground = background.transparent
            ? data[index + 3] > 90
            : data[index + 3] >= 40
              && colorDistance(
                data[index],
                data[index + 1],
                data[index + 2],
                background.r,
                background.g,
                background.b,
              ) >= background.threshold;
          if (foreground) foregroundPixels++;
          count++;
        }
      }
      foregroundRatio[row * grid.cols + col] = foregroundPixels / Math.max(1, count);
    }
  }

  const colorMask = grid.r.map((red, index) => {
    if (background.transparent) {
      return grid.a[index] > 90 || foregroundRatio[index] >= 0.12;
    }
    if (grid.a[index] < 40) return false;
    const averageDistance = colorDistance(
      red,
      grid.g[index],
      grid.b[index],
      background.r,
      background.g,
      background.b,
    );
    return averageDistance >= background.threshold || foregroundRatio[index] >= 0.12;
  });

  // 亮区通道在白底线稿中也有价值：封闭轮廓会把白色内部分割成独立区域，
  // 可以补回被细线连接成超大前景分量的卡片、白板、容器等对象。
  // 铺满画布的背景分量会在 connectedComponents 中被过滤。
  const brightThreshold = Math.min(232, Math.max(172, percentile(grid.luma, 0.88) - 14));
  const brightMask = grid.luma.map((value, index) =>
    !background.transparent && grid.a[index] >= 40 && value >= brightThreshold);

  const minCells = Math.max(3, Math.round(total * 0.00035));
  const colorComponents = mergeNearbyComponents(connectedComponents(
    stabilizeMask(colorMask, grid.cols, grid.rows),
    grid.cols,
    grid.rows,
    minCells,
  ));
  const brightComponents = mergeNearbyComponents(connectedComponents(
    stabilizeMask(brightMask, grid.cols, grid.rows),
    grid.cols,
    grid.rows,
    minCells,
  ));

  // 将细线加粗一格后查找“不与画布边缘连通”的背景空腔。
  // 这能识别白底线稿中的白板、卡片、容器和屏幕，即使它们的轮廓存在细小断口。
  const sealedForeground = dilateMask(colorMask, grid.cols, grid.rows, 1);
  const interiorMask = sealedForeground.map((foreground, index) =>
    !foreground && grid.a[index] >= 40);
  const interiorComponents = mergeNearbyComponents(connectedComponents(
    interiorMask,
    grid.cols,
    grid.rows,
    Math.max(minCells, Math.round(total * 0.001)),
  )
    .filter((component) =>
      component.c0 > 0
      && component.r0 > 0
      && component.c1 < grid.cols - 1
      && component.r1 < grid.rows - 1)
    .map((component) => ({
      ...component,
      c0: Math.max(0, component.c0 - 1),
      r0: Math.max(0, component.r0 - 1),
      c1: Math.min(grid.cols - 1, component.c1 + 1),
      r1: Math.min(grid.rows - 1, component.r1 + 1),
    })));

  const candidates = [...colorComponents, ...brightComponents, ...interiorComponents]
    .filter((component) => {
      const areaRatio = compArea(component) / total;
      const width = component.c1 - component.c0 + 1;
      const height = component.r1 - component.r0 + 1;
      return areaRatio >= 0.0015 && areaRatio <= 0.82 && width >= 2 && height >= 2;
    })
    .sort((left, right) => compArea(right) - compArea(left));

  const kept: Component[] = [];
  for (const component of candidates) {
    const duplicate = kept.some((existing) => {
      const intersection = intersectArea(component, existing);
      const smallerArea = Math.min(compArea(component), compArea(existing));
      const largerArea = Math.max(compArea(component), compArea(existing));
      const unionArea = compArea(component) + compArea(existing) - intersection;
      const similarSize = smallerArea / largerArea >= 0.65;
      return intersection / unionArea >= 0.58
        || (similarSize && intersection / smallerArea >= 0.85);
    });
    if (!duplicate) kept.push(component);
  }

  const lightLineArt = !background.transparent
    && (background.r + background.g + background.b) / 3 >= 215;
  const preferredRegionCount = options.preferredRegionCount === undefined
    ? undefined
    : clampInt(options.preferredRegionCount, 1, MAX_REGION_COUNT);
  const columnBandProposals = lightLineArt && preferredRegionCount
    ? buildColumnBandProposals(
      colorMask,
      grid.cols,
      grid.rows,
      minCells,
      preferredRegionCount,
    )
    : [];
  const expandedLineArt = lightLineArt
    ? expandLineArtSeeds(kept, colorMask, grid.cols, grid.rows, minCells)
    : [];
  // 白底线稿先把内部命中扩展为完整视觉组；其他图片继续沿用原来的通道聚合。
  // 极简图或实心图没有可扩展的结构分量时，回退到原来的候选，不能返回空结果。
  const regionCandidates = (columnBandProposals.length > 0
    ? columnBandProposals
    : expandedLineArt.length > 0
      ? expandedLineArt
      : mergeNearbyComponents(kept))
    .sort((left, right) => compArea(right) - compArea(left));
  // 先沿用已提交版本完成安全边界合并，再按面积过滤。若反过来先删候选，
  // 会丢失用于绕开相邻物体的完整视觉组，甚至让最大阈值返回空区域。
  const consolidated = regionCandidates;
  const limited = preferredRegionCount
    ? consolidated
    : consolidated.slice(0, MAX_REGION_COUNT)
      .sort((left, right) => (left.r0 !== right.r0 ? left.r0 - right.r0 : left.c0 - right.c0));
  const padX = 0.5 / grid.cols;
  const padY = 0.5 / grid.rows;
  const backgroundSafeComponents = lightLineArt && options.requireBackgroundSafe
    ? ensureBackgroundSafeComponents(
      limited,
      colorMask,
      grid.cols,
      grid.rows,
    )
    : limited.map((component) => ({
      component,
      points: lightLineArt && component.polygonSafe
        ? componentSafePolygon(component, grid.cols, grid.rows, colorMask)
        : [] as NormalizedPoint[],
    }));
  let minRegionAreaRatio = 0;
  if (options.minRegionThreshold !== undefined && backgroundSafeComponents.length > 0) {
    const threshold = clampInt(options.minRegionThreshold, 1, 100);
    const largestAreaRatio = Math.max(...backgroundSafeComponents.map(({component}) =>
      compArea(component) / total));
    const absoluteThreshold = threshold / 100;
    if (threshold <= 2) {
      // 1 和 2 保持直观的画布面积百分比语义；若整张图的主体本来就很小，
      // 不用绝对阈值把所有候选一次性清空。
      minRegionAreaRatio = largestAreaRatio >= absoluteThreshold
        ? absoluteThreshold
        : 0;
    } else {
      // 2 以上在 2% 与当前最大安全主体之间平滑收紧。100 只保留最大主体，
      // 且任意阈值都不会因为图片构图偏小而返回空结果。
      const baseline = largestAreaRatio >= 0.02 ? 0.02 : 0;
      const progress = (threshold - 2) / 98;
      minRegionAreaRatio = baseline + (largestAreaRatio - baseline) * progress;
    }
  }
  const safeComponents = backgroundSafeComponents.filter(({component}) =>
    compArea(component) / total >= minRegionAreaRatio);

  const regions: DetectedRegion[] = safeComponents.map(({component, points}) => {
    const boundedPoints = lightLineArt && points.length >= 3
      ? limitClosedPolygonPoints(points)
      : [];
    if (boundedPoints.length >= 3) {
      const left = Math.min(...boundedPoints.map((point) => point.x));
      const top = Math.min(...boundedPoints.map((point) => point.y));
      const right = Math.max(...boundedPoints.map((point) => point.x));
      const bottom = Math.max(...boundedPoints.map((point) => point.y));
      return {
        rect: {x: left, y: top, width: right - left, height: bottom - top},
        selectionType: 'freehand' as const,
        points: boundedPoints,
      };
    }
    const x = clamp01(component.c0 / grid.cols - padX);
    const y = clamp01(component.r0 / grid.rows - padY);
    const right = clamp01((component.c1 + 1) / grid.cols + padX);
    const bottom = clamp01((component.r1 + 1) / grid.rows + padY);
    return {
      rect: {x, y, width: right - x, height: bottom - y},
      selectionType: 'rectangle' as const,
      points: [],
    };
  });

  // 不同候选通道可能命中同一物品。轮廓补全后再去重，可避免同一物品显示
  // 两条几乎重合的边线；只有高度包含且尺寸相近时才合并，保留真正的独立区域。
  const byArea = [...regions].sort((left, right) =>
    right.rect.width * right.rect.height - left.rect.width * left.rect.height);
  const unique: DetectedRegion[] = [];
  for (const region of byArea) {
    const regionArea = region.rect.width * region.rect.height;
    const duplicate = unique.some((existing) => {
      const width = Math.max(0, Math.min(
        region.rect.x + region.rect.width,
        existing.rect.x + existing.rect.width,
      ) - Math.max(region.rect.x, existing.rect.x));
      const height = Math.max(0, Math.min(
        region.rect.y + region.rect.height,
        existing.rect.y + existing.rect.height,
      ) - Math.max(region.rect.y, existing.rect.y));
      const intersection = width * height;
      const existingArea = existing.rect.width * existing.rect.height;
      const smallerArea = Math.min(regionArea, existingArea);
      const largerArea = Math.max(regionArea, existingArea);
      return smallerArea > 0
        && intersection / smallerArea >= 0.92
        && smallerArea / largerArea >= 0.75;
    });
    if (!duplicate) unique.push(region);
  }
  if (preferredRegionCount) {
    const byTop = [...unique].sort((left, right) =>
      left.rect.y !== right.rect.y
        ? left.rect.y - right.rect.y
        : left.rect.x - right.rect.x);
    const lines: DetectedRegion[][] = [];
    for (const region of byTop) {
      const line = lines.find((values) => {
        const firstTop = Math.min(...values.map((value) => value.rect.y));
        return region.rect.y - firstTop <= 0.12;
      });
      if (line) line.push(region);
      else lines.push([region]);
    }
    return lines.flatMap((line) =>
      line.sort((left, right) => left.rect.x - right.rect.x));
  }
  return unique.sort((left, right) =>
    left.rect.y !== right.rect.y
      ? left.rect.y - right.rect.y
      : left.rect.x - right.rect.x);
}

/** 调用项目内 OpenCV 脚本生成流程 3 的自动圈选区域。 */
export async function autoDetectRegions(
  imageUrl: string,
  options: RegionDetectionOptions = {},
): Promise<DetectedRegion[]> {
  const response = await fetch('/api/detect-regions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      imageUrl,
      preferredRegionCount: options.preferredRegionCount,
      minRegionThreshold: options.minRegionThreshold,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || 'OpenCV 自动框选失败');
  }
  if (!Array.isArray(payload.regions)) {
    throw new Error('OpenCV 自动框选返回格式不正确');
  }

  return payload.regions.flatMap((value: unknown): DetectedRegion[] => {
    if (!value || typeof value !== 'object') return [];
    const raw = value as Record<string, unknown>;
    const rect = raw.rect as Record<string, unknown> | undefined;
    if (!rect) return [];
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const points = Array.isArray(raw.points)
      ? raw.points.flatMap((point: unknown): NormalizedPoint[] => {
        if (!point || typeof point !== 'object') return [];
        const px = Number((point as Record<string, unknown>).x);
        const py = Number((point as Record<string, unknown>).y);
        return Number.isFinite(px) && Number.isFinite(py)
          ? [{x: clamp01(px), y: clamp01(py)}]
          : [];
      })
      : [];
    const freehandPoints = raw.selectionType === 'freehand' && points.length >= 3
      ? sanitizeClosedPolygon(points)
      : [];
    const selectionType = freehandPoints.length >= 3
      ? 'freehand' as const
      : 'rectangle' as const;
    return [{
      rect: {
        x: clamp01(x),
        y: clamp01(y),
        width: Math.min(clamp01(width), 1 - clamp01(x)),
        height: Math.min(clamp01(height), 1 - clamp01(y)),
      },
      selectionType,
      points: selectionType === 'freehand' ? freehandPoints : [],
    }];
  });
}

/** 加载一张图片并估算用于该页遮罩的底色。 */
export async function detectImageBackgroundColor(imageUrl: string): Promise<string> {
  const img = await loadImage(imageUrl);
  const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) return '#ffffff';
  context.drawImage(img, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return estimateImageBackgroundColorFromImageData(imageData.data, width, height);
}
