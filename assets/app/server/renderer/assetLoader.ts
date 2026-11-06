/**
 * 素材预加载：渲染前统一加载并解码所有场景 base 图与全局背景图。
 * 任一素材加载失败立即抛错（含场景索引 / 素材来源），绝不静默产出空白帧。
 */
import fs from 'fs';
import path from 'path';
import {lookup as dnsLookup} from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import {BlockList, isIP, type LookupFunction} from 'node:net';
import {type Image, loadImage} from '@napi-rs/canvas';
import type {RenderAssets, VideoData} from './types';

const MAX_REMOTE_ASSET_BYTES = 20 * 1024 * 1024;
const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_ASSET_LOADS = 4;
const MAX_REMOTE_REDIRECTS = 3;

const ALLOWED_REMOTE_CONTENT_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// 使用 Node 的标准地址匹配器集中拒绝内网、链路本地、组播、文档及其他保留网段。
const BLOCKED_REMOTE_ADDRESSES = new BlockList();
const addBlockedSubnet = (subnet: string, prefix: number, family: 'ipv4' | 'ipv6') => {
  BLOCKED_REMOTE_ADDRESSES.addSubnet(subnet, prefix, family);
};
const blockedIpv4Subnets: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
];
const blockedIpv6Subnets: ReadonlyArray<readonly [string, number]> = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:0::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
];
for (const [subnet, prefix] of blockedIpv4Subnets) addBlockedSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of blockedIpv6Subnets) addBlockedSubnet(subnet, prefix, 'ipv6');

/** 与 LayoutEngine.toStaticFilePath 一致：去掉 /public/ 前缀与前导斜杠，逐段解码。 */
export function toStaticFilePath(src: string): string {
  const withoutPublicPrefix = src.startsWith('/public/')
    ? src.replace(/^\/public\//, '')
    : src.replace(/^\/+/, '');
  const decodedPath = withoutPublicPrefix
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
  if (
    path.posix.isAbsolute(decodedPath) ||
    path.win32.isAbsolute(decodedPath) ||
    decodedPath.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`本地素材路径非法: ${src}`);
  }
  return decodedPath;
}

function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveLocalAssetPath(src: string, publicDir: string): Promise<string> {
  const relativePath = toStaticFilePath(src);
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`本地素材路径非法: ${src}`);
  }

  const realPublicDir = await fs.promises.realpath(path.resolve(publicDir));
  const lexicalPath = path.resolve(realPublicDir, relativePath);
  if (!isPathWithinDirectory(realPublicDir, lexicalPath)) {
    throw new Error(`本地素材路径超出 public 目录: ${src}`);
  }

  let realAssetPath: string;
  try {
    realAssetPath = await fs.promises.realpath(lexicalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`本地文件不存在: ${lexicalPath}`);
    }
    throw err;
  }

  if (!isPathWithinDirectory(realPublicDir, realAssetPath)) {
    throw new Error(`本地素材路径指向 public 目录之外: ${src}`);
  }

  const stat = await fs.promises.stat(realAssetPath);
  if (!stat.isFile()) {
    throw new Error(`本地素材不是文件: ${realAssetPath}`);
  }
  return realAssetPath;
}

function isForbiddenAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return true;
  if (isIP(address) !== family) return true;
  return BLOCKED_REMOTE_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function normaliseHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function isForbiddenHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'local' ||
    hostname.endsWith('.local') ||
    hostname === 'internal' ||
    hostname.endsWith('.internal')
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface ResolvedRemoteAddress {
  address: string;
  family: 4 | 6;
}

async function resolveRemoteAddress(url: URL): Promise<ResolvedRemoteAddress> {
  const hostname = normaliseHostname(url.hostname);
  if (!hostname || isForbiddenHostname(hostname)) {
    throw new Error(`远程素材主机名被禁止: ${hostname || '(empty)'}`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isForbiddenAddress(hostname, literalFamily)) {
      throw new Error(`远程素材地址被禁止: ${hostname}`);
    }
    return {address: hostname, family: literalFamily};
  }

  const addresses = await withTimeout(
    dnsLookup(hostname, {all: true, verbatim: true}),
    DNS_LOOKUP_TIMEOUT_MS,
    '远程素材 DNS 解析超时',
  );
  if (!addresses.length) throw new Error(`远程素材无法解析主机: ${hostname}`);

  // 校验解析结果中的每个地址，并在实际请求中固定到其中一个地址，降低 DNS 重绑定风险。
  for (const address of addresses) {
    if (isForbiddenAddress(address.address, address.family)) {
      throw new Error(`远程素材解析到被禁止的地址: ${address.address}`);
    }
  }
  const selected = addresses[0];
  return {address: selected.address, family: selected.family as 4 | 6};
}

function parseRemoteUrl(src: string): URL {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error('远程素材 URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`远程素材协议不受支持: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('远程素材 URL 不允许携带用户凭据');
  }
  return url;
}

async function requestRemoteAsset(url: URL, redirectCount = 0): Promise<Buffer> {
  const resolved = await resolveRemoteAddress(url);
  const client = url.protocol === 'https:' ? https : http;
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    if (typeof _options === 'object' && _options.all) {
      const callbackAll = callback as (
        error: NodeJS.ErrnoException | null,
        addresses: Array<{address: string; family: number}>,
      ) => void;
      callbackAll(null, [resolved]);
      return;
    }
    const callbackOne = callback as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void;
    callbackOne(null, resolved.address, resolved.family);
  };

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    let overallTimeout: ReturnType<typeof setTimeout> | undefined;
    let request: http.ClientRequest | undefined;
    const chunks: Buffer[] = [];
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (overallTimeout) clearTimeout(overallTimeout);
      request?.destroy();
      reject(err);
    };

    const currentRequest = client.request(
      {
        hostname: normaliseHostname(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname || '/'}${url.search}`,
        method: 'GET',
        headers: {Accept: 'image/*', Host: url.host},
        lookup,
        timeout: REMOTE_REQUEST_TIMEOUT_MS,
        // 重定向由响应处理器逐跳重新校验，不交给客户端自动跟随。
        maxHeaderSize: 16 * 1024,
      },
      (response) => {
        if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
          const location = response.headers.location;
          if (!location || redirectCount >= MAX_REMOTE_REDIRECTS) {
            response.resume();
            fail(new Error('远程素材重定向地址无效或次数过多'));
            return;
          }
          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, url);
            parseRemoteUrl(redirectUrl.toString());
          } catch {
            response.resume();
            fail(new Error('远程素材重定向地址无效'));
            return;
          }
          settled = true;
          if (overallTimeout) clearTimeout(overallTimeout);
          response.resume();
          void requestRemoteAsset(redirectUrl, redirectCount + 1).then(resolve, reject);
          return;
        }
        const contentTypeHeader = response.headers['content-type'];
        const contentType = typeof contentTypeHeader === 'string'
          ? contentTypeHeader.split(';', 1)[0].trim().toLowerCase()
          : '';
        const contentLength = Number(response.headers['content-length']);

        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`HTTP ${response.statusCode ?? '未知'} ${response.statusMessage ?? ''}`.trim()));
          return;
        }
        if (!ALLOWED_REMOTE_CONTENT_TYPES.has(contentType)) {
          response.resume();
          fail(new Error(`远程素材 Content-Type 不受支持: ${contentType || '(empty)'}`));
          return;
        }
        if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_ASSET_BYTES) {
          response.resume();
          fail(new Error(`远程素材响应超过大小限制 (${MAX_REMOTE_ASSET_BYTES} bytes)`));
          return;
        }

        response.on('data', (chunk: Buffer | Uint8Array) => {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += part.length;
          if (totalBytes > MAX_REMOTE_ASSET_BYTES) {
            response.destroy();
            fail(new Error(`远程素材响应超过大小限制 (${MAX_REMOTE_ASSET_BYTES} bytes)`));
            return;
          }
          chunks.push(part);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          if (overallTimeout) clearTimeout(overallTimeout);
          resolve(Buffer.concat(chunks, totalBytes));
        });
        response.on('error', fail);
      },
    );
    request = currentRequest;
    overallTimeout = setTimeout(
      () => fail(new Error(`远程素材请求超时 (${REMOTE_REQUEST_TIMEOUT_MS}ms)`)),
      REMOTE_REQUEST_TIMEOUT_MS,
    );
    currentRequest.on('timeout', () => fail(new Error(`远程素材请求超时 (${REMOTE_REQUEST_TIMEOUT_MS}ms)`)));
    currentRequest.on('error', fail);
    currentRequest.end();
  });
}

async function loadOne(src: string, publicDir: string, context: string): Promise<Image> {
  try {
    if (/^https?:\/\//i.test(src)) {
      const buf = await requestRemoteAsset(parseRemoteUrl(src));
      return await loadImage(buf);
    }
    const filePath = await resolveLocalAssetPath(src, publicDir);
    return await loadImage(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`素材加载失败 [${context}] src="${src}": ${message}`);
  }
}

export interface LoadAssetsOptions {
  /** public 目录绝对路径，用于解析非 http 素材。 */
  publicDir: string;
}

/**
 * 预加载 videoData 中所有场景的 base 图（images[0]）与全局背景图。
 * 以“数据中出现的原始 src 字符串”为 key，供渲染阶段按 scene.images[0] 直接取用。
 */
export async function loadRenderAssets(
  videoData: VideoData,
  options: LoadAssetsOptions,
): Promise<RenderAssets> {
  const {publicDir} = options;
  const images = new Map<string, Image>();

  // 收集去重后的 (src, context) 列表。
  const jobs: {src: string; context: string}[] = [];
  const seen = new Set<string>();
  const pushJob = (src: string | undefined, context: string) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    jobs.push({src, context});
  };

  const scenes = Array.isArray(videoData.scenes) ? videoData.scenes : [];
  scenes.forEach((scene, index) => {
    const baseImage = scene.images?.[0];
    pushJob(baseImage, `场景#${index}(${scene.type}) base 图`);
  });

  // 使用固定数量的 worker，避免一次性发起无限并发的网络 / 解码任务。
  let nextJobIndex = 0;
  const worker = async () => {
    while (nextJobIndex < jobs.length) {
      const job = jobs[nextJobIndex++];
      const image = await loadOne(job.src, publicDir, job.context);
      images.set(job.src, image);
    }
  };
  const workerCount = Math.min(MAX_CONCURRENT_ASSET_LOADS, jobs.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));

  // 全局背景图（可选）。
  let background: Image | undefined;
  if (videoData.backgroundImage) {
    background = await loadOne(videoData.backgroundImage, publicDir, '全局背景图');
  }

  return {images, background};
}
