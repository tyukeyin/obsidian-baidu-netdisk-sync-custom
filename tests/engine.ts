import assert from "assert";
import type { App } from "obsidian";
import type { BaiduClient } from "../src/baidu/client";
import type { ManifestManager } from "../src/sync/manifest";
import { SyncEngine } from "../src/sync/engine";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import type { SyncPolicy } from "../src/sync/policy";

async function run() {
  const local = { path: "note.md", mtime: 10000, size: 10 };
  const remote = { ...local, remotePath: "/vault/note.md", mtime: 20000, fsId: 1 };
  const baseline = { ...local, remotePath: remote.remotePath, remoteMtime: remote.mtime, md5: "" };
  async function scenario(policy: SyncPolicy, options: { selection?: SyncPolicy | null; silent?: boolean; accept?: boolean; changeDuringPreview?: boolean; missingLocal?: boolean; localChanged?: boolean; modeChange?: boolean } = {}) {
    let settings = { ...DEFAULT_SETTINGS, syncPolicy: policy, accessToken: "offline-test", remoteBasePath: "/vault" };
    const effects: string[] = [];
    let approvals = 0;
    let scans = 0;
    let selections = 0;
    let localBytes = new ArrayBuffer(10);
    const app = { vault: { configDir: ".obsidian", adapter: {
      exists: async () => !options.missingLocal, readBinary: async () => localBytes,
      stat: async () => local,
      writeBinary: async (_: string, data: ArrayBuffer) => { localBytes = data; effects.push("download"); },
      trashLocal: async () => { effects.push("deleteLocal"); }
    }, getAbstractFileByPath: () => null } } as unknown as App;
    const manifest = { load: async () => {}, getAll: () => ({ "note.md": baseline }),
      set: () => {}, delete: () => {}, updateLastSyncTime: () => {}, save: async () => {} } as unknown as ManifestManager;
    const client = { deleteFiles: async () => { effects.push("deleteRemote"); } } as unknown as BaiduClient;
    const engine = new SyncEngine(app, () => settings, async s => { settings = s; }, client, manifest, async () => {
      approvals++;
      if (options.modeChange) settings.syncPolicy = "receive";
      return options.accept ?? false;
    }, options.selection !== undefined ? async () => { selections++; return options.selection ?? null; } : undefined);
    Reflect.set(engine, "scanLocalFiles", async () => {
      scans++;
      return new Map(options.missingLocal ? [] : [["note.md", { ...local, size: options.changeDuringPreview && scans > 1 ? 99 : options.localChanged ? 20 : 10 }]]);
    });
    Reflect.set(engine, "scanRemoteFiles", async () => new Map([["note.md", { ...remote, size: 30 }]]));
    Reflect.set(engine, "uploader", { uploadFile: async () => { effects.push("upload"); return { mtime: 20, size: 10 }; } });
    Reflect.set(engine, "downloader", { downloadByFsId: async () => new ArrayBuffer(30) });
    const result = await engine.startSync(options.silent);
    assert.equal(engine.isSyncing(), false);
    return { effects, approvals, result, engine, selections, scans, settings };
  }
  assert.deepEqual((await scenario("send")).effects, []);
  const chosen = await scenario("send", { selection: "receive" });
  assert.deepEqual(chosen.effects, ["download"]);
  assert.equal(chosen.settings.syncPolicy, "send");
  assert.equal(chosen.settings.lastManualPolicy, "receive");
  const cancelled = await scenario("send", { selection: null });
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.scans, 0);
  assert.deepEqual(cancelled.effects, []);
  assert.equal((await scenario("send", { selection: "receive", silent: true })).selections, 0);
  assert.deepEqual((await scenario("receive")).effects, ["download"]);
  assert.deepEqual((await scenario("mirrorReceive", { accept: true })).effects, ["download"]);
  assert.deepEqual((await scenario("receive", { localChanged: true })).effects, []);
  assert.deepEqual((await scenario("mirrorSend", { silent: true })).effects, []);
  assert.equal((await scenario("mirrorSend", { silent: true })).approvals, 0);
  assert.deepEqual((await scenario("mirrorSend")).effects, []);
  assert.deepEqual((await scenario("mirrorSend", { accept: true })).effects, ["upload"]);
  assert.deepEqual((await scenario("mirrorSend", { accept: true, missingLocal: true })).effects, ["deleteRemote"]);
  assert.deepEqual((await scenario("mirrorSend", { accept: true, changeDuringPreview: true })).effects, []);
  assert.deepEqual((await scenario("mirrorSend", { accept: true, modeChange: true })).effects, []);
  await assert.rejects((await scenario("receive")).engine.convertVaultToPlaintext(), /双向同步/);
  console.log("Offline engine tests passed: direction, mirror approval, automatic triggers, changed preview and migration guard");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
