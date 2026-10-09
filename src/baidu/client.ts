import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { BaiduOAuthManager } from "./oauth";
import { buildMultipartFormData } from "./multipart";
import {
  BaiduCreateResponse,
  BaiduFileItem,
  BaiduFileMeta,
  BaiduFileMetasResponse,
  BaiduPrecreateResponse,
  BaiduFileManagerResponse
} from "./types";

export interface ListingProgress {
  directoriesScanned: number;
  directoriesQueued: number;
  directoriesSkipped: number;
  filesFound: number;
  requests: number;
  retries: number;
  elapsedMs: number;
  concurrency: number;
}
export interface ListingOptions {
  concurrency?: number;
  shouldSkipDirectory?: (relativePath: string) => boolean;
  onProgress?: (progress: ListingProgress) => void;
}
export class BaiduClient {
  private tokenRefresh?: Promise<string>;
  private async refreshRequestToken(param: RequestUrlParam): Promise<RequestUrlParam> {
    const url = new URL(param.url);
    const failedToken = url.searchParams.get('access_token');
    if (!this.tokenRefresh) {
      this.tokenRefresh = (async () => {
        const current = await this.oauth.refreshTokenIfNeeded();
        return current !== failedToken ? current : await this.oauth.refreshTokenIfNeeded(true);
      })();
    }
    const pending = this.tokenRefresh;
    try {
      url.searchParams.set('access_token', await pending);
      return { ...param, url: url.toString() };
    } finally {
      if (this.tokenRefresh === pending) this.tokenRefresh = undefined;
    }
  }
  constructor(private oauth: BaiduOAuthManager) {}

  private async requestWithRetry(
    param: RequestUrlParam,
    maxRetries = 3,
    initialDelayMs = 1000,
    onRetry?: (error: unknown) => void
  ): Promise<RequestUrlResponse> {
    let lastError: unknown = null;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await requestUrl(param);
        // Baidu sometimes returns HTTP 200 with errno: 31034 (QPS limit exceeded) or errno: -6 (invalid token)
        if (resp.status === 200) {
          try {
            const data = resp.json as { errno?: number } | undefined;
            if (data && typeof data === "object") {
              if (data.errno === 31034) {
                // Rate limit hit
                throw new Error("Baidu Rate Limit Hit (errno: 31034)");
              }
              if (data.errno === -6) {
                // Token expired, force refresh and retry
                console.warn("[BaiduSync] Token 失效，尝试刷新并重试...");
                param = await this.refreshRequestToken(param);
                throw new Error("Token expired (errno: -6)");
              }
            }
          } catch (e: unknown) {
            // If it's our re-thrown error, rethrow it
            if (e instanceof Error && (e.message.includes("Rate Limit") || e.message.includes("Token expired"))) {
              throw e;
            }
            // Otherwise, resp is non-JSON file content (markdown, image, binary)
          }
          return resp;
        }

        if (resp.status === 429 || resp.status >= 500) {
          throw new Error(`Server Error HTTP ${resp.status}`);
        }

        return resp;
      } catch (err: unknown) {
        lastError = err;
        if (attempt < maxRetries) {
          // Exponential backoff with jitter; count only retries that will run.
          onRetry?.(err);
          const jitter = Math.random() * 300;
          await new Promise((r) => window.setTimeout(r, delay + jitter));
          delay *= 2;
        }
      }
    }

    throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
  }

  async listAll(rootPath: string, allowMissingRoot = false, options: ListingOptions = {}): Promise<BaiduFileItem[]> {
    await this.oauth.refreshTokenIfNeeded();
    const cleanPath = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
    if (!cleanPath.startsWith('/') || cleanPath.split('/').slice(1).some(p => !p || p === '.' || p === '..') || cleanPath.includes('\\')) {
      throw new Error('云端同步目录无效，停止同步');
    }
    const requested = options.concurrency ?? 2;
    let concurrency = Number.isFinite(requested) ? Math.max(1, Math.min(3, Math.floor(requested))) : 2;
    const started = Date.now();
    const allFiles: BaiduFileItem[] = [];
    const dirQueue = [cleanPath];
    const seenPaths = new Set<string>();
    const progress: ListingProgress = {
      directoriesScanned: 0, directoriesQueued: 1, directoriesSkipped: 0,
      filesFound: 0, requests: 0, retries: 0, elapsedMs: 0, concurrency
    };
    const report = () => options.onProgress?.({ ...progress, elapsedMs: Date.now() - started, concurrency });
    let failed = false;
    const scanDirectory = async (currentDir: string) => {
      let start = 0;
      const limit = 1000;
      while (!failed) {
        // Reuse a refreshed token on later directories/pages, not the initial stale one.
        const token = await (this.tokenRefresh ?? this.oauth.refreshTokenIfNeeded());
        if (failed) return;
        const url = 'https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=' + encodeURIComponent(currentDir) +
          '&order=name&desc=0&start=' + start + '&limit=' + limit + '&web=web&folder=0&access_token=' + encodeURIComponent(token);
        progress.requests++;
        report();
        const resp = await this.requestWithRetry({ url, method: 'GET' }, 3, 1000, error => {
          progress.requests++; progress.retries++;
          if (error instanceof Error && /31034|429|Rate Limit/.test(error.message)) concurrency = 1;
          report();
        });
        if (failed) return;
        if (resp.status !== 200) throw new Error('获取网盘文件列表失败: HTTP ' + resp.status);
        const raw: unknown = resp.json;
        if (!raw || typeof raw !== 'object' || !('errno' in raw) || typeof raw.errno !== 'number') {
          throw new Error('云端返回不完整文件列表，停止同步');
        }
        if (raw.errno === -9 || raw.errno === 31066 || raw.errno === 20020) {
          if (!allowMissingRoot || currentDir !== cleanPath || start !== 0) {
            throw new Error('云端目录缺失或扫描中发生变化，本轮停止，不能据此推断删除');
          }
          break;
        }
        if (raw.errno !== 0) throw new Error('获取网盘列表返回异常 (errno: ' + raw.errno + ')');
        if (!('list' in raw) || !Array.isArray(raw.list) || raw.list.length > limit) {
          throw new Error('云端返回不完整文件列表，停止同步');
        }
        for (const value of raw.list as unknown[]) {
          if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' ||
              !('isdir' in value) || (value.isdir !== 0 && value.isdir !== 1)) {
            throw new Error('云端文件条目无效，停止同步');
          }
          const path = value.path;
          const child = path.startsWith(currentDir + '/') ? path.slice(currentDir.length + 1) : '';
          if (!child || child.includes('/') || child.includes('\\') || child === '.' || child === '..' || child.includes('\0')) {
            throw new Error('云端返回目录外或无效路径，停止同步');
          }
          if (seenPaths.has(path)) throw new Error('云端分页返回重复路径，停止同步以免使用不完整清单');
          seenPaths.add(path);
          if (value.isdir === 1) {
            if (options.shouldSkipDirectory?.(path.slice(cleanPath.length + 1))) progress.directoriesSkipped++;
            else { dirQueue.push(path); progress.directoriesQueued++; }
          } else { allFiles.push(value as BaiduFileItem); progress.filesFound++; }
        }
        report();
        const more: unknown = 'has_more' in raw ? raw.has_more : undefined;
        if (more !== undefined && more !== 0 && more !== 1) throw new Error('云端分页标识无效，停止同步');
        const hasMore = more === undefined ? raw.list.length === limit : more === 1;
        if (!hasMore) break;
        if (raw.list.length === 0) throw new Error('云端分页没有前进，停止同步');
        start += raw.list.length;
      }
      if (!failed) { progress.directoriesScanned++; report(); }
    };
    // Drain in-flight requests on failure; never publish a partial listing.
    // Pages in each directory remain serial to preserve pagination correctness.
    while (dirQueue.length && !failed) {
      const batch = dirQueue.splice(0, concurrency);
      const settled = await Promise.allSettled(batch.map(async dir => {
        try { await scanDirectory(dir); } catch (error) { failed = true; throw error; }
      }));
      const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected) { report(); throw rejected.reason; }
    }
    report();
    return allFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  async getFileMeta(fsId: string | number): Promise<BaiduFileMeta> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[${fsId}]&dlink=1&access_token=${token}`;

    const resp = await this.requestWithRetry({
      url,
      method: "GET"
    });

    if (resp.status !== 200) {
      throw new Error(`获取文件元数据失败: HTTP ${resp.status}`);
    }

    const data = resp.json as unknown as BaiduFileMetasResponse;
    if (!data.list || data.list.length === 0) {
      throw new Error(`未找到文件元数据 fsId=${fsId}`);
    }

    return data.list[0];
  }

  async downloadFile(dlink: string): Promise<ArrayBuffer> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const connector = dlink.includes("?") ? "&" : "?";
    const finalUrl = `${dlink}${connector}access_token=${token}`;

    const resp = await this.requestWithRetry({
      url: finalUrl,
      method: "GET",
      headers: {
        "User-Agent": "pan.baidu.com"
      }
    });

    if (resp.status !== 200) {
      throw new Error(`下载文件失败: HTTP ${resp.status}`);
    }

    return resp.arrayBuffer;
  }

  async precreate(remotePath: string, size: number, blockList: string[]): Promise<BaiduPrecreateResponse> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      autoinit: "1",
      rtype: "3", // overwrite existing
      block_list: JSON.stringify(blockList)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`Precreate 失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data = resp.json as unknown as BaiduPrecreateResponse;
    if (data.errno !== 0) {
      throw new Error(`Precreate 错误 [errno: ${data.errno}]: ${resp.text}`);
    }

    return data;
  }

  async uploadSlice(
    remotePath: string,
    uploadid: string,
    partseq: number,
    sliceBuffer: ArrayBuffer
  ): Promise<void> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&uploadid=${encodeURIComponent(
      uploadid
    )}&partseq=${partseq}&path=${encodeURIComponent(remotePath)}&access_token=${token}`;

    const { body, contentType } = buildMultipartFormData(sliceBuffer, "file", "blob");

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": contentType
      },
      body: body
    });

    if (resp.status !== 200) {
      throw new Error(`分片上传失败 partseq=${partseq} (HTTP ${resp.status}): ${resp.text}`);
    }
  }

  async createFile(
    remotePath: string,
    size: number,
    uploadid: string,
    blockList: string[]
  ): Promise<BaiduCreateResponse> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: size.toString(),
      isdir: "0",
      rtype: "3",
      uploadid: uploadid,
      block_list: JSON.stringify(blockList)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`合并创建文件失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data = resp.json as unknown as BaiduCreateResponse;
    if (data.errno !== 0) {
      throw new Error(`落盘创建文件错误 [errno: ${data.errno}]: ${resp.text}`);
    }

    return data;
  }

  async createDirectory(remotePath: string): Promise<void> {
    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;

    const body = new URLSearchParams({
      path: remotePath,
      size: "0",
      isdir: "1",
      rtype: "0"
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const data = resp.json as unknown as BaiduCreateResponse;
    // errno 0 = success, -8 = dir already exists (ignore)
    if (data.errno !== 0 && data.errno !== -8) {
      console.warn(`创建目录警告 path=${remotePath} errno=${data.errno}`);
    }
  }

  async deleteFiles(remotePaths: string[]): Promise<void> {
    if (remotePaths.length === 0) return;

    const token = await this.oauth.refreshTokenIfNeeded();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${token}`;

    const body = new URLSearchParams({
      filelist: JSON.stringify(remotePaths)
    });

    const resp = await this.requestWithRetry({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.status !== 200) {
      throw new Error(`删除网盘文件失败 (HTTP ${resp.status}): ${resp.text}`);
    }

    const data = resp.json as unknown as BaiduFileManagerResponse;
    if (data.errno !== 0) {
      throw new Error(`删除网盘文件错误 [errno: ${data.errno}]: ${resp.text}`);
    }
  }
}
