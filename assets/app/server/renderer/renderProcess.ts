import {fork} from 'node:child_process';
import type {RenderHooks} from './renderer.js';
import type {VideoData} from './types';

export type RenderTask = {
  videoData: VideoData;
  width: number;
  height: number;
  fps: number;
  publicDir: string;
  outputPath: string;
} & ({mode: 'quick'} | {
  mode: 'frames';
  framesDir: string;
  startFrame: number;
  jpegQuality: number;
  totalFrames: number;
});

export type RenderMessage =
  | {type: 'progress'; done: number; total: number}
  | {type: 'encoding'}
  | {type: 'done'}
  | {type: 'error'; message: string};

/** Canvas 和素材解码在独立进程执行，主进程仅接收进度及处理取消。 */
export function renderInSubprocess(
  task: RenderTask,
  hooks: RenderHooks & {onEncoding?: () => void} = {},
): Promise<void> {
  if (hooks.shouldCancel?.()) return Promise.reject(new Error('渲染已取消'));
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== 'win32';
    const child = fork(new URL('./renderWorker.ts', import.meta.url), [], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      detached: useProcessGroup,
    });
    let completed = false;
    let canceled = false;
    let failure: Error | undefined;
    const stopWorker = () => {
      if (!child.pid) return;
      try {
        // FFmpeg 继承进程组，一起终止，避免取消后编码进程继续占用资源。
        if (useProcessGroup) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('[RenderWorker] 停止进程失败:', error);
      }
    };
    const cancelTimer = setInterval(() => {
      if (!canceled && hooks.shouldCancel?.()) {
        canceled = true;
        stopWorker();
      }
    }, 100);
    const cleanup = () => {
      clearInterval(cancelTimer);
      process.removeListener('exit', stopWorker);
    };
    process.once('exit', stopWorker);
    child.on('message', (message: RenderMessage) => {
      if (canceled) return;
      if (message.type === 'progress') hooks.onProgress?.(message.done, message.total);
      else if (message.type === 'encoding') hooks.onEncoding?.();
      else if (message.type === 'done') completed = true;
      else if (message.type === 'error') failure = new Error(message.message);
    });
    child.once('error', (error) => {
      failure = error;
      stopWorker();
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (canceled || hooks.shouldCancel?.()) reject(new Error('渲染已取消'));
      else if (failure) reject(failure);
      else if (completed && code === 0) resolve();
      else reject(new Error(`渲染进程异常退出（${signal || code}）`));
    });
    child.send(task, (error) => {
      if (error) {
        failure = error;
        stopWorker();
      }
    });
  });
}
