<script setup>
// Prompt 抽屉 — 系统提示词编辑、prompt bundle 预览。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";

const { state } = useWorkspaceState();
const { promptPreviewText, versionMetaLabel } = useSetupConfig();
const { restoreVersion } = useDesignSession();
</script>

<template>
  <section class="drawer-section">
    <pre class="prompt-preview">{{ promptPreviewText }}</pre>

    <div class="warning-stack">
      <article v-for="warning in state.warnings" :key="warning" class="notice-card notice-card-warning">
        {{ warning }}
      </article>
    </div>

    <div class="timeline-head">
      <span class="eyebrow">{{ t("runtime.versionTimeline") }}</span>
      <span class="timeline-meta">{{ versionMetaLabel }}</span>
    </div>
    <div class="version-strip">
      <button
        v-for="(version, index) in state.versions"
        :key="version.id"
        type="button"
        class="version-pill"
        :class="{ active: index === state.activeVersionIndex }"
        @click="restoreVersion(index)"
      >
        {{ version.id }} · {{ version.label }}
      </button>
    </div>
  </section>
</template>
