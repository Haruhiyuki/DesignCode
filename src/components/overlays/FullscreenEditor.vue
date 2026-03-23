<script setup>
// 全屏编辑器 — 在独立视口中编辑设计 HTML 的可编辑文本区域。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useCanvasViewport } from "../../composables/useCanvasViewport.js";

const {
  viewport, fullscreenEditor, ui,
  fullscreenFrameShell, fullscreenFrameViewport, fullscreenDesignFrame,
  fullscreenEditorInputRef, fullscreenEditableHotspots, fullscreenHotspotLayerStyle,
  frameRevision,
} = useWorkspaceState();

const {
  hasDesign,
  fullscreenRenderablePreviewHtml, fullscreenSelectedEntry,
  fullscreenHasUnsavedChanges,
  canvasLoadingVisible, canvasLoadingLabel, canvasLoadingDetail,
} = useSetupConfig();

const {
  zoomIn, zoomOut, resetZoom,
  startCanvasPan, handleCanvasWheel,
  closeCanvasFullscreen,
  handleFullscreenFrameLoad, handleFullscreenHotspotMouseDown,
  handleFullscreenEditorInput, saveFullscreenEditorChanges,
  fullscreenEntryDraft,
} = useCanvasViewport();
</script>

<template>
  <div class="canvas-fullscreen-overlay">
    <div class="canvas-fullscreen-stage canvas-fullscreen-stage-edit">
      <div class="canvas-toolbar canvas-toolbar-fullscreen">
        <div class="canvas-toolbar-group">
          <button type="button" class="canvas-toolbar-button" @click="zoomOut">-</button>
          <span class="canvas-toolbar-value">{{ viewport.zoomPercent }}%</span>
          <button type="button" class="canvas-toolbar-button" @click="zoomIn">+</button>
        </div>
        <div class="canvas-toolbar-divider" aria-hidden="true"></div>
        <button type="button" class="canvas-toolbar-button" @click="resetZoom">{{ t("canvas.fit") }}</button>
        <div class="canvas-toolbar-spacer"></div>
        <div class="canvas-toolbar-group canvas-toolbar-group-actions">
          <button
            type="button"
            class="canvas-toolbar-button"
            :disabled="!fullscreenHasUnsavedChanges || fullscreenEditor.saveBusy"
            @click="saveFullscreenEditorChanges"
          >
            {{ fullscreenEditor.saveBusy ? t("common.saveBusy") : t("common.save") }}
          </button>
          <button type="button" class="canvas-toolbar-button" @click="closeCanvasFullscreen">{{ t("common.exit") }}</button>
        </div>
      </div>

      <button type="button" class="canvas-fullscreen-close" :aria-label="t('common.exitFullscreen')" @click="closeCanvasFullscreen">
        ×
      </button>

      <div class="canvas-fullscreen-body">
        <div ref="fullscreenFrameShell" class="frame-shell frame-shell-fullscreen" :class="{ 'is-empty': !hasDesign }">
          <div
            ref="fullscreenFrameViewport"
            class="frame-viewport frame-viewport-fullscreen"
            :class="{ 'is-empty': !hasDesign, 'is-dragging': ui.canvasDragging, 'is-editing': hasDesign }"
            @mousedown.prevent="startCanvasPan"
            @wheel.prevent="handleCanvasWheel"
          >
            <iframe
              v-if="hasDesign"
              :key="`fullscreen-${frameRevision}`"
              ref="fullscreenDesignFrame"
              title="Design Preview Fullscreen"
              sandbox="allow-same-origin"
              :srcdoc="fullscreenRenderablePreviewHtml"
              @load="handleFullscreenFrameLoad"
            ></iframe>
            <div
              v-if="hasDesign"
              class="fullscreen-edit-hotspots"
              :style="fullscreenHotspotLayerStyle"
              aria-hidden="true"
            >
              <button
                v-for="hotspot in fullscreenEditableHotspots"
                :key="hotspot.id"
                type="button"
                class="fullscreen-edit-hotspot"
                :class="{ 'is-selected': hotspot.id === fullscreenEditor.selectedEntryId }"
                :style="{
                  left: `${hotspot.left}px`,
                  top: `${hotspot.top}px`,
                  width: `${hotspot.width}px`,
                  height: `${hotspot.height}px`
                }"
                tabindex="-1"
                @mousedown="handleFullscreenHotspotMouseDown(hotspot.id, $event)"
              ></button>
            </div>
            <div v-else class="frame-placeholder">
              <div class="placeholder-copy">
                <strong>{{ t("canvas.emptyTitle1") }}</strong>
                <p>· {{ t("canvas.emptyHint1a") }}</p>
                <p>· {{ t("canvas.emptyHint1b") }}</p>
                <strong>{{ t("canvas.emptyTitle2") }}</strong>
                <p>· {{ t("canvas.emptyHint2a") }}</p>
                <p v-if="t('canvas.emptyHint2b')">· {{ t("canvas.emptyHint2b") }}</p>
                <p>{{ t("canvas.emptyHint2c") }}</p>
                <p>{{ t("canvas.emptyHint2d") }}</p>
              </div>
            </div>
          </div>
          <div v-if="canvasLoadingVisible" class="canvas-loading-overlay" aria-live="polite" aria-busy="true">
            <div class="canvas-loading-card">
              <span class="canvas-loading-spinner" aria-hidden="true"></span>
              <strong>{{ canvasLoadingLabel }}</strong>
              <p>{{ canvasLoadingDetail }}</p>
            </div>
          </div>
        </div>

        <aside v-if="hasDesign" class="canvas-fullscreen-editor" :class="{ 'is-empty': !fullscreenSelectedEntry }">
          <div class="canvas-fullscreen-editor-head">
            <div>
              <strong>{{ fullscreenSelectedEntry?.label || t("canvas.fullscreen.clickToEdit") }}</strong>
              <span>
                {{
                  fullscreenHasUnsavedChanges
                    ? t("canvas.fullscreen.unsavedChanges")
                    : t("canvas.fullscreen.inSync")
                }}
              </span>
            </div>
          </div>

          <div v-if="fullscreenSelectedEntry" class="canvas-fullscreen-editor-body">
            <textarea
              ref="fullscreenEditorInputRef"
              rows="8"
              :value="fullscreenEntryDraft()"
              @input="handleFullscreenEditorInput"
            ></textarea>
          </div>
          <div v-else class="canvas-fullscreen-editor-empty">
            <p>{{ t("canvas.fullscreen.editHint") }}</p>
            <small>{{ t("canvas.fullscreen.editNote") }}</small>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>
