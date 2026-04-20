// 应用自动更新 — 检查 GitHub release、下载安装、重启。
import { reactive } from "vue";
import {
  checkForUpdates,
  checkAndInstallUpdate,
  relaunchApp
} from "../lib/desktop-api.js";

const updateState = reactive({
  checking: false,
  installing: false,
  installed: false,
  progress: null,
  result: null,
  lastChecked: null
});

async function doCheckForUpdates(proxyValue) {
  if (updateState.checking || updateState.installing) {
    return;
  }

  updateState.checking = true;

  try {
    updateState.result = await checkForUpdates(proxyValue || null);
    updateState.lastChecked = Date.now();
  } catch (e) {
    // 真实版本号由 Tauri 运行时决定；这里兜底字段不再硬编码（写死的字符串
    // 每次 bump 都得记得改，容易漏）。留空由调用方补默认 "—"。
    let runtimeVersion = "";
    try {
      const mod = await import("@tauri-apps/api/app");
      runtimeVersion = await mod.getVersion();
    } catch {}
    updateState.result = {
      currentVersion: runtimeVersion,
      updateAvailable: false,
      checkError: e.message || String(e)
    };
    // "检查更新"按钮经常被用户吐槽"没反应"，把原因灌进会话控制台日志便于反馈。
    import("./useCliStream.js")
      .then((mod) => mod.useCliStream().logSessionError("update-check", e))
      .catch(() => {});
  } finally {
    updateState.checking = false;
  }
}

async function doInstallUpdate() {
  if (updateState.installing) {
    return;
  }

  updateState.installing = true;
  updateState.progress = { downloaded: 0, total: 0 };

  try {
    const result = await checkAndInstallUpdate((progress) => {
      updateState.progress = progress;
    });

    if (result.available) {
      updateState.installed = true;
    }
  } catch (e) {
    updateState.result = {
      ...updateState.result,
      checkError: e.message || String(e)
    };
    import("./useCliStream.js")
      .then((mod) => mod.useCliStream().logSessionError("update-install", e))
      .catch(() => {});
  } finally {
    updateState.installing = false;
  }
}

async function doRelaunch() {
  try {
    await relaunchApp();
  } catch {}
}

function openUpdateUrl() {
  const url = updateState.result?.downloadUrl || updateState.result?.releaseUrl;
  if (url) {
    window.open(url, "_blank");
  }
}

export function useAppUpdate() {
  return {
    updateState,
    doCheckForUpdates,
    doInstallUpdate,
    doRelaunch,
    openUpdateUrl
  };
}
