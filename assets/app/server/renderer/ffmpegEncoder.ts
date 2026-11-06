/** 从原项目 Canvas → FFmpeg 编码链路提取；独立版仅输出无声音轨的 MP4。 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {Writable} from 'node:stream';
import type {Timeline, VideoData} from './types';

export function resolveFfmpegPath(): string {
  return [process.env.FFMPEG_PATH, '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']
    .find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) || 'ffmpeg';
}

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  outputPath: string;
  videoData: VideoData;
  timeline: Timeline;
  publicDir: string;
}
export interface RawFrameEncoder {
  frameStream: Writable;
  done: Promise<void>;
  finish: () => Promise<void>;
  cancel: () => void;
}
const outputArgs = (outputPath: string): string[] => [
  '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-movflags', '+faststart', outputPath,
];

export async function encodeRawFramesToVideo(opts: EncodeOptions): Promise<RawFrameEncoder> {
  const proc = spawn(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', String(opts.fps),
    '-i', 'pipe:0', ...outputArgs(opts.outputPath)], {stdio: ['pipe', 'ignore', 'pipe']});
  let stderr = '';
  proc.stderr.on('data', (data) => {stderr = (stderr + data.toString()).slice(-65536);});
  const done = new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.stdin.once('error', reject);
    proc.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 编码失败（${code}）\n${stderr.slice(-2000)}`)));
  });
  void done.catch(() => {});
  return {
    frameStream: proc.stdin,
    done,
    finish: () => {proc.stdin.end(); return done;},
    cancel: () => {proc.stdin.destroy(); proc.kill('SIGKILL');},
  };
}

export async function encodeFrameFilesToVideo(opts: EncodeOptions & {
  framesDir: string; framePattern?: string; startNumber?: number;
}): Promise<{usedVideotoolbox: boolean}> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(opts.fps),
    '-start_number', String(opts.startNumber ?? 0), '-i', path.join(opts.framesDir, opts.framePattern ?? 'element-%04d.jpeg'),
    ...outputArgs(opts.outputPath)];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args, {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    proc.stderr.on('data', (data) => {stderr = (stderr + data.toString()).slice(-65536);});
    proc.once('error', reject);
    proc.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 帧序列编码失败（${code}）\n${stderr.slice(-2000)}`)));
  });
  return {usedVideotoolbox: false};
}
