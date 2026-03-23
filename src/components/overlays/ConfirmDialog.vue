<script setup>
// 确认弹窗 — 危险操作（删除设计等）的二次确认。
import { useConfirmDialog } from "../../composables/useConfirmDialog.js";
const { confirmDialog, settleConfirmation } = useConfirmDialog();
</script>

<template>
  <div class="confirm-overlay" @click.self="settleConfirmation(false)">
    <section class="confirm-dialog panel panel-light" :data-tone="confirmDialog.tone">
      <div class="confirm-dialog-copy">
        <h2>{{ confirmDialog.title }}</h2>
        <p>{{ confirmDialog.message }}</p>
      </div>
      <div class="confirm-dialog-actions">
        <button type="button" class="button button-ghost" @click="settleConfirmation(false)">
          {{ confirmDialog.cancelLabel }}
        </button>
        <button
          type="button"
          class="button"
          :class="confirmDialog.tone === 'warn' ? 'button-ghost' : 'button-danger'"
          @click="settleConfirmation(true)"
        >
          {{ confirmDialog.confirmLabel }}
        </button>
      </div>
    </section>
  </div>
</template>
