<script setup>
// 导出完成提示 — 右下角小弹窗，6s 自动消失；点「打开文件夹」调用 Tauri 打开系统下载目录。
// 由 ui.exportToast 的 visible/fileName/format 驱动，没有自身状态。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { revealDownloadFolder } from "../../lib/desktop-api.js";

const { ui } = useWorkspaceState();

function dismiss() {
  ui.exportToast.visible = false;
}

async function openFolder() {
  try {
    await revealDownloadFolder(ui.exportToast.fileName || null);
  } catch {
    // 打开失败时静默：提示窗本身不需要抛错，文件已经在用户下载目录里了。
  }
  dismiss();
}
</script>

<template>
  <Transition name="export-toast">
    <div v-if="ui.exportToast.visible" class="export-toast" role="status" aria-live="polite">
      <div class="export-toast-icon" aria-hidden="true">✓</div>
      <div class="export-toast-copy">
        <strong>{{ t("export.toast.title", { format: ui.exportToast.format || "" }) }}</strong>
        <span class="export-toast-filename">{{ ui.exportToast.fileName }}</span>
      </div>
      <div class="export-toast-actions">
        <button type="button" class="export-toast-action" @click="openFolder">
          {{ t("export.toast.openFolder") }}
        </button>
        <button
          type="button"
          class="export-toast-close"
          :aria-label="t('export.toast.dismiss')"
          @click="dismiss"
        >
          ×
        </button>
      </div>
    </div>
  </Transition>
</template>
