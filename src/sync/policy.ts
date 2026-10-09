export const SYNC_POLICIES = {
  bidirectional: "双向同步",
  send: "仅发送",
  mirrorSend: "仅发送：覆盖云端变更",
  receive: "仅接收",
  mirrorReceive: "仅接收：还原本地变更"
} as const;

export type SyncPolicy = keyof typeof SYNC_POLICIES;

export function isSyncPolicy(value: unknown): value is SyncPolicy {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SYNC_POLICIES, value);
}

export function isMirrorPolicy(policy: SyncPolicy): boolean {
  return policy === "mirrorSend" || policy === "mirrorReceive";
}

export function allowsAction(policy: SyncPolicy, action: string): boolean {
  if (!isSyncPolicy(policy)) return false;
  if (action === "SKIP" || action === "CLEAN_MANIFEST") return true;
  if (policy === "bidirectional") return true;
  if (policy === "send") return action === "UPLOAD";
  if (policy === "receive") return action === "DOWNLOAD";
  if (policy === "mirrorSend") return action === "UPLOAD" || action === "DELETE_REMOTE";
  return action === "DOWNLOAD" || action === "DELETE_LOCAL";
}
