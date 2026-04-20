<script setup>
// 顶栏 — 品牌、标签页栏（融合设计稿名称）、尺寸/保存/runtime 芯片、右侧操作。
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "../composables/useWorkspaceState.js";
import { useSetupConfig } from "../composables/useSetupConfig.js";
import { useDesignSession } from "../composables/useDesignSession.js";
import { useCanvasViewport } from "../composables/useCanvasViewport.js";
import { useDesignExport } from "../composables/useDesignExport.js";
import { useTabs } from "../composables/useTabs.js";
import ExportToast from "./overlays/ExportToast.vue";

const { state, ui, exportMenuRef, headerTitleInputRef } = useWorkspaceState();
const { tabs, activeTabId, createTab, closeTab, switchTo } = useTabs();
const createTabForNewDesign = () => createTab({ activate: true, pendingAction: { type: "new" } });
const {
  EXPORT_QUALITY_OPTIONS,
  projectTitle, headerEditableTitle,
  hasActiveDesignSession, topbarSaveStatus, headerSizeLabel,
  canExport, canExportPsd,
  runtimeBackendDisplayName, activeRuntimeBackend,
} = useSetupConfig();
const {
  openHeaderTitleEditor, commitHeaderTitleEdit,
  handleHeaderTitleInput, handleHeaderTitleKeydown,
  startNewDesignSession,
} = useDesignSession();
const { toggleDrawerVisibility, toggleExportMenu } = useCanvasViewport();
const { runExportAction } = useDesignExport();

const currentRuntimeHeaderLabel = computed(() => t("runtime.currentRuntimeHeader", { backend: runtimeBackendDisplayName(activeRuntimeBackend.value) }));

function handleTabClick(tabId) {
  if (tabId !== activeTabId.value) {
    switchTo(tabId);
  }
}

function handleTabClose(event, tabId) {
  event.stopPropagation();
  void closeTab(tabId);
}

function handleTabMouseDown(event, tabId) {
  // 鼠标中键关闭（主流编辑器/浏览器标准行为）
  if (event.button === 1) {
    event.preventDefault();
    void closeTab(tabId);
  }
}

function handleTabDoubleClick(event, tabId) {
  // 双击活动 tab 进入重命名模式
  if (tabId === activeTabId.value && hasActiveDesignSession.value) {
    event.preventDefault();
    openHeaderTitleEditor();
  }
}

function handleTabWheel(event) {
  const delta = event.deltaY;
  if (Math.abs(delta) < 1) return;
  event.currentTarget.scrollLeft += delta;
}

// 函数式 ref：v-for 内部的 ref 默认会被 Vue 收集成数组；这里用函数 ref
// 直接把激活 tab 的 input 元素写入 headerTitleInputRef.value（一个普通 Ref）。
function bindRenameInput(el, tabId) {
  if (tabId === activeTabId.value) {
    headerTitleInputRef.value = el;
  }
}
</script>

<template>
  <header class="studio-topbar panel panel-dark">
    <div class="topbar-mainline">
      <button type="button" class="sidebar-toggle" :aria-label="ui.drawerOpen ? t('topbar.collapseMenu') : t('topbar.expandMenu')" @click="toggleDrawerVisibility">
        <span></span>
        <span></span>
        <span></span>
      </button>

      <div class="brand-block brand-block-compact">
        <img class="brand-mark-logo" src="/src-tauri/icons/128x128.png" alt="DC" />
        <div class="brand-copy brand-copy-compact">
          <h1>DesignCode</h1>
        </div>
      </div>

      <div class="topbar-divider" aria-hidden="true"></div>

      <!-- 多标签页：融合到 TopBar 中，取代「设计稿：名称」。活动 tab 可双击重命名。 -->
      <div class="topbar-tabs">
        <div class="topbar-tab-list" @wheel.passive="handleTabWheel">
          <div
            v-for="tab in tabs"
            :key="tab.id"
            class="topbar-tab"
            :class="{ 'is-active': tab.id === activeTabId }"
            :title="tab.title"
            @click="handleTabClick(tab.id)"
            @mousedown="handleTabMouseDown($event, tab.id)"
            @dblclick="handleTabDoubleClick($event, tab.id)"
          >
            <input
              v-if="tab.id === activeTabId && ui.headerTitleEditing"
              :ref="el => bindRenameInput(el, tab.id)"
              class="topbar-tab-input"
              :value="headerEditableTitle"
              @input="handleHeaderTitleInput"
              @blur="commitHeaderTitleEdit"
              @keydown="handleHeaderTitleKeydown"
              @click.stop
            />
            <span v-else class="topbar-tab-label">{{ tab.title }}</span>

            <button
              v-if="tab.id === activeTabId && hasActiveDesignSession && !ui.headerTitleEditing"
              type="button"
              class="topbar-tab-rename"
              :aria-label="t('topbar.renameDesign')"
              :title="t('topbar.renameDesign')"
              @click.stop="openHeaderTitleEditor"
            >
              ✎
            </button>

            <button
              v-if="tabs.length > 1"
              type="button"
              class="topbar-tab-close"
              :aria-label="t('tab.closeTab')"
              :title="t('tab.closeTab')"
              @click="handleTabClose($event, tab.id)"
            >×</button>
          </div>
        </div>

        <button
          type="button"
          class="topbar-tab-new"
          :aria-label="t('tab.newTab')"
          :title="t('tab.newTab')"
          @click="createTabForNewDesign"
        >+</button>
      </div>

      <!-- 活动 tab 的状态 chip：runtime / 尺寸 / 保存状态 -->
      <div class="topbar-chips">
        <span class="topbar-runtime-chip">{{ currentRuntimeHeaderLabel }}</span>
        <span class="topbar-size-chip">{{ headerSizeLabel }}</span>
        <span
          v-if="hasActiveDesignSession"
          class="topbar-save-chip"
          :data-status="topbarSaveStatus"
        >
          <span v-if="topbarSaveStatus === 'saving' || topbarSaveStatus === 'pending' || topbarSaveStatus === 'busy'" class="topbar-save-spinner"></span>
          <span v-else-if="topbarSaveStatus === 'saved'" class="topbar-save-check">✓</span>
          {{ topbarSaveStatus === 'saving' || topbarSaveStatus === 'pending'
            ? t("topbar.saving")
            : topbarSaveStatus === 'busy'
              ? t("topbar.working")
              : topbarSaveStatus === 'saved'
                ? t("topbar.saved")
                : "" }}
        </span>
      </div>
    </div>

    <div class="topbar-inline-actions">
      <button type="button" class="button button-solid topbar-action" :disabled="state.design.createBusy" @click="createTabForNewDesign">
        {{ t("topbar.newDesign") }}
      </button>
      <div ref="exportMenuRef" class="topbar-export">
        <button
          type="button"
          class="button button-ghost topbar-action topbar-export-trigger"
          :class="{ 'is-exporting': state.design.exportBusy }"
          :disabled="!canExport || state.design.exportBusy"
          @click.stop="toggleExportMenu"
        >
          <span v-if="state.design.exportBusy" class="topbar-save-spinner" aria-hidden="true"></span>
          {{ state.design.exportBusy ? t("topbar.exporting") : t("topbar.download") }}
        </button>

        <div v-if="ui.exportMenuOpen" class="topbar-export-menu" @click.stop>
          <div class="topbar-export-quality">
            <span class="topbar-export-caption">{{ t("topbar.exportQualityCaption") }}</span>
            <div class="topbar-export-quality-group">
              <button
                v-for="option in EXPORT_QUALITY_OPTIONS"
                :key="option.id"
                type="button"
                class="topbar-export-quality-chip"
                :class="{ active: ui.exportScale === option.scale }"
                @click="ui.exportScale = option.scale"
              >
                <span>{{ option.label }}</span>
                <small>{{ option.scale }}x</small>
              </button>
            </div>
          </div>
          <button type="button" class="topbar-export-item" @click="runExportAction('png')">{{ t("topbar.exportPng") }}</button>
          <button type="button" class="topbar-export-item" @click="runExportAction('svg')">{{ t("topbar.exportSvg") }}</button>
          <button type="button" class="topbar-export-item" @click="runExportAction('html')">{{ t("topbar.exportHtml") }}</button>
          <button type="button" class="topbar-export-item" @click="runExportAction('print')">{{ t("topbar.exportPdf") }}</button>
          <button v-if="canExportPsd" type="button" class="topbar-export-item" @click="runExportAction('psd')">{{ t("topbar.exportPsd") }}</button>
        </div>

        <ExportToast />
      </div>
    </div>
  </header>
</template>
