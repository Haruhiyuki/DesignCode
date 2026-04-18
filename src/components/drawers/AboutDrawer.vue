<script setup>
// 关于抽屉 — 版本信息、更新检查。
import { ref, onMounted } from "vue";
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useAppUpdate } from "../../composables/useAppUpdate.js";

const { state } = useWorkspaceState();
const { updateState, doCheckForUpdates, doInstallUpdate, doRelaunch, openUpdateUrl } = useAppUpdate();

// 版本号从 Tauri 运行时读取——唯一的真实源是 tauri.conf.json（由发版脚本统一改写）。
// 不再硬编码 fallback，避免每次 bump 漏改。
const runtimeVersion = ref("");
onMounted(async () => {
  try {
    const mod = await import("@tauri-apps/api/app");
    runtimeVersion.value = await mod.getVersion();
  } catch (_error) {
    runtimeVersion.value = "";
  }
});
</script>

<template>
  <section class="drawer-section about-section">
    <div class="about-hero">
      <img class="about-logo-img" src="/src-tauri/icons/128x128.png" alt="DesignCode" />
      <h3 class="about-name">DesignCode</h3>
      <p class="about-version">v{{ updateState.result?.currentVersion || runtimeVersion || "—" }}</p>
      <p class="about-tagline">{{ t("about.tagline") }}</p>
    </div>

    <div v-if="state.desktop.isDesktop" class="about-update-row">
      <button
        v-if="!updateState.installed"
        type="button"
        class="about-update-button"
        :disabled="updateState.checking || updateState.installing"
        @click="doCheckForUpdates(state.agent.proxy)"
      >
        {{ updateState.checking ? t("update.checking") : t("update.checkButton") }}
      </button>

      <template v-if="updateState.installed">
        <p class="about-update-available">{{ t("update.restartRequired") }}</p>
        <button type="button" class="about-update-button" @click="doRelaunch">{{ t("update.restartButton") }}</button>
      </template>

      <template v-else-if="updateState.installing">
        <p class="about-update-installing">{{ t("update.installing") }}</p>
        <div v-if="updateState.progress && updateState.progress.total" class="about-update-progress">
          <div class="about-update-progress-bar">
            <div class="about-update-progress-fill" :style="{ width: Math.round(updateState.progress.downloaded / updateState.progress.total * 100) + '%' }"></div>
          </div>
          <small>{{ Math.round(updateState.progress.downloaded / 1024 / 1024) }} / {{ Math.round(updateState.progress.total / 1024 / 1024) }} MB</small>
        </div>
      </template>

      <template v-else-if="updateState.result">
        <p v-if="updateState.result.checkError" class="about-update-error">{{ t("update.checkFailed", { error: updateState.result.checkError }) }}</p>
        <template v-else-if="updateState.result.updateAvailable">
          <p class="about-update-available">{{ t("update.available", { version: updateState.result.latestVersion }) }}</p>
          <button type="button" class="about-update-button" @click="doInstallUpdate">{{ t("update.installButton") }}</button>
          <button v-if="updateState.result.releaseUrl" type="button" class="about-update-button about-update-button-ghost" @click="openUpdateUrl">{{ t("update.viewRelease") }}</button>
        </template>
        <p v-else class="about-update-current">{{ t("update.upToDate") }}</p>
      </template>
    </div>

    <div class="about-block">
      <strong>{{ t("about.introTitle") }}</strong>
      <p class="about-intro">{{ t("about.intro") }}</p>
      <p class="about-intro">{{ t("about.introScope") }}</p>
    </div>

    <div class="about-block">
      <strong>{{ t("about.copyright") }}</strong>
      <p>&copy; 2026 DesignCode contributors.</p>
      <p class="about-legal">{{ t("about.publisher") }}</p>
      <p class="about-legal">{{ t("about.publisherDetail") }}</p>
      <p class="about-legal">{{ t("about.publisherLink") }}</p>
    </div>

    <div class="about-block">
      <strong>{{ t("about.license") }}</strong>
      <p>Apache License 2.0</p>
      <p class="about-legal">{{ t("about.licenseNotice") }}</p>
    </div>

    <div class="about-block">
      <strong>{{ t("about.thirdParty") }}</strong>
      <p class="about-legal">{{ t("about.thirdPartyDetail") }}</p>
      <p class="about-legal">{{ t("about.claudeNotice") }}</p>
    </div>
  </section>
</template>
