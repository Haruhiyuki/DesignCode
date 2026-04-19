// CLI stream 处理 — 监听 Codex/Claude/Gemini 的 stdout/stderr 事件，
// 格式化日志、解析 JSON block、驱动对话面板的实时更新。
import { listenCliOutput } from "../lib/desktop-api.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useConversation } from "./useConversation.js";
import { useTabs, withTabContext, effectiveActiveTabId } from "./useTabs.js";

// ---------------------------------------------------------------------------
// 模块级单例状态
// ---------------------------------------------------------------------------

const { state } = useWorkspaceState();
const { activeRuntimeBackend, currentConversationScopeKey } = useSetupConfig();
const {
  normalizeTodoEntries, resolveApprovalDetails, pickFirstText,
  upsertAgentStreamBlock, parseCliStreamBlock
} = useConversation();

// ---------------------------------------------------------------------------
// 模块级 let 变量
// ---------------------------------------------------------------------------

// 多标签页：每个 tab 维护独立的 stream 监听器；不再用单例 removeCodexStreamListener。
// 切 tab 时旧 tab 的 stream 仍在后台运行并往 tab 自己的 store 写入。
const tabStreamListeners = new Map(); // tabId -> { streamId, off, heartbeatTimer, startedAt, lastEventAt, lastHeartbeatAt, suppressed }
let activeCodexSuppressedLines = new Set();
let geminiStderrCapacityModel = "";

// ---------------------------------------------------------------------------
// 流 ID 和辅助
// ---------------------------------------------------------------------------

function nextCodexStreamId() {
  return `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildCodexSuppressedLines(blocks = []) {
  const lines = new Set();
  for (const block of blocks) {
    for (const line of String(block || "").split("\n")) {
      const normalized = line.trim();
      if (normalized) {
        lines.add(normalized);
      }
    }
  }
  return lines;
}

const HIDDEN_SOURCE_MESSAGE = t("chat.hiddenSource");

// ---------------------------------------------------------------------------
// 输出格式化
// ---------------------------------------------------------------------------

function compactConsoleText(value, limit = 360) {
  const text = String(value || "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function looksLikeSourceDump(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  if (
    text.includes("```html") ||
    text.includes("```css") ||
    text.includes("```svg") ||
    text.includes("```xml") ||
    text.includes("<!DOCTYPE html") ||
    text.includes("</html>") ||
    text.includes("<style") ||
    text.includes("<svg")
  ) {
    return true;
  }

  const tagMatches = text.match(/<([a-z][\w:-]*)\b[^>]*>/gi);
  return text.length > 900 && Array.isArray(tagMatches) && tagMatches.length >= 8;
}

function sanitizeAgentConsoleMessage(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const beforeFence = text.includes("```")
    ? text.split("```")[0].trim()
    : text;

  if (looksLikeSourceDump(text)) {
    if (beforeFence && !looksLikeSourceDump(beforeFence)) {
      return compactConsoleText(beforeFence);
    }
    return HIDDEN_SOURCE_MESSAGE;
  }

  return compactConsoleText(text, 640);
}

function sanitizeAgentLogMessage(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (looksLikeSourceDump(text)) {
    return HIDDEN_SOURCE_MESSAGE;
  }

  return text;
}

function formatStreamElapsedTag(timestamp = Date.now()) {
  // 从当前 tab（或 withTabContext override 的 origin tab）对应的 stream handle
  // 取 startedAt。之前引用的 module-level codexStreamStartedAt 在改成 per-tab
  // Map 时被删掉了，但这里漏改导致 ReferenceError——整个 stream 事件处理块
  // 被异常中断，日志面板永远拿不到内容。
  const handle = tabStreamListeners.get(effectiveActiveTabId());
  if (!handle?.startedAt) {
    return "";
  }
  const elapsed = Math.max(0, timestamp - handle.startedAt);
  const totalSeconds = elapsed / 1000;
  return `+${totalSeconds.toFixed(1)}s`;
}

function prefixMultilineLog(text, prefix) {
  if (!prefix) {
    return text;
  }

  return String(text || "")
    .split("\n")
    .map((line) => (line ? `[${prefix}] ${line}` : line))
    .join("\n");
}

function summarizeCliResultOutput(value, fallback = "") {
  const message = sanitizeAgentConsoleMessage(value);
  if (!message || message === HIDDEN_SOURCE_MESSAGE) {
    return fallback;
  }
  return message;
}

function formatCodexJsonEvent(event) {
  const eventType = event.type || "";

  if (
    eventType === "thread.started" ||
    eventType === "turn.completed"
  ) {
    return null;
  }

  if (eventType === "turn.started") {
    return "[codex] Turn started";
  }

  if (eventType === "step-start") {
    return "[codex] Thinking...";
  }

  if (eventType === "error" && event.message) {
    return `[error] ${event.message}`;
  }

  if (eventType === "turn.failed") {
    return `[error] ${event.error?.message || event.message || "Codex turn failed."}`;
  }

  if (eventType === "tool") {
    const tool = event.tool || "tool";
    const status = event.state?.status || event.status || "running";
    const title = String(event.state?.title || "").trim();
    const count = event.state?.metadata?.count;
    const parts = [`[tool] ${tool}`];
    if (title) {
      parts.push(title);
    }
    if (typeof count === "number") {
      parts.push(`${count} items`);
    }
    if (status && status !== "completed") {
      parts.push(status);
    }
    return parts.join(" · ");
  }

  if (eventType === "item.completed") {
    const item = event.item || {};
    if (item.type === "file_change") {
      return item.path ? `[file] ${item.path}` : "[file] updated";
    }
    if (item.type === "command_execution") {
      return null;
    }
    if (item.type === "todo_list") {
      const items = normalizeTodoEntries(item);
      return items.length ? t("chat.todoCount", { count: items.length }) : "[todo] Updated task list";
    }
      if (item.type === "agent_message" && item.text) {
      const message = sanitizeAgentLogMessage(item.text);
      return message ? `[message]\n${message}` : null;
    }
    if (item.type === "error" && item.message) {
      return `[error] ${item.message}`;
    }
    if (resolveApprovalDetails(item)) {
      return t("chat.confirmNeeded");
    }
    return item.type ? `[item] ${item.type}` : null;
  }

  if (eventType === "item.started") {
    const item = event.item || {};
    if (item.type === "command_execution") {
      return item.command ? `[command] ${item.command}` : "[command] running";
    }
    if (item.type === "todo_list") {
      const items = normalizeTodoEntries(item);
      return items.length ? t("chat.todoCount", { count: items.length }) : "[todo] Updating task list";
    }
    if (resolveApprovalDetails(item)) {
      return t("chat.confirmNeeded");
    }
    return item.type ? `[item] ${item.type}` : null;
  }

  if (event.message) {
    const message = sanitizeAgentLogMessage(event.message);
    return message ? `[codex]\n${message}` : null;
  }

  return eventType ? `[codex] ${eventType}` : null;
}

// Claude Code 的 stream-json 在每个 turn 结束时会连发两条：
//   1) assistant 消息里的最后一个 text block（正式回答）
//   2) result 事件，字段 event.result 和上面那段 text 一字不差
// 两次都打印会出现"已将奖金改为 2048 元" 连续重复两遍。这里用一个
// 模块级缓存记录最近 assistant text，在 result 里命中就只发终止标记。
let _lastClaudeAssistantText = "";

function formatClaudeJsonEvent(event) {
  const eventType = event.type || "";

  // Claude CLI 的 stream-json 会为每个文本/JSON delta 发一条 `stream_event`，
  // Write 工具写一份 20KB HTML 就能轰出几千条。它们是增量的子级事件，
  // 最终内容会被包在后续的 `assistant` / `user` 事件里，我们从来不需要独立渲染。
  // 留着只会让 state.agent.output 字符串以 O(n²) 速度膨胀，主线程直接冻死。
  if (eventType === "stream_event") {
    return null;
  }

  if (eventType === "system" && event.subtype === "init") {
    _lastClaudeAssistantText = "";
    return "[claude] Session started";
  }

  if (eventType === "assistant") {
    const items = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of items) {
      if (item?.type === "tool_use") {
        const toolName = String(item.name || "").trim();
        const toolInput = item.input || {};

        if (toolName === "Bash") {
          const command = pickFirstText(
            toolInput.command,
            toolInput.cmd,
            toolInput.commandLine,
            toolInput.argv
          );
          return command ? `[command] ${command}` : "[command] Bash";
        }

        if (toolName === "TodoWrite") {
          const todoItems = normalizeTodoEntries(toolInput);
          return todoItems.length ? t("chat.todoCount", { count: todoItems.length }) : "[todo] Updated task list";
        }

        return toolName ? `[claude] ${toolName}` : "[claude] tool_use";
      }

      if (item?.type === "text") {
        const message = sanitizeAgentLogMessage(item.text || "");
        if (message) {
          _lastClaudeAssistantText = message;
          return `[message]\n${message}`;
        }
      }

      if (item?.type === "thinking" || item?.type === "reasoning" || item?.type === "redacted_thinking") {
        const thinking = sanitizeAgentLogMessage(
          pickFirstText(item.text, item.thinking, item.content, item.summary)
        );
        if (thinking) {
          return `[thought]\n${thinking}`;
        }
      }
    }
  }

  if (eventType === "result") {
    const result = sanitizeAgentLogMessage(event.result || "");
    // result 事件的文本几乎总是上一个 assistant text 的复述；命中就只发终止标记，
    // 避免日志里同一段话连续出现两遍。仅当 result 和 assistant text 不同（极少数
    // 异常路径）时才把 result 文本也打印出来。
    if (!result || result === _lastClaudeAssistantText) {
      _lastClaudeAssistantText = "";
      return "[claude] Completed";
    }
    _lastClaudeAssistantText = "";
    return `[final]\n${result}`;
  }

  if (event.error) {
    return `[error] ${event.error}`;
  }

  return eventType ? `[claude] ${eventType}` : null;
}

function formatGeminiJsonEvent(event) {
  const eventType = event.type || event.event || "";
  if (
    eventType === "designcode.session"
    || eventType === "designcode.result"
    || eventType === "designcode.models"
  ) {
    return null;
  }

  if (eventType === "designcode.phase") {
    const phaseMessage = sanitizeAgentLogMessage(event.message || "");
    return phaseMessage ? `[gemini] ${phaseMessage}` : null;
  }

  if (eventType === "designcode.error") {
    const errorMessage = sanitizeAgentConsoleMessage(event.message || event.error || "");
    return errorMessage ? `[error] ${errorMessage}` : t("chat.geminiError");
  }

  const message =
    event.result ||
    event.response ||
    event.text ||
    event.message?.text ||
    event.content?.text ||
    event.content ||
    "";

  if (message) {
    const safeMessage = sanitizeAgentLogMessage(message);
    if (!safeMessage) {
      return null;
    }
    if (eventType === "result" || eventType === "final") {
      return `[final]\n${safeMessage}`;
    }
    return `[gemini]\n${safeMessage}`;
  }

  return eventType ? `[gemini] ${eventType}` : null;
}

function formatOpencodeJsonEvent(event) {
  const eventType = event.type || "";

  if (event.suppressLogLine) {
    return null;
  }

  if (eventType === "opencode.text") {
    const content = sanitizeAgentLogMessage(event.content || "");
    return content ? `[message]\n${content}` : null;
  }

  if (eventType === "opencode.thinking") {
    const content = sanitizeAgentLogMessage(event.content || "");
    return content ? `[thought]\n${content}` : null;
  }

  if (eventType === "opencode.tool") {
    const tool = event.tool || "tool";
    const status = event.status || "running";
    const detail = String(event.detail || "").trim();
    const parts = [`[tool] ${tool}`];
    if (detail) {
      parts.push(detail);
    }
    if (status && status !== "completed") {
      parts.push(status);
    }
    return parts.join(" · ");
  }

  if (eventType === "opencode.file") {
    const path = event.path || "";
    const tool = event.tool || "file";
    const status = String(event.status || "completed").trim();
    const detail = String(event.detail || "").trim();
    const prefix = path ? `[${tool}] ${path}` : detail ? `[${tool}] ${detail}` : `[${tool}] updated`;
    return status && status !== "completed" ? `${prefix} · ${status}` : prefix;
  }

  if (eventType === "opencode.error") {
    return event.message ? `[error] ${event.message}` : "[error] OpenCode error";
  }

  if (eventType === "opencode.status") {
    return event.message ? `[opencode] ${event.message}` : null;
  }

  if (event.message) {
    const message = sanitizeAgentLogMessage(event.message);
    return message ? `[opencode]\n${message}` : null;
  }

  return eventType ? `[opencode] ${eventType}` : null;
}

function sanitizeGeminiStderrLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return null;
  }
  if (text === "Loaded cached credentials.") {
    return null;
  }
  if (text.includes("[STARTUP] Phase 'cli_startup' was started but never ended.")) {
    return null;
  }
  const capacityMatch = text.match(/No capacity available for model\s+([^\s"']+)/i)
    || text.match(/"model"\s*:\s*"([^"]+)"/i);
  if (capacityMatch?.[1]) {
    const model = capacityMatch[1].trim();
    if (geminiStderrCapacityModel === model) {
      return null;
    }
    geminiStderrCapacityModel = model;
    return null;
  }
  if (
    /^Attempt \d+ failed with status 429\./.test(text)
    || /No capacity available for model/i.test(text)
    || /MODEL_CAPACITY_EXHAUSTED/i.test(text)
    || /RESOURCE_EXHAUSTED/i.test(text)
    || /rateLimitExceeded/i.test(text)
  ) {
    return null;
  }
  if (
    text.startsWith("GaxiosError:")
    || text.startsWith("at ")
    || /^[{'"]/.test(text)
    || /^(config|response|headers|request|data|proxy|url|method|params|body|signal|retry|paramsSerializer|validateStatus|agent|errorRedactor):/i.test(text)
    || text.startsWith("[Symbol")
    || text === "{"
    || text === "}"
    || text === "["
    || text === "]"
    || text === "},"
    || text === "],"
    || text === "}, {"
  ) {
    return null;
  }
  return text;
}

function formatCliBlockSummary(block, backend) {
  if (!block || typeof block !== "object") {
    return null;
  }

  if (block.suppressLogLine) {
    return null;
  }

  if (block.type === "confirm") {
    const title = sanitizeAgentLogMessage(block.title || t("confirm.needConfirm"));
    const content = sanitizeAgentLogMessage(block.content || "");
    return content ? `[confirm] ${title}\n${content}` : `[confirm] ${title}`;
  }

  if (block.type === "command") {
    const command = block.command ? `[command] ${block.command}` : `[${backend}] command`;
    const output = sanitizeAgentLogMessage(block.output || "");
    return output ? `${command}\n[output]\n${output}` : command;
  }

  if (block.type === "todo") {
    const items = Array.isArray(block.items)
      ? block.items
          .map((item) => {
            const label = sanitizeAgentLogMessage(item?.label || "");
            if (!label) {
              return null;
            }
            return `- [${String(item?.status || "pending")}] ${label}`;
          })
          .filter(Boolean)
      : [];
    if (items.length) {
      return [`[todo] ${block.title || "Todo List"}`, ...items].join("\n");
    }
    return "[todo] Updated task list";
  }

  if (block.type === "thought") {
    const content = sanitizeAgentLogMessage(block.content || "");
    if (!content) {
      return null;
    }
    return `[thought]\n${content}`;
  }

  if (block.type === "text") {
    const content = sanitizeAgentLogMessage(block.content || "");
    if (!content) {
      return null;
    }
    const prefix = block.tone === "error"
      ? "[error]"
      : block.tone === "file"
        ? "[file]"
        : "[message]";
    return `${prefix}\n${content}`;
  }

  return null;
}

function formatCliStreamPayload(payload) {
  if (!payload || !payload.line) {
    return null;
  }

  const rawLine = String(payload.line).trim();
  if (!rawLine) {
    return null;
  }

  if (payload.channel === "stderr") {
    if (payload.backend === "gemini") {
      const safeLine = sanitizeGeminiStderrLine(rawLine);
      return safeLine ? `[stderr] ${safeLine}` : null;
    }
    return `[stderr] ${rawLine}`;
  }

  if (activeCodexSuppressedLines.has(rawLine)) {
    return null;
  }

  if (!rawLine.startsWith("{")) {
    const backend = payload.backend || activeRuntimeBackend.value;
    const message = sanitizeAgentConsoleMessage(rawLine);
    return message ? `[${backend}] ${message}` : null;
  }

  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    const backend = payload.backend || activeRuntimeBackend.value;
    const message = sanitizeAgentConsoleMessage(rawLine);
    return message ? `[${backend}] ${message}` : null;
  }

  if (event?.type === "designcode.block" && event.block) {
    return formatCliBlockSummary(event.block, payload.backend || activeRuntimeBackend.value);
  }

  switch (payload.backend) {
    case "claude":
      return formatClaudeJsonEvent(event);
    case "gemini":
      return formatGeminiJsonEvent(event);
    case "opencode":
      return formatOpencodeJsonEvent(event);
    default:
      return formatCodexJsonEvent(event);
  }
}

// ---------------------------------------------------------------------------
// 输出管理
// ---------------------------------------------------------------------------

function appendAgentOutputLine(line) {
  const text = String(line || "").trimEnd();
  if (!text) {
    return;
  }

  state.agent.outputDesignId = currentConversationScopeKey.value;
  state.agent.output = state.agent.output
    ? `${state.agent.output}\n${text}`
    : text;
}

function beginAgentOutputSection(scopeKey = currentConversationScopeKey.value) {
  state.agent.outputDesignId = scopeKey || currentConversationScopeKey.value;
  if (!state.agent.output) {
    return;
  }
  const normalized = state.agent.output.replace(/\s+$/, "");
  state.agent.output = normalized.endsWith("\n\n")
    ? normalized
    : `${normalized}\n\n`;
}

function appendAgentOutputEntry(text, scopeKey = currentConversationScopeKey.value) {
  const value = String(text || "").trim();
  if (!value) {
    return;
  }
  beginAgentOutputSection(scopeKey);
  state.agent.output = state.agent.output
    ? `${state.agent.output}${value}`
    : value;
}

function markConversationRuntimeScope() {
  const scopeKey = currentConversationScopeKey.value;
  state.agent.streamDesignId = scopeKey;
  state.agent.outputDesignId = scopeKey;
}

function rebindConversationRuntimeScope(previousScopeKey, nextScopeKey) {
  if (
    !previousScopeKey ||
    !nextScopeKey ||
    previousScopeKey === nextScopeKey ||
    previousScopeKey !== "__workspace__"
  ) {
    return;
  }

  if (state.agent.streamDesignId === previousScopeKey) {
    state.agent.streamDesignId = nextScopeKey;
  }
  if (state.agent.outputDesignId === previousScopeKey) {
    state.agent.outputDesignId = nextScopeKey;
  }
}

function serializeConversationBlocksForStorage(blocks = []) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object" || !block.type) {
        return null;
      }

      if (block.type === "command") {
        return {
          type: "command",
          command: String(block.command || "").trim(),
          output: String(block.output || "").trim(),
          status: String(block.status || "").trim() || "success"
        };
      }

      if (block.type === "todo") {
        const items = Array.isArray(block.items)
          ? block.items
              .map((item, index) => {
                const label = String(item?.label || "").trim();
                if (!label) {
                  return null;
                }
                return {
                  id: item?.id || `todo-${index}`,
                  label,
                  status: String(item?.status || "pending")
                };
              })
              .filter(Boolean)
          : [];

        return {
          type: "todo",
          title: String(block.title || "").trim() || "Todo List",
          items,
          status: String(block.status || "").trim() || "success"
        };
      }

      if (block.type === "confirm") {
        return {
          type: "confirm",
          title: String(block.title || "").trim() || t("confirm.needConfirm"),
          content: String(block.content || "").trim(),
          command: String(block.command || "").trim(),
          status: String(block.status || "").trim() || "waiting"
        };
      }

      if (block.type === "thought" || block.type === "text") {
        const content = String(block.content || "").trim();
        if (!content) {
          return null;
        }
        return {
          type: block.type,
          content,
          tone: String(block.tone || "").trim()
        };
      }

      return null;
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 流控制
// ---------------------------------------------------------------------------

async function beginCliStream(streamId, backend, suppressedBlocks = []) {
  // 用 effectiveActiveTabId 而非直接 activeTabId.value：generateDesign 等调用方
  // 可能把 sync 块包在 withTabContext(origin) 里再调 beginCliStream，这时
  // effective 能拿到 origin，而不是当前用户正在看的 tab。
  const originatingTabId = effectiveActiveTabId();

  // 关闭此 tab 之前可能未结束的旧 stream 监听
  const prev = tabStreamListeners.get(originatingTabId);
  if (prev) {
    prev.off?.();
    if (prev.heartbeatTimer) window.clearInterval(prev.heartbeatTimer);
    tabStreamListeners.delete(originatingTabId);
  }

  withTabContext(originatingTabId, () => {
    markConversationRuntimeScope();
    state.agent.outputDesignId = currentConversationScopeKey.value;
    state.agent.output = "";
    state.agent.streamBlocks = [];
  });
  // 全局共享：抑制重复行 / 隐藏 stderr 容量行 的状态。短时间内一次只跑一个流通常足够；
  // 多 tab 同时跑也只会抑制一些边角日志，不影响功能。
  activeCodexSuppressedLines = buildCodexSuppressedLines(suppressedBlocks);
  geminiStderrCapacityModel = "";

  const startedAt = Date.now();
  const handle = {
    streamId,
    backend,
    startedAt,
    lastEventAt: startedAt,
    lastHeartbeatAt: startedAt,
    off: null,
    heartbeatTimer: null
  };

  handle.heartbeatTimer = window.setInterval(() => {
    const now = Date.now();
    const elapsedSeconds = Math.max(1, Math.round((now - handle.startedAt) / 1000));
    const silentSeconds = Math.round((now - handle.lastEventAt) / 1000);
    if (elapsedSeconds < 15 || now - handle.lastHeartbeatAt < 15000) {
      return;
    }
    handle.lastHeartbeatAt = now;
    withTabContext(originatingTabId, () => {
      if (silentSeconds >= 20) {
        appendAgentOutputLine(
          prefixMultilineLog(
            `[${backend}] Still running... ${elapsedSeconds}s elapsed, waiting for the next event.`,
            formatStreamElapsedTag()
          )
        );
      } else if (silentSeconds >= 10) {
        appendAgentOutputLine(
          prefixMultilineLog(
            `[${backend}] Running... ${elapsedSeconds}s elapsed.`,
            formatStreamElapsedTag()
          )
        );
      }
    });
  }, 5000);

  handle.off = await listenCliOutput((payload) => {
    if (!payload || payload.streamId !== streamId) {
      return;
    }
    handle.lastEventAt = Date.now();

    withTabContext(originatingTabId, () => {
      const formatted = formatCliStreamPayload(payload);
      if (formatted) {
        appendAgentOutputLine(prefixMultilineLog(formatted, formatStreamElapsedTag()));
      }
      const block = parseCliStreamBlock(payload);
      if (block) {
        upsertAgentStreamBlock(block);
      }
    });
  });

  tabStreamListeners.set(originatingTabId, handle);
}

function endCliStream() {
  // 多标签页：仅停止当前 tab 的 stream；其它 tab 的 stream 保持运行。
  // 同样使用 effective：若 endCliStream 被包在 withTabContext(origin) 里调，
  // 停的是那个 origin tab 的 stream 而不是当前用户看的 tab。
  const tabId = effectiveActiveTabId();
  const handle = tabStreamListeners.get(tabId);
  if (handle) {
    handle.off?.();
    if (handle.heartbeatTimer) window.clearInterval(handle.heartbeatTimer);
    tabStreamListeners.delete(tabId);
  }
  activeCodexSuppressedLines = new Set();
  geminiStderrCapacityModel = "";
}

// 关闭某个 tab 时调用：彻底停掉该 tab 名下的 stream 监听
export function endCliStreamForTab(tabId) {
  const handle = tabStreamListeners.get(tabId);
  if (!handle) return;
  handle.off?.();
  if (handle.heartbeatTimer) window.clearInterval(handle.heartbeatTimer);
  tabStreamListeners.delete(tabId);
}

// 查询某个 tab 当前活动的流信息（streamId / backend），供 abort 使用
export function getActiveStreamInfo(tabId) {
  const handle = tabStreamListeners.get(tabId);
  if (!handle) return null;
  return { streamId: handle.streamId, backend: handle.backend };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function useCliStream() {
  return {
    // 流 ID 和辅助
    nextCodexStreamId,
    buildCodexSuppressedLines,
    HIDDEN_SOURCE_MESSAGE,

    // 输出格式化
    compactConsoleText,
    looksLikeSourceDump,
    sanitizeAgentConsoleMessage,
    sanitizeAgentLogMessage,
    formatStreamElapsedTag,
    prefixMultilineLog,
    summarizeCliResultOutput,
    formatCodexJsonEvent,
    formatClaudeJsonEvent,
    formatGeminiJsonEvent,
    formatOpencodeJsonEvent,
    sanitizeGeminiStderrLine,
    formatCliBlockSummary,
    formatCliStreamPayload,

    // 输出管理
    appendAgentOutputLine,
    beginAgentOutputSection,
    appendAgentOutputEntry,
    markConversationRuntimeScope,
    rebindConversationRuntimeScope,
    serializeConversationBlocksForStorage,

    // 流控制
    beginCliStream,
    endCliStream
  };
}
