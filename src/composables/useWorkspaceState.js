// 全局工作区状态 — reactive state、所有 DOM ref、基础工具函数。
// 其他 composable 通过 useWorkspaceState() 共享同一份状态实例。
import { reactive, ref } from "vue";
import { t } from "../i18n/index.js";

const state = reactive({
  catalog: null,
  styleId: "",
  sizeId: "",
  customSize: {
    name: t("setup.customSizeName"),
    width: 1080,
    height: 1440,
    unit: "px"
  },
  fields: {},
  fieldDefinitions: [],
  brief: "",
  composer: "",
  agentPrompt: "",
  currentHtml: "",
  currentMeta: null,
  currentBlobUrl: null,
  provider: "mock",
  promptBundle: null,
  warnings: [],
  versions: [],
  activeVersionIndex: -1,
  isBusy: false,
  statusText: t("status.loading"),
  statusTone: "busy",
  statusCategory: "load",
  desktop: {
    isDesktop: false,
    nodeAvailable: false,
    nodeVersion: null,
    opencodeAvailable: false,
    opencodeVersion: null,
    opencodeRunning: false,
    opencodePort: null,
    projectDir: null,
    currentSessionId: null
  },
  agent: {
    backend: "codex",
    installed: false,
    version: null,
    running: false,
    port: null,
    binary: "opencode",
    proxy: "",
    proxyPortInput: "",
    appliedProxyPort: "",
    sessionId: null,
    agents: ["build"],
    selectedAgent: "build",
    authPending: false,
    authPendingProviderId: "",
    authPendingUrl: "",
    providers: [],
    providerId: "",
    modelId: "",
    connectedProviders: [],
    providerDefaults: {},
    authMethods: {},
    configModel: "",
    configSmallModel: "",
    opencodeSmallModelId: "",
    opencodeProviderBaseUrl: "",
    opencodeProviderApiKey: "",
    opencodeProviderApiKeySaved: false,
    opencodeConfig: null,
    codexInstalled: false,
    codexVersion: null,
    codexBinary: "codex",
    codexLoggedIn: false,
    codexLoginStatus: "",
    codexAuthMethod: "",
    codexDefaultModel: "",
    codexDefaultReasoningEffort: "",
    codexModels: [],
    codexModelId: "",
    codexReasoningEffort: "",
    codexThreadId: null,
    codexVerified: false,
    codexVerificationMessage: "",
    claudeInstalled: false,
    claudeVersion: null,
    claudeBinary: "claude",
    claudeLoggedIn: false,
    claudeLoginStatus: "",
    claudeAuthMethod: "",
    claudeDefaultModel: "",
    claudeDefaultEffort: "",
    claudeModels: [],
    claudeEfforts: [],
    claudeModelId: "",
    claudeEffort: "",
    claudeSessionId: null,
    claudeVerified: false,
    claudeVerificationMessage: "",
    geminiInstalled: false,
    geminiVersion: null,
    geminiBinary: "gemini",
    geminiLoggedIn: false,
    geminiLoginStatus: "",
    geminiAuthMethod: "",
    geminiDefaultModel: "",
    geminiModels: [],
    geminiModelId: "",
    geminiSessionId: null,
    geminiVerified: false,
    geminiVerificationMessage: "",
    authResult: "",
    output: "",
    outputDesignId: null,
    streamBlocks: [],
    streamDesignId: null,
    busy: false
  },
  design: {
    items: [],
    currentId: null,
    currentName: "",
    sessionId: null,
    runtimeSessions: {
      opencode: null,
      codex: null,
      claude: null,
      gemini: null
    },
    workspaceDir: null,
    chat: [],
    commits: [],
    activeCommitHash: null,
    browsingHistory: false,
    createBusy: false,
    createError: "",
    saveState: "idle",
    saveError: "",
    lastSavedAt: ""
  },
  assets: {
    items: [],
    selectedIds: [],
    nameDrafts: {},
    noteDrafts: {},
    previewUrls: {},
    deletingIds: [],
    importing: false,
    dragDepth: 0,
    dropActive: false
  },
  inspect: {
    drafts: {},
    saveState: "idle",
    saveError: "",
    lastSavedAt: "",
    lastEntryLabel: ""
  }
});

const viewport = reactive({
  zoomPercent: 100,
  frameLabel: t("canvas.notGenerated")
});

const fullscreenEditor = reactive({
  draftHtml: "",
  baselineHtml: "",
  draftFields: {},
  baselineFields: {},
  draftMeta: null,
  baselineMeta: null,
  selectedEntryId: "",
  lastEntryLabel: "",
  saveBusy: false
});

const ui = reactive({
  drawerOpen: true,
  activeDrawer: "setup",
  historyView: "designs",
  rightPanelTab: "chat",
  exportMenuOpen: false,
  exportScale: 2,
  drawerWidth: 420,
  drawerFloating: false,
  stylePreviewId: "",
  floatingX: 0,
  floatingY: 64,
  zoomMode: "fit",
  previewZoom: 1,
  panX: 0,
  panY: 0,
  canvasDragging: false,
  canvasFullscreen: false,
  headerTitleEditing: false,
  localeMenuOpen: false
});

const interaction = reactive({
  mode: "",
  startX: 0,
  startY: 0,
  originWidth: 420,
  originX: 0,
  originY: 0,
  originPanX: 0,
  originPanY: 0
});

const runtimeWarmupState = reactive({
  opencode: { key: "", ready: false },
  codex: { key: "", ready: false },
  claude: { key: "", ready: false },
  gemini: { key: "", ready: false }
});

const runtimeWarmupPromises = {
  opencode: null,
  codex: null,
  claude: null,
  gemini: null
};

const conversationExpandedBlocks = reactive({});
const activeDropdown = reactive({ id: null, rect: null });

const workspaceRef = ref(null);
const frameShell = ref(null);
const frameViewport = ref(null);
const designFrame = ref(null);
const fullscreenFrameShell = ref(null);
const fullscreenFrameViewport = ref(null);
const fullscreenDesignFrame = ref(null);
const fullscreenEditorInputRef = ref(null);
const fullscreenEditableHotspots = ref([]);
const fullscreenHotspotLayerStyle = ref({});
const conversationScrollRef = ref(null);
const assetInputRef = ref(null);
const assetDrawerRef = ref(null);
const exportMenuRef = ref(null);
const headerTitleInputRef = ref(null);
const frameRevision = ref(0);

let workspaceBackgroundPersistQueue = Promise.resolve();

function hasDirectTauriInvoke() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

async function invokeDesktop(command, payload) {
  if (!hasDirectTauriInvoke()) {
    throw new Error("Desktop export channel unavailable.");
  }

  return window.__TAURI__.core.invoke(command, payload);
}

function findExactById(collection = [], id) {
  return collection.find((item) => item.id === id) || null;
}

function compactText(value, fallback = "") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function setStatus(text, tone = "idle", category = "") {
  state.statusText = text;
  state.statusTone = tone;
  state.statusCategory = category;
}

function setBusy(isBusy, label = "") {
  state.isBusy = isBusy;
  if (label) {
    setStatus(label, isBusy ? "busy" : "idle");
  }
}

function setAgentBusy(isBusy) {
  state.agent.busy = isBusy;
}

function runInBackground(task) {
  Promise.resolve()
    .then(task)
    .catch(() => {});
}

function queueBackgroundWorkspaceTask(task) {
  workspaceBackgroundPersistQueue = workspaceBackgroundPersistQueue
    .then(() => task())
    .catch(() => {});
  return workspaceBackgroundPersistQueue;
}

export function useWorkspaceState() {
  return {
    state,
    viewport,
    fullscreenEditor,
    ui,
    interaction,
    runtimeWarmupState,
    runtimeWarmupPromises,
    conversationExpandedBlocks,
    activeDropdown,
    workspaceRef,
    frameShell,
    frameViewport,
    designFrame,
    fullscreenFrameShell,
    fullscreenFrameViewport,
    fullscreenDesignFrame,
    fullscreenEditorInputRef,
    fullscreenEditableHotspots,
    fullscreenHotspotLayerStyle,
    conversationScrollRef,
    assetInputRef,
    assetDrawerRef,
    exportMenuRef,
    headerTitleInputRef,
    frameRevision,
    hasDirectTauriInvoke,
    invokeDesktop,
    findExactById,
    compactText,
    setStatus,
    setBusy,
    setAgentBusy,
    runInBackground,
    queueBackgroundWorkspaceTask
  };
}
