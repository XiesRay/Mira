import type {NormalizedPoint} from './types';

export interface SmoothCurveSegment {
  start: NormalizedPoint;
  control: NormalizedPoint;
  end: NormalizedPoint;
}

export interface SmoothClosedCurve {
  start: NormalizedPoint;
  segments: SmoothCurveSegment[];
}

const CORNER_ROUNDING_RATIO = 0.03;
const GEOMETRY_EPSILON = 1e-8;

/** 自由多边形进入编辑器和持久化结构的固定点数上限。 */
export const MAX_CLOSED_POLYGON_POINTS = 64;

const cross = (
  origin: NormalizedPoint,
  left: NormalizedPoint,
  right: NormalizedPoint,
) => (left.x - origin.x) * (right.y - origin.y)
  - (left.y - origin.y) * (right.x - origin.x);

const pointOnSegment = (
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
) => Math.abs(cross(start, end, point)) <= GEOMETRY_EPSILON
  && point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
  && point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
  && point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON
  && point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON;

const pointToSegmentDistanceSquared = (
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    const pointDX = point.x - start.x;
    const pointDY = point.y - start.y;
    return pointDX * pointDX + pointDY * pointDY;
  }
  const amount = Math.max(0, Math.min(
    1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
  ));
  const distanceX = point.x - (start.x + amount * dx);
  const distanceY = point.y - (start.y + amount * dy);
  return distanceX * distanceX + distanceY * distanceY;
};

const simplifyOpenPath = (
  points: NormalizedPoint[],
  toleranceSquared: number,
): NormalizedPoint[] => {
  if (points.length <= 2) return points;
  const kept = new Uint8Array(points.length);
  kept[0] = 1;
  kept[points.length - 1] = 1;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [startIndex, endIndex] = pending.pop()!;
    let furthestIndex = -1;
    let furthestDistance = toleranceSquared;
    for (let index = startIndex + 1; index < endIndex; index++) {
      const distance = pointToSegmentDistanceSquared(
        points[index],
        points[startIndex],
        points[endIndex],
      );
      if (distance > furthestDistance) {
        furthestIndex = index;
        furthestDistance = distance;
      }
    }
    if (furthestIndex < 0) continue;
    kept[furthestIndex] = 1;
    pending.push([startIndex, furthestIndex], [furthestIndex, endIndex]);
  }
  return points.filter((_, index) => kept[index] === 1);
};

const simplifyClosedPathAtTolerance = (
  points: NormalizedPoint[],
  toleranceSquared: number,
): NormalizedPoint[] => {
  let anchorIndex = 1;
  let furthestDistance = 0;
  for (let index = 1; index < points.length; index++) {
    const distance = pointToSegmentDistanceSquared(points[index], points[0], points[0]);
    if (distance > furthestDistance) {
      anchorIndex = index;
      furthestDistance = distance;
    }
  }
  const firstPath = simplifyOpenPath(
    points.slice(0, anchorIndex + 1),
    toleranceSquared,
  );
  const secondPath = simplifyOpenPath(
    [...points.slice(anchorIndex), points[0]],
    toleranceSquared,
  );
  return [...firstPath, ...secondPath.slice(1, -1)];
};

const takeEvenlySpacedPoints = (
  points: NormalizedPoint[],
): NormalizedPoint[] => {
  const count = Math.min(MAX_CLOSED_POLYGON_POINTS, points.length);
  if (count === points.length) return points;
  return Array.from({length: count}, (_, index) =>
    points[Math.floor(index * points.length / count)]);
};

const simplifyClosedPolygon = (points: NormalizedPoint[]): NormalizedPoint[] => {
  if (points.length <= MAX_CLOSED_POLYGON_POINTS) return points;

  let lowerTolerance = 0;
  let upperTolerance = 2;
  let simplified = takeEvenlySpacedPoints(points);
  for (let pass = 0; pass < 18; pass++) {
    const tolerance = (lowerTolerance + upperTolerance) / 2;
    const candidate = simplifyClosedPathAtTolerance(points, tolerance * tolerance);
    if (candidate.length > MAX_CLOSED_POLYGON_POINTS) {
      lowerTolerance = tolerance;
    } else {
      simplified = candidate;
      upperTolerance = tolerance;
    }
  }
  return simplified.length >= 3
    ? simplified
    : takeEvenlySpacedPoints(points);
};

const clampCoordinate = (value: number) => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value))
  : 0;

const normalizePoints = (points: NormalizedPoint[]): NormalizedPoint[] => {
  let changed = false;
  const normalized = points.map((point) => {
    const next = {x: clampCoordinate(point.x), y: clampCoordinate(point.y)};
    if (next.x !== point.x || next.y !== point.y) changed = true;
    return next;
  });
  return changed ? normalized : points;
};

/**
 * 将闭合轮廓归一化并限制点数，不负责修复自交或重复回路。
 * @param points 待限制的闭合轮廓点。
 * @returns 坐标位于 0 到 1 且不超过固定上限的轮廓点。
 */
export const limitClosedPolygonPoints = (points: NormalizedPoint[]): NormalizedPoint[] =>
  simplifyClosedPolygon(normalizePoints(points));

const segmentsIntersect = (
  firstStart: NormalizedPoint,
  firstEnd: NormalizedPoint,
  secondStart: NormalizedPoint,
  secondEnd: NormalizedPoint,
) => {
  const a = cross(firstStart, firstEnd, secondStart);
  const b = cross(firstStart, firstEnd, secondEnd);
  const c = cross(secondStart, secondEnd, firstStart);
  const d = cross(secondStart, secondEnd, firstEnd);
  const crossesProperly = ((a > GEOMETRY_EPSILON && b < -GEOMETRY_EPSILON)
    || (a < -GEOMETRY_EPSILON && b > GEOMETRY_EPSILON))
    && ((c > GEOMETRY_EPSILON && d < -GEOMETRY_EPSILON)
      || (c < -GEOMETRY_EPSILON && d > GEOMETRY_EPSILON));
  if (crossesProperly) return true;
  return (Math.abs(a) <= GEOMETRY_EPSILON && pointOnSegment(secondStart, firstStart, firstEnd))
    || (Math.abs(b) <= GEOMETRY_EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (Math.abs(c) <= GEOMETRY_EPSILON && pointOnSegment(firstStart, secondStart, secondEnd))
    || (Math.abs(d) <= GEOMETRY_EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd));
};

const isSimplePolygon = (points: NormalizedPoint[]) => {
  if (points.length < 3) return false;
  const unique = new Set(points.map((point) => `${point.x.toFixed(8)}:${point.y.toFixed(8)}`));
  if (unique.size !== points.length) return false;
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(twiceArea) <= GEOMETRY_EPSILON) return false;
  for (let first = 0; first < points.length; first++) {
    const firstEnd = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second++) {
      const secondEnd = (second + 1) % points.length;
      if (firstEnd === second || secondEnd === first) continue;
      if (segmentsIntersect(
        points[first],
        points[firstEnd],
        points[second],
        points[secondEnd],
      )) return false;
    }
  }
  return true;
};

const polygonAreaMagnitude = (points: NormalizedPoint[]) => Math.abs(points.reduce(
  (sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  },
  0,
));

const removeRepeatedLoops = (points: NormalizedPoint[]) => {
  let result = [...points];
  for (let pass = 0; pass < points.length && result.length >= 3; pass++) {
    const seen = new Map<string, number>();
    let changed = false;
    for (let index = 0; index < result.length; index++) {
      const point = result[index];
      const key = `${point.x.toFixed(8)}:${point.y.toFixed(8)}`;
      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, index);
        continue;
      }
      const firstBranch = result.slice(previous, index);
      const secondBranch = [...result.slice(index), ...result.slice(0, previous)];
      const candidates = [firstBranch, secondBranch].filter((branch) => branch.length >= 3);
      result = candidates.sort((left, right) =>
        polygonAreaMagnitude(right) - polygonAreaMagnitude(left))[0] ?? result;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return result;
};

/**
 * 归一化并清洗闭合轮廓，同时限制其点数。
 * @param points 待清洗的闭合轮廓点。
 * @returns 保持输入基本几何有效性并位于归一化坐标范围内的轮廓。
 */
export const sanitizeClosedPolygon = (points: NormalizedPoint[]): NormalizedPoint[] => {
  const normalized = normalizePoints(points);
  if (normalized.length < 3) return normalized;
  // 先限流，避免旧项目的大轮廓进入 O(n²) 自交检查。
  const candidate = simplifyClosedPolygon(normalized);
  if (isSimplePolygon(candidate)) return candidate;
  const withoutLoops = removeRepeatedLoops(candidate);
  if (isSimplePolygon(withoutLoops)) return withoutLoops;
  const left = Math.min(...withoutLoops.map((point) => point.x));
  const top = Math.min(...withoutLoops.map((point) => point.y));
  const right = Math.max(...withoutLoops.map((point) => point.x));
  const bottom = Math.max(...withoutLoops.map((point) => point.y));
  if (right - left <= GEOMETRY_EPSILON || bottom - top <= GEOMETRY_EPSILON) return candidate;
  return [
    {x: left, y: top},
    {x: right, y: top},
    {x: right, y: bottom},
    {x: left, y: bottom},
  ];
};

const pointToward = (
  origin: NormalizedPoint,
  target: NormalizedPoint,
): NormalizedPoint => ({
  x: origin.x + (target.x - origin.x) * CORNER_ROUNDING_RATIO,
  y: origin.y + (target.y - origin.y) * CORNER_ROUNDING_RATIO,
});

/**
 * 只在每个拐角附近使用短二次贝塞尔圆角，其余部分保留原始安全边线。
 * 圆角比例必须足够小，避免像原来的中点曲线一样大幅向选区内部收缩。
 */
export const getSmoothClosedCurve = (
  points: NormalizedPoint[],
): SmoothClosedCurve | null => {
  if (points.length < 3) return null;
  const safePoints = sanitizeClosedPolygon(points);
  const segments = safePoints.map((control, index) => ({
    start: pointToward(control, safePoints[(index - 1 + safePoints.length) % safePoints.length]),
    control,
    end: pointToward(control, safePoints[(index + 1) % safePoints.length]),
  }));
  return {
    start: segments[0].start,
    segments,
  };
};

const formatCoordinate = (value: number) => Number(value.toFixed(4));

export const getSmoothClosedCurvePath = (points: NormalizedPoint[]): string => {
  const curve = getSmoothClosedCurve(points);
  if (!curve) return '';
  const commands = curve.segments.map(({start, control, end}, index) => (
    `${index === 0 ? '' : `L ${formatCoordinate(start.x)} ${formatCoordinate(start.y)} `}`
    + `Q ${formatCoordinate(control.x)} ${formatCoordinate(control.y)} ${formatCoordinate(end.x)} ${formatCoordinate(end.y)}`
  ));
  return `M ${formatCoordinate(curve.start.x)} ${formatCoordinate(curve.start.y)} ${commands.join(' ')} Z`;
};

const quadraticPoint = (
  start: NormalizedPoint,
  control: NormalizedPoint,
  end: NormalizedPoint,
  t: number,
): NormalizedPoint => {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
};

/** 为 CSS polygon 生成足够密的曲线采样点，保证播放预览与 SVG 曲线一致。 */
export const sampleSmoothClosedCurve = (
  points: NormalizedPoint[],
  samplesPerSegment = 6,
): NormalizedPoint[] => {
  const curve = getSmoothClosedCurve(points);
  if (!curve) return points;
  const samples = Math.max(2, Math.floor(samplesPerSegment));
  const result: NormalizedPoint[] = [];
  for (const segment of curve.segments) {
    result.push(segment.start);
    for (let step = 1; step <= samples; step += 1) {
      result.push(quadraticPoint(
        segment.start,
        segment.control,
        segment.end,
        step / samples,
      ));
    }
  }
  return result;
};
