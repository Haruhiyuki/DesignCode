<script setup>
import { computed, watch } from "vue";
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useRuntimeAgent } from "../../composables/useRuntimeAgent.js";
import { useCanvasViewport } from "../../composables/useCanvasViewport.js";
import { useGuidedSetup } from "../../composables/useGuidedSetup.js";

const { state, activeDropdown } = useWorkspaceState();
const {
  RUNTIME_BACKEND_OPTIONS,
  activeRuntimeBackend,
  runtimeBackendDisplayName,
  appliedProxyLabel,
  codexModelOptions,
  codexReasoningOptions,
  claudeModelOptions,
  claudeEffortOptions,
  apiProviderPickerOptions,
  selectedProviderModels,
  providerConnectionLabel,
  authResultText
} = useSetupConfig();
const {
  setRuntimeBackend,
  applyProxyPort,
  refreshDesktopIntegration,
  handleOpenCodexLogin,
  handleVerifyCodex,
  applyCodexModel,
  handleOpenClaudeLogin,
  handleVerifyClaude,
  applyClaudeModel,
  handleStartOpencode,
  handleCreateSession,
  applySelectedModel
} = useRuntimeAgent();
const { openDropdown, closeDropdown } = useCanvasViewport();
const {
  guidedSetup,
  closeGuidedSetup,
  setGuidedSetupStep,
  markGuidedSetupCompleted
} = useGuidedSetup();

const steps = computed(() => [
  {
    id: "network",
    label: t("guidedSetup.stepNetwork"),
    shortLabel: "01",
    ready: Boolean(state.desktop.isDesktop),
    detail: state.desktop.isDesktop ? t("guidedSetup.desktopReady") : t("guidedSetup.desktopUnavailable")
  },
  {
    id: "agent",
    label: t("guidedSetup.stepAgent"),
    shortLabel: "02",
    ready: Boolean(activeRuntimeBackend.value),
    detail: runtimeBackendDisplayName(activeRuntimeBackend.value)
  },
  {
    id: "connect",
    label: t("guidedSetup.stepConnect"),
    shortLabel: "03",
    ready: runtimeReady.value,
    detail: runtimeReady.value ? t("guidedSetup.statusConfigured") : t("guidedSetup.statusNeedsConnect")
  }
]);

const activeStep = computed(() => steps.value[guidedSetup.activeStep] || steps.value[0]);

const backendChoices = computed(() =>
  RUNTIME_BACKEND_OPTIONS.value.map((option) => ({
    ...option,
    description: t(`guidedSetup.backend.${option.id}.desc`),
    ready: backendReady(option.id),
    status: backendStatusLabel(option.id)
  }))
);

const runtimeReady = computed(() => backendReady(activeRuntimeBackend.value));

watch(
  () => guidedSetup.open,
  (open) => {
    if (open) {
      void refreshDesktopIntegration({ skipSessionMessages: true });
    }
  }
);

function backendInstalled(backend) {
  if (backend === "codex") {
    return state.agent.codexInstalled;
  }
  if (backend === "claude") {
    return state.agent.claudeInstalled;
  }
  return state.agent.installed;
}

function backendReady(backend) {
  if (!state.desktop.isDesktop) {
    return false;
  }
  if (backend === "codex") {
    return Boolean(state.agent.codexInstalled && state.agent.codexLoggedIn);
  }
  if (backend === "claude") {
    return Boolean(state.agent.claudeInstalled && state.agent.claudeLoggedIn);
  }
  return Boolean(
    state.agent.installed
    && state.agent.running
    && (state.agent.configModel || (state.agent.providerId && state.agent.modelId))
  );
}

function backendStatusLabel(backend) {
  if (!state.desktop.isDesktop) {
    return t("guidedSetup.statusDesktopUnavailable");
  }
  if (!backendInstalled(backend)) {
    return t("guidedSetup.statusMissingCli");
  }
  if (backend === "opencode") {
    if (!state.agent.running) {
      return t("guidedSetup.statusStopped");
    }
    return state.agent.configModel || (state.agent.providerId && state.agent.modelId)
      ? t("guidedSetup.statusConfigured")
      : t("guidedSetup.statusNeedsModel");
  }
  if (backend === "codex") {
    return state.agent.codexLoggedIn ? t("guidedSetup.statusLoggedIn") : t("guidedSetup.statusNotLoggedIn");
  }
  return state.agent.claudeLoggedIn ? t("guidedSetup.statusLoggedIn") : t("guidedSetup.statusNotLoggedIn");
}

function chipTone(value) {
  return value ? "ready" : "missing";
}

function selectBackend(id) {
  setRuntimeBackend(id);
}

function goNext() {
  setGuidedSetupStep(guidedSetup.activeStep + 1);
}

function goBack() {
  setGuidedSetupStep(guidedSetup.activeStep - 1);
}

function finishSetup() {
  markGuidedSetupCompleted();
  closeGuidedSetup();
}
</script>

<template>
  <div class="guided-setup-overlay" role="presentation" @mousedown.self="closeGuidedSetup">
    <section class="guided-setup-modal" role="dialog" aria-modal="true" :aria-label="t('guidedSetup.modalTitle')">
      <header class="guided-setup-header">
        <div>
          <p class="eyebrow">{{ t("guidedSetup.modalEyebrow") }}</p>
          <h2>{{ t("guidedSetup.modalTitle") }}</h2>
          <p>{{ t("guidedSetup.modalDesc") }}</p>
        </div>
        <button type="button" class="guided-icon-button" :aria-label="t('guidedSetup.close')" @click="closeGuidedSetup">
          ×
        </button>
      </header>

      <div class="guided-setup-content">
        <aside class="guided-setup-rail" :aria-label="t('guidedSetup.stepNavLabel')">
          <button
            v-for="(step, index) in steps"
            :key="step.id"
            type="button"
            class="guided-rail-step"
            :class="{ active: guidedSetup.activeStep === index }"
            :data-ready="step.ready"
            @click="setGuidedSetupStep(index)"
          >
            <span class="guided-rail-index">{{ step.shortLabel }}</span>
            <span class="guided-rail-copy">
              <strong>{{ step.label }}</strong>
              <small>{{ step.detail }}</small>
            </span>
          </button>
        </aside>

        <div class="guided-setup-body custom-scrollbar">
          <section v-if="activeStep.id === 'network'" class="guided-setup-panel">
            <div class="guided-panel-head">
              <h3>{{ t("guidedSetup.networkTitle") }}</h3>
              <p>{{ t("guidedSetup.networkDesc") }}</p>
            </div>

            <div class="guided-status-grid">
              <article class="guided-status-card" :data-tone="state.desktop.isDesktop ? 'ready' : 'missing'">
                <span>{{ t("guidedSetup.desktopStatus") }}</span>
                <strong>{{ state.desktop.isDesktop ? t("guidedSetup.desktopReady") : t("guidedSetup.desktopUnavailable") }}</strong>
              </article>
              <article class="guided-status-card">
                <span>{{ t("runtime.appliedProxy") }}</span>
                <strong>{{ appliedProxyLabel }}</strong>
              </article>
            </div>

            <div class="guided-section-card">
              <div class="guided-card-head">
                <strong>{{ t("runtime.proxyPort") }}</strong>
                <small>{{ t("guidedSetup.proxyOptional") }}</small>
              </div>

              <div class="field-row runtime-proxy-row">
                <label class="field">
                  <span>{{ t("runtime.proxyPort") }}</span>
                  <div class="runtime-port-input">
                    <input
                      v-model="state.agent.proxyPortInput"
                      :disabled="!state.desktop.isDesktop || state.agent.busy"
                      inputmode="numeric"
                      placeholder="7890"
                      @keydown.enter.prevent="applyProxyPort"
                    />
                  </div>
                </label>
                <label class="field">
                  <span>{{ t("runtime.appliedProxy") }}</span>
                  <div class="runtime-inline-value">{{ appliedProxyLabel }}</div>
                </label>
              </div>

              <div class="action-row guided-action-row">
                <button type="button" class="button button-solid" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="applyProxyPort">
                  {{ t("runtime.confirmProxy") }}
                </button>
                <button type="button" class="button button-ghost" :disabled="state.agent.busy" @click="refreshDesktopIntegration({ skipSessionMessages: true })">
                  {{ t("guidedSetup.refreshStatus") }}
                </button>
              </div>
            </div>
          </section>

          <section v-else-if="activeStep.id === 'agent'" class="guided-setup-panel">
            <div class="guided-panel-head">
              <h3>{{ t("guidedSetup.agentTitle") }}</h3>
              <p>{{ t("guidedSetup.agentDesc") }}</p>
            </div>

            <div class="guided-backend-list">
              <button
                v-for="backend in backendChoices"
                :key="backend.id"
                type="button"
                class="guided-backend-row"
                :class="{ active: activeRuntimeBackend === backend.id }"
                @click="selectBackend(backend.id)"
              >
                <span class="guided-backend-radio" aria-hidden="true"></span>
                <span class="guided-backend-copy">
                  <strong>{{ backend.label }}</strong>
                  <small>{{ backend.description }}</small>
                </span>
                <span class="guided-backend-status" :data-tone="chipTone(backend.ready)">
                  {{ backend.status }}
                </span>
              </button>
            </div>
          </section>

          <section v-else-if="activeStep.id === 'connect'" class="guided-setup-panel">
            <div class="guided-panel-head">
              <h3>{{ t("guidedSetup.connectTitle", { backend: runtimeBackendDisplayName(activeRuntimeBackend) }) }}</h3>
              <p>{{ t("guidedSetup.connectDesc") }}</p>
            </div>

            <div class="guided-status-grid">
              <article class="guided-status-card" :data-tone="backendInstalled(activeRuntimeBackend) ? 'ready' : 'missing'">
                <span>{{ t("runtime.installed") }}</span>
                <strong>{{ backendInstalled(activeRuntimeBackend) ? t("runtime.installed") : t("runtime.notInstalled") }}</strong>
              </article>
              <article class="guided-status-card" :data-tone="runtimeReady ? 'ready' : 'missing'">
                <span>{{ t("guidedSetup.currentBackend") }}</span>
                <strong>{{ backendStatusLabel(activeRuntimeBackend) }}</strong>
              </article>
            </div>

            <div v-if="activeRuntimeBackend === 'codex'" class="guided-section-card">
              <div class="guided-card-head">
                <strong>Codex CLI</strong>
                <small>{{ t("runtime.codex.description") }}</small>
              </div>
              <div class="guided-chip-row">
                <span class="guided-status-pill" :data-ready="state.agent.codexInstalled">{{ state.agent.codexInstalled ? t("runtime.installed") : t("runtime.notInstalled") }}</span>
                <span class="guided-status-pill" :data-ready="state.agent.codexLoggedIn">{{ state.agent.codexLoggedIn ? t("runtime.codex.loggedIn") : t("runtime.codex.notLoggedIn") }}</span>
                <span class="guided-status-pill" :data-ready="state.agent.codexVerified">{{ state.agent.codexVerified ? t("runtime.verified") : t("guidedSetup.statusNotVerified") }}</span>
              </div>

              <details class="guided-advanced">
                <summary>{{ t("guidedSetup.advancedRuntime") }}</summary>
                <label class="field">
                  <span>{{ t("runtime.codex.pathLabel") }}</span>
                  <input v-model="state.agent.codexBinary" :disabled="!state.desktop.isDesktop || state.agent.busy" :placeholder="t('runtime.codex.pathPlaceholder')" />
                </label>
                <div class="field-row">
                  <div class="field">
                    <span>{{ t("runtime.codex.modelLabel") }}</span>
                    <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-codex-model' }">
                      <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || state.agent.busy || !codexModelOptions.length" @click="openDropdown('guided-codex-model', $event.currentTarget)">
                        <span class="custom-select-value">{{ codexModelOptions.find(m => m.id === state.agent.codexModelId)?.name || state.agent.codexModelId || '\u2014' }}</span>
                        <span class="custom-select-arrow" aria-hidden="true"></span>
                      </button>
                      <div v-if="activeDropdown.id === 'guided-codex-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                        <button v-for="model in codexModelOptions" :key="model.id" type="button" class="custom-select-option" :data-active="model.id === state.agent.codexModelId" @click="state.agent.codexModelId = model.id; closeDropdown()">
                          {{ model.name || model.id }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="field">
                    <span>{{ t("runtime.codex.effort") }}</span>
                    <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-codex-effort' }">
                      <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || state.agent.busy || !codexReasoningOptions.length" @click="openDropdown('guided-codex-effort', $event.currentTarget)">
                        <span class="custom-select-value">{{ state.agent.codexReasoningEffort || '\u2014' }}</span>
                        <span class="custom-select-arrow" aria-hidden="true"></span>
                      </button>
                      <div v-if="activeDropdown.id === 'guided-codex-effort'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                        <button v-for="option in codexReasoningOptions" :key="option.effort" type="button" class="custom-select-option" :data-active="option.effort === state.agent.codexReasoningEffort" @click="state.agent.codexReasoningEffort = option.effort; closeDropdown()">
                          {{ option.effort }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              <div class="action-row guided-action-row">
                <button type="button" class="button button-solid" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled" @click="handleOpenCodexLogin()">{{ t("runtime.codex.browserLogin") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled" @click="handleOpenCodexLogin({ deviceAuth: true, force: true })">{{ t("runtime.codex.deviceCodeLogin") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexModelId" @click="applyCodexModel">{{ t("runtime.codex.confirmModel") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled || !state.agent.codexLoggedIn" @click="handleVerifyCodex">{{ t("runtime.codex.verifyConnection") }}</button>
              </div>
            </div>

            <div v-else-if="activeRuntimeBackend === 'claude'" class="guided-section-card">
              <div class="guided-card-head">
                <strong>Claude Code</strong>
                <small>{{ t("runtime.claude.description") }}</small>
              </div>
              <div class="guided-chip-row">
                <span class="guided-status-pill" :data-ready="state.agent.claudeInstalled">{{ state.agent.claudeInstalled ? t("runtime.installed") : t("runtime.notInstalled") }}</span>
                <span class="guided-status-pill" :data-ready="state.agent.claudeLoggedIn">{{ state.agent.claudeLoggedIn ? t("runtime.claude.loggedIn") : t("runtime.claude.notLoggedIn") }}</span>
                <span class="guided-status-pill" :data-ready="state.agent.claudeVerified">{{ state.agent.claudeVerified ? t("runtime.verified") : t("guidedSetup.statusNotVerified") }}</span>
              </div>

              <details class="guided-advanced">
                <summary>{{ t("guidedSetup.advancedRuntime") }}</summary>
                <label class="field">
                  <span>{{ t("runtime.claude.pathLabel") }}</span>
                  <input v-model="state.agent.claudeBinary" :disabled="!state.desktop.isDesktop || state.agent.busy" :placeholder="t('runtime.claude.pathPlaceholder')" />
                </label>
                <div class="field-row">
                  <div class="field">
                    <span>{{ t("runtime.claude.modelLabel") }}</span>
                    <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-claude-model' }">
                      <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="openDropdown('guided-claude-model', $event.currentTarget)">
                        <span class="custom-select-value">{{ claudeModelOptions.find(m => m.id === state.agent.claudeModelId)?.name || state.agent.claudeModelId || '\u2014' }}</span>
                        <span class="custom-select-arrow" aria-hidden="true"></span>
                      </button>
                      <div v-if="activeDropdown.id === 'guided-claude-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                        <button v-for="model in claudeModelOptions" :key="model.id || 'default'" type="button" class="custom-select-option" :data-active="model.id === state.agent.claudeModelId" @click="state.agent.claudeModelId = model.id; closeDropdown()">
                          {{ model.name }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="field">
                    <span>{{ t("runtime.claude.effort") }}</span>
                    <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-claude-effort' }">
                      <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="openDropdown('guided-claude-effort', $event.currentTarget)">
                        <span class="custom-select-value">{{ state.agent.claudeEffort || t("runtime.effortDefault") }}</span>
                        <span class="custom-select-arrow" aria-hidden="true"></span>
                      </button>
                      <div v-if="activeDropdown.id === 'guided-claude-effort'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                        <button v-for="option in claudeEffortOptions" :key="option || 'default'" type="button" class="custom-select-option" :data-active="option === state.agent.claudeEffort" @click="state.agent.claudeEffort = option; closeDropdown()">
                          {{ option || t("runtime.effortDefault") }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              <div class="action-row guided-action-row">
                <button type="button" class="button button-solid" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.claudeInstalled" @click="handleOpenClaudeLogin">{{ t("runtime.claude.login") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="applyClaudeModel">{{ t("runtime.claude.confirmParams") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.claudeInstalled || !state.agent.claudeLoggedIn" @click="handleVerifyClaude">{{ t("runtime.claude.verifyConnection") }}</button>
              </div>
            </div>

            <div v-else class="guided-section-card">
              <div class="guided-card-head">
                <strong>OpenCode Runtime</strong>
                <small>{{ t("runtime.opencode.description") }}</small>
              </div>
              <div class="guided-chip-row">
                <span class="guided-status-pill" :data-ready="state.agent.installed">{{ state.agent.installed ? t("runtime.installed") : t("runtime.notInstalled") }}</span>
                <span class="guided-status-pill" :data-ready="state.agent.running">{{ state.agent.running ? t("guidedSetup.statusRunning") : t("guidedSetup.statusStopped") }}</span>
                <span class="guided-status-pill" :data-ready="Boolean(state.agent.configModel || (state.agent.providerId && state.agent.modelId))">{{ providerConnectionLabel }}</span>
              </div>

              <div class="action-row guided-action-row">
                <button type="button" class="button button-solid" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="handleStartOpencode">{{ state.agent.running ? t("guidedSetup.statusRunning") : t("runtime.opencode.start") }}</button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy" @click="handleCreateSession">{{ t("runtime.opencode.newSession") }}</button>
              </div>

              <div class="field-row">
                <div class="field">
                  <span>Provider</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-provider' }">
                    <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy" @click="openDropdown('guided-provider', $event.currentTarget)">
                      <span class="custom-select-value">{{ apiProviderPickerOptions.find(p => p.id === state.agent.providerId)?.name || state.agent.providerId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'guided-provider'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button v-for="provider in apiProviderPickerOptions" :key="provider.id" type="button" class="custom-select-option" :data-active="provider.id === state.agent.providerId" @click="state.agent.providerId = provider.id; closeDropdown()">
                        {{ provider.name || provider.id }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="field">
                  <span>{{ t("runtime.opencode.defaultModel") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'guided-opencode-model' }">
                    <button type="button" class="custom-select-trigger" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !selectedProviderModels.length" @click="openDropdown('guided-opencode-model', $event.currentTarget)">
                      <span class="custom-select-value">{{ selectedProviderModels.find(m => m.id === state.agent.modelId)?.name || state.agent.modelId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'guided-opencode-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button v-for="model in selectedProviderModels" :key="model.id" type="button" class="custom-select-option" :data-active="model.id === state.agent.modelId" @click="state.agent.modelId = model.id; closeDropdown()">
                        {{ model.name || model.id }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <label class="field">
                <span>{{ t("runtime.opencode.providerApiKey") }}</span>
                <input v-model="state.agent.opencodeProviderApiKey" type="password" autocomplete="off" spellcheck="false" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId" :placeholder="state.agent.opencodeProviderApiKeySaved && !state.agent.opencodeProviderApiKey ? t('runtime.opencode.apiKeyPlaceholderSaved') : t('runtime.opencode.apiKeyPlaceholder')" />
              </label>

              <details class="guided-advanced">
                <summary>{{ t("guidedSetup.advancedRuntime") }}</summary>
                <label class="field">
                  <span>{{ t("runtime.opencode.pathLabel") }}</span>
                  <input v-model="state.agent.binary" :disabled="!state.desktop.isDesktop || state.agent.busy" :placeholder="t('runtime.opencode.pathPlaceholder')" />
                </label>
                <label class="field">
                  <span>{{ t("runtime.opencode.providerBaseUrl") }}</span>
                  <input v-model="state.agent.opencodeProviderBaseUrl" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId" :placeholder="t('runtime.opencode.baseUrlPlaceholder')" />
                </label>
              </details>

              <div class="action-row guided-action-row">
                <button type="button" class="button button-solid" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId || !state.agent.modelId" @click="applySelectedModel">
                  {{ t("runtime.opencode.saveConfig") }}
                </button>
              </div>
            </div>

            <pre class="prompt-preview agent-output guided-auth-output">{{ authResultText }}</pre>
          </section>

        </div>
      </div>

      <footer class="guided-setup-footer">
        <button type="button" class="button button-ghost" @click="closeGuidedSetup">{{ t("guidedSetup.later") }}</button>
        <div class="guided-setup-footer-actions">
          <button type="button" class="button button-ghost" :disabled="guidedSetup.activeStep === 0" @click="goBack">
            {{ t("guidedSetup.back") }}
          </button>
          <button v-if="guidedSetup.activeStep < steps.length - 1" type="button" class="button button-solid" @click="goNext">
            {{ t("guidedSetup.next") }}
          </button>
          <template v-else>
            <button type="button" class="button button-solid" @click="finishSetup">
              {{ t("guidedSetup.finish") }}
            </button>
          </template>
        </div>
      </footer>
    </section>
  </div>
</template>
