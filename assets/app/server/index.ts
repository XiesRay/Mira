import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createCanvas} from '@napi-rs/canvas';
import {loadRasterImage} from './rasterImage.js';
import {parseProject} from '../src/core/project.js';
import {renderInSubprocess} from './renderer/renderProcess.js';
import {resolveFfmpegPath} from './renderer/ffmpegEncoder.js';
import type {ExportFormat, Project} from '../src/core/types.js';
import type {VideoData} from './videoTypes.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(appDir, '.runtime');
const port = Number(process.env.REGION_MOTION_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在 1024 到 65535 之间');
const publicOrigin = process.env.REGION_MOTION_PUBLIC_ORIGIN ? new URL(process.env.REGION_MOTION_PUBLIC_ORIGIN).origin : undefined;
const execFileAsync = promisify(execFile);
let ffmpegAvailable = false;
try {await execFileAsync(resolveFfmpegPath(), ['-version'], {timeout: 5000}); ffmpegAvailable = true;} catch { /* 页面仍可编辑和预览。 */ }
await fs.mkdir(runtimeDir, {recursive: true});
const opencvPython = process.env.OPENCV_PYTHON_BIN || 'python3';
const opencvScript = path.resolve(appDir, '../../scripts/opencv_object_boxer.py');
let opencvAvailable = false;
try {await execFileAsync(opencvPython, ['-c', 'import cv2, numpy'], {timeout: 15000}); opencvAvailable = true;} catch { /* 页面显示缺少依赖。 */ }
let activeDetections = 0;

type Job = {id: string; status: 'queued' | 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled';
  format: ExportFormat; progress: number; error?: string; cancelled: boolean; directory: string;
  finishedAt?: number; active: boolean; conversion?: AbortController};
const jobs = new Map<string, Job>();
const view = (job: Job) => ({id: job.id, format: job.format, status: job.status, progress: job.progress, error: job.error});
const resultName = (job: Job) => job.format === 'gif' ? 'animation.gif' : 'video.mp4';
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicOrigin ? [new URL(publicOrigin).host] : [])]);
  if (!allowedHosts.has(req.headers.host || '')) {res.status(403).json({error: '访问主机不受支持'}); return;}
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, publicOrigin].includes(origin)) {
    res.status(403).json({error: '拒绝跨站请求'}); return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use('/api', (_req, res, next) => {res.setHeader('Cache-Control', 'no-store'); next();});
app.get('/api/health', (_req, res) => res.json({app: 'region-motion', version: '0.1.0', ffmpeg: ffmpegAvailable, opencv: opencvAvailable,
  pid: process.pid, instance: createHash('sha256').update(appDir).digest('hex').slice(0, 12)}));
app.use(express.json({limit: '80mb'}));

/** 复用原项目的 OpenCV 脚本、默认阈值和命令行参数，保持原始图片像素。 */
app.post('/api/detect-regions', async (req, res) => {
  if (!opencvAvailable) {res.status(503).json({error: 'OpenCV 未就绪，请通过 skill 启动脚本准备依赖并重启'}); return;}
  if (activeDetections >= 2) {res.status(429).json({error: '自动框选任务较多，请稍后重试'}); return;}
  const match = typeof req.body?.imageUrl === 'string'
    ? req.body.imageUrl.match(/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=\r\n]+)$/) : null;
  if (!match) {res.status(400).json({error: '请选择本地 PNG、JPEG 或 WebP 图片'}); return;}
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {res.status(400).json({error: '图片内容为空或超过 20 MB'}); return;}
  const minRegionThreshold = Math.max(1, Math.min(100, Math.round(Number(req.body?.minRegionThreshold) || 2)));
  const preferredRegionCount = Number.isFinite(Number(req.body?.preferredRegionCount))
    ? Math.max(1, Math.min(50, Math.round(Number(req.body.preferredRegionCount)))) : null;
  activeDetections += 1;
  let directory: string | undefined;
  try {
    directory = await fs.mkdtemp(path.join(runtimeDir, 'detect-'));
    const imagePath = path.join(directory, `image.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
    await fs.writeFile(imagePath, bytes);
    const args = [opencvScript, imagePath, '--auto-json', '--min-region-threshold', String(minRegionThreshold),
      ...(preferredRegionCount === null ? [] : ['--preferred-count', String(preferredRegionCount)])];
    const {stdout} = await execFileAsync(opencvPython, args, {cwd: path.dirname(opencvScript),
      timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: {...process.env}});
    const result = JSON.parse(stdout);
    if (!Array.isArray(result?.regions)) throw new Error('脚本未返回 regions 数组');
    res.json({regions: result.regions});
  } catch (error) {
    const failure = error as Error & {stderr?: string; killed?: boolean};
    const message = failure.killed ? '自动框选处理超过 2 分钟，已停止。请重试或手动框选。'
      : String(failure.stderr || failure.message).trim().split('\n').filter(Boolean).at(-1) || '脚本调用失败';
    res.status(500).json({error: 'OpenCV 自动框选失败', message});
  } finally {
    activeDetections -= 1;
    if (directory) await fs.rm(directory, {recursive: true, force: true}).catch(console.error);
  }
});

async function prepareVideo(project: Project, directory: string, size: number): Promise<{videoData: VideoData; width: number; height: number}> {
  const first = project.scenes[0];
  const aspect = first.width / first.height;
  const width = Math.max(2, Math.round((aspect >= 1 ? size : size * aspect) / 2) * 2);
  const height = Math.max(2, Math.round((aspect >= 1 ? size / aspect : size) / 2) * 2);
  const scenes: VideoData['scenes'] = [];
  for (const [index, scene] of project.scenes.entries()) {
    const bytes = Buffer.from(scene.imageUrl.split(',')[1], 'base64');
    if (bytes.length > 20 * 1024 * 1024) throw new Error('单张图片超过 20 MB');
    const image = await loadRasterImage(bytes, directory, index);
    if (image.width !== scene.width || image.height !== scene.height) throw new Error('图片尺寸与项目记录不一致');
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = scene.backgroundColor;
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / image.width, height / image.height);
    const fitW = image.width * scale / width;
    const fitH = image.height * scale / height;
    const fitX = (1 - fitW) / 2;
    const fitY = (1 - fitH) / 2;
    context.drawImage(image, fitX * width, fitY * height, fitW * width, fitH * height);
    const imageName = `scene-${index}.png`;
    await fs.writeFile(path.join(directory, imageName), await canvas.encode('png'));
    scenes.push({type: 'illustration', title: scene.name, backgroundColor: scene.backgroundColor,
      images: [imageName], durationInFrames: Math.max(1, Math.round(scene.duration * 30)), transition: scene.transition,
      regions: scene.regions.map((region) => ({...region, startTime: Math.max(0, region.startTime - scene.startTime),
        rect: {x: fitX + region.rect.x * fitW, y: fitY + region.rect.y * fitH, width: region.rect.width * fitW, height: region.rect.height * fitH},
        points: region.points.map((point) => ({x: fitX + point.x * fitW, y: fitY + point.y * fitH})),
      })),
    });
  }
  return {width, height, videoData: {theme: 'tech-dark', hideProgressBar: true, scenes}};
}

async function execute(job: Job, project: Project, size: number): Promise<void> {
  try {
    const prepared = await prepareVideo(project, job.directory, size);
    if (job.cancelled) return;
    job.status = 'rendering';
    await renderInSubprocess({...prepared, fps: 30, publicDir: job.directory,
      mode: 'quick', outputPath: path.join(job.directory, 'video.mp4')}, {
      shouldCancel: () => job.cancelled,
      onProgress: (done, total) => {job.progress = Math.min(99, done / total * (job.format === 'gif' ? 90 : 99));},
      onEncoding: () => {job.status = 'encoding';},
    });
    if (job.format === 'gif' && !job.cancelled) {
      job.status = 'encoding';
      job.progress = 92;
      job.conversion = new AbortController();
      const input = path.join(job.directory, 'video.mp4');
      const palette = path.join(job.directory, 'palette.png');
      const options = {signal: job.conversion.signal, maxBuffer: 1024 * 1024};
      // 分两次处理调色板，避免分支滤镜在内存中缓存整个动画。
      await execFileAsync(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input, '-vf', 'fps=15,palettegen=stats_mode=diff', '-frames:v', '1', '-threads', '1', palette], options);
      job.progress = 95;
      await execFileAsync(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input, '-i', palette, '-filter_complex_threads', '1', '-lavfi',
        '[0:v]fps=15[frames];[frames][1:v]paletteuse=dither=sierra2_4a', '-an', '-loop', '0',
        path.join(job.directory, 'animation.gif')], options);
    }
    if (!job.cancelled) {job.status = 'done'; job.progress = 100;}
  } catch (error) {
    if (!job.cancelled) {job.status = 'error'; job.error = error instanceof Error ? error.message : '导出失败';}
  } finally {
    job.active = false;
    job.finishedAt = Date.now();
    try {
      for (const entry of await fs.readdir(job.directory)) {
        if (entry !== resultName(job) || job.status !== 'done') await fs.rm(path.join(job.directory, entry), {recursive: true, force: true});
      }
    } catch (error) {console.error('清理临时素材失败:', error);}
  }
}

app.post('/api/exports', async (req, res) => {
  try {
    if (!req.is('application/json')) {res.status(415).json({error: '请发送 JSON 项目'}); return;}
    if ([...jobs.values()].some((job) => job.active)) {res.status(409).json({error: '已有导出正在运行，请等待完成或取消'}); return;}
    if (!ffmpegAvailable) {res.status(503).json({error: '没有找到 FFmpeg，请安装后重新启动 skill'}); return;}
    const project = parseProject(req.body.project);
    if (!project.scenes.length) throw new Error('请先上传图片');
    if (project.scenes.some((scene) => scene.width / scene.height < 0.1 || scene.width / scene.height > 10)) throw new Error('导出图片宽高比须在 1:10 到 10:1 之间');
    if (project.scenes.reduce((total, scene) => total + scene.duration, 0) > 600) throw new Error('单次导出最长 10 分钟，请拆分项目');
    const size = 1920;
    const format = req.body.format ?? 'mp4';
    if (format !== 'mp4' && format !== 'gif') throw new Error('请选择 MP4 或 GIF 导出格式');
    const id = randomUUID();
    const directory = path.join(runtimeDir, 'exports', id);
    const job: Job = {id, directory, format, status: 'queued', progress: 0, cancelled: false, active: true};
    // 先占用槽位，防止 mkdir 等待期间接到并行导出。
    jobs.set(id, job);
    try {await fs.mkdir(directory, {recursive: true});} catch (error) {jobs.delete(id); throw error;}
    res.status(202).json(view(job));
    void execute(job, project, size);
  } catch (error) {res.status(400).json({error: error instanceof Error ? error.message : '项目格式错误'});}
});

app.get('/api/exports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {res.status(404).json({error: '找不到导出任务，服务重启后请重新导出'}); return;}
  res.json(view(job));
});
app.delete('/api/exports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {res.status(404).json({error: '找不到导出任务'}); return;}
  if (job.active) {job.cancelled = true; job.status = 'cancelled'; job.conversion?.abort();}
  res.json(view(job));
});
app.get('/api/exports/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') {res.status(404).json({error: '视频尚未完成或已过期'}); return;}
  res.download(path.join(job.directory, resultName(job)), `region-motion.${job.format}`, (error) => {
    if (error && !res.headersSent) res.status(404).json({error: '导出文件不存在，请重新导出'});
  });
});
app.use('/api', (_req, res) => res.status(404).json({error: '接口不存在'}));
app.use(express.static(path.join(appDir, 'dist')));
app.use((error: Error & {type?: string}, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.type === 'entity.too.large' ? 413 : 400).json({error: error.type === 'entity.too.large' ? '项目超过 80 MB' : '请求格式不正确'});
});

const server = app.listen(port, '127.0.0.1', () => console.log(`Region Motion ready: http://127.0.0.1:${port}`));
server.on('error', (error) => {console.error(error.message); process.exitCode = 1;});
const prune = setInterval(() => {
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.now() - job.finishedAt > 24 * 60 * 60 * 1000) {
      jobs.delete(id);
      void fs.rm(job.directory, {recursive: true, force: true}).catch(console.error);
    }
  }
}, 60 * 1000);
prune.unref();
const stop = () => {
  for (const job of jobs.values()) {job.cancelled = true; job.conversion?.abort();}
  clearInterval(prune);
  server.close(() => {process.exitCode = 0;});
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
