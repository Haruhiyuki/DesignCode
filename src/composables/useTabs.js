// 多标签页注册表 — 全局唯一单例，管理所有 tab 的生命周期与活动状态。
// 每个 tab 绑定一份独立的 workspace store；WorkbenchContainer 不用 :key，
// 切 tab 由 useWorkspaceState 的 Proxy 自动路由 state 到新 store。
import { ref, shallowReactive, watch } from "vue";
import { createWorkspaceStore } from "./useWorkspaceState.js";
import { t } from "../i18n/index.js";

// 内部 ID 计数器：保证每次新建 tab 拿到唯一 id
let tabIdCounter = 0;

function nextTabId() {
  tabIdCounter += 1;
  const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `tab-${Date.now().toString(36)}-${tabIdCounter}-${random}`;
}

// shallowReactive：tabs 容器只追踪条目增删；每个 store 内部已是深 reactive，
// 不需要再嵌套一层代理。
const tabs = shallowReactive([]);
const activeTabId = ref(null);

// 临时覆盖当前 active tab 的 ID。用于事件回调等场景：
// 例如 CLI stream 监听器在收到 tab A 的 stream 事件时，需要把数据写入 tab A 的
// store（而非 UI 上当前激活的 tab）。withTabContext 把 overrideTabId 暂时设为
// tab A，期间所有 useWorkspaceState() 代理都路由到 tab A。
//
// 关键：overrideTabId 必须是 ref，并且 useWorkspaceState 的 Proxy 要 track
// 它的 .value。否则 Vue 的 computed 依赖图里只有 activeTabId，用 withTabContext
// 切换 override 时 computed 不会 invalidate，继续返回 active tab 的缓存值。
// 例如 currentConversationScopeKey 就会在流事件路由时拿回错 designId，导致
// state.agent.outputDesignId 被塞错 id，日志面板显示占位符。
export const overrideTabId = ref(null);
export function withTabContext(tabId, fn) {
  const prev = overrideTabId.value;
  overrideTabId.value = tabId;
  try {
    return fn();
  } finally {
    overrideTabId.value = prev;
  }
}
export function effectiveActiveTabId() {
  return overrideTabId.value || activeTabId.value;
}

// 注意：tab 必须是【纯对象】（不可 reactive 包裹）。
// 原因：tab.store 内部的 workspaceRef / frameShell 等是 Ref 实例；如果
// reactive(tab) 深度包裹，访问 tab.store.workspaceRef 会被 Vue 自动 unwrap
// 为 .value（一个 element 或 null），useWorkspaceState 的 refProxy 拿到的
// 就不再是 Ref 而是裸值，导致模板 ref 绑定与 .value 读写全部失效。
//
// title 通过 getter 暴露：每次访问都重新读取 store.state.design.currentName，
// Vue 在模板渲染 effect 中会自动跟踪到 state.design.currentName 这个深层依赖。

function makeTabTitle(tab) {
  const designName = tab.store.state.design.currentName;
  if (designName && designName.trim()) {
    return designName.trim();
  }
  if (tab.store.state.design.currentId) {
    return tab.store.state.design.currentId;
  }
  return t("tab.untitled");
}

function findIndexById(tabId) {
  return tabs.findIndex((tab) => tab.id === tabId);
}

function tabById(tabId) {
  return tabs.find((tab) => tab.id === tabId) || null;
}

function findByDesignId(designId) {
  if (!designId) return null;
  return tabs.find((tab) => tab.store.state.design.currentId === designId) || null;
}

// 从主 tab（首个 tab）同步共享的应用级数据到新 tab：catalog / 设计列表 /
// 桌面集成 / runtime agent 元信息等都是 app-global 数据，不需要每个 tab
// 重新跑 bootstrap 再拉一遍。只把真正 per-tab 的字段留空（当前设计、会话、
// stream 状态等）。同步后新 tab 的 state.catalog 等立刻可用，UI 不卡顿。
function seedStateFromPrimary(newStore, primaryStore) {
  const ns = newStore.state;
  const ps = primaryStore.state;

  ns.catalog = ps.catalog;
  ns.styleId = ps.styleId;
  ns.sizeId = ps.sizeId;

  ns.desktop = { ...ps.desktop, currentSessionId: null };

  ns.design.items = ps.design.items;
  ns.assets.items = ps.assets.items;

  const fields = [
    "backend", "installed", "version", "running", "port", "binary", "proxy",
    "proxyPortInput", "appliedProxyPort", "agents", "selectedAgent",
    "providers", "providerId", "modelId", "connectedProviders",
    "providerDefaults", "authMethods", "configModel", "configSmallModel",
    "opencodeSmallModelId", "opencodeProviderBaseUrl", "opencodeProviderApiKey",
    "opencodeProviderApiKeySaved", "opencodeConfig",
    "codexInstalled", "codexVersion", "codexBinary", "codexLoggedIn",
    "codexLoginStatus", "codexAuthMethod", "codexDefaultModel",
    "codexDefaultReasoningEffort", "codexModels", "codexModelId",
    "codexReasoningEffort", "codexVerified", "codexVerificationMessage",
    "claudeInstalled", "claudeVersion", "claudeBinary", "claudeLoggedIn",
    "claudeLoginStatus", "claudeAuthMethod", "claudeDefaultModel",
    "claudeDefaultEffort", "claudeModels", "claudeEfforts", "claudeModelId",
    "claudeEffort", "claudeVerified", "claudeVerificationMessage",
    "geminiInstalled", "geminiVersion", "geminiBinary", "geminiLoggedIn",
    "geminiLoginStatus", "geminiAuthMethod", "geminiDefaultModel",
    "geminiModels", "geminiModelId", "geminiVerified", "geminiVerificationMessage"
  ];
  for (const key of fields) {
    if (key in ps.agent) ns.agent[key] = ps.agent[key];
  }

  // 新 tab 立刻视为 ready（不再是默认的 "loading"）
  ns.statusText = ps.statusText || "";
  ns.statusTone = "idle";
  ns.statusCategory = "load";
  ns.isBusy = false;
}

function createTab({ activate = true, designId = null, pendingAction = null } = {}) {
  const id = nextTabId();
  const store = createWorkspaceStore();

  // 如果已经有 tab（primary）已经跑过 bootstrap，同步它的 catalog / desktop /
  // 设计列表 / runtime 信息到新 tab，避免新 tab 再等一次全量加载。
  // 如果 primary 还在 bootstrap 中（catalog 为空），用 watcher 等它就绪后再
  // 灌入（处理「app 启动瞬间立刻点 +」的边界情况）。
  if (tabs.length > 0) {
    const primary = tabs[0];
    if (primary?.store?.state?.catalog) {
      seedStateFromPrimary(store, primary.store);
    } else if (primary) {
      const unwatch = watch(
        () => primary.store.state.catalog,
        (catalog) => {
          if (catalog) {
            seedStateFromPrimary(store, primary.store);
            unwatch();
          }
        },
        { flush: "sync" }
      );
    }
  }

  const tab = {
    id,
    store,
    designId,
    pendingAction,
    createdAt: Date.now(),
    get title() {
      return makeTabTitle(this);
    }
  };
  tabs.push(tab);
  if (activate || tabs.length === 1) {
    activeTabId.value = id;
  }
  return tab;
}

// 入口辅助：新建一个标签页并标注「待打开新设计」
function createTabForNewDesign() {
  return createTab({ activate: true, pendingAction: { type: "new" } });
}

// 入口辅助：打开指定设计稿。已在某个 tab 打开则切过去，否则新建 tab 并标注待打开。
function openOrCreateForDesign(designId) {
  if (!designId) return null;
  const existing = findByDesignId(designId);
  if (existing) {
    switchTo(existing.id);
    return existing;
  }
  return createTab({
    activate: true,
    designId,
    pendingAction: { type: "open", designId }
  });
}

// 由 WorkbenchContainer onMounted 调用：取出并清除当前 tab 的 pendingAction
function consumePendingAction(tabId) {
  const tab = tabById(tabId);
  if (!tab || !tab.pendingAction) return null;
  const action = tab.pendingAction;
  tab.pendingAction = null;
  return action;
}

function switchTo(tabId) {
  if (!tabById(tabId)) return false;
  activeTabId.value = tabId;
  return true;
}

function ensureActiveStore() {
  // 优先返回 withTabContext 临时指定的 tab 的 store（用于事件回调路由）。
  const targetId = overrideTabId.value || activeTabId.value;
  if (!targetId || !tabById(targetId)) {
    const tab = createTab({ activate: true });
    return tab.store;
  }
  return tabById(targetId).store;
}

async function closeTab(tabId) {
  const index = findIndexById(tabId);
  if (index === -1) return;

  // 1. 停掉前端 stream 监听（停止把后端事件写入此 tab 的 store）
  try {
    const { endCliStreamForTab } = await import("./useCliStream.js");
    endCliStreamForTab?.(tabId);
  } catch (_error) {
    // useCliStream 可能尚未加载——静默忽略
  }

  // 2. 通知后端清理该 tab 名下的运行时子进程
  try {
    if (window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke("runtime_cleanup_tab", { runId: tabId });
    }
  } catch (_error) {
    // 后端命令失败时也保留前端关闭流程，避免 UI 卡死
  }

  tabs.splice(index, 1);

  if (tabs.length === 0) {
    // 永远保持至少一个 tab
    createTab({ activate: true });
    return;
  }

  if (activeTabId.value === tabId) {
    const fallback = tabs[Math.max(0, index - 1)];
    activeTabId.value = fallback.id;
  }
}

function activeTab() {
  return tabById(activeTabId.value);
}

// 唯一导出入口：返回 tabs 注册表与所有操作；模块级单例
export function useTabs() {
  return {
    tabs,
    activeTabId,
    createTab,
    createTabForNewDesign,
    openOrCreateForDesign,
    consumePendingAction,
    closeTab,
    switchTo,
    findByDesignId,
    ensureActiveStore,
    activeTab
  };
}
