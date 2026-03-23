<script setup>
// 风格抽屉 — 预设风格卡片选择、风格预览。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";

const { state, ui } = useWorkspaceState();
const { styles, currentStyle, styleCardSurfaceStyle } = useSetupConfig();
const { selectStyle, openStylePreview } = useDesignSession();
</script>

<template>
  <section class="drawer-section">
    <div class="selection-strip">
      <span class="selection-chip" :data-active="Boolean(state.styleId)">
        {{ t("styles.currentStyle", { name: currentStyle?.name || t("styles.noStyle") }) }}
      </span>
    </div>

    <div class="style-grid">
      <article
        class="style-card style-card-empty"
        :class="{ active: !state.styleId }"
      >
        <div class="style-card-preview style-card-preview-empty">
          <div class="style-card-preview-surface style-swatch-empty">
            <span class="style-card-preview-accent"></span>
            <p class="style-card-preview-kicker">NO PRESET</p>
            <h3>Freeform</h3>
            <p class="style-card-preview-body">{{ t("styles.noStylePreview") }}</p>
          </div>
        </div>
        <strong>{{ t("styles.noStyleTitle") }}</strong>
        <small>{{ t("styles.noStyleSubtitle") }}</small>
        <p class="style-card-summary">{{ t("styles.noStyleSummary") }}</p>
        <div class="style-card-actions">
          <button type="button" class="button button-ghost style-card-action" @click="selectStyle('')">
            {{ !state.styleId ? t("styles.currentlyUsing") : t("styles.useThis") }}
          </button>
        </div>
      </article>
      <article
        v-for="style in styles"
        :key="style.id"
        class="style-card"
        :class="{ active: style.id === state.styleId, 'is-previewing': ui.stylePreviewId === style.id }"
      >
        <div class="style-card-preview">
          <div class="style-card-preview-surface" :style="styleCardSurfaceStyle(style)">
            <span class="style-card-preview-accent"></span>
            <p class="style-card-preview-kicker">{{ style.previewExample?.kicker || style.name }}</p>
            <h3>{{ style.previewExample?.title || style.name }}</h3>
            <p class="style-card-preview-body">{{ style.previewExample?.body || style.summary }}</p>
            <div class="style-card-preview-meta">
              <span v-for="keyword in style.keywords.slice(0, 2)" :key="`${style.id}-preview-${keyword}`">
                {{ keyword }}
              </span>
            </div>
          </div>
        </div>
        <strong>{{ style.name }}</strong>
        <small>{{ style.mood }}</small>
        <div class="style-card-tags">
          <span v-for="keyword in style.keywords.slice(0, 3)" :key="`${style.id}-${keyword}`" class="style-card-tag">
            {{ keyword }}
          </span>
        </div>
        <p class="style-card-summary">{{ style.summary }}</p>
        <div class="style-card-actions">
          <button type="button" class="button button-ghost style-card-action" @click="selectStyle(style.id)">
            {{ style.id === state.styleId ? t("styles.currentlyUsing") : t("styles.useThisStyle") }}
          </button>
          <button type="button" class="button button-ghost style-card-action" @click="openStylePreview(style.id)">
            {{ t("styles.floatPreview") }}
          </button>
        </div>
      </article>
    </div>

  </section>
</template>
