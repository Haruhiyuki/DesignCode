// 素材资源库 — 导入、预览、拖放、元数据编辑、删除。
import {
  listArtAssets,
  importArtAsset as requestImportArtAsset,
  importArtAssetsFromPaths as requestImportArtAssetsFromPaths,
  deleteArtAsset as requestDeleteArtAsset,
  readArtAssetPreview as requestReadArtAssetPreview,
  updateArtAsset as requestUpdateArtAsset,
} from "../lib/desktop-api.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useConfirmDialog } from "./useConfirmDialog.js";

// ---------------------------------------------------------------------------
// 模块级单例 — 从其他 composable 获取依赖
// ---------------------------------------------------------------------------

const {
  state, ui,
  assetInputRef, assetDrawerRef,
  setStatus,
} = useWorkspaceState();

const {
  artAssetLibrary,
  scheduleCurrentDesignConfigSave,
} = useSetupConfig();

const { requestConfirmation } = useConfirmDialog();

// ---------------------------------------------------------------------------
// 资源库操作
// ---------------------------------------------------------------------------

async function refreshArtAssetLibrary() {
  const items = await listArtAssets();
  state.assets.items = items;
  state.assets.nameDrafts = Object.fromEntries(
    items.map((item) => [item.id, state.assets.nameDrafts[item.id] ?? item.name ?? ""])
  );
  state.assets.noteDrafts = Object.fromEntries(
    items.map((item) => [item.id, state.assets.noteDrafts[item.id] ?? item.note ?? ""])
  );
  const availableIds = new Set(items.map((item) => item.id));
  state.assets.selectedIds = state.assets.selectedIds.filter((item) => availableIds.has(item));
  state.assets.previewUrls = Object.fromEntries(
    Object.entries(state.assets.previewUrls).filter(([assetId]) => availableIds.has(assetId))
  );
  state.assets.deletingIds = state.assets.deletingIds.filter((assetId) => availableIds.has(assetId));
  void syncArtAssetPreviews(items);
  return items;
}

async function loadArtAssetPreview(asset) {
  if (!asset?.id || state.assets.previewUrls[asset.id] || !String(asset.mimeType || "").startsWith("image/")) {
    return;
  }

  try {
    const preview = await requestReadArtAssetPreview({ assetId: asset.id });
    if (preview?.dataUrl) {
      state.assets.previewUrls[asset.id] = preview.dataUrl;
    }
  } catch {}
}

async function syncArtAssetPreviews(items = artAssetLibrary.value) {
  await Promise.all(items.map((asset) => loadArtAssetPreview(asset)));
}

// ---------------------------------------------------------------------------
// 导入操作
// ---------------------------------------------------------------------------

function triggerAssetImport() {
  assetInputRef.value?.click();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const [, payload = ""] = result.split(",");
      resolve(payload);
    };
    reader.onerror = () => reject(reader.error || new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function importAssetFiles(files) {
  if (!files.length) {
    return;
  }

  state.assets.importing = true;
  try {
    for (const file of files) {
      const contentBase64 = await fileToBase64(file);
      await requestImportArtAsset({
        name: file.name,
        displayName: file.name.replace(/\.[^.]+$/, ""),
        mimeType: file.type || "application/octet-stream",
        contentBase64,
        note: ""
      });
    }
    await refreshArtAssetLibrary();
    setStatus(t("status.importedAssets", { count: files.length }), "success");
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.assetImportFailed"), "error", "save");
  } finally {
    state.assets.importing = false;
    resetAssetDropState();
  }
}

async function importAssetPaths(paths) {
  if (!paths.length) {
    return;
  }

  state.assets.importing = true;
  try {
    await requestImportArtAssetsFromPaths({ paths });
    await refreshArtAssetLibrary();
    setStatus(t("status.importedAssets", { count: paths.length }), "success");
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.assetImportFailed"), "error", "save");
  } finally {
    state.assets.importing = false;
    resetAssetDropState();
  }
}

async function handleAssetImport(event) {
  const input = event.target;
  const files = Array.from(input?.files || []);
  try {
    await importAssetFiles(files);
  } finally {
    if (input) {
      input.value = "";
    }
  }
}

// ---------------------------------------------------------------------------
// 拖拽操作（浏览器原生）
// ---------------------------------------------------------------------------

function dataTransferHasFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("Files");
}

function resetAssetDropState() {
  state.assets.dragDepth = 0;
  state.assets.dropActive = false;
}

function handleAssetDragEnter(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  state.assets.dragDepth += 1;
  state.assets.dropActive = true;
}

function handleAssetDragOver(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  state.assets.dropActive = true;
}

function handleAssetDragLeave(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  const currentTarget = event.currentTarget;
  const relatedTarget = event.relatedTarget;
  if (currentTarget instanceof HTMLElement && relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) {
    return;
  }

  state.assets.dragDepth = Math.max(0, state.assets.dragDepth - 1);
  if (state.assets.dragDepth === 0) {
    state.assets.dropActive = false;
  }
}

async function handleAssetDrop(event) {
  if (!dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  const files = Array.from(event.dataTransfer?.files || []);
  await importAssetFiles(files);
}

// ---------------------------------------------------------------------------
// 窗口级文件拖放
// ---------------------------------------------------------------------------

function isAssetDrawerActiveDrop(event) {
  if (ui.activeDrawer !== "assets" || !dataTransferHasFiles(event.dataTransfer)) {
    return false;
  }

  const drawer = assetDrawerRef.value;
  if (!drawer) {
    return false;
  }

  if (!(event.target instanceof Node)) {
    return true;
  }

  return drawer.contains(event.target);
}

function handleWindowFileDropGuard(event) {
  if (!isAssetDrawerActiveDrop(event)) {
    return;
  }

  event.preventDefault();
}

function handleWindowAssetDragEnter(event) {
  if (!isAssetDrawerActiveDrop(event)) {
    return;
  }

  event.preventDefault();
  state.assets.dragDepth += 1;
  state.assets.dropActive = true;
}

function handleWindowAssetDragLeave(event) {
  if (ui.activeDrawer !== "assets" || !dataTransferHasFiles(event.dataTransfer)) {
    return;
  }

  if (event.target === document.documentElement || event.target === document.body) {
    state.assets.dragDepth = Math.max(0, state.assets.dragDepth - 1);
  } else {
    state.assets.dragDepth = Math.max(0, state.assets.dragDepth - 1);
  }

  if (
    event.clientX <= 0
    || event.clientY <= 0
    || event.clientX >= window.innerWidth
    || event.clientY >= window.innerHeight
    || state.assets.dragDepth === 0
  ) {
    resetAssetDropState();
  }
}

async function handleWindowAssetDrop(event) {
  if (!isAssetDrawerActiveDrop(event)) {
    return;
  }

  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  await importAssetFiles(files);
}

// ---------------------------------------------------------------------------
// 桌面拖拽（Tauri 特有）
// ---------------------------------------------------------------------------

function normalizeDesktopDropPaths(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((item) => typeof item === "string" && item.trim());
  }

  if (Array.isArray(payload?.paths)) {
    return payload.paths.filter((item) => typeof item === "string" && item.trim());
  }

  if (typeof payload?.path === "string" && payload.path.trim()) {
    return [payload.path.trim()];
  }

  return [];
}

function shouldAcceptDesktopAssetDrop() {
  return ui.activeDrawer === "assets";
}

function handleDesktopAssetDragEnter(payload) {
  const paths = normalizeDesktopDropPaths(payload);
  if (!shouldAcceptDesktopAssetDrop() || !paths.length) {
    return;
  }

  state.assets.dragDepth += 1;
  state.assets.dropActive = true;
}

function handleDesktopAssetDragOver(payload) {
  const paths = normalizeDesktopDropPaths(payload);
  if (!shouldAcceptDesktopAssetDrop() || !paths.length) {
    return;
  }

  state.assets.dropActive = true;
}

function handleDesktopAssetDragLeave() {
  if (!shouldAcceptDesktopAssetDrop()) {
    return;
  }

  resetAssetDropState();
}

async function handleDesktopAssetDrop(payload) {
  const paths = normalizeDesktopDropPaths(payload);
  if (!shouldAcceptDesktopAssetDrop() || !paths.length) {
    return;
  }

  await importAssetPaths(paths);
}

// ---------------------------------------------------------------------------
// 选择管理
// ---------------------------------------------------------------------------

function setArtAssetSelection(assetId, enabled) {
  const next = new Set(state.assets.selectedIds);
  if (enabled) {
    next.add(assetId);
  } else {
    next.delete(assetId);
  }
  state.assets.selectedIds = [...next];
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

async function saveArtAssetMetadata(assetId) {
  const asset = artAssetLibrary.value.find((item) => item.id === assetId);
  if (!asset) {
    return false;
  }

  const name = String(state.assets.nameDrafts[assetId] || "").trim();
  const note = String(state.assets.noteDrafts[assetId] || "").trim();
  const nextName = name || asset.name;

  if ((asset.name || "") === nextName && (asset.note || "") === note) {
    return false;
  }

  try {
    await requestUpdateArtAsset({
      assetId,
      name: nextName,
      note
    });
    await refreshArtAssetLibrary();
    setStatus(t("status.assetInfoSaved"), "success", "save");
    return true;
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.assetInfoSaveFailed"), "error", "save");
    throw error;
  }
}

async function persistPendingAssetNotes() {
  for (const asset of artAssetLibrary.value) {
    const name = String(state.assets.nameDrafts[asset.id] || "").trim();
    const draft = String(state.assets.noteDrafts[asset.id] || "").trim();
    const nextName = name || asset.name;
    if ((asset.name || "") !== nextName || (asset.note || "") !== draft) {
      await requestUpdateArtAsset({
        assetId: asset.id,
        name: nextName,
        note: draft
      });
    }
  }
  await refreshArtAssetLibrary();
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

async function deleteArtAssetFromLibrary(assetId) {
  const asset = artAssetLibrary.value.find((item) => item.id === assetId);
  if (!asset) {
    return;
  }

  const confirmed = await requestConfirmation({
    title: t("confirm.deleteAssetTitle"),
    message: t("confirm.deleteAssetMessage", { name: asset.name }),
    confirmLabel: t("confirm.deleteAssetConfirm")
  });
  if (!confirmed) {
    return;
  }

  state.assets.deletingIds = [...new Set([...state.assets.deletingIds, assetId])];
  try {
    await requestDeleteArtAsset({ assetId });
    state.assets.selectedIds = state.assets.selectedIds.filter((item) => item !== assetId);
    delete state.assets.nameDrafts[assetId];
    delete state.assets.noteDrafts[assetId];
    delete state.assets.previewUrls[assetId];
    await refreshArtAssetLibrary();
    scheduleCurrentDesignConfigSave();
    setStatus(t("status.assetDeleted"), "success", "save");
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.assetDeleteFailed"), "error", "save");
  } finally {
    state.assets.deletingIds = state.assets.deletingIds.filter((item) => item !== assetId);
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function useArtAssets() {
  return {
    // 资源库操作
    refreshArtAssetLibrary,
    loadArtAssetPreview,
    syncArtAssetPreviews,

    // 导入操作
    triggerAssetImport,
    fileToBase64,
    importAssetFiles,
    importAssetPaths,
    handleAssetImport,

    // 拖拽操作（浏览器原生）
    dataTransferHasFiles,
    resetAssetDropState,
    handleAssetDragEnter,
    handleAssetDragOver,
    handleAssetDragLeave,
    handleAssetDrop,

    // 窗口级文件拖放
    handleWindowFileDropGuard,
    handleWindowAssetDragEnter,
    handleWindowAssetDragLeave,
    handleWindowAssetDrop,

    // 桌面拖拽（Tauri 特有）
    normalizeDesktopDropPaths,
    handleDesktopAssetDragEnter,
    handleDesktopAssetDragOver,
    handleDesktopAssetDragLeave,
    handleDesktopAssetDrop,

    // 选择管理
    setArtAssetSelection,

    // 元数据
    saveArtAssetMetadata,
    persistPendingAssetNotes,

    // 删除
    deleteArtAssetFromLibrary,
  };
}
