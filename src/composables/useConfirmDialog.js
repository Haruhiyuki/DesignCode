// 全局确认弹窗 — requestConfirmation() 发起，settleConfirmation() 关闭。
import { reactive } from "vue";
import { t } from "../i18n/index.js";

const confirmDialog = reactive({
  open: false,
  title: "",
  message: "",
  confirmLabel: t("confirm.confirmLabel"),
  cancelLabel: t("confirm.cancelLabel"),
  tone: "danger"
});

let resolveConfirmDialogPromise = null;

function requestConfirmation({
  title,
  message,
  confirmLabel = t("confirm.confirmLabel"),
  cancelLabel = t("confirm.cancelLabel"),
  tone = "danger"
}) {
  if (resolveConfirmDialogPromise) {
    resolveConfirmDialogPromise(false);
  }

  confirmDialog.open = true;
  confirmDialog.title = title || t("confirm.defaultTitle");
  confirmDialog.message = message || "";
  confirmDialog.confirmLabel = confirmLabel;
  confirmDialog.cancelLabel = cancelLabel;
  confirmDialog.tone = tone;

  return new Promise((resolve) => {
    resolveConfirmDialogPromise = resolve;
  });
}

function settleConfirmation(result) {
  const resolve = resolveConfirmDialogPromise;
  resolveConfirmDialogPromise = null;
  confirmDialog.open = false;
  confirmDialog.title = "";
  confirmDialog.message = "";
  confirmDialog.confirmLabel = t("confirm.confirmLabel");
  confirmDialog.cancelLabel = t("confirm.cancelLabel");
  confirmDialog.tone = "danger";
  resolve?.(result);
}

export function useConfirmDialog() {
  return {
    confirmDialog,
    requestConfirmation,
    settleConfirmation
  };
}
