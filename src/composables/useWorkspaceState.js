// 工作区状态工厂 — 每个标签页拥有一份独立的 reactive 状态树。
// 模块顶层只保留导出函数；真实状态由 useTabs 管理的 tab store 持有，
// useWorkspaceState() 在调用时解析当前 active tab 并返回其 store。
import { reactive, ref } from "vue";
import { t } from "../i18n/index.js";
import { useTabs, overrideTabId } from "./useTabs.js";

// 设计库列表跨 tab 共享：历史抽屉的排序根据 updatedAt，任何一个 tab 里发生
// 的修改（自动保存、upsert、删除）都必须对所有 tab 可见，否则切 tab 看到的是
// 各自陈旧的 items 快照，顺序会"在切换时突然变"。所有 tab 的 state.design.items
// 都指向这个同一个 reactive 数组；mutation 必须走 in-place（splice/push/pop），
// 不能用 `state.design.items = newArray` 替换引用，否则当前 tab 就脱钩。
const sharedDesignItems = reactive([]);

export function replaceItemsInPlace(target, next) {
  target.splice(0, target.length, ...next);
  return target;
}

// ---------------------------------------------------------------------------
// 工厂：每次调用返回一份完全独立的 store（state / ui / refs / 持久化队列）
// ---------------------------------------------------------------------------
export function createWorkspaceStore() {
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
      busy: false,
      // 用户主动点击「停止」时置 true，让 generateDesign/editDesign 的 catch
      // 跳过正常错误流程（不回滚用户消息、不写 warnings），改走保留会话的收尾。
      userAborted: false
    },
    design: {
      items: sharedDesignItems,
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
      lastSavedAt: "",
      // 导出期间只影响下载按钮的 UI（灰+转圈）；不走 state.isBusy / setBusy，
      // 避免阻塞整体状态（右侧 console status 陷入 busy、左侧抽屉禁用等）。
      exportBusy: false
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

  // drawerOpen / activeDrawer / historyView / drawerWidth / drawerFloating /
  // floatingX / floatingY 在模块级 sharedDrawerUi 里共享——侧栏状态跨 tab
  // 保留，切换历史设计稿时抽屉不回跳、滚动位置不丢。
  const ui = reactive({
    rightPanelTab: "chat",
    exportMenuOpen: false,
    exportScale: 2,
    stylePreviewId: "",
    zoomMode: "fit",
    previewZoom: 1,
    panX: 0,
    panY: 0,
    canvasDragging: false,
    canvasFullscreen: false,
    headerTitleEditing: false,
    localeMenuOpen: false,
    // 导出完成后右下角弹出的小提醒；点"打开文件夹"跳转系统文件管理器。
    // visible=false 时其它字段可无；format 用于决定提示文案里的格式名。
    exportToast: {
      visible: false,
      fileName: "",
      format: ""
    }
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

// ---------------------------------------------------------------------------
// 应用级共享资源（非 per-tab）
// ---------------------------------------------------------------------------
// DOM ref：整个 app 只有一棵 DOM 树，所有 tab 共享同一组 DOM 节点。
// 模板 ref 绑定会把 element 写到这些 ref；切 tab 不卸载 DOM，ref 保持有效。
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
// frameRevision 用于强制 iframe 重新渲染；切 tab 时 watcher 会把它 +1
const frameRevision = ref(0);

// ---------------------------------------------------------------------------
// 多标签页代理层
// ---------------------------------------------------------------------------
// 旧代码大量采用「模块顶层 destructure useWorkspaceState()」的写法，
// 缓存了引用到模块作用域里。这意味着如果直接返回 active store 的对象，
// 那么后续切 tab 时这些缓存仍指向第一个 tab。
//
// 因此 useWorkspaceState() 返回的不是真实对象，而是 Proxy：每次属性访问
// 实时解析 useTabs().ensureActiveStore()，并显式读取 activeTabId.value
// 让 Vue 把 activeTabId 也加入 reactive 依赖图——切 tab 时所有依赖它的
// computed/watch 自然会重算。
//
// 三类对象需要代理：
//   1. reactive 状态树（state / ui / viewport / fullscreenEditor /
//      interaction / runtimeWarmupState / conversationExpandedBlocks /
//      activeDropdown）：双向代理 get/set。
//   2. DOM ref（workspaceRef 等 14 个）：代理 .value 的 get/set；
//      模板 ref 绑定写入 .value 时会自动路由到 active tab 的 ref。
//   3. 函数（setStatus / setBusy / runInBackground 等）：调用时取 active
//      store 上对应函数执行。
//   4. 普通对象（runtimeWarmupPromises）：代理 get/set。

function createReactiveProxy(key) {
  return new Proxy({ __proxyKind: "reactive", __proxyKey: key }, {
    get(_target, prop, receiver) {
      if (prop === "__proxyKind" || prop === "__proxyKey") return _target[prop];
      // 关键：tracks activeTabId + overrideTabId。
      // - activeTabId：切 tab 时所有依赖的 computed/watch 正常 invalidate。
      // - overrideTabId：withTabContext 把 override 换到 originating tab 时，
      //   同样触发 invalidate；否则 computed 会返回基于 activeTabId 的陈旧缓存，
      //   导致例如 currentConversationScopeKey 在流事件路由时拿错 designId。
      void useTabs().activeTabId.value;
      void overrideTabId.value;
      const inner = useTabs().ensureActiveStore()[key];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
    set(_target, prop, value) {
      const inner = useTabs().ensureActiveStore()[key];
      return Reflect.set(inner, prop, value);
    },
    has(_target, prop) {
      const inner = useTabs().ensureActiveStore()[key];
      return Reflect.has(inner, prop);
    },
    ownKeys(_target) {
      const inner = useTabs().ensureActiveStore()[key];
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const inner = useTabs().ensureActiveStore()[key];
      return Reflect.getOwnPropertyDescriptor(inner, prop);
    },
    deleteProperty(_target, prop) {
      const inner = useTabs().ensureActiveStore()[key];
      return Reflect.deleteProperty(inner, prop);
    }
  });
}

const stateProxy = createReactiveProxy("state");
const viewportProxy = createReactiveProxy("viewport");
const fullscreenEditorProxy = createReactiveProxy("fullscreenEditor");

// Drawer/历史相关的几个字段是"整个工作台的侧栏"语义，不该跟 tab 绑。
// 跟 tab 绑的后果：切换历史设计稿（进入另一个 tab）时 activeDrawer 回到各自
// 初始值 "setup"，用户被甩出历史列表；而且 HistoryDrawer 因 v-if 条件变化
// 卸载重建，滚动位置也丢。把这几个字段提到全局 singleton，侧栏状态跨 tab
// 保留，DOM 也不会被重建。
const sharedDrawerUi = reactive({
  drawerOpen: true,
  activeDrawer: "setup",
  historyView: "designs",
  drawerWidth: 420,
  drawerFloating: false,
  floatingX: 0,
  floatingY: 64,
});

const SHARED_UI_KEYS = new Set([
  "drawerOpen",
  "activeDrawer",
  "historyView",
  "drawerWidth",
  "drawerFloating",
  "floatingX",
  "floatingY",
]);

function resolveUiTarget(prop) {
  if (SHARED_UI_KEYS.has(prop)) return sharedDrawerUi;
  return useTabs().ensureActiveStore().ui;
}

const uiProxy = new Proxy({ __proxyKind: "reactive", __proxyKey: "ui" }, {
  get(_target, prop) {
    if (prop === "__proxyKind" || prop === "__proxyKey") return _target[prop];
    if (!SHARED_UI_KEYS.has(prop)) {
      // 只有 per-tab 字段需要跟 activeTabId / overrideTabId 耦合；共享字段
      // 直接走 sharedDrawerUi，自身的 reactivity 会驱动依赖更新。
      void useTabs().activeTabId.value;
      void overrideTabId.value;
    }
    const inner = resolveUiTarget(prop);
    const value = Reflect.get(inner, prop, inner);
    return typeof value === "function" ? value.bind(inner) : value;
  },
  set(_target, prop, value) {
    const inner = resolveUiTarget(prop);
    return Reflect.set(inner, prop, value);
  },
  has(_target, prop) {
    const inner = resolveUiTarget(prop);
    return Reflect.has(inner, prop);
  },
  ownKeys(_target) {
    const tabUi = useTabs().ensureActiveStore().ui;
    return [...new Set([...Reflect.ownKeys(tabUi), ...SHARED_UI_KEYS])];
  },
  getOwnPropertyDescriptor(_target, prop) {
    const inner = resolveUiTarget(prop);
    return Reflect.getOwnPropertyDescriptor(inner, prop);
  },
  deleteProperty(_target, prop) {
    const inner = resolveUiTarget(prop);
    return Reflect.deleteProperty(inner, prop);
  }
});

const interactionProxy = createReactiveProxy("interaction");
const runtimeWarmupStateProxy = createReactiveProxy("runtimeWarmupState");
const conversationExpandedBlocksProxy = createReactiveProxy("conversationExpandedBlocks");
const activeDropdownProxy = createReactiveProxy("activeDropdown");
const runtimeWarmupPromisesProxy = createReactiveProxy("runtimeWarmupPromises");

function callOnActive(name, ...args) {
  return useTabs().ensureActiveStore()[name](...args);
}

function hasDirectTauriInvoke() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

async function invokeDesktop(command, payload) {
  return callOnActive("invokeDesktop", command, payload);
}

function findExactById(collection, id) {
  return callOnActive("findExactById", collection, id);
}

function compactText(value, fallback) {
  return callOnActive("compactText", value, fallback);
}

function setStatus(text, tone, category) {
  return callOnActive("setStatus", text, tone, category);
}

function setBusy(isBusy, label) {
  return callOnActive("setBusy", isBusy, label);
}

function setAgentBusy(isBusy) {
  return callOnActive("setAgentBusy", isBusy);
}

function runInBackground(task) {
  return callOnActive("runInBackground", task);
}

function queueBackgroundWorkspaceTask(task) {
  return callOnActive("queueBackgroundWorkspaceTask", task);
}

// ---------------------------------------------------------------------------
// 主入口：返回多标签页代理。模块级 destructure 现在拿到的是 Proxy，
// 切 tab 后所有访问自动路由到新 tab 的 store。
// ---------------------------------------------------------------------------
export function useWorkspaceState() {
  return {
    state: stateProxy,
    viewport: viewportProxy,
    fullscreenEditor: fullscreenEditorProxy,
    ui: uiProxy,
    interaction: interactionProxy,
    runtimeWarmupState: runtimeWarmupStateProxy,
    runtimeWarmupPromises: runtimeWarmupPromisesProxy,
    conversationExpandedBlocks: conversationExpandedBlocksProxy,
    activeDropdown: activeDropdownProxy,
    // DOM refs 与 frameRevision：整个 app 只有一棵 DOM 树，所有 tab 共享
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
