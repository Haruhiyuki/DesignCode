// 设计配置 — 样式、尺寸、字段定义、prompt 构建、运行时面板数据。
// 负责配置的序列化/签名/持久化调度。
import { computed } from "vue";
import { createCustomSize, defaultSizePresets, findSizePreset } from "../../app/shared/catalog.js";
import { buildEditPrompt, buildGenerationPrompt } from "../../app/shared/prompt-engine.js";
import {
  cloneSnapshot,
  editableTextEntriesFromHtml,
  extractDesignSize,
  formatClock,
  materializeArtAssetUrls,
  normalizeMeta,
} from "../lib/studio-utils.js";
import { updateDesignSession as requestUpdateDesignSession } from "../lib/desktop-api.js";
import { t, locale } from "../i18n/index.js";
import { RAIL_ICONS } from "../constants/icons.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { effectiveActiveTabId } from "./useTabs.js";

const {
  state, ui, viewport, fullscreenEditor,
  findExactById, compactText, setStatus
} = useWorkspaceState();

// ── 常量 ──────────────────────────────────────────────────────────────

const RUNTIME_PROXY_PORT_STORAGE_KEY = "designcode.runtimeProxyPort";
const A4_VIEWPORT_RATIO = 210 / 297;

const EXPORT_QUALITY_OPTIONS = computed(() => [
  { id: "normal", label: t("quality.normal"), scale: 1 },
  { id: "hd", label: t("quality.hd"), scale: 2 },
  { id: "ultra", label: t("quality.ultra"), scale: 3 }
]);

const STYLE_GUIDE_SECTIONS = computed(() => [
  { key: "composition", label: t("guide.composition") },
  { key: "typography", label: t("guide.typography") },
  { key: "color", label: t("guide.color") },
  { key: "texture", label: t("guide.texture") },
  { key: "avoid", label: t("guide.avoid") }
]);

const drawerTabs = computed(() => [
  { id: "history", label: t("drawer.history.label"), icon: RAIL_ICONS.history, description: t("drawer.history.description") },
  { id: "setup", label: t("drawer.setup.label"), icon: RAIL_ICONS.setup, description: t("drawer.setup.description") },
  { id: "styles", label: t("drawer.styles.label"), icon: RAIL_ICONS.styles, description: t("drawer.styles.description") },
  { id: "assets", label: t("drawer.assets.label"), icon: RAIL_ICONS.assets, description: t("drawer.assets.description") },
  { id: "inspect", label: t("drawer.inspect.label"), icon: RAIL_ICONS.inspect, description: t("drawer.inspect.description") },
  { id: "prompt", label: t("drawer.prompt.label"), icon: RAIL_ICONS.prompt, description: t("drawer.prompt.description") },
  { id: "runtime", label: t("drawer.runtime.label"), icon: RAIL_ICONS.runtime, description: t("drawer.runtime.description") },
  { id: "settings", label: t("drawer.settings.tab"), icon: RAIL_ICONS.settings, description: t("drawer.settings.desc") },
  { id: "about", label: t("drawer.about.tab"), icon: RAIL_ICONS.about, description: t("drawer.about.desc") }
]);

const rightPanelTabs = computed(() => [
  { id: "chat", label: t("chat.tabLabel") },
  { id: "logs", label: t("chat.logsTabLabel") }
]);

const RUNTIME_BACKEND_OPTIONS = computed(() => [
  { id: "codex", label: t("runtime.codexSubscription") },
  { id: "claude", label: "Claude Code" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode / API" }
]);

const leftRailTabs = computed(() => drawerTabs.value.filter((tab) => tab.id !== "prompt"));

// ── 样式 / 尺寸 ──────────────────────────────────────────────────────

const styles = computed(() => state.catalog?.styles || []);
const currentStyle = computed(() => findExactById(styles.value, state.styleId));
const stylePreviewStyle = computed(() => findExactById(styles.value, ui.stylePreviewId));

function fontStack(fonts = []) {
  return fonts
    .map((font) => (String(font).includes(" ") ? `"${font}"` : font))
    .join(", ");
}

function buildStyleGuideSections(style) {
  if (!style?.guide) {
    return [];
  }

  return STYLE_GUIDE_SECTIONS.value
    .map((section) => ({
      key: section.key,
      label: section.label,
      items: Array.isArray(style.guide?.[section.key]) ? style.guide[section.key] : []
    }))
    .filter((section) => section.items.length);
}

const stylePreviewGuideSections = computed(() => buildStyleGuideSections(stylePreviewStyle.value));

const currentExportQuality = computed(
  () => EXPORT_QUALITY_OPTIONS.value.find((option) => option.scale === ui.exportScale) || EXPORT_QUALITY_OPTIONS.value[1]
);

const stylePreviewSurfaceStyle = computed(() => {
  const style = stylePreviewStyle.value;
  if (!style) {
    return {};
  }

  return {
    background: `linear-gradient(180deg, ${style.tokens["--bg-primary"]}, ${style.tokens["--bg-secondary"]})`,
    color: style.tokens["--text-primary"],
    borderColor: style.tokens["--border"],
    "--preview-accent": style.tokens["--accent"],
    "--preview-accent-secondary": style.tokens["--accent-secondary"],
    "--preview-display-font": fontStack(style.fonts?.display || []),
    "--preview-body-font": fontStack(style.fonts?.body || []),
    "--preview-accent-font": fontStack(style.fonts?.accent || [])
  };
});

function styleCardSurfaceStyle(style) {
  const tokens = style?.tokens || {};
  const fonts = style?.fonts || {};
  return {
    background: style?.preview || "linear-gradient(135deg, #f3efe7, #ddd3c4)",
    color: tokens["--text-primary"] || "#111111",
    "--preview-accent": tokens["--accent"] || "#f06a3c",
    "--preview-accent-secondary": tokens["--accent-secondary"] || tokens["--accent"] || "#f06a3c",
    "--preview-display-font": (fonts.display || []).join(", ") || "Georgia, serif",
    "--preview-body-font": (fonts.body || []).join(", ") || "system-ui, sans-serif",
    "--preview-accent-font": (fonts.accent || fonts.display || []).join(", ") || "system-ui, sans-serif"
  };
}

const availableSizePresetOptions = computed(() => {
  const options = [];
  const seen = new Set();

  const pushSize = (size) => {
    if (!size?.id || size.id === "custom" || seen.has(size.id)) {
      return;
    }
    seen.add(size.id);
    options.push(size);
  };

  pushSize({
    id: "",
    label: t("setup.sizeNotSet"),
    name: t("setup.sizeNotSet")
  });
  defaultSizePresets.forEach(pushSize);

  return options;
});

const currentSizeMode = computed(() => (state.sizeId === "custom" ? "custom" : "preset"));

const currentSize = computed(() => {
  if (state.sizeId === "custom") {
    return createCustomSize(state.customSize);
  }
  return findExactById(availableSizePresetOptions.value, state.sizeId);
});

const renderedCanvas = computed(() => {
  const direct = extractDesignSize(state.currentHtml);
  if (direct) {
    return {
      width: direct.width,
      height: direct.height,
      label: `${direct.width} × ${direct.height}px`,
      name: `${direct.width} × ${direct.height}`
    };
  }

  if (!state.currentMeta?.sizeId) {
    return null;
  }

  const size = findSizePreset(
    state.currentMeta.sizeId,
    state.currentMeta.customSize || null
  );
  if (!size) {
    return null;
  }

  return {
    ...size,
    label: size.label || `${size.width} × ${size.height}px`,
    name: size.name || size.label || `${size.width} × ${size.height}`
  };
});

// ── 字段 ──────────────────────────────────────────────────────────────

const fieldDefinitions = computed(() => state.fieldDefinitions || []);
const editableTextEntries = computed(() => editableTextEntriesFromHtml(state.currentHtml));

// ── 派生 computed ─────────────────────────────────────────────────────

const fullscreenEditableEntries = computed(() => {
  const sourceHtml = ui.canvasFullscreen ? (fullscreenEditor.draftHtml || state.currentHtml) : state.currentHtml;
  return editableTextEntriesFromHtml(sourceHtml);
});

const fullscreenSelectedEntry = computed(() => {
  return fullscreenEditableEntries.value.find((entry) => entry.id === fullscreenEditor.selectedEntryId) || null;
});

const activeVersion = computed(() => state.versions[state.activeVersionIndex] || null);
const hasDesign = computed(() => Boolean(state.currentHtml));
const hasActiveDesignSession = computed(() => Boolean(state.design.currentId));
const hasPrompt = computed(() => Boolean(state.promptBundle));
const canUndo = computed(() => !state.isBusy && state.activeVersionIndex > 0);
const canExport = computed(() => hasDesign.value && !state.isBusy);
const canExportPsd = computed(() => canExport.value && state.desktop.isDesktop);
const designChatMessages = computed(() => state.design.chat || []);
const currentConversationScopeKey = computed(() => state.design.currentId || "__workspace__");

const conversationHasScopedRuntimeState = computed(() => {
  return state.agent.streamDesignId === currentConversationScopeKey.value;
});

const conversationIsBusy = computed(() => {
  return conversationHasScopedRuntimeState.value && (state.isBusy || state.agent.busy);
});

const liveConversationBlocks = computed(() => {
  if (!conversationHasScopedRuntimeState.value) {
    return [];
  }
  return state.agent.streamBlocks || [];
});

const designLibrary = computed(() => {
  return [...(state.design.items || [])].sort((left, right) => {
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  });
});

const artAssetLibrary = computed(() => state.assets.items || []);

const selectedArtAssets = computed(() => {
  const selected = new Set(state.assets.selectedIds || []);
  return artAssetLibrary.value.filter((item) => selected.has(item.id));
});

const renderablePreviewHtml = computed(() => {
  return materializeArtAssetUrls(
    state.currentHtml,
    artAssetLibrary.value,
    state.assets.previewUrls,
    state.design.workspaceDir || ""
  );
});

const fullscreenRenderablePreviewHtml = computed(() => {
  const html = ui.canvasFullscreen ? (fullscreenEditor.draftHtml || state.currentHtml) : state.currentHtml;
  return materializeArtAssetUrls(
    html,
    artAssetLibrary.value,
    state.assets.previewUrls,
    state.design.workspaceDir || ""
  );
});

const selectedAssetCount = computed(() => selectedArtAssets.value.length);
const latestCommit = computed(() => state.versions[state.versions.length - 1] || null);

const projectTitle = computed(() => {
  if (String(state.design.currentName || "").trim()) {
    return String(state.design.currentName).trim();
  }

  const firstFieldValue = fieldDefinitions.value
    .map((field) => state.fields[field.id])
    .find((value) => String(value || "").trim());
  return (
    state.fields.title ||
    state.fields.headline ||
    state.fields.name ||
    state.fields.recipient ||
    firstFieldValue ||
    "Structured Design Workspace"
  );
});

const headerEditableTitle = computed(() => {
  return String(state.design.currentName || "").trim() || projectTitle.value;
});

// ── 日期 / UI 标签 ───────────────────────────────────────────────────

function formatHistoryDate(value) {
  if (!value) {
    return t("history.dateUnknown");
  }

  return t("history.createdAt", { date: new Date(value).toLocaleDateString(locale.value, {
    year: "numeric",
    month: "long",
    day: "numeric"
  }) });
}

function formatHistoryDateTime(value) {
  if (!value) {
    return t("history.timeUnknown");
  }

  return new Date(value).toLocaleString(locale.value, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const inspectEditableCountLabel = computed(() => {
  return editableTextEntries.value.length ? t("inspect.editableCount", { count: editableTextEntries.value.length }) : t("inspect.noEditable");
});

const fullscreenHasUnsavedChanges = computed(() => {
  if (!ui.canvasFullscreen || !hasDesign.value) {
    return false;
  }

  return (
    (fullscreenEditor.draftHtml || "") !== (fullscreenEditor.baselineHtml || "") ||
    serializeFieldsForSignature(fullscreenEditor.draftFields || {}) !==
      serializeFieldsForSignature(fullscreenEditor.baselineFields || {})
  );
});

const inspectSaveTone = computed(() => {
  if (state.inspect.saveState === "error") {
    return "warning";
  }
  if (state.inspect.saveState === "saving") {
    return "busy";
  }
  if (state.inspect.saveState === "pending") {
    return "idle";
  }
  return "success";
});

const topbarSaveStatus = computed(() => {
  const ds = state.design.saveState;
  const is = state.inspect.saveState;
  if (ds === "saving" || is === "saving") {
    return "saving";
  }
  if (ds === "pending" || is === "pending") {
    return "pending";
  }
  if (ds === "error" || is === "error") {
    return "error";
  }
  if (!hasActiveDesignSession.value) {
    return "idle";
  }
  if (state.isBusy) {
    return "busy";
  }
  return "saved";
});

const inspectSaveLabel = computed(() => {
  if (state.inspect.saveState === "error") {
    return state.inspect.saveError || t("inspect.saveFailed");
  }
  if (state.inspect.saveState === "saving") {
    return t("inspect.saving");
  }
  if (state.inspect.saveState === "pending") {
    return t("inspect.pendingSave");
  }
  if (state.inspect.lastSavedAt) {
    return t("inspect.savedAt", { time: formatClock(state.inspect.lastSavedAt) });
  }
  return t("inspect.autoSaveHint");
});

const newDesignNameExample = computed(() => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `new-${year}-${month}-${day}-01`;
});

// ── Prompt 构建 ───────────────────────────────────────────────────────

function composeWorkspaceSystemPrompt(basePrompt = "") {
  return String(basePrompt || "").trim();
}

function buildPromptBundleForInstruction(instruction = "", mode = null) {
  try {
    const basePayload = {
      styleId: state.styleId,
      sizeId: state.sizeId,
      customSize: state.sizeId === "custom" ? cloneSnapshot(state.customSize) : null,
      fields: cloneSnapshot(state.fields),
      fieldDefinitions: cloneSnapshot(state.fieldDefinitions),
      brief: state.brief,
      selectedArtAssets: selectedArtAssets.value.map((asset) => ({
        id: asset.id,
        name: asset.name,
        absolutePath: asset.absolutePath,
        mimeType: asset.mimeType,
        note: String(state.assets.noteDrafts[asset.id] ?? asset.note ?? "").trim()
      }))
    };

    const normalizedInstruction = String(instruction || "").trim();
    const resolvedMode = mode || (hasDesign.value ? "edit" : "generate");
    if (resolvedMode === "edit") {
      return buildEditPrompt({
        ...basePayload,
        instruction: normalizedInstruction
      });
    }

    return buildGenerationPrompt({
      ...basePayload,
      instruction: normalizedInstruction
    });
  } catch {
    return state.promptBundle || null;
  }
}

const livePromptBundle = computed(() => {
  if (hasDesign.value && !state.composer.trim()) {
    return state.promptBundle || null;
  }

  return buildPromptBundleForInstruction(
    state.composer.trim(),
    hasDesign.value ? "edit" : "generate"
  );
});

const promptPreviewText = computed(() => {
  if (!livePromptBundle.value) {
    return t("status.waitingFirstEvent");
  }

  return [
    "[System Prompt]",
    composeWorkspaceSystemPrompt(livePromptBundle.value.systemPrompt),
    "",
    "[User Message]",
    livePromptBundle.value.userMessage || t("status.waitingUserInput")
  ].join("\n");
});

// ── Runtime 标签 ─────────────────────────────────────────────────────

function runtimeBackendDisplayName(runtimeBackend) {
  switch (runtimeBackend) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "gemini":
      return "Gemini CLI";
    default:
      return "OpenCode";
  }
}

function normalizeGeminiModelValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object") {
    for (const candidate of [
      value.id,
      value.modelId,
      value.model_id,
      value.name,
      value.title,
      value.value
    ]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "";
}

const conversationAgentOutputText = computed(() => {
  if (
    state.agent.output &&
    (!state.agent.outputDesignId || state.agent.outputDesignId === currentConversationScopeKey.value)
  ) {
    return state.agent.output;
  }

  if (activeRuntimeBackend.value !== "opencode") {
    return conversationIsBusy.value
      ? t("status.waitingOutput", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) })
      : t("status.cliOutputPlaceholder");
  }

  return t("status.noCliLogs");
});

const workspaceStateLabel = computed(() => {
  if (state.isBusy) {
    return t("status.processing");
  }

  return hasDesign.value ? t("status.canIterate") : t("status.waitingGeneration");
});

const workspaceHint = computed(() => {
  if (state.isBusy) {
    return t("status.busyHint");
  }

  return hasDesign.value
    ? t("status.iterateHint")
    : t("status.setupHint");
});

const providerLabel = computed(() => {
  return state.desktop.isDesktop ? `Provider · ${state.provider} · desktop` : `Provider · ${state.provider}`;
});

const versionMetaLabel = computed(() => {
  if (!activeVersion.value) {
    return t("history.noVersions");
  }

  return `${activeVersion.value.id} · ${activeVersion.value.label} · ${activeVersion.value.createdAt}`;
});

const successNotice = computed(() => {
  return hasDesign.value
    ? t("history.latestCommitHint")
    : t("history.readyHint");
});

const activeDrawerTab = computed(() => drawerTabs.value.find((item) => item.id === ui.activeDrawer) || drawerTabs.value[0]);

const workspaceStyle = computed(() => ({
  "--drawer-shell-width": ui.drawerOpen ? `${ui.drawerWidth}px` : "0px"
}));

const drawerShellStyle = computed(() => ({
  width: `${ui.drawerWidth}px`,
  "--drawer-shell-width": `${ui.drawerWidth}px`
}));

const runtimeModeLabel = computed(() => (state.desktop.isDesktop ? "Tauri v2" : "Web"));

const nodeRuntimeLabel = computed(() => {
  return state.desktop.nodeAvailable ? state.desktop.nodeVersion || t("runtime.nodeDetected") : t("runtime.nodeNotDetected");
});

const opencodeInstallLabel = computed(() => {
  return state.agent.installed ? state.agent.version || t("runtime.installed") : t("runtime.notInstalled");
});

const codexInstallLabel = computed(() => {
  return state.agent.codexInstalled ? state.agent.codexVersion || t("runtime.installed") : t("runtime.notInstalled");
});

const claudeInstallLabel = computed(() => {
  return state.agent.claudeInstalled ? state.agent.claudeVersion || t("runtime.installed") : t("runtime.notInstalled");
});

const geminiInstallLabel = computed(() => {
  return state.agent.geminiInstalled ? state.agent.geminiVersion || t("runtime.installed") : t("runtime.notInstalled");
});

const opencodeSessionLabel = computed(() => {
  const sessionId = state.design.runtimeSessions.opencode || state.agent.sessionId;
  return sessionId ? sessionId.slice(0, 10) : t("runtime.sessionBound");
});

const codexSessionLabel = computed(() => {
  const threadId = state.design.runtimeSessions.codex || state.agent.codexThreadId;
  return threadId ? threadId.slice(0, 10) : t("runtime.sessionBound");
});

const claudeSessionLabel = computed(() => {
  const sessionId = state.design.runtimeSessions.claude || state.agent.claudeSessionId;
  return sessionId ? sessionId.slice(0, 10) : t("runtime.sessionBound");
});

const geminiSessionLabel = computed(() => {
  const sessionId = state.design.runtimeSessions.gemini || state.agent.geminiSessionId;
  return sessionId ? sessionId.slice(0, 10) : t("runtime.sessionBound");
});

const runtimeDirectory = computed(() => state.design.workspaceDir || state.desktop.projectDir || null);

const activeRuntimeBackend = computed(() => {
  if (!state.desktop.isDesktop) {
    return "opencode";
  }

  return RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === state.agent.backend)
    ? state.agent.backend
    : "codex";
});

const availableProviders = computed(() => state.agent.providers || []);

const providerPickerOptions = computed(() => {
  const connected = new Set(state.agent.connectedProviders || []);
  const selected = state.agent.providerId;

  return [...availableProviders.value].sort((left, right) => {
    const leftRank =
      (left.id === selected ? 0 : 1) +
      (connected.has(left.id) ? 0 : 2) +
      (left.id === "openai" ? -1 : 0);
    const rightRank =
      (right.id === selected ? 0 : 1) +
      (connected.has(right.id) ? 0 : 2) +
      (right.id === "openai" ? -1 : 0);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return String(left.name || left.id).localeCompare(String(right.name || right.id));
  });
});

const apiProviderPickerOptions = computed(() => {
  return providerPickerOptions.value.filter((provider) => provider.id !== "openrouter-browser");
});

const selectedProvider = computed(() => {
  return availableProviders.value.find((item) => item.id === state.agent.providerId) || null;
});

const selectedProviderModels = computed(() => {
  const entries = Object.values(selectedProvider.value?.models || {});
  return entries.sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
});

const opencodeSmallModelOptions = computed(() => {
  const entries = [];
  const seen = new Set();
  const sourceProviders = selectedProvider.value ? [selectedProvider.value] : providerPickerOptions.value;

  sourceProviders.forEach((provider) => {
    Object.entries(provider.models || {}).forEach(([modelKey, modelValue]) => {
      const providerId = String(provider.id || "").trim();
      const modelId = String(modelValue?.id || modelKey || "").trim();
      if (!providerId || !modelId) {
        return;
      }

      const fullId = `${providerId}/${modelId}`;
      if (seen.has(fullId)) {
        return;
      }
      seen.add(fullId);
      entries.push({
        id: fullId,
        name: selectedProvider.value
          ? String(modelValue?.name || modelId)
          : `${provider.name || providerId} / ${modelValue?.name || modelId}`
      });
    });
  });

  entries.sort((left, right) => left.name.localeCompare(right.name));

  const configuredSmallModel = String(state.agent.configSmallModel || "").trim();
  if (configuredSmallModel && !seen.has(configuredSmallModel)) {
    entries.unshift({
      id: configuredSmallModel,
      name: configuredSmallModel
    });
  }

  return [
    { id: "", name: t("runtime.modelDefaultOpencode") },
    ...entries
  ];
});

const codexModelOptions = computed(() => {
  const entries = Array.isArray(state.agent.codexModels) ? [...state.agent.codexModels] : [];
  const known = new Set(entries.map((item) => item.id));

  if (state.agent.codexDefaultModel && !known.has(state.agent.codexDefaultModel)) {
    entries.unshift({
      id: state.agent.codexDefaultModel,
      name: state.agent.codexDefaultModel,
      description: t("runtime.modelCurrentCodex")
    });
  }

  return entries;
});

const selectedCodexModel = computed(() => {
  return codexModelOptions.value.find((item) => item.id === state.agent.codexModelId) || null;
});

const claudeModelOptions = computed(() => {
  const entries = Array.isArray(state.agent.claudeModels) ? [...state.agent.claudeModels] : [];
  const known = new Set(entries.map((item) => item.id));

  if (state.agent.claudeDefaultModel && !known.has(state.agent.claudeDefaultModel)) {
    entries.unshift({
      id: state.agent.claudeDefaultModel,
      name: state.agent.claudeDefaultModel,
      description: t("runtime.modelCurrentClaude")
    });
  }

  return [
    { id: "", name: t("runtime.modelAutoDefault"), description: null },
    ...entries
  ];
});

const claudeEffortOptions = computed(() => {
  const efforts = Array.isArray(state.agent.claudeEfforts) ? [...state.agent.claudeEfforts] : [];
  const known = new Set(efforts);

  if (state.agent.claudeDefaultEffort && !known.has(state.agent.claudeDefaultEffort)) {
    efforts.unshift(state.agent.claudeDefaultEffort);
  }

  return ["", ...efforts];
});

const geminiModelOptions = computed(() => {
  const entries = Array.isArray(state.agent.geminiModels) ? [...state.agent.geminiModels] : [];
  const known = new Set(entries.map((item) => item.id));
  const defaultModel = normalizeGeminiModelValue(state.agent.geminiDefaultModel);

  if (defaultModel && !known.has(defaultModel)) {
    entries.unshift({
      id: defaultModel,
      name: defaultModel,
      description: t("runtime.modelCurrentGemini")
    });
  }

  return [
    { id: "", name: t("runtime.modelAutoDefault"), description: null },
    ...entries
  ];
});

const codexReasoningOptions = computed(() => {
  const levels = Array.isArray(selectedCodexModel.value?.supportedReasoningLevels)
    ? [...selectedCodexModel.value.supportedReasoningLevels]
    : [];
  const known = new Set(levels.map((item) => item.effort));
  const fallback = selectedCodexModel.value?.defaultReasoningLevel
    || state.agent.codexDefaultReasoningEffort
    || state.agent.codexReasoningEffort;

  if (fallback && !known.has(fallback)) {
    levels.unshift({
      effort: fallback,
      description: t("runtime.reasoningEffort")
    });
  }

  return levels;
});

const sandboxDirectoryLabel = computed(() => {
  return runtimeDirectory.value || t("runtime.workspaceNotReady");
});

const activeRuntimeSessionId = computed(() => {
  switch (activeRuntimeBackend.value) {
    case "codex":
      return state.design.runtimeSessions.codex || state.agent.codexThreadId || null;
    case "claude":
      return state.design.runtimeSessions.claude || state.agent.claudeSessionId || null;
    case "gemini":
      return state.design.runtimeSessions.gemini || state.agent.geminiSessionId || null;
    default:
      return state.design.runtimeSessions.opencode || state.agent.sessionId || null;
  }
});

const activeModelLabel = computed(() => {
  if (activeRuntimeBackend.value === "codex") {
    const model = state.agent.codexModelId || state.agent.codexDefaultModel || "";
    const effort = state.agent.codexReasoningEffort || state.agent.codexDefaultReasoningEffort || "";
    if (!model) {
      return t("runtime.notSet");
    }
    return effort ? `${model} · ${effort}` : model;
  }

  if (activeRuntimeBackend.value === "claude") {
    const model = state.agent.claudeModelId || state.agent.claudeDefaultModel || "";
    const effort = state.agent.claudeEffort || state.agent.claudeDefaultEffort || "";
    if (!model) {
      return t("runtime.notSet");
    }
    return effort ? `${model} · ${effort}` : model;
  }

  if (activeRuntimeBackend.value === "gemini") {
    return (
      normalizeGeminiModelValue(state.agent.geminiModelId)
      || normalizeGeminiModelValue(state.agent.geminiDefaultModel)
      || t("runtime.notSet")
    );
  }

  if (state.agent.configModel) {
    return state.agent.configModel;
  }

  if (state.agent.providerId && state.agent.modelId) {
    return `${state.agent.providerId}/${state.agent.modelId}`;
  }

  return t("runtime.notSet");
});

const providerConnectionLabel = computed(() => {
  if (activeRuntimeBackend.value === "codex") {
    if (state.agent.codexVerified) {
      return t("runtime.verified");
    }

    return state.agent.codexLoggedIn ? t("runtime.codexLocalLogin") : t("runtime.notLoggedIn");
  }

  if (activeRuntimeBackend.value === "claude") {
    if (state.agent.claudeVerified) {
      return t("runtime.verified");
    }

    return state.agent.claudeLoggedIn ? t("runtime.claudeLocalLogin") : t("runtime.notLoggedIn");
  }

  if (activeRuntimeBackend.value === "gemini") {
    if (state.agent.geminiVerified) {
      return t("runtime.verified");
    }

    return state.agent.geminiLoggedIn ? t("runtime.geminiAuthDetected") : t("runtime.geminiPendingVerify");
  }

  if (!state.agent.connectedProviders.length) {
    return t("runtime.notConnected");
  }

  if (state.agent.connectedProviders.includes(state.agent.providerId)) {
    return t("runtime.connected");
  }

  return t("runtime.connectedCount", { count: state.agent.connectedProviders.length });
});

const agentOptions = computed(() => {
  const items = state.agent.agents.length ? state.agent.agents : ["build"];
  return [...new Set(items)];
});

const appliedProxyLabel = computed(() => {
  return state.agent.appliedProxyPort ? `127.0.0.1:${state.agent.appliedProxyPort}` : t("runtime.proxyNotSet");
});

const currentRuntimeSessionLabel = computed(() => {
  switch (activeRuntimeBackend.value) {
    case "codex":
      return codexSessionLabel.value;
    case "claude":
      return claudeSessionLabel.value;
    case "gemini":
      return geminiSessionLabel.value;
    default:
      return opencodeSessionLabel.value;
  }
});

const runtimeAgentEnabled = computed(() => {
  if (!state.desktop.isDesktop || state.agent.busy) {
    return false;
  }

  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexInstalled && state.agent.codexLoggedIn;
  }

  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeInstalled && state.agent.claudeLoggedIn;
  }

  if (activeRuntimeBackend.value === "gemini") {
    return state.agent.geminiInstalled;
  }

  return state.agent.running;
});

const runtimeShellEnabled = computed(() => {
  if (!state.desktop.isDesktop || state.agent.busy) {
    return false;
  }

  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexInstalled && state.agent.codexLoggedIn;
  }

  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeInstalled && state.agent.claudeLoggedIn;
  }

  if (activeRuntimeBackend.value === "gemini") {
    return state.agent.geminiInstalled;
  }

  return state.agent.running;
});

const renderedCanvasLabel = computed(() => {
  if (renderedCanvas.value) {
    return `${renderedCanvas.value.width} × ${renderedCanvas.value.height}px`;
  }

  return hasDesign.value ? t("canvas.missingSize") : t("canvas.notGenerated");
});

const promptSizeLabel = computed(() => currentSize.value?.label || t("setup.sizeNotSet"));

const consoleStatusLabel = computed(() => compactWorkbenchStatus(state.statusTone, state.statusCategory));

const canvasLoadingVisible = computed(() => {
  if (state.design.createBusy) {
    return true;
  }
  if (hasDesign.value) {
    return false;
  }
  const category = state.statusCategory;
  return (state.isBusy || state.statusTone === "busy") && (category === "generate" || category === "edit" || category === "load");
});

const canvasLoadingLabel = computed(() => {
  if (state.design.createBusy) {
    return t("status.creatingDesign");
  }
  if (state.statusCategory === "load") {
    return t("status.loadingText");
  }
  return t("status.generating");
});

const canvasLoadingDetail = computed(() => {
  if (state.design.createBusy) {
    return t("status.loadingDetail");
  }
  if (state.statusCategory === "load") {
    return t("status.loadingDetail");
  }
  return t("status.generatingDetail");
});

const headerSizeLabel = computed(() => {
  if (currentSize.value?.label) {
    return currentSize.value.label;
  }

  if (renderedCanvas.value) {
    return renderedCanvasLabel.value;
  }

  return t("setup.sizeNotSet");
});

const conversationPrimaryLabel = computed(() => (hasDesign.value ? t("chat.submitEdit") : t("chat.startDesign")));
const conversationPrimaryBusyLabel = computed(() => (hasDesign.value ? t("chat.submitting") : t("chat.designing")));

const agentOutputText = computed(() => {
  if (!state.desktop.isDesktop) {
    return t("runtime.webModeHint");
  }

  if (activeRuntimeBackend.value === "codex") {
    if (!state.agent.codexInstalled) {
      return t("runtime.codexNotDetected");
    }

    if (!state.agent.codexLoggedIn) {
      return [
        `Node: ${state.desktop.nodeVersion || "unknown"}`,
        `Codex: ${state.agent.codexVersion || "installed"}`,
        `Workspace: ${state.desktop.projectDir || "unknown"}`,
        "",
        t("runtime.codexLoginFirst")
      ].join("\n");
    }

    return state.agent.output || t("runtime.codexReady");
  }

  if (activeRuntimeBackend.value === "claude") {
    if (!state.agent.claudeInstalled) {
      return t("runtime.claudeNotDetected");
    }

    if (!state.agent.claudeLoggedIn) {
      return [
        `Node: ${state.desktop.nodeVersion || "unknown"}`,
        `Claude Code: ${state.agent.claudeVersion || "installed"}`,
        `Workspace: ${state.desktop.projectDir || "unknown"}`,
        "",
        t("runtime.claudeLoginFirst")
      ].join("\n");
    }

    return state.agent.output || t("runtime.claudeReady");
  }

  if (activeRuntimeBackend.value === "gemini") {
    if (!state.agent.geminiInstalled) {
      return t("runtime.geminiNotDetected");
    }

    return state.agent.output || t("runtime.geminiReady");
  }

  if (!state.agent.installed) {
    return t("runtime.opencodeNotDetected");
  }

  if (!state.agent.running) {
    return [
      `Node: ${state.desktop.nodeVersion || "unknown"}`,
      `OpenCode: ${state.agent.version || "installed"}`,
      `Workspace: ${state.desktop.projectDir || "unknown"}`,
      "",
      t("runtime.opencodeStartHint")
    ].join("\n");
  }

  return state.agent.output || t("runtime.opencodeRunning");
});

const designHistoryHint = computed(() => {
  if (!hasActiveDesignSession.value) {
    return t("history.noSessionHint");
  }

  return state.design.browsingHistory
    ? t("history.browsingHint")
    : t("history.latestHint");
});

const authResultText = computed(() => {
  if (state.agent.authResult) {
    return state.agent.authResult;
  }

  if (activeRuntimeBackend.value === "codex") {
    return [
      state.agent.codexLoginStatus || t("runtime.auth.codexStatusDefault"),
      state.agent.codexVerificationMessage
        ? t("runtime.auth.codexVerifyResult", { message: state.agent.codexVerificationMessage })
        : t("runtime.auth.codexVerifyHint")
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (activeRuntimeBackend.value === "claude") {
    return [
      state.agent.claudeLoginStatus || t("runtime.auth.claudeStatusDefault"),
      state.agent.claudeVerificationMessage
        ? t("runtime.auth.claudeVerifyResult", { message: state.agent.claudeVerificationMessage })
        : t("runtime.auth.claudeVerifyHint")
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (activeRuntimeBackend.value === "gemini") {
    return [
      state.agent.geminiLoginStatus || t("runtime.auth.geminiStatusDefault"),
      state.agent.geminiVerificationMessage
        ? t("runtime.auth.geminiVerifyResult", { message: state.agent.geminiVerificationMessage })
        : t("runtime.auth.geminiVerifyHint")
    ]
      .filter(Boolean)
      .join("\n");
  }

  return t("runtime.auth.opencodeHint");
});

// ── compactWorkbenchStatus ───────────────────────────────────────────

function compactWorkbenchStatus(tone = "idle", category = "") {
  const compactLabels = {
    error: {
      timeout: "status.compact.timeout",
      _default: "status.compact.failed"
    },
    warning: {
      login: "status.compact.pendingLogin",
      input: "status.compact.pendingInput",
      timeout: "status.compact.timeout",
      _default: "status.compact.attention"
    },
    busy: {
      load: "status.compact.loading",
      generate: "status.compact.generating",
      edit: "status.compact.editing",
      verify: "status.compact.verifying",
      login: "status.compact.loggingIn",
      start: "status.compact.starting",
      save: "status.compact.saving",
      export: "status.compact.processing",
      create: "status.compact.processing",
      _default: "status.compact.processing"
    },
    success: {
      export: "status.compact.exported",
      save: "status.compact.saved",
      generate: "status.compact.generated",
      edit: "status.compact.updated",
      update: "status.compact.updated",
      verify: "status.compact.verified",
      start: "status.compact.started",
      connect: "status.compact.connected",
      create: "status.compact.created",
      load: "status.compact.loaded",
      _default: "status.compact.done"
    },
    idle: {
      stop: "status.compact.stopped",
      load: "status.compact.loaded",
      _default: "status.compact.ready"
    }
  };

  const group = compactLabels[tone] || compactLabels.idle;
  const key = (category && group[category]) || group._default;
  return t(key);
}

// ── syncActiveRuntimeSession ─────────────────────────────────────────

function syncActiveRuntimeSession() {
  const designScoped = Boolean(state.design.currentId);

  const runtimeBackend = activeRuntimeBackend.value;
  const sessionId = designScoped
    ? state.design.runtimeSessions[runtimeBackend] || null
    : state.design.runtimeSessions[runtimeBackend] ||
      (runtimeBackend === "codex"
        ? state.agent.codexThreadId
        : runtimeBackend === "claude"
          ? state.agent.claudeSessionId
          : runtimeBackend === "gemini"
            ? state.agent.geminiSessionId
            : state.agent.sessionId) ||
      null;

  if (runtimeBackend === "codex") {
    state.agent.codexThreadId = sessionId;
  } else if (runtimeBackend === "claude") {
    state.agent.claudeSessionId = sessionId;
  } else if (runtimeBackend === "gemini") {
    state.agent.geminiSessionId = sessionId;
  } else {
    state.agent.sessionId = sessionId;
  }

  state.design.sessionId = sessionId;
}

// ── 配置持久化 ────────────────────────────────────────────────────────

// 每个 tab 各自的保存状态——旧实现用 5 个模块级 let 变量，导致切 tab 时
// 新 tab 的 signature 和其他 tab 保存下来的 baseline 不匹配，永远触发一次
// 空转的 pending→saving→saved（右上角转圈）；且一个 tab 的 save timer 会
// 被另一个 tab 的切换清掉。这里改成按 tabId 索引的 Map。
const tabSaveEntries = new Map();
function getTabSaveEntry(tabId) {
  let entry = tabSaveEntries.get(tabId);
  if (!entry) {
    entry = {
      hydrating: false,
      savedSignature: "",
      saveTimer: null,
      savePromise: null,
      saveRerun: false,
    };
    tabSaveEntries.set(tabId, entry);
  }
  return entry;
}
function currentTabSaveEntry() {
  // 用 effectiveActiveTabId 以尊重 withTabContext 的 override。
  const tabId = effectiveActiveTabId() || "__default__";
  return getTabSaveEntry(tabId);
}

function buildDesignConfigPayload(extra = {}) {
  const fallbackDesignName = state.design.currentId || projectTitle.value || "Untitled Design";
  return {
    designId: state.design.currentId,
    designName: compactText(state.design.currentName, fallbackDesignName),
    runtimeBackend: activeRuntimeBackend.value,
    styleId: state.styleId,
    sizeId: state.sizeId,
    customSize: state.sizeId === "custom" ? cloneSnapshot(state.customSize) : null,
    fields: cloneSnapshot(state.fields),
    fieldDefinitions: cloneSnapshot(state.fieldDefinitions),
    brief: state.brief,
    selectedAssetIds: [...state.assets.selectedIds],
    ...extra
  };
}

function serializeSignaturePart(value) {
  return String(value ?? "").replace(/\u0000/g, "");
}

function serializeFieldsForSignature(fields = {}) {
  return Object.keys(fields || {})
    .sort()
    .map((key) => `${serializeSignaturePart(key)}\u001f${serializeSignaturePart(fields[key])}`)
    .join("\u001e");
}

function serializeFieldDefinitionsForSignature(definitions = []) {
  return (definitions || [])
    .map((field) => {
      return [
        field.id,
        field.label,
        field.placeholder,
        field.required ? "1" : "0",
        field.custom === false ? "0" : "1"
      ]
        .map(serializeSignaturePart)
        .join("\u001f");
    })
    .join("\u001e");
}

function serializeCustomSizeForSignature(sizeId, customSize) {
  if (sizeId !== "custom" || !customSize) {
    return "";
  }

  return [
    customSize.name,
    customSize.width,
    customSize.height,
    customSize.unit
  ]
    .map(serializeSignaturePart)
    .join("\u001d");
}

function serializeDesignConfigPayload(payload = {}) {
  return [
    payload.designId,
    payload.designName,
    payload.runtimeBackend,
    payload.styleId,
    payload.sizeId,
    serializeCustomSizeForSignature(payload.sizeId, payload.customSize),
    serializeFieldsForSignature(payload.fields || {}),
    serializeFieldDefinitionsForSignature(payload.fieldDefinitions || []),
    payload.brief,
    ...(payload.selectedAssetIds || []).map(serializeSignaturePart)
  ]
    .map(serializeSignaturePart)
    .join("\u0001");
}

function currentDesignConfigSignature() {
  if (!state.design.currentId) {
    return "";
  }

  return serializeDesignConfigPayload({
    designId: state.design.currentId,
    designName: compactText(
      state.design.currentName,
      state.design.currentId || projectTitle.value || "Untitled Design"
    ),
    runtimeBackend: activeRuntimeBackend.value,
    styleId: state.styleId,
    sizeId: state.sizeId,
    customSize: state.sizeId === "custom" ? state.customSize : null,
    fields: state.fields,
    fieldDefinitions: state.fieldDefinitions,
    brief: state.brief,
    selectedAssetIds: state.assets.selectedIds
  });
}

function clearDesignConfigSaveTimer() {
  const save = currentTabSaveEntry();
  if (!save.saveTimer) {
    return;
  }
  window.clearTimeout(save.saveTimer);
  save.saveTimer = null;
}

function setDesignConfigSaveBaseline(updatedAt = "") {
  clearDesignConfigSaveTimer();
  currentTabSaveEntry().savedSignature = currentDesignConfigSignature();
  state.design.saveError = "";
  state.design.lastSavedAt = updatedAt || state.design.lastSavedAt || "";
  state.design.saveState = state.design.currentId ? "saved" : "idle";
}

function upsertDesignLibraryItem(design, previousId = null) {
  if (!design?.id) {
    return;
  }

  const next = [...state.design.items].filter((item) => {
    return !(previousId && previousId !== design.id && item.id === previousId);
  });
  const index = next.findIndex((item) => item.id === design.id);
  const merged = {
    ...(index >= 0 ? next[index] : {}),
    ...design
  };

  if (index >= 0) {
    next[index] = merged;
  } else {
    next.push(merged);
  }

  next.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  state.design.items = next;
}

function shouldApplyPersistResult(targetDesignId, nextDesignId = targetDesignId) {
  if (!state.design.currentId) {
    return false;
  }

  return state.design.currentId === targetDesignId || state.design.currentId === nextDesignId;
}

async function saveDesignConfigPayload(payload, options = {}) {
  const background = Boolean(options.background);
  const targetDesignId = payload?.designId || state.design.currentId;
  if (!targetDesignId) {
    return true;
  }

  try {
    const previousDesignId = targetDesignId;
    const record = await requestUpdateDesignSession(payload);
    upsertDesignLibraryItem(record.design, previousDesignId);

    const shouldApply = shouldApplyPersistResult(targetDesignId, record.design?.id);
    if (shouldApply && record.design?.id) {
      state.design.currentId = record.design.id;
      state.design.currentName = record.design?.title || state.design.currentName;
      state.design.runtimeSessions = {
        opencode: record.design.runtimeSessions?.opencode || record.design.sessionId || state.design.runtimeSessions.opencode,
        codex: record.design.runtimeSessions?.codex || state.design.runtimeSessions.codex,
        claude: record.design.runtimeSessions?.claude || state.design.runtimeSessions.claude,
        gemini: record.design.runtimeSessions?.gemini || state.design.runtimeSessions.gemini
      };
      state.design.workspaceDir = record.design?.workspaceDir || state.design.workspaceDir;
      state.agent.sessionId = state.design.runtimeSessions.opencode || state.agent.sessionId;
      state.agent.codexThreadId = state.design.runtimeSessions.codex || state.agent.codexThreadId;
      state.agent.claudeSessionId = state.design.runtimeSessions.claude || state.agent.claudeSessionId;
      state.agent.geminiSessionId = state.design.runtimeSessions.gemini || state.agent.geminiSessionId;
      state.currentMeta = normalizeMeta(record.meta || state.currentMeta);
      state.warnings = record.warnings || state.warnings;
      state.assets.selectedIds = Array.isArray(record.design?.selectedAssetIds)
        ? [...record.design.selectedAssetIds]
        : state.assets.selectedIds;
      syncActiveRuntimeSession();
      setDesignConfigSaveBaseline(record.design?.updatedAt || "");
    }

    return true;
  } catch (error) {
    if (!background) {
      state.design.saveState = "error";
      state.design.saveError = error instanceof Error ? error.message : String(error);
      setStatus(t("status.designConfigSaveFailed"), "error", "save");
    }
    // 动态导入避免 useSetupConfig ↔ useCliStream 的循环依赖。
    import("./useCliStream.js")
      .then((mod) => mod.useCliStream().logSessionError("design-config-save", error, { background }))
      .catch(() => {});
    return false;
  }
}

async function persistCurrentDesignConfig(force = false, options = {}) {
  const save = currentTabSaveEntry();
  const payload = options.payload || buildDesignConfigPayload();
  const background = Boolean(options.background);

  if (!payload.designId || save.hydrating) {
    return true;
  }

  const signature = options.payload
    ? serializeDesignConfigPayload(payload)
    : currentDesignConfigSignature();
  if (!signature) {
    return true;
  }

  if (!force && signature === save.savedSignature) {
    return true;
  }

  if (save.savePromise) {
    save.saveRerun = true;
    if (!force) {
      if (!background) {
        state.design.saveState = "pending";
      }
      return true;
    }
    await save.savePromise;
    const refreshedSignature = options.payload
      ? signature
      : currentDesignConfigSignature();
    if (!refreshedSignature || refreshedSignature === save.savedSignature) {
      return true;
    }
  }

  if (options.payload) {
    return saveDesignConfigPayload(payload, options);
  }

  clearDesignConfigSaveTimer();
  if (!background) {
    state.design.saveState = "saving";
    state.design.saveError = "";
  }

  const run = saveDesignConfigPayload(payload, options);

  save.savePromise = run;
  const result = await run;
  save.savePromise = null;

  if (save.saveRerun) {
    save.saveRerun = false;
    const rerunSignature = currentDesignConfigSignature();
    if (rerunSignature && rerunSignature !== save.savedSignature) {
      return persistCurrentDesignConfig(force);
    }
  }

  return result;
}

function scheduleCurrentDesignConfigSave() {
  const save = currentTabSaveEntry();
  if (!state.design.currentId || save.hydrating) {
    return;
  }

  const signature = currentDesignConfigSignature();
  if (!signature || signature === save.savedSignature) {
    return;
  }

  clearDesignConfigSaveTimer();
  state.design.saveState = "pending";
  save.saveTimer = window.setTimeout(() => {
    persistCurrentDesignConfig(false).catch(() => {});
  }, 450);
}

async function flushCurrentDesignConfig() {
  clearDesignConfigSaveTimer();
  const save = currentTabSaveEntry();
  if (!state.design.currentId || save.hydrating) {
    return true;
  }

  const signature = currentDesignConfigSignature();
  if (!signature || signature === save.savedSignature) {
    return true;
  }

  return persistCurrentDesignConfig(true);
}

// ── 字段模板函数 ──────────────────────────────────────────────────────

function makeDefaultCustomSize() {
  const firstSize = defaultSizePresets[0];
  return {
    name: t("setup.customSizeName"),
    width: Math.round(firstSize?.width || 1080),
    height: Math.round(firstSize?.height || 1440),
    unit: "px"
  };
}

function templateFieldDefinitions(incomingFields = {}, incomingDefinitions = []) {
  if (Array.isArray(incomingDefinitions) && incomingDefinitions.length) {
    const normalized = incomingDefinitions.map((field) => ({
      id: field.id,
      label: field.label || field.id,
      required: Boolean(field.required),
      placeholder: field.placeholder || "",
      custom: field.custom !== false
    }));
    const seen = new Set(normalized.map((field) => field.id));
    Object.keys(incomingFields || {}).forEach((id) => {
      if (!seen.has(id)) {
        normalized.push({
          id,
          label: id,
          required: false,
          placeholder: "",
          custom: true
        });
      }
    });
    return normalized;
  }

  const extraFields = Object.keys(incomingFields || {})
    .map((id) => ({
      id,
      label: id,
      required: false,
      placeholder: "",
      custom: true
    }));

  return extraFields;
}

function templateFieldDefaults(incomingFields = {}, incomingDefinitions = []) {
  const definitions = templateFieldDefinitions(incomingFields, incomingDefinitions);
  return Object.fromEntries(
    definitions.map((slot) => [slot.id, incomingFields[slot.id] ?? slot.placeholder ?? ""])
  );
}

// ── designConfigHydrating 访问器 ─────────────────────────────────────

function getDesignConfigHydrating() {
  return currentTabSaveEntry().hydrating;
}

function setDesignConfigHydrating(value) {
  currentTabSaveEntry().hydrating = value;
}

function getDesignConfigSavedSignature() {
  return currentTabSaveEntry().savedSignature;
}

// ── 导出 ──────────────────────────────────────────────────────────────

export function useSetupConfig() {
  return {
    // 常量
    RUNTIME_PROXY_PORT_STORAGE_KEY,
    A4_VIEWPORT_RATIO,
    EXPORT_QUALITY_OPTIONS,
    STYLE_GUIDE_SECTIONS,
    drawerTabs,
    rightPanelTabs,
    RUNTIME_BACKEND_OPTIONS,
    leftRailTabs,

    // 样式 / 尺寸
    styles,
    currentStyle,
    stylePreviewStyle,
    fontStack,
    buildStyleGuideSections,
    stylePreviewGuideSections,
    currentExportQuality,
    stylePreviewSurfaceStyle,
    styleCardSurfaceStyle,
    availableSizePresetOptions,
    currentSizeMode,
    currentSize,
    renderedCanvas,

    // 字段
    fieldDefinitions,
    editableTextEntries,

    // 派生 computed
    fullscreenEditableEntries,
    fullscreenSelectedEntry,
    activeVersion,
    hasDesign,
    hasActiveDesignSession,
    hasPrompt,
    canUndo,
    canExport,
    canExportPsd,
    designChatMessages,
    currentConversationScopeKey,
    conversationHasScopedRuntimeState,
    conversationIsBusy,
    liveConversationBlocks,
    designLibrary,
    artAssetLibrary,
    selectedArtAssets,
    renderablePreviewHtml,
    fullscreenRenderablePreviewHtml,
    selectedAssetCount,
    latestCommit,
    projectTitle,
    headerEditableTitle,

    // 日期 / UI 标签
    formatHistoryDate,
    formatHistoryDateTime,
    inspectEditableCountLabel,
    fullscreenHasUnsavedChanges,
    inspectSaveTone,
    topbarSaveStatus,
    inspectSaveLabel,
    newDesignNameExample,

    // Prompt 构建
    composeWorkspaceSystemPrompt,
    buildPromptBundleForInstruction,
    livePromptBundle,
    promptPreviewText,

    // Runtime 标签
    runtimeBackendDisplayName,
    normalizeGeminiModelValue,
    conversationAgentOutputText,
    workspaceStateLabel,
    workspaceHint,
    providerLabel,
    versionMetaLabel,
    successNotice,
    activeDrawerTab,
    workspaceStyle,
    drawerShellStyle,
    runtimeModeLabel,
    nodeRuntimeLabel,
    opencodeInstallLabel,
    codexInstallLabel,
    claudeInstallLabel,
    geminiInstallLabel,
    opencodeSessionLabel,
    codexSessionLabel,
    claudeSessionLabel,
    geminiSessionLabel,
    runtimeDirectory,
    activeRuntimeBackend,
    availableProviders,
    providerPickerOptions,
    apiProviderPickerOptions,
    selectedProvider,
    selectedProviderModels,
    opencodeSmallModelOptions,
    codexModelOptions,
    selectedCodexModel,
    claudeModelOptions,
    claudeEffortOptions,
    geminiModelOptions,
    codexReasoningOptions,
    sandboxDirectoryLabel,
    activeRuntimeSessionId,
    activeModelLabel,
    providerConnectionLabel,
    agentOptions,
    appliedProxyLabel,
    currentRuntimeSessionLabel,
    runtimeAgentEnabled,
    runtimeShellEnabled,
    renderedCanvasLabel,
    promptSizeLabel,
    consoleStatusLabel,
    canvasLoadingVisible,
    canvasLoadingLabel,
    canvasLoadingDetail,
    headerSizeLabel,
    conversationPrimaryLabel,
    conversationPrimaryBusyLabel,
    agentOutputText,
    designHistoryHint,
    authResultText,

    // compactWorkbenchStatus
    compactWorkbenchStatus,

    // syncActiveRuntimeSession
    syncActiveRuntimeSession,

    // 配置持久化
    buildDesignConfigPayload,
    serializeSignaturePart,
    serializeFieldsForSignature,
    serializeFieldDefinitionsForSignature,
    serializeCustomSizeForSignature,
    serializeDesignConfigPayload,
    currentDesignConfigSignature,
    clearDesignConfigSaveTimer,
    setDesignConfigSaveBaseline,
    upsertDesignLibraryItem,
    shouldApplyPersistResult,
    saveDesignConfigPayload,
    persistCurrentDesignConfig,
    scheduleCurrentDesignConfigSave,
    flushCurrentDesignConfig,

    // 字段模板函数
    makeDefaultCustomSize,
    templateFieldDefinitions,
    templateFieldDefaults,

    // designConfigHydrating 访问器
    getDesignConfigHydrating,
    setDesignConfigHydrating,
    getDesignConfigSavedSignature,
  };
}
