<script setup>
// 左侧工具栏 — 抽屉切换、语言选择、导出按钮。
import { t, locale, setLocale, SUPPORTED_LOCALES } from "../i18n/index.js";
import { RAIL_ICONS } from "../constants/icons.js";
import { useWorkspaceState } from "../composables/useWorkspaceState.js";
import { useSetupConfig } from "../composables/useSetupConfig.js";
import { useCanvasViewport } from "../composables/useCanvasViewport.js";

const { ui } = useWorkspaceState();
const { leftRailTabs } = useSetupConfig();
const { selectDrawer } = useCanvasViewport();
</script>

<template>
  <aside class="tool-rail panel panel-dark">
    <div class="tool-rail-scroll">
      <button
        v-for="tab in leftRailTabs"
        :key="tab.id"
        type="button"
        class="rail-button"
        :class="{ active: ui.drawerOpen && ui.activeDrawer === tab.id }"
        :title="tab.label"
        @click="selectDrawer(tab.id)"
      >
        <span class="rail-button-icon" v-html="tab.icon"></span>
        <small>{{ tab.label }}</small>
      </button>
    </div>
      <div class="tool-rail-footer">
        <div class="locale-picker">
          <button
            type="button"
            class="rail-button"
            :title="t('drawer.settings.tab')"
            @click.stop="ui.localeMenuOpen = !ui.localeMenuOpen"
          >
            <span class="rail-button-icon" v-html="RAIL_ICONS.locale"></span>
            <small>Lang</small>
          </button>
          <div v-if="ui.localeMenuOpen" class="locale-menu" @click.stop>
            <button
              v-for="loc in SUPPORTED_LOCALES"
              :key="loc.id"
              type="button"
              class="locale-menu-item"
              :data-active="locale === loc.id"
              @click="setLocale(loc.id); ui.localeMenuOpen = false"
            >
              {{ loc.nativeLabel }}
            </button>
          </div>
        </div>
      </div>
  </aside>
</template>
