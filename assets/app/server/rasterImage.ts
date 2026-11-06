import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadImage, type Image} from '@napi-rs/canvas';
import {resolveFfmpegPath} from './renderer/ffmpegEncoder.js';

const execFileAsync = promisify(execFile);

/** 浏览器可显示但 Canvas 无法解码的位图，转成标准 RGBA PNG 后读取。 */
export async function loadRasterImage(bytes: Buffer, directory: string, sceneIndex: number): Promise<Image> {
  try {
    return await loadImage(bytes);
  } catch (originalError) {
    const input = path.join(directory, `source-${sceneIndex}.image`);
    const output = path.join(directory, `normalized-${sceneIndex}.png`);
    try {
      await fs.writeFile(input, bytes);
      await execFileAsync(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input, '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', '-threads', '1', output],
      {timeout: 30000, maxBuffer: 1024 * 1024});
      return await loadImage(await fs.readFile(output));
    } catch (error) {
      const original = originalError instanceof Error ? originalError.message : String(originalError);
      const failure = error as Error & {stderr?: string};
      const detail = String(failure.stderr || failure.message).trim().split('\n').filter(Boolean).at(-1);
      throw new Error(`第 ${sceneIndex + 1} 张图片无法解码（${original}；${detail || '图片格式转换失败'}）`);
    } finally {
      await Promise.all([input, output].map((file) => fs.rm(file, {force: true}).catch(() => {})));
    }
  }
}
