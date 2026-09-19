import { ManifestItem } from "./manifest";
import { SyncPolicy, isSyncPolicy, isMirrorPolicy } from "./policy";

export type SyncActionType =
  | "UPLOAD"
  | "DOWNLOAD"
  | "DELETE_LOCAL"
  | "DELETE_REMOTE"
  | "CLEAN_MANIFEST"
  | "SKIP";

export interface LocalFileInfo {
  contentHash?: string;
  path: string;
  mtime: number;
  size: number;
}

export interface RemoteFileInfo {
  path: string; // Relative path
  remotePath: string; // Absolute path on Baidu Netdisk
  mtime: number;
  size: number;
  fsId: string | number;
  md5?: string;
}

export interface SyncPlanItem {
  path: string;
  remotePath: string;
  action: SyncActionType;
  reason: string;
  local?: LocalFileInfo;
  remote?: RemoteFileInfo;
  manifest?: ManifestItem;
}

function localChangedSince(local: LocalFileInfo, manifest: ManifestItem): boolean {
  if (local.contentHash && manifest.contentHash) return local.contentHash !== manifest.contentHash;
  return Math.abs(local.mtime - manifest.mtime) > 1000 || local.size !== manifest.size;
}
function remoteChangedSince(remote: RemoteFileInfo, manifest: ManifestItem): boolean {
  if (remote.md5 && manifest.md5) return remote.md5.toLowerCase() !== manifest.md5.toLowerCase();
  return Math.abs(remote.mtime - manifest.remoteMtime) > 1000 || remote.size !== (manifest.remoteSize ?? manifest.size);
}
export class SyncPlanner {
  static plan(
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>,
    manifestFiles: Record<string, ManifestItem>,
    remoteBasePath: string,
    policy: SyncPolicy = "bidirectional"
  ): SyncPlanItem[] {
    if (!isSyncPolicy(policy)) throw new Error("未知同步策略，请在设置中重新选择。");
    const plans: SyncPlanItem[] = [];
    const allPaths = new Set<string>([
      ...localFiles.keys(),
      ...remoteFiles.keys(),
      ...Object.keys(manifestFiles)
    ]);

    const normalizeRemoteBase = remoteBasePath.endsWith("/")
      ? remoteBasePath.slice(0, -1)
      : remoteBasePath;

    for (const path of allPaths) {
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);
      const manifest = manifestFiles[path];
      const remotePath = remote?.remotePath || `${normalizeRemoteBase}/${path}`;

      if (policy !== "bidirectional") {
        const send = policy === "send" || policy === "mirrorSend";
        const mirror = isMirrorPolicy(policy);
        const source = send ? local : remote;
        const target = send ? remote : local;
        const localChanged = !manifest || !local || localChangedSince(local, manifest);
        const remoteChanged = !manifest || !remote || remoteChangedSince(remote, manifest);
        const sourceChanged = send ? localChanged : remoteChanged;
        const targetChanged = send ? remoteChanged : localChanged;
        const item = { path, remotePath, local, remote, manifest };
        if (!source && !target) {
          if (manifest) plans.push({ ...item, action: "CLEAN_MANIFEST", reason: "两端均不存在，清理基线" });
        } else if (!source) {
          if (mirror) plans.push({ ...item, action: send ? "DELETE_REMOTE" : "DELETE_LOCAL", reason: "镜像：删除目标端独有文件" });
        } else if (!target) {
          // A missing target with history is an independent deletion. Preserve it in ordinary one-way mode.
          if (mirror || !manifest) plans.push({ ...item, action: send ? "UPLOAD" : "DOWNLOAD", reason: "来源端文件传送到目标端" });
          else plans.push({ ...item, action: "SKIP", reason: "保留目标端删除，未恢复文件" });
        } else if (mirror && (sourceChanged || targetChanged)) {
          plans.push({ ...item, action: send ? "UPLOAD" : "DOWNLOAD", reason: "镜像：以来源端版本覆盖目标端" });
        } else if (!mirror && targetChanged) {
          plans.push({ ...item, action: "SKIP", reason: manifest ? "保留目标端独立修改，未覆盖" : "无同步历史的同名文件，保留目标端，请核对后使用覆盖或还原模式" });
        } else if (sourceChanged) {
          plans.push({ ...item, action: send ? "UPLOAD" : "DOWNLOAD", reason: "来源端更新，目标端未独立修改" });
        }
        continue;
      }

      // Case 1: Both sides exist
      if (local && remote) {
        if (!manifest) {
          // No manifest, conflict resolution via LWW
          if (local.mtime >= remote.mtime) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "双端均存在且无同步历史，本地时间戳较新 (LWW 胜出)",
              local,
              remote
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "双端均存在且无同步历史，远端时间戳较新 (LWW 胜出)",
              local,
              remote
            });
          }
          continue;
        }

        // With manifest
        const localChanged =
          localChangedSince(local, manifest);
        const expectedRemoteSize =
          manifest.remoteSize !== undefined ? manifest.remoteSize : manifest.size;
        const remoteChanged =
          remoteChangedSince(remote, manifest);

        if (!localChanged && !remoteChanged) {
          // Both unchanged
          continue;
        } else if (localChanged && !remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "UPLOAD",
            reason: "本地文件有更新，推送到网盘",
            local,
            remote,
            manifest
          });
        } else if (!localChanged && remoteChanged) {
          plans.push({
            path,
            remotePath,
            action: "DOWNLOAD",
            reason: "网盘端文件有更新，拉取到本地",
            local,
            remote,
            manifest
          });
        } else {
          // Both changed: Conflict resolved by LWW
          if (local.mtime >= remote.mtime) {
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "双端并发修改产生冲突，本地时间戳较新 (LWW 覆盖远端)",
              local,
              remote,
              manifest
            });
          } else {
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "双端并发修改产生冲突，远端时间戳较新 (LWW 覆盖本地)",
              local,
              remote,
              manifest
            });
          }
        }
        continue;
      }

      // Case 2: Only local exists
      if (local && !remote) {
        if (!manifest) {
          plans.push({
            path,
            remotePath,
            action: "UPLOAD",
            reason: "本地新增文件，推送到网盘",
            local
          });
        } else {
          // Remote was deleted
          const localChanged =
            localChangedSince(local, manifest);
          if (localChanged) {
            // Local was modified after remote deletion, keep local
            plans.push({
              path,
              remotePath,
              action: "UPLOAD",
              reason: "远端已删除但本地有新修改，重新推送到网盘",
              local,
              manifest
            });
          } else {
            // Remote was deleted and local unchanged -> Delete local
            plans.push({
              path,
              remotePath,
              action: "DELETE_LOCAL",
              reason: "网盘端已删除，同步移入本地回收站",
              local,
              manifest
            });
          }
        }
        continue;
      }

      // Case 3: Only remote exists
      if (!local && remote) {
        if (!manifest) {
          plans.push({
            path,
            remotePath,
            action: "DOWNLOAD",
            reason: "网盘端新增文件，拉取到本地",
            remote
          });
        } else {
          // Local was deleted
          const expectedRemoteSize =
            manifest.remoteSize !== undefined ? manifest.remoteSize : manifest.size;
          const remoteChanged =
            remoteChangedSince(remote, manifest);
          if (remoteChanged) {
            // Remote was modified after local deletion, keep remote
            plans.push({
              path,
              remotePath,
              action: "DOWNLOAD",
              reason: "本地已删除但网盘端有新修改，重新拉取到本地",
              remote,
              manifest
            });
          } else {
            // Local was deleted and remote unchanged -> Delete remote
            plans.push({
              path,
              remotePath,
              action: "DELETE_REMOTE",
              reason: "本地已删除，同步移入网盘回收站",
              remote,
              manifest
            });
          }
        }
        continue;
      }

      // Case 4: Neither exists, but present in manifest
      if (!local && !remote && manifest) {
        plans.push({
          path,
          remotePath,
          action: "CLEAN_MANIFEST",
          reason: "两端均已不存在，清理元数据基线",
          manifest
        });
      }
    }

    return plans;
  }
}
