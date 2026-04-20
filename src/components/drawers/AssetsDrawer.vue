<script setup>
// 素材抽屉 — 素材库浏览、导入、拖放、元数据编辑。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useArtAssets } from "../../composables/useArtAssets.js";
import { useDesignSession } from "../../composables/useDesignSession.js";

const { state, assetInputRef, assetDrawerRef } = useWorkspaceState();
const { artAssetLibrary, selectedAssetCount } = useSetupConfig();
const {
  triggerAssetImport, handleAssetImport, refreshArtAssetLibrary,
  setArtAssetSelection, saveArtAssetMetadata, deleteArtAssetFromLibrary,
  handleAssetDragEnter, handleAssetDragOver, handleAssetDragLeave, handleAssetDrop
} = useArtAssets();
const { assetFallbackLabel } = useDesignSession();
</script>

<template>
  <section
    ref="assetDrawerRef"
    class="drawer-section asset-drawer-section"
    :class="{ 'is-drop-active': state.assets.dropActive }"
    @dragenter.prevent="handleAssetDragEnter"
    @dragover.prevent="handleAssetDragOver"
    @dragleave.prevent="handleAssetDragLeave"
    @drop.prevent="handleAssetDrop"
  >
    <input
      ref="assetInputRef"
      type="file"
      multiple
      class="hidden-input"
      @change="handleAssetImport"
    />

    <div v-if="state.assets.dropActive" class="asset-drop-overlay" aria-hidden="true">
      <strong>{{ t("assets.dropToImport") }}</strong>
      <span>{{ t("assets.dropHint") }}</span>
    </div>

    <div class="asset-toolbar">
      <div class="selection-strip asset-toolbar-strip">
        <span class="selection-chip" data-active="true">{{ t("assets.countChip", { count: artAssetLibrary.length }) }}</span>
        <span class="selection-chip" :data-active="selectedAssetCount > 0">{{ t("assets.selectedChip", { count: selectedAssetCount }) }}</span>
      </div>
      <div class="action-row asset-toolbar-actions">
        <button
          type="button"
          class="button button-solid"
          :disabled="state.assets.importing"
          @click="triggerAssetImport"
        >
          {{ state.assets.importing ? t("assets.importing") : t("assets.importAssets") }}
        </button>
        <button type="button" class="button button-ghost" @click="refreshArtAssetLibrary">
          {{ t("assets.refresh") }}
        </button>
      </div>
    </div>

    <div class="asset-library asset-library-grid">
      <article
        v-for="asset in artAssetLibrary"
        :key="asset.id"
        class="asset-thumb-card"
        :class="{ active: state.assets.selectedIds.includes(asset.id) }"
      >
        <div class="asset-thumb-topline">
          <label class="asset-toggle asset-toggle-compact" @click.stop>
            <input
              type="checkbox"
              :checked="state.assets.selectedIds.includes(asset.id)"
              @change="setArtAssetSelection(asset.id, $event.target.checked)"
            />
            <span>{{ state.assets.selectedIds.includes(asset.id) ? t("assets.usedForDesign") : t("assets.useForDesign") }}</span>
          </label>

          <button
            type="button"
            class="asset-card-delete"
            :disabled="state.assets.deletingIds.includes(asset.id)"
            @click.stop="deleteArtAssetFromLibrary(asset.id)"
          >
            {{ state.assets.deletingIds.includes(asset.id) ? t("assets.deleting") : t("assets.delete") }}
          </button>
        </div>

        <div
          class="asset-thumb-media"
          :class="{ 'is-empty': !state.assets.previewUrls[asset.id] }"
          @click="setArtAssetSelection(asset.id, !state.assets.selectedIds.includes(asset.id))"
        >
          <img
            v-if="state.assets.previewUrls[asset.id]"
            :src="state.assets.previewUrls[asset.id]"
            :alt="asset.name"
            loading="lazy"
          />
          <div v-else class="asset-thumb-fallback">{{ assetFallbackLabel(asset) }}</div>
        </div>

        <div class="asset-thumb-body">
          <label class="field asset-name-field" @click.stop>
            <input
              v-model="state.assets.nameDrafts[asset.id]"
              type="text"
              :placeholder="t('assets.namePlaceholder')"
              @blur="saveArtAssetMetadata(asset.id)"
              @keydown.enter.prevent="saveArtAssetMetadata(asset.id)"
            />
          </label>
          <label class="field asset-note-field" @click.stop>
            <textarea
              v-model="state.assets.noteDrafts[asset.id]"
              rows="3"
              :placeholder="t('assets.notePlaceholder')"
              @blur="saveArtAssetMetadata(asset.id)"
            ></textarea>
          </label>
        </div>
      </article>

      <article v-if="!artAssetLibrary.length" class="layer-card asset-empty-card">
        <strong>{{ t("assets.emptyLibrary") }}</strong>
        <span>{{ t("assets.emptyLibraryHint") }}</span>
      </article>
    </div>
  </section>
</template>
