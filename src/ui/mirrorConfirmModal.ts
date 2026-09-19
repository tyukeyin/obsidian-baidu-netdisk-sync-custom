import { App, Modal, Setting } from "obsidian";
import type { SyncPlanItem } from "../sync/planner";

export function confirmMirror(app: App, plans: SyncPlanItem[]): Promise<boolean> {
  return new Promise((resolve) => {
    class MirrorModal extends Modal {
      private accepted = false;
      onOpen(): void {
        this.titleEl.setText("确认覆盖／还原操作");
        const transfers = plans.filter(p => p.action === "UPLOAD" || p.action === "DOWNLOAD").length;
        const deletions = plans.filter(p => p.action === "DELETE_LOCAL" || p.action === "DELETE_REMOTE").length;
        this.contentEl.createEl("p", { text: `将传输或覆盖 ${transfers} 个文件，删除 ${deletions} 个目标端文件。目标端独立修改会被替换。请核对以下完整清单。` });
        const list = this.contentEl.createEl("pre", { cls: "baidu-sync-plan-preview" });
        const labels: Record<string, string> = { UPLOAD: "上传/覆盖云端", DOWNLOAD: "下载/覆盖本地", DELETE_LOCAL: "删除本地", DELETE_REMOTE: "删除云端", CLEAN_MANIFEST: "清理历史", SKIP: "跳过" };
        list.setText(plans.map(p => `${labels[p.action]}：${p.path}`).join("\n"));
        new Setting(this.contentEl)
          .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
          .addButton(b => b.setButtonText("确认执行").setWarning().onClick(() => { this.accepted = true; this.close(); }));
      }
      onClose(): void { this.contentEl.empty(); resolve(this.accepted); }
    }
    new MirrorModal(app).open();
  });
}
