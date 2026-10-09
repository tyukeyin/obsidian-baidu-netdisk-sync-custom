import { BaiduSyncSettings } from "../settings/settings";

function globToRegex(glob: string): RegExp {
  const clean = glob.trim();
  let regexStr = "^";
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "*" && clean[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (clean[i] === "/") {
        i++;
      }
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (".+^$()|{}[]\\".includes(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

export class SyncFilter {
  private compiledPatterns: RegExp[] = [];
  private subtreePatterns: RegExp[] = [];

  constructor(private settings: BaiduSyncSettings, private configDir: string = "") {
    this.recompilePatterns();
  }

  updateSettings(settings: BaiduSyncSettings): void {
    this.settings = settings;
    this.recompilePatterns();
  }

  private recompilePatterns(): void {
    this.compiledPatterns = [];
    this.subtreePatterns = [];
    const lines = this.settings.ignoredPatterns.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        try {
          const pattern = globToRegex(trimmed);
          this.compiledPatterns.push(pattern);
          if (trimmed.endsWith("/**")) this.subtreePatterns.push(pattern);
        } catch {
          // ignore invalid patterns
        }
      }
    }
  }

  // Only prune a subtree when all its descendants are out of scope.
  // File-only patterns must not hide allowed files such as PDF attachments.
  shouldSkipDirectory(relativePath: string): boolean {
    const path = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = path.split('/');
    if (path.includes('baidu-netdisk-sync') || path.includes('obsidian-baidu-netdisk-sync') ||
        parts.includes('.git') || parts[0] === '.trash') return true;
    const config = this.configDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (config && (path === config || path.startsWith(config + '/'))) {
      if (!this.settings.syncObsidianConfig) return true;
      if ((path + '/').includes('/cache/') || (path + '/').includes('/indexeddb/')) return true;
      const selected = (this.settings.syncPluginIds || '').split(/[,\n]/).map(id => id.trim())
        .filter(id => /^[a-z0-9][a-z0-9-]*$/.test(id));
      if (!this.settings.syncPlugins) {
        if (path === config + '/plugins' && selected.length === 0) return true;
        if (path.startsWith(config + '/plugins/')) {
          const id = path.slice((config + '/plugins/').length).split('/')[0];
          if (!selected.includes(id)) return true;
        }
      }
      if (!this.settings.syncThemes && (path === config + '/themes' || path.startsWith(config + '/themes/'))) return true;
    }
    return this.subtreePatterns.some(pattern => pattern.test(path + '/'));
  }

  shouldIgnore(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");

    // Always ignore plugin's own manifest and storage
    if (
      normalized.includes("baidu-netdisk-sync") ||
      normalized.includes("obsidian-baidu-netdisk-sync") ||
      normalized.endsWith("sync_manifest.json")
    ) {
      return true;
    }

    // Always ignore Obsidian trash folder
    if (normalized.startsWith(".trash/") || normalized === ".trash") {
      return true;
    }

    // Git metadata
    if (normalized.startsWith(".git/") || normalized.includes("/.git/")) {
      return true;
    }

    // Handle config folder configuration rules
    const configPrefix = this.configDir ? `${this.configDir}/` : "";
    if (configPrefix && normalized.startsWith(configPrefix)) {
      if (!this.settings.syncObsidianConfig) {
        return true;
      }

      // Hard-ignore device specific workspaces and cache
      if (
        normalized.includes("/workspace.json") ||
        normalized.includes("/workspace-mobile.json") ||
        normalized.endsWith("/workspace.json") ||
        normalized.endsWith("/workspace-mobile.json") ||
        normalized.includes("/cache/") ||
        normalized.includes("/indexeddb/")
      ) {
        return true;
      }

      // Sync selected plugin folders without enabling all community plugins.
      if (!this.settings.syncPlugins && normalized.includes("/plugins/")) {
        const pluginPath = normalized.split("/plugins/", 2)[1];
        const pluginId = pluginPath?.split("/", 1)[0];
        const selected = (this.settings.syncPluginIds || "")
          .split(/[,\n]/)
          .map((id) => id.trim())
          .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id));
        if (!pluginId || !selected.includes(pluginId)) return true;
      }

      // Themes rule
      if (!this.settings.syncThemes && normalized.includes("/themes/")) {
        return true;
      }
    }

    // Check custom patterns
    for (const pattern of this.compiledPatterns) {
      if (pattern.test(normalized)) {
        return true;
      }
    }

    return false;
  }
}
