<script setup>
// 工作区容器 — 单 tab 内的完整工作台。
// 由 App.vue 用 :key="activeTabId" 包裹；切 tab 时此组件整体重挂载，
// 内部所有 composable 的 setup 重跑、`useWorkspaceState()` 解析到新 tab 的 store。
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import {
  listenDesktopEvent,
  rebuildNativeMenu,
  getSystemLocale,
  listenMenuAction,
  isTauriRuntime
} from "../lib/desktop-api.js";
import { t, locale, setLocale, onLocaleChange, SUPPORTED_LOCALES } from "../i18n/index.js";
import { RAIL_ICONS } from "../constants/icons.js";
import { useWorkspaceState } from "../composables/useWorkspaceState.js";
import { useConfirmDialog } from "../composables/useConfirmDialog.js";
import { useAppUpdate } from "../composables/useAppUpdate.js";
import { useConversation } from "../composables/useConversation.js";
import { useSetupConfig } from "../composables/useSetupConfig.js";
import { useCliStream } from "../composables/useCliStream.js";
import { useDesignSession } from "../composables/useDesignSession.js";
import { useCanvasViewport } from "../composables/useCanvasViewport.js";
import { useArtAssets } from "../composables/useArtAssets.js";
import { useDesignExport } from "../composables/useDesignExport.js";
import { useRuntimeAgent } from "../composables/useRuntimeAgent.js";
import { useViewportScale } from "../composables/useViewportScale.js";
import { useTabs } from "../composables/useTabs.js";
import ToolRail from "./ToolRail.vue";
import ComposerPanel from "./ComposerPanel.vue";
import StylePreviewOverlay from "./overlays/StylePreviewOverlay.vue";
import FullscreenEditor from "./overlays/FullscreenEditor.vue";
import TopBar from "./TopBar.vue";
import AboutDrawer from "./drawers/AboutDrawer.vue";
import SettingsDrawer from "./drawers/SettingsDrawer.vue";
import PromptDrawer from "./drawers/PromptDrawer.vue";
import InspectDrawer from "./drawers/InspectDrawer.vue";
import StylesDrawer from "./drawers/StylesDrawer.vue";
import HistoryDrawer from "./drawers/HistoryDrawer.vue";
import AssetsDrawer from "./drawers/AssetsDrawer.vue";
import SetupDrawer from "./drawers/SetupDrawer.vue";
import RuntimeDrawer from "./drawers/RuntimeDrawer.vue";

const {
  state, viewport, fullscreenEditor, ui, interaction,
  runtimeWarmupState, runtimeWarmupPromises, conversationExpandedBlocks, activeDropdown,
  workspaceRef, frameShell, frameViewport, designFrame,
  fullscreenFrameShell, fullscreenFrameViewport, fullscreenDesignFrame,
  fullscreenEditorInputRef, fullscreenEditableHotspots, fullscreenHotspotLayerStyle,
  conversationScrollRef, assetInputRef, assetDrawerRef, exportMenuRef, headerTitleInputRef,
  frameRevision,
  hasDirectTauriInvoke, invokeDesktop, findExactById, compactText,
  setStatus, setBusy, setAgentBusy, runInBackground, queueBackgroundWorkspaceTask
} = useWorkspaceState();
const { confirmDialog, requestConfirmation, settleConfirmation } = useConfirmDialog();
const { updateState, doCheckForUpdates, doInstallUpdate, doRelaunch, openUpdateUrl } = useAppUpdate();
const {
  RUNTIME_PROXY_PORT_STORAGE_KEY, A4_VIEWPORT_RATIO,
  EXPORT_QUALITY_OPTIONS, STYLE_GUIDE_SECTIONS,
  drawerTabs, rightPanelTabs, RUNTIME_BACKEND_OPTIONS, leftRailTabs,
  styles, currentStyle, stylePreviewStyle,
  fontStack, buildStyleGuideSections, stylePreviewGuideSections,
  currentExportQuality, stylePreviewSurfaceStyle,
  styleCardSurfaceStyle,
  availableSizePresetOptions, currentSizeMode, currentSize, renderedCanvas,
  fieldDefinitions, editableTextEntries,
  fullscreenEditableEntries, fullscreenSelectedEntry,
  activeVersion, hasDesign, hasActiveDesignSession, hasPrompt,
  canUndo, canExport, canExportPsd,
  designChatMessages, currentConversationScopeKey,
  conversationHasScopedRuntimeState, conversationIsBusy, liveConversationBlocks,
  designLibrary, artAssetLibrary, selectedArtAssets,
  renderablePreviewHtml, fullscreenRenderablePreviewHtml,
  selectedAssetCount, latestCommit, projectTitle, headerEditableTitle,
  formatHistoryDate, formatHistoryDateTime,
  inspectEditableCountLabel, fullscreenHasUnsavedChanges,
  inspectSaveTone, topbarSaveStatus, inspectSaveLabel, newDesignNameExample,
  composeWorkspaceSystemPrompt, buildPromptBundleForInstruction, livePromptBundle, promptPreviewText,
  runtimeBackendDisplayName, normalizeGeminiModelValue,
  conversationAgentOutputText, workspaceStateLabel, workspaceHint,
  providerLabel, versionMetaLabel, successNotice,
  activeDrawerTab, workspaceStyle, drawerShellStyle,
  runtimeModeLabel, nodeRuntimeLabel,
  opencodeInstallLabel, codexInstallLabel, claudeInstallLabel, geminiInstallLabel,
  opencodeSessionLabel, codexSessionLabel, claudeSessionLabel, geminiSessionLabel,
  runtimeDirectory, activeRuntimeBackend,
  availableProviders, providerPickerOptions, apiProviderPickerOptions,
  selectedProvider, selectedProviderModels, opencodeSmallModelOptions,
  codexModelOptions, selectedCodexModel,
  claudeModelOptions, claudeEffortOptions, geminiModelOptions, codexReasoningOptions,
  sandboxDirectoryLabel, activeRuntimeSessionId,
  activeModelLabel, providerConnectionLabel,
  agentOptions, appliedProxyLabel, currentRuntimeSessionLabel,
  runtimeAgentEnabled, runtimeShellEnabled,
  renderedCanvasLabel, promptSizeLabel, consoleStatusLabel,
  canvasLoadingVisible, canvasLoadingLabel, canvasLoadingDetail,
  headerSizeLabel,
  conversationPrimaryLabel, conversationPrimaryBusyLabel,
  agentOutputText, designHistoryHint, authResultText,
  compactWorkbenchStatus,
  syncActiveRuntimeSession,
  buildDesignConfigPayload,
  serializeSignaturePart, serializeFieldsForSignature,
  serializeFieldDefinitionsForSignature, serializeCustomSizeForSignature,
  serializeDesignConfigPayload,
  currentDesignConfigSignature, clearDesignConfigSaveTimer,
  setDesignConfigSaveBaseline,
  upsertDesignLibraryItem, shouldApplyPersistResult, saveDesignConfigPayload,
  persistCurrentDesignConfig, scheduleCurrentDesignConfigSave, flushCurrentDesignConfig,
  makeDefaultCustomSize, templateFieldDefinitions, templateFieldDefaults,
  getDesignConfigHydrating, setDesignConfigHydrating,
  getDesignConfigSavedSignature,
} = useSetupConfig();

let removeDesktopDragEnterListener = null;
let removeDesktopDragOverListener = null;
let removeDesktopDragLeaveListener = null;
let removeDesktopDragDropListener = null;

const {
  conversationRoleLabel, conversationActorName, conversationActorInitial, conversationKindLabel,
  conversationStoredTone, conversationStoredBlocks,
  appendOptimisticUserConversation, finalizeOptimisticConversationEntry,
  appendLocalAssistantConversation, rollbackOptimisticConversationEntry,
  normalizeConversationMessage,
  conversationBlockText, conversationBlockKey, conversationBlockExpandable,
  isConversationBlockExpanded, toggleConversationBlock,
  nextAgentStreamBlockId, findLastBlockIndex,
  pickFirstText, normalizeTodoStatus, normalizeTodoEntries, resolveApprovalDetails,
  parseCodexStreamBlock, parseClaudeStreamBlock, parseGeminiStreamBlock, parseCliStreamBlock,
  upsertAgentStreamBlock, handleConversationBlockAction,
  pendingConversationBlocks, conversationEntries
} = useConversation({
  activeRuntimeBackend,
  activeRuntimeSessionId,
  runtimeDirectory,
  runtimeBackendDisplayName,
  designChatMessages,
  liveConversationBlocks,
  conversationIsBusy
});

const {
  nextCodexStreamId, buildCodexSuppressedLines, HIDDEN_SOURCE_MESSAGE,
  compactConsoleText, looksLikeSourceDump,
  sanitizeAgentConsoleMessage, sanitizeAgentLogMessage,
  formatStreamElapsedTag, prefixMultilineLog, summarizeCliResultOutput,
  formatCodexJsonEvent, formatClaudeJsonEvent, formatGeminiJsonEvent,
  sanitizeGeminiStderrLine, formatCliBlockSummary, formatCliStreamPayload,
  appendAgentOutputLine, beginAgentOutputSection, appendAgentOutputEntry,
  markConversationRuntimeScope, rebindConversationRuntimeScope,
  serializeConversationBlocksForStorage,
  beginCliStream, endCliStream
} = useCliStream();

const {
  setDeps: setDesignSessionDeps,
  assetFallbackLabel, sanitizeDesignName,
  openHeaderTitleEditor, commitHeaderTitleEdit, cancelHeaderTitleEdit,
  handleHeaderTitleInput, handleHeaderTitleKeydown,
  syncVersionsFromCommits, restoreVersion,
  clearEditableHtmlSaveTimer, setEditableHtmlBaseline,
  syncEditableTextDrafts, persistEditableHtmlChanges,
  scheduleEditableHtmlSave, flushEditableHtmlChanges,
  updateEditableTextEntry,
  buildEditableHtmlPayload,
  saveEditableHtmlPayload,
  refreshDesignLibrary,
  resetDesignConfiguration, clearCurrentDesignWorkspace,
  applyOpenedDesignRecord, openDesignRecord, deleteDesignRecord,
  startNewDesignSession,
  buildPayload, applyDesignResult,
  generateDesign, editDesign,
  submitConversation, handleComposerKeydown,
  selectStyle, openStylePreview, closeStylePreview,
  setSizePreset, setSizeMode,
  addCustomField, removeField,
  fillBrief, fillComposer,
} = useDesignSession();

const {
  refreshArtAssetLibrary, triggerAssetImport,
  importAssetFiles, handleAssetImport,
  dataTransferHasFiles, resetAssetDropState,
  handleAssetDragEnter, handleAssetDragOver, handleAssetDragLeave, handleAssetDrop,
  handleWindowFileDropGuard, handleWindowAssetDragEnter, handleWindowAssetDragLeave, handleWindowAssetDrop,
  handleDesktopAssetDragEnter, handleDesktopAssetDragOver, handleDesktopAssetDragLeave, handleDesktopAssetDrop,
  setArtAssetSelection, saveArtAssetMetadata, persistPendingAssetNotes,
  deleteArtAssetFromLibrary,
} = useArtAssets();

const {
  setDeps: setCanvasViewportDeps,
  fitCanvas, zoomIn, zoomOut, resetZoom, applyCanvasWheelDelta, handleCanvasWheel,
  beginCanvasPan, startCanvasPan, stopInteraction, handlePointerMove,
  selectDrawer, toggleDrawerVisibility, closeDrawer,
  startDrawerResize, startFloatingDrag, toggleDrawerFloating,
  toggleExportMenu, closeExportMenu,
  openDropdown, closeDropdown,
  openCanvasFullscreen, closeCanvasFullscreen,
  resetFullscreenEditorState, initializeFullscreenEditorState,
  selectFullscreenEditableEntry, refreshFullscreenEditableHotspots,
  scheduleFullscreenEditableHotspotsRefresh, clearFullscreenEditableHotspots,
  syncFullscreenHotspotLayerStyle, decorateFullscreenEditableDocument,
  bindFullscreenFrameInteractions, removeFullscreenFrameBindings,
  handleFullscreenFrameLoad, handleFullscreenHotspotMouseDown,
  handleFullscreenEditorInput, saveFullscreenEditorChanges,
  focusFullscreenEditorInput, findFullscreenEditableElementById,
  fullscreenEntryDraft, updateFullscreenIframeText,
  handleFrameLoad, activeCanvasRefs,
  handleShortcut, handleWindowPointerDown,
} = useCanvasViewport();

const {
  runExportAction,
  exportHtml, exportSvg, exportPng, exportPdf, exportPsd,
} = useDesignExport();

const {
  normalizeProxyPort, loadRuntimeProxyPortPreference, persistRuntimeProxyPortPreference,
  applyProxyPort, restartOpencodeWithCurrentProxy,
  handleStartOpencode, handleStopOpencode, handleCreateSession,
  applySelectedModel, refreshDesktopIntegration,
  syncOpenCodeProviderBaseUrl, syncOpenCodeProviderApiKey,
  handleOpenCodexLogin, handleVerifyCodex, applyCodexModel,
  applyCodexStatusSnapshot, syncCodexModelSelection, syncCodexReasoningSelection,
  handleOpenClaudeLogin, handleVerifyClaude, applyClaudeModel,
  applyClaudeStatusSnapshot, applyClaudeModelsSnapshot,
  handleOpenGeminiLogin, handleVerifyGemini, applyGeminiModel,
  applyGeminiStatusSnapshot, applyGeminiModelsSnapshot,
  normalizedGeminiBinary,
  runtimeWarmupEligible, runtimeWarmupPayload, runtimeWarmupKey,
  ensureRuntimeWarmup, scheduleRuntimeWarmups,
  sendActiveCliPrompt, activeCliBinary, activeCliModel, activeCliEffort,
  runtimeLoginReminder,
  runAgentPrompt, runAgentShell,
  applyRuntimeCatalog, syncRuntimeModelSelection,
  ensureDesignAgentSession,
  bootstrap, hydrateFromMeta,
  setRuntimeBackend, readRuntimeSession, writeRuntimeSession,
  resolvedGeminiModelLabel, clearPendingBrowserAuth,
  applyProviderConnectionSnapshot, applyCliSessionToState,
  syncOpenCodeSmallModelSelection,
} = useRuntimeAgent();

// ---------------------------------------------------------------------------
// 视口自适应缩放：窗口尺寸不足时等比缩小整个 UI
// ---------------------------------------------------------------------------
const { updateScale } = useViewportScale();

watch(() => ui.drawerOpen, () => {
  nextTick(updateScale);
});

const currentRuntimeHeaderLabel = computed(() => t("runtime.currentRuntimeHeader", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }));

watch(
  () => `${state.design.chat.length}|${state.agent.streamBlocks.length}|${state.agent.streamBlocks.at(-1)?.status || ""}`,
  async () => {
    await nextTick();
    if (!conversationScrollRef.value) {
      return;
    }
    conversationScrollRef.value.scrollTop = conversationScrollRef.value.scrollHeight;
  }
);

watch(projectTitle, (value) => {
  document.title = `${value} · DesignCode Studio`;
}, { immediate: true });

watch(agentOptions, (options) => {
  if (!options.includes(state.agent.selectedAgent)) {
    state.agent.selectedAgent = options[0] || "build";
  }
}, { immediate: true });

watch(
  () => state.agent.providerId,
  (providerId) => {
    if (!providerId) {
      state.agent.modelId = "";
      state.agent.opencodeProviderBaseUrl = "";
      state.agent.opencodeProviderApiKey = "";
      state.agent.opencodeProviderApiKeySaved = false;
      return;
    }

    const models = Object.keys(selectedProvider.value?.models || {});
    if (!models.length) {
      state.agent.modelId = "";
      syncOpenCodeProviderBaseUrl(providerId);
      syncOpenCodeProviderApiKey(providerId);
      return;
    }

    if (models.includes(state.agent.modelId)) {
      syncOpenCodeProviderBaseUrl(providerId);
      syncOpenCodeProviderApiKey(providerId);
      return;
    }

    syncRuntimeModelSelection();
    syncOpenCodeProviderBaseUrl(providerId);
    syncOpenCodeProviderApiKey(providerId);
  }
);

watch(
  () => state.agent.codexModelId,
  () => {
    syncCodexReasoningSelection();
  }
);

watch(
  () => renderablePreviewHtml.value,
  async (html) => {
    if (!html) {
      viewport.zoomPercent = 100;
      viewport.frameLabel = currentSize.value?.label || t("canvas.notGenerated");
      await nextTick();
      fitCanvas();
      return;
    }

    frameRevision.value += 1;
    await nextTick();
    fitCanvas();
  },
  { flush: "post" }
);

watch(
  editableTextEntries,
  (entries) => {
    syncEditableTextDrafts(entries);
  },
  { immediate: true }
);

watch(
  () => ui.activeDrawer,
  (drawerId) => {
    if (drawerId !== "assets") {
      resetAssetDropState();
    }
  }
);

watch(
  fullscreenEditableEntries,
  (entries) => {
    if (!ui.canvasFullscreen) {
      return;
    }

    if (fullscreenEditor.selectedEntryId && !entries.some((entry) => entry.id === fullscreenEditor.selectedEntryId)) {
      fullscreenEditor.selectedEntryId = "";
    }

    nextTick(() => {
      decorateFullscreenEditableDocument();
    });
  },
  { flush: "post" }
);

watch(currentSize, (size) => {
  if (!hasDesign.value) {
    viewport.frameLabel = size?.label || t("canvas.notGenerated");
  }
}, { immediate: true });

watch(
  () => currentDesignConfigSignature(),
  (signature) => {
    if (!signature || getDesignConfigHydrating()) {
      return;
    }

    if (signature === getDesignConfigSavedSignature()) {
      return;
    }

    scheduleCurrentDesignConfigSave();
  }
);

watch(renderedCanvas, async () => {
  await nextTick();
  fitCanvas();
});

function inspectEntryDraft(entry) {
  return state.inspect.drafts[entry.id] ?? entry.value ?? "";
}

async function flushPendingWorkspaceState() {
  const htmlFlushed = await flushEditableHtmlChanges();
  if (!htmlFlushed) {
    return false;
  }

  return flushCurrentDesignConfig();
}

setDesignSessionDeps({
  resetZoom,
  hydrateFromMeta,
  normalizedGeminiBinary,
  nextCodexStreamId,
  beginCliStream,
  endCliStream,
  appendAgentOutputLine,
  markConversationRuntimeScope,
  rebindConversationRuntimeScope,
  serializeConversationBlocksForStorage,
  runtimeLoginReminder,
  ensureRuntimeWarmup,
  ensureDesignAgentSession,
  scheduleRuntimeWarmups,
  refreshDesktopIntegration,
  persistPendingAssetNotes,
  sanitizeAgentConsoleMessage,
});

// ---------------------------------------------------------------------------
// 注入 useCanvasViewport 延迟依赖
// ---------------------------------------------------------------------------
setCanvasViewportDeps({
  closeStylePreview,
  runAgentPrompt,
  submitConversation,
});

let removeMenuActionListener = null;

// 标签页待执行动作：openOrCreateForDesign / createTabForNewDesign 创建新 tab 时
// 会附带 pendingAction，这里在挂载完成且 bootstrap 结束后消费一次。
const { activeTabId: currentTabId, consumePendingAction, createTabForNewDesign, openOrCreateForDesign } = useTabs();

// 消费指定 tab 的 pendingAction：根据类型触发新建会话 / 打开设计稿。
function handlePendingAction(tabId) {
  if (!tabId) return;
  const pending = consumePendingAction(tabId);
  if (!pending) return;
  if (pending.type === "new") {
    startNewDesignSession();
  } else if (pending.type === "open" && pending.designId) {
    openDesignRecord(pending.designId);
  }
}

// 切 tab 时：立刻消费新 tab 的 pendingAction（不用等任何 bootstrap）。
// 同步 setStatus 到 idle，避免新 tab 残留 "loading"。useTabs.createTab 已经
// 通过 seedStateFromPrimary 把 catalog/agents/desktop 灌进来，所以 UI 立刻可用。
watch(currentTabId, (newId, oldId) => {
  if (!newId || newId === oldId) return;
  handlePendingAction(newId);
});

onMounted(() => {
  window.addEventListener("resize", fitCanvas);
  window.addEventListener("keydown", handleShortcut);
  window.addEventListener("pointerdown", handleWindowPointerDown);
  window.addEventListener("dragenter", handleWindowAssetDragEnter);
  window.addEventListener("dragleave", handleWindowAssetDragLeave);
  window.addEventListener("dragover", handleWindowFileDropGuard);
  window.addEventListener("drop", handleWindowAssetDrop);

  // bootstrap 只在 app 启动时跑一次；WorkbenchContainer 现在整个生命期内
  // 只 mount 一次，切 tab 不会重新触发这个钩子。
  //
  // bootstrap 内部已经把各分支错误折叠进 state.warnings + 会话控制台日志；
  // 只有真正意外的顶层异常（例如 composable 内部语法错误）才会到这里。此时也
  // 不要只扔一个红色 "失败" 标签 —— 右上角那个 chip 完全没法让用户看见 stack，
  // 一并把详情灌进会话控制台日志，方便截图反馈。
  bootstrap()
    .catch((error) => {
      const detail = error instanceof Error ? (error.stack || error.message) : String(error);
      state.warnings = [detail];
      appendAgentOutputEntry(`⚠ bootstrap: ${detail}`);
      setStatus(t("status.workbenchReady"), "idle", "load");
    })
    .finally(() => {
      handlePendingAction(currentTabId.value);
    });

  void Promise.all([
    listenDesktopEvent("tauri://drag-enter", handleDesktopAssetDragEnter),
    listenDesktopEvent("tauri://drag-over", handleDesktopAssetDragOver),
    listenDesktopEvent("tauri://drag-leave", handleDesktopAssetDragLeave),
    listenDesktopEvent("tauri://drag-drop", handleDesktopAssetDrop)
  ]).then(([offEnter, offOver, offLeave, offDrop]) => {
    removeDesktopDragEnterListener = offEnter;
    removeDesktopDragOverListener = offOver;
    removeDesktopDragLeaveListener = offLeave;
    removeDesktopDragDropListener = offDrop;
  });

  // listenMenuAction 返回 Promise<unlisten>，需在 then 内捕获 unlisten
  Promise.resolve(listenMenuAction((payload) => {
    const action = payload?.action;
    if (!action) {
      return;
    }

    switch (action) {
      case "new-design": createTabForNewDesign(); break;
      case "export-html": exportHtml(); break;
      case "export-png": exportPng(); break;
      case "export-svg": exportSvg(); break;
      case "export-pdf": exportPdf(); break;
      case "export-psd": exportPsd(); break;
      case "fit-canvas": resetZoom(); break;
      case "fullscreen-edit": ui.canvasFullscreen ? closeCanvasFullscreen() : openCanvasFullscreen(); break;
      case "generate-design": generateDesign(); break;
      case "edit-design": editDesign(); break;
      case "about": selectDrawer("about"); break;
      case "check-updates": selectDrawer("about"); doCheckForUpdates(state.agent.proxy); break;
      default: break;
    }
  })).then((off) => {
    removeMenuActionListener = typeof off === "function" ? off : null;
  });

  onLocaleChange((id) => {
    rebuildNativeMenu(id).catch(() => {});
  });

  if (isTauriRuntime()) {
    rebuildNativeMenu(locale.value).catch(() => {});
  }
});

onBeforeUnmount(() => {
  // 注意：不调 endCliStream() —— 切 tab 时让背景流继续往本 tab 的 store 写入；
  // 真正彻底关闭流是在 useTabs.closeTab() 里通过 endCliStreamForTab 进行。
  removeFullscreenFrameBindings();
  window.removeEventListener("resize", fitCanvas);
  window.removeEventListener("keydown", handleShortcut);
  window.removeEventListener("pointerdown", handleWindowPointerDown);
  window.removeEventListener("dragenter", handleWindowAssetDragEnter);
  window.removeEventListener("dragleave", handleWindowAssetDragLeave);
  window.removeEventListener("dragover", handleWindowFileDropGuard);
  window.removeEventListener("drop", handleWindowAssetDrop);
  removeDesktopDragEnterListener?.();
  removeDesktopDragOverListener?.();
  removeDesktopDragLeaveListener?.();
  removeDesktopDragDropListener?.();
  removeMenuActionListener?.();
  stopInteraction();
});
</script>

<template>
  <div class="workbench-shell">
    <div class="workbench-frame">
      <TopBar />

      <main ref="workspaceRef" class="studio-workspace" :style="workspaceStyle">
        <ToolRail />

        <section class="canvas-stack">
          <section class="panel panel-light preview-stage">
            <div class="canvas-backdrop canvas-backdrop-a" aria-hidden="true"></div>
            <div class="canvas-backdrop canvas-backdrop-b" aria-hidden="true"></div>

            <div class="canvas-toolbar">
              <div class="canvas-toolbar-group">
                <button type="button" class="canvas-toolbar-button" @click="zoomOut">-</button>
                <span class="canvas-toolbar-value">{{ viewport.zoomPercent }}%</span>
                <button type="button" class="canvas-toolbar-button" @click="zoomIn">+</button>
              </div>
              <div class="canvas-toolbar-divider" aria-hidden="true"></div>
              <button type="button" class="canvas-toolbar-button" @click="resetZoom">{{ t("canvas.fit") }}</button>
              <button type="button" class="canvas-toolbar-button" @click="openCanvasFullscreen">{{ t("canvas.fullscreenEdit") }}</button>
            </div>

            <div class="preview-stage-body">
              <div ref="frameShell" class="frame-shell" :class="{ 'is-empty': !hasDesign }">
                <div
                  ref="frameViewport"
                  class="frame-viewport"
                  :class="{ 'is-empty': !hasDesign, 'is-dragging': ui.canvasDragging }"
                  @mousedown.prevent="startCanvasPan"
                  @wheel.prevent="handleCanvasWheel"
                >
                  <iframe
                    v-if="hasDesign"
                    :key="frameRevision"
                    ref="designFrame"
                    title="Design Preview"
                    sandbox="allow-same-origin"
                    :srcdoc="renderablePreviewHtml"
                    @load="handleFrameLoad"
                  ></iframe>
                  <div v-if="hasDesign" class="frame-interaction-layer" aria-hidden="true"></div>
                  <div v-else class="frame-placeholder">
                    <div class="placeholder-copy">
                      <strong>{{ t("canvas.emptyTitle1") }}</strong>
                      <p>· {{ t("canvas.emptyHint1a") }}</p>
                      <p>· {{ t("canvas.emptyHint1b") }}</p>
                      <strong>{{ t("canvas.emptyTitle2") }}</strong>
                      <p>· {{ t("canvas.emptyHint2a") }}</p>
                      <p v-if="t('canvas.emptyHint2b')">· {{ t("canvas.emptyHint2b") }}</p>
                      <p>{{ t("canvas.emptyHint2c") }}</p>
                      <p>{{ t("canvas.emptyHint2d") }}</p>
                    </div>
                  </div>
                </div>
                <div v-if="canvasLoadingVisible" class="canvas-loading-overlay" aria-live="polite" aria-busy="true">
                  <div class="canvas-loading-card">
                    <span class="canvas-loading-spinner" aria-hidden="true"></span>
                    <strong>{{ canvasLoadingLabel }}</strong>
                    <p>{{ canvasLoadingDetail }}</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <ComposerPanel />
        </section>

        <div
          v-if="ui.drawerOpen"
          class="drawer-shell"
          :style="drawerShellStyle"
        >
          <button
            v-if="!ui.drawerFloating"
            type="button"
            class="drawer-splitter"
            :aria-label="t('common.resizePanelWidth')"
            @mousedown.prevent="startDrawerResize"
          ></button>

          <aside class="tool-drawer panel panel-light">
            <div class="drawer-head">
              <div>
                <p class="eyebrow">Options Menu</p>
                <h2>{{ activeDrawerTab.label }}</h2>
                <p class="drawer-copy">{{ activeDrawerTab.description }}</p>
              </div>

              <div class="drawer-head-actions">
                <button type="button" class="button button-ghost" @click="closeDrawer">{{ t("common.collapse") }}</button>
              </div>
            </div>

            <div class="tool-drawer-scroll custom-scrollbar">
              <HistoryDrawer v-if="ui.activeDrawer === 'history'" />

              <SetupDrawer v-else-if="ui.activeDrawer === 'setup'" />

              <StylesDrawer v-else-if="ui.activeDrawer === 'styles'" />

              <AssetsDrawer v-else-if="ui.activeDrawer === 'assets'" />

              <InspectDrawer v-else-if="ui.activeDrawer === 'inspect'" />

              <PromptDrawer v-else-if="ui.activeDrawer === 'prompt'" />

              <RuntimeDrawer v-else-if="ui.activeDrawer === 'runtime'" />

              <SettingsDrawer v-else-if="ui.activeDrawer === 'settings'" />

              <AboutDrawer v-else-if="ui.activeDrawer === 'about'" />
            </div>
          </aside>
        </div>
      </main>
    </div>

    <FullscreenEditor v-if="ui.canvasFullscreen" />

    <StylePreviewOverlay v-if="stylePreviewStyle" />
  </div>
</template>
