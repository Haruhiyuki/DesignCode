<script setup>
// 检视抽屉 — 可编辑文本字段列表，实时同步到画布 iframe。
import { t } from "../../i18n/index.js";
import { useWorkspaceState } from "../../composables/useWorkspaceState.js";
import { useSetupConfig } from "../../composables/useSetupConfig.js";
import { useDesignSession } from "../../composables/useDesignSession.js";

const { state } = useWorkspaceState();
const { hasDesign, editableTextEntries, inspectEditableCountLabel, inspectSaveTone, inspectSaveLabel } = useSetupConfig();
const { updateEditableTextEntry } = useDesignSession();

function inspectEntryDraft(entry) {
  return state.inspect.drafts[entry.id] ?? entry.value ?? "";
}
</script>

<template>
  <section class="drawer-section">
    <div class="inspect-panel-head">
      <div>
        <strong>{{ t("inspect.editableText") }}</strong>
        <span>{{ inspectEditableCountLabel }}</span>
      </div>
      <span class="inspect-save-pill" :data-tone="inspectSaveTone">{{ inspectSaveLabel }}</span>
    </div>

    <div class="inspect-text-list">
      <article v-if="!hasDesign" class="layer-card inspect-empty-card">
        <strong>{{ t("inspect.noDesign") }}</strong>
        <span>{{ t("inspect.noDesignHint") }}</span>
      </article>
      <article v-else-if="!editableTextEntries.length" class="layer-card inspect-empty-card">
        <strong>{{ t("inspect.noEditableFound") }}</strong>
        <span>{{ t("inspect.noEditableHint") }}</span>
      </article>
      <article
        v-for="(entry, index) in editableTextEntries"
        :key="entry.id"
        class="inspect-text-card"
      >
        <div class="inspect-text-head">
          <strong>{{ index + 1 }}. {{ entry.label }}</strong>
          <span>{{ entry.tagName }}</span>
        </div>
        <textarea
          :value="inspectEntryDraft(entry)"
          rows="3"
          :placeholder="entry.label"
          :disabled="state.isBusy || state.agent.busy"
          @input="updateEditableTextEntry(entry, $event.target.value)"
        ></textarea>
      </article>
    </div>
  </section>
</template>
