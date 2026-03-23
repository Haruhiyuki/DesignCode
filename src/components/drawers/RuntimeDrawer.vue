<script setup>
// 运行时抽屉 — 后端选择、登录状态、模型配置、连接验证。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useRuntimeAgent } from "../../composables/useRuntimeAgent.js";
import { useCanvasViewport } from "../../composables/useCanvasViewport.js";

const { state, activeDropdown } = useWorkspaceState();
const {
  activeRuntimeBackend, RUNTIME_BACKEND_OPTIONS,
  runtimeBackendDisplayName, activeModelLabel, appliedProxyLabel,
  codexSessionLabel, claudeSessionLabel, geminiSessionLabel,
  codexModelOptions, codexReasoningOptions,
  claudeModelOptions, claudeEffortOptions,
  geminiModelOptions,
  agentOptions, providerConnectionLabel,
  apiProviderPickerOptions, selectedProviderModels, opencodeSmallModelOptions,
  authResultText
} = useSetupConfig();
const {
  setRuntimeBackend, applyProxyPort,
  handleOpenCodexLogin, handleVerifyCodex, applyCodexModel,
  handleOpenClaudeLogin, handleVerifyClaude, applyClaudeModel,
  handleOpenGeminiLogin, handleVerifyGemini, applyGeminiModel,
  handleStartOpencode, handleStopOpencode, handleCreateSession,
  applySelectedModel, refreshDesktopIntegration,
  resolvedGeminiModelLabel
} = useRuntimeAgent();
const { openDropdown, closeDropdown } = useCanvasViewport();
</script>

<template>
  <section class="drawer-section">
            <div class="runtime-global-panel">
              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.currentBackend") }}</span>
                  <div class="runtime-inline-value">{{ runtimeBackendDisplayName(activeRuntimeBackend) }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.model") }}</span>
                  <div class="runtime-inline-value">{{ activeModelLabel }}</div>
                </label>
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

              <div class="action-row">
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="applyProxyPort"
                >
                  {{ t("runtime.confirmProxy") }}
                </button>
              </div>
            </div>

            <div class="runtime-mode-switch">
              <button
                v-for="option in RUNTIME_BACKEND_OPTIONS"
                :key="option.id"
                type="button"
                class="mode-toggle"
                :class="{ active: activeRuntimeBackend === option.id }"
                @click="setRuntimeBackend(option.id)"
              >
                {{ option.label }}
              </button>
            </div>

            <div v-if="activeRuntimeBackend === 'codex'" class="runtime-mode-panel">
              <div class="runtime-mode-header">
                <strong>Codex CLI</strong>
                <span>{{ t("runtime.codex.description") }}</span>
              </div>

              <label class="field">
                <span>{{ t("runtime.codex.pathLabel") }}</span>
                <input
                  v-model="state.agent.codexBinary"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  :placeholder="t('runtime.codex.pathPlaceholder')"
                />
              </label>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.codex.loginStatus") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.codexLoggedIn ? t("runtime.codex.loggedIn") : t("runtime.codex.notLoggedIn") }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.codex.authMethod") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.codexAuthMethod || t("runtime.authNotRecognized") }}</div>
                </label>
              </div>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.codex.thread") }}</span>
                  <div class="runtime-inline-value">{{ codexSessionLabel }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.codex.defaultModel") }}</span>
                  <div class="runtime-inline-value">
                    {{ state.agent.codexDefaultModel || t("runtime.notSet") }}
                    <template v-if="state.agent.codexDefaultReasoningEffort">
                      · {{ state.agent.codexDefaultReasoningEffort }}
                    </template>
                  </div>
                </label>
              </div>

              <div class="field-row">
                <div class="field">
                  <span>{{ t("runtime.codex.modelLabel") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-codex-model' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || state.agent.busy || !codexModelOptions.length"
                      @click="openDropdown('select-codex-model', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ codexModelOptions.find(m => m.id === state.agent.codexModelId)?.name || state.agent.codexModelId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-codex-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="model in codexModelOptions"
                        :key="model.id"
                        type="button"
                        class="custom-select-option"
                        :data-active="model.id === state.agent.codexModelId"
                        @click="state.agent.codexModelId = model.id; closeDropdown()"
                      >
                        {{ model.name || model.id }}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="field">
                  <span>{{ t("runtime.codex.effort") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-codex-effort' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || state.agent.busy || !codexReasoningOptions.length"
                      @click="openDropdown('select-codex-effort', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ state.agent.codexReasoningEffort || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-codex-effort'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="option in codexReasoningOptions"
                        :key="option.effort"
                        type="button"
                        class="custom-select-option"
                        :data-active="option.effort === state.agent.codexReasoningEffort"
                        @click="state.agent.codexReasoningEffort = option.effort; closeDropdown()"
                      >
                        {{ option.effort }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="action-row">
                <button
                  type="button"
                  class="button button-solid"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled"
                  @click="handleOpenCodexLogin()"
                >
                  {{ t("runtime.codex.browserLogin") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled"
                  @click="handleOpenCodexLogin({ deviceAuth: true, force: true })"
                >
                  {{ t("runtime.codex.deviceCodeLogin") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexModelId"
                  @click="applyCodexModel"
                >
                  {{ t("runtime.codex.confirmModel") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.codexInstalled || !state.agent.codexLoggedIn"
                  @click="handleVerifyCodex"
                >
                  {{ t("runtime.codex.verifyConnection") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="refreshDesktopIntegration({ skipProviderCatalog: true, skipSessionMessages: true })"
                >
                  {{ t("runtime.codex.refreshStatus") }}
                </button>
              </div>
            </div>

            <div v-else-if="activeRuntimeBackend === 'claude'" class="runtime-mode-panel">
              <div class="runtime-mode-header">
                <strong>Claude Code</strong>
                <span>{{ t("runtime.claude.description") }}</span>
              </div>

              <label class="field">
                <span>{{ t("runtime.claude.pathLabel") }}</span>
                <input
                  v-model="state.agent.claudeBinary"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  :placeholder="t('runtime.claude.pathPlaceholder')"
                />
              </label>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.claude.loginStatus") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.claudeLoggedIn ? t("runtime.claude.loggedIn") : t("runtime.claude.notLoggedIn") }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.claude.authMethod") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.claudeAuthMethod || t("runtime.authNotRecognized") }}</div>
                </label>
              </div>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.claude.session") }}</span>
                  <div class="runtime-inline-value">{{ claudeSessionLabel }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.claude.defaultModel") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.claudeDefaultModel || t("runtime.notSet") }}</div>
                </label>
              </div>

              <div class="field-row">
                <div class="field">
                  <span>{{ t("runtime.claude.modelLabel") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-claude-model' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || state.agent.busy"
                      @click="openDropdown('select-claude-model', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ claudeModelOptions.find(m => m.id === state.agent.claudeModelId)?.name || state.agent.claudeModelId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-claude-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="option in claudeModelOptions"
                        :key="option.id || 'default'"
                        type="button"
                        class="custom-select-option"
                        :data-active="option.id === state.agent.claudeModelId"
                        @click="state.agent.claudeModelId = option.id; closeDropdown()"
                      >
                        {{ option.name }}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="field">
                  <span>{{ t("runtime.claude.effort") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-claude-effort' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || state.agent.busy"
                      @click="openDropdown('select-claude-effort', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ state.agent.claudeEffort || t("runtime.effortDefault") }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-claude-effort'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="option in claudeEffortOptions"
                        :key="option || 'default'"
                        type="button"
                        class="custom-select-option"
                        :data-active="option === state.agent.claudeEffort"
                        @click="state.agent.claudeEffort = option; closeDropdown()"
                      >
                        {{ option || t("runtime.effortDefault") }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="action-row">
                <button
                  type="button"
                  class="button button-solid"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.claudeInstalled"
                  @click="handleOpenClaudeLogin"
                >
                  {{ t("runtime.claude.login") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="applyClaudeModel"
                >
                  {{ t("runtime.claude.confirmParams") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.claudeInstalled || !state.agent.claudeLoggedIn"
                  @click="handleVerifyClaude"
                >
                  {{ t("runtime.claude.verifyConnection") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="refreshDesktopIntegration({ skipProviderCatalog: true, skipSessionMessages: true })"
                >
                  {{ t("runtime.claude.refreshStatus") }}
                </button>
              </div>
            </div>

            <div v-else-if="activeRuntimeBackend === 'gemini'" class="runtime-mode-panel">
              <div class="runtime-mode-header">
                <strong>Gemini CLI</strong>
                <span>{{ t("runtime.gemini.description") }}</span>
              </div>

              <label class="field">
                <span>{{ t("runtime.gemini.pathLabel") }}</span>
                <input
                  v-model="state.agent.geminiBinary"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  :placeholder="t('runtime.gemini.pathPlaceholder')"
                />
              </label>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.gemini.authStatus") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.geminiLoggedIn ? t("runtime.gemini.authDetected") : t("runtime.gemini.pendingVerify") }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.gemini.authMethod") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.geminiAuthMethod || t("runtime.authNotRecognized") }}</div>
                </label>
              </div>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.gemini.session") }}</span>
                  <div class="runtime-inline-value">{{ geminiSessionLabel }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.gemini.defaultModel") }}</span>
                  <div class="runtime-inline-value">{{ resolvedGeminiModelLabel(state.agent.geminiDefaultModel) }}</div>
                </label>
              </div>

              <div class="field">
                <span>{{ t("runtime.gemini.modelLabel") }}</span>
                <div class="custom-select" :class="{ open: activeDropdown.id === 'select-gemini-model' }">
                  <button
                    type="button"
                    class="custom-select-trigger"
                    :disabled="!state.desktop.isDesktop || state.agent.busy"
                    @click="openDropdown('select-gemini-model', $event.currentTarget)"
                  >
                    <span class="custom-select-value">{{ geminiModelOptions.find(m => m.id === state.agent.geminiModelId)?.name || state.agent.geminiModelId || '\u2014' }}</span>
                    <span class="custom-select-arrow" aria-hidden="true"></span>
                  </button>
                  <div v-if="activeDropdown.id === 'select-gemini-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                    <button
                      v-for="option in geminiModelOptions"
                      :key="option.id || 'default'"
                      type="button"
                      class="custom-select-option"
                      :data-active="option.id === state.agent.geminiModelId"
                      @click="state.agent.geminiModelId = option.id; closeDropdown()"
                    >
                      {{ option.name }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="action-row">
                <button
                  type="button"
                  class="button button-solid"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.geminiInstalled"
                  @click="handleOpenGeminiLogin"
                >
                  {{ t("runtime.gemini.login") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="applyGeminiModel"
                >
                  {{ t("runtime.gemini.confirmModel") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy || !state.agent.geminiInstalled"
                  @click="handleVerifyGemini"
                >
                  {{ t("runtime.gemini.verifyConnection") }}
                </button>
                <button
                  type="button"
                  class="button button-ghost"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  @click="refreshDesktopIntegration({ skipProviderCatalog: true, skipSessionMessages: true })"
                >
                  {{ t("runtime.gemini.refreshStatus") }}
                </button>
              </div>
            </div>

            <div v-else-if="activeRuntimeBackend === 'opencode'" class="runtime-mode-panel">
              <div class="runtime-mode-header">
                <strong>OpenCode Runtime</strong>
                <span>{{ t("runtime.opencode.description") }}</span>
              </div>

              <div class="runtime-config-note">
                <strong>{{ t("runtime.opencode.configTitle") }}</strong>
                <p>{{ t("runtime.opencode.configDesc1") }}</p>
                <p>{{ t("runtime.opencode.configDesc2") }}</p>
              </div>

              <label class="field">
                <span>{{ t("runtime.opencode.pathLabel") }}</span>
                <input
                  v-model="state.agent.binary"
                  :disabled="!state.desktop.isDesktop || state.agent.busy"
                  :placeholder="t('runtime.opencode.pathPlaceholder')"
                />
              </label>

              <div class="field">
                <span>Agent</span>
                <div class="custom-select" :class="{ open: activeDropdown.id === 'select-agent' }">
                  <button
                    type="button"
                    class="custom-select-trigger"
                    :disabled="!state.desktop.isDesktop || state.agent.busy"
                    @click="openDropdown('select-agent', $event.currentTarget)"
                  >
                    <span class="custom-select-value">{{ state.agent.selectedAgent || '\u2014' }}</span>
                    <span class="custom-select-arrow" aria-hidden="true"></span>
                  </button>
                  <div v-if="activeDropdown.id === 'select-agent'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                    <button
                      v-for="agent in agentOptions"
                      :key="agent"
                      type="button"
                      class="custom-select-option"
                      :data-active="agent === state.agent.selectedAgent"
                      @click="state.agent.selectedAgent = agent; closeDropdown()"
                    >
                      {{ agent }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="action-row">
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="handleStartOpencode">
                  {{ t("runtime.opencode.start") }}
                </button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy" @click="handleStopOpencode">
                  {{ t("runtime.opencode.stop") }}
                </button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy" @click="handleCreateSession">
                  {{ t("runtime.opencode.newSession") }}
                </button>
                <button type="button" class="button button-ghost" :disabled="!state.desktop.isDesktop || state.agent.busy" @click="refreshDesktopIntegration">
                  {{ t("runtime.opencode.refreshStatus") }}
                </button>
              </div>

              <div class="field-row">
                <div class="field">
                  <span>Provider</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-provider' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy"
                      @click="openDropdown('select-provider', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ apiProviderPickerOptions.find(p => p.id === state.agent.providerId)?.name || state.agent.providerId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-provider'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="provider in apiProviderPickerOptions"
                        :key="provider.id"
                        type="button"
                        class="custom-select-option"
                        :data-active="provider.id === state.agent.providerId"
                        @click="state.agent.providerId = provider.id; closeDropdown()"
                      >
                        {{ provider.name || provider.id }}
                      </button>
                    </div>
                  </div>
                </div>

                <label class="field">
                  <span>{{ t("runtime.opencode.connectionStatus") }}</span>
                  <div class="runtime-inline-value">{{ providerConnectionLabel }}</div>
                </label>
              </div>

              <div class="field-row">
                <div class="field">
                  <span>{{ t("runtime.opencode.defaultModel") }}</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-opencode-model' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !selectedProviderModels.length"
                      @click="openDropdown('select-opencode-model', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ selectedProviderModels.find(m => m.id === state.agent.modelId)?.name || state.agent.modelId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-opencode-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="model in selectedProviderModels"
                        :key="model.id"
                        type="button"
                        class="custom-select-option"
                        :data-active="model.id === state.agent.modelId"
                        @click="state.agent.modelId = model.id; closeDropdown()"
                      >
                        {{ model.name || model.id }}
                      </button>
                    </div>
                  </div>
                </div>

                <div class="field">
                  <span>small_model</span>
                  <div class="custom-select" :class="{ open: activeDropdown.id === 'select-opencode-small-model' }">
                    <button
                      type="button"
                      class="custom-select-trigger"
                      :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy"
                      @click="openDropdown('select-opencode-small-model', $event.currentTarget)"
                    >
                      <span class="custom-select-value">{{ opencodeSmallModelOptions.find(m => m.id === state.agent.opencodeSmallModelId)?.name || state.agent.opencodeSmallModelId || '\u2014' }}</span>
                      <span class="custom-select-arrow" aria-hidden="true"></span>
                    </button>
                    <div v-if="activeDropdown.id === 'select-opencode-small-model'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
                      <button
                        v-for="model in opencodeSmallModelOptions"
                        :key="model.id || 'default'"
                        type="button"
                        class="custom-select-option"
                        :data-active="model.id === state.agent.opencodeSmallModelId"
                        @click="state.agent.opencodeSmallModelId = model.id; closeDropdown()"
                      >
                        {{ model.name }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <label class="field">
                <span>{{ t("runtime.opencode.providerBaseUrl") }}</span>
                <input
                  v-model="state.agent.opencodeProviderBaseUrl"
                  :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId"
                  :placeholder="t('runtime.opencode.baseUrlPlaceholder')"
                />
              </label>

              <label class="field">
                <span>{{ t("runtime.opencode.providerApiKey") }}</span>
                <input
                  v-model="state.agent.opencodeProviderApiKey"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId"
                  :placeholder="t('runtime.opencode.apiKeyPlaceholder')"
                />
              </label>

              <div class="field-row">
                <label class="field">
                  <span>{{ t("runtime.opencode.currentModel") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.configModel || t("runtime.notSet") }}</div>
                </label>

                <label class="field">
                  <span>{{ t("runtime.opencode.currentSmallModel") }}</span>
                  <div class="runtime-inline-value">{{ state.agent.configSmallModel || t("runtime.notSet") }}</div>
                </label>
              </div>

              <div class="action-row">
                <button
                  type="button"
                  class="button button-solid"
                  :disabled="!state.desktop.isDesktop || !state.agent.running || state.agent.busy || !state.agent.providerId || !state.agent.modelId"
                  @click="applySelectedModel"
                >
                  {{ t("runtime.opencode.saveConfig") }}
                </button>
              </div>
            </div>

            <pre class="prompt-preview agent-output">{{ authResultText }}</pre>
  </section>
</template>
