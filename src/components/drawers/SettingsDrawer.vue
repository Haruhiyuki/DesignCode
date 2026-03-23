<script setup>
// 设置抽屉 — 语言、代理端口、运行时路径等全局配置。
import { t, locale, setLocale, SUPPORTED_LOCALES } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useCanvasViewport } from "../../composables/useCanvasViewport.js";

const { activeDropdown } = useWorkspaceState();
const { openDropdown, closeDropdown } = useCanvasViewport();
</script>

<template>
  <section class="drawer-section">
    <div class="field">
      <span>{{ t("drawer.settings.language") }}</span>
      <div class="custom-select" :class="{ open: activeDropdown.id === 'select-locale' }">
        <button type="button" class="custom-select-trigger" @click="openDropdown('select-locale', $event.currentTarget)">
          <span class="custom-select-value">{{ SUPPORTED_LOCALES.find(l => l.id === locale)?.nativeLabel || locale }}</span>
          <span class="custom-select-arrow" aria-hidden="true"></span>
        </button>
        <div v-if="activeDropdown.id === 'select-locale'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
          <button
            v-for="loc in SUPPORTED_LOCALES"
            :key="loc.id"
            type="button"
            class="custom-select-option"
            :data-active="loc.id === locale"
            @click="setLocale(loc.id); closeDropdown()"
          >
            {{ loc.nativeLabel }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
