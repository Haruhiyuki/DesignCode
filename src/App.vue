<script setup>
// 应用根组件 — 顶层多标签页外壳。
// 每个 tab 拥有独立的 reactive 状态树（由 useTabs 管理）；
// WorkbenchContainer 用 :key="activeTabId" 包裹，切 tab 时整子树重挂载，
// 内部 composable 重新解析到新 tab 的 store。
// TabBar 现已融入 TopBar（替代原「设计稿：名称」段），不再占用独立一行。
// ConfirmDialog 仍保持全局单例（一次只允许一个模态对话框）。
import { computed } from "vue";
import { useTabs } from "./composables/useTabs.js";
import { useConfirmDialog } from "./composables/useConfirmDialog.js";
import WorkbenchContainer from "./components/WorkbenchContainer.vue";
import ConfirmDialog from "./components/overlays/ConfirmDialog.vue";

const { activeTabId, ensureActiveStore } = useTabs();
const { confirmDialog } = useConfirmDialog();

// 启动时确保至少一个 tab 存在；后续 useWorkspaceState 调用都能解析到 store。
ensureActiveStore();

// 当前活动 tab 的 store；activeTabId 变化时自动重算。
const activeStore = computed(() => {
  // 显式读取 activeTabId.value 以建立响应式依赖
  void activeTabId.value;
  return ensureActiveStore();
});
const hasDesign = computed(() => Boolean(activeStore.value.state.currentHtml));
const isBusy = computed(() => activeStore.value.state.isBusy);
</script>

<template>
  <div class="studio-shell" :class="{ 'has-design': hasDesign, 'is-busy': isBusy }">
    <div class="shell-glow shell-glow-a" aria-hidden="true"></div>
    <div class="shell-glow shell-glow-b" aria-hidden="true"></div>
    <div class="shell-grid" aria-hidden="true"></div>

    <!-- WorkbenchContainer 整 app 只 mount 一次；切 tab 由 useWorkspaceState 的
         Proxy 把 state 路由到新 tab 的 store。这样切 tab 是常数时间、不触发 bootstrap、
         也不会覆盖 tab 的设计状态。 -->
    <WorkbenchContainer />

    <ConfirmDialog v-if="confirmDialog.open" />
  </div>
</template>
