// 对话管理 — 消息列表、乐观更新、stream block 解析、审批交互。
import { computed, reactive } from "vue";
import { cloneSnapshot, formatClock } from "../lib/studio-utils.js";
import { replyRuntimeApproval } from "../lib/desktop-api.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";

// ---------------------------------------------------------------------------
// 模块级单例状态
// ---------------------------------------------------------------------------

const { state, conversationExpandedBlocks, setStatus } = useWorkspaceState();

let agentStreamBlockCounter = 0;

// ---------------------------------------------------------------------------
// 外部依赖注入（由 App.vue 调用 useConversation 时传入）
// ---------------------------------------------------------------------------

let _activeRuntimeBackend = null;
let _activeRuntimeSessionId = null;
let _runtimeDirectory = null;
let _runtimeBackendDisplayName = null;
let _designChatMessages = null;
let _liveConversationBlocks = null;
let _conversationIsBusy = null;

// ---------------------------------------------------------------------------
// 辅助函数 — 对话角色 / 类型标签
// ---------------------------------------------------------------------------

function conversationRoleLabel(role) {
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "agent";
  }
  return "system";
}

function conversationActorName(role) {
  if (role === "user") {
    return "You";
  }
  if (role === "assistant") {
    return "Design Agent";
  }
  return "System";
}

function conversationActorInitial(role) {
  if (role === "user") {
    return "U";
  }
  if (role === "assistant") {
    return "A";
  }
  return "S";
}

function conversationKindLabel(kind, role) {
  const value = String(kind || "").toLowerCase();
  if (value === "instruction") {
    return "request";
  }
  if (value === "render") {
    return "render";
  }
  if (value === "update") {
    return "update";
  }
  if (value === "inspect") {
    return "inspect";
  }
  if (value === "config") {
    return "context";
  }
  if (value === "agent") {
    return "agent";
  }
  if (role === "system") {
    return "context";
  }
  if (role === "assistant") {
    return "message";
  }
  return "request";
}

// ---------------------------------------------------------------------------
// 对话消息 — 语气 / 块处理
// ---------------------------------------------------------------------------

function conversationStoredTone(message) {
  const kind = String(message?.kind || "").toLowerCase();
  const text = String(message?.text || "");
  if (/失败|错误|error|fail|denied|rejected/i.test(text)) {
    return "error";
  }
  if (message?.role === "system" || kind === "config") {
    return "system";
  }
  if (kind === "render" || kind === "update" || kind === "inspect" || kind === "agent") {
    return "result";
  }
  return "default";
}

function conversationStoredBlocks(message) {
  if (Array.isArray(message?.blocks) && message.blocks.length) {
    return message.blocks.map((block, index) => ({
      id: block.id || `stored-block-${message.id}-${index}`,
      ...cloneSnapshot(block)
    }));
  }

  if (!message?.text) {
    return [];
  }

  if (message.role === "system" || message.kind === "config") {
    return [{
      id: `stored-${message.id}`,
      type: "thought",
      content: message.text
    }];
  }

  return [{
    id: `stored-${message.id}`,
    type: "text",
    tone: conversationStoredTone(message),
    content: message.text
  }];
}

// ---------------------------------------------------------------------------
// 乐观更新
// ---------------------------------------------------------------------------

function appendOptimisticUserConversation(text) {
  const id = `local-user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  state.design.chat = [
    ...(state.design.chat || []),
    {
      id,
      role: "user",
      kind: "instruction",
      text,
      createdAt: new Date().toISOString(),
      pending: true
    }
  ];
  return id;
}

function finalizeOptimisticConversationEntry(entryId) {
  if (!entryId) {
    return;
  }
  state.design.chat = (state.design.chat || []).map((message) => (
    message.id === entryId
      ? {
          ...message,
          pending: false
        }
      : message
  ));
}

function appendLocalAssistantConversation(text, kind = "agent") {
  const message = normalizeConversationMessage(text);
  if (!message) {
    return null;
  }
  const id = `local-assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  state.design.chat = [
    ...(state.design.chat || []),
    {
      id,
      role: "assistant",
      kind,
      text: message,
      createdAt: new Date().toISOString()
    }
  ];
  return id;
}

function rollbackOptimisticConversationEntry(entryId) {
  if (!entryId) {
    return;
  }
  state.design.chat = (state.design.chat || []).filter((message) => message.id !== entryId);
}

// ---------------------------------------------------------------------------
// 消息规范化
// ---------------------------------------------------------------------------

function normalizeConversationMessage(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  return text;
}

function normalizeConversationCommandStatus(value, fallback = "running") {
  const status = String(value || fallback).toLowerCase();
  if (!status) {
    return fallback;
  }
  if (status === "completed" || status === "success" || status === "done") {
    return "success";
  }
  if (status === "failed" || status === "failure") {
    return "error";
  }
  return status;
}

function formatConversationPath(path) {
  const rawPath = normalizeConversationMessage(path);
  if (!rawPath) {
    return "";
  }

  const runtimeDirectory = String(_runtimeDirectory?.value || "").replace(/\/+$/g, "");
  if (runtimeDirectory && rawPath.startsWith(`${runtimeDirectory}/`)) {
    return rawPath.slice(runtimeDirectory.length + 1);
  }

  if (runtimeDirectory && rawPath === runtimeDirectory) {
    return ".";
  }

  return rawPath;
}

function unwrapConversationMarker(value) {
  return String(value || "")
    .replace(/^[·•\s]+/gu, "")
    .replace(/[·•\s]+$/gu, "")
    .trim();
}

function isOpencodeThoughtMarkerLine(value) {
  const text = unwrapConversationMarker(value)
    .replace(/^[\[\(（【<\s]+/u, "")
    .replace(/[\]\)）】>\s]+$/u, "")
    .trim();

  if (!text) {
    return true;
  }

  return /^(thinking|thought|reasoning|analyzing|analysis)(?:\s*[.。…]+)?$/iu.test(text)
    || /^(思考中|思考|推理中|推理|分析中|分析)(?:\s*[.。…]+)?$/u.test(text);
}

function sanitizeOpencodeThoughtContent(value) {
  const text = normalizeConversationMessage(value);
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      const withoutLeadingMarker = trimmed
        .replace(
          /^(?:[·•\s]*)?(?:thinking|thought|reasoning|analyzing|analysis|思考中|思考|推理中|推理|分析中|分析)(?:\s*[.。…]+)?(?:[·•\s:：-]*)/iu,
          ""
        )
        .trim();

      if (isOpencodeThoughtMarkerLine(trimmed) || isOpencodeThoughtMarkerLine(withoutLeadingMarker)) {
        return "";
      }

      return withoutLeadingMarker || trimmed;
    })
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatOpencodeToolCommand(source = {}) {
  const tool = pickFirstText(source.tool, source.name) || "tool";
  const command = pickFirstText(source.command, source.commandLine, source.argv, source.args);
  if (command) {
    return command;
  }

  const path = formatConversationPath(
    pickFirstText(source.path, source.filePath, source.file_path)
  );
  const detail = normalizeConversationMessage(
    pickFirstText(source.detail, source.pattern, source.query, source.url, source.task)
  );

  if (path) {
    return `${tool} ${path}`;
  }

  if (detail) {
    return `${tool} ${detail}`;
  }

  return tool;
}

// ---------------------------------------------------------------------------
// 对话块 — 文本 / 展开
// ---------------------------------------------------------------------------

function conversationBlockText(block) {
  if (!block || typeof block !== "object") {
    return "";
  }

  if (block.type === "command") {
    return normalizeConversationMessage(block.output || "");
  }

  if (block.type === "todo") {
    return Array.isArray(block.items)
      ? block.items.map((item) => normalizeConversationMessage(item?.label || "")).filter(Boolean).join("\n")
      : "";
  }

  if (block.type === "confirm") {
    return normalizeConversationMessage(block.content || "");
  }

  return normalizeConversationMessage(block.content || "");
}

function conversationBlockKey(entryId, blockId) {
  return `${entryId}:${blockId}`;
}

function conversationBlockExpandable(block) {
  const text = conversationBlockText(block);
  if (!text) {
    return false;
  }
  const lineCount = text.split("\n").length;
  return text.length > 420 || lineCount > 8;
}

function isConversationBlockExpanded(entryId, block) {
  return Boolean(conversationExpandedBlocks[conversationBlockKey(entryId, block.id)]);
}

function toggleConversationBlock(entryId, block) {
  const key = conversationBlockKey(entryId, block.id);
  conversationExpandedBlocks[key] = !conversationExpandedBlocks[key];
}

// ---------------------------------------------------------------------------
// 流式块辅助
// ---------------------------------------------------------------------------

function nextAgentStreamBlockId(prefix = "block") {
  agentStreamBlockCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${agentStreamBlockCounter.toString(36)}`;
}

function findLastBlockIndex(blocks, predicate) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index], index)) {
      return index;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 通用文本提取
// ---------------------------------------------------------------------------

function pickFirstText(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => pickFirstText(item))
        .filter(Boolean)
        .join(" ");
      if (joined) {
        return joined;
      }
      continue;
    }

    if (candidate && typeof candidate === "object") {
      const nested = pickFirstText(
        candidate.text,
        candidate.content,
        candidate.message,
        candidate.title,
        candidate.label,
        candidate.name,
        candidate.reason,
        candidate.description
      );
      if (nested) {
        return nested;
      }
      continue;
    }

    const text = String(candidate || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Todo 条目
// ---------------------------------------------------------------------------

function normalizeTodoStatus(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("done") || text.includes("complete") || text.includes("finished") || text === "true") {
    return "done";
  }
  if (text.includes("progress") || text.includes("doing") || text.includes("active") || text.includes("running")) {
    return "active";
  }
  return "pending";
}

function normalizeTodoEntries(source = {}) {
  const candidates = [
    source.items,
    source.todos,
    source.entries,
    source.tasks,
    source.todoList,
    source.todo_list,
    source.state?.items,
    source.state?.todos,
    source.state?.entries,
    source.state?.tasks
  ];

  const list = candidates.find((value) => Array.isArray(value) && value.length) || [];
  if (list.length) {
    return list
      .map((entry, index) => {
        if (typeof entry === "string") {
          return {
            id: `todo-${index}`,
            label: entry,
            status: "pending"
          };
        }

        const label = pickFirstText(
          entry.content,
          entry.text,
          entry.label,
          entry.title,
          entry.name,
          entry.task,
          entry.todo
        );

        if (!label) {
          return null;
        }

        return {
          id: entry.id || `todo-${index}`,
          label,
          status: entry.done || entry.completed ? "done" : normalizeTodoStatus(entry.status)
        };
      })
      .filter(Boolean);
  }

  const summary = pickFirstText(source.text, source.message, source.content);
  return summary
    ? [{
        id: nextAgentStreamBlockId("todo"),
        label: summary,
        status: "pending"
      }]
    : [];
}

// ---------------------------------------------------------------------------
// 审批详情解析
// ---------------------------------------------------------------------------

function resolveApprovalDetails(source = {}) {
  const typeSignature = [
    source.type,
    source.kind,
    source.subtype,
    source.status,
    source.name
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!/(approval|approve|confirm|permission)/.test(typeSignature)) {
    return null;
  }

  const command = pickFirstText(
    source.command,
    source.commandLine,
    source.argv,
    source.args
  );
  const description = [
    pickFirstText(source.content, source.description, source.details, source.message, source.reason),
    command ? t("chat.commandLabel", { command }) : "",
    source.path ? t("chat.pathLabel", { path: source.path }) : ""
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: source.id || source.callId || source.callID || nextAgentStreamBlockId("confirm"),
    type: "confirm",
    title: pickFirstText(source.title, source.label, source.name) || t("confirm.needConfirm"),
    content: description || t("confirm.commandNeedsConfirm"),
    command,
    status: "waiting",
    interactive: false,
    backend: source.backend || _activeRuntimeBackend.value,
    note: t("confirm.approvalNotSupported")
  };
}

// ---------------------------------------------------------------------------
// 各后端流式事件解析
// ---------------------------------------------------------------------------

function parseCodexStreamBlock(event) {
  const eventType = event.type || "";

  if (eventType === "step-start") {
    return {
      id: nextAgentStreamBlockId("thought"),
      type: "thought",
      content: t("chat.analyzing")
    };
  }

  if (eventType === "turn.failed") {
    return {
      id: nextAgentStreamBlockId("error"),
      type: "text",
      tone: "error",
      content: event.error?.message || event.message || t("chat.executionFailed")
    };
  }

  if (eventType === "item.started" || eventType === "item.completed") {
    const item = event.item || {};
    const phase = eventType === "item.started" ? "running" : "success";

    if (item.type === "command_execution") {
      return {
        id: item.id || item.callId || item.callID || nextAgentStreamBlockId("command"),
        type: "command",
        command: pickFirstText(item.command, item.commandLine, item.argv, item.args),
        output: pickFirstText(item.output, item.stdout, item.stderr),
        status: phase
      };
    }

    if (item.type === "todo_list") {
      const items = normalizeTodoEntries(item);
      return items.length
        ? {
            id: item.id || nextAgentStreamBlockId("todo"),
            type: "todo",
            title: "Todo List",
            items,
            status: phase
          }
        : null;
    }

    const approval = resolveApprovalDetails(item);
    if (approval) {
      return {
        ...approval,
        status: eventType === "item.completed" ? "resolved" : approval.status
      };
    }

    if (item.type === "agent_message" && item.text) {
      const content = normalizeConversationMessage(item.text);
      if (!content) {
        return null;
      }
      return {
        id: nextAgentStreamBlockId("thought"),
        type: "thought",
        content
      };
    }

    if (item.type === "file_change") {
      return {
        id: item.path || nextAgentStreamBlockId("file"),
        type: "text",
        tone: "file",
        content: item.path ? t("chat.fileUpdated", { path: item.path }) : t("chat.fileUpdatedGeneric")
      };
    }
  }

  const approval = resolveApprovalDetails(event);
  if (approval) {
    return approval;
  }

  if (event.message) {
    const content = normalizeConversationMessage(event.message);
    if (!content) {
      return null;
    }
    return {
      id: nextAgentStreamBlockId("thought"),
      type: "thought",
      content
    };
  }

  return null;
}

// Claude 每个 turn 结束会连发 assistant text + result 两条同文内容；
// 不去重会导致对话记录里同一段回答连续出现两遍。用模块级缓存记录上一次
// assistant text，result 命中就丢掉（日志那条路已经做过相同处理）。
let _lastClaudeBlockText = "";

// 从路径中取文件名，用于把 "/Users/foo/bar/baz.txt" 压成 "baz.txt"。
// Claude 的 Read/Write/Edit 常传完整绝对路径，直接显示会把一行塞满。
function basenameFromPath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const cleaned = text.replace(/[\\/]+$/u, "");
  const parts = cleaned.split(/[\\/]/u);
  return parts[parts.length - 1] || cleaned;
}

function truncateInlineText(value, limit = 48) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Claude tool_use → 简短标识。目的是控制占位：对话流里用户关心的是
// "Claude 读了哪个文件"，而不是完整绝对路径；完整 input 依然保留在日志 Tab。
function formatClaudeToolBrief(toolName, toolInput = {}) {
  const tool = String(toolName || "").trim();
  const filePath = pickFirstText(toolInput.file_path, toolInput.path, toolInput.filePath, toolInput.notebook_path);
  const fileName = basenameFromPath(filePath);
  const pattern = pickFirstText(toolInput.pattern, toolInput.query);
  const url = pickFirstText(toolInput.url);
  const subagent = pickFirstText(toolInput.subagent_type, toolInput.description);

  switch (tool) {
    case "Read":
      return t("chat.claudeTool.read", { name: fileName || truncateInlineText(filePath) || tool });
    case "Write":
      return t("chat.claudeTool.write", { name: fileName || truncateInlineText(filePath) || tool });
    case "Edit":
    case "MultiEdit":
      return t("chat.claudeTool.edit", { name: fileName || truncateInlineText(filePath) || tool });
    case "NotebookEdit":
      return t("chat.claudeTool.notebook", { name: fileName || truncateInlineText(filePath) || tool });
    case "Glob":
      return t("chat.claudeTool.glob", { name: truncateInlineText(pattern) || tool });
    case "Grep":
      return t("chat.claudeTool.grep", { name: truncateInlineText(pattern) || tool });
    case "LS": {
      const label = fileName || truncateInlineText(filePath);
      return t("chat.claudeTool.ls", { name: label || tool });
    }
    case "Task":
      return t("chat.claudeTool.task", { name: truncateInlineText(subagent) || tool });
    case "WebFetch":
      return t("chat.claudeTool.webFetch", { name: truncateInlineText(url) || tool });
    case "WebSearch":
      return t("chat.claudeTool.webSearch", { name: truncateInlineText(pattern || url) || tool });
    default: {
      const detail = truncateInlineText(fileName || filePath || pattern || url || subagent);
      if (!tool) {
        return detail || "";
      }
      return detail
        ? t("chat.claudeTool.genericWith", { tool, name: detail })
        : t("chat.claudeTool.generic", { tool });
    }
  }
}

function parseClaudeStreamBlock(event) {
  if (event.type === "system" && event.subtype === "init") {
    _lastClaudeBlockText = "";
    return null;
  }

  const approval = resolveApprovalDetails(event);
  if (approval) {
    return approval;
  }

  if (event.type === "result") {
    const content = normalizeConversationMessage(event.result || "");
    if (!content || content === _lastClaudeBlockText) {
      _lastClaudeBlockText = "";
      return null;
    }
    _lastClaudeBlockText = "";
    return {
      id: nextAgentStreamBlockId("text"),
      type: "text",
      tone: event.is_error ? "error" : undefined,
      content
    };
  }

  if (event.type === "assistant") {
    const items = Array.isArray(event.message?.content) ? event.message.content : [];
    const blocks = [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      // 思考/推理：以默认 thought 样式（小字、斜体、灰色）展示，
      // 超过 conversationBlockExpandable 阈值（>420 字符或 >8 行）时会自动折叠。
      if (item.type === "thinking" || item.type === "reasoning") {
        const content = normalizeConversationMessage(
          pickFirstText(item.thinking, item.text, item.content, item.summary)
        );
        if (content) {
          blocks.push({
            id: item.id || nextAgentStreamBlockId("thinking"),
            type: "thought",
            content
          });
        }
        continue;
      }

      // redacted_thinking：Anthropic 会把敏感思考块加密，正文取不出来；
      // 仅留一条提示以示"确实在思考"。
      if (item.type === "redacted_thinking") {
        blocks.push({
          id: item.id || nextAgentStreamBlockId("thinking"),
          type: "thought",
          content: t("chat.claudeTool.redactedThinking")
        });
        continue;
      }

      if (item.type === "tool_use") {
        const toolName = String(item.name || "").trim();
        const toolInput = item.input || {};

        if (toolName === "TodoWrite") {
          const todoItems = normalizeTodoEntries(toolInput);
          if (todoItems.length) {
            blocks.push({
              id: item.id || nextAgentStreamBlockId("todo"),
              type: "todo",
              title: "Todo List",
              items: todoItems,
              status: "running"
            });
            continue;
          }
        }

        if (toolName === "Bash") {
          const command = pickFirstText(
            toolInput.command,
            toolInput.cmd,
            toolInput.commandLine,
            toolInput.argv
          );
          if (command) {
            blocks.push({
              id: item.id || nextAgentStreamBlockId("command"),
              type: "command",
              command,
              output: "",
              status: "running"
            });
            continue;
          }
        }

        const brief = formatClaudeToolBrief(toolName, toolInput);
        if (brief) {
          blocks.push({
            id: item.id || nextAgentStreamBlockId("tool"),
            type: "thought",
            content: brief
          });
        }
        continue;
      }

      if (item.type === "text") {
        const safeContent = normalizeConversationMessage(item.text || "");
        if (safeContent) {
          _lastClaudeBlockText = safeContent;
          blocks.push({
            id: nextAgentStreamBlockId("text"),
            type: "text",
            content: safeContent
          });
        }
        continue;
      }
    }

    if (blocks.length === 0) {
      return null;
    }
    return blocks.length === 1 ? blocks[0] : blocks;
  }

  return null;
}

function parseGeminiStreamBlock(event) {
  const approval = resolveApprovalDetails(event);
  if (approval) {
    return approval;
  }

  const message =
    event.result ||
    event.response ||
    event.text ||
    event.message?.text ||
    event.content?.text ||
    event.content ||
    "";
  const safeMessage = normalizeConversationMessage(message);
  return safeMessage
    ? {
        id: nextAgentStreamBlockId("text"),
        type: "text",
        content: safeMessage
      }
    : null;
}

function parseOpencodeStreamBlock(event) {
  const eventType = event.type || "";

  if (eventType === "opencode.text") {
    const content = normalizeConversationMessage(event.content || event.message || "");
    return content
      ? {
          id: event.id || nextAgentStreamBlockId("opencode-text"),
          type: "text",
          content,
          suppressLogLine: Boolean(event.suppressLogLine)
        }
      : null;
  }

  if (eventType === "opencode.thinking" || eventType === "opencode.status") {
    const content = sanitizeOpencodeThoughtContent(event.content || event.message || "");
    return content
      ? {
          id: event.id || nextAgentStreamBlockId("opencode-thought"),
          type: "thought",
          variant: "rich",
          content,
          suppressLogLine: Boolean(event.suppressLogLine)
        }
      : null;
  }

  if (eventType === "opencode.error") {
    const content = normalizeConversationMessage(event.message || event.error || "");
    return content
      ? {
          id: event.id || nextAgentStreamBlockId("opencode-error"),
          type: "text",
          tone: "error",
          content,
          suppressLogLine: Boolean(event.suppressLogLine)
        }
      : null;
  }

  if (eventType === "opencode.file") {
    const status = normalizeConversationCommandStatus(event.status, "success");
    const detail = pickFirstText(event.message, event.error);
    return {
      id: event.id || nextAgentStreamBlockId("opencode-file"),
      type: "command",
      title: "Workspace",
      command: formatOpencodeToolCommand(event),
      output: status === "error" ? normalizeConversationMessage(detail) : "",
      status,
      suppressLogLine: Boolean(event.suppressLogLine)
    };
  }

  if (eventType === "opencode.tool") {
    const tool = pickFirstText(event.tool, event.name) || "tool";
    const status = normalizeConversationCommandStatus(event.status, "running");
    const command = formatOpencodeToolCommand(event);
    const detail = pickFirstText(event.detail, event.path, event.pattern, event.query);
    const message = pickFirstText(event.message, event.error);

    if (status === "error") {
      return {
        id: event.id || nextAgentStreamBlockId("opencode-command"),
        type: "command",
        title: "OpenCode Tool",
        command,
        output: normalizeConversationMessage(detail || message),
        status,
        suppressLogLine: Boolean(event.suppressLogLine)
      };
    }

    return {
      id: event.id || nextAgentStreamBlockId("opencode-command"),
      type: "command",
      title: /^(bash|shell)$/i.test(tool) ? "Agent CLI" : "OpenCode Tool",
      command,
      output: /^(bash|shell)$/i.test(tool)
        ? normalizeConversationMessage(
            pickFirstText(event.output, event.result, event.stdout, event.stderr, message)
          )
        : "",
      status,
      suppressLogLine: Boolean(event.suppressLogLine)
    };
  }

  if (event.message) {
    const content = sanitizeOpencodeThoughtContent(event.message);
    return content
      ? {
          id: event.id || nextAgentStreamBlockId("opencode-message"),
          type: "thought",
          variant: "rich",
          content,
          suppressLogLine: Boolean(event.suppressLogLine)
        }
      : null;
  }

  return null;
}

function extractOpencodeMessages(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  const directMessage = payload.message && typeof payload.message === "object"
    ? payload.message
    : null;
  if (directMessage) {
    return [directMessage];
  }

  const collections = [payload.messages, payload.items, payload.data];
  const list = collections.find((value) => Array.isArray(value) && value.length);
  if (list) {
    return list;
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    return [payload];
  }

  return [];
}

function opencodeAssistantMessageParts(message) {
  if (!message || typeof message !== "object") {
    return [];
  }

  const role = String(message.role || message.type || "").toLowerCase();
  if (role && role !== "assistant") {
    return [];
  }

  if (Array.isArray(message.parts)) {
    return message.parts;
  }

  if (Array.isArray(message.content)) {
    return message.content;
  }

  return [];
}

function buildOpencodePartEvent(part) {
  if (!part || typeof part !== "object") {
    return null;
  }

  const partType = String(part.type || "").toLowerCase();
  const partId = part.id || part.partId || part.partID || part.toolCallId || part.tool_call_id || null;

  if (partType === "text") {
    return {
      type: "opencode.text",
      id: partId,
      content: part.text || part.content || "",
      suppressLogLine: true
    };
  }

  if (partType === "thinking" || partType === "reasoning") {
    return {
      type: "opencode.thinking",
      id: partId,
      content: part.text || part.content || part.thinking || "",
      suppressLogLine: true
    };
  }

  if (partType === "tool") {
    const state = part.state || {};
    const input = state.input || {};
    const tool = pickFirstText(part.toolName, part.name, part.tool) || "tool";
    const path = pickFirstText(input.filePath, input.file_path, input.path);
    const detail = pickFirstText(input.pattern, input.query, input.url, input.task);
    const command = pickFirstText(input.command, input.cmd, input.commandLine, input.argv);
    const output = pickFirstText(state.output, part.result, part.output);
    const message = pickFirstText(state.error, part.error);
    const status = String(state.status || (message ? "error" : output ? "completed" : "running"));

    if (command || /^(bash|shell)$/i.test(tool)) {
      return {
        type: "opencode.tool",
        id: part.callID || partId || nextAgentStreamBlockId("opencode-command"),
        tool,
        command: command || tool,
        output: output || message,
        status,
        suppressLogLine: true
      };
    }

    if (path || /(file|write|read|edit)/i.test(tool)) {
      return {
        type: "opencode.file",
        id: part.callID || partId || nextAgentStreamBlockId("opencode-file"),
        tool,
        path,
        detail,
        message,
        status,
        suppressLogLine: true
      };
    }

    return {
      type: "opencode.tool",
      id: part.callID || partId || nextAgentStreamBlockId("opencode-tool"),
      tool,
      detail,
      message,
      status,
      suppressLogLine: true
    };
  }

  if (partType === "tool-invocation" || partType === "tool-call" || partType === "tool_call") {
    const args = part.args || part.input || {};
    const tool = pickFirstText(part.toolName, part.name, part.tool) || "tool";
    const command = pickFirstText(args.command, args.cmd, args.commandLine, args.argv);
    const path = pickFirstText(args.file_path, args.path, args.filePath);
    const output = pickFirstText(part.result, part.output);

    if (command || /^(bash|shell)$/i.test(tool)) {
      return {
        type: "opencode.tool",
        id: partId || nextAgentStreamBlockId("opencode-command"),
        tool,
        command: command || tool,
        output,
        status: output ? "completed" : "running",
        suppressLogLine: true
      };
    }

    if (path || /(file|write|read|edit)/i.test(tool)) {
      return {
        type: "opencode.file",
        id: partId || nextAgentStreamBlockId("opencode-file"),
        tool,
        path,
        status: output ? "completed" : "running",
        suppressLogLine: true
      };
    }

    return {
      type: "opencode.tool",
      id: partId || nextAgentStreamBlockId("opencode-tool"),
      tool,
      status: output ? "completed" : "running",
      suppressLogLine: true
    };
  }

  if (partType === "patch") {
    const files = Array.isArray(part.files) ? part.files : [];
    if (!files.length) {
      return {
        type: "opencode.tool",
        id: partId || nextAgentStreamBlockId("opencode-patch"),
        tool: "patch",
        status: "completed",
        suppressLogLine: true
      };
    }

    return files.map((path, index) => ({
      type: "opencode.file",
      id: `${partId || nextAgentStreamBlockId("opencode-patch")}-${index}`,
      tool: "patch",
      path,
      status: "completed",
      suppressLogLine: true
    }));
  }

  return null;
}

function buildOpencodeBlocksFromMessages(payload) {
  const blocks = [];
  const seen = new Set();

  for (const message of extractOpencodeMessages(payload)) {
    for (const part of opencodeAssistantMessageParts(message)) {
      const events = []
        .concat(buildOpencodePartEvent(part) || [])
        .filter(Boolean);

      for (const event of events) {
        const block = event?.type === "designcode.block"
          ? event.block
          : parseOpencodeStreamBlock(event);
        if (!block) {
          continue;
        }
        const key = `${block.type}:${block.id}:${block.content || block.command || ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        blocks.push(block);
      }
    }
  }

  return blocks;
}

function parseCliStreamBlock(payload) {
  if (!payload?.line) {
    return null;
  }

  const rawLine = String(payload.line).trim();
  if (!rawLine) {
    return null;
  }

  if (payload.channel === "stderr") {
    return {
      id: nextAgentStreamBlockId("stderr"),
      type: "text",
      tone: "error",
      content: rawLine
    };
  }

  if (!rawLine.startsWith("{")) {
    return null;
  }

  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return null;
  }

  if (event?.type === "designcode.block" && event.block && typeof event.block === "object") {
    return {
      ...event.block,
      backend: event.block.backend || payload.backend
    };
  }

  switch (payload.backend) {
    case "claude":
      return parseClaudeStreamBlock(event);
    case "gemini":
      return parseGeminiStreamBlock(event);
    case "opencode":
      return parseOpencodeStreamBlock(event);
    default:
      return parseCodexStreamBlock(event);
  }
}

// ---------------------------------------------------------------------------
// 流式块更新
// ---------------------------------------------------------------------------

function upsertAgentStreamBlock(block) {
  if (!block) {
    return;
  }

  const blocks = [...(state.agent.streamBlocks || [])];
  const sameIdIndex = findLastBlockIndex(
    blocks,
    (entry) => entry?.id === block.id && entry?.type === block.type
  );
  if (sameIdIndex !== -1) {
    blocks[sameIdIndex] = {
      ...blocks[sameIdIndex],
      ...block,
      id: blocks[sameIdIndex].id
    };
    state.agent.streamBlocks = blocks;
    return;
  }

  const updateExisting = (predicate, patch) => {
    const index = findLastBlockIndex(blocks, predicate);
    if (index === -1) {
      return false;
    }
    blocks[index] = {
      ...blocks[index],
      ...patch,
      id: blocks[index].id
    };
    state.agent.streamBlocks = blocks;
    return true;
  };

  if (block.type === "command" && block.status !== "running") {
    if (
      updateExisting(
        (entry) => entry.type === "command" && entry.id === block.id,
        block
      ) ||
      updateExisting(
        (entry) => entry.type === "command" && entry.status === "running",
        block
      )
    ) {
      return;
    }
  }

  if (block.type === "todo" && block.status !== "running") {
    if (
      updateExisting(
        (entry) => entry.type === "todo" && entry.id === block.id,
        block
      ) ||
      updateExisting(
        (entry) => entry.type === "todo" && entry.status === "running",
        block
      )
    ) {
      return;
    }
  }

  if (block.type === "confirm" && block.status !== "waiting") {
    if (
      updateExisting(
        (entry) => entry.type === "confirm" && entry.id === block.id,
        block
      ) ||
      updateExisting(
        (entry) => entry.type === "confirm" && entry.status === "waiting",
        block
      )
    ) {
      return;
    }
  }

  blocks.push(block);
  state.agent.streamBlocks = blocks;
}

// ---------------------------------------------------------------------------
// 对话块操作（审批确认 / 拒绝）
// ---------------------------------------------------------------------------

async function handleConversationBlockAction(blockId, action) {
  const index = findLastBlockIndex(
    state.agent.streamBlocks || [],
    (block) => block.id === blockId && block.type === "confirm"
  );
  if (index === -1) {
    return;
  }

  const blocks = [...state.agent.streamBlocks];
  const current = blocks[index];
  const backend = current.backend || _activeRuntimeBackend.value;
  const approvalId = current.approvalId || current.id;
  const sessionId = current.sessionId || _activeRuntimeSessionId.value || null;
  blocks[index] = {
    ...current,
    localAction: action,
    interactive: false,
    note: action === "confirm" ? t("status.confirming") : t("status.rejecting")
  };
  state.agent.streamBlocks = blocks;

  if (backend !== "opencode" && backend !== "codex" && backend !== "gemini") {
    blocks[index] = {
      ...blocks[index],
      interactive: false,
      note: t("runtime.approvalTransportNote", { backend: _runtimeBackendDisplayName(backend) })
    };
    state.agent.streamBlocks = blocks;
    setStatus(t("status.approvalNotSupported"), "warning", "input");
    return;
  }

  try {
    await replyRuntimeApproval({
      backend,
      sessionId,
      approvalId,
      decision: action === "confirm" ? "once" : "reject",
      directory: _runtimeDirectory.value
    });
    blocks[index] = {
      ...blocks[index],
      interactive: false,
      status: "resolved",
      note: action === "confirm" ? t("status.confirmed") : t("status.rejected")
    };
    state.agent.streamBlocks = blocks;
    setStatus(action === "confirm" ? t("status.confirmed") : t("status.rejected"), "success", "update");
  } catch (error) {
    blocks[index] = {
      ...blocks[index],
      interactive: true,
      note: error instanceof Error ? error.message : String(error)
    };
    state.agent.streamBlocks = blocks;
    setStatus(t("status.approvalFailed"), "error", "input");
  }
}

// ---------------------------------------------------------------------------
// computed
// ---------------------------------------------------------------------------

const pendingConversationBlocks = computed(() => [{
  id: "pending-agent-boot",
  type: "thought",
  content: t("chat.agentStarting")
}]);

const conversationEntries = computed(() => {
  const entries = _designChatMessages.value
    .filter((message) => message.kind !== "config")
    .map((message) => ({
      id: `entry-${message.id}`,
      role: conversationRoleLabel(message.role),
      actorName: conversationActorName(message.role),
      actorInitial: conversationActorInitial(message.role),
      kindLabel: conversationKindLabel(message.kind, message.role),
      timeLabel: formatClock(message.createdAt),
      text: message.role === "user" ? message.text : "",
      blocks: message.role === "user" ? [] : conversationStoredBlocks(message),
      isLive: false
    }));

  const liveBlocks = _liveConversationBlocks.value;
  if (liveBlocks.length) {
    entries.push({
      id: "entry-live",
      role: "agent",
      actorName: "Design Agent",
      actorInitial: "A",
      kindLabel: "live",
      timeLabel: "streaming",
      text: "",
      blocks: liveBlocks,
      isLive: true
    });
  } else if (_conversationIsBusy.value) {
    entries.push({
      id: "entry-live",
      role: "agent",
      actorName: "Design Agent",
      actorInitial: "A",
      kindLabel: "pending",
      timeLabel: "starting",
      text: "",
      blocks: pendingConversationBlocks.value,
      isLive: true
    });
  }

  return entries;
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function useConversation({
  activeRuntimeBackend,
  activeRuntimeSessionId,
  runtimeDirectory,
  runtimeBackendDisplayName,
  designChatMessages,
  liveConversationBlocks,
  conversationIsBusy
} = {}) {
  // 首次调用时缓存外部依赖
  if (activeRuntimeBackend) _activeRuntimeBackend = activeRuntimeBackend;
  if (activeRuntimeSessionId) _activeRuntimeSessionId = activeRuntimeSessionId;
  if (runtimeDirectory) _runtimeDirectory = runtimeDirectory;
  if (runtimeBackendDisplayName) _runtimeBackendDisplayName = runtimeBackendDisplayName;
  if (designChatMessages) _designChatMessages = designChatMessages;
  if (liveConversationBlocks) _liveConversationBlocks = liveConversationBlocks;
  if (conversationIsBusy) _conversationIsBusy = conversationIsBusy;

  return {
    // 角色 / 类型标签
    conversationRoleLabel,
    conversationActorName,
    conversationActorInitial,
    conversationKindLabel,

    // 语气 / 块处理
    conversationStoredTone,
    conversationStoredBlocks,

    // 乐观更新
    appendOptimisticUserConversation,
    finalizeOptimisticConversationEntry,
    appendLocalAssistantConversation,
    rollbackOptimisticConversationEntry,

    // 消息规范化
    normalizeConversationMessage,

    // 对话块文本 / 展开
    conversationBlockText,
    conversationBlockKey,
    conversationBlockExpandable,
    isConversationBlockExpanded,
    toggleConversationBlock,

    // 流式块辅助
    nextAgentStreamBlockId,
    findLastBlockIndex,

    // 通用文本提取
    pickFirstText,

    // Todo
    normalizeTodoStatus,
    normalizeTodoEntries,

    // 审批
    resolveApprovalDetails,

    // 各后端流式事件解析
    parseCodexStreamBlock,
    parseClaudeStreamBlock,
    parseGeminiStreamBlock,
    parseOpencodeStreamBlock,
    extractOpencodeMessages,
    buildOpencodeBlocksFromMessages,
    parseCliStreamBlock,

    // 流式块更新
    upsertAgentStreamBlock,

    // 对话块操作
    handleConversationBlockAction,

    // computed
    pendingConversationBlocks,
    conversationEntries
  };
}
