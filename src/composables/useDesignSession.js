// 设计会话 — 创建/打开/删除设计、版本管理、HTML 编辑、生成/编辑触发。
// 依赖 useSetupConfig 提供的配置和 useRuntimeAgent 提供的后端连接。
import { nextTick } from "vue";
import {
  createDesignSession as requestCreateDesignSession,
  deleteDesignSession as requestDeleteDesignSession,
  generateDesign as requestGenerateDesign,
  editDesign as requestEditDesign,
  listOpencodeMessages,
  listDesignSessions,
  openDesignSession,
  readDesignCommit,
  syncDesignWorkspace as syncDesignWorkspaceSnapshot,
  updateDesignHtml as requestUpdateDesignHtml,
} from "../lib/desktop-api.js";
import {
  cloneSnapshot,
  normalizeMeta,
  patchEditableTextInHtml,
} from "../lib/studio-utils.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useConfirmDialog } from "./useConfirmDialog.js";
import { useConversation } from "./useConversation.js";
import { useTabs, withTabContext, effectiveActiveTabId } from "./useTabs.js";

// ---------------------------------------------------------------------------
// 模块级单例 — 从其他 composable 获取依赖
// ---------------------------------------------------------------------------

const {
  state, ui,
  headerTitleInputRef, compactText,
  setStatus, setBusy, runInBackground, queueBackgroundWorkspaceTask,
} = useWorkspaceState();

const {
  RUNTIME_BACKEND_OPTIONS,
  hasDesign,
  currentConversationScopeKey,
  buildDesignConfigPayload, setDesignConfigSaveBaseline,
  flushCurrentDesignConfig,
  persistCurrentDesignConfig,
  designLibrary, upsertDesignLibraryItem,
  headerEditableTitle,
  makeDefaultCustomSize,
  editableTextEntries,
  setDesignConfigHydrating,
  getDesignConfigSavedSignature,
  serializeDesignConfigPayload,
  clearDesignConfigSaveTimer,
  shouldApplyPersistResult,
  syncActiveRuntimeSession,
  activeRuntimeBackend, activeRuntimeSessionId,
  runtimeDirectory,
  runtimeBackendDisplayName,
  normalizeGeminiModelValue,
  activeModelLabel,
  buildPromptBundleForInstruction,
  latestCommit,
  newDesignNameExample,
} = useSetupConfig();

const { requestConfirmation } = useConfirmDialog();

const {
  appendOptimisticUserConversation, finalizeOptimisticConversationEntry,
  rollbackOptimisticConversationEntry, appendLocalAssistantConversation,
  buildOpencodeBlocksFromMessages,
} = useConversation();

// ---------------------------------------------------------------------------
// 延迟注入依赖 — 来自 App.vue 中尚未拆分的函数
// ---------------------------------------------------------------------------

let _resetZoom = null;
let _hydrateFromMeta = null;
let _normalizedGeminiBinary = null;
let _nextCodexStreamId = null;
let _beginCliStream = null;
let _endCliStream = null;
let _appendAgentOutputLine = null;
let _markConversationRuntimeScope = null;
let _rebindConversationRuntimeScope = null;
let _serializeConversationBlocksForStorage = null;
let _runtimeLoginReminder = null;
let _ensureRuntimeWarmup = null;
let _ensureDesignAgentSession = null;
let _scheduleRuntimeWarmups = null;
let _refreshDesktopIntegration = null;
let _persistPendingAssetNotes = null;
let _sanitizeAgentConsoleMessage = null;

function setDeps(deps) {
  if (deps.resetZoom) _resetZoom = deps.resetZoom;
  if (deps.hydrateFromMeta) _hydrateFromMeta = deps.hydrateFromMeta;
  if (deps.normalizedGeminiBinary) _normalizedGeminiBinary = deps.normalizedGeminiBinary;
  if (deps.nextCodexStreamId) _nextCodexStreamId = deps.nextCodexStreamId;
  if (deps.beginCliStream) _beginCliStream = deps.beginCliStream;
  if (deps.endCliStream) _endCliStream = deps.endCliStream;
  if (deps.appendAgentOutputLine) _appendAgentOutputLine = deps.appendAgentOutputLine;
  if (deps.markConversationRuntimeScope) _markConversationRuntimeScope = deps.markConversationRuntimeScope;
  if (deps.rebindConversationRuntimeScope) _rebindConversationRuntimeScope = deps.rebindConversationRuntimeScope;
  if (deps.serializeConversationBlocksForStorage) _serializeConversationBlocksForStorage = deps.serializeConversationBlocksForStorage;
  if (deps.runtimeLoginReminder) _runtimeLoginReminder = deps.runtimeLoginReminder;
  if (deps.ensureRuntimeWarmup) _ensureRuntimeWarmup = deps.ensureRuntimeWarmup;
  if (deps.ensureDesignAgentSession) _ensureDesignAgentSession = deps.ensureDesignAgentSession;
  if (deps.scheduleRuntimeWarmups) _scheduleRuntimeWarmups = deps.scheduleRuntimeWarmups;
  if (deps.refreshDesktopIntegration) _refreshDesktopIntegration = deps.refreshDesktopIntegration;
  if (deps.persistPendingAssetNotes) _persistPendingAssetNotes = deps.persistPendingAssetNotes;
  if (deps.sanitizeAgentConsoleMessage) _sanitizeAgentConsoleMessage = deps.sanitizeAgentConsoleMessage;
}

// ---------------------------------------------------------------------------
// 可编辑 HTML 持久化 — 每个 tab 独立的保存状态
// ---------------------------------------------------------------------------
// 旧实现用 4 个模块级 let 变量，切 tab 时会互相干扰（基线不匹配触发空转保存、
// 一个 tab 的 save timer 被另一个 tab 的切换清掉）。按 tabId 索引的 Map。
const tabEditableHtmlEntries = new Map();
function currentTabEditableEntry() {
  const tabId = effectiveActiveTabId() || "__default__";
  let entry = tabEditableHtmlEntries.get(tabId);
  if (!entry) {
    entry = {
      saveTimer: null,
      savedSignature: "",
      savePromise: null,
      saveRerun: false,
    };
    tabEditableHtmlEntries.set(tabId, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// 标题编辑 — 私有变量
// ---------------------------------------------------------------------------

let headerTitleDraft = "";

// ---------------------------------------------------------------------------
// 辅助函数 — assetFallbackLabel / sanitizeDesignName
// ---------------------------------------------------------------------------

function assetFallbackLabel(asset) {
  const name = String(asset?.name || "").trim();
  if (name) {
    return name.slice(0, 1).toUpperCase();
  }
  const ext = String(asset?.fileName || "").split(".").pop();
  return (ext || "A").slice(0, 1).toUpperCase();
}

function sanitizeDesignName(value) {
  return compactText(value, "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// 标题编辑
// ---------------------------------------------------------------------------

function openHeaderTitleEditor() {
  if (!state.design.currentId) {
    return;
  }

  headerTitleDraft = headerEditableTitle.value;
  ui.headerTitleEditing = true;
  nextTick(() => {
    headerTitleInputRef.value?.focus();
    headerTitleInputRef.value?.select?.();
  });
}

async function commitHeaderTitleEdit() {
  if (!ui.headerTitleEditing) {
    return;
  }

  const normalized = sanitizeDesignName(headerTitleDraft) || state.design.currentId || headerEditableTitle.value;
  ui.headerTitleEditing = false;
  headerTitleDraft = "";

  if (!normalized || normalized === state.design.currentName) {
    return;
  }

  state.design.currentName = normalized;
  await flushCurrentDesignConfig();
}

function cancelHeaderTitleEdit() {
  ui.headerTitleEditing = false;
  headerTitleDraft = "";
}

function handleHeaderTitleInput(event) {
  headerTitleDraft = event.target.value;
}

async function handleHeaderTitleKeydown(event) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    await commitHeaderTitleEdit();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelHeaderTitleEdit();
  }
}

// ---------------------------------------------------------------------------
// 版本管理
// ---------------------------------------------------------------------------

function syncVersionsFromCommits(commits, activeCommitHash = null) {
  state.design.commits = commits || [];
  state.versions = (commits || []).map((commit, index) => ({
    id: commit.id || `v${index + 1}`,
    label: commit.label || commit.message || "render",
    createdAt: commit.createdAt || "",
    commitHash: commit.commitHash || commit.hash || null
  }));

  if (!state.versions.length) {
    state.activeVersionIndex = -1;
    state.design.activeCommitHash = null;
    state.design.browsingHistory = false;
    return;
  }

  const targetHash = activeCommitHash || state.versions[state.versions.length - 1].commitHash;
  const index = state.versions.findIndex((version) => version.commitHash === targetHash);
  state.activeVersionIndex = index >= 0 ? index : state.versions.length - 1;
  state.design.activeCommitHash = state.versions[state.activeVersionIndex]?.commitHash || null;
  state.design.browsingHistory =
    state.design.activeCommitHash !== state.versions[state.versions.length - 1]?.commitHash;
}

async function restoreVersion(index) {
  const snapshot = state.versions[index];
  if (!snapshot) {
    return;
  }

  if (!snapshot.commitHash || !state.design.currentId) {
    return;
  }

  queuePendingWorkspaceStatePersistence();

  const record = await readDesignCommit(state.design.currentId, snapshot.commitHash);
  setDesignConfigHydrating(true);
  try {
    state.activeVersionIndex = index;
    state.design.activeCommitHash = snapshot.commitHash;
    state.design.browsingHistory = snapshot.commitHash !== latestCommit.value?.commitHash;
    state.currentHtml = record.html;
    state.currentMeta = normalizeMeta(record.meta || record.design?.currentMeta || state.currentMeta);
    state.design.chat = record.chat || state.design.chat;
    state.assets.selectedIds = Array.isArray(record.design?.selectedAssetIds)
      ? [...record.design.selectedAssetIds]
      : state.assets.selectedIds;
    if (RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === record.design?.runtimeBackend)) {
      state.agent.backend = record.design.runtimeBackend;
    }
    if (record.design?.title) {
      state.design.currentName = record.design.title;
    }
    state.design.runtimeSessions = {
      opencode: record.design?.runtimeSessions?.opencode || record.design?.sessionId || state.design.runtimeSessions.opencode,
      codex: record.design?.runtimeSessions?.codex || state.design.runtimeSessions.codex,
      claude: record.design?.runtimeSessions?.claude || state.design.runtimeSessions.claude,
      gemini: record.design?.runtimeSessions?.gemini || state.design.runtimeSessions.gemini
    };
    syncActiveRuntimeSession();
    _hydrateFromMeta(state.currentMeta);
  } finally {
    setDesignConfigHydrating(false);
  }
  setEditableHtmlBaseline(record.html || "", record.design?.updatedAt || "");
  setDesignConfigSaveBaseline(record.design?.updatedAt || "");
  setStatus(t("status.restored", { id: snapshot.id }), "idle");
}

// ---------------------------------------------------------------------------
// 可编辑 HTML 持久化 — 内部辅助
// ---------------------------------------------------------------------------

function clearEditableHtmlSaveTimer() {
  const entry = currentTabEditableEntry();
  if (!entry.saveTimer) {
    return;
  }
  window.clearTimeout(entry.saveTimer);
  entry.saveTimer = null;
}

function buildEditableHtmlPayload(options = {}) {
  const fields = cloneSnapshot(options.fields ?? state.fields);
  return {
    ...buildDesignConfigPayload({
      fields
    }),
    html: options.html ?? state.currentHtml,
    meta: cloneSnapshot(options.meta ?? state.currentMeta),
    entryLabel: options.entryLabel ?? state.inspect.lastEntryLabel ?? "editable text",
    summary: options.summary ?? `Inspect panel updated ${compactText(state.inspect.lastEntryLabel || "editable text")}.`,
    logSummary: options.logSummary ?? ""
  };
}

function applyEditableHtmlResult(result) {
  if (result.html) {
    state.currentHtml = result.html;
  }
  state.currentMeta = normalizeMeta(result.meta || result.design?.currentMeta || state.currentMeta);
  state.promptBundle = result.promptBundle || state.promptBundle;
  state.warnings = result.warnings || [];
  if (result.design) {
    state.design.currentId = result.design.id || state.design.currentId;
    state.design.currentName = result.design.title || state.design.currentName;
    if (RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === result.design.runtimeBackend)) {
      state.agent.backend = result.design.runtimeBackend;
    }
    state.design.runtimeSessions = {
      opencode: result.design.runtimeSessions?.opencode || result.design.sessionId || state.design.runtimeSessions.opencode,
      codex: result.design.runtimeSessions?.codex || state.design.runtimeSessions.codex,
      claude: result.design.runtimeSessions?.claude || state.design.runtimeSessions.claude,
      gemini: result.design.runtimeSessions?.gemini || state.design.runtimeSessions.gemini
    };
    state.design.workspaceDir = result.design.workspaceDir || state.design.workspaceDir;
    state.assets.selectedIds = Array.isArray(result.design.selectedAssetIds)
      ? [...result.design.selectedAssetIds]
      : state.assets.selectedIds;
    upsertDesignLibraryItem(result.design);
  }
  if (Array.isArray(result.chat)) {
    state.design.chat = result.chat;
    state.agent.streamBlocks = [];
  }
  syncVersionsFromCommits(result.commits || [], result.commits?.[result.commits.length - 1]?.commitHash);
  syncActiveRuntimeSession();
}

async function saveEditableHtmlPayload(payload, options = {}) {
  const background = Boolean(options.background);
  const targetDesignId = payload?.designId || state.design.currentId;
  if (!targetDesignId || !payload?.html) {
    return true;
  }

  try {
    const result = await requestUpdateDesignHtml(payload);
    const shouldApply = shouldApplyPersistResult(targetDesignId, result.design?.id);
    if (shouldApply) {
      applyEditableHtmlResult(result);
      setEditableHtmlBaseline(result.html || state.currentHtml, result.design?.updatedAt || "");
      setDesignConfigSaveBaseline(result.design?.updatedAt || "");
      if (!background && payload.logSummary) {
        _appendAgentOutputLine(`[local] ${_sanitizeAgentConsoleMessage(payload.logSummary)}`);
      }
    } else if (result.design) {
      upsertDesignLibraryItem(result.design, targetDesignId);
    }
    return true;
  } catch (error) {
    if (!background) {
      state.inspect.saveState = "error";
      state.inspect.saveError = error instanceof Error ? error.message : String(error);
      setStatus(t("status.inspectSaveFailed"), "error", "save");
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 可编辑 HTML 持久化 — 公开函数
// ---------------------------------------------------------------------------

function setEditableHtmlBaseline(html = state.currentHtml, updatedAt = "") {
  clearEditableHtmlSaveTimer();
  currentTabEditableEntry().savedSignature = html || "";
  state.inspect.saveError = "";
  state.inspect.lastSavedAt = updatedAt || state.inspect.lastSavedAt || "";
  state.inspect.saveState = state.design.currentId ? "saved" : "idle";
}

function syncEditableTextDrafts(entries = editableTextEntries.value) {
  const nextDrafts = {};
  entries.forEach((entry) => {
    nextDrafts[entry.id] = state.inspect.drafts[entry.id] ?? entry.value;
  });
  state.inspect.drafts = nextDrafts;
}

async function persistEditableHtmlChanges(force = false, options = {}) {
  const entry = currentTabEditableEntry();
  const payload = options.payload || buildEditableHtmlPayload();
  const background = Boolean(options.background);

  if (!payload.designId || !payload.html) {
    return true;
  }

  const signature = payload.html;
  if (!force && signature === entry.savedSignature) {
    return true;
  }

  if (options.payload) {
    if (entry.savePromise) {
      await entry.savePromise;
    }
    return saveEditableHtmlPayload(payload, options);
  }

  if (entry.savePromise) {
    entry.saveRerun = true;
    if (!force) {
      if (!background) {
        state.inspect.saveState = "pending";
      }
      return true;
    }
    await entry.savePromise;
    if (state.currentHtml === entry.savedSignature) {
      return true;
    }
  }

  clearEditableHtmlSaveTimer();
  if (!background) {
    state.inspect.saveState = "saving";
    state.inspect.saveError = "";
  }

  const run = saveEditableHtmlPayload(payload, options);

  entry.savePromise = run;
  const result = await run;
  entry.savePromise = null;

  if (entry.saveRerun) {
    entry.saveRerun = false;
    if (state.currentHtml !== entry.savedSignature) {
      return persistEditableHtmlChanges(force);
    }
  }

  return result;
}

function scheduleEditableHtmlSave() {
  if (!state.design.currentId || !state.currentHtml) {
    return;
  }

  const entry = currentTabEditableEntry();
  if (state.currentHtml === entry.savedSignature) {
    return;
  }

  clearEditableHtmlSaveTimer();
  state.inspect.saveState = "pending";
  entry.saveTimer = window.setTimeout(() => {
    persistEditableHtmlChanges(false).catch(() => {});
  }, 900);
}

async function flushEditableHtmlChanges() {
  clearEditableHtmlSaveTimer();
  if (!state.design.currentId || !state.currentHtml) {
    return true;
  }

  const entry = currentTabEditableEntry();
  if (state.currentHtml === entry.savedSignature) {
    return true;
  }

  return persistEditableHtmlChanges(true);
}

function updateEditableTextEntry(entry, value, options = {}) {
  if (!entry?.path || !state.currentHtml) {
    return;
  }

  const nextHtml = patchEditableTextInHtml(state.currentHtml, entry, value);
  if (!nextHtml || nextHtml === state.currentHtml) {
    state.inspect.drafts[entry.id] = value;
    return;
  }

  state.inspect.drafts[entry.id] = value;
  state.inspect.lastEntryLabel = entry.label || entry.fieldId || entry.tagName || "editable text";
  state.currentHtml = nextHtml;

  if (entry.fieldId) {
    state.fields[entry.fieldId] = value;
  }

  if (state.currentMeta?.fields && entry.fieldId) {
    state.currentMeta = normalizeMeta({
      ...state.currentMeta,
      fields: {
        ...(state.currentMeta.fields || {}),
        [entry.fieldId]: value
      }
    });
  }

  if (options.autoSave === false) {
    state.inspect.saveState = "pending";
    return;
  }

  scheduleEditableHtmlSave();
}

// ---------------------------------------------------------------------------
// 设计会话 CRUD
// ---------------------------------------------------------------------------

function resetDesignConfiguration() {
  state.styleId = "";
  state.sizeId = "";
  state.customSize = makeDefaultCustomSize();
  state.fieldDefinitions = [];
  state.fields = {};
  state.brief = "";
}

function clearCurrentDesignWorkspace() {
  const previousScopeKey = currentConversationScopeKey.value;
  setDesignConfigHydrating(true);
  try {
    state.design.currentId = null;
    state.design.currentName = "";
    state.design.runtimeSessions = {
      opencode: null,
      codex: null,
      claude: null,
      gemini: null
    };
    state.design.workspaceDir = null;
    state.design.chat = [];
    syncVersionsFromCommits([], null);
    state.currentHtml = "";
    state.currentMeta = normalizeMeta(null);
    state.promptBundle = null;
    state.warnings = [];
    state.assets.selectedIds = [];
    state.agent.sessionId = null;
    state.agent.codexThreadId = null;
    state.agent.claudeSessionId = null;
    state.agent.geminiSessionId = null;
    resetDesignConfiguration();
    syncActiveRuntimeSession();
  } finally {
    setDesignConfigHydrating(false);
  }

  _rebindConversationRuntimeScope(previousScopeKey, currentConversationScopeKey.value);
  setEditableHtmlBaseline("", "");
  setDesignConfigSaveBaseline("");
}

function applyOpenedDesignRecord(record, options = {}) {
  const design = record.design || {};
  const previousScopeKey = currentConversationScopeKey.value;
  setDesignConfigHydrating(true);
  try {
    state.design.currentId = design.id || state.design.currentId;
    state.design.currentName = design.title || design.id || "";
    state.agent.backend = RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === design.runtimeBackend)
      ? design.runtimeBackend
      : state.agent.backend;
    state.design.runtimeSessions = {
      opencode: design.runtimeSessions?.opencode || design.sessionId || null,
      codex: design.runtimeSessions?.codex || null,
      claude: design.runtimeSessions?.claude || null,
      gemini: design.runtimeSessions?.gemini || null
    };
    state.design.workspaceDir = design.workspaceDir || null;
    state.agent.sessionId = state.design.runtimeSessions.opencode || null;
    state.agent.codexThreadId = state.design.runtimeSessions.codex || null;
    state.agent.claudeSessionId = state.design.runtimeSessions.claude || null;
    state.agent.geminiSessionId = state.design.runtimeSessions.gemini || null;
    state.design.chat = record.chat || [];
    state.agent.streamBlocks = [];
    syncVersionsFromCommits(record.commits || [], options.activeCommitHash);

    state.currentHtml = record.html || "";
    state.currentMeta = normalizeMeta(record.meta || design.currentMeta || state.currentMeta);
    state.promptBundle = record.promptBundle ?? design.promptBundle ?? null;
    state.provider = design.provider || state.provider;
    state.warnings = record.warnings || design.warnings || [];
    state.assets.selectedIds = Array.isArray(design.selectedAssetIds)
      ? [...design.selectedAssetIds]
      : [];

    resetDesignConfiguration();
    _hydrateFromMeta(state.currentMeta);
    syncActiveRuntimeSession();
  } finally {
    setDesignConfigHydrating(false);
  }
  _rebindConversationRuntimeScope(previousScopeKey, currentConversationScopeKey.value);

  upsertDesignLibraryItem({
    ...design,
    updatedAt: design.updatedAt || new Date().toISOString()
  });
  state.design.createBusy = false;
  state.design.createError = "";
  setEditableHtmlBaseline(record.html || "", design.updatedAt || "");
  setDesignConfigSaveBaseline(design.updatedAt || "");
  _scheduleRuntimeWarmups();
}

async function refreshDesignLibrary() {
  const items = await listDesignSessions();
  state.design.items = items;
  return items;
}

async function openDesignRecord(designId) {
  if (!designId) {
    return;
  }

  queuePendingWorkspaceStatePersistence();

  const record = await openDesignSession(designId);
  applyOpenedDesignRecord(record);
  setStatus(t("status.designLoaded", { id: designId }), "idle");
  runInBackground(async () => {
    await Promise.allSettled([
      refreshDesignLibrary(),
      _refreshDesktopIntegration({ skipSessionMessages: true })
    ]);
  });
}

async function deleteDesignRecord(designId) {
  const target = designLibrary.value.find((item) => item.id === designId);
  if (!target) {
    return;
  }

  const confirmed = await requestConfirmation({
    title: t("confirm.deleteDesignTitle"),
    message: t("confirm.deleteDesignMessage", { name: target.title || target.id }),
    confirmLabel: t("confirm.deleteDesignConfirm")
  });
  if (!confirmed) {
    return;
  }

  if (state.design.currentId === designId) {
    clearEditableHtmlSaveTimer();
    clearDesignConfigSaveTimer();
  }

  const remaining = designLibrary.value.filter((item) => item.id !== designId);

  try {
    await requestDeleteDesignSession(designId);
    state.design.items = remaining;

    if (state.design.currentId === designId) {
      clearCurrentDesignWorkspace();
      if (remaining.length) {
        const record = await openDesignSession(remaining[0].id);
        applyOpenedDesignRecord(record);
      }
    }

    setStatus(t("status.designDeleted"), "success", "save");
    runInBackground(async () => {
      await Promise.allSettled([
        refreshDesignLibrary(),
        _refreshDesktopIntegration({ skipSessionMessages: true })
      ]);
    });
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.designDeleteFailed"), "error", "save");
  }
}

async function startNewDesignSession() {
  if (state.design.createBusy) {
    return;
  }

  queuePendingWorkspaceStatePersistence();

  state.design.createBusy = true;
  state.design.createError = "";
  ui.activeDrawer = "history";
  ui.drawerOpen = true;
  setStatus(t("status.creatingDesign"), "idle", "create");

  try {
    const record = await requestCreateDesignSession(
      buildDesignConfigPayload({
        designId: null,
        designName: null,
        designDirectory: null,
        styleId: "",
        sizeId: "",
        customSize: null,
        fields: {},
        fieldDefinitions: [],
        brief: "",
        selectedAssetIds: [],
        sessionId: null
      })
    );
    applyOpenedDesignRecord(record);
    _resetZoom();
    setStatus(t("status.designCreated", { id: record.design?.id || newDesignNameExample.value }), "success");
    runInBackground(async () => {
      await Promise.allSettled([
        refreshDesignLibrary(),
        _refreshDesktopIntegration({ skipSessionMessages: true })
      ]);
    });
  } catch (error) {
    state.design.createError = error instanceof Error ? error.message : String(error);
    setStatus(t("status.designCreateFailed"), "error", "create");
  } finally {
    state.design.createBusy = false;
  }
}

// ---------------------------------------------------------------------------
// 待持久化的工作区状态（搬移辅助函数 — 与 editable HTML 紧耦合）
// ---------------------------------------------------------------------------

function queuePendingWorkspaceStatePersistence() {
  const htmlDirty = Boolean(state.design.currentId && state.currentHtml && state.currentHtml !== editableHtmlSavedSignature);
  const configPayload = buildDesignConfigPayload();
  const configDirty = Boolean(
    configPayload.designId &&
    serializeDesignConfigPayload(configPayload) !== getDesignConfigSavedSignature()
  );

  clearEditableHtmlSaveTimer();
  clearDesignConfigSaveTimer();

  if (!htmlDirty && !configDirty) {
    return;
  }

  const htmlPayload = htmlDirty ? buildEditableHtmlPayload() : null;
  const detachedConfigPayload = !htmlDirty && configDirty ? configPayload : null;

  queueBackgroundWorkspaceTask(async () => {
    if (htmlPayload) {
      await persistEditableHtmlChanges(true, {
        payload: htmlPayload,
        background: true
      });
      return;
    }

    if (detachedConfigPayload) {
      await persistCurrentDesignConfig(true, {
        payload: detachedConfigPayload,
        background: true
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 设计生成/编辑核心流程
// ---------------------------------------------------------------------------

function buildPayload(extra = {}) {
  const runtimeBackend = activeRuntimeBackend.value;
  const runtimeModel = runtimeBackend === "codex"
    ? state.agent.codexModelId || state.agent.codexDefaultModel || null
    : runtimeBackend === "claude"
      ? state.agent.claudeModelId || state.agent.claudeDefaultModel || null
      : runtimeBackend === "gemini"
        ? normalizeGeminiModelValue(state.agent.geminiModelId)
          || normalizeGeminiModelValue(state.agent.geminiDefaultModel)
          || null
        : state.agent.configModel || null;
  const runtimeBinary = runtimeBackend === "codex"
    ? (state.agent.codexBinary.trim() || "codex")
    : runtimeBackend === "claude"
      ? (state.agent.claudeBinary.trim() || "claude")
      : runtimeBackend === "gemini"
        ? _normalizedGeminiBinary()
        : null;

  return {
    ...buildDesignConfigPayload(),
    sessionId: activeRuntimeSessionId.value,
    runtimeModel,
    runtimeReasoningEffort: runtimeBackend === "codex"
      ? state.agent.codexReasoningEffort || state.agent.codexDefaultReasoningEffort || null
      : runtimeBackend === "claude"
        ? state.agent.claudeEffort || state.agent.claudeDefaultEffort || null
        : null,
    runtimeBinary,
    codexBinary: runtimeBackend === "codex" ? runtimeBinary : null,
    runtimeProxy: state.agent.proxy || null,
    ...extra
  };
}

async function recoverOpencodeConversationBlocks(result) {
  if (!state.desktop.isDesktop || activeRuntimeBackend.value !== "opencode") {
    return [];
  }

  const sessionId =
    result?.design?.runtimeSessions?.opencode
    || result?.design?.sessionId
    || activeRuntimeSessionId.value;

  if (!sessionId) {
    return [];
  }

  try {
    const messages = await listOpencodeMessages(sessionId, runtimeDirectory.value);
    return buildOpencodeBlocksFromMessages(messages);
  } catch {
    return [];
  }
}

function hydrateAssistantBlocksIntoChat(chat, blocks = []) {
  if (!Array.isArray(chat) || !blocks.length) {
    return chat;
  }

  const assistantIndex = [...chat].findLastIndex((message) => message?.role === "assistant");
  if (assistantIndex === -1) {
    return chat;
  }

  const target = chat[assistantIndex];
  if (Array.isArray(target?.blocks) && target.blocks.length) {
    return chat;
  }

  const nextChat = [...chat];
  nextChat[assistantIndex] = {
    ...target,
    blocks: cloneSnapshot(blocks)
  };
  return nextChat;
}

function applyDesignResult(result, label, options = {}) {
  const { preserveStreamBlocks = false, assistantBlocks = [] } = options;
  const previousScopeKey = currentConversationScopeKey.value;
  state.currentHtml = result.html;
  state.currentMeta = normalizeMeta(result.meta || result.design?.currentMeta || state.currentMeta);
  _hydrateFromMeta(state.currentMeta);
  state.provider = result.provider || state.provider;
  state.promptBundle = result.promptBundle || state.promptBundle;
  state.warnings = result.warnings || [];
  _resetZoom();
  if (result.design) {
    state.design.currentId = result.design.id || state.design.currentId;
    state.design.currentName = result.design.title || state.design.currentName;
    if (RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === result.design.runtimeBackend)) {
      state.agent.backend = result.design.runtimeBackend;
    }
    state.design.runtimeSessions = {
      opencode: result.design.runtimeSessions?.opencode || result.design.sessionId || state.design.runtimeSessions.opencode,
      codex: result.design.runtimeSessions?.codex || state.design.runtimeSessions.codex,
      claude: result.design.runtimeSessions?.claude || state.design.runtimeSessions.claude,
      gemini: result.design.runtimeSessions?.gemini || state.design.runtimeSessions.gemini
    };
    state.design.workspaceDir = result.design.workspaceDir || state.design.workspaceDir;
    state.assets.selectedIds = Array.isArray(result.design.selectedAssetIds)
      ? [...result.design.selectedAssetIds]
      : state.assets.selectedIds;
    upsertDesignLibraryItem(result.design);
  }
  if (Array.isArray(result.chat)) {
    state.design.chat = hydrateAssistantBlocksIntoChat(result.chat, assistantBlocks);
    if (!preserveStreamBlocks) {
      state.agent.streamBlocks = [];
    }
  }
  syncVersionsFromCommits(result.commits || [], result.commits?.[result.commits.length - 1]?.commitHash);
  syncActiveRuntimeSession();
  _rebindConversationRuntimeScope(previousScopeKey, currentConversationScopeKey.value);
  setEditableHtmlBaseline(result.html || "", result.design?.updatedAt || "");
  setDesignConfigSaveBaseline(result.design?.updatedAt || "");
}

async function generateDesign() {
  // 捕获发起本次生成的 tab。后续所有 sync 状态写入都通过 withTabContext(origin)
  // 路由回这个 tab 的 store——用户即使在 await 期间切到别的 tab，生成结果也
  // 一定回写到原 tab，不会污染当前激活的 tab。
  const origin = useTabs().activeTabId.value;
  const scoped = (fn) => withTabContext(origin, fn);

  const instruction = state.composer.trim();
  const previousComposer = state.composer;
  const runtimePromptBundle = buildPromptBundleForInstruction(instruction, "generate");
  let optimisticEntryId = null;
  if (!instruction) {
    setStatus(t("status.enterFirstRequirement"), "warning", "input");
    return;
  }
  ui.rightPanelTab = "chat";
  _markConversationRuntimeScope();
  const instructionCreatedAt = new Date().toISOString();
  optimisticEntryId = appendOptimisticUserConversation(instruction);
  if (state.desktop.isDesktop && activeRuntimeBackend.value !== "opencode") {
    const loginReminder = _runtimeLoginReminder();
    if (loginReminder) {
      finalizeOptimisticConversationEntry(optimisticEntryId);
      appendLocalAssistantConversation(loginReminder);
      setStatus(t("status.completeRuntimeLogin"), "warning", "login");
      return;
    }
  }
  state.composer = "";
  setBusy(true, t("status.submittingGeneration"));
  let streamId = null;

  try {
    const flushed = await flushEditableHtmlChanges();
    if (!flushed) {
      scoped(() => {
        rollbackOptimisticConversationEntry(optimisticEntryId);
        state.composer = previousComposer;
      });
      return;
    }
    await _persistPendingAssetNotes();
    const desktopBackend = scoped(() => {
      if (!state.desktop.isDesktop) return null;
      setStatus(t("status.waitingWarmup", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "busy");
      return activeRuntimeBackend.value;
    });
    if (desktopBackend) {
      await _ensureRuntimeWarmup(desktopBackend);
      streamId = _nextCodexStreamId();
      await scoped(() => _beginCliStream(streamId, desktopBackend, [
        instruction,
        runtimePromptBundle?.userMessage || ""
      ]));
      scoped(() => {
        _appendAgentOutputLine(
          `[${desktopBackend}] Generating design with ${activeModelLabel.value || "default model"}...`
        );
      });
    }
    const result = await requestGenerateDesign(
      buildPayload({
        instruction,
        streamId,
        instructionCreatedAt
      })
    );
    scoped(() => {
      if (streamId) {
        _endCliStream();
        _appendAgentOutputLine("");
        _appendAgentOutputLine(t("status.firstDraftSynced"));
      }
    });
    const assistantCreatedAt = new Date().toISOString();
    const recoveredBlocks = scoped(() => !state.agent.streamBlocks.length)
      ? await recoverOpencodeConversationBlocks(result)
      : [];
    const savedStreamBlocks = scoped(() => {
      if (recoveredBlocks.length) {
        state.agent.streamBlocks = recoveredBlocks;
      }
      const saved = _serializeConversationBlocksForStorage([...state.agent.streamBlocks]);
      applyDesignResult(result, "生成", {
        assistantBlocks: saved
      });
      state.composer = "";
      setStatus(t("status.firstDraftGenerated"), "success", "generate");
      return saved;
    });
    const currentDesignId = scoped(() => state.design.currentId);
    if (savedStreamBlocks.length && currentDesignId) {
      const savedStreamBlocksSignature = JSON.stringify(savedStreamBlocks);
      runInBackground(() => syncDesignWorkspaceSnapshot({
        ...scoped(() => buildPayload({ designId: currentDesignId })),
        assistantBlocks: savedStreamBlocks,
        instructionCreatedAt,
        assistantCreatedAt
      }).then((synced) => {
        scoped(() => {
          if (synced?.chat) {
            state.design.chat = synced.chat;
          }
          const currentStreamBlocksSignature = JSON.stringify(
            _serializeConversationBlocksForStorage([...state.agent.streamBlocks])
          );
          if (currentStreamBlocksSignature === savedStreamBlocksSignature) {
            state.agent.streamBlocks = [];
          }
        });
      }).catch(() => {}));
    }
    runInBackground(async () => {
      await Promise.allSettled([
        refreshDesignLibrary(),
        _ensureDesignAgentSession(),
        _refreshDesktopIntegration({ skipSessionMessages: true })
      ]);
    });
  } catch (error) {
    scoped(() => {
      if (streamId) {
        _endCliStream();
      }
      rollbackOptimisticConversationEntry(optimisticEntryId);
      state.composer = previousComposer;
      state.warnings = [error instanceof Error ? error.message : String(error)];
      setStatus(t("status.generationFailed"), "error", "generate");
    });
  } finally {
    scoped(() => setBusy(false));
  }
}

async function editDesign() {
  const origin = useTabs().activeTabId.value;
  const scoped = (fn) => withTabContext(origin, fn);

  const instruction = state.composer.trim();
  const previousComposer = state.composer;
  const runtimePromptBundle = buildPromptBundleForInstruction(instruction, "edit");
  let optimisticEntryId = null;
  if (!instruction) {
    setStatus(hasDesign.value ? t("status.enterEditInstruction") : t("status.enterFirstRequirement"), "warning", "edit");
    return;
  }

  if (!state.currentHtml) {
    await generateDesign();
    return;
  }

  ui.rightPanelTab = "chat";
  _markConversationRuntimeScope();
  const instructionCreatedAt = new Date().toISOString();
  optimisticEntryId = appendOptimisticUserConversation(instruction);
  if (state.desktop.isDesktop && activeRuntimeBackend.value !== "opencode") {
    const loginReminder = _runtimeLoginReminder();
    if (loginReminder) {
      finalizeOptimisticConversationEntry(optimisticEntryId);
      appendLocalAssistantConversation(loginReminder);
      setStatus(t("status.completeRuntimeLogin"), "warning", "login");
      return;
    }
  }
  state.composer = "";
  setBusy(true, t("status.submittingEdit"));
  let streamId = null;

  try {
    const flushed = await flushEditableHtmlChanges();
    if (!flushed) {
      scoped(() => {
        rollbackOptimisticConversationEntry(optimisticEntryId);
        state.composer = previousComposer;
      });
      return;
    }
    await _persistPendingAssetNotes();
    const desktopBackend = scoped(() => {
      if (!state.desktop.isDesktop) return null;
      setStatus(t("status.waitingWarmup", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "busy");
      return activeRuntimeBackend.value;
    });
    if (desktopBackend) {
      await _ensureRuntimeWarmup(desktopBackend);
      streamId = _nextCodexStreamId();
      await scoped(() => _beginCliStream(streamId, desktopBackend, [
        instruction,
        runtimePromptBundle?.userMessage || ""
      ]));
      scoped(() => {
        _appendAgentOutputLine(
          `[${desktopBackend}] Updating design with ${activeModelLabel.value || "default model"}...`
        );
      });
    }
    const currentHtmlSnapshot = scoped(() => state.currentHtml);
    const result = await requestEditDesign(buildPayload({
      currentHtml: currentHtmlSnapshot,
      instruction,
      streamId,
      instructionCreatedAt
    }));
    scoped(() => {
      if (streamId) {
        _endCliStream();
        _appendAgentOutputLine("");
        _appendAgentOutputLine(t("status.editSynced"));
      }
    });
    const assistantCreatedAt = new Date().toISOString();
    const recoveredBlocks = scoped(() => !state.agent.streamBlocks.length)
      ? await recoverOpencodeConversationBlocks(result)
      : [];
    const savedStreamBlocks = scoped(() => {
      if (recoveredBlocks.length) {
        state.agent.streamBlocks = recoveredBlocks;
      }
      const saved = _serializeConversationBlocksForStorage([...state.agent.streamBlocks]);
      applyDesignResult(result, "编辑", {
        assistantBlocks: saved
      });
      state.composer = "";
      setStatus(t("status.editComplete"), "success", "edit");
      return saved;
    });
    const currentDesignId = scoped(() => state.design.currentId);
    if (savedStreamBlocks.length && currentDesignId) {
      const savedStreamBlocksSignature = JSON.stringify(savedStreamBlocks);
      runInBackground(() => syncDesignWorkspaceSnapshot({
        ...scoped(() => buildPayload({ designId: currentDesignId })),
        assistantBlocks: savedStreamBlocks,
        instructionCreatedAt,
        assistantCreatedAt
      }).then((synced) => {
        scoped(() => {
          if (synced?.chat) {
            state.design.chat = synced.chat;
          }
          const currentStreamBlocksSignature = JSON.stringify(
            _serializeConversationBlocksForStorage([...state.agent.streamBlocks])
          );
          if (currentStreamBlocksSignature === savedStreamBlocksSignature) {
            state.agent.streamBlocks = [];
          }
        });
      }).catch(() => {}));
    }
    runInBackground(async () => {
      await Promise.allSettled([
        refreshDesignLibrary(),
        _ensureDesignAgentSession(),
        _refreshDesktopIntegration({ skipSessionMessages: true })
      ]);
    });
  } catch (error) {
    scoped(() => {
      if (streamId) {
        _endCliStream();
      }
      rollbackOptimisticConversationEntry(optimisticEntryId);
      state.composer = previousComposer;
      state.warnings = [error instanceof Error ? error.message : String(error)];
      setStatus(t("status.editFailed"), "error", "edit");
    });
  } finally {
    scoped(() => setBusy(false));
  }
}

// ---------------------------------------------------------------------------
// 提交对话
// ---------------------------------------------------------------------------

function submitConversation() {
  if (hasDesign.value) {
    return editDesign();
  }

  return generateDesign();
}

function handleComposerKeydown(event) {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  event.preventDefault();
  submitConversation();
}

// ---------------------------------------------------------------------------
// 样式/尺寸操作
// ---------------------------------------------------------------------------

function selectStyle(styleId) {
  state.styleId = styleId;
}

function openStylePreview(styleId) {
  ui.stylePreviewId = styleId;
}

function closeStylePreview() {
  ui.stylePreviewId = "";
}

function setSizePreset(sizeId) {
  state.sizeId = sizeId;
  if (!sizeId) {
    return;
  }
  if (sizeId === "custom" && (!state.customSize.width || !state.customSize.height)) {
    state.customSize = makeDefaultCustomSize();
  }
}

function setSizeMode(mode) {
  if (mode === "custom") {
    if (state.sizeId !== "custom") {
      state.sizeId = "custom";
    }
    if (!state.customSize.width || !state.customSize.height) {
      state.customSize = makeDefaultCustomSize();
    }
    return;
  }

  if (state.sizeId === "custom") {
    state.sizeId = "";
  }
}

function addCustomField() {
  const id = `field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  state.fieldDefinitions = [
    ...state.fieldDefinitions,
    {
      id,
      label: t("setup.newField"),
      required: false,
      placeholder: "",
      custom: true
    }
  ];
  state.fields = {
    ...state.fields,
    [id]: ""
  };
}

function removeField(fieldId) {
  state.fieldDefinitions = state.fieldDefinitions.filter((field) => field.id !== fieldId);
  const nextFields = { ...state.fields };
  delete nextFields[fieldId];
  state.fields = nextFields;

  if (state.currentMeta?.fields) {
    const nextMetaFields = { ...(state.currentMeta.fields || {}) };
    delete nextMetaFields[fieldId];
    state.currentMeta = normalizeMeta({
      ...state.currentMeta,
      fields: nextMetaFields,
      fieldDefinitions: cloneSnapshot(state.fieldDefinitions)
    });
  }
}

function fillBrief(text) {
  state.brief = text;
}

function fillComposer(text) {
  state.composer = text;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function useDesignSession() {
  return {
    // 依赖注入
    setDeps,

    // 辅助
    assetFallbackLabel,
    sanitizeDesignName,

    // 标题编辑
    openHeaderTitleEditor,
    commitHeaderTitleEdit,
    cancelHeaderTitleEdit,
    handleHeaderTitleInput,
    handleHeaderTitleKeydown,

    // 版本管理
    syncVersionsFromCommits,
    restoreVersion,

    // 可编辑 HTML 持久化
    clearEditableHtmlSaveTimer,
    setEditableHtmlBaseline,
    syncEditableTextDrafts,
    persistEditableHtmlChanges,
    scheduleEditableHtmlSave,
    flushEditableHtmlChanges,
    updateEditableTextEntry,

    // 内部辅助（被 App.vue 中其余代码引用）
    buildEditableHtmlPayload,
    applyEditableHtmlResult,
    saveEditableHtmlPayload,
    queuePendingWorkspaceStatePersistence,

    // 库刷新
    refreshDesignLibrary,

    // 设计会话 CRUD
    resetDesignConfiguration,
    clearCurrentDesignWorkspace,
    applyOpenedDesignRecord,
    openDesignRecord,
    deleteDesignRecord,
    startNewDesignSession,

    // 设计生成/编辑核心流程
    buildPayload,
    applyDesignResult,
    generateDesign,
    editDesign,

    // 提交对话
    submitConversation,
    handleComposerKeydown,

    // 样式/尺寸操作
    selectStyle,
    openStylePreview,
    closeStylePreview,
    setSizePreset,
    setSizeMode,
    addCustomField,
    removeField,
    fillBrief,
    fillComposer,
  };
}
