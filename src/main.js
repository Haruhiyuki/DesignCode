import { createApp } from "vue";
import App from "./App.vue";
import "./styles/workbench.css";

// 全局 JS 错误 / 未捕获 Promise rejection 都灌进会话控制台日志。
// 通过动态 import 装载 useCliStream，避免把会话控制台的加载拖到 boot 关键路径上。
async function installGlobalSessionErrorSinks() {
  try {
    const mod = await import("./composables/useCliStream.js");
    const { logSessionError } = mod.useCliStream();
    window.addEventListener("error", (event) => {
      const err = event.error || new Error(event.message || "Unknown window error");
      logSessionError("window-error", err, {
        file: event.filename || "",
        line: event.lineno || 0,
        col: event.colno || 0
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      logSessionError("unhandled-rejection", event.reason);
    });
  } catch {
    // useCliStream 拿不到就算了，不能让这层日志把 app 启动拖垮。
  }
}

createApp(App).mount("#app");
void installGlobalSessionErrorSinks();
