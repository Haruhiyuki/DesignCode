<script setup>
// 顶栏 — 项目标题、尺寸信息、缩放控制、保存状态。
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "../composables/useWorkspaceState.js";
import { useSetupConfig } from "../composables/useSetupConfig.js";
import { useDesignSession } from "../composables/useDesignSession.js";
import { useCanvasViewport } from "../composables/useCanvasViewport.js";
import { useDesignExport } from "../composables/useDesignExport.js";

const { state, ui, exportMenuRef, headerTitleInputRef } = useWorkspaceState();
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

      <div class="topbar-design-identity" :title="projectTitle">
        <span class="topbar-design-label">{{ t("topbar.designLabel") }}</span>
        <input
          v-if="ui.headerTitleEditing"
          ref="headerTitleInputRef"
          class="topbar-title-input"
          :value="headerEditableTitle"
          @input="handleHeaderTitleInput"
          @blur="commitHeaderTitleEdit"
          @keydown="handleHeaderTitleKeydown"
        />
        <strong v-else>{{ projectTitle }}</strong>
        <button
          v-if="hasActiveDesignSession"
          type="button"
          class="topbar-title-edit"
          :aria-label="t('topbar.renameDesign')"
          :title="t('topbar.renameDesign')"
          @click="openHeaderTitleEditor"
        >
          ✎
        </button>
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
      <button type="button" class="button button-solid topbar-action" :disabled="state.design.createBusy" @click="startNewDesignSession">
        {{ t("topbar.newDesign") }}
      </button>
      <div ref="exportMenuRef" class="topbar-export">
        <button
          type="button"
          class="button button-ghost topbar-action"
          :disabled="!canExport"
          @click.stop="toggleExportMenu"
        >
          {{ t("topbar.download") }}
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
      </div>
    </div>
  </header>
</template>
