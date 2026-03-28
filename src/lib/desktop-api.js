// 桌面端 API 层 — 封装所有 Tauri invoke 调用和 Web fallback。
// Tauri 环境走 invoke()，浏览器环境走 fetch()。

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

async function invoke(command, payload) {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error("Tauri runtime is not available.");
  }

  return tauri.core.invoke(command, payload);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    if (!text) {
      throw new Error("Request failed");
    }

    let message = text;
    try {
      const payload = JSON.parse(text);
      message = payload.error || payload.message || text;
    } catch {}

    throw new Error(message);
  }
  return response.json();
}

export async function getCatalog() {
  if (isTauriRuntime()) {
    return invoke("desktop_catalog");
  }

  return fetchJson("/api/catalog");
}

export async function generateDesign(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_generate_design", { payload });
  }

  return fetchJson("/api/design/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function editDesign(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_edit_design", { payload });
  }

  return fetchJson("/api/design/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function listDesignSessions() {
  if (isTauriRuntime()) {
    return invoke("desktop_designs_list");
  }

  return fetchJson("/api/designs");
}

export async function createDesignSession(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_create", {
      payload
    });
  }

  return fetchJson("/api/designs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function openDesignSession(designId) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_open", {
      designId
    });
  }

  return fetchJson(`/api/designs/${encodeURIComponent(designId)}`);
}

export async function deleteDesignSession(designId) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_delete", {
      designId
    });
  }

  return fetchJson(`/api/designs/${encodeURIComponent(designId)}`, {
    method: "DELETE"
  });
}

export async function updateDesignSession(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_update", {
      designId: payload.designId,
      payload
    });
  }

  return fetchJson(`/api/designs/${encodeURIComponent(payload.designId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateDesignHtml(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_update_html", {
      payload
    });
  }

  return fetchJson("/api/designs/update-html", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function readDesignCommit(designId, commitHash) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_commit_read", {
      designId,
      commitHash
    });
  }

  return fetchJson(
    `/api/designs/${encodeURIComponent(designId)}/commits/${encodeURIComponent(commitHash)}`
  );
}

export async function attachDesignSession(designId, sessionId, runtimeBackend) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_attach_session", {
      designId,
      sessionId,
      runtimeBackend: runtimeBackend || null
    });
  }

  return fetchJson("/api/designs/attach-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      designId,
      sessionId,
      runtimeBackend: runtimeBackend || null
    })
  });
}

export async function syncDesignWorkspace(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_design_sync_workspace", {
      payload
    });
  }

  return fetchJson("/api/designs/sync-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function listArtAssets() {
  if (isTauriRuntime()) {
    return invoke("desktop_art_assets_list");
  }

  return fetchJson("/api/art-assets");
}

export async function importArtAsset(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_art_asset_import", { payload });
  }

  return fetchJson("/api/art-assets/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function importArtAssetsFromPaths(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_art_asset_import_paths", { payload });
  }

  return fetchJson("/api/art-assets/import-paths", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function updateArtAsset(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_art_asset_update", { payload });
  }

  return fetchJson("/api/art-assets/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function deleteArtAsset(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_art_asset_delete", { payload });
  }

  return fetchJson("/api/art-assets/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function readArtAssetPreview(payload) {
  if (isTauriRuntime()) {
    return invoke("desktop_art_asset_preview", { payload });
  }

  return fetchJson("/api/art-assets/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function getDesktopContext() {
  if (!isTauriRuntime()) {
    return {
      isDesktop: false,
      nodeAvailable: true,
      nodeVersion: "browser",
      opencodeAvailable: false,
      opencodeVersion: null,
      opencodeRunning: false,
      opencodePort: null,
      projectDir: null,
      currentSessionId: null
    };
  }

  return invoke("desktop_context");
}

export async function getOpencodeStatus() {
  if (!isTauriRuntime()) {
    return {
      installed: false,
      running: false,
      port: null,
      sessionId: null
    };
  }

  return invoke("opencode_status");
}

export async function getCodexStatus(binary) {
  if (!isTauriRuntime()) {
    return {
      installed: false,
      version: null,
      binary: binary || "codex",
      loggedIn: false,
      loginStatus: "Tauri runtime is not available.",
      authMethod: null,
      defaultModel: null,
      defaultReasoningEffort: null
    };
  }

  return invoke("codex_status", {
    binary: binary || null
  });
}

export async function getClaudeStatus(binary) {
  if (!isTauriRuntime()) {
    return {
      installed: false,
      version: null,
      binary: binary || "claude",
      loggedIn: false,
      loginStatus: "Tauri runtime is not available.",
      authMethod: null,
      defaultModel: null,
      defaultEffort: null
    };
  }

  return invoke("claude_status", {
    binary: binary || null
  });
}

export async function getGeminiStatus(binary) {
  if (!isTauriRuntime()) {
    return {
      installed: false,
      version: null,
      binary: binary || "gemini",
      loggedIn: false,
      loginStatus: "Tauri runtime is not available.",
      authMethod: null,
      defaultModel: null,
      defaultEffort: null
    };
  }

  return invoke("gemini_status", {
    binary: binary || null
  });
}

export async function listCodexModels() {
  if (!isTauriRuntime()) {
    return [];
  }

  return invoke("codex_models");
}

export async function listClaudeModels(binary) {
  if (!isTauriRuntime()) {
    return {
      availableModels: [],
      availableEfforts: [],
      currentModelId: null,
      currentEffort: null
    };
  }

  return invoke("claude_models", {
    binary: binary || null
  });
}

export async function listGeminiModels(binary, proxy = null) {
  if (!isTauriRuntime()) {
    return {
      availableModels: [],
      currentModelId: null
    };
  }

  return invoke("gemini_models", {
    binary: binary || null,
    proxy: proxy || null
  });
}

export async function openCodexLogin(binary, deviceAuth = false, proxy = null) {
  return invoke("codex_open_login", {
    binary: binary || null,
    deviceAuth,
    proxy: proxy || null
  });
}

export async function openClaudeLogin(binary, proxy = null) {
  return invoke("claude_open_login", {
    binary: binary || null,
    proxy: proxy || null
  });
}

export async function openGeminiLogin(binary, proxy = null) {
  return invoke("gemini_open_login", {
    binary: binary || null,
    proxy: proxy || null
  });
}

export async function verifyCodex(binary, model, reasoningEffort = null, proxy = null) {
  return invoke("codex_verify", {
    binary: binary || null,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    proxy: proxy || null
  });
}

export async function verifyClaude(binary, model, effort = null, proxy = null) {
  return invoke("claude_verify", {
    binary: binary || null,
    model: model || null,
    effort: effort || null,
    proxy: proxy || null
  });
}

export async function verifyGemini(binary, model, proxy = null) {
  return invoke("gemini_verify", {
    binary: binary || null,
    model: model || null,
    proxy: proxy || null
  });
}

export async function updateCodexSettings(binary, model, reasoningEffort) {
  return invoke("codex_update_settings", {
    binary: binary || null,
    model: model || null,
    reasoningEffort: reasoningEffort || null
  });
}

export async function startOpencode(binary, proxy) {
  return invoke("opencode_start", {
    binary: binary || null,
    proxy: proxy || null,
    port: null
  });
}

export async function stopOpencode() {
  return invoke("opencode_stop");
}

export async function listOpencodeAgents() {
  return invoke("opencode_agents");
}

export async function createOpencodeSession(title, directory) {
  return invoke("opencode_create_session", {
    title: title || null,
    directory: directory || null
  });
}

export async function sendCodexPrompt({ threadId, text, system, directory, model, reasoningEffort, binary, proxy, streamId }) {
  return invoke("codex_send_prompt", {
    threadId: threadId || null,
    text,
    system: system || null,
    directory,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    binary: binary || null,
    proxy: proxy || null,
    streamId: streamId || null
  });
}

export async function sendClaudePrompt({ sessionId, text, system, directory, model, effort, binary, proxy, streamId }) {
  return invoke("claude_send_prompt", {
    sessionId: sessionId || null,
    text,
    system: system || null,
    directory,
    model: model || null,
    effort: effort || null,
    binary: binary || null,
    proxy: proxy || null,
    streamId: streamId || null
  });
}

export async function sendGeminiPrompt({ sessionId, text, system, directory, model, binary, proxy, streamId }) {
  return invoke("gemini_send_prompt", {
    sessionId: sessionId || null,
    text,
    system: system || null,
    directory,
    model: model || null,
    binary: binary || null,
    proxy: proxy || null,
    streamId: streamId || null
  });
}

export async function warmRuntimeBackend({ backend, directory, sessionId, model, effort, binary, proxy }) {
  return invoke("runtime_warmup", {
    backend,
    directory: directory || null,
    sessionId: sessionId || null,
    model: model || null,
    effort: effort || null,
    binary: binary || null,
    proxy: proxy || null
  });
}

export async function listenCliOutput(handler) {
  const tauri = window.__TAURI__;
  if (!tauri?.event?.listen) {
    return () => {};
  }

  return tauri.event.listen("designcode://cli-output", (event) => {
    handler(event.payload);
  });
}

export const listenCodexOutput = listenCliOutput;

export async function listenDesktopEvent(eventName, handler) {
  const tauri = window.__TAURI__;
  if (!tauri?.event?.listen) {
    return () => {};
  }

  return tauri.event.listen(eventName, (event) => {
    handler(event.payload);
  });
}

export async function listOpencodeProviders(directory) {
  return invoke("opencode_provider_list", {
    directory: directory || null
  });
}

export async function listOpencodeProviderAuth(directory) {
  return invoke("opencode_provider_auth", {
    directory: directory || null
  });
}

export async function authorizeOpencodeProvider({ providerId, method, directory, openBrowser = false }) {
  return invoke("opencode_provider_authorize", {
    providerId,
    method,
    directory: directory || null,
    openBrowser
  });
}

export async function getOpencodeAuthDiagnostic(providerId) {
  return invoke("opencode_auth_diagnostic", {
    providerId: providerId || null
  });
}

export async function getOpencodeConfig(directory) {
  return invoke("opencode_config_get", {
    directory: directory || null
  });
}

export async function getOpencodeConfigProviders(directory) {
  return invoke("opencode_config_providers", {
    directory: directory || null
  });
}

export async function updateOpencodeConfig({ payload, directory }) {
  return invoke("opencode_config_update", {
    payload,
    directory: directory || null
  });
}

export async function getOpencodePreferences() {
  return invoke("opencode_preferences_get");
}

export async function updateOpencodePreferences(payload) {
  return invoke("opencode_preferences_update", {
    payload
  });
}

export async function getOpencodeStoredApiKey(providerId) {
  return invoke("opencode_provider_secret_get", {
    providerId
  });
}

export async function sendOpencodePrompt({ sessionId, agent, text, system, directory, streamId }) {
  return invoke("opencode_send_prompt", {
    sessionId,
    agent: agent || null,
    text,
    system: system || null,
    directory: directory || null,
    streamId: streamId || null
  });
}

export async function runOpencodeShell({ sessionId, command, directory, streamId }) {
  return invoke("opencode_run_shell", {
    sessionId,
    command,
    directory: directory || null,
    streamId: streamId || null
  });
}

export async function listRuntimeApprovals({ backend, sessionId, directory }) {
  return invoke("runtime_list_approvals", {
    backend,
    sessionId: sessionId || null,
    directory: directory || null
  });
}

export async function replyRuntimeApproval({ backend, sessionId, approvalId, decision, directory }) {
  return invoke("runtime_reply_approval", {
    backend,
    sessionId: sessionId || null,
    approvalId,
    decision,
    directory: directory || null
  });
}

export async function runWorkspaceShell({ command, directory }) {
  return invoke("workspace_shell_exec", {
    command,
    directory
  });
}

export async function listOpencodeMessages(sessionId, directory) {
  return invoke("opencode_messages", {
    sessionId,
    directory: directory || null
  });
}

export async function checkForUpdates(proxy) {
  return invoke("check_for_updates", { proxy: proxy || null });
}

export async function checkAndInstallUpdate(onProgress) {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update?.available) {
    return { available: false };
  }

  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started" && event.data?.contentLength) {
      total = event.data.contentLength;
    } else if (event.event === "Progress" && event.data?.chunkLength) {
      downloaded += event.data.chunkLength;
      if (onProgress) {
        onProgress({ downloaded, total });
      }
    }
  });

  return { available: true, version: update.version };
}

export async function relaunchApp() {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export async function rebuildNativeMenu(locale) {
  return invoke("rebuild_menu", { locale });
}

export async function getSystemLocale() {
  return invoke("get_system_locale");
}

export async function listenMenuAction(handler) {
  const tauri = window.__TAURI__;
  if (!tauri?.event?.listen) {
    return () => {};
  }

  return tauri.event.listen("designcode://menu-action", (event) => {
    handler(event.payload);
  });
}

export { isTauriRuntime };
