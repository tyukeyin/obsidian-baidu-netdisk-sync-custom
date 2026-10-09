import { App, Modal, Setting } from "obsidian";
import { SYNC_POLICIES, SyncPolicy, isSyncPolicy } from "../sync/policy";

export function choosePolicy(app: App, initial: SyncPolicy): Promise<SyncPolicy | null> {
  return new Promise(resolve => {
    class PolicyModal extends Modal {
      private selected = initial;
      private result: SyncPolicy | null = null;
      onOpen(): void {
        this.titleEl.setText("选择本次同步方式");
        this.contentEl.createEl("p", { text: "仅对本次手动同步生效，不改变自动同步方向。普通单向保留目标端独立修改；覆盖/还原可能删除目标端文件，下一步会展示清单。" });
        new Setting(this.contentEl).setName("本次同步方式").addDropdown(d => d
          .addOptions(SYNC_POLICIES).setValue(this.selected)
          .onChange(value => { if (isSyncPolicy(value)) this.selected = value; }));
        new Setting(this.contentEl)
          .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
          .addButton(b => b.setButtonText("继续").setCta().onClick(() => { this.result = this.selected; this.close(); }));
      }
      onClose(): void { this.contentEl.empty(); resolve(this.result); }
    }
    new PolicyModal(app).open();
  });
}
