import fs from 'node:fs';
import path from 'node:path';
import {prepareRenderContext, renderFramesToDir, renderVideoQuick} from './renderer.js';
import {encodeFrameFilesToVideo} from './ffmpegEncoder.js';
import type {RenderMessage, RenderTask} from './renderProcess.js';

// 父服务退出后清理本进程及 FFmpeg，避免热重启留下后台渲染。
const onDisconnect = () => {
  if (process.platform !== 'win32') process.kill(-process.pid, 'SIGTERM');
  else process.exit(1);
};
process.once('disconnect', onDisconnect);

const send = (message: RenderMessage) => {
  if (process.connected) process.send?.(message);
};

process.once('message', async (task: RenderTask) => {
  let lastPercent = -1;
  const onProgress = (done: number, total: number) => {
    const percent = Math.floor(done / Math.max(1, total) * 100);
    if (percent === lastPercent && done !== total) return;
    lastPercent = percent;
    send({type: 'progress', done, total});
    if (done === total) send({type: 'encoding'});
  };
  let result: RenderMessage;
  try {
    const render = await prepareRenderContext(task.videoData, task);
    if (task.mode === 'quick') {
      await renderVideoQuick(render, task.outputPath, {onProgress});
    } else {
      if (task.startFrame < task.totalFrames) {
        await renderFramesToDir(render, task.framesDir, {
          startFrame: task.startFrame,
          jpegQuality: task.jpegQuality,
          hooks: {onProgress},
        });
      }
      send({type: 'encoding'});
      const framePattern = fs.existsSync(path.join(task.framesDir, 'element-0000.png'))
        ? 'element-%04d.png' : 'element-%04d.jpeg';
      await encodeFrameFilesToVideo({
        ...task,
        timeline: render.timeline,
        framePattern,
        startNumber: 0,
      });
    }
    result = {type: 'done'};
  } catch (error) {
    process.exitCode = 1;
    result = {type: 'error', message: error instanceof Error ? error.message : String(error)};
  }
  if (process.connected) {
    process.send?.(result, () => {
      process.removeListener('disconnect', onDisconnect);
      process.disconnect();
    });
  }
});
