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
    updateState.result = {
      currentVersion: "1.0.3",
      updateAvailable: false,
      checkError: e.message || String(e)
    };
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
