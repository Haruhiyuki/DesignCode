<script setup>
// 历史抽屉 — 设计版本列表、版本回退。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";
import { useTabs } from "../../composables/useTabs.js";

const { state, ui } = useWorkspaceState();
const { hasActiveDesignSession, designLibrary, formatHistoryDate, formatHistoryDateTime } = useSetupConfig();
const { startNewDesignSession, openDesignRecord, deleteDesignRecord, refreshDesignLibrary, restoreVersion } = useDesignSession();
const { createTabForNewDesign, openOrCreateForDesign } = useTabs();
</script>

<template>
  <section class="drawer-section">
    <p v-if="state.design.createError" class="inline-note inline-note-error">{{ state.design.createError }}</p>

    <div class="action-row">
      <button type="button" class="button button-solid" :disabled="state.design.createBusy" @click="createTabForNewDesign">
        {{ state.design.createBusy ? t("history.creatingDesign") : t("history.newDesign") }}
      </button>
      <button
        type="button"
        class="button button-ghost"
        :disabled="!hasActiveDesignSession || !state.design.browsingHistory"
        @click="openDesignRecord(state.design.currentId)"
      >
        {{ t("history.backToCurrent") }}
      </button>
      <button type="button" class="button button-ghost" @click="refreshDesignLibrary">
        {{ t("history.refresh") }}
      </button>
    </div>

    <div class="history-subtabs" role="tablist" :aria-label="t('history.switchLabel')">
      <button
        type="button"
        class="history-subtab"
        :class="{ active: ui.historyView === 'designs' }"
        @click="ui.historyView = 'designs'"
      >
        {{ t("history.designsTab") }}
      </button>
      <button
        type="button"
        class="history-subtab"
        :class="{ active: ui.historyView === 'commits' }"
        @click="ui.historyView = 'commits'"
      >
        {{ t("history.commitsTab") }}
      </button>
    </div>

    <div v-if="ui.historyView === 'designs'" class="layer-stack">
      <article
        v-for="item in designLibrary"
        :key="item.id"
        class="layer-card layer-card-action history-design-card"
        :data-active="item.id === state.design.currentId"
        @click="openOrCreateForDesign(item.id)"
      >
        <div class="history-design-card-head">
          <strong>{{ item.title }}</strong>
          <div class="history-design-card-actions">
            <span v-if="item.id === state.design.currentId" class="history-design-current">{{ t("history.currentBadge") }}</span>
            <button
              type="button"
              class="button button-ghost history-design-delete"
              :title="t('history.deleteDesignTitle')"
              @click.stop="deleteDesignRecord(item.id)"
            >
              {{ t("history.deleteAction") }}
            </button>
          </div>
        </div>
        <span>{{ formatHistoryDate(item.createdAt) }}</span>
      </article>
      <article v-if="!designLibrary.length" class="layer-card">
        <strong>{{ t("history.noDesigns") }}</strong>
        <span>{{ t("history.noDesignsHint") }}</span>
      </article>
    </div>

    <template v-else>
      <div class="layer-stack">
        <article
          v-for="(version, index) in state.versions"
          :key="version.commitHash || version.id"
          class="layer-card layer-card-action history-commit-card"
          :data-active="index === state.activeVersionIndex"
          @click="restoreVersion(index)"
        >
          <div class="history-commit-card-head">
            <strong>{{ version.id }} · {{ version.label }}</strong>
            <span v-if="index === state.activeVersionIndex" class="history-design-current">{{ t("history.currentBadge") }}</span>
          </div>
          <span>{{ formatHistoryDateTime(version.createdAt) }}</span>
        </article>
      </div>

      <article v-if="!state.versions.length" class="layer-card">
        <strong>{{ t("history.noCommits") }}</strong>
        <span>{{ t("history.noCommitsHint") }}</span>
      </article>
    </template>
  </section>
</template>
