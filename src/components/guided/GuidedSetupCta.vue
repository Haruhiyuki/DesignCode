<script setup>
import { computed } from "vue";
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useGuidedSetup } from "../../composables/useGuidedSetup.js";

const { state } = useWorkspaceState();
const { activeRuntimeBackend } = useSetupConfig();
const { guidedSetup, openGuidedSetup } = useGuidedSetup();

const runtimeReady = computed(() => {
  if (!state.desktop.isDesktop) {
    return false;
  }

  if (activeRuntimeBackend.value === "codex") {
    return state.agent.codexInstalled && state.agent.codexLoggedIn;
  }

  if (activeRuntimeBackend.value === "claude") {
    return state.agent.claudeInstalled && state.agent.claudeLoggedIn;
  }

  return state.agent.installed && state.agent.running && Boolean(state.agent.providerId && state.agent.modelId);
});

const showSetupCta = computed(() => {
  if (state.currentHtml) {
    return false;
  }
  return !runtimeReady.value || !guidedSetup.completed;
});

const primaryStep = computed(() => 0);
</script>

<template>
  <article v-if="showSetupCta" class="guided-setup-cta">
    <div class="guided-setup-cta-copy">
      <h3>{{ t("guidedSetup.ctaTitle") }}</h3>
    </div>

    <button type="button" class="button button-solid guided-setup-cta-button" @click="openGuidedSetup(primaryStep)">
      {{ t("guidedSetup.ctaButton") }}
    </button>
  </article>
</template>
