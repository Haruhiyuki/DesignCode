// 画布视口 — 缩放/平移、抽屉布局、全屏编辑器、快捷键、iframe 交互。
import { nextTick, ref } from "vue";
import {
  applyEditableTextValue,
  clamp,
  cloneSnapshot,
  normalizeMeta,
  patchEditableTextInHtml,
} from "../lib/studio-utils.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useConfirmDialog } from "./useConfirmDialog.js";
import { useDesignSession } from "./useDesignSession.js";

// ---------------------------------------------------------------------------
// 模块级单例 — 从其他 composable 获取依赖
// ---------------------------------------------------------------------------

const {
  state, ui, viewport, fullscreenEditor, interaction,
  activeDropdown,
  workspaceRef, frameShell, frameViewport, designFrame,
  fullscreenFrameShell, fullscreenFrameViewport, fullscreenDesignFrame,
  fullscreenEditorInputRef, fullscreenEditableHotspots, fullscreenHotspotLayerStyle,
  exportMenuRef, frameRevision,
  compactText, setStatus,
} = useWorkspaceState();

const {
  A4_VIEWPORT_RATIO,
  hasDesign, renderedCanvas, canExport,
  fullscreenEditableEntries, fullscreenSelectedEntry,
  fullscreenHasUnsavedChanges,
} = useSetupConfig();

const { confirmDialog, requestConfirmation, settleConfirmation } = useConfirmDialog();

const {
  buildEditableHtmlPayload, saveEditableHtmlPayload,
} = useDesignSession();

// ---------------------------------------------------------------------------
// 延迟注入依赖 — 来自 App.vue 中尚未拆分的函数
// ---------------------------------------------------------------------------

let _closeStylePreview = null;
let _runAgentPrompt = null;
let _submitConversation = null;
const frameLoadedRevision = ref(0);
let frameReadyResolvers = [];

function resolveFrameReadyWaiters() {
  const resolvers = frameReadyResolvers;
  frameReadyResolvers = [];
  resolvers.forEach((fn) => fn());
}

function waitForFrameReady() {
  return new Promise((resolve) => {
    frameReadyResolvers.push(resolve);
  });
}

function setDeps(deps) {
  if (deps.closeStylePreview) _closeStylePreview = deps.closeStylePreview;
  if (deps.runAgentPrompt) _runAgentPrompt = deps.runAgentPrompt;
  if (deps.submitConversation) _submitConversation = deps.submitConversation;
}

// ---------------------------------------------------------------------------
// 私有变量
// ---------------------------------------------------------------------------

let removeFullscreenFrameListeners = null;
let removeCanvasPanListeners = null;
let fullscreenHotspotAnimationFrame = 0;

// ---------------------------------------------------------------------------
// 全屏编辑器 — 状态管理
// ---------------------------------------------------------------------------

function resetFullscreenEditorState() {
  fullscreenEditor.draftHtml = "";
  fullscreenEditor.baselineHtml = "";
  fullscreenEditor.draftFields = {};
  fullscreenEditor.baselineFields = {};
  fullscreenEditor.draftMeta = null;
  fullscreenEditor.baselineMeta = null;
  fullscreenEditor.selectedEntryId = "";
  fullscreenEditor.lastEntryLabel = "";
  fullscreenEditor.saveBusy = false;
  fullscreenEditableHotspots.value = [];
  fullscreenHotspotLayerStyle.value = {};
}

function initializeFullscreenEditorState() {
  fullscreenEditor.draftHtml = state.currentHtml || "";
  fullscreenEditor.baselineHtml = state.currentHtml || "";
  fullscreenEditor.draftFields = cloneSnapshot(state.fields);
  fullscreenEditor.baselineFields = cloneSnapshot(state.fields);
  fullscreenEditor.draftMeta = normalizeMeta(state.currentMeta);
  fullscreenEditor.baselineMeta = normalizeMeta(state.currentMeta);
  fullscreenEditor.selectedEntryId = "";
  fullscreenEditor.lastEntryLabel = "";
  fullscreenEditor.saveBusy = false;
}

// ---------------------------------------------------------------------------
// 全屏编辑器 — 辅助函数
// ---------------------------------------------------------------------------

function fullscreenEntryDraft(entry = fullscreenSelectedEntry.value) {
  return entry?.value || "";
}

function updateFullscreenIframeText(entry, value) {
  const doc = fullscreenDesignFrame.value?.contentDocument;
  if (!doc || !entry?.path) {
    return;
  }

  const target = doc.querySelector(entry.path);
  if (!target) {
    return;
  }

  applyEditableTextValue(target, value);
  scheduleFullscreenEditableHotspotsRefresh();
}

// ---------------------------------------------------------------------------
// 画布引用
// ---------------------------------------------------------------------------

function activeCanvasRefs() {
  if (ui.canvasFullscreen) {
    return {
      shell: fullscreenFrameShell.value,
      viewport: fullscreenFrameViewport.value,
      frame: fullscreenDesignFrame.value
    };
  }

  return {
    shell: frameShell.value,
    viewport: frameViewport.value,
    frame: designFrame.value
  };
}

// ---------------------------------------------------------------------------
// 画布适配与缩放
// ---------------------------------------------------------------------------

function fitCanvas() {
  const { shell, viewport: viewportEl, frame } = activeCanvasRefs();

  if (!shell || !viewportEl) {
    return;
  }

  const bounds = shell.getBoundingClientRect();
  const shellPadding = 0;
  const availableWidth = Math.max(bounds.width - shellPadding * 2, 0);
  const availableHeight = Math.max(bounds.height - shellPadding * 2, 0);
  let viewportWidth = availableWidth;
  let viewportHeight = viewportWidth / A4_VIEWPORT_RATIO;

  if (viewportHeight > availableHeight) {
    viewportHeight = availableHeight;
    viewportWidth = viewportHeight * A4_VIEWPORT_RATIO;
  }

  if (!ui.drawerOpen) {
    viewportWidth = availableWidth;
  }

  viewportEl.style.width = `${viewportWidth}px`;
  viewportEl.style.height = `${viewportHeight}px`;

  if (!hasDesign.value || !frame) {
    viewport.zoomPercent = 100;
    if (ui.canvasFullscreen) {
      scheduleFullscreenEditableHotspotsRefresh();
    }
    return;
  }

  if (!renderedCanvas.value) {
    frame.style.width = `${viewportWidth}px`;
    frame.style.height = `${viewportHeight}px`;
    frame.style.left = "50%";
    frame.style.top = "50%";
    frame.style.transform = "translate(-50%, -50%)";
    frame.style.transformOrigin = "center center";
    viewport.zoomPercent = 100;
    viewport.frameLabel = t("canvas.sizeNotSet");
    if (ui.canvasFullscreen) {
      scheduleFullscreenEditableHotspotsRefresh();
    }
    return;
  }

  const baseScale = Math.min(
    viewportWidth / renderedCanvas.value.width,
    viewportHeight / renderedCanvas.value.height
  );
  const scale = clamp(
    ui.zoomMode === "fit" ? baseScale : baseScale * ui.previewZoom,
    0.04,
    8
  );

  if (ui.zoomMode === "fit") {
    ui.panX = 0;
    ui.panY = 0;
  }

  const maxPanX = Math.max((renderedCanvas.value.width * scale - viewportWidth) / 2, 0);
  const maxPanY = Math.max((renderedCanvas.value.height * scale - viewportHeight) / 2, 0);
  ui.panX = clamp(ui.panX, -maxPanX, maxPanX);
  ui.panY = clamp(ui.panY, -maxPanY, maxPanY);

  frame.style.width = `${renderedCanvas.value.width}px`;
  frame.style.height = `${renderedCanvas.value.height}px`;
  frame.style.left = "50%";
  frame.style.top = "50%";
  frame.style.transform = `translate(calc(-50% + ${ui.panX}px), calc(-50% + ${ui.panY}px)) scale(${scale})`;
  frame.style.transformOrigin = "center center";
  viewport.zoomPercent = Math.round(scale * 100);
  viewport.frameLabel = `${renderedCanvas.value.width} × ${renderedCanvas.value.height}px`;

  if (ui.canvasFullscreen) {
    scheduleFullscreenEditableHotspotsRefresh();
  }
}

function zoomIn() {
  ui.zoomMode = "manual";
  ui.previewZoom = clamp(ui.previewZoom * 1.2, 1, 8);
  fitCanvas();
}

function zoomOut() {
  ui.zoomMode = "manual";
  ui.previewZoom = clamp(ui.previewZoom / 1.2, 0.2, 8);
  fitCanvas();
}

function resetZoom() {
  ui.zoomMode = "fit";
  ui.previewZoom = 1;
  ui.panX = 0;
  ui.panY = 0;
  fitCanvas();
}

function applyCanvasWheelDelta(delta) {
  if (!hasDesign.value) {
    return;
  }

  const numericDelta = Number(delta || 0);
  if (!Number.isFinite(numericDelta) || numericDelta === 0) {
    return;
  }

  ui.zoomMode = "manual";
  const factor = numericDelta < 0 ? 1.12 : 1 / 1.12;
  ui.previewZoom = clamp(ui.previewZoom * factor, 0.2, 8);
  fitCanvas();
}

function handleCanvasWheel(event) {
  applyCanvasWheelDelta(event.deltaY);
}

// ---------------------------------------------------------------------------
// 画布平移
// ---------------------------------------------------------------------------

function stopInteraction() {
  ui.canvasDragging = false;
  interaction.mode = "";
  if (typeof removeCanvasPanListeners === "function") {
    removeCanvasPanListeners();
  }
  removeCanvasPanListeners = null;
}

function handlePointerMove(event) {
  if (interaction.mode === "resize") {
    ui.drawerWidth = clamp(interaction.originWidth - (event.clientX - interaction.startX), 340, 620);
    return;
  }

  if (interaction.mode === "floating") {
    const host = workspaceRef.value?.getBoundingClientRect();
    const maxX = Math.max((host?.width || window.innerWidth) - ui.drawerWidth - 24, 0);
    const maxY = Math.max((host?.height || window.innerHeight) - 140, 0);
    ui.floatingX = clamp(interaction.originX + (event.clientX - interaction.startX), 0, maxX);
    ui.floatingY = clamp(interaction.originY + (event.clientY - interaction.startY), 0, maxY);
    return;
  }

  if (interaction.mode === "canvas-pan") {
    ui.panX = interaction.originPanX + (event.clientX - interaction.startX);
    ui.panY = interaction.originPanY + (event.clientY - interaction.startY);
    fitCanvas();
  }
}

function beginCanvasPan(clientX, clientY) {
  interaction.mode = "canvas-pan";
  interaction.startX = clientX;
  interaction.startY = clientY;
  interaction.originPanX = ui.panX;
  interaction.originPanY = ui.panY;
  ui.canvasDragging = true;
  if (typeof removeCanvasPanListeners === "function") {
    removeCanvasPanListeners();
  }

  const teardown = [];
  const attach = (target, type, handler) => {
    if (!target?.addEventListener) {
      return;
    }

    target.addEventListener(type, handler);
    teardown.push(() => target.removeEventListener(type, handler));
  };

  attach(window, "mousemove", handlePointerMove);
  attach(window, "mouseup", stopInteraction);

  if (ui.canvasFullscreen) {
    const doc = fullscreenDesignFrame.value?.contentDocument;
    const frameWindow = fullscreenDesignFrame.value?.contentWindow;
    attach(doc, "mousemove", handlePointerMove);
    attach(doc, "mouseup", stopInteraction);
    attach(frameWindow, "mouseup", stopInteraction);
  }

  removeCanvasPanListeners = () => {
    teardown.splice(0).forEach((dispose) => dispose());
  };
}

function startCanvasPan(event) {
  if (!hasDesign.value || event.button !== 0) {
    return;
  }

  beginCanvasPan(event.clientX, event.clientY);
}

// ---------------------------------------------------------------------------
// 抽屉交互
// ---------------------------------------------------------------------------

function selectDrawer(id) {
  ui.activeDrawer = id;
  ui.drawerOpen = true;
  nextTick(() => fitCanvas());
}

function toggleDrawerVisibility() {
  ui.drawerOpen = !ui.drawerOpen;
  nextTick(() => fitCanvas());
}

function closeDrawer() {
  ui.drawerOpen = false;
  nextTick(() => fitCanvas());
}

function startDrawerResize(event) {
  if (ui.drawerFloating) {
    return;
  }

  interaction.mode = "resize";
  interaction.startX = event.clientX;
  interaction.originWidth = ui.drawerWidth;
  window.addEventListener("mousemove", handlePointerMove);
  window.addEventListener("mouseup", stopInteraction);
}

function startFloatingDrag(event) {
  if (!ui.drawerFloating) {
    return;
  }

  interaction.mode = "floating";
  interaction.startX = event.clientX;
  interaction.startY = event.clientY;
  interaction.originX = ui.floatingX;
  interaction.originY = ui.floatingY;
  window.addEventListener("mousemove", handlePointerMove);
  window.addEventListener("mouseup", stopInteraction);
}

function toggleDrawerFloating() {
  ui.drawerFloating = !ui.drawerFloating;

  if (ui.drawerFloating) {
    ui.floatingX = 24;
    ui.floatingY = 24;
  }
}

// ---------------------------------------------------------------------------
// 导出菜单
// ---------------------------------------------------------------------------

function toggleExportMenu() {
  if (!canExport.value) {
    return;
  }

  ui.exportMenuOpen = !ui.exportMenuOpen;
}

function closeExportMenu() {
  ui.exportMenuOpen = false;
}

// ---------------------------------------------------------------------------
// 下拉菜单
// ---------------------------------------------------------------------------

function openDropdown(id, triggerEl) {
  if (activeDropdown.id === id) {
    activeDropdown.id = null;
    return;
  }
  const rect = triggerEl.getBoundingClientRect();
  activeDropdown.id = id;
  activeDropdown.rect = { top: rect.bottom + 4, left: rect.left, width: rect.width };
}

function closeDropdown() {
  activeDropdown.id = null;
}

// ---------------------------------------------------------------------------
// 全屏编辑 — 进入/退出
// ---------------------------------------------------------------------------

function openCanvasFullscreen() {
  if (ui.canvasFullscreen) {
    return;
  }

  initializeFullscreenEditorState();
  ui.canvasFullscreen = true;
  nextTick(() => {
    fitCanvas();
  });
}

async function closeCanvasFullscreen() {
  if (!ui.canvasFullscreen) {
    return;
  }

  if (fullscreenHasUnsavedChanges.value) {
    const confirmed = await requestConfirmation({
      title: t("confirm.discardChangesTitle"),
      message: t("confirm.discardChangesMessage"),
      confirmLabel: t("confirm.discardChangesConfirm"),
      tone: "warn"
    });
    if (!confirmed) {
      return;
    }
  }

  stopInteraction();
  removeFullscreenFrameBindings();
  resetFullscreenEditorState();
  ui.canvasFullscreen = false;
  nextTick(() => {
    fitCanvas();
  });
}

// ---------------------------------------------------------------------------
// 全屏编辑 — 编辑入口选择与输入
// ---------------------------------------------------------------------------

function focusFullscreenEditorInput() {
  nextTick(() => {
    fullscreenEditorInputRef.value?.focus();
    fullscreenEditorInputRef.value?.select?.();
  });
}

function selectFullscreenEditableEntry(entryId = "") {
  if (!entryId) {
    return;
  }

  fullscreenEditor.selectedEntryId = entryId;
  fullscreenEditor.lastEntryLabel = fullscreenSelectedEntry.value?.label || fullscreenEditor.lastEntryLabel;
  decorateFullscreenEditableDocument();
  focusFullscreenEditorInput();
}

// ---------------------------------------------------------------------------
// 全屏编辑 — 热区 (hotspot)
// ---------------------------------------------------------------------------

function clearFullscreenEditableHotspots() {
  if (fullscreenHotspotAnimationFrame) {
    window.cancelAnimationFrame(fullscreenHotspotAnimationFrame);
    fullscreenHotspotAnimationFrame = 0;
  }
  fullscreenEditableHotspots.value = [];
  fullscreenHotspotLayerStyle.value = {};
}

function syncFullscreenHotspotLayerStyle() {
  const frame = fullscreenDesignFrame.value;
  if (!ui.canvasFullscreen || !frame) {
    fullscreenHotspotLayerStyle.value = {};
    return;
  }

  fullscreenHotspotLayerStyle.value = {
    width: frame.style.width || "",
    height: frame.style.height || "",
    left: frame.style.left || "",
    top: frame.style.top || "",
    transform: frame.style.transform || "",
    transformOrigin: frame.style.transformOrigin || ""
  };
}

function refreshFullscreenEditableHotspots() {
  fullscreenHotspotAnimationFrame = 0;

  const doc = fullscreenDesignFrame.value?.contentDocument;
  if (!ui.canvasFullscreen || !hasDesign.value || !doc) {
    fullscreenEditableHotspots.value = [];
    fullscreenHotspotLayerStyle.value = {};
    return;
  }

  syncFullscreenHotspotLayerStyle();
  const nextHotspots = [];

  fullscreenEditableEntries.value.forEach((entry) => {
    const target = entry.path ? doc.querySelector(entry.path) : null;
    if (!target) {
      return;
    }

    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    nextHotspots.push({
      id: entry.id,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  });

  fullscreenEditableHotspots.value = nextHotspots;
}

function scheduleFullscreenEditableHotspotsRefresh() {
  if (!ui.canvasFullscreen) {
    fullscreenEditableHotspots.value = [];
    return;
  }

  if (fullscreenHotspotAnimationFrame) {
    window.cancelAnimationFrame(fullscreenHotspotAnimationFrame);
  }

  fullscreenHotspotAnimationFrame = window.requestAnimationFrame(() => {
    refreshFullscreenEditableHotspots();
  });
}

// ---------------------------------------------------------------------------
// 全屏编辑 — 文档装饰与帧绑定
// ---------------------------------------------------------------------------

function findFullscreenEditableElementById(doc, entryId) {
  if (!doc || !entryId) {
    return null;
  }

  return [...doc.querySelectorAll("[data-designcode-editable-id]")].find((element) => {
    return element.getAttribute("data-designcode-editable-id") === entryId;
  }) || null;
}

function decorateFullscreenEditableDocument() {
  const doc = fullscreenDesignFrame.value?.contentDocument;
  if (!doc || !ui.canvasFullscreen || !hasDesign.value) {
    return;
  }

  if (doc.documentElement) {
    doc.documentElement.setAttribute("data-designcode-fullscreen-editor", "true");
  }

  let styleTag = doc.getElementById("designcode-fullscreen-edit-style");
  if (!styleTag) {
    styleTag = doc.createElement("style");
    styleTag.id = "designcode-fullscreen-edit-style";
    styleTag.textContent = `
      html[data-designcode-fullscreen-editor="true"],
      html[data-designcode-fullscreen-editor="true"] body {
        -webkit-user-select: none !important;
        user-select: none !important;
      }
      html[data-designcode-fullscreen-editor="true"] img,
      html[data-designcode-fullscreen-editor="true"] svg,
      html[data-designcode-fullscreen-editor="true"] canvas {
        -webkit-user-drag: none !important;
        user-select: none !important;
      }
      [data-designcode-editable-id] {
        cursor: text !important;
        outline: 1px dashed rgba(57, 124, 255, 0.45);
        outline-offset: 4px;
        transition: outline-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
      }
      [data-designcode-editable-id]:hover {
        outline-color: rgba(57, 124, 255, 0.8);
        background: rgba(57, 124, 255, 0.08);
      }
      [data-designcode-editable-selected="true"] {
        outline: 2px solid rgba(57, 124, 255, 0.96);
        outline-offset: 4px;
        background: rgba(57, 124, 255, 0.12);
        box-shadow: 0 0 0 4px rgba(57, 124, 255, 0.12);
      }
    `;
    doc.head.append(styleTag);
  }

  [...doc.querySelectorAll("[data-designcode-editable-id]")].forEach((element) => {
    element.removeAttribute("data-designcode-editable-id");
    element.removeAttribute("data-designcode-editable-selected");
  });

  fullscreenEditableEntries.value.forEach((entry) => {
    const target = entry.path ? doc.querySelector(entry.path) : null;
    if (!target) {
      return;
    }

    target.setAttribute("data-designcode-editable-id", entry.id);
    if (entry.id === fullscreenEditor.selectedEntryId) {
      target.setAttribute("data-designcode-editable-selected", "true");
    }
  });
}

function removeFullscreenFrameBindings() {
  if (typeof removeFullscreenFrameListeners === "function") {
    removeFullscreenFrameListeners();
  }
  removeFullscreenFrameListeners = null;
  clearFullscreenEditableHotspots();
}

function bindFullscreenFrameInteractions() {
  removeFullscreenFrameBindings();

  const doc = fullscreenDesignFrame.value?.contentDocument;
  if (!doc || !ui.canvasFullscreen || !hasDesign.value) {
    return;
  }

  decorateFullscreenEditableDocument();
  scheduleFullscreenEditableHotspotsRefresh();

  removeFullscreenFrameListeners = () => {
    doc.documentElement?.removeAttribute("data-designcode-fullscreen-editor");
  };
}

function handleFullscreenFrameLoad() {
  fitCanvas();
  bindFullscreenFrameInteractions();
}

function handleFullscreenHotspotMouseDown(entryId, event) {
  event.preventDefault();
  event.stopPropagation();
  selectFullscreenEditableEntry(entryId);
}

function handleFullscreenEditorInput(event) {
  const entry = fullscreenSelectedEntry.value;
  if (!entry) {
    return;
  }

  const value = event.target.value;
  const nextDraftHtml = patchEditableTextInHtml(fullscreenEditor.draftHtml || state.currentHtml, entry, value);
  if (!nextDraftHtml) {
    return;
  }

  fullscreenEditor.draftHtml = nextDraftHtml;
  fullscreenEditor.lastEntryLabel = entry.label || entry.fieldId || entry.tagName || "editable text";
  updateFullscreenIframeText(entry, value);

  if (entry.fieldId) {
    fullscreenEditor.draftFields = {
      ...(fullscreenEditor.draftFields || {}),
      [entry.fieldId]: value
    };
    fullscreenEditor.draftMeta = normalizeMeta({
      ...(fullscreenEditor.draftMeta || state.currentMeta || {}),
      fields: {
        ...((fullscreenEditor.draftMeta || state.currentMeta || {}).fields || {}),
        [entry.fieldId]: value
      }
    });
  }
}

async function saveFullscreenEditorChanges() {
  if (!hasDesign.value || !fullscreenHasUnsavedChanges.value || fullscreenEditor.saveBusy) {
    return;
  }

  fullscreenEditor.saveBusy = true;
  try {
    const success = await saveEditableHtmlPayload(
      buildEditableHtmlPayload({
        html: fullscreenEditor.draftHtml || state.currentHtml,
        meta: cloneSnapshot(fullscreenEditor.draftMeta || state.currentMeta),
        fields: cloneSnapshot(fullscreenEditor.draftFields || state.fields),
        entryLabel: fullscreenEditor.lastEntryLabel || "fullscreen edit",
        summary: `Fullscreen edit updated ${compactText(fullscreenEditor.lastEntryLabel || "editable text")}.`,
        logSummary: `Fullscreen edit updated ${compactText(fullscreenEditor.lastEntryLabel || "editable text")}.`
      })
    );

    if (!success) {
      return;
    }

    const selectedEntryId = fullscreenEditor.selectedEntryId;
    initializeFullscreenEditorState();
    if (fullscreenEditableEntries.value.some((entry) => entry.id === selectedEntryId)) {
      fullscreenEditor.selectedEntryId = selectedEntryId;
    }
    decorateFullscreenEditableDocument();
    setStatus(t("status.fullscreenSaved"), "success", "save");
  } finally {
    fullscreenEditor.saveBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 帧加载
// ---------------------------------------------------------------------------

function handleFrameLoad() {
  frameLoadedRevision.value = frameRevision.value;
  resolveFrameReadyWaiters();
  fitCanvas();
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

function handleShortcut(event) {
  if (event.key === "Escape" && confirmDialog.open) {
    event.preventDefault();
    settleConfirmation(false);
    return;
  }

  if (event.key === "Escape" && ui.canvasFullscreen) {
    event.preventDefault();
    void closeCanvasFullscreen();
    return;
  }

  if (event.key === "Escape" && ui.exportMenuOpen) {
    event.preventDefault();
    closeExportMenu();
    return;
  }

  if (event.key === "Escape" && ui.stylePreviewId) {
    event.preventDefault();
    if (typeof _closeStylePreview === "function") {
      _closeStylePreview();
    }
    return;
  }

  if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  if (document.activeElement?.id === "agentPromptInput" && state.desktop.isDesktop) {
    if (typeof _runAgentPrompt === "function") {
      _runAgentPrompt();
    }
    return;
  }

  if (document.activeElement?.id === "composerInput") {
    if (typeof _submitConversation === "function") {
      _submitConversation();
    }
  }
}

// ---------------------------------------------------------------------------
// 窗口级指针事件
// ---------------------------------------------------------------------------

function handleWindowPointerDown(event) {
  if (activeDropdown.id && !event.target.closest(".custom-select")) {
    closeDropdown();
  }

  if (ui.localeMenuOpen && !event.target.closest(".locale-picker")) {
    ui.localeMenuOpen = false;
  }

  if (!ui.exportMenuOpen || !exportMenuRef.value) {
    return;
  }

  if (!exportMenuRef.value.contains(event.target)) {
    closeExportMenu();
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function useCanvasViewport() {
  return {
    // 依赖注入
    setDeps,

    // 缩放和适配
    fitCanvas,
    zoomIn,
    zoomOut,
    resetZoom,
    applyCanvasWheelDelta,
    handleCanvasWheel,

    // 平移
    beginCanvasPan,
    startCanvasPan,
    stopInteraction,
    handlePointerMove,

    // 抽屉交互
    selectDrawer,
    toggleDrawerVisibility,
    closeDrawer,
    startDrawerResize,
    startFloatingDrag,
    toggleDrawerFloating,

    // 导出菜单
    toggleExportMenu,
    closeExportMenu,

    // 下拉菜单
    openDropdown,
    closeDropdown,

    // 全屏编辑
    openCanvasFullscreen,
    closeCanvasFullscreen,
    resetFullscreenEditorState,
    initializeFullscreenEditorState,
    selectFullscreenEditableEntry,
    refreshFullscreenEditableHotspots,
    scheduleFullscreenEditableHotspotsRefresh,
    clearFullscreenEditableHotspots,
    syncFullscreenHotspotLayerStyle,
    decorateFullscreenEditableDocument,
    bindFullscreenFrameInteractions,
    removeFullscreenFrameBindings,
    handleFullscreenFrameLoad,
    handleFullscreenHotspotMouseDown,
    handleFullscreenEditorInput,
    saveFullscreenEditorChanges,
    focusFullscreenEditorInput,
    findFullscreenEditableElementById,

    // 全屏编辑辅助
    fullscreenEntryDraft,
    updateFullscreenIframeText,

    // 帧加载
    handleFrameLoad,
    activeCanvasRefs,
    frameLoadedRevision,
    resolveFrameReadyWaiters,
    waitForFrameReady,

    // 快捷键
    handleShortcut,
    handleWindowPointerDown,
  };
}
