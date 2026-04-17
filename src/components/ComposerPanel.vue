<script setup>
// 对话输入面板 — prompt 输入框、对话历史、agent stream block 渲染。
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "../composables/useWorkspaceState.js";
import { useSetupConfig } from "../composables/useSetupConfig.js";
import { useConversation } from "../composables/useConversation.js";
import { useDesignSession } from "../composables/useDesignSession.js";

const { state, ui, conversationScrollRef } = useWorkspaceState();
const {
  rightPanelTabs, consoleStatusLabel,
  conversationIsBusy, hasDesign,
  conversationPrimaryLabel, conversationPrimaryBusyLabel,
  runtimeBackendDisplayName, activeRuntimeBackend,
  currentRuntimeSessionLabel, conversationAgentOutputText,
} = useSetupConfig();
const {
  conversationEntries,
  conversationBlockExpandable, isConversationBlockExpanded, toggleConversationBlock,
  handleConversationBlockAction,
} = useConversation();
const { submitConversation, stopConversation, handleComposerKeydown } = useDesignSession();
</script>

<template>
  <aside class="panel panel-light composer-panel">
    <div class="composer-side-head">
      <div class="composer-side-head-copy">
        <h2>{{ t("chat.sessionConsole") }}</h2>
      </div>

      <div class="composer-side-meta">
        <span class="status-pill" :data-tone="state.statusTone">{{ consoleStatusLabel }}</span>
      </div>
    </div>

    <div class="composer-side-tabs">
      <button
        v-for="tab in rightPanelTabs"
        :key="tab.id"
        type="button"
        class="composer-side-tab"
        :class="{ active: ui.rightPanelTab === tab.id }"
        @click="ui.rightPanelTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </div>

    <section v-if="ui.rightPanelTab === 'chat'" class="composer-side-view composer-side-view-chat">
      <div class="conversation-chat-shell">
        <div ref="conversationScrollRef" class="conversation-chat-scroll custom-scrollbar">
          <div class="conversation-day-marker">
            <span>{{ t("chat.currentSession") }}</span>
          </div>

          <article
            v-for="entry in conversationEntries"
            :key="entry.id"
            class="conversation-message"
            :class="[`is-${entry.role}`, entry.isLive ? 'is-live' : '']"
          >
            <div class="conversation-message-head" :class="`is-${entry.role}`">
              <div class="conversation-avatar" :class="`is-${entry.role}`">
                {{ entry.actorInitial }}
              </div>
              <span>{{ entry.actorName }}</span>
              <strong>{{ entry.kindLabel }}</strong>
              <time>{{ entry.timeLabel }}</time>
            </div>

            <div v-if="entry.role === 'user'" class="conversation-user-bubble">
              {{ entry.text }}
            </div>

            <div v-else class="conversation-agent-blocks">
              <template v-for="block in entry.blocks" :key="block.id">
                <article
                  v-if="block.type === 'thought'"
                  class="agent-block agent-block-thought"
                  :class="{ 'agent-block-thought-rich': block.variant === 'rich' }"
                >
                  <p
                    class="conversation-block-copy"
                    :class="{ 'is-collapsed': conversationBlockExpandable(block) && !isConversationBlockExpanded(entry.id, block) }"
                  >
                    {{ block.content }}
                  </p>
                  <button
                    v-if="conversationBlockExpandable(block)"
                    type="button"
                    class="conversation-block-toggle"
                    @click="toggleConversationBlock(entry.id, block)"
                  >
                    {{ isConversationBlockExpanded(entry.id, block) ? t("chat.collapse") : t("chat.expand") }}
                  </button>
                </article>

                <article v-else-if="block.type === 'command'" class="agent-block agent-block-command" :data-status="block.status || 'success'">
                  <div class="agent-block-command-head">
                    <span>{{ block.title || "Agent CLI" }}</span>
                    <strong>{{ block.status || "success" }}</strong>
                  </div>
                  <div class="agent-block-command-line">
                    <span>❯</span>
                    <code>{{ block.command || "command_execution" }}</code>
                  </div>
                  <div
                    v-if="block.output"
                    class="agent-block-command-output conversation-block-copy"
                    :class="{ 'is-collapsed': conversationBlockExpandable(block) && !isConversationBlockExpanded(entry.id, block) }"
                  >
                    {{ block.output }}
                  </div>
                  <button
                    v-if="conversationBlockExpandable(block)"
                    type="button"
                    class="conversation-block-toggle conversation-block-toggle-dark"
                    @click="toggleConversationBlock(entry.id, block)"
                  >
                    {{ isConversationBlockExpanded(entry.id, block) ? t("chat.collapse") : t("chat.expandOutput") }}
                  </button>
                </article>

                <article v-else-if="block.type === 'todo'" class="agent-block agent-block-todo" :data-status="block.status || 'running'">
                  <div class="agent-block-todo-head">
                    <span>{{ block.title || "Todo List" }}</span>
                    <strong>{{ block.status === 'success' ? 'updated' : 'active' }}</strong>
                  </div>
                  <ul class="agent-todo-list">
                    <li v-for="item in block.items || []" :key="item.id" :data-status="item.status || 'pending'">
                      <span class="agent-todo-indicator"></span>
                      <span class="agent-todo-label">{{ item.label }}</span>
                    </li>
                  </ul>
                </article>

                <article v-else-if="block.type === 'confirm'" class="agent-block agent-block-confirm" :data-status="block.status || 'waiting'">
                  <div class="agent-block-confirm-head">
                    <span>{{ block.title || t("confirm.needConfirm") }}</span>
                    <strong>{{ block.status === 'resolved' ? 'resolved' : 'waiting' }}</strong>
                  </div>
                  <p
                    class="conversation-block-copy"
                    :class="{ 'is-collapsed': conversationBlockExpandable(block) && !isConversationBlockExpanded(entry.id, block) }"
                  >
                    {{ block.content }}
                  </p>
                  <div class="agent-block-confirm-actions">
                    <button
                      type="button"
                      class="button button-solid"
                      :disabled="!block.interactive"
                      @click="handleConversationBlockAction(block.id, 'confirm')"
                    >
                      {{ t("confirm.confirmAction") }}
                    </button>
                    <button
                      type="button"
                      class="button button-ghost"
                      :disabled="!block.interactive"
                      @click="handleConversationBlockAction(block.id, 'cancel')"
                    >
                      {{ t("confirm.cancelAction") }}
                    </button>
                  </div>
                  <button
                    v-if="conversationBlockExpandable(block)"
                    type="button"
                    class="conversation-block-toggle"
                    @click="toggleConversationBlock(entry.id, block)"
                  >
                    {{ isConversationBlockExpanded(entry.id, block) ? t("chat.collapse") : t("chat.expand") }}
                  </button>
                  <p v-if="block.note" class="agent-block-note">{{ block.note }}</p>
                </article>

                <article
                  v-else
                  class="agent-block agent-block-text"
                  :data-tone="block.tone || 'default'"
                >
                  <p
                    class="conversation-block-copy"
                    :class="{ 'is-collapsed': conversationBlockExpandable(block) && !isConversationBlockExpanded(entry.id, block) }"
                  >
                    {{ block.content }}
                  </p>
                  <button
                    v-if="conversationBlockExpandable(block)"
                    type="button"
                    class="conversation-block-toggle"
                    @click="toggleConversationBlock(entry.id, block)"
                  >
                    {{ isConversationBlockExpanded(entry.id, block) ? t("chat.collapse") : t("chat.expand") }}
                  </button>
                </article>
              </template>
            </div>
          </article>

          <article
            v-if="!conversationEntries.length"
            class="conversation-empty"
          >
            <h3>{{ t("chat.waitingFirstSession") }}</h3>
            <p>{{ t("chat.waitingHint") }}</p>
          </article>

          <div v-if="conversationIsBusy" class="conversation-working-row" aria-live="polite">
            <span class="working-pill">
              <span class="working-pill-dot" aria-hidden="true"></span>
              <span>working...</span>
            </span>
          </div>
        </div>

        <div class="conversation-composer">
          <label class="conversation-composer-shell">
            <textarea
              id="composerInput"
              v-model="state.composer"
              rows="5"
              :placeholder="hasDesign ? t('chat.editPlaceholder') : t('chat.designPlaceholder')"
              @keydown="handleComposerKeydown"
            ></textarea>
            <button
              v-if="state.isBusy"
              type="button"
              class="conversation-send-button conversation-stop-button"
              :title="t('chat.stopTitle')"
              @click="stopConversation"
            >
              <span class="conversation-stop-glyph" aria-hidden="true"></span>
              {{ t("chat.stop") }}
            </button>
            <button
              v-else
              type="button"
              class="conversation-send-button"
              :disabled="!state.composer.trim()"
              :title="conversationPrimaryLabel"
              @click="submitConversation"
            >
              {{ conversationPrimaryLabel }}
            </button>
          </label>
        </div>
      </div>
    </section>

    <section v-else class="composer-side-view composer-side-view-logs">
      <div class="composer-side-status">
        <article class="summary-card">
          <span>{{ t("chat.currentBackend") }}</span>
          <strong>{{ runtimeBackendDisplayName(activeRuntimeBackend) }}</strong>
        </article>
        <article class="summary-card">
          <span>{{ t("chat.currentSession") }}</span>
          <strong>{{ currentRuntimeSessionLabel }}</strong>
        </article>
      </div>

      <pre class="prompt-preview agent-output conversation-output composer-log-output">{{ conversationAgentOutputText }}</pre>
    </section>
  </aside>
</template>
