// CLI stream 处理 — 监听 Codex/Claude/Gemini 的 stdout/stderr 事件，
// 格式化日志、解析 JSON block、驱动对话面板的实时更新。
import { listenCliOutput } from "../lib/desktop-api.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useConversation } from "./useConversation.js";

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

let removeCodexStreamListener = null;
let activeCodexSuppressedLines = new Set();
let geminiStderrCapacityModel = "";
let codexStreamHeartbeatTimer = null;
let codexStreamStartedAt = 0;
let codexStreamLastEventAt = 0;
let codexStreamLastHeartbeatAt = 0;

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
  if (!codexStreamStartedAt) {
    return "";
  }

  const elapsed = Math.max(0, timestamp - codexStreamStartedAt);
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

function formatClaudeJsonEvent(event) {
  const eventType = event.type || "";

  if (eventType === "system" && event.subtype === "init") {
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
    return result ? `[final]\n${result}` : "[claude] Completed";
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
    const prefix = block.tone === "error" ? "[error]" : "[message]";
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
      return null;
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
  if (removeCodexStreamListener) {
    removeCodexStreamListener();
    removeCodexStreamListener = null;
  }
  if (codexStreamHeartbeatTimer) {
    window.clearInterval(codexStreamHeartbeatTimer);
    codexStreamHeartbeatTimer = null;
  }

  markConversationRuntimeScope();
  beginAgentOutputSection();
  state.agent.streamBlocks = [];
  activeCodexSuppressedLines = buildCodexSuppressedLines(suppressedBlocks);
  geminiStderrCapacityModel = "";
  codexStreamStartedAt = Date.now();
  codexStreamLastEventAt = codexStreamStartedAt;
  codexStreamLastHeartbeatAt = codexStreamStartedAt;
  codexStreamHeartbeatTimer = window.setInterval(() => {
    const now = Date.now();
    const elapsedSeconds = Math.max(1, Math.round((now - codexStreamStartedAt) / 1000));
    const silentSeconds = Math.round((now - codexStreamLastEventAt) / 1000);
    if (elapsedSeconds < 15 || now - codexStreamLastHeartbeatAt < 15000) {
      return;
    }
    codexStreamLastHeartbeatAt = now;
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
  }, 5000);
  removeCodexStreamListener = await listenCliOutput((payload) => {
    if (!payload || payload.streamId !== streamId) {
      return;
    }
    codexStreamLastEventAt = Date.now();

    const formatted = formatCliStreamPayload(payload);
    if (formatted) {
      appendAgentOutputLine(prefixMultilineLog(formatted, formatStreamElapsedTag()));
    }

    const block = parseCliStreamBlock(payload);
    if (block) {
      upsertAgentStreamBlock(block);
    }
  });
}

function endCliStream() {
  if (removeCodexStreamListener) {
    removeCodexStreamListener();
    removeCodexStreamListener = null;
  }
  if (codexStreamHeartbeatTimer) {
    window.clearInterval(codexStreamHeartbeatTimer);
    codexStreamHeartbeatTimer = null;
  }
  activeCodexSuppressedLines = new Set();
  geminiStderrCapacityModel = "";
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
