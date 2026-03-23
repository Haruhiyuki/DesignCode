<script setup>
// 风格预览浮层 — 放大展示选中的风格卡片及其 style guide。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";

const { state } = useWorkspaceState();
const { stylePreviewStyle, stylePreviewSurfaceStyle, stylePreviewGuideSections } = useSetupConfig();
const { selectStyle, closeStylePreview } = useDesignSession();
</script>

<template>
  <div class="style-preview-overlay" @click.self="closeStylePreview">
    <section class="style-preview-window panel panel-light">
      <div class="style-preview-head">
        <div>
          <p class="eyebrow">Style Preview</p>
          <h2>{{ stylePreviewStyle.name }}</h2>
          <p class="drawer-copy">{{ stylePreviewStyle.summary }}</p>
        </div>
        <div class="style-preview-actions">
          <button type="button" class="button button-ghost" @click="selectStyle(stylePreviewStyle.id)">
            {{ stylePreviewStyle.id === state.styleId ? t("styles.currentlyUsing") : t("styles.useThisStyle") }}
          </button>
          <button type="button" class="button button-ghost" @click="closeStylePreview">{{ t("styles.closePreview") }}</button>
        </div>
      </div>

      <div class="style-preview-canvas">
        <div class="style-preview-surface" :style="stylePreviewSurfaceStyle">
          <div class="style-preview-accent-line"></div>
          <p class="style-preview-kicker">{{ stylePreviewStyle.previewExample?.kicker || stylePreviewStyle.name }}</p>
          <h3>{{ stylePreviewStyle.previewExample?.title || stylePreviewStyle.name }}</h3>
          <p class="style-preview-body">{{ stylePreviewStyle.previewExample?.body || stylePreviewStyle.mood }}</p>
          <div class="style-preview-meta">
            <span v-for="keyword in stylePreviewStyle.keywords.slice(0, 4)" :key="`preview-${stylePreviewStyle.id}-${keyword}`">
              {{ keyword }}
            </span>
          </div>
        </div>
      </div>

      <div class="selection-strip">
        <span class="selection-chip" data-active="true">{{ t("styles.previewMood", { mood: stylePreviewStyle.mood }) }}</span>
        <span v-if="stylePreviewStyle.keywords?.length" class="selection-chip" data-active="true">
          {{ t("styles.previewKeywords", { keywords: stylePreviewStyle.keywords.join(" / ") }) }}
        </span>
      </div>

      <div class="style-preview-meta-grid">
        <article class="layer-card">
          <strong>{{ t("styles.titleFont") }}</strong>
          <span>{{ stylePreviewStyle.fonts.display.join(", ") }}</span>
        </article>
        <article class="layer-card">
          <strong>{{ t("styles.bodyFont") }}</strong>
          <span>{{ stylePreviewStyle.fonts.body.join(", ") }}</span>
        </article>
        <article class="layer-card">
          <strong>{{ t("styles.accentFont") }}</strong>
          <span>{{ stylePreviewStyle.fonts.accent.join(", ") }}</span>
        </article>
        <article class="layer-card">
          <strong>{{ t("styles.primaryAccent") }}</strong>
          <span>{{ stylePreviewStyle.tokens["--accent"] }} / {{ stylePreviewStyle.tokens["--accent-secondary"] }}</span>
        </article>
      </div>

      <div class="style-preview-guide-grid">
        <article v-for="section in stylePreviewGuideSections" :key="`preview-${section.key}`" class="layer-card">
          <strong>{{ section.label }}</strong>
          <span>{{ section.items.join(" / ") }}</span>
        </article>
        <article v-for="rule in stylePreviewStyle.rules" :key="`preview-rule-${rule}`" class="layer-card">
          <strong>{{ t("styles.executionRules") }}</strong>
          <span>{{ rule }}</span>
        </article>
      </div>
    </section>
  </div>
</template>
