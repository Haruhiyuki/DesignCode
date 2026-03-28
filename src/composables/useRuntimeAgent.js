// 运行时后端管理 — OpenCode/Codex/Claude/Gemini 的启停、登录、模型切换、
// 代理配置、warmup 预热、prompt 发送。是前端与 Rust 子系统之间的桥梁。
import {
  attachDesignSession as persistDesignSession,
  createOpencodeSession,
  getCatalog,
  getClaudeStatus,
  getCodexStatus,
  getDesktopContext,
  getGeminiStatus,
  getOpencodeConfig,
  getOpencodeConfigProviders,
  getOpencodePreferences,
  getOpencodeStatus,
  getOpencodeStoredApiKey,
  listClaudeModels,
  listCodexModels,
  listGeminiModels,
  listOpencodeAgents,
  listOpencodeMessages,
  listOpencodeProviderAuth,
  listOpencodeProviders,
  openClaudeLogin,
  openCodexLogin,
  openGeminiLogin,
  runOpencodeShell,
  sendClaudePrompt,
  sendCodexPrompt,
  sendGeminiPrompt,
  sendOpencodePrompt,
  startOpencode,
  stopOpencode,
  syncDesignWorkspace as syncDesignWorkspaceSnapshot,
  updateCodexSettings,
  updateOpencodeConfig,
  updateOpencodePreferences,
  verifyClaude,
  verifyCodex,
  verifyGemini,
  warmRuntimeBackend,
} from "../lib/desktop-api.js";
import { cloneSnapshot, inferAgentText } from "../lib/studio-utils.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useCliStream } from "./useCliStream.js";
import { useConversation } from "./useConversation.js";
import { useDesignSession } from "./useDesignSession.js";
import { useArtAssets } from "./useArtAssets.js";

// ---------------------------------------------------------------------------
// 模块级单例 — 从其他 composable 获取依赖
// ---------------------------------------------------------------------------

const {
  state,
  runtimeWarmupState, runtimeWarmupPromises,
  setStatus, setAgentBusy, runInBackground,
  findExactById,
} = useWorkspaceState();

const {
  RUNTIME_BACKEND_OPTIONS, RUNTIME_PROXY_PORT_STORAGE_KEY,
  styles,
  activeRuntimeBackend, activeRuntimeSessionId,
  runtimeDirectory, runtimeBackendDisplayName,
  normalizeGeminiModelValue,
  availableProviders, selectedProvider,
  opencodeSmallModelOptions,
  codexModelOptions, selectedCodexModel,
  codexReasoningOptions,
  currentConversationScopeKey,
  hasDesign,
  buildPromptBundleForInstruction,
  syncActiveRuntimeSession,
  makeDefaultCustomSize, templateFieldDefinitions, templateFieldDefaults,
} = useSetupConfig();

const {
  nextCodexStreamId,
  sanitizeAgentConsoleMessage,
  appendAgentOutputLine, appendAgentOutputEntry,
  markConversationRuntimeScope,
  serializeConversationBlocksForStorage,
  beginCliStream, endCliStream,
  summarizeCliResultOutput, formatCliBlockSummary,
} = useCliStream();

const { buildOpencodeBlocksFromMessages } = useConversation();

const {
  buildPayload, applyOpenedDesignRecord,
  refreshDesignLibrary, openDesignRecord,
  resetDesignConfiguration, flushEditableHtmlChanges,
} = useDesignSession();

const {
  refreshArtAssetLibrary,
} = useArtAssets();

// ---------------------------------------------------------------------------
// 模块级 let 变量
// ---------------------------------------------------------------------------

let providerAuthPollToken = 0;
let opencodeAutoStartAttempted = false;
let opencodeAutoStartSuppressed = false;
let opencodePreferenceCache = createEmptyOpencodePreferenceSnapshot();

// ---------------------------------------------------------------------------
// 辅助函数 — sleep
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createEmptyOpencodePreferenceSnapshot() {
  return {
    selectedProviderId: "",
    selectedModelId: "",
    smallModelId: "",
    providers: {}
  };
}

function normalizeOpencodePreferenceSnapshot(value) {
  const snapshot = createEmptyOpencodePreferenceSnapshot();
  if (!value || typeof value !== "object") {
    return snapshot;
  }

  snapshot.selectedProviderId = String(value.selectedProviderId || "").trim();
  snapshot.selectedModelId = String(value.selectedModelId || "").trim();
  snapshot.smallModelId = String(value.smallModelId || "").trim();

  const providers = value.providers && typeof value.providers === "object"
    ? value.providers
    : {};
  snapshot.providers = Object.fromEntries(
    Object.entries(providers)
      .map(([providerId, providerValue]) => {
        const normalizedProviderId = String(providerId || "").trim();
        if (!normalizedProviderId || !providerValue || typeof providerValue !== "object") {
          return null;
        }
        return [normalizedProviderId, {
          modelId: String(providerValue.modelId || "").trim(),
          baseUrl: String(providerValue.baseUrl || "").trim(),
          hasApiKey: Boolean(providerValue.hasApiKey)
        }];
      })
      .filter(Boolean)
  );

  return snapshot;
}

function getStoredOpencodeProviderState(providerId) {
  const normalizedProviderId = String(providerId || "").trim();
  if (!normalizedProviderId) {
    return null;
  }
  return opencodePreferenceCache.providers[normalizedProviderId] || null;
}

function applyOpencodePreferenceSnapshot(snapshot) {
  opencodePreferenceCache = normalizeOpencodePreferenceSnapshot(snapshot);

  if (!state.agent.providerId && opencodePreferenceCache.selectedProviderId) {
    state.agent.providerId = opencodePreferenceCache.selectedProviderId;
  }

  if (!state.agent.modelId && opencodePreferenceCache.selectedModelId) {
    state.agent.modelId = opencodePreferenceCache.selectedModelId;
  }

  if (!state.agent.opencodeSmallModelId && opencodePreferenceCache.smallModelId) {
    state.agent.opencodeSmallModelId = opencodePreferenceCache.smallModelId;
  }

  syncOpenCodeProviderBaseUrl(state.agent.providerId);
  syncOpenCodeProviderApiKey(state.agent.providerId);
}

async function loadOpencodePreferenceSnapshot() {
  if (!state.desktop.isDesktop) {
    return opencodePreferenceCache;
  }

  try {
    const snapshot = await getOpencodePreferences();
    applyOpencodePreferenceSnapshot(snapshot);
  } catch (error) {
    appendAgentOutputEntry(
      t("runtime.refresh.providerFailed", { error: error instanceof Error ? error.message : String(error) })
    );
  }

  return opencodePreferenceCache;
}

function formatOpencodeMessagesForConsole(messages) {
  const blocks = buildOpencodeBlocksFromMessages(messages);
  return blocks
    .map((block) => formatCliBlockSummary({
      ...block,
      suppressLogLine: false
    }, "opencode"))
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 辅助函数 — clearPendingBrowserAuth
// ---------------------------------------------------------------------------

function clearPendingBrowserAuth() {
  providerAuthPollToken += 1;
  state.agent.authPending = false;
  state.agent.authPendingProviderId = "";
  state.agent.authPendingUrl = "";
}

// ---------------------------------------------------------------------------
// 辅助函数 — 运行时 session 读写
// ---------------------------------------------------------------------------

function readRuntimeSession(runtimeBackend) {
  return state.design.runtimeSessions[runtimeBackend] || null;
}

function writeRuntimeSession(runtimeBackend, sessionId) {
  state.design.runtimeSessions = {
    ...state.design.runtimeSessions,
    [runtimeBackend]: sessionId || null
  };
  syncActiveRuntimeSession();
}

// ---------------------------------------------------------------------------
// 辅助函数 — 模型推断
// ---------------------------------------------------------------------------

function inferConfiguredModelParts(configModel) {
  if (!configModel || !String(configModel).includes("/")) {
    return { providerId: "", modelId: "" };
  }

  const [providerId, ...rest] = String(configModel).split("/");
  return {
    providerId,
    modelId: rest.join("/")
  };
}

function readConfiguredOpenCodeProviderBaseUrl(providerId) {
  if (!providerId || !state.agent.opencodeConfig || typeof state.agent.opencodeConfig !== "object") {
    return "";
  }

  const providerConfig = state.agent.opencodeConfig.provider?.[providerId];
  const baseUrl = providerConfig?.options?.baseURL;
  return typeof baseUrl === "string" ? baseUrl : "";
}

function readConfiguredOpenCodeProviderApiKey(providerId) {
  if (!providerId || !state.agent.opencodeConfig || typeof state.agent.opencodeConfig !== "object") {
    return "";
  }

  const providerConfig = state.agent.opencodeConfig.provider?.[providerId];
  const apiKey = providerConfig?.options?.apiKey;
  return typeof apiKey === "string" ? apiKey : "";
}

// ---------------------------------------------------------------------------
// 辅助函数 — Gemini 二进制判断
// ---------------------------------------------------------------------------

function isGeminiDisplayBinary(value) {
  const input = String(value || "").trim();
  return Boolean(input && input.includes("package/dist/index.js") && input.includes("node"));
}

function resolvedGeminiModelLabel(value, fallback = t("runtime.notSet")) {
  return normalizeGeminiModelValue(value) || fallback;
}

function normalizedGeminiBinary(value = state.agent.geminiBinary) {
  const input = String(value || "").trim();
  if (!input || isGeminiDisplayBinary(input)) {
    return "gemini";
  }
  return input;
}

// ---------------------------------------------------------------------------
// 辅助函数 — CLI session 同步
// ---------------------------------------------------------------------------

function applyCliSessionToState(sessionId) {
  if (!sessionId) {
    return;
  }

  if (activeRuntimeBackend.value === "codex") {
    state.agent.codexThreadId = sessionId;
  } else if (activeRuntimeBackend.value === "claude") {
    state.agent.claudeSessionId = sessionId;
  } else if (activeRuntimeBackend.value === "gemini") {
    state.agent.geminiSessionId = sessionId;
  }

  writeRuntimeSession(activeRuntimeBackend.value, sessionId);
}

// ---------------------------------------------------------------------------
// 辅助函数 — 运行时后端切换
// ---------------------------------------------------------------------------

function setRuntimeBackend(mode) {
  state.agent.backend = RUNTIME_BACKEND_OPTIONS.value.some((item) => item.id === mode) ? mode : "codex";
  syncActiveRuntimeSession();
}

// ---------------------------------------------------------------------------
// 代理端口管理
// ---------------------------------------------------------------------------

function normalizeProxyPort(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) {
    return "";
  }

  const port = Number(digits);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return String(port);
}

function loadRuntimeProxyPortPreference() {
  try {
    const stored = window.localStorage.getItem(RUNTIME_PROXY_PORT_STORAGE_KEY);
    const normalized = normalizeProxyPort(stored || "");
    if (!normalized) {
      return;
    }
    state.agent.proxyPortInput = normalized;
    state.agent.appliedProxyPort = normalized;
    state.agent.proxy = `http://127.0.0.1:${normalized}`;
  } catch {}
}

function persistRuntimeProxyPortPreference(port) {
  try {
    if (!port) {
      window.localStorage.removeItem(RUNTIME_PROXY_PORT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(RUNTIME_PROXY_PORT_STORAGE_KEY, port);
  } catch {}
}

async function restartOpencodeWithCurrentProxy(reason) {
  if (!state.desktop.isDesktop || !state.agent.running) {
    return false;
  }

  const binary = state.agent.binary.trim() || "opencode";
  const proxy = state.agent.proxy || null;
  setAgentBusy(true);
  try {
    setStatus(reason || t("status.restartingOpencode"), "busy", "start");
    await stopOpencode();
    await sleep(400);
    const status = await startOpencode(binary, proxy);
    state.agent.installed = status.installed;
    state.agent.version = status.version || null;
    state.agent.running = status.running;
    state.agent.port = status.port || null;
    state.agent.binary = status.binary || binary;
    state.agent.sessionId = status.session_id || status.sessionId || null;
    await refreshDesktopIntegration();
    return true;
  } finally {
    setAgentBusy(false);
  }
}

async function applyProxyPort() {
  const normalized = normalizeProxyPort(state.agent.proxyPortInput);
  if (normalized === null) {
    setStatus(t("status.proxyPortInvalid"), "warning", "input");
    return;
  }

  const previousProxy = state.agent.proxy;
  state.agent.appliedProxyPort = normalized;
  state.agent.proxy = normalized ? `http://127.0.0.1:${normalized}` : "";
  state.agent.proxyPortInput = normalized;
  persistRuntimeProxyPortPreference(normalized);

  if (state.desktop.isDesktop && state.agent.running && previousProxy !== state.agent.proxy) {
    try {
      await restartOpencodeWithCurrentProxy(normalized ? t("status.proxyAppliedRestart", { proxy: normalized }) : t("status.proxyClearRestart"));
      setStatus(normalized ? t("status.proxyApplied", { proxy: normalized }) : t("status.proxyCleared"), "success");
    } catch (error) {
      state.agent.output = t("export.proxyApplyFailed", { error: error instanceof Error ? error.message : String(error) });
      setStatus(t("status.proxyApplyFailed"), "error", "save");
    }
    return;
  }

  setStatus(normalized ? t("status.proxyApplied", { proxy: normalized }) : t("status.proxyCleared"), "success");
}

// ---------------------------------------------------------------------------
// Provider 管理
// ---------------------------------------------------------------------------

function syncRuntimeModelSelection() {
  const providerIds = availableProviders.value.map((item) => item.id);
  if (!providerIds.length) {
    state.agent.providerId = "";
    state.agent.modelId = "";
    return;
  }

  const configured = inferConfiguredModelParts(state.agent.configModel);
  const preferredFromPrefs =
    providerIds.includes(opencodePreferenceCache.selectedProviderId)
      ? opencodePreferenceCache.selectedProviderId
      : "";
  const preferredProvider =
    (providerIds.includes(state.agent.providerId) && state.agent.providerId) ||
    (providerIds.includes(configured.providerId) && configured.providerId) ||
    preferredFromPrefs ||
    (providerIds.includes("openai") && "openai") ||
    state.agent.connectedProviders.find((providerId) => providerIds.includes(providerId)) ||
    providerIds[0];

  state.agent.providerId = preferredProvider;

  const modelIds = Object.keys(selectedProvider.value?.models || {});
  if (!modelIds.length) {
    state.agent.modelId = "";
    return;
  }

  const configuredModel =
    configured.providerId === preferredProvider && modelIds.includes(configured.modelId)
      ? configured.modelId
      : "";
  const storedModel = getStoredOpencodeProviderState(preferredProvider)?.modelId || "";
  const defaultModel = state.agent.providerDefaults[preferredProvider];
  state.agent.modelId =
    configuredModel ||
    (modelIds.includes(storedModel) ? storedModel : "") ||
    (modelIds.includes(defaultModel) ? defaultModel : "") ||
    state.agent.modelId ||
    modelIds[0];
}

function syncOpenCodeSmallModelSelection() {
  const optionIds = new Set(opencodeSmallModelOptions.value.map((item) => item.id));
  const configuredSmallModel = String(state.agent.configSmallModel || "").trim();

  if (state.agent.opencodeSmallModelId && optionIds.has(state.agent.opencodeSmallModelId)) {
    return;
  }

  if (configuredSmallModel && optionIds.has(configuredSmallModel)) {
    state.agent.opencodeSmallModelId = configuredSmallModel;
    return;
  }

  if (
    opencodePreferenceCache.smallModelId
    && optionIds.has(opencodePreferenceCache.smallModelId)
  ) {
    state.agent.opencodeSmallModelId = opencodePreferenceCache.smallModelId;
    return;
  }

  state.agent.opencodeSmallModelId = "";
}

function syncOpenCodeProviderBaseUrl(providerId = state.agent.providerId) {
  if (!providerId) {
    state.agent.opencodeProviderBaseUrl = "";
    return;
  }

  state.agent.opencodeProviderBaseUrl =
    readConfiguredOpenCodeProviderBaseUrl(providerId)
    || getStoredOpencodeProviderState(providerId)?.baseUrl
    || "";
}

function syncOpenCodeProviderApiKey(providerId = state.agent.providerId) {
  state.agent.opencodeProviderApiKey = "";
  state.agent.opencodeProviderApiKeySaved = providerId
    ? Boolean(getStoredOpencodeProviderState(providerId)?.hasApiKey || readConfiguredOpenCodeProviderApiKey(providerId))
    : false;
}

function applyRuntimeCatalog(providerList, authMethods, configProviders, config) {
  state.agent.providers = Array.isArray(providerList?.all) ? providerList.all : [];
  state.agent.connectedProviders = Array.isArray(providerList?.connected)
    ? providerList.connected
    : [];
  state.agent.providerDefaults =
    configProviders?.default ||
    providerList?.default ||
    {};
  state.agent.authMethods = authMethods || {};
  state.agent.configModel = config?.model || "";
  state.agent.configSmallModel = config?.small_model || "";
  state.agent.opencodeConfig = config && typeof config === "object" ? cloneSnapshot(config) : null;
  syncRuntimeModelSelection();
  syncOpenCodeSmallModelSelection();
  syncOpenCodeProviderBaseUrl();
  syncOpenCodeProviderApiKey();
}

function applyProviderConnectionSnapshot(providerList) {
  state.agent.providers = Array.isArray(providerList?.all) ? providerList.all : [];
  state.agent.connectedProviders = Array.isArray(providerList?.connected)
    ? providerList.connected
    : [];
  if (providerList?.default && typeof providerList.default === "object") {
    state.agent.providerDefaults = providerList.default;
  }
  syncRuntimeModelSelection();
  return state.agent.connectedProviders;
}

// ---------------------------------------------------------------------------
// Codex 操作
// ---------------------------------------------------------------------------

function syncCodexModelSelection() {
  const modelIds = new Set(codexModelOptions.value.map((item) => item.id));
  if (state.agent.codexModelId && modelIds.has(state.agent.codexModelId)) {
    return;
  }

  if (state.agent.codexDefaultModel && modelIds.has(state.agent.codexDefaultModel)) {
    state.agent.codexModelId = state.agent.codexDefaultModel;
    return;
  }

  state.agent.codexModelId = codexModelOptions.value[0]?.id || state.agent.codexModelId || "";
}

function syncCodexReasoningSelection() {
  const efforts = codexReasoningOptions.value.map((item) => item.effort);
  if (!efforts.length) {
    if (!state.agent.codexReasoningEffort) {
      state.agent.codexReasoningEffort = state.agent.codexDefaultReasoningEffort || "";
    }
    return;
  }

  if (state.agent.codexReasoningEffort && efforts.includes(state.agent.codexReasoningEffort)) {
    return;
  }

  if (state.agent.codexDefaultReasoningEffort && efforts.includes(state.agent.codexDefaultReasoningEffort)) {
    state.agent.codexReasoningEffort = state.agent.codexDefaultReasoningEffort;
    return;
  }

  const modelDefault = selectedCodexModel.value?.defaultReasoningLevel;
  if (modelDefault && efforts.includes(modelDefault)) {
    state.agent.codexReasoningEffort = modelDefault;
    return;
  }

  state.agent.codexReasoningEffort = codexReasoningOptions.value[0]?.effort || state.agent.codexReasoningEffort || "";
}

function applyCodexStatusSnapshot(status, models = null) {
  const previousBinary = state.agent.codexBinary;
  state.agent.codexInstalled = Boolean(status?.installed);
  state.agent.codexVersion = status?.version || null;
  state.agent.codexBinary = status?.binary || state.agent.codexBinary;
  state.agent.codexLoggedIn = Boolean(status?.loggedIn);
  state.agent.codexLoginStatus = status?.loginStatus || "";
  state.agent.codexAuthMethod = status?.authMethod || "";
  state.agent.codexDefaultModel = status?.defaultModel || "";
  state.agent.codexDefaultReasoningEffort = status?.defaultReasoningEffort || "";

  if (Array.isArray(models)) {
    state.agent.codexModels = models;
  }

  if (!state.agent.codexLoggedIn || previousBinary !== state.agent.codexBinary) {
    state.agent.codexVerified = false;
    if (!state.agent.codexLoggedIn) {
      state.agent.codexVerificationMessage = "";
    }
  }

  syncCodexModelSelection();
  syncCodexReasoningSelection();
}

async function handleOpenCodexLogin(options = {}) {
  if (!state.desktop.isDesktop) {
    return;
  }

  const { deviceAuth = false, force = false } = options;

  if (state.agent.codexLoggedIn && !force) {
    state.agent.authResult = [
      t("runtime.auth.codexLocalDetected"),
      t("runtime.auth.codexLocalNote"),
      t("runtime.auth.codexLocalAction")
    ].join("\n");
    setStatus(t("status.codexLoginDetected"), "idle", "login");
    return;
  }

  setAgentBusy(true);
  try {
    const result = await openCodexLogin(
      state.agent.codexBinary.trim() || "codex",
      deviceAuth,
      state.agent.proxy || null
    );
    state.agent.authResult = result.message || t("runtime.auth.codexLoginOpened");
    appendAgentOutputEntry(state.agent.authResult);
    await refreshDesktopIntegration({
      skipProviderCatalog: true,
      skipSessionMessages: true
    });
    setStatus(deviceAuth ? t("status.codexDeviceCodeLogin") : t("status.codexLoginOpened"), "success", "login");
  } catch (error) {
    state.agent.authResult = t("runtime.refresh.codexLoginFailed", { error: error instanceof Error ? error.message : String(error) });
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.codexLoginFailed"), "error", "login");
  } finally {
    setAgentBusy(false);
  }
}

async function handleVerifyCodex() {
  if (!state.desktop.isDesktop) {
    return;
  }

  setAgentBusy(true);
  try {
    const result = await verifyCodex(
      state.agent.codexBinary.trim() || "codex",
      state.agent.codexModelId || state.agent.codexDefaultModel || null,
      state.agent.codexReasoningEffort || state.agent.codexDefaultReasoningEffort || null,
      state.agent.proxy || null
    );
    state.agent.codexVerified = Boolean(result.ok);
    state.agent.codexVerificationMessage = result.message || "";
    state.agent.authResult = [
      t("runtime.auth.codexVerifySuccess"),
      result.message || ""
    ]
      .filter(Boolean)
      .join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.codexVerified"), "success", "verify");
  } catch (error) {
    state.agent.codexVerified = false;
    state.agent.codexVerificationMessage = error instanceof Error ? error.message : String(error);
    state.agent.authResult = [
      t("runtime.auth.codexVerifyFail"),
      state.agent.codexVerificationMessage
    ].join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.codexVerifyFailed"), "error", "verify");
  } finally {
    setAgentBusy(false);
  }
}

async function applyCodexModel() {
  if (!state.agent.codexModelId) {
    setStatus(t("status.selectCodexModel"), "warning", "save");
    return;
  }

  setAgentBusy(true);
  try {
    const status = await updateCodexSettings(
      state.agent.codexBinary.trim() || "codex",
      state.agent.codexModelId,
      state.agent.codexReasoningEffort || null
    );
    applyCodexStatusSnapshot(status);
    state.agent.codexVerified = false;
    state.agent.codexVerificationMessage = "";
    state.agent.authResult = [
      t("runtime.model.codexSwitched", { model: state.agent.codexDefaultModel || state.agent.codexModelId }),
      state.agent.codexDefaultReasoningEffort
        ? t("runtime.model.effortLevel", { effort: state.agent.codexDefaultReasoningEffort })
        : ""
    ]
      .filter(Boolean)
      .join("\n");
    setStatus(t("status.codexModelSwitched"), "success", "save");
  } catch (error) {
    state.agent.authResult = t("runtime.refresh.codexModelUpdateFailed", { error: error instanceof Error ? error.message : String(error) });
    setStatus(t("status.codexModelUpdateFailed"), "error", "save");
  } finally {
    setAgentBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Claude 操作
// ---------------------------------------------------------------------------

function applyClaudeStatusSnapshot(status) {
  const previousBinary = state.agent.claudeBinary;
  state.agent.claudeInstalled = Boolean(status?.installed);
  state.agent.claudeVersion = status?.version || null;
  state.agent.claudeBinary = status?.binary || state.agent.claudeBinary;
  state.agent.claudeLoggedIn = Boolean(status?.loggedIn);
  state.agent.claudeLoginStatus = status?.loginStatus || "";
  state.agent.claudeAuthMethod = status?.authMethod || "";
  state.agent.claudeDefaultModel = status?.defaultModel || "";
  state.agent.claudeDefaultEffort = status?.defaultEffort || "";

  if (!state.agent.claudeModelId && state.agent.claudeDefaultModel) {
    state.agent.claudeModelId = state.agent.claudeDefaultModel;
  }
  if (!state.agent.claudeEffort && state.agent.claudeDefaultEffort) {
    state.agent.claudeEffort = state.agent.claudeDefaultEffort;
  }

  if (!state.agent.claudeLoggedIn || previousBinary !== state.agent.claudeBinary) {
    state.agent.claudeVerified = false;
    if (!state.agent.claudeLoggedIn) {
      state.agent.claudeVerificationMessage = "";
    }
  }
}

function applyClaudeModelsSnapshot(payload = null) {
  if (!payload) {
    return;
  }

  const availableModels = Array.isArray(payload?.availableModels)
    ? payload.availableModels
    : Array.isArray(payload?.available_models)
      ? payload.available_models
      : null;
  const availableEfforts = Array.isArray(payload?.availableEfforts)
    ? payload.availableEfforts
    : Array.isArray(payload?.available_efforts)
      ? payload.available_efforts
      : null;

  state.agent.claudeModels = Array.isArray(availableModels)
    ? availableModels
      .map((model) => {
        const id = String(model?.id || model?.modelId || model?.model_id || "").trim();
        if (!id) {
          return null;
        }
        return {
          id,
          name: String(model?.name || model?.title || id).trim() || id,
          description: model?.description ? String(model.description).trim() : null
        };
      })
      .filter(Boolean)
    : state.agent.claudeModels;

  state.agent.claudeEfforts = Array.isArray(availableEfforts)
    ? availableEfforts
      .map((effort) => String(effort || "").trim())
      .filter(Boolean)
    : state.agent.claudeEfforts;

  const currentModelId = String(payload?.currentModelId || payload?.current_model_id || "").trim();
  const currentEffort = String(payload?.currentEffort || payload?.current_effort || "").trim();

  if (currentModelId) {
    state.agent.claudeDefaultModel = currentModelId;
  }
  if (currentEffort) {
    state.agent.claudeDefaultEffort = currentEffort;
  }

  if (
    state.agent.claudeModelId
    && state.agent.claudeModelId !== state.agent.claudeDefaultModel
    && !state.agent.claudeModels.some((model) => model.id === state.agent.claudeModelId)
  ) {
    state.agent.claudeModelId = state.agent.claudeDefaultModel || "";
  }

  if (
    state.agent.claudeEffort
    && state.agent.claudeEffort !== state.agent.claudeDefaultEffort
    && !state.agent.claudeEfforts.includes(state.agent.claudeEffort)
  ) {
    state.agent.claudeEffort = state.agent.claudeDefaultEffort || "";
  }
}

async function handleOpenClaudeLogin() {
  if (!state.desktop.isDesktop) {
    return;
  }

  setAgentBusy(true);
  try {
    const result = await openClaudeLogin(
      state.agent.claudeBinary.trim() || "claude",
      state.agent.proxy || null
    );
    state.agent.authResult = result.message || t("runtime.auth.claudeLoginOpened");
    appendAgentOutputEntry(state.agent.authResult);
    await refreshDesktopIntegration({
      skipProviderCatalog: true,
      skipSessionMessages: true
    });
    setStatus(t("status.claudeLoginOpened"), "success", "login");
  } catch (error) {
    state.agent.authResult = t("runtime.refresh.claudeLoginFailed", { error: error instanceof Error ? error.message : String(error) });
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.claudeLoginFailed"), "error", "login");
  } finally {
    setAgentBusy(false);
  }
}

async function handleVerifyClaude() {
  if (!state.desktop.isDesktop) {
    return;
  }

  setAgentBusy(true);
  try {
    const result = await verifyClaude(
      state.agent.claudeBinary.trim() || "claude",
      state.agent.claudeModelId || state.agent.claudeDefaultModel || null,
      state.agent.claudeEffort || state.agent.claudeDefaultEffort || null,
      state.agent.proxy || null
    );
    state.agent.claudeVerified = Boolean(result.ok);
    state.agent.claudeVerificationMessage = result.message || "";
    state.agent.authResult = [
      t("runtime.auth.claudeVerifySuccess"),
      result.message || ""
    ]
      .filter(Boolean)
      .join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.claudeVerified"), "success", "verify");
  } catch (error) {
    state.agent.claudeVerified = false;
    state.agent.claudeVerificationMessage = error instanceof Error ? error.message : String(error);
    state.agent.authResult = [
      t("runtime.auth.claudeVerifyFail"),
      state.agent.claudeVerificationMessage
    ].join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.claudeVerifyFailed"), "error", "verify");
  } finally {
    setAgentBusy(false);
  }
}

function applyClaudeModel() {
  state.agent.claudeVerified = false;
  state.agent.claudeVerificationMessage = "";
  state.agent.authResult = [
    t("runtime.model.claudeSwitched", { model: state.agent.claudeModelId || state.agent.claudeDefaultModel || t("runtime.model.cliDefault") }),
    state.agent.claudeEffort ? t("runtime.model.effortLevel", { effort: state.agent.claudeEffort }) : ""
  ]
    .filter(Boolean)
    .join("\n");
  setStatus(t("status.claudeParamsUpdated"), "success", "save");
}

// ---------------------------------------------------------------------------
// Gemini 操作
// ---------------------------------------------------------------------------

function applyGeminiStatusSnapshot(status, modelsPayload = null) {
  const previousBinary = normalizedGeminiBinary(state.agent.geminiBinary);
  state.agent.geminiInstalled = Boolean(status?.installed);
  state.agent.geminiVersion = status?.version || null;
  if (isGeminiDisplayBinary(state.agent.geminiBinary)) {
    state.agent.geminiBinary = "gemini";
  }
  state.agent.geminiLoggedIn = Boolean(status?.loggedIn);
  state.agent.geminiLoginStatus = status?.loginStatus || "";
  state.agent.geminiAuthMethod = status?.authMethod || "";
  const currentModelId = normalizeGeminiModelValue(
    modelsPayload?.currentModelId || modelsPayload?.current_model_id
  );
  if (currentModelId) {
    state.agent.geminiDefaultModel = currentModelId;
  } else if (!state.agent.geminiDefaultModel) {
    state.agent.geminiDefaultModel = normalizeGeminiModelValue(status?.defaultModel);
  }
  if (modelsPayload) {
    applyGeminiModelsSnapshot(modelsPayload);
  }

  if (previousBinary !== normalizedGeminiBinary(state.agent.geminiBinary)) {
    state.agent.geminiVerified = false;
    state.agent.geminiVerificationMessage = "";
  }
}

function applyGeminiModelsSnapshot(modelsPayload = null) {
  if (!modelsPayload) {
    return;
  }

  const availableModels = Array.isArray(modelsPayload?.availableModels)
    ? modelsPayload.availableModels
    : Array.isArray(modelsPayload?.available_models)
      ? modelsPayload.available_models
      : null;

  state.agent.geminiModels = Array.isArray(availableModels)
    ? availableModels
      .map((model) => {
        const id = normalizeGeminiModelValue(model?.id || model?.modelId || model?.model_id || model);
        if (!id) {
          return null;
        }
        return {
          id,
          name: normalizeGeminiModelValue(model?.name || model?.title) || id,
          description: model?.description ? String(model.description).trim() : null
        };
      })
      .filter(Boolean)
    : state.agent.geminiModels;

  const currentModelId = normalizeGeminiModelValue(
    modelsPayload?.currentModelId || modelsPayload?.current_model_id
  );
  if (currentModelId) {
    state.agent.geminiDefaultModel = currentModelId;
  }

  if (
    state.agent.geminiModelId &&
    state.agent.geminiModelId !== state.agent.geminiDefaultModel &&
    !state.agent.geminiModels.some((model) => model.id === state.agent.geminiModelId)
  ) {
    state.agent.geminiModelId = state.agent.geminiDefaultModel || "";
  }
}

async function handleOpenGeminiLogin() {
  if (!state.desktop.isDesktop) {
    return;
  }

  setAgentBusy(true);
  try {
    const result = await openGeminiLogin(
      normalizedGeminiBinary(),
      state.agent.proxy || null
    );
    state.agent.authResult = result.message || t("runtime.auth.geminiLoginDone");
    appendAgentOutputEntry(state.agent.authResult);
    await refreshDesktopIntegration({
      skipProviderCatalog: true,
      skipSessionMessages: true
    });
    setStatus(t("status.geminiLoginDone"), "success", "login");
  } catch (error) {
    state.agent.authResult = t("runtime.refresh.geminiLoginFailed", { error: error instanceof Error ? error.message : String(error) });
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.geminiLoginFailed"), "error", "login");
  } finally {
    setAgentBusy(false);
  }
}

async function handleVerifyGemini() {
  if (!state.desktop.isDesktop) {
    return;
  }

  setAgentBusy(true);
  try {
    const result = await verifyGemini(
      normalizedGeminiBinary(),
      normalizeGeminiModelValue(state.agent.geminiModelId)
        || normalizeGeminiModelValue(state.agent.geminiDefaultModel)
        || null,
      state.agent.proxy || null
    );
    state.agent.geminiVerified = Boolean(result.ok);
    state.agent.geminiVerificationMessage = result.message || "";
    state.agent.authResult = [
      t("runtime.auth.geminiVerifySuccess"),
      result.message || ""
    ]
      .filter(Boolean)
      .join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.geminiVerified"), "success", "verify");
  } catch (error) {
    state.agent.geminiVerified = false;
    state.agent.geminiVerificationMessage = error instanceof Error ? error.message : String(error);
    state.agent.authResult = [
      t("runtime.auth.geminiVerifyFail"),
      state.agent.geminiVerificationMessage
    ].join("\n");
    appendAgentOutputEntry(state.agent.authResult);
    setStatus(t("status.geminiVerifyFailed"), "error", "verify");
  } finally {
    setAgentBusy(false);
  }
}

function applyGeminiModel() {
  state.agent.geminiVerified = false;
  state.agent.geminiVerificationMessage = "";
  state.agent.authResult = t("runtime.model.geminiSwitched", {
    model: normalizeGeminiModelValue(state.agent.geminiModelId)
      || normalizeGeminiModelValue(state.agent.geminiDefaultModel)
      || t("runtime.model.cliDefault")
  });
  setStatus(t("status.geminiParamsUpdated"), "success", "save");
}

// ---------------------------------------------------------------------------
// OpenCode 操作
// ---------------------------------------------------------------------------

async function handleStartOpencode() {
  if (!state.desktop.isDesktop) {
    return;
  }

  opencodeAutoStartSuppressed = false;
  setAgentBusy(true);
  try {
    const status = await startOpencode(
      state.agent.binary.trim() || "opencode",
      state.agent.proxy || null
    );
    state.agent.installed = status.installed;
    state.agent.version = status.version || null;
    state.agent.running = status.running;
    state.agent.port = status.port || null;
    state.agent.binary = status.binary || "opencode";
    state.agent.sessionId = status.session_id || null;
    state.agent.output = [
      t("runtime.opencodeOutput"),
      `Binary: ${state.agent.binary}`,
      `Version: ${state.agent.version || "unknown"}`,
      `Port: ${state.agent.port || "unknown"}`,
      state.agent.proxy ? `Proxy: ${state.agent.proxy}` : ""
    ].join("\n");
    await refreshDesktopIntegration();
    setStatus(t("status.opencodeStarted"), "success", "start");
  } catch (error) {
    state.agent.output = t("runtime.refresh.opencodeStartFailed", { error: error instanceof Error ? error.message : String(error) });
    setStatus(t("status.opencodeStartFailed"), "error", "start");
  } finally {
    setAgentBusy(false);
  }
}

async function handleStopOpencode() {
  setAgentBusy(true);
  try {
    await stopOpencode();
    clearPendingBrowserAuth();
    runtimeWarmupState.opencode.ready = false;
    opencodeAutoStartSuppressed = true;
    state.agent.running = false;
    state.agent.sessionId = null;
    state.agent.output = t("runtime.opencodeStopped");
    await refreshDesktopIntegration();
    setStatus(t("status.opencodeStopped"), "idle", "stop");
  } catch (error) {
    state.agent.output = t("runtime.refresh.opencodeStopFailed", { error: error instanceof Error ? error.message : String(error) });
    setStatus(t("status.opencodeStopFailed"), "error", "stop");
  } finally {
    setAgentBusy(false);
  }
}

async function handleCreateSession() {
  if (activeRuntimeBackend.value !== "opencode") {
    setStatus(t("status.sessionNoPreCreate"), "warning", "create");
    return;
  }

  setAgentBusy(true);
  try {
    const result = await createOpencodeSession("DesignCode Local Agent", runtimeDirectory.value);
    state.agent.sessionId = result.id || result.sessionID || result.session?.id || state.agent.sessionId;
    if (state.design.currentId && state.agent.sessionId) {
      await persistDesignSession(state.design.currentId, state.agent.sessionId, "opencode");
      writeRuntimeSession("opencode", state.agent.sessionId);
      await refreshDesignLibrary();
    }
    state.agent.output = t("export.sessionCreated", { detail: JSON.stringify(result, null, 2) });
    await refreshDesktopIntegration();
    setStatus(t("status.opencodeSessionCreated"), "success", "create");
  } catch (error) {
    state.agent.output = t("runtime.refresh.sessionCreateFailed", { error: error instanceof Error ? error.message : String(error) });
    setStatus(t("status.opencodeSessionCreateFailed"), "error", "create");
  } finally {
    setAgentBusy(false);
  }
}

async function applySelectedModel() {
  if (!state.agent.providerId || !state.agent.modelId) {
    setStatus(t("status.selectProviderModel"), "warning", "save");
    return;
  }

  setAgentBusy(true);
  try {
    const currentProviderId = state.agent.providerId;
    const model = `${state.agent.providerId}/${state.agent.modelId}`;
    const nextConfig = cloneSnapshot(state.agent.opencodeConfig || {});
    nextConfig.model = model;

    if (state.agent.opencodeSmallModelId) {
      nextConfig.small_model = state.agent.opencodeSmallModelId;
    } else {
      delete nextConfig.small_model;
    }

    const providerConfig = cloneSnapshot(nextConfig.provider || {});
    const nextProviderConfig = cloneSnapshot(providerConfig[state.agent.providerId] || {});
    const nextProviderOptions = cloneSnapshot(nextProviderConfig.options || {});
    const trimmedBaseUrl = String(state.agent.opencodeProviderBaseUrl || "").trim();
    const enteredApiKey = String(state.agent.opencodeProviderApiKey || "").trim();
    const storedApiKeyResult = !enteredApiKey && state.agent.opencodeProviderApiKeySaved
      ? await getOpencodeStoredApiKey(currentProviderId)
      : null;
    const trimmedApiKey =
      enteredApiKey
      || String(storedApiKeyResult?.apiKey || "").trim()
      || readConfiguredOpenCodeProviderApiKey(currentProviderId);

    if (trimmedBaseUrl) {
      nextProviderOptions.baseURL = trimmedBaseUrl;
    } else {
      delete nextProviderOptions.baseURL;
    }

    if (trimmedApiKey) {
      nextProviderOptions.apiKey = trimmedApiKey;
    } else {
      delete nextProviderOptions.apiKey;
    }

    if (Object.keys(nextProviderOptions).length) {
      nextProviderConfig.options = nextProviderOptions;
    } else {
      delete nextProviderConfig.options;
    }

    if (Object.keys(nextProviderConfig).length) {
      providerConfig[state.agent.providerId] = nextProviderConfig;
    } else {
      delete providerConfig[state.agent.providerId];
    }

    if (Object.keys(providerConfig).length) {
      nextConfig.provider = providerConfig;
    } else {
      delete nextConfig.provider;
    }

    await updateOpencodeConfig({
      payload: nextConfig,
      directory: runtimeDirectory.value
    });
    const preferenceSnapshot = await updateOpencodePreferences({
      selectedProviderId: currentProviderId,
      selectedModelId: state.agent.modelId,
      smallModelId: state.agent.opencodeSmallModelId || "",
      providerId: currentProviderId,
      modelId: state.agent.modelId,
      baseUrl: trimmedBaseUrl,
      updateApiKey: Boolean(enteredApiKey),
      apiKey: enteredApiKey
    });
    state.agent.configModel = model;
    state.agent.configSmallModel = state.agent.opencodeSmallModelId || "";
    state.agent.opencodeConfig = cloneSnapshot(nextConfig);
    applyOpencodePreferenceSnapshot(preferenceSnapshot);
    state.agent.opencodeProviderApiKey = "";
    state.agent.opencodeProviderApiKeySaved = Boolean(trimmedApiKey);
    state.agent.authResult = [
      t("runtime.model.defaultModel", { model }),
      state.agent.opencodeSmallModelId ? t("runtime.model.smallModel", { model: state.agent.opencodeSmallModelId }) : t("runtime.model.smallModelNotSet"),
      trimmedBaseUrl ? t("runtime.model.baseUrlCustom", { provider: state.agent.providerId, url: trimmedBaseUrl }) : t("runtime.model.baseUrlDefault", { provider: state.agent.providerId }),
      enteredApiKey
        ? t("runtime.model.apiKeyWritten", { provider: state.agent.providerId })
        : trimmedApiKey
          ? t("runtime.model.apiKeyReused", { provider: state.agent.providerId })
          : t("runtime.model.apiKeyNotWritten", { provider: state.agent.providerId })
    ].join("\n");
    await refreshDesktopIntegration();
    setStatus(t("status.opencodeConfigUpdated"), "success", "save");
  } catch (error) {
    state.agent.authResult = t("runtime.refresh.opencodeConfigFailed", { error: error instanceof Error ? error.message : String(error) });
    setStatus(t("status.opencodeConfigUpdateFailed"), "error", "save");
  } finally {
    setAgentBusy(false);
  }
}

// ---------------------------------------------------------------------------
// 桌面集成刷新
// ---------------------------------------------------------------------------

async function refreshDesktopIntegration(options = {}) {
  const {
    skipProviderCatalog = false,
    skipSessionMessages = false
  } = options;

  try {
    state.desktop = {
      ...state.desktop,
      ...(await getDesktopContext())
    };

    if (!state.desktop.isDesktop) {
      return;
    }

    await loadOpencodePreferenceSnapshot();

    const [
      opencodeStatusResult,
      codexStatusResult,
      codexModelsResult,
      claudeStatusResult,
      geminiStatusResult
    ] = await Promise.allSettled([
      getOpencodeStatus(),
      getCodexStatus(state.agent.codexBinary.trim() || "codex"),
      listCodexModels(),
      getClaudeStatus(state.agent.claudeBinary.trim() || "claude"),
      getGeminiStatus(normalizedGeminiBinary())
    ]);

    const refreshErrors = [];

    if (opencodeStatusResult.status === "fulfilled") {
      const opencodeStatus = opencodeStatusResult.value;
      state.agent.installed = opencodeStatus.installed;
      state.agent.version = opencodeStatus.version || null;
      state.agent.running = opencodeStatus.running;
      runtimeWarmupState.opencode.ready = Boolean(opencodeStatus.running);
      state.agent.port = opencodeStatus.port || null;
      state.agent.binary = opencodeStatus.binary || state.agent.binary;
      state.agent.sessionId = state.design.currentId
        ? readRuntimeSession("opencode")
        : readRuntimeSession("opencode") ||
          opencodeStatus.session_id ||
          opencodeStatus.sessionId ||
          state.desktop.currentSessionId ||
          null;
    } else {
      refreshErrors.push(`OpenCode：${opencodeStatusResult.reason instanceof Error ? opencodeStatusResult.reason.message : String(opencodeStatusResult.reason)}`);
    }

    if (codexStatusResult.status === "fulfilled") {
      const codexModels = codexModelsResult.status === "fulfilled" ? codexModelsResult.value : [];
      applyCodexStatusSnapshot(codexStatusResult.value, codexModels);
      state.agent.codexThreadId = state.design.currentId
        ? readRuntimeSession("codex")
        : readRuntimeSession("codex") || state.agent.codexThreadId || null;
    } else {
      refreshErrors.push(`Codex：${codexStatusResult.reason instanceof Error ? codexStatusResult.reason.message : String(codexStatusResult.reason)}`);
    }

    if (claudeStatusResult.status === "fulfilled") {
      applyClaudeStatusSnapshot(claudeStatusResult.value);
      state.agent.claudeSessionId = state.design.currentId
        ? readRuntimeSession("claude")
        : readRuntimeSession("claude") || state.agent.claudeSessionId || null;
    } else {
      refreshErrors.push(`Claude：${claudeStatusResult.reason instanceof Error ? claudeStatusResult.reason.message : String(claudeStatusResult.reason)}`);
    }

    if (geminiStatusResult.status === "fulfilled") {
      applyGeminiStatusSnapshot(geminiStatusResult.value);
      state.agent.geminiSessionId = state.design.currentId
        ? readRuntimeSession("gemini")
        : readRuntimeSession("gemini") || state.agent.geminiSessionId || null;
    } else {
      refreshErrors.push(`Gemini：${geminiStatusResult.reason instanceof Error ? geminiStatusResult.reason.message : String(geminiStatusResult.reason)}`);
    }

    if (state.agent.running) {
      const directory = runtimeDirectory.value;
      const activeOpencodeSession = readRuntimeSession("opencode") || state.agent.sessionId;
      const [agentsResult, providerResult, messagesResult] = await Promise.allSettled([
        listOpencodeAgents(),
        skipProviderCatalog
          ? Promise.resolve(null)
          : Promise.all([
              listOpencodeProviders(directory),
              listOpencodeProviderAuth(directory),
              getOpencodeConfigProviders(directory),
              getOpencodeConfig(directory)
            ]),
        activeRuntimeBackend.value === "opencode" && activeOpencodeSession && !skipSessionMessages
          ? listOpencodeMessages(activeOpencodeSession, runtimeDirectory.value)
          : Promise.resolve(null)
      ]);

      if (agentsResult.status === "fulfilled") {
        const response = agentsResult.value;
        const list = Array.isArray(response) ? response : response.items || [];
        state.agent.agents = list.map((item) => item.id || item.name || String(item));
      } else {
        state.agent.output = t("runtime.refresh.agentsFailed", { error: agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason) });
      }

      if (!skipProviderCatalog) {
        if (providerResult.status === "fulfilled" && providerResult.value) {
          const [providerList, authMethods, configProviders, config] = providerResult.value;
          applyRuntimeCatalog(providerList, authMethods, configProviders, config);
        } else if (providerResult.status === "rejected") {
          state.agent.authResult = t("runtime.refresh.providerFailed", { error: providerResult.reason instanceof Error ? providerResult.reason.message : String(providerResult.reason) });
        }
      }

      if (messagesResult.status === "fulfilled" && messagesResult.value) {
        state.agent.outputDesignId = currentConversationScopeKey.value;
        state.agent.output = activeRuntimeBackend.value === "opencode"
          ? formatOpencodeMessagesForConsole(messagesResult.value) || inferAgentText(messagesResult.value)
          : inferAgentText(messagesResult.value);
      } else if (messagesResult.status === "rejected") {
        state.agent.outputDesignId = currentConversationScopeKey.value;
        state.agent.output = t("runtime.refresh.messagesFailed", { error: messagesResult.reason instanceof Error ? messagesResult.reason.message : String(messagesResult.reason) });
      }
    }

    syncActiveRuntimeSession();

    if (refreshErrors.length) {
      appendAgentOutputEntry(t("runtime.refresh.partialFailed", { errors: refreshErrors.join("；") }));
    }

    if (geminiStatusResult.status === "fulfilled") {
      const currentBinary = normalizedGeminiBinary();
      const currentProxy = state.agent.proxy || null;
      void Promise.race([
        listGeminiModels(currentBinary, currentProxy),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(t("runtime.refresh.geminiModelTimeout"))), 4000);
        })
      ])
        .then((models) => {
          applyGeminiModelsSnapshot(models);
        })
        .catch((error) => {
          appendAgentOutputEntry(t("runtime.refresh.geminiModelFailed", { error: error instanceof Error ? error.message : String(error) }));
        });
    }

    if (claudeStatusResult.status === "fulfilled" && state.agent.claudeInstalled) {
      const currentBinary = state.agent.claudeBinary.trim() || "claude";
      void Promise.race([
        listClaudeModels(currentBinary),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(t("runtime.refresh.claudeModelTimeout"))), 4000);
        })
      ])
        .then((catalog) => {
          applyClaudeModelsSnapshot(catalog);
        })
        .catch((error) => {
          appendAgentOutputEntry(t("runtime.refresh.claudeModelFailed", { error: error instanceof Error ? error.message : String(error) }));
        });
    }

    scheduleRuntimeWarmups();
  } catch (error) {
    appendAgentOutputEntry(t("runtime.refresh.desktopFailed", { error: error instanceof Error ? error.message : String(error) }));
  }
}

// ---------------------------------------------------------------------------
// 预热系统
// ---------------------------------------------------------------------------

function runtimeWarmupEligible(backend) {
  if (!state.desktop.isDesktop) {
    return false;
  }

  if (backend === "opencode") {
    return state.agent.installed;
  }

  if (backend === "codex") {
    return state.agent.codexInstalled && state.agent.codexLoggedIn;
  }

  if (backend === "claude") {
    return state.agent.claudeInstalled && state.agent.claudeLoggedIn;
  }

  if (backend === "gemini") {
    return state.agent.geminiInstalled && state.agent.geminiLoggedIn;
  }

  return false;
}

function runtimeWarmupPayload(backend) {
  const payload = {
    backend,
    directory: runtimeDirectory.value || state.desktop.projectDir || null,
    sessionId: readRuntimeSession(backend),
    model: null,
    effort: null,
    binary: null,
    proxy: state.agent.proxy || null
  };

  if (backend === "opencode") {
    payload.binary = state.agent.binary.trim() || "opencode";
    return payload;
  }

  if (backend === "codex") {
    payload.binary = state.agent.codexBinary.trim() || "codex";
    payload.model = state.agent.codexModelId || state.agent.codexDefaultModel || null;
    payload.effort = state.agent.codexReasoningEffort || state.agent.codexDefaultReasoningEffort || null;
    return payload;
  }

  if (backend === "claude") {
    payload.binary = state.agent.claudeBinary.trim() || "claude";
    payload.model = state.agent.claudeModelId || state.agent.claudeDefaultModel || null;
    payload.effort = state.agent.claudeEffort || state.agent.claudeDefaultEffort || null;
    return payload;
  }

  payload.binary = normalizedGeminiBinary();
  payload.model = normalizeGeminiModelValue(state.agent.geminiModelId)
    || normalizeGeminiModelValue(state.agent.geminiDefaultModel)
    || null;
  return payload;
}

function runtimeWarmupKey(payload) {
  return JSON.stringify([
    payload.backend,
    payload.directory || "",
    payload.sessionId || "",
    payload.model || "",
    payload.effort || "",
    payload.binary || "",
    payload.proxy || ""
  ]);
}

async function ensureRuntimeWarmup(backend, options = {}) {
  const {
    background = false
  } = options;

  if (!runtimeWarmupEligible(backend)) {
    return null;
  }

  const payload = runtimeWarmupPayload(backend);
  if (!payload.directory && backend !== "codex") {
    return null;
  }

  const key = runtimeWarmupKey(payload);
  const current = runtimeWarmupState[backend];
  if (current.ready && current.key === key) {
    return null;
  }

  if (runtimeWarmupPromises[backend]?.key === key) {
    return background ? null : runtimeWarmupPromises[backend].promise;
  }

  current.key = key;
  current.ready = false;
  const promise = warmRuntimeBackend(payload)
    .then((result) => {
      current.ready = true;
      if (backend === "opencode") {
        const wasRunning = state.agent.running;
        state.agent.running = Boolean(result?.ready);
        state.agent.port = result?.port || state.agent.port || null;
        state.agent.binary = result?.binary || state.agent.binary;
        if (!wasRunning && state.agent.running) {
          runInBackground(async () => {
            await refreshDesktopIntegration({ skipSessionMessages: true });
          });
        }
      }
      const sessionId = result?.sessionId || null;
      if (sessionId) {
        if (backend === "codex") {
          state.agent.codexThreadId = sessionId;
        } else if (backend === "claude") {
          state.agent.claudeSessionId = sessionId;
        } else if (backend === "gemini") {
          state.agent.geminiSessionId = sessionId;
        }
        writeRuntimeSession(backend, sessionId);
      }
      return result;
    })
    .catch((error) => {
      current.ready = false;
      appendAgentOutputEntry(
        t("export.warmupFailed", { backend: runtimeBackendDisplayName(backend), error: error instanceof Error ? error.message : String(error) })
      );
      throw error;
    })
    .finally(() => {
      if (runtimeWarmupPromises[backend]?.key === key) {
        runtimeWarmupPromises[backend] = null;
      }
    });

  runtimeWarmupPromises[backend] = { key, promise };
  return background ? null : promise;
}

function scheduleRuntimeWarmups() {
  const backends = ["codex", "claude", "gemini"];
  if (!opencodeAutoStartAttempted && !opencodeAutoStartSuppressed) {
    backends.unshift("opencode");
    opencodeAutoStartAttempted = true;
  }

  backends.forEach((backend) => {
    runInBackground(async () => {
      await ensureRuntimeWarmup(backend, { background: true });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI 调用
// ---------------------------------------------------------------------------

function activeCliBinary() {
  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexBinary.trim() || "codex";
  }
  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeBinary.trim() || "claude";
  }
  return normalizedGeminiBinary();
}

function activeCliModel() {
  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexModelId || state.agent.codexDefaultModel || null;
  }
  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeModelId || state.agent.claudeDefaultModel || null;
  }
  return state.agent.geminiModelId || null;
}

function activeCliEffort() {
  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexReasoningEffort || state.agent.codexDefaultReasoningEffort || null;
  }
  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeEffort || state.agent.claudeDefaultEffort || null;
  }
  return null;
}

function runtimeLoginReminder(backend = activeRuntimeBackend.value) {
  if (backend === "codex" && !state.agent.codexLoggedIn) {
    return t("runtime.auth.codexNotLoggedIn");
  }
  if (backend === "claude" && !state.agent.claudeLoggedIn) {
    return t("runtime.auth.claudeNotLoggedIn");
  }
  if (backend === "gemini" && !state.agent.geminiLoggedIn) {
    return t("runtime.auth.geminiNotLoggedIn");
  }
  return "";
}

async function sendActiveCliPrompt({ text, system, streamId }) {
  if (activeRuntimeBackend.value === "codex") {
    return sendCodexPrompt({
      threadId: readRuntimeSession("codex"),
      text,
      system,
      directory: runtimeDirectory.value,
      model: activeCliModel(),
      reasoningEffort: activeCliEffort(),
      binary: activeCliBinary(),
      proxy: state.agent.proxy || null,
      streamId
    });
  }

  if (activeRuntimeBackend.value === "claude") {
    return sendClaudePrompt({
      sessionId: readRuntimeSession("claude"),
      text,
      system,
      directory: runtimeDirectory.value,
      model: activeCliModel(),
      effort: activeCliEffort(),
      binary: activeCliBinary(),
      proxy: state.agent.proxy || null,
      streamId
    });
  }

  return sendGeminiPrompt({
    sessionId: readRuntimeSession("gemini"),
    text,
    system,
    directory: runtimeDirectory.value,
    model: activeCliModel(),
    binary: activeCliBinary(),
    proxy: state.agent.proxy || null,
    streamId
  });
}

// ---------------------------------------------------------------------------
// Agent 执行
// ---------------------------------------------------------------------------

async function runAgentPrompt() {
  const text = state.agentPrompt.trim();
  if (!text) {
    setStatus(t("status.enterAgentPrompt"), "warning", "input");
    return;
  }

  const runtimePromptBundle = buildPromptBundleForInstruction(
    text,
    hasDesign.value ? "edit" : "generate"
  );

  const instructionCreatedAt = new Date().toISOString();
  setAgentBusy(true);
  markConversationRuntimeScope();
  try {
    const flushed = await flushEditableHtmlChanges();
    if (!flushed) {
      return;
    }
    if (activeRuntimeBackend.value !== "opencode") {
      if (activeRuntimeBackend.value === "codex" && !state.agent.codexInstalled) {
        setStatus(t("status.noCodexDetected"), "warning", "login");
        return;
      }

      if (activeRuntimeBackend.value === "claude" && !state.agent.claudeInstalled) {
        setStatus(t("status.noClaudeDetected"), "warning", "login");
        return;
      }

      if (activeRuntimeBackend.value === "gemini" && !state.agent.geminiInstalled) {
        setStatus(t("status.noGeminiDetected"), "warning", "login");
        return;
      }

      if (activeRuntimeBackend.value === "codex" && !state.agent.codexLoggedIn) {
        setStatus(t("status.completeCodexLogin"), "warning", "login");
        return;
      }

      if (activeRuntimeBackend.value === "claude" && !state.agent.claudeLoggedIn) {
        setStatus(t("status.completeClaudeLogin"), "warning", "login");
        return;
      }
    } else if (!state.agent.installed) {
      setStatus(t("status.noOpencodeDetected"), "warning", "login");
      return;
    }

    setStatus(t("status.waitingWarmup", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "busy");
    await ensureRuntimeWarmup(activeRuntimeBackend.value);

    if (activeRuntimeBackend.value !== "opencode") {
      const streamId = nextCodexStreamId();
      await beginCliStream(streamId, activeRuntimeBackend.value, [
        text,
        runtimePromptBundle?.userMessage || ""
      ]);
      appendAgentOutputLine(
        `[${activeRuntimeBackend.value}] Agent is running with ${activeCliModel() || "default model"}`
        + `${activeCliEffort() ? ` · ${activeCliEffort()}` : ""}...`
      );
      const result = await sendActiveCliPrompt({
        text,
        system: runtimePromptBundle?.systemPrompt || "",
        streamId
      });
      endCliStream();
      const sessionId = result.threadId || result.sessionId || activeRuntimeSessionId.value;
      if (sessionId) {
        applyCliSessionToState(sessionId);
        if (state.design.currentId) {
          await persistDesignSession(state.design.currentId, sessionId, activeRuntimeBackend.value);
        }
      }

      if (result.output) {
        appendAgentOutputLine("");
        appendAgentOutputLine(`[final] ${sanitizeAgentConsoleMessage(result.output) || t("chat.requestCompleted")}`);
      } else if (!state.agent.output) {
        state.agent.output = t("chat.codexExecuted");
      }

      if (state.design.currentId) {
        const synced = await syncDesignWorkspaceSnapshot({
          ...buildPayload({
            designId: state.design.currentId,
            sessionId: sessionId || activeRuntimeSessionId.value
          }),
          instruction: text,
          promptBundle: runtimePromptBundle || null,
          assistantBlocks: serializeConversationBlocksForStorage(state.agent.streamBlocks),
          summary: summarizeCliResultOutput(
            result.output,
            `${runtimeBackendDisplayName(activeRuntimeBackend.value)} workspace updated.`
          ),
          instructionCreatedAt,
          assistantCreatedAt: new Date().toISOString()
        });
        applyOpenedDesignRecord(synced, {
          activeCommitHash: synced.commits?.[synced.commits.length - 1]?.commitHash
        });
        await refreshDesignLibrary();
      }
      setStatus(t("status.agentExecuted", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "success");
      return;
    }

    if (!state.agent.sessionId) {
      await handleCreateSession();
      if (!state.agent.sessionId) {
        return;
      }
    }

    const streamId = nextCodexStreamId();
    await beginCliStream(streamId, "opencode", [
      text,
      runtimePromptBundle?.userMessage || ""
    ]);
    appendAgentOutputLine("[opencode] Agent is running...");
    const result = await sendOpencodePrompt({
      sessionId: state.agent.sessionId,
      agent: state.agent.selectedAgent,
      text,
      system: runtimePromptBundle?.systemPrompt || "",
      directory: runtimeDirectory.value,
      streamId
    });
    endCliStream();
    const messages = await listOpencodeMessages(state.agent.sessionId, runtimeDirectory.value);
    appendAgentOutputLine("");
    appendAgentOutputLine(`[final] ${sanitizeAgentConsoleMessage(inferAgentText(result)) || t("chat.requestCompleted")}`);
    const mergedOutput = `${state.agent.output}\n${inferAgentText(messages)}`.trim();
    state.agent.output = mergedOutput;
    if (state.design.currentId) {
      const synced = await syncDesignWorkspaceSnapshot({
        ...buildPayload({
          designId: state.design.currentId,
          sessionId: state.agent.sessionId
        }),
        instruction: text,
        promptBundle: runtimePromptBundle || null,
        assistantBlocks: serializeConversationBlocksForStorage(state.agent.streamBlocks),
        summary: inferAgentText(messages) || inferAgentText(result) || "OpenCode workspace updated.",
        instructionCreatedAt,
        assistantCreatedAt: new Date().toISOString()
      });
      applyOpenedDesignRecord(synced, {
        activeCommitHash: synced.commits?.[synced.commits.length - 1]?.commitHash
      });
      await refreshDesignLibrary();
    }
    setStatus(t("status.opencodeAgentExecuted"), "success", "connect");
  } catch (error) {
    if (activeRuntimeBackend.value !== "opencode") {
      endCliStream();
    } else {
      endCliStream();
    }
    const message = t("export.agentRunFailed", { error: error instanceof Error ? error.message : String(error) });
    state.agent.output = state.agent.output ? `${state.agent.output}\n${message}` : message;
    setStatus(t("status.agentFailed", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "error");
  } finally {
    setAgentBusy(false);
  }
}

async function runAgentShell() {
  const command = state.agentPrompt.trim();
  if (!command) {
    setStatus(t("status.enterShellCommand"), "warning", "input");
    return;
  }

  const shellPromptBundle = buildPromptBundleForInstruction("", "generate");
  const instructionCreatedAt = new Date().toISOString();

  if (command.startsWith("/")) {
    state.agent.output = [
      t("runtime.shell.notShellHint1"),
      t("runtime.shell.notShellHint2", { command }),
      t("runtime.shell.notShellHint3")
    ].join("\n");
    setStatus(t("status.notShellCommand"), "warning", "input");
    return;
  }

  setAgentBusy(true);
  markConversationRuntimeScope();
  try {
    const flushed = await flushEditableHtmlChanges();
    if (!flushed) {
      return;
    }
    if (activeRuntimeBackend.value !== "opencode") {
      setStatus(t("status.waitingWarmup", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "busy");
      await ensureRuntimeWarmup(activeRuntimeBackend.value);
      const streamId = nextCodexStreamId();
      await beginCliStream(streamId, activeRuntimeBackend.value, [command]);
      appendAgentOutputLine(
        `[${activeRuntimeBackend.value}] Running shell task inside agent with ${activeCliModel() || "default model"}`
        + `${activeCliEffort() ? ` · ${activeCliEffort()}` : ""}...`
      );
      const result = await sendActiveCliPrompt({
        text: [
          "[Shell Task]",
          t("chat.shellExecHint1"),
          t("chat.shellExecHint2"),
          t("chat.shellExecHint3"),
          "",
          command
        ].join("\n"),
        system: shellPromptBundle?.systemPrompt || "",
        streamId
      });
      endCliStream();
      const sessionId = result.threadId || result.sessionId || activeRuntimeSessionId.value;
      if (sessionId) {
        applyCliSessionToState(sessionId);
        if (state.design.currentId) {
          await persistDesignSession(state.design.currentId, sessionId, activeRuntimeBackend.value);
        }
      }
      if (result.output) {
        appendAgentOutputLine("");
        appendAgentOutputLine(`[final] ${sanitizeAgentConsoleMessage(result.output) || t("chat.shellCompleted")}`);
      } else if (!state.agent.output) {
        state.agent.output = t("chat.codexShellExecuted");
      }

      if (state.design.currentId) {
        const synced = await syncDesignWorkspaceSnapshot({
          ...buildPayload({
            designId: state.design.currentId,
            sessionId: sessionId || activeRuntimeSessionId.value
          }),
          instruction: `shell: ${command}`,
          assistantBlocks: serializeConversationBlocksForStorage(state.agent.streamBlocks),
          summary: summarizeCliResultOutput(
            result.output,
            `${runtimeBackendDisplayName(activeRuntimeBackend.value)} shell task completed.`
          ),
          instructionCreatedAt,
          assistantCreatedAt: new Date().toISOString()
        });
        applyOpenedDesignRecord(synced, {
          activeCommitHash: synced.commits?.[synced.commits.length - 1]?.commitHash
        });
        await refreshDesignLibrary();
      }
      setStatus(t("status.shellExecuted", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "success");
      return;
    }

    if (!state.agent.installed) {
      setStatus(t("status.noOpencodeDetected"), "warning", "login");
      return;
    }

    setStatus(t("status.waitingOpencodeWarmup"), "busy", "start");
    await ensureRuntimeWarmup("opencode");

    if (!state.agent.sessionId) {
      await handleCreateSession();
      if (!state.agent.sessionId) {
        return;
      }
    }

    const streamId = nextCodexStreamId();
    await beginCliStream(streamId, "opencode", [command]);
    appendAgentOutputLine("[opencode] Running shell task inside agent...");
    const result = await runOpencodeShell({
      sessionId: state.agent.sessionId,
      command,
      directory: runtimeDirectory.value,
      streamId
    });
    endCliStream();
    appendAgentOutputLine("");
    appendAgentOutputLine(`[final] ${sanitizeAgentConsoleMessage(inferAgentText(result)) || t("chat.shellCompleted")}`);
    if (state.design.currentId) {
      const synced = await syncDesignWorkspaceSnapshot({
        ...buildPayload({
          designId: state.design.currentId,
          sessionId: state.agent.sessionId
        }),
        instruction: `shell: ${command}`,
        assistantBlocks: serializeConversationBlocksForStorage(state.agent.streamBlocks),
        summary: inferAgentText(result) || "Shell command completed.",
        instructionCreatedAt,
        assistantCreatedAt: new Date().toISOString()
      });
      applyOpenedDesignRecord(synced, {
        activeCommitHash: synced.commits?.[synced.commits.length - 1]?.commitHash
      });
      await refreshDesignLibrary();
    }
    state.agent.output = `${state.agent.output}\n${inferAgentText(result)}`.trim();
    setStatus(t("status.opencodeShellExecuted"), "success", "connect");
  } catch (error) {
    endCliStream();
    const message = t("export.shellRunFailed", { error: error instanceof Error ? error.message : String(error) });
    state.agent.output = state.agent.output ? `${state.agent.output}\n${message}` : message;
    setStatus(t("status.shellFailed", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }), "error");
  } finally {
    setAgentBusy(false);
  }
}

// ---------------------------------------------------------------------------
// 设计代理会话
// ---------------------------------------------------------------------------

async function ensureDesignAgentSession() {
  if (
    activeRuntimeBackend.value !== "opencode" ||
    !state.desktop.isDesktop ||
    !state.agent.running ||
    !state.design.currentId ||
    readRuntimeSession("opencode")
  ) {
    return;
  }

  try {
    const result = await createOpencodeSession(
      `DesignCode ${state.design.currentId}`,
      state.design.workspaceDir
    );
    const sessionId = result.id || result.sessionID || result.session?.id || null;
    if (!sessionId) {
      return;
    }

    await persistDesignSession(state.design.currentId, sessionId, "opencode");
    writeRuntimeSession("opencode", sessionId);
    await refreshDesignLibrary();
  } catch (error) {
    state.agent.output = t("export.bindSessionFailed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// hydrateFromMeta — 从 meta 数据恢复状态
// ---------------------------------------------------------------------------

function hydrateFromMeta(meta) {
  if (!meta) {
    return;
  }

  state.sizeId = meta.sizeId || "";
  state.customSize = meta.customSize
    ? { ...makeDefaultCustomSize(), ...meta.customSize }
    : makeDefaultCustomSize();
  state.fieldDefinitions = templateFieldDefinitions(meta.fields || {}, meta.fieldDefinitions || []);
  state.fields = templateFieldDefaults(meta.fields || {}, state.fieldDefinitions);

  if (meta.styleId) {
    const style = findExactById(styles.value, meta.styleId);
    if (style) {
      state.styleId = style.id;
    }
  } else {
    state.styleId = "";
  }

  state.brief = meta.brief || "";
}

// ---------------------------------------------------------------------------
// Bootstrap — 主初始化函数
// ---------------------------------------------------------------------------

async function bootstrap() {
  setStatus(t("status.loadingWorkbench"), "busy", "load");

  loadRuntimeProxyPortPreference();
  const catalog = await getCatalog();
  state.catalog = catalog;
  resetDesignConfiguration();
  const [, , designs] = await Promise.all([
    refreshArtAssetLibrary(),
    refreshDesktopIntegration({ skipSessionMessages: true }),
    refreshDesignLibrary()
  ]);
  if (designs.length) {
    await openDesignRecord(designs[0].id);
  }
  setStatus(t("status.workbenchReady"), "idle", "load");
}

// ---------------------------------------------------------------------------
// 导出 composable
// ---------------------------------------------------------------------------

export function useRuntimeAgent() {
  return {
    // 代理端口管理
    normalizeProxyPort,
    loadRuntimeProxyPortPreference,
    persistRuntimeProxyPortPreference,
    applyProxyPort,
    restartOpencodeWithCurrentProxy,

    // OpenCode 操作
    handleStartOpencode,
    handleStopOpencode,
    handleCreateSession,
    applySelectedModel,
    refreshDesktopIntegration,
    syncOpenCodeProviderBaseUrl,
    syncOpenCodeProviderApiKey,

    // Codex 操作
    handleOpenCodexLogin,
    handleVerifyCodex,
    applyCodexModel,
    applyCodexStatusSnapshot,
    syncCodexModelSelection,
    syncCodexReasoningSelection,

    // Claude 操作
    handleOpenClaudeLogin,
    handleVerifyClaude,
    applyClaudeModel,
    applyClaudeStatusSnapshot,
    applyClaudeModelsSnapshot,

    // Gemini 操作
    handleOpenGeminiLogin,
    handleVerifyGemini,
    applyGeminiModel,
    applyGeminiStatusSnapshot,
    applyGeminiModelsSnapshot,
    normalizedGeminiBinary,

    // 预热系统
    runtimeWarmupEligible,
    runtimeWarmupPayload,
    runtimeWarmupKey,
    ensureRuntimeWarmup,
    scheduleRuntimeWarmups,

    // CLI 调用
    sendActiveCliPrompt,
    activeCliBinary,
    activeCliModel,
    activeCliEffort,
    runtimeLoginReminder,

    // Agent 执行
    runAgentPrompt,
    runAgentShell,

    // Provider 管理
    applyRuntimeCatalog,
    syncRuntimeModelSelection,

    // 设计代理会话
    ensureDesignAgentSession,

    // Bootstrap
    bootstrap,
    hydrateFromMeta,

    // 辅助函数（模板和 watch 中使用）
    setRuntimeBackend,
    readRuntimeSession,
    writeRuntimeSession,
    resolvedGeminiModelLabel,
    clearPendingBrowserAuth,
    applyProviderConnectionSnapshot,
    applyCliSessionToState,
    syncOpenCodeSmallModelSelection,
  };
}
