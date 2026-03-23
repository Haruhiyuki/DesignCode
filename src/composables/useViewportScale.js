import { onMounted, onBeforeUnmount } from "vue";

// 缩放下限，防止 UI 缩得太小无法操作
const MIN_ZOOM = 0.5;

/**
 * 视口自适应缩放：当窗口尺寸不足以容纳工作区最小宽度时，
 * 通过 html zoom 等比缩放整个界面，避免出现水平滚动条或组件截断。
 * zoom 作用在 document.documentElement 上，vw / vh 等视口单位会自动适配。
 */
export function useViewportScale() {
  function updateScale() {
    const root = document.documentElement;

    // 先清除已有缩放，以便在原始视口尺寸下测量内容的自然宽度
    root.style.zoom = "";

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const workspace = document.querySelector(".studio-workspace");

    if (!workspace) return;

    // scrollWidth 包含了 min-width 导致的溢出部分
    const contentWidth = workspace.scrollWidth;

    // 同时检查垂直方向：shell 有 100vh 限制，正常不会溢出，但极端小窗口可能触发
    const shell = document.querySelector(".studio-shell");
    const contentHeight = shell ? shell.scrollHeight : vh;

    const scaleX = contentWidth > vw ? vw / contentWidth : 1;
    const scaleY = contentHeight > vh ? vh / contentHeight : 1;
    const scale = Math.min(scaleX, scaleY);

    if (scale >= 1) return;

    root.style.zoom = String(Math.max(MIN_ZOOM, scale));
  }

  function onResize() {
    updateScale();
  }

  onMounted(() => {
    updateScale();
    window.addEventListener("resize", onResize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", onResize);
    document.documentElement.style.zoom = "";
  });

  return { updateScale };
}
