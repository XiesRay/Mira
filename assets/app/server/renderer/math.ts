/**
 * 纯数学工具，复刻 Remotion 的 interpolate / spring 计算，供确定性逐帧渲染使用。
 * 本模块不依赖 React / DOM / Remotion / Canvas，可被单元测试直接覆盖。
 */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** easeOutCubic：与 Remotion 的 Easing.out(Easing.cubic) 等价。 */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** easeOutQuad：与 regionAnimation 中的 1-(1-p)^2 等价，区域动画缓动。 */
export const easeOutQuad = (t: number): number => 1 - Math.pow(1 - t, 2);

export type EasingFn = (t: number) => number;

interface InterpolateOptions {
  easing?: EasingFn;
  extrapolateLeft?: 'clamp' | 'extend';
  extrapolateRight?: 'clamp' | 'extend';
}

/**
 * 复刻 Remotion 的 interpolate。默认线性、两端 extend；缓动作用于每段归一化进度。
 * 支持多点区间（inputRange 单调递增）。
 */
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolateOptions = {},
): number {
  if (inputRange.length !== outputRange.length) {
    throw new Error('interpolate: inputRange 与 outputRange 长度必须一致');
  }
  if (inputRange.length < 2) {
    throw new Error('interpolate: 区间至少需要 2 个点');
  }
  const {easing = (t) => t, extrapolateLeft = 'extend', extrapolateRight = 'extend'} = options;

  // 定位所在段。
  let i = 0;
  const last = inputRange.length - 1;
  for (; i < last - 1; i++) {
    if (input <= inputRange[i + 1]) break;
  }
  const inMin = inputRange[i];
  const inMax = inputRange[i + 1];
  const outMin = outputRange[i];
  const outMax = outputRange[i + 1];

  let progress = inMax === inMin ? 0 : (input - inMin) / (inMax - inMin);

  if (progress < 0) {
    if (extrapolateLeft === 'clamp') progress = 0;
  } else if (progress > 1) {
    if (extrapolateRight === 'clamp') progress = 1;
  }

  const eased = easing(progress);
  return outMin + eased * (outMax - outMin);
}

/** Spring 物理参数（与 Remotion config 对齐）。 */
export interface SpringConfig {
  damping: number;
  mass: number;
  stiffness: number;
}

export const DEFAULT_SPRING_CONFIG: SpringConfig = {
  damping: 20,
  mass: 1,
  stiffness: 100,
};

/**
 * 复刻 Remotion springCalculation：阻尼谐振子解析解。
 * from=0, to=1, 初速度 0。返回该时刻位置（趋近 1）。
 */
export function springValue(frame: number, fps: number, config: SpringConfig = DEFAULT_SPRING_CONFIG): number {
  const {damping, mass, stiffness} = config;
  const t = frame / fps;
  if (t <= 0) return 0;

  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  // d(t) 为剩余距离（初值 1，初速度 0）；position = 1 - d(t)。
  let d: number;
  if (zeta < 1) {
    // 欠阻尼
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * w0 * t);
    d = envelope * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    // 临界阻尼（damping20/mass1/stiffness100 命中此分支）
    d = (1 + w0 * t) * Math.exp(-w0 * t);
  } else {
    // 过阻尼
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    const c1 = -r2 / (r1 - r2);
    const c2 = 1 - c1;
    d = c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  }
  return 1 - d;
}

/**
 * 复刻 Remotion measureSpring：找到位置首次落入阈值内的整数帧数（自然时长）。
 */
export function measureSpring(fps: number, config: SpringConfig = DEFAULT_SPRING_CONFIG, threshold = 0.005): number {
  let frame = 0;
  // 上限防止极端配置死循环（10 秒足够所有正常弹簧收敛）。
  const maxFrame = fps * 10;
  while (frame <= maxFrame) {
    if (Math.abs(1 - springValue(frame, fps, config)) < threshold) return frame;
    frame += 1;
  }
  return maxFrame;
}

/**
 * 复刻 Remotion springTiming({durationInFrames, config}) 的 getProgress：
 * 将自然弹簧曲线拉伸到 durationInFrames，并归一化到端点精确为 1。
 * frame 为转场内的本地帧（0..durationInFrames）。
 */
export function springProgress(
  frame: number,
  durationInFrames: number,
  fps: number,
  config: SpringConfig = DEFAULT_SPRING_CONFIG,
): number {
  if (durationInFrames <= 0) return 1;
  const natural = measureSpring(fps, config);
  const ratio = natural / durationInFrames;
  const raw = (f: number) => springValue(f * ratio, fps, config);
  const endpoint = raw(durationInFrames);
  if (endpoint === 0) return frame >= durationInFrames ? 1 : 0;
  return raw(frame) / endpoint;
}
