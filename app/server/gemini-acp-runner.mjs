import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitBlock(block) {
  emit({
    type: "designcode.block",
    block: {
      backend: "gemini",
      suppressLogLine: true,
      ...block
    }
  });
}

function emitPhase(message, meta = {}) {
  emit({
    type: "designcode.phase",
    message,
    ...meta
  });
}

function compactText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function normalizeStatus(value) {
  switch (String(value || "")) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

function summarizeToolContent(content = []) {
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      if (entry.type === "content") {
        if (entry.content?.type === "text") {
          return compactText(entry.content.text);
        }
        return entry.content?.type ? `[${entry.content.type}]` : "";
      }
      if (entry.type === "diff") {
        const kind = entry._meta?.kind || "modify";
        return `${kind}: ${entry.path || "file"}`;
      }
      if (entry.type === "terminal") {
        return `[terminal ${entry.terminalId || ""}]`.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeLocations(locations = []) {
  return locations
    .map((location) => {
      if (!location?.path) {
        return "";
      }
      return location.line ? `${location.path}:${location.line}` : location.path;
    })
    .filter(Boolean);
}

function normalizeTodoItems(entries = []) {
  return entries.map((entry, index) => ({
    id: `todo-${index}`,
    label: compactText(entry?.content || entry?.label || entry?.text || ""),
    status: entry?.status === "completed"
      ? "done"
      : entry?.status === "in_progress"
        ? "in_progress"
        : "pending"
  }));
}

function absoluteLocation(cwd, rawPath = "") {
  if (!rawPath) {
    return "";
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function buildGeminiChildEnv() {
  const env = { ...process.env };
  for (const key of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "CLOUD_SHELL",
    "GEMINI_CLI_USE_COMPUTE_ADC"
  ]) {
    delete env[key];
  }
  return env;
}

function resolveGeminiPackageRoot(payload) {
  const entry = Array.isArray(payload?.launchArgs)
    ? payload.launchArgs.find((value) => String(value || "").endsWith("/dist/index.js"))
    : "";
  if (entry) {
    return path.dirname(path.dirname(entry));
  }

  const sdkPath = String(payload?.sdkPath || "");
  if (!sdkPath) {
    throw new Error("Missing Gemini package root.");
  }

  let current = path.dirname(sdkPath);
  for (let index = 0; index < 4; index += 1) {
    current = path.dirname(current);
  }
  return current;
}

async function importGeminiPackageModule(packageRoot, relativePath) {
  const href = pathToFileURL(path.join(packageRoot, relativePath)).href;
  return await import(href);
}

async function loadGeminiRuntimeContext(payload) {
  const packageRoot = resolveGeminiPackageRoot(payload);
  const [core, settingsModule] = await Promise.all([
    importGeminiPackageModule(packageRoot, "node_modules/@google/gemini-cli-core/dist/index.js"),
    importGeminiPackageModule(packageRoot, "dist/src/config/settings.js")
  ]);

  const settings = settingsModule.loadSettings(payload.cwd);
  return { packageRoot, core, settings };
}

function readConfiguredGeminiModel(settings) {
  const candidates = [
    settings?.merged?.model?.name,
    typeof settings?.merged?.model === "string" ? settings.merged.model : "",
    typeof settings?.merged?.general?.model === "string" ? settings.merged.general.model : "",
    typeof settings?.merged?.core?.model === "string" ? settings.merged.core.model : ""
  ];

  for (const candidate of candidates) {
    const text = compactText(candidate);
    if (text) {
      return text;
    }
  }

  return "";
}

function isGeminiPreviewAutoModel(core, modelId = "") {
  const value = compactText(modelId);
  return Boolean(
    value
    && (value === core.PREVIEW_GEMINI_MODEL_AUTO || value === "auto-gemini-3")
  );
}

function isGeminiPreviewModelId(modelId = "") {
  const value = compactText(modelId).toLowerCase();
  return Boolean(
    value
    && (
      value === "auto-gemini-3"
      || value.includes("preview")
      || value.startsWith("gemini-3-")
      || value.startsWith("gemini-3.1-")
    )
  );
}

function extractGeminiCapacityModel(value = "") {
  const text = String(value || "");
  const direct = text.match(/No capacity available for model\s+([^\s"']+)/i);
  if (direct?.[1]) {
    return direct[1].trim();
  }

  const metadata = text.match(/"model"\s*:\s*"([^"]+)"/i);
  return metadata?.[1]?.trim() || "";
}

function isGeminiCapacityError(value = "") {
  const text = String(value || "");
  return /No capacity available for model/i.test(text) || /MODEL_CAPACITY_EXHAUSTED/i.test(text);
}

async function resolveGeminiExecutionPlan(payload) {
  const { core, settings } = await loadGeminiRuntimeContext(payload);
  const configuredModel = readConfiguredGeminiModel(settings);
  const requestedModel = compactText(payload.model);
  const effectiveModel = requestedModel || configuredModel || core.PREVIEW_GEMINI_MODEL_AUTO;

  return {
    requestedModel,
    configuredModel,
    effectiveModel,
    fallbackModel: null,
    fallbackDisplayName: null,
    note: ""
  };
}

function buildAvailableModelsSnapshot(core, settings) {
  const selectedAuthType = settings?.merged?.security?.auth?.selectedType;
  const preferredModel =
    readConfiguredGeminiModel(settings) || core.PREVIEW_GEMINI_MODEL_AUTO;
  const useGemini31 =
    selectedAuthType === core.AuthType.USE_GEMINI
    || selectedAuthType === core.AuthType.USE_VERTEX_AI;
  const useCustomToolModel = useGemini31 && selectedAuthType === core.AuthType.USE_GEMINI;
  const shouldShowPreviewModels = true;

  const mainOptions = [
    {
      value: core.DEFAULT_GEMINI_MODEL_AUTO,
      title: core.getDisplayString(core.DEFAULT_GEMINI_MODEL_AUTO),
      description:
        "Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash"
    }
  ];

  if (shouldShowPreviewModels) {
    mainOptions.unshift({
      value: core.PREVIEW_GEMINI_MODEL_AUTO,
      title: core.getDisplayString(core.PREVIEW_GEMINI_MODEL_AUTO),
      description: useGemini31
        ? "Let Gemini CLI decide the best model for the task: gemini-3.1-pro, gemini-3-flash"
        : "Let Gemini CLI decide the best model for the task: gemini-3-pro, gemini-3-flash"
    });
  }

  const manualOptions = [
    {
      value: core.DEFAULT_GEMINI_MODEL,
      title: core.getDisplayString(core.DEFAULT_GEMINI_MODEL)
    },
    {
      value: core.DEFAULT_GEMINI_FLASH_MODEL,
      title: core.getDisplayString(core.DEFAULT_GEMINI_FLASH_MODEL)
    },
    {
      value: core.DEFAULT_GEMINI_FLASH_LITE_MODEL,
      title: core.getDisplayString(core.DEFAULT_GEMINI_FLASH_LITE_MODEL)
    }
  ];

  if (shouldShowPreviewModels) {
    const previewProModel = useGemini31
      ? core.PREVIEW_GEMINI_3_1_MODEL
      : core.PREVIEW_GEMINI_MODEL;
    const previewProValue = useCustomToolModel
      ? core.PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL
      : previewProModel;

    manualOptions.unshift(
      {
        value: previewProValue,
        title: core.getDisplayString(previewProModel)
      },
      {
        value: core.PREVIEW_GEMINI_FLASH_MODEL,
        title: core.getDisplayString(core.PREVIEW_GEMINI_FLASH_MODEL)
      }
    );
  }

  const normalize = (option) => ({
    modelId: option.value,
    name: option.title,
    description: option.description
  });

  return {
    currentModelId: preferredModel,
    availableModels: [...mainOptions, ...manualOptions].map(normalize)
  };
}

async function queryGeminiAvailableModels(payload) {
  const { core, settings } = await loadGeminiRuntimeContext(payload);
  return buildAvailableModelsSnapshot(core, settings);
}

function optionIdForDecision(options = [], decision = "once") {
  const normalized = String(decision || "").toLowerCase();
  const pick = (kind) => options.find((option) => option?.kind === kind)?.optionId;

  if (normalized === "session") {
    return pick("allow_always") || pick("allow_once") || null;
  }

  if (["cancel", "reject", "deny", "decline"].includes(normalized)) {
    return pick("reject_once") || pick("reject_always") || null;
  }

  return pick("allow_once") || pick("allow_always") || null;
}

class GeminiAcpRunner {
  constructor(payload, acp) {
    this.payload = payload;
    this.acp = acp;
    this.agentProcess = null;
    this.connection = null;
    this.readline = null;
    this.pendingApprovals = new Map();
    this.currentSessionId = payload.sessionId || null;
    this.lastMessage = "";
    this.lastThought = "";
    this.toolBlocks = new Map();
    this.historyDrainResolver = null;
    this.historyDrainTimer = null;
    this.ignoringHistory = false;
    this.promptBlockIds = {
      message: "gemini-message",
      thought: "gemini-thought",
      todo: "gemini-plan"
    };
    this.executionPlan = null;
    this.currentModelId = "";
    this.reportedCapacityModel = "";
    this.fallbackAttempted = false;
    this.startedAt = Date.now();
    this.activePromptId = null;
  }

  async run() {
    try {
      if (this.payload.mode === "models") {
        const created = await queryGeminiAvailableModels(this.payload);
        emit({
          type: "designcode.models",
          models: created || null,
          sessionId: null
        });
        emit({
          type: "designcode.result",
          sessionId: null,
          output: "Gemini ACP 模型列表已获取。"
        });
        return;
      }

      emitPhase("启动 Gemini ACP...");
      await this.startAgent();
      emitPhase("Gemini ACP 已启动。", { elapsedMs: Date.now() - this.startedAt });
      await this.initializeConnection();
      emitPhase("Gemini ACP 连接已初始化。", { elapsedMs: Date.now() - this.startedAt });

      if (this.payload.mode === "auth") {
        await this.authenticate();
        emit({
          type: "designcode.result",
          sessionId: null,
          output: "Gemini ACP 登录已完成。"
        });
        return;
      }

      const sessionId = await this.ensureSession();
      emitPhase("Gemini 会话已就绪。", { sessionId, elapsedMs: Date.now() - this.startedAt });
      emit({
        type: "designcode.session",
        sessionId
      });
      this.executionPlan = await resolveGeminiExecutionPlan(this.payload);
      this.currentModelId = this.executionPlan.effectiveModel || "";
      if (this.executionPlan.note) {
        emitPhase(this.executionPlan.note, { sessionId, elapsedMs: Date.now() - this.startedAt });
      }
      await this.configureSession(sessionId, this.currentModelId);
      emitPhase("Gemini 会话配置完成。", {
        sessionId,
        modelId: this.currentModelId || null,
        elapsedMs: Date.now() - this.startedAt
      });

      if (this.payload.mode === "session") {
        emit({
          type: "designcode.ready",
          sessionId,
          modelId: this.currentModelId || null
        });
        await this.connection.closed;
        return;
      }

      await this.executePrompt(this.payload.promptId || "prompt-0", this.payload.prompt || "", this.payload.model || this.currentModelId);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const capacityModel = extractGeminiCapacityModel(rawMessage) || this.reportedCapacityModel;
      const message = isGeminiCapacityError(rawMessage)
        ? `Gemini 模型 ${capacityModel || this.currentModelId || "当前模型"} 当前容量不足。请稍后重试，或改用 Auto (Gemini 2.5) / Gemini 2.5 Pro。`
        : rawMessage;
      if (this.activePromptId) {
        emit({
          type: "designcode.prompt_error",
          promptId: this.activePromptId,
          sessionId: this.currentSessionId || null,
          message
        });
      } else {
        emit({
          type: "designcode.error",
          message
        });
      }
      process.exitCode = 1;
    } finally {
      await this.shutdown();
    }
  }

  async executePrompt(promptId, promptText, requestedModel = null) {
    const sessionId = this.currentSessionId || await this.ensureSession();
    this.activePromptId = promptId;
    this.resetPromptState();

    const nextModel = compactText(requestedModel || this.currentModelId || this.payload.model || "");
    if (nextModel && nextModel !== this.currentModelId) {
      await this.configureSession(sessionId, nextModel);
      emitPhase("Gemini 会话配置完成。", {
        sessionId,
        modelId: this.currentModelId || nextModel,
        elapsedMs: Date.now() - this.startedAt
      });
    }

    emitPhase("Gemini 已发送请求。", { sessionId, elapsedMs: Date.now() - this.startedAt });
    let result;
    try {
      result = await this.connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: promptText }]
      });
    } catch (error) {
      if (await this.retryWithCapacityFallback(sessionId, promptText, error)) {
        result = await this.connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: promptText }]
        });
      } else {
        throw error;
      }
    }

    if (this.lastMessage) {
      emitBlock({
        id: this.promptBlockIds.message,
        type: "text",
        content: this.lastMessage,
        status: "resolved",
        suppressLogLine: false
      });
    }

    emit({
      type: "designcode.prompt_result",
      promptId,
      sessionId,
      output: this.lastMessage,
      stopReason: result?.stopReason || "end_turn"
    });
    this.activePromptId = null;
  }

  async startAgent() {
    const args = [...(this.payload.launchArgs || []), "--acp"];
    const env = buildGeminiChildEnv();
    this.agentProcess = spawn(this.payload.launchProgram, args, {
      cwd: this.payload.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.agentProcess.stderr.setEncoding("utf8");
    const stderrReader = readline.createInterface({
      input: this.agentProcess.stderr,
      crlfDelay: Infinity
    });
    stderrReader.on("line", (line) => {
      this.handleAgentStderrLine(line);
    });

    process.on("SIGTERM", () => {
      this.agentProcess?.kill();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      this.agentProcess?.kill();
      process.exit(0);
    });
  }

  async initializeConnection() {
    const hostClient = {
      sessionUpdate: async (params) => this.handleSessionUpdate(params),
      requestPermission: async (params) => this.handlePermissionRequest(params)
    };

    const stream = this.acp.ndJsonStream(
      Writable.toWeb(this.agentProcess.stdin),
      Readable.toWeb(this.agentProcess.stdout)
    );
    this.connection = new this.acp.ClientSideConnection(() => hostClient, stream);

    const result = await this.connection.initialize({
      protocolVersion: this.acp.PROTOCOL_VERSION,
      clientCapabilities: {}
    });

    this.authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
  }

  async authenticate() {
    const requested = this.payload.authMethod || "oauth-personal";
    const available = this.authMethods.find((method) => method.id === requested)
      || this.authMethods.find((method) => method.id === "oauth-personal")
      || this.authMethods[0];

    if (!available?.id) {
      throw new Error("Gemini ACP 没有返回可用认证方式。");
    }

    await this.connection.authenticate({
      methodId: available.id
    });
  }

  async ensureSession() {
    if (this.currentSessionId) {
      this.ignoringHistory = true;
      await this.connection.loadSession({
        sessionId: this.currentSessionId,
        cwd: this.payload.cwd,
        mcpServers: []
      });
      // Gemini ACP resumes and replays history asynchronously. Waiting for the
      // full replay blocks the next prompt for too long and is not needed here
      // because the app already persists its own chat transcript.
      setTimeout(() => {
        this.ignoringHistory = false;
      }, 250);
      return this.currentSessionId;
    }

    const created = await this.connection.newSession({
      cwd: this.payload.cwd,
      mcpServers: []
    });
    this.currentSessionId = created?.sessionId || null;
    if (!this.currentSessionId) {
      throw new Error("Gemini ACP 没有返回 sessionId。");
    }
    return this.currentSessionId;
  }

  async configureSession(sessionId, modelId = null) {
    const preferredMode = this.payload.approvalMode || "autoEdit";
    try {
      await this.connection.setSessionMode({
        sessionId,
        modeId: preferredMode
      });
    } catch {}

    const selectedModel = compactText(modelId || this.payload.model || "");
    if (selectedModel) {
      try {
        await this.connection.unstable_setSessionModel({
          sessionId,
          modelId: selectedModel
        });
        this.currentModelId = selectedModel;
      } catch {}
    }
  }

  resetPromptState() {
    this.lastMessage = "";
    this.lastThought = "";
    this.toolBlocks.clear();
  }

  scheduleHistoryDrain() {
    if (!this.historyDrainResolver) {
      return;
    }
    clearTimeout(this.historyDrainTimer);
    this.historyDrainTimer = setTimeout(() => {
      const resolve = this.historyDrainResolver;
      this.historyDrainResolver = null;
      resolve();
    }, 80);
  }

  async waitForHistoryDrain() {
    await new Promise((resolve) => {
      this.historyDrainResolver = resolve;
      this.scheduleHistoryDrain();
    });
  }

  async handleSessionUpdate(params) {
    const update = params?.update;
    if (!update || typeof update !== "object") {
      return;
    }

    if (this.ignoringHistory) {
      this.scheduleHistoryDrain();
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type !== "text") {
          return;
        }
        this.lastMessage += update.content.text || "";
        emitBlock({
          id: this.promptBlockIds.message,
          type: "text",
          content: this.lastMessage,
          suppressLogLine: true
        });
        return;
      }
      case "agent_thought_chunk": {
        if (update.content?.type !== "text") {
          return;
        }
        this.lastThought += update.content.text || "";
        emitBlock({
          id: this.promptBlockIds.thought,
          type: "thought",
          content: this.lastThought,
          suppressLogLine: true
        });
        return;
      }
      case "plan": {
        emitBlock({
          id: this.promptBlockIds.todo,
          type: "todo",
          title: "Todo List",
          items: normalizeTodoItems(update.entries || []),
          status: (update.entries || []).every((entry) => entry?.status === "completed")
            ? "success"
            : "running",
          suppressLogLine: true
        });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const block = this.buildToolBlock(update);
        if (block) {
          emitBlock(block);
        }
        return;
      }
      default:
        return;
    }
  }

  buildToolBlock(update) {
    const toolCallId = update.toolCallId;
    if (!toolCallId) {
      return null;
    }

    const previous = this.toolBlocks.get(toolCallId) || {};
    const next = {
      ...previous,
      ...update
    };
    this.toolBlocks.set(toolCallId, next);

    const output = summarizeToolContent(next.content || []);
    const locations = summarizeLocations(next.locations || []);
    const content = [output, ...locations.map((value) => `路径：${value}`)]
      .filter(Boolean)
      .join("\n");

    if (next.kind === "execute") {
      return {
        id: toolCallId,
        type: "command",
        command: compactText(next.title || "执行命令"),
        output,
        status: normalizeStatus(next.status),
        suppressLogLine: next.status !== "completed" && next.status !== "failed"
      };
    }

    const tone = ["edit", "delete", "move"].includes(next.kind) ? "file" : undefined;
    return {
      id: toolCallId,
      type: "text",
      tone,
      content: compactText([next.title, content].filter(Boolean).join("\n")) || "Gemini 正在执行工具调用。",
      suppressLogLine: next.status !== "completed" && next.status !== "failed"
    };
  }

  shouldAutoApprove(params) {
    const kind = params?.toolCall?.kind;
    if (!["read", "search", "edit", "delete", "move"].includes(kind)) {
      return false;
    }
    const locations = Array.isArray(params?.toolCall?.locations) ? params.toolCall.locations : [];
    if (!locations.length) {
      return false;
    }
    return locations.every((location) => {
      const absolute = absoluteLocation(this.payload.cwd, location?.path || "");
      return absolute.startsWith(this.payload.cwd);
    });
  }

  async handlePermissionRequest(params) {
    const approvalId = params?.toolCall?.toolCallId || `approval-${Date.now()}`;
    const allowOption = optionIdForDecision(params?.options || [], "once");

    if (allowOption && this.shouldAutoApprove(params)) {
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption
        }
      };
    }

    const title = compactText(params?.toolCall?.title || "需要确认执行");
    const summary = [
      summarizeToolContent(params?.toolCall?.content || []),
      ...summarizeLocations(params?.toolCall?.locations || []).map((value) => `路径：${value}`),
      Array.isArray(params?.options) && params.options.length
        ? `可选：${params.options.map((option) => option.name).join(" / ")}`
        : ""
    ]
      .filter(Boolean)
      .join("\n");

    emitBlock({
      id: approvalId,
      approvalId,
      type: "confirm",
      title,
      content: summary || "当前操作需要确认后才能继续执行。",
      status: "waiting",
      interactive: true,
      sessionId: params?.sessionId || this.currentSessionId || null,
      note: ""
    });

    return await new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, {
        params,
        resolve
      });
    });
  }

  async handleControlMessage(line) {
    const raw = String(line || "").trim();
    if (!raw) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload.type === "prompt") {
      try {
        await this.executePrompt(
          payload.promptId || `prompt-${Date.now()}`,
          payload.prompt || "",
          payload.model || null
        );
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const capacityModel = extractGeminiCapacityModel(rawMessage) || this.reportedCapacityModel;
        emit({
          type: "designcode.prompt_error",
          promptId: payload.promptId || null,
          sessionId: this.currentSessionId || null,
          message: isGeminiCapacityError(rawMessage)
            ? `Gemini 模型 ${capacityModel || this.currentModelId || "当前模型"} 当前容量不足。请稍后重试，或改用 Auto (Gemini 2.5) / Gemini 2.5 Pro。`
            : rawMessage
        });
      } finally {
        this.activePromptId = null;
      }
      return;
    }

    if (payload.type !== "approval") {
      return;
    }

    const approvalId = payload.approvalId;
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return;
    }

    this.pendingApprovals.delete(approvalId);
    const optionId = optionIdForDecision(
      pending.params?.options || [],
      payload.decision || "once"
    );

    emitBlock({
      id: approvalId,
      approvalId,
      type: "confirm",
      title: compactText(pending.params?.toolCall?.title || "需要确认执行"),
      content: "",
      status: "resolved",
      interactive: false,
      sessionId: pending.params?.sessionId || this.currentSessionId || null,
      note: payload.decision === "cancel" || payload.decision === "reject"
        ? "已拒绝执行。"
        : "已确认执行。"
    });

    if (optionId) {
      pending.resolve({
        outcome: {
          outcome: "selected",
          optionId
        }
      });
      return;
    }

    pending.resolve({
      outcome: {
        outcome: "cancelled"
      }
    });
  }

  handleAgentStderrLine(line) {
    const text = compactText(line);
    if (!text) {
      return;
    }
    if (text === "Loaded cached credentials.") {
      return;
    }
    if (text.includes("[STARTUP] Phase 'cli_startup' was started but never ended.")) {
      return;
    }

    const capacityModel = extractGeminiCapacityModel(text);
    if (capacityModel) {
      this.reportedCapacityModel = capacityModel;
      return;
    }

    if (/^Attempt \d+ failed with status 429\./.test(text)) {
      return;
    }

    if (
      this.reportedCapacityModel
      && (
        text.startsWith("GaxiosError:")
        || text.startsWith("at ")
        || /^(config|response|headers|request|data|proxy|url|method|params|body|signal|retry|paramsSerializer|validateStatus|agent|errorRedactor):/i.test(text)
        || text.startsWith("[Symbol")
        || text === "{"
        || text === "}"
        || text === "["
        || text === "]"
        || text === "},"
        || text === "],"
        || text === "}, {"
      )
    ) {
      return;
    }

    process.stderr.write(`${text}\n`);
  }

  async retryWithCapacityFallback(sessionId, promptText, error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const fallbackModel = compactText(this.executionPlan?.fallbackModel || "");
    if (
      this.fallbackAttempted
      || !fallbackModel
      || fallbackModel === this.currentModelId
      || !isGeminiCapacityError(rawMessage)
    ) {
      return false;
    }

    this.fallbackAttempted = true;
    emitPhase(
      `Gemini 模型 ${extractGeminiCapacityModel(rawMessage) || this.currentModelId || "当前模型"} 当前容量不足，自动改用 ${this.executionPlan?.fallbackDisplayName || fallbackModel} 继续。`,
      { sessionId, elapsedMs: Date.now() - this.startedAt }
    );
    this.resetPromptState();
    await this.configureSession(sessionId, fallbackModel);
    emitPhase("Gemini 已重新发送请求。", {
      sessionId,
      modelId: fallbackModel,
      elapsedMs: Date.now() - this.startedAt
    });
    return true;
  }

  async shutdown() {
    clearTimeout(this.historyDrainTimer);
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({
        outcome: {
          outcome: "cancelled"
        }
      });
    }
    this.pendingApprovals.clear();

    if (this.readline) {
      this.readline.close();
    }

    if (this.connection?.closed) {
      try {
        await Promise.race([
          this.connection.closed,
          new Promise((resolve) => setTimeout(resolve, 200))
        ]);
      } catch {}
    }

    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
    }
  }
}

async function readInitPayload() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });
  const iterator = rl[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value) {
    throw new Error("Missing Gemini ACP runner payload.");
  }
  const payload = JSON.parse(first.value);
  return { payload, rl, iterator };
}

async function main() {
  const { payload, rl, iterator } = await readInitPayload();
  const sdkPath = pathToFileURL(payload.sdkPath).href;
  const acp = await import(sdkPath);
  const runner = new GeminiAcpRunner(payload, acp);
  runner.readline = rl;

  (async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      await runner.handleControlMessage(next.value);
    }
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  });

  await runner.run();
}

main().catch((error) => {
  emit({
    type: "designcode.error",
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
