import type { SyncPolicy } from "../sync/policy";

export interface BaiduSyncSettings {
  syncPolicy: SyncPolicy;
  lastManualPolicy?: SyncPolicy;
  appKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number; // Unix timestamp in ms
  remoteBasePath: string;  // e.g. "/apps/obsidian_vault"

  // Sync triggers
  syncOnStartup: boolean;
  syncIntervalMinutes: number; // 0 disables periodic sync
  syncOnSave: boolean;
  syncDebounceSeconds: number;

  // Sync Scope
  syncObsidianConfig: boolean;
  syncPlugins: boolean;
  syncPluginIds: string; // Comma- or newline-separated plugin IDs allowed while syncPlugins is off
  syncThemes: boolean;
  ignoredPatterns: string; // Newline separated patterns

  // Concurrency and Network
  concurrency: number; // 1 to 5, default 3
  listingConcurrency: number; // directory listing only, 1 to 3, default 2

  // E2EE
  enableE2EE: boolean;
  e2eePassword: string;

  // Status
  lastSyncTime: number;
}

export const DEFAULT_SETTINGS: BaiduSyncSettings = {
  syncPolicy: "bidirectional",
  appKey: "",
  appSecret: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  remoteBasePath: "/apps/obsidian_vault",

  syncOnStartup: true,
  syncIntervalMinutes: 10,
  syncOnSave: false,
  syncDebounceSeconds: 5,

  syncObsidianConfig: true,
  syncPlugins: true,
  syncPluginIds: "baidu-pan-video-keys",
  syncThemes: true,
  ignoredPatterns: [
    "**/.git/**",
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/workspace*.json",
    "**/cache/**",
    "**/indexeddb/**"
  ].join("\n"),

  concurrency: 3,
  listingConcurrency: 2,

  enableE2EE: false,
  e2eePassword: "",

  lastSyncTime: 0
};
