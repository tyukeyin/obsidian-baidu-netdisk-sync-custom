import { md5 } from "../crypto/md5";
import { App, TFile } from "obsidian";
import { BaiduSyncSettings } from "../settings/settings";
import { BaiduClient } from "../baidu/client";
import { BaiduUploader } from "../baidu/uploader";
import { BaiduDownloader } from "../baidu/downloader";
import { ManifestManager } from "./manifest";
import { SyncFilter } from "./filter";
import { AsyncQueue } from "./queue";
import { allowsAction, isSyncPolicy, isMirrorPolicy, SYNC_POLICIES, SyncPolicy } from "./policy";
import {
  SyncPlanner,
  SyncPlanItem,
  LocalFileInfo,
  RemoteFileInfo
} from "./planner";

export type SyncState = "idle" | "preparing" | "diffing" | "syncing" | "error";

export interface SyncLogEntry {
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  detail?: string;
}

export class SyncEngine {
  private state: SyncState = "idle";
  private filter: SyncFilter;
  private queue: AsyncQueue;
  private uploader: BaiduUploader;
  private downloader: BaiduDownloader;
  private logs: SyncLogEntry[] = [];
  private onStateChangeListeners: Array<(state: SyncState, message?: string) => void> = [];
  private onLogListeners: Array<(entry: SyncLogEntry) => void> = [];

  constructor(
    private app: App,
    private getSettings: () => BaiduSyncSettings,
    private saveSettings: (settings: BaiduSyncSettings) => Promise<void>,
    private client: BaiduClient,
    private manifest: ManifestManager,
    private approveMirror: (plans: SyncPlanItem[]) => Promise<boolean> = async () => false,
    private selectPolicy?: (initial: SyncPolicy) => Promise<SyncPolicy | null>
  ) {
    const settings = this.getSettings();
    this.filter = new SyncFilter(settings, this.app.vault.configDir);
    this.queue = new AsyncQueue(settings.concurrency || 3);
    this.uploader = new BaiduUploader(this.client);
    this.downloader = new BaiduDownloader(this.client);
  }

  onStateChange(listener: (state: SyncState, message?: string) => void): () => void {
    this.onStateChangeListeners.push(listener);
    return () => {
      this.onStateChangeListeners = this.onStateChangeListeners.filter((l) => l !== listener);
    };
  }

  onLog(listener: (entry: SyncLogEntry) => void): () => void {
    this.onLogListeners.push(listener);
    return () => {
      this.onLogListeners = this.onLogListeners.filter((l) => l !== listener);
    };
  }

  private setState(state: SyncState, message?: string): void {
    this.state = state;
    for (const listener of this.onStateChangeListeners) {
      listener(state, message);
    }
  }

  getState(): SyncState {
    return this.state;
  }

  isSyncing(): boolean {
    return this.state !== "idle" && this.state !== "error";
  }

  getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  addLog(level: "info" | "success" | "warn" | "error", message: string, detail?: string): void {
    const entry: SyncLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      detail
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) {
      this.logs.pop();
    }
    for (const listener of this.onLogListeners) {
      try {
        listener(entry);
      } catch {
        // ignore listener errors
      }
    }
  }

  async startSync(silent = false, selectForRun = true): Promise<{ success: boolean; cancelled?: boolean; stats: { uploaded: number; downloaded: number; deleted: number; errors: number } }> {
    if (this.state !== "idle" && this.state !== "error") {
      this.addLog("warn", "已有同步任务正在运行，跳过本次触发");
      return { success: false, stats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 } };
    }

    const settings = { ...this.getSettings() };
    if (!settings.accessToken) {
      this.addLog("error", "未配置百度网盘授权，请先前往设置授权账号");
      this.setState("error", "未授权账号");
      return { success: false, stats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 } };
    }

    this.filter.updateSettings(settings);
    this.queue.setConcurrency(settings.concurrency || 3);

    const stats = { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 };
    const startTime = Date.now();
    const configuredPolicy = settings.syncPolicy;

    try {
      if (!silent && selectForRun && this.selectPolicy) {
        this.setState("preparing", "等待选择同步方式...");
        const initial = isSyncPolicy(settings.lastManualPolicy) ? settings.lastManualPolicy : settings.syncPolicy;
        const selected = await this.selectPolicy(initial);
        if (selected === null) {
          this.setState("idle", "已取消");
          return { success: false, cancelled: true, stats };
        }
        if (!isSyncPolicy(selected)) throw new Error("未知同步策略");
        settings.syncPolicy = selected;
        await this.saveSettings({ ...this.getSettings(), lastManualPolicy: selected });
      }
      const policy = settings.syncPolicy;
      if (!isSyncPolicy(policy)) throw new Error("未知同步策略，请在设置中重新选择。");
      if (silent && isMirrorPolicy(policy)) {
        this.addLog("info", "覆盖/还原模式仅支持手动同步，已跳过自动触发");
        return { success: false, cancelled: true, stats };
      }
      this.addLog("info", `本轮同步方向：${SYNC_POLICIES[policy]}`);
      this.setState("preparing", "正在加载同步清单...");
      await this.manifest.load();

      // Step 1: Scan local files
      this.setState("diffing", "正在扫描本地文件...");
      const localFiles = await this.scanLocalFiles();

      // Step 2: Scan remote files
      this.setState("diffing", "正在检索百度网盘文件列表...");
      const remoteFiles = await this.scanRemoteFiles(settings.remoteBasePath,
        Object.keys(this.manifest.getAll()).length === 0 && policy !== "receive" && policy !== "mirrorReceive");

      // Bootstrap legacy plaintext histories only with evidence of matching bytes.
      // Never compare plaintext hashes with encrypted remote bytes.
      if (!settings.enableE2EE) {
        const history = this.manifest.getAll();
        for (const [path, local] of localFiles) {
          const remote = remoteFiles.get(path);
          const previous = history[path];
          if (local.contentHash && remote?.md5 && local.contentHash === remote.md5.toLowerCase()) {
            this.manifest.set({ path, remotePath: remote.remotePath, mtime: local.mtime,
              remoteMtime: remote.mtime, size: local.size, remoteSize: remote.size,
              fsId: remote.fsId, md5: remote.md5, contentHash: local.contentHash });
          } else if (local.contentHash && previous?.md5 && !previous.contentHash &&
              local.contentHash === previous.md5.toLowerCase()) {
            this.manifest.set({ ...previous, contentHash: local.contentHash });
          }
        }
      }

      // Step 3: Compute diff plan
      this.setState("diffing", "正在对比差异并裁决冲突 (LWW)...");
      const plans = SyncPlanner.plan(
        localFiles,
        remoteFiles,
        Object.fromEntries(Object.entries(this.manifest.getAll()).filter(([path]) => !this.filter.shouldIgnore(path))),
        settings.remoteBasePath,
        policy
      );

      for (const item of plans.filter(p => p.action === "SKIP")) this.addLog("warn", `跳过 ${item.path}：${item.reason}`);
      const skipped = plans.filter(p => p.action === "SKIP").length;
      if (skipped) this.addLog("warn", `有 ${skipped} 个文件因目标端变更或缺少历史而保留，未同步；两端不一定一致。`);
      if (isMirrorPolicy(policy) && plans.length && !(await this.approveMirror(plans))) {
        this.addLog("info", "已取消覆盖/还原，本轮未传输或删除文件");
        this.setState("idle", "已取消");
        return { success: false, cancelled: true, stats };
      }
      if (isMirrorPolicy(policy) && plans.length) {
        const fingerprint = (files: Map<string, LocalFileInfo | RemoteFileInfo>) =>
          JSON.stringify([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
        if (fingerprint(await this.scanLocalFiles()) !== fingerprint(localFiles) ||
            fingerprint(await this.scanRemoteFiles(settings.remoteBasePath)) !== fingerprint(remoteFiles)) {
          throw new Error("预览后文件发生变化，已停止执行，请重新同步并核对清单。");
        }
      }

      if (plans.length === 0) {
        await this.manifest.save();
        this.addLog("info", "当前同步方向下无待执行操作");
        this.setState("idle", "同步完成 (无变动)");
        return { success: true, stats };
      }

      this.addLog("info", `规划完成，待执行操作数: ${plans.length}`);

      // Step 4: Execute actions
      this.setState("syncing", `同步中 (0/${plans.length})...`);
      let processed = 0;

      const orderedPlans = [...plans].sort((a, b) =>
        Number(a.action.startsWith("DELETE") || a.action === "CLEAN_MANIFEST") -
        Number(b.action.startsWith("DELETE") || b.action === "CLEAN_MANIFEST"));
      let deletionChecked = false;
      for (const item of orderedPlans) {
        await this.queue.add(async () => {
          try {
            if (item.action.startsWith("DELETE") || item.action === "CLEAN_MANIFEST") {
              if (stats.errors) throw new Error("前序操作失败，保留旧路径，待下次同步重试");
              if (!deletionChecked) {
                // Persist new paths before removing any old copy.
                await this.manifest.save();
                const freshRemote = await this.scanRemoteFiles(settings.remoteBasePath);
                for (const removal of orderedPlans.filter(p => p.action.startsWith("DELETE"))) {
                  const fresh = freshRemote.get(removal.path);
                  if (removal.action === "DELETE_LOCAL" && fresh) throw new Error("云端路径重新出现，停止清理");
                  if (removal.action === "DELETE_REMOTE" && (!fresh || fresh.mtime !== removal.remote?.mtime || fresh.size !== removal.remote?.size || fresh.md5 !== removal.remote?.md5)) throw new Error("云端文件发生变化，停止清理");
                }
                deletionChecked = true;
              }
            }
            if (this.getSettings().syncPolicy !== configuredPolicy || this.getSettings().remoteBasePath !== settings.remoteBasePath) throw new Error("同步设置已改变，请重新同步");
            if (!allowsAction(policy, item.action)) throw new Error("同步方向禁止执行此操作");
            await this.executePlanItem(item, settings);
            if (item.action === "UPLOAD") stats.uploaded++;
            else if (item.action === "DOWNLOAD") stats.downloaded++;
            else if (item.action === "DELETE_LOCAL" || item.action === "DELETE_REMOTE") stats.deleted++;
          } catch (err: unknown) {
            stats.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            this.addLog("error", `处理失败: ${item.path}`, msg);
          } finally {
            processed++;
            this.setState("syncing", `同步中 (${processed}/${plans.length})...`);
          }
        });
      }

      await this.queue.waitAll();

      // Step 5: Save manifest
      this.manifest.updateLastSyncTime();
      await this.manifest.save();

      await this.saveSettings({ ...this.getSettings(), lastSyncTime: Date.now() });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = `同步完成！用时 ${elapsed}s | 上传: ${stats.uploaded}, 下载: ${stats.downloaded}, 删除: ${stats.deleted}, 失败: ${stats.errors}`;
      this.addLog(stats.errors > 0 ? "warn" : "success", summary);

      this.setState("idle", "同步完成");
      return { success: stats.errors === 0, stats };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addLog("error", "同步过程中发生严重异常", msg);
      this.setState("error", msg);
      return { success: false, stats };
    }
  }

  private async executePlanItem(item: SyncPlanItem, settings: BaiduSyncSettings): Promise<void> {
    const adapter = this.app.vault.adapter;

    switch (item.action) {
      case "UPLOAD": {
        if (!(await adapter.exists(item.path))) {
          throw new Error("待上传文件已移动或删除，请重新同步");
        }
        const buffer = await adapter.readBinary(item.path);
        if (item.local?.contentHash && md5(new Uint8Array(buffer)) !== item.local.contentHash) throw new Error("扫描后本地内容已变化，请重新同步");
        const stat = await adapter.stat(item.path);
        const localMtime = stat?.mtime || Date.now();

        const res = await this.uploader.uploadFile(item.remotePath, buffer, {
          enableE2EE: settings.enableE2EE,
          e2eePassword: settings.e2eePassword
        });

        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: localMtime,
          contentHash: md5(new Uint8Array(buffer)),
          remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
          md5: res.md5 || "",
          size: stat?.size || buffer.byteLength,
          remoteSize: res.size,
          fsId: res.fs_id
        });
        this.addLog("success", `上传成功: ${item.path}`);
        break;
      }

      case "DOWNLOAD": {
        if (!item.remote?.fsId) {
          throw new Error(`缺少远端 fs_id，无法下载: ${item.path}`);
        }

        const buffer = await this.downloader.downloadByFsId(item.remote.fsId, {
          e2eePassword: settings.e2eePassword
        });

        // Ensure parent directory exists
        const segments = item.path.split("/");
        for (let i = 1; i < segments.length; i++) {
          const dir = segments.slice(0, i).join("/");
          if (!(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
          }
        }

        await this.assertLocalUnchanged(item);
        await adapter.writeBinary(item.path, buffer);
        if (md5(new Uint8Array(await adapter.readBinary(item.path))) !== md5(new Uint8Array(buffer))) throw new Error("下载文件落盘校验失败，保留旧路径");
        const stat = await adapter.stat(item.path);

        this.manifest.set({
          path: item.path,
          remotePath: item.remotePath,
          mtime: stat?.mtime || Date.now(),
          contentHash: md5(new Uint8Array(buffer)),
          remoteMtime: item.remote.mtime,
          md5: item.remote.md5 || "",
          size: buffer.byteLength,
          remoteSize: item.remote.size,
          fsId: item.remote.fsId
        });
        this.addLog("success", `下载成功: ${item.path}`);
        break;
      }

      case "DELETE_LOCAL": {
        await this.assertLocalUnchanged(item);
        if (await adapter.exists(item.path)) {
          const file = this.app.vault.getAbstractFileByPath(item.path);
          if (file && file instanceof TFile) {
            await this.app.fileManager.trashFile(file); // Respect user trash preference
          } else {
            // For files under config directory or files not indexed by Vault
            await adapter.trashLocal(item.path);
          }
          this.addLog("info", `移入本地回收站: ${item.path}`);
        }
        this.manifest.delete(item.path);
        await this.pruneEmptyParents(item.path);
        break;
      }

      case "DELETE_REMOTE": {
        if (await adapter.exists(item.path)) throw new Error("本地路径已重新出现，停止删除云端文件");
        await this.client.deleteFiles([item.remotePath]);
        this.manifest.delete(item.path);
        this.addLog("info", `移入网盘回收站: ${item.path}`);
        break;
      }

      case "CLEAN_MANIFEST": {
        this.manifest.delete(item.path);
        break;
      }

      default:
        break;
    }
  }

  private async assertLocalUnchanged(item: SyncPlanItem): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(item.path);
    if (!item.local && exists) throw new Error("本地出现新文件，保留并等待重新同步");
    if (item.local?.contentHash && (!exists || md5(new Uint8Array(await adapter.readBinary(item.path))) !== item.local.contentHash)) {
      throw new Error("本地内容已变化，保留并等待重新同步");
    }
  }

  private async pruneEmptyParents(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let dir = path.slice(0, path.lastIndexOf("/"));
    if (!path.includes("/")) return;
    while (dir && !this.filter.shouldIgnore(dir) && dir !== this.app.vault.configDir && !dir.startsWith(this.app.vault.configDir + "/")) {
      const children = await adapter.list(dir);
      if (children.files.length || children.folders.length) break;
      await adapter.rmdir(dir, false);
      this.addLog("info", `清理旧空目录: ${dir}`);
      if (!dir.includes("/")) break;
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }

  async convertVaultToPlaintext(
    onProgress?: (processed: number, total: number, currentPath: string) => void
  ): Promise<{ success: boolean; total: number; errors: number }> {
    if (this.state !== "idle" && this.state !== "error") {
      throw new Error("已有同步任务正在运行，请等待当前任务完成。");
    }

    const settings = this.getSettings();
    if (settings.syncPolicy !== "bidirectional") {
      throw new Error("全量解密迁移会读写两端，请先切回双向同步。");
    }
    if (!settings.accessToken) {
      throw new Error("未配置百度网盘授权，请先前往设置授权账号。");
    }

    this.addLog("info", "启动全量解密迁移流程：开始拉取并解密云端全部最新文件确保本地完整...");
    const pullResult = await this.startSync(false, false);
    if (!pullResult.success && pullResult.stats.errors > 0) {
      throw new Error(`云端预拉取未完全成功（存在 ${pullResult.stats.errors} 个错误），请在同步日志中检查并排除后再试，以防数据丢失。`);
    }

    this.setState("diffing", "正在扫描本地待迁移文件...");
    const localFiles = await this.scanLocalFiles();
    const total = localFiles.size;
    let processed = 0;
    let errors = 0;

    this.addLog("info", `开始以明文全量重新上传 ${total} 个文件覆盖网盘历史密文...`);

    const adapter = this.app.vault.adapter;
    const cleanBase = settings.remoteBasePath.endsWith("/")
      ? settings.remoteBasePath.slice(0, -1)
      : settings.remoteBasePath;

    this.setState("syncing", `正在以明文重新上传 (0/${total})...`);

    for (const [path] of localFiles) {
      await this.queue.add(async () => {
        try {
          if (!(await adapter.exists(path))) {
            return;
          }
          const buffer = await adapter.readBinary(path);
          const stat = await adapter.stat(path);
          const localMtime = stat?.mtime || Date.now();
          const remotePath = `${cleanBase}/${path}`;

          // Explicitly upload with enableE2EE: false -> Pure Plaintext!
          const res = await this.uploader.uploadFile(remotePath, buffer, {
            enableE2EE: false
          });

          this.manifest.set({
            path: path,
            remotePath: remotePath,
            mtime: localMtime,
          contentHash: md5(new Uint8Array(buffer)),
            remoteMtime: (res.mtime || Math.floor(Date.now() / 1000)) * 1000,
            md5: res.md5 || "",
            size: stat?.size || buffer.byteLength,
            remoteSize: res.size,
            fsId: res.fs_id
          });
          this.addLog("success", `明文重传成功: ${path}`);
        } catch (err: unknown) {
          errors++;
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog("error", `明文重传失败: ${path}`, msg);
        } finally {
          processed++;
          onProgress?.(processed, total, path);
          this.setState("syncing", `正在以明文重新上传 (${processed}/${total})...`);
        }
      });
    }

    await this.queue.waitAll();

    this.manifest.updateLastSyncTime();
    await this.manifest.save();

    settings.lastSyncTime = Date.now();
    await this.saveSettings(settings);

    this.setState("idle", "明文迁移重传完成");
    const summary = `明文迁移完成！共处理 ${processed}/${total} 个文件，失败: ${errors}`;
    this.addLog(errors > 0 ? "warn" : "success", summary);

    return { success: errors === 0, total, errors };
  }

  private async scanLocalFiles(): Promise<Map<string, LocalFileInfo>> {
    const adapter = this.app.vault.adapter;
    const result = new Map<string, LocalFileInfo>();
    const started = Date.now();
    let lastUpdate = started;
    const scanState: SyncState = this.state === 'syncing' ? 'syncing' : 'diffing';

    const scanDirectory = async (dir: string) => {
      const list = await adapter.list(dir);

      for (const file of list.files) {
        if (this.filter.shouldIgnore(file)) {
          continue;
        }
        const stat = await adapter.stat(file);
        if (Date.now() - lastUpdate >= 500) {
          this.setState(scanState, '正在扫描本地文件：已核对 ' + result.size + ' 个，' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒');
          lastUpdate = Date.now();
        }
        if (stat && stat.type === "file") {
          result.set(file, {
            path: file,
            contentHash: md5(new Uint8Array(await adapter.readBinary(file))),
            mtime: stat.mtime,
            size: stat.size
          });
        }
      }

      for (const folder of list.folders) {
        if (this.filter.shouldIgnore(folder)) {
          continue;
        }
        await scanDirectory(folder);
      }
    };

    // Scan regular vault contents
    await scanDirectory("");

    // Scan config directory if enabled
    const settings = this.getSettings();
    const configDir = this.app.vault.configDir;
    if (settings.syncObsidianConfig && configDir && (await adapter.exists(configDir))) {
      await scanDirectory(configDir);
    }

    this.addLog('info', '本地扫描完成：' + result.size + ' 个文件，耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒（完整指纹校验）');
    return result;
  }

  private async scanRemoteFiles(remoteBasePath: string, allowMissingRoot = false): Promise<Map<string, RemoteFileInfo>> {
    const result = new Map<string, RemoteFileInfo>();
    const cleanBase = remoteBasePath.endsWith("/") ? remoteBasePath.slice(0, -1) : remoteBasePath;

    const started = Date.now();
    let lastUpdate = 0;
    let lastProgress: import('../baidu/client').ListingProgress | undefined;
    const scanState: SyncState = this.state === 'syncing' ? 'syncing' : 'diffing';
    const options: import('../baidu/client').ListingOptions = {
      concurrency: this.getSettings().listingConcurrency ?? 2,
      shouldSkipDirectory: path => this.filter.shouldSkipDirectory(path),
      onProgress: progress => {
        lastProgress = progress;
        if (Date.now() - lastUpdate >= 500) {
          this.setState(scanState, '正在检索网盘：目录 ' + progress.directoriesScanned + '/' + progress.directoriesQueued +
            '，请求 ' + progress.requests + '，重试 ' + progress.retries + '，' + (progress.elapsedMs / 1000).toFixed(1) + ' 秒');
          lastUpdate = Date.now();
        }
      }
    };
    let items: Awaited<ReturnType<BaiduClient['listAll']>>;
    try {
      items = await this.client.listAll(cleanBase, allowMissingRoot, options);
    } catch (error) {
      this.addLog('error', '云端检索未完成，停止同步；耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒',
        lastProgress ? '已查目录 ' + lastProgress.directoriesScanned + '/' + lastProgress.directoriesQueued +
          '，请求 ' + lastProgress.requests + '，重试 ' + lastProgress.retries : '尚未取得完整列表');
      throw error;
    }
    this.addLog('info', '云端检索完成：耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒',
      lastProgress ? '目录 ' + lastProgress.directoriesScanned + '，跳过目录 ' + lastProgress.directoriesSkipped +
        '，请求 ' + lastProgress.requests + '，重试 ' + lastProgress.retries + '，检索并发 ' + lastProgress.concurrency : undefined);

    for (const item of items) {
      if (item.isdir === 1) {
        continue;
      }

      let relativePath = item.path;
      if (!relativePath.startsWith(cleanBase + "/")) throw new Error("云端返回同步目录外的路径，停止同步");
      if (relativePath.startsWith(cleanBase)) {
        relativePath = relativePath.slice(cleanBase.length);
      }
      if (relativePath.startsWith("/")) {
        relativePath = relativePath.slice(1);
      }
      if (relativePath.split("/").some(part => !part || part === "." || part === "..") || relativePath.includes("\\")) throw new Error("云端路径无效，停止同步");

      if (this.filter.shouldIgnore(relativePath)) {
        continue;
      }

      result.set(relativePath, {
        path: relativePath,
        remotePath: item.path,
        mtime: (item.server_mtime || 0) * 1000,
        size: item.size || 0,
        fsId: item.fs_id,
        md5: item.md5
      });
    }

    return result;
  }
}
