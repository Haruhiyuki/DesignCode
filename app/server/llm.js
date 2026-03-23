import {
  attachDesignSession,
  prepareDesignSession,
  syncDesignWorkspace
} from "./design-sessions.js";

const OPENCODE_BASE_URL = process.env.DESIGNCODE_OPENCODE_BASE_URL || "http://127.0.0.1:4096";
const OPENCODE_REQUEST_TIMEOUT_MS = Number(process.env.DESIGNCODE_OPENCODE_TIMEOUT_MS || 8000);

function composeDesignSystemPrompt(basePrompt) {
  return String(basePrompt || "").trim();
}

function extractSessionId(value) {
  return (
    value?.id ||
    value?.sessionID ||
    value?.session?.id ||
    null
  );
}

function extractOpencodeError(value) {
  return (
    value?.info?.error?.data?.message ||
    value?.error?.data?.message ||
    value?.error?.message ||
    null
  );
}

async function opencodeRequest(pathname, { method = "GET", body, directory } = {}) {
  const url = new URL(pathname, OPENCODE_BASE_URL);
  if (directory) {
    url.searchParams.set("directory", directory);
  }

  let response;

  try {
    response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`OpenCode request timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms.`);
    }

    throw new Error(
      `OpenCode request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenCode returned ${response.status}: ${text || "request failed"}`);
  }

  return response.json();
}

async function ensureOpencodeAvailable() {
  try {
    await opencodeRequest("/provider/auth");
  } catch (error) {
    throw new Error(
      `OpenCode server is not available at ${OPENCODE_BASE_URL}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function ensureWorkspaceSession(rootDir, prepared) {
  const existingSessionId = prepared.design?.sessionId || null;
  if (existingSessionId) {
    return existingSessionId;
  }

  const designId = prepared.design?.id;
  const workspaceDir = prepared.design?.workspaceDir;
  if (!designId || !workspaceDir) {
    throw new Error("Design workspace is missing id or directory.");
  }

  const response = await opencodeRequest("/session", {
    method: "POST",
    directory: workspaceDir,
    body: {
      title: `DesignCode ${designId}`
    }
  });

  const sessionId = extractSessionId(response);
  if (!sessionId) {
    throw new Error("OpenCode did not return a session id.");
  }

  await attachDesignSession(rootDir, designId, sessionId, "opencode");
  return sessionId;
}

async function runOpencodeDesign(payload, mode, rootDir = process.cwd()) {
  const prepared = await prepareDesignSession(rootDir, payload, mode);
  await ensureOpencodeAvailable();
  const sessionId = await ensureWorkspaceSession(rootDir, prepared);
  const promptBundle = prepared.promptBundle;

  const response = await opencodeRequest(`/session/${sessionId}/message`, {
    method: "POST",
    directory: prepared.design.workspaceDir,
    body: {
      parts: [
        {
          type: "text",
          text: promptBundle.userMessage
        }
      ],
      agent: "build",
      system: composeDesignSystemPrompt(promptBundle.systemPrompt)
    }
  });

  const opencodeError = extractOpencodeError(response);
  if (opencodeError) {
    throw new Error(`OpenCode design execution failed: ${opencodeError}`);
  }

  const synced = await syncDesignWorkspace(rootDir, {
      ...payload,
      designId: prepared.design.id,
      sessionId,
      mode,
      promptBundle,
      meta: prepared.meta,
      configSignature: prepared.design.configSignature,
      summary:
        mode === "generate"
          ? "Initial render completed via OpenCode."
          : "Render updated successfully via OpenCode."
    });

  if (!synced.design?.sessionId) {
    await attachDesignSession(rootDir, prepared.design.id, sessionId, "opencode");
    synced.design = {
      ...synced.design,
      sessionId
    };
  }

  return {
    ...synced,
    provider: "opencode"
  };
}

export async function generateDesign(payload) {
  return runOpencodeDesign(payload, "generate");
}

export async function editDesign(payload) {
  return runOpencodeDesign(payload, "edit");
}
