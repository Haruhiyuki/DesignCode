<script setup>
// 设计配置抽屉 — 尺寸、字段定义、brief 填充。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";
import { useCanvasViewport } from "../../composables/useCanvasViewport.js";

const { state, activeDropdown } = useWorkspaceState();
const { currentSizeMode, availableSizePresetOptions, fieldDefinitions } = useSetupConfig();
const { setSizeMode, setSizePreset, addCustomField, removeField } = useDesignSession();
const { openDropdown, closeDropdown } = useCanvasViewport();
</script>

<template>
  <section class="drawer-section setup-section">
    <div class="setup-size-panel">
      <div class="setup-size-mode-row">
        <label class="setup-size-mode-option">
          <input
            type="radio"
            name="sizeMode"
            :checked="currentSizeMode === 'preset'"
            @change="setSizeMode('preset')"
          />
          <span class="setup-size-mode-dot" aria-hidden="true"></span>
          <span>{{ t("setup.usePresetSize") }}</span>
        </label>

        <label class="setup-size-mode-option">
          <input
            type="radio"
            name="sizeMode"
            :checked="currentSizeMode === 'custom'"
            @change="setSizeMode('custom')"
          />
          <span class="setup-size-mode-dot" aria-hidden="true"></span>
          <span>{{ t("setup.useCustomSize") }}</span>
        </label>
      </div>

      <div v-if="currentSizeMode === 'preset'" class="field">
        <span>{{ t("setup.presetSize") }}</span>
        <div class="custom-select" :class="{ open: activeDropdown.id === 'select-size' }">
          <button type="button" class="custom-select-trigger" @click="openDropdown('select-size', $event.currentTarget)">
            <span class="custom-select-value">{{ availableSizePresetOptions.find(s => s.id === (state.sizeId === 'custom' ? '' : state.sizeId))?.label || '' }}</span>
            <span class="custom-select-arrow" aria-hidden="true"></span>
          </button>
          <div v-if="activeDropdown.id === 'select-size'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
            <button
              v-for="size in availableSizePresetOptions"
              :key="size.id || 'unset'"
              type="button"
              class="custom-select-option"
              :data-active="size.id === (state.sizeId === 'custom' ? '' : state.sizeId)"
              @click="setSizePreset(size.id); closeDropdown()"
            >
              {{ size.label }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="currentSizeMode === 'custom'" class="custom-size-grid setup-size-grid">
      <label class="field">
        <span>{{ t("setup.sizeName") }}</span>
        <input v-model="state.customSize.name" :placeholder="t('setup.customSizePlaceholder')" />
      </label>

      <div class="field">
        <span>{{ t("setup.unit") }}</span>
        <div class="custom-select" :class="{ open: activeDropdown.id === 'select-unit' }">
          <button type="button" class="custom-select-trigger" @click="openDropdown('select-unit', $event.currentTarget)">
            <span class="custom-select-value">{{ state.customSize.unit }}</span>
            <span class="custom-select-arrow" aria-hidden="true"></span>
          </button>
          <div v-if="activeDropdown.id === 'select-unit'" class="custom-select-dropdown" :style="{ minWidth: activeDropdown.rect?.width + 'px' }">
            <button type="button" class="custom-select-option" :data-active="state.customSize.unit === 'px'" @click="state.customSize.unit = 'px'; closeDropdown()">px</button>
            <button type="button" class="custom-select-option" :data-active="state.customSize.unit === 'mm'" @click="state.customSize.unit = 'mm'; closeDropdown()">mm</button>
          </div>
        </div>
      </div>

      <label class="field">
        <span>{{ t("setup.width") }}</span>
        <input v-model.number="state.customSize.width" type="number" min="1" step="1" />
      </label>

      <label class="field">
        <span>{{ t("setup.height") }}</span>
        <input v-model.number="state.customSize.height" type="number" min="1" step="1" />
      </label>
    </div>

    <div class="action-row setup-fields-toolbar">
      <span class="inline-note">{{ t("setup.fieldsNote") }}</span>
      <button type="button" class="button button-ghost" @click="addCustomField">{{ t("setup.addField") }}</button>
    </div>

    <div v-if="!fieldDefinitions.length" class="empty-fields-hint">
      <strong>{{ t("setup.noFieldsTitle") }}</strong>
      <p>{{ t("setup.noFieldsDesc") }}</p>
      <code>{{ t("setup.noFieldsExample") }}</code>
    </div>

    <div class="dynamic-field-grid setup-fields-grid">
      <article v-for="(slot, index) in fieldDefinitions" :key="slot.id" class="field-card">
        <div class="field-card-head">
          <div class="field-card-meta">
            <span class="field-tag">{{ slot.custom ? t("setup.customFieldTag") : t("setup.presetFieldTag") }}</span>
            <strong>{{ t("setup.fieldIndex", { index: index + 1 }) }}</strong>
          </div>
          <button
            type="button"
            class="button button-ghost button-icon"
            @click="removeField(slot.id)"
          >
            {{ t("setup.deleteField") }}
          </button>
        </div>
        <div class="field-card-body">
          <label class="field">
            <span>{{ t("setup.fieldName") }}</span>
            <input v-model="slot.label" :placeholder="slot.placeholder || t('setup.fieldNamePlaceholder')" />
          </label>
          <label class="field">
            <span>{{ t("setup.fieldContent") }}<em v-if="slot.required">{{ t("setup.fieldRequired") }}</em></span>
            <textarea
              v-if="/body|items|extra|aside|note|desc|content/i.test(slot.id)"
              v-model="state.fields[slot.id]"
              rows="4"
              :placeholder="slot.placeholder || ''"
            ></textarea>
            <input
              v-else
              v-model="state.fields[slot.id]"
              :placeholder="slot.placeholder || ''"
            />
          </label>
        </div>
      </article>
    </div>

    <label class="field">
      <span>{{ t("setup.designIntent") }}</span>
      <textarea
        v-model="state.brief"
        rows="4"
        :placeholder="t('setup.designIntentPlaceholder')"
      ></textarea>
    </label>

  </section>
</template>
