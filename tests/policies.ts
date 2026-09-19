import assert from "assert";
import { SyncPlanner, LocalFileInfo, RemoteFileInfo } from "../src/sync/planner";
import { SYNC_POLICIES, SyncPolicy, allowsAction } from "../src/sync/policy";
import { ManifestItem } from "../src/sync/manifest";

export function testPolicies(): void {
  const local: LocalFileInfo = { path: "note.md", mtime: 10000, size: 10 };
  const remote: RemoteFileInfo = { ...local, remotePath: "/vault/note.md", fsId: 1, mtime: 20000 };
  const baseline: ManifestItem = { ...local, remotePath: remote.remotePath, remoteMtime: remote.mtime, remoteSize: 10, md5: "" };
  const plan = (policy: SyncPolicy, l?: LocalFileInfo, r?: RemoteFileInfo, history = true) =>
    SyncPlanner.plan(new Map(l ? [[l.path, l]] : []), new Map(r ? [[r.path, r]] : []), history ? { "note.md": baseline } : {}, "/vault", policy);
  const action = (policy: SyncPolicy, l?: LocalFileInfo, r?: RemoteFileInfo, history = true) => plan(policy, l, r, history)[0]?.action;
  for (const policy of Object.keys(SYNC_POLICIES) as SyncPolicy[]) {
    for (const l of [undefined, local, { ...local, size: 20 }, { ...local, mtime: 40000 }]) {
      for (const r of [undefined, remote, { ...remote, size: 20 }, { ...remote, mtime: 40000 }]) {
        for (const history of [false, true]) {
          for (const item of plan(policy, l, r, history)) assert.ok(allowsAction(policy, item.action), `${policy}: forbidden ${item.action}`);
        }
      }
    }
    assert.equal(action(policy, local, remote), undefined, "settled history must not transfer again");
  }
  assert.equal(action("send", { ...local, size: 20 }, remote), "UPLOAD");
  assert.equal(action("receive", local, { ...remote, size: 20 }), "DOWNLOAD");
  assert.equal(action("send", local, { ...remote, size: 20 }), "SKIP");
  assert.equal(action("receive", { ...local, size: 20 }, remote), "SKIP");
  assert.equal(action("send", local, remote, false), "SKIP");
  assert.equal(action("receive", local, remote, false), "SKIP");
  assert.equal(action("send", local, undefined, false), "UPLOAD");
  assert.equal(action("receive", undefined, remote, false), "DOWNLOAD");
  assert.equal(action("send", local, undefined), "SKIP");
  assert.equal(action("receive", undefined, remote), "SKIP");
  assert.equal(action("mirrorSend", local, { ...remote, mtime: 90000 }), "UPLOAD");
  assert.equal(action("mirrorReceive", { ...local, mtime: 90000 }, remote), "DOWNLOAD");
  assert.equal(action("mirrorSend", undefined, remote, false), "DELETE_REMOTE");
  assert.equal(action("mirrorReceive", local, undefined, false), "DELETE_LOCAL");
  assert.equal(action("mirrorSend", local, undefined), "UPLOAD");
  assert.equal(action("mirrorReceive", undefined, remote), "DOWNLOAD");
  // Remote encryption overhead is not mistaken for an independent change.
  const encryptedRemote = { ...remote, size: 80 };
  const encryptedHistory = { ...baseline, remoteSize: 80 };
  assert.equal(SyncPlanner.plan(new Map([[local.path, local]]), new Map([[remote.path, encryptedRemote]]), { "note.md": encryptedHistory }, "/vault", "send").length, 0);
  assert.throws(() => SyncPlanner.plan(new Map(), new Map(), {}, "/vault", "invalid" as SyncPolicy));
  console.log("   Five-policy matrix: 160 scenarios and targeted conflict/deletion cases passed");
}
