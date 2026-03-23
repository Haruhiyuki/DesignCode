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

function parseClaudeStreamBlock(event) {
  const approval = resolveApprovalDetails(event);
  if (approval) {
    return approval;
  }

  if (event.type === "result") {
    const content = normalizeConversationMessage(event.result || "");
    return content
      ? {
          id: nextAgentStreamBlockId("text"),
          type: "text",
          tone: event.is_error ? "error" : undefined,
          content
        }
      : null;
  }

  if (event.type === "assistant") {
    const items = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of items) {
      if (item?.type === "tool_use") {
        const toolName = String(item.name || "").trim();
        const toolInput = item.input || {};

        if (toolName === "TodoWrite") {
          const todoItems = normalizeTodoEntries(toolInput);
          if (todoItems.length) {
            return {
              id: item.id || nextAgentStreamBlockId("todo"),
              type: "todo",
              title: "Todo List",
              items: todoItems,
              status: "running"
            };
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
            return {
              id: item.id || nextAgentStreamBlockId("command"),
              type: "command",
              command,
              output: "",
              status: "running"
            };
          }
        }

        const toolSummary = pickFirstText(
          toolInput.path,
          toolInput.file_path,
          toolInput.pattern,
          toolInput.query,
          toolInput.command
        );
        const label = toolName || "Tool";
        if (label) {
          return {
            id: item.id || nextAgentStreamBlockId("text"),
            type: "thought",
            content: toolSummary ? `${label}: ${toolSummary}` : label
          };
        }
      }

      if (item?.type === "text") {
        const safeContent = normalizeConversationMessage(item.text || "");
        if (safeContent) {
          return {
            id: nextAgentStreamBlockId("text"),
            type: "text",
            content: safeContent
          };
        }
      }
    }
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
      return null;
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
