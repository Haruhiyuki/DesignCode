import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveArtAssets,
  writeSelectedArtAssetManifest
} from "./art-assets.js";
import {
  designsRoot,
  ensureStudioScaffold
} from "./storage-layout.js";
import {
  buildEditPrompt,
  buildGenerationPrompt,
  sanitizeHtml
} from "../shared/prompt-engine.js";

const execFileAsync = promisify(execFile);
const PROJECT_FILE = "project.json";
const CHAT_FILE = "chat.json";
const DESIGN_FILE = "design.html";
const ART_ASSET_MANIFEST_FILE = "art-assets.json";
const WORKSPACE_SEED_MARKER = "DESIGNCODE_WORKSPACE_SEED";
const DEFAULT_RUNTIME_BACKEND = "opencode";
const SUPPORTED_RUNTIME_BACKENDS = new Set(["opencode", "codex", "claude", "gemini"]);
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

function isoNow() {
  return new Date().toISOString();
}

function hashText(value) {
  return createHash("sha1").update(String(value || "")).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compactText(value, fallback = "Untitled Design") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function slugify(value, fallback = "design") {
  const slug = compactText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = (slug || fallback).replace(/[. ]+$/g, "") || fallback;
  return WINDOWS_RESERVED_NAMES.has(safe) ? `${safe}-design` : safe;
}

function inferContentTitle(payload) {
  return compactText(
    payload.fields?.title ||
      payload.fields?.headline ||
      payload.fields?.name ||
      payload.fields?.recipient ||
      payload.brief,
    "Untitled Design"
  );
}

function requestedDesignName(payload) {
  const requested = compactText(
    payload.designName || payload.designDirectory || payload.designId || "",
    ""
  );
  return requested ? slugify(requested, "design") : "";
}

function resolveDesignName(payload, existingProject = null) {
  return requestedDesignName(payload) || existingProject?.id || "";
}

function requestedDesignId(payload) {
  const requested = compactText(payload.designDirectory || payload.designId || "", "");
  return requested ? slugify(requested, "") : "";
}

function formatDesignDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatAutoDesignId(dateStamp, sequence) {
  return `new-${dateStamp}-${String(sequence).padStart(2, "0")}`;
}

async function generateAutoDesignId(rootDir, date = new Date()) {
  await ensureStudioScaffold(rootDir);
  const dateStamp = formatDesignDateStamp(date);
  const pattern = new RegExp(`^new-${dateStamp}-(\\d+)$`);
  const entries = await readdir(designsRoot(rootDir), { withFileTypes: true });

  let maxSequence = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const match = entry.name.match(pattern);
    if (!match) {
      continue;
    }

    const sequence = Number.parseInt(match[1], 10);
    if (Number.isFinite(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  }

  return formatAutoDesignId(dateStamp, maxSequence + 1);
}

async function generateDesignId(rootDir, payload, existingProject = null) {
  if (existingProject?.id) {
    return existingProject.id;
  }

  const explicit = requestedDesignId(payload) || requestedDesignName(payload);
  if (explicit) {
    return explicit;
  }

  return generateAutoDesignId(rootDir);
}

function summarizeConfig(payload) {
  const fieldLines = Object.entries(payload.fields || {})
    .filter(([, value]) => String(value || "").trim())
    .map(([key, value]) => `- ${key}: ${String(value).trim()}`);

  const sizeLabel =
    payload.sizeId === "custom" && payload.customSize
      ? `${payload.customSize.name || "custom"} ${payload.customSize.width}×${payload.customSize.height}${payload.customSize.unit || "px"}`
      : payload.sizeId || "unknown";

  return [
    payload.designName ? `Design: ${payload.designName}` : "",
    `Style: ${payload.styleId || "unknown"}`,
    `Size: ${sizeLabel}`,
    payload.brief ? `Brief: ${payload.brief}` : "",
    payload.selectedArtAssets?.length
      ? `Art Assets: ${payload.selectedArtAssets.map((item) => `${item.name}${item.note ? `（${item.note}）` : ""}`).join(" / ")}`
      : "Art Assets: none",
    fieldLines.length ? "Fields:" : "",
    ...fieldLines
  ]
    .filter(Boolean)
    .join("\n");
}

function buildConfigSignature(payload) {
  return JSON.stringify({
    designName: payload.designName || "",
    styleId: payload.styleId,
    sizeId: payload.sizeId,
    customSize: payload.customSize || null,
    brief: payload.brief || "",
    fields: payload.fields || {},
    fieldDefinitions: payload.fieldDefinitions || [],
    selectedAssetIds: payload.selectedAssetIds || []
  });
}

function buildMessage(id, role, kind, text, extra = {}) {
  return {
    id,
    role,
    kind,
    text,
    createdAt: isoNow(),
    ...extra
  };
}

function normalizeBlockText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function normalizeStoredConversationBlocks(blocks = []) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }

      const type = compactText(block.type, "");
      if (!type) {
        return null;
      }

      if (type === "command") {
        const command = compactText(block.command, "");
        return command
          ? {
              type,
              command,
              output: normalizeBlockText(block.output),
              status: compactText(block.status, "success")
            }
          : null;
      }

      if (type === "todo") {
        const items = Array.isArray(block.items)
          ? block.items
              .map((item, index) => {
                const label = compactText(item?.label, "");
                if (!label) {
                  return null;
                }
                return {
                  id: compactText(item?.id, `todo-${index}`),
                  label,
                  status: compactText(item?.status, "pending")
                };
              })
              .filter(Boolean)
          : [];

        return {
          type,
          title: compactText(block.title, "Todo List"),
          status: compactText(block.status, "success"),
          items
        };
      }

      if (type === "confirm") {
        return {
          type,
          title: compactText(block.title, "需要确认执行"),
          content: normalizeBlockText(block.content),
          command: compactText(block.command, ""),
          status: compactText(block.status, "waiting")
        };
      }

      if (type === "thought" || type === "text") {
        const content = normalizeBlockText(block.content);
        return content
          ? {
              type,
              content,
              tone: compactText(block.tone, "")
            }
          : null;
      }

      return null;
    })
    .filter(Boolean);
}

function normalizeRuntimeBackend(value) {
  return SUPPORTED_RUNTIME_BACKENDS.has(value) ? value : DEFAULT_RUNTIME_BACKEND;
}

function normalizeRuntimeSessions(project = null) {
  const sessions = {
    opencode: null,
    codex: null,
    claude: null,
    gemini: null
  };

  if (project?.runtimeSessions && typeof project.runtimeSessions === "object") {
    if (project.runtimeSessions.opencode) {
      sessions.opencode = project.runtimeSessions.opencode;
    }
    if (project.runtimeSessions.codex) {
      sessions.codex = project.runtimeSessions.codex;
    }
    if (project.runtimeSessions.claude) {
      sessions.claude = project.runtimeSessions.claude;
    }
    if (project.runtimeSessions.gemini) {
      sessions.gemini = project.runtimeSessions.gemini;
    }
  }

  if (!sessions.opencode && project?.sessionId) {
    sessions.opencode = project.sessionId;
  }

  return sessions;
}

function activeRuntimeSession(project = null, runtimeBackend = DEFAULT_RUNTIME_BACKEND) {
  const backend = normalizeRuntimeBackend(runtimeBackend);
  const sessions = normalizeRuntimeSessions(project);
  return sessions[backend] || null;
}

function setRuntimeSession(project, runtimeBackend, sessionId) {
  const backend = normalizeRuntimeBackend(runtimeBackend);
  const sessions = normalizeRuntimeSessions(project);
  sessions[backend] = sessionId || null;
  project.runtimeSessions = sessions;
  if (backend === DEFAULT_RUNTIME_BACKEND) {
    project.sessionId = sessions.opencode || null;
  }
}

function decorateProject(project, workspaceDir, runtimeBackend = null) {
  const backend = normalizeRuntimeBackend(runtimeBackend || project?.runtimeBackend);
  const runtimeSessions = normalizeRuntimeSessions(project);
  return {
    ...project,
    workspaceDir,
    runtimeSessions,
    runtimeBackend: backend,
    sessionId: runtimeSessions[backend] || runtimeSessions.opencode || project?.sessionId || null
  };
}

function runtimeBackendLabel(runtimeBackend) {
  switch (normalizeRuntimeBackend(runtimeBackend)) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "gemini":
      return "Gemini CLI";
    default:
      return "OpenCode";
  }
}

function nextMessageId(messages) {
  return `msg_${String(messages.length + 1).padStart(4, "0")}`;
}

function designDir(rootDir, designId) {
  return path.join(designsRoot(rootDir), designId);
}

function projectFile(rootDir, designId) {
  return path.join(designDir(rootDir, designId), PROJECT_FILE);
}

function chatFile(rootDir, designId) {
  return path.join(designDir(rootDir, designId), CHAT_FILE);
}

function designFile(rootDir, designId) {
  return path.join(designDir(rootDir, designId), DESIGN_FILE);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function runGit(cwd, args, allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 8
    });
    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim()
    };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(error.stdout || "").trim(),
        stderr: String(error.stderr || error.message || "").trim()
      };
    }

    throw new Error(String(error.stderr || error.message || "Git command failed"));
  }
}

async function ensureGitRepo(cwd) {
  if (!existsSync(path.join(cwd, ".git"))) {
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.name", "DesignCode Studio"]);
    await runGit(cwd, ["config", "user.email", "designcode@local.invalid"]);
  }
}

async function getLatestCommit(cwd) {
  const result = await runGit(
    cwd,
    ["log", "--max-count=1", "--pretty=format:%H\t%s\t%cI"],
    true
  );

  if (!result.ok || !result.stdout) {
    return null;
  }

  const [hash, message, createdAt] = result.stdout.split("\t");
  if (!hash) {
    return null;
  }

  return {
    hash,
    message: message || "",
    createdAt: createdAt || ""
  };
}

async function commitWorkspace(cwd, message) {
  await ensureGitRepo(cwd);
  await runGit(cwd, ["add", "-A"]);

  const staged = await runGit(cwd, ["diff", "--cached", "--quiet"], true);
  if (staged.ok) {
    return getLatestCommit(cwd);
  }

  await runGit(cwd, ["commit", "--no-gpg-sign", "-m", message]);
  return getLatestCommit(cwd);
}

function summarizeAssistantResult(payload, result, mode) {
  const title = inferContentTitle(payload);
  const warningLine = result.warnings?.length
    ? `Warnings: ${result.warnings.join(" / ")}`
    : "Warnings: none";

  return [
    mode === "generate" ? "Initial render completed." : "Render updated successfully.",
    `Title: ${title}`,
    `Provider: ${result.provider || "mock"}`,
    warningLine
  ].join("\n");
}

function summarizeAgentWorkspaceResult(summary) {
  const text = String(summary || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return text || "OpenCode workspace updated.";
}

function buildMetaFromPayload(payload, existingMeta = null) {
  return {
    version: 1,
    styleId: payload.styleId,
    sizeId: payload.sizeId,
    customSize: payload.customSize || existingMeta?.customSize || null,
    brief: payload.brief || "",
    fields: payload.fields || {},
    fieldDefinitions: payload.fieldDefinitions || existingMeta?.fieldDefinitions || [],
    overrides: existingMeta?.overrides || payload.overrides || {},
    generatedAt: new Date().toISOString()
  };
}

function resolveProjectMeta(project = null, fallback = null) {
  if (project?.currentMeta) {
    return project.currentMeta;
  }
  if (fallback) {
    return fallback;
  }
  return buildMetaFromPayload(project || {}, null);
}

function stripDesignMetaComment(html) {
  return String(html || "").replace(/<!--\s*DESIGNCODE_META:[A-Za-z0-9+/=]+\s*-->\s*/g, "");
}

function sanitizeStoredDesignHtml(html) {
  return stripDesignMetaComment(sanitizeHtml(stripWorkspaceSeedMarker(html)));
}

function buildWorkspaceSeed(promptBundle, title) {
  const size =
    promptBundle?.size &&
    Number(promptBundle.size.width) > 0 &&
    Number(promptBundle.size.height) > 0
      ? promptBundle.size
      : null;
  const hint = "等待 agent 生成设计稿。";
  const rootSizeAttributes = size
    ? `data-design-width="${size.width}" data-design-height="${size.height}"`
    : 'data-design-width="" data-design-height=""';
  const canvasSizeStyles = size
    ? [
        `      width: ${size.width}px;`,
        `      height: ${size.height}px;`
      ]
    : [];

  return [
    "<!DOCTYPE html>",
    `<html lang="zh-CN" ${rootSizeAttributes}>`,
    "<head>",
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `  <title>${title}</title>`,
    "  <style>",
    "    :root { color-scheme: light; }",
    "    * { box-sizing: border-box; }",
    "    html, body {",
    "      margin: 0;",
    ...canvasSizeStyles,
    "      overflow: hidden;",
    "      font-family: 'SF Pro Display', 'PingFang SC', 'Segoe UI', sans-serif;",
    "      background: linear-gradient(135deg, #f4f0e8, #d8cfbf);",
    "      color: #1f1d19;",
    "    }",
    "    body {",
    size ? "" : "      min-height: 100vh;",
    "      display: grid;",
    "      place-items: center;",
    "    }",
    "    main {",
    "      width: min(78%, 920px);",
    "      padding: 48px;",
    "      border-radius: 32px;",
    "      background: rgba(255,255,255,0.72);",
    "      border: 1px solid rgba(42, 34, 24, 0.1);",
    "      box-shadow: 0 32px 80px rgba(32, 24, 18, 0.12);",
    "    }",
    "    h1 { margin: 0 0 16px; font-size: 56px; line-height: 0.96; }",
    "    p { margin: 0; font-size: 22px; line-height: 1.6; color: rgba(31,29,25,0.72); }",
    "  </style>",
    "</head>",
    "<body>",
      `  <!-- ${WORKSPACE_SEED_MARKER} -->`,
      '  <main data-layer="workspace-seed">',
      `    <h1 data-editable="title">${title}</h1>`,
      `    <p>${hint}</p>`,
    "  </main>",
    "</body>",
    "</html>"
  ].join("\n");
}

function stripWorkspaceSeedMarker(html) {
  return String(html || "").replace(
    new RegExp(`<!--\\s*${WORKSPACE_SEED_MARKER}\\s*-->\\s*`, "g"),
    ""
  );
}

function normalizeCommit(commit, index) {
  return {
    id: `v${index + 1}`,
    commitHash: commit.hash,
    label: commit.message,
    createdAt: commit.createdAt
  };
}

async function buildCommits(rootDir, designId) {
  const cwd = designDir(rootDir, designId);
  const result = await runGit(
    cwd,
    ["log", "--pretty=format:%H\t%s\t%cI", "--", DESIGN_FILE],
    true
  );

  if (!result.ok || !result.stdout) {
    return [];
  }

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, createdAt] = line.split("\t");
      return { hash, message, createdAt };
    })
    .reverse()
    .map(normalizeCommit);
}

async function readTrackedFileAtCommit(rootDir, designId, commitHash, fileName) {
  const cwd = designDir(rootDir, designId);
  const result = await runGit(cwd, ["show", `${commitHash}:${fileName}`], true);
  if (!result.ok) {
    return null;
  }
  return result.stdout;
}

async function hydratePayloadWithAssets(rootDir, payload) {
  const selectedAssetIds = Array.isArray(payload.selectedAssetIds) ? payload.selectedAssetIds : [];
  const selectedArtAssets = await resolveArtAssets(rootDir, selectedAssetIds);

  return {
    ...payload,
    selectedAssetIds,
    selectedArtAssets
  };
}

async function assertDesignDirectoryAvailable(rootDir, designId) {
  const cwd = designDir(rootDir, designId);
  if (!existsSync(cwd)) {
    return;
  }

  const entries = await readdir(cwd);
  if (entries.length) {
    throw new Error(`Design directory already exists: ${designId}`);
  }
}

async function loadDesignProject(rootDir, designId) {
  const project = await readJson(projectFile(rootDir, designId), null);
  if (!project) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  const html = existsSync(designFile(rootDir, designId))
    ? stripDesignMetaComment(await readFile(designFile(rootDir, designId), "utf8"))
    : "";
  const chat = await readJson(chatFile(rootDir, designId), []);
  const commits = await buildCommits(rootDir, designId);

  return {
    project,
    html,
    chat,
    commits,
    meta: resolveProjectMeta(project)
  };
}

export async function listDesignSessions(rootDir) {
  await ensureStudioScaffold(rootDir);
  const entries = await readdir(designsRoot(rootDir), { withFileTypes: true });
  const designs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const project = await readJson(projectFile(rootDir, entry.name), null);
    if (!project) {
      continue;
    }

    const latestCommit = await getLatestCommit(designDir(rootDir, entry.name));
    designs.push({
      ...decorateProject(project, designDir(rootDir, entry.name)),
      latestCommit
    });
  }

  return designs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function openDesignSession(rootDir, designId) {
  await ensureStudioScaffold(rootDir);
  const loaded = await loadDesignProject(rootDir, designId);
  return {
    design: decorateProject(loaded.project, designDir(rootDir, designId)),
    html: loaded.html,
    meta: loaded.meta,
    chat: loaded.chat,
    commits: loaded.commits,
    warnings: loaded.project.warnings || [],
    promptBundle: loaded.project.promptBundle || null
  };
}

export async function deleteDesignSession(rootDir, designId) {
  await ensureStudioScaffold(rootDir);
  const cwd = designDir(rootDir, designId);
  if (!existsSync(cwd)) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  await rm(cwd, { recursive: true, force: true });
  return {
    id: designId,
    deleted: true
  };
}

export async function createDesignSession(rootDir, payload) {
  await ensureStudioScaffold(rootDir);
  const hydratedPayload = await hydratePayloadWithAssets(rootDir, payload);
  const designId = await generateDesignId(rootDir, hydratedPayload);
  if (!designId) {
    throw new Error("Missing design directory.");
  }

  await assertDesignDirectoryAvailable(rootDir, designId);

  const cwd = designDir(rootDir, designId);
  await ensureDir(cwd);
  await ensureGitRepo(cwd);

  const runtimeBackend = normalizeRuntimeBackend(hydratedPayload.runtimeBackend);
  const designName = designId;
  const meta = buildMetaFromPayload(hydratedPayload);
  const now = isoNow();
  const project = {
    id: designId,
    directoryName: designId,
    createdAt: now,
    updatedAt: now,
    title: designName,
    sessionId: hydratedPayload.sessionId || null,
    styleId: hydratedPayload.styleId,
    sizeId: hydratedPayload.sizeId,
    customSize: hydratedPayload.customSize || null,
    fields: hydratedPayload.fields || {},
    fieldDefinitions: hydratedPayload.fieldDefinitions || [],
    brief: hydratedPayload.brief || "",
    selectedAssetIds: hydratedPayload.selectedAssetIds || [],
    provider: runtimeBackend,
    runtimeBackend,
    currentMeta: meta,
    promptBundle: null,
    warnings: [],
    lastInstruction: "",
    lastMode: "draft",
    workspaceSeedSignature: null,
    configSignature: buildConfigSignature({
      ...hydratedPayload,
      designName
    })
  };
  setRuntimeSession(
    project,
    runtimeBackend,
    hydratedPayload.sessionId || activeRuntimeSession(project, runtimeBackend)
  );

  await Promise.all([
    writeJson(projectFile(rootDir, designId), project),
    writeJson(chatFile(rootDir, designId), []),
    writeSelectedArtAssetManifest(cwd, hydratedPayload.selectedArtAssets)
  ]);

  return {
    design: decorateProject(project, cwd, runtimeBackend),
    html: "",
    meta,
    chat: [],
    commits: [],
    promptBundle: null,
    warnings: []
  };
}

export async function updateDesignSession(rootDir, designId, payload) {
  await ensureStudioScaffold(rootDir);
  const hydratedPayload = await hydratePayloadWithAssets(rootDir, {
    ...payload,
    designId
  });
  const existingProject = await readJson(projectFile(rootDir, designId), null);
  if (!existingProject) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  const nextDesignId = resolveDesignName(hydratedPayload, existingProject) || existingProject.id;
  if (nextDesignId !== designId) {
    if (existsSync(designDir(rootDir, nextDesignId))) {
      throw new Error(`Design directory already exists: ${nextDesignId}`);
    }
    await rename(designDir(rootDir, designId), designDir(rootDir, nextDesignId));
  }

  const cwd = designDir(rootDir, nextDesignId);

  const runtimeBackend = normalizeRuntimeBackend(
    hydratedPayload.runtimeBackend || existingProject.runtimeBackend
  );
  const designName = nextDesignId;
  const meta = buildMetaFromPayload(
    hydratedPayload,
    existingProject.currentMeta || null
  );
  const now = isoNow();
  const project = {
    ...existingProject
  };

  project.id = nextDesignId;
  project.directoryName = nextDesignId;
  project.title = designName;
  project.updatedAt = now;
  project.styleId = hydratedPayload.styleId;
  project.sizeId = hydratedPayload.sizeId;
  project.customSize = hydratedPayload.customSize || null;
  project.fields = hydratedPayload.fields || {};
  project.fieldDefinitions = hydratedPayload.fieldDefinitions || [];
  project.brief = hydratedPayload.brief || "";
  project.selectedAssetIds = hydratedPayload.selectedAssetIds || [];
  project.provider = existingProject.provider || runtimeBackend;
  project.runtimeBackend = runtimeBackend;
  project.currentMeta = meta;
  project.promptBundle = existingProject.promptBundle || null;
  project.warnings = existingProject.warnings || [];
  project.lastInstruction = existingProject.lastInstruction || "";
  project.lastMode = existingProject.lastMode || "draft";
  project.workspaceSeedSignature = existingProject.workspaceSeedSignature || null;
  project.configSignature = buildConfigSignature({
    ...hydratedPayload,
    designName
  });
  setRuntimeSession(
    project,
    runtimeBackend,
    hydratedPayload.sessionId || activeRuntimeSession(project, runtimeBackend)
  );

  await Promise.all([
    writeJson(projectFile(rootDir, nextDesignId), project),
    writeSelectedArtAssetManifest(cwd, hydratedPayload.selectedArtAssets)
  ]);

  return {
    design: decorateProject(project, cwd, runtimeBackend),
    meta,
    promptBundle: project.promptBundle,
    warnings: project.warnings || []
  };
}

export async function updateDesignHtml(rootDir, payload) {
  await ensureStudioScaffold(rootDir);
  const designId = compactText(payload.designId || "", "");
  if (!designId) {
    throw new Error("Missing designId for html update.");
  }

  const existingProject = await readJson(projectFile(rootDir, designId), null);
  if (!existingProject) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  const hydratedPayload = await hydratePayloadWithAssets(rootDir, {
    ...payload,
    designId
  });
  const cwd = designDir(rootDir, designId);
  await ensureDir(cwd);
  await ensureGitRepo(cwd);

  const rawHtml = String(hydratedPayload.html || "").trim();
  if (!rawHtml) {
    throw new Error("Missing html payload for design update.");
  }

  const runtimeBackend = normalizeRuntimeBackend(
    hydratedPayload.runtimeBackend || existingProject.runtimeBackend
  );
  const nextFields = hydratedPayload.fields || existingProject.fields || {};
  const nextFieldDefinitions =
    hydratedPayload.fieldDefinitions || existingProject.fieldDefinitions || [];
  const nextCustomSize =
    hydratedPayload.customSize === undefined
      ? existingProject.customSize || null
      : hydratedPayload.customSize || null;
  const meta =
    hydratedPayload.meta ||
    buildMetaFromPayload(
      {
        ...existingProject,
        ...hydratedPayload,
        customSize: nextCustomSize,
        fields: nextFields,
        fieldDefinitions: nextFieldDefinitions
      },
      existingProject.currentMeta || null
    );
  const html = sanitizeStoredDesignHtml(rawHtml);
  const now = isoNow();
  const project = {
    ...existingProject
  };

  project.updatedAt = now;
  project.styleId =
    hydratedPayload.styleId === undefined ? existingProject.styleId : hydratedPayload.styleId;
  project.sizeId =
    hydratedPayload.sizeId === undefined ? existingProject.sizeId : hydratedPayload.sizeId;
  project.customSize = nextCustomSize;
  project.fields = nextFields;
  project.fieldDefinitions = nextFieldDefinitions;
  project.brief =
    hydratedPayload.brief === undefined ? existingProject.brief || "" : hydratedPayload.brief || "";
  project.selectedAssetIds = Array.isArray(hydratedPayload.selectedAssetIds)
    ? hydratedPayload.selectedAssetIds
    : existingProject.selectedAssetIds || [];
  project.provider = existingProject.provider || runtimeBackend;
  project.runtimeBackend = runtimeBackend;
  project.currentMeta = meta;
  project.promptBundle = existingProject.promptBundle || null;
  project.warnings = existingProject.warnings || [];
  project.lastInstruction = hydratedPayload.instruction || existingProject.lastInstruction || "";
  project.lastMode = "inspect";
  project.workspaceSeedSignature = null;
  project.configSignature = buildConfigSignature({
    styleId: project.styleId,
    sizeId: project.sizeId,
    customSize: project.customSize,
    brief: project.brief,
    fields: project.fields,
    fieldDefinitions: project.fieldDefinitions,
    selectedAssetIds: project.selectedAssetIds,
    designName: project.title
  });
  if (hydratedPayload.sessionId || activeRuntimeSession(project, runtimeBackend)) {
    setRuntimeSession(
      project,
      runtimeBackend,
      hydratedPayload.sessionId || activeRuntimeSession(project, runtimeBackend)
    );
  }

  const chat = await readJson(chatFile(rootDir, designId), []);
  const selectedArtAssets = await resolveArtAssets(rootDir, project.selectedAssetIds || []);

  await Promise.all([
    writeFile(designFile(rootDir, designId), html, "utf8"),
    writeJson(projectFile(rootDir, designId), project),
    writeJson(chatFile(rootDir, designId), chat),
    writeSelectedArtAssetManifest(cwd, selectedArtAssets)
  ]);

  const latestCommit = await commitWorkspace(
    cwd,
    `inspect: ${compactText(hydratedPayload.entryLabel || "update text").slice(0, 72)}`
  );
  const commits = await buildCommits(rootDir, designId);

  return {
    design: {
      ...decorateProject(project, cwd, runtimeBackend),
      latestCommit
    },
    html,
    meta,
    chat,
    commits,
    warnings: project.warnings || [],
    promptBundle: project.promptBundle || null
  };
}

export async function readDesignCommit(rootDir, designId, commitHash) {
  await ensureStudioScaffold(rootDir);
  const [html, projectJson, chatJson] = await Promise.all([
    readTrackedFileAtCommit(rootDir, designId, commitHash, DESIGN_FILE),
    readTrackedFileAtCommit(rootDir, designId, commitHash, PROJECT_FILE),
    readTrackedFileAtCommit(rootDir, designId, commitHash, CHAT_FILE)
  ]);

  if (!html) {
    throw new Error(`Commit ${commitHash} does not contain ${DESIGN_FILE}`);
  }

  const project = projectJson ? JSON.parse(projectJson) : null;
  const chat = chatJson ? JSON.parse(chatJson) : [];

  return {
    html: stripDesignMetaComment(html),
    design: project,
    meta: resolveProjectMeta(project),
    chat
  };
}

export async function attachDesignSession(rootDir, designId, sessionId, runtimeBackend = DEFAULT_RUNTIME_BACKEND) {
  await ensureStudioScaffold(rootDir);
  runtimeBackend = normalizeRuntimeBackend(runtimeBackend);
  const project = await readJson(projectFile(rootDir, designId), null);
  if (!project) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  setRuntimeSession(project, runtimeBackend, sessionId);
  project.runtimeBackend = runtimeBackend;
  project.updatedAt = isoNow();
  await writeJson(projectFile(rootDir, designId), project);

  return {
    id: project.id,
    workspaceDir: designDir(rootDir, designId),
    sessionId: activeRuntimeSession(project, runtimeBackend),
    runtimeSessions: normalizeRuntimeSessions(project),
    runtimeBackend,
    updatedAt: project.updatedAt
  };
}

export async function prepareDesignSession(rootDir, payload, mode) {
  await ensureStudioScaffold(rootDir);
  const hydratedPayload = await hydratePayloadWithAssets(rootDir, payload);

  const existingProject = payload.designId
    ? await readJson(projectFile(rootDir, payload.designId), null)
    : null;
  const designId = await generateDesignId(rootDir, hydratedPayload, existingProject);
  const cwd = designDir(rootDir, designId);
  await ensureDir(cwd);
  await ensureGitRepo(cwd);

  const existingHtml = existsSync(designFile(rootDir, designId))
    ? await readFile(designFile(rootDir, designId), "utf8")
    : "";
  const existingMeta = existingProject?.currentMeta || null;
  const meta = buildMetaFromPayload(hydratedPayload, existingMeta);
  const seedCurrentHtml =
    mode === "edit"
      ? sanitizeStoredDesignHtml(
            hydratedPayload.currentHtml ||
            existingHtml ||
            buildWorkspaceSeed({ size: existingProject?.promptBundle?.size }, inferContentTitle(hydratedPayload))
        )
      : buildWorkspaceSeed(buildGenerationPrompt(hydratedPayload), inferContentTitle(hydratedPayload));
  const promptBundle =
    mode === "edit"
      ? buildEditPrompt({
          ...hydratedPayload
        })
      : buildGenerationPrompt(hydratedPayload);
  const chat = await readJson(chatFile(rootDir, designId), []);
  const commits = await buildCommits(rootDir, designId);
  const now = isoNow();
  const project = existingProject || {
    id: designId,
    createdAt: now,
    sessionId: hydratedPayload.sessionId || null
  };
  const runtimeBackend = normalizeRuntimeBackend(hydratedPayload.runtimeBackend);

  project.directoryName = project.id;
  project.title = project.id;
  project.updatedAt = now;
  project.styleId = hydratedPayload.styleId;
  project.sizeId = hydratedPayload.sizeId;
  project.customSize = hydratedPayload.customSize || null;
  project.fields = hydratedPayload.fields || {};
  project.fieldDefinitions = hydratedPayload.fieldDefinitions || [];
  project.brief = hydratedPayload.brief || "";
  project.selectedAssetIds = hydratedPayload.selectedAssetIds || [];
  project.provider = runtimeBackend;
  project.runtimeBackend = runtimeBackend;
  project.currentMeta = meta;
  project.promptBundle = promptBundle;
  project.warnings = [];
  project.lastInstruction = hydratedPayload.instruction || "";
  project.lastMode = mode;
  project.workspaceSeedSignature = hashText(seedCurrentHtml);
  project.configSignature = buildConfigSignature({
    ...hydratedPayload,
    designName: project.title
  });
  setRuntimeSession(project, runtimeBackend, hydratedPayload.sessionId || activeRuntimeSession(project, runtimeBackend));

  await Promise.all([
    writeFile(designFile(rootDir, designId), seedCurrentHtml, "utf8"),
    writeJson(projectFile(rootDir, designId), project),
    existsSync(chatFile(rootDir, designId)) ? Promise.resolve() : writeJson(chatFile(rootDir, designId), chat),
    writeSelectedArtAssetManifest(cwd, hydratedPayload.selectedArtAssets)
  ]);

  return {
    design: {
      ...decorateProject(project, cwd, runtimeBackend)
    },
    html: seedCurrentHtml,
    meta,
    chat,
    commits,
    promptBundle,
    warnings: []
  };
}

export async function persistDesignResult(rootDir, payload, result, mode) {
  await ensureStudioScaffold(rootDir);
  const hydratedPayload = await hydratePayloadWithAssets(rootDir, payload);

  const existingProject = payload.designId
    ? await readJson(projectFile(rootDir, payload.designId), null)
    : null;
  const designId = await generateDesignId(rootDir, hydratedPayload, existingProject);
  const cwd = designDir(rootDir, designId);

  await ensureDir(cwd);
  await ensureGitRepo(cwd);

  const chat = await readJson(chatFile(rootDir, designId), []);
  const designName = designId;
  const configSignature = buildConfigSignature({
    ...hydratedPayload,
    designName
  });
  const now = isoNow();
  const html = sanitizeStoredDesignHtml(result.html || "");

  const project = existingProject || {
    id: designId,
    createdAt: now,
    sessionId: hydratedPayload.sessionId || null
  };
  const runtimeBackend = normalizeRuntimeBackend(hydratedPayload.runtimeBackend || result.provider);
  const activeSessionId =
    hydratedPayload.sessionId ||
    activeRuntimeSession(project, runtimeBackend) ||
    null;
  const assistantBlocks = normalizeStoredConversationBlocks(hydratedPayload.assistantBlocks);

  project.directoryName = project.id;
  project.title = designName;
  project.updatedAt = now;
  project.styleId = hydratedPayload.styleId;
  project.sizeId = hydratedPayload.sizeId;
  project.customSize = hydratedPayload.customSize || null;
  project.fields = hydratedPayload.fields || {};
  project.fieldDefinitions = hydratedPayload.fieldDefinitions || [];
  project.brief = hydratedPayload.brief || "";
  project.selectedAssetIds = hydratedPayload.selectedAssetIds || [];
  project.provider = result.provider || runtimeBackend;
  project.runtimeBackend = runtimeBackend;
  project.currentMeta = result.meta || resolveProjectMeta(project);
  project.promptBundle = result.promptBundle || null;
  project.warnings = result.warnings || [];
  project.lastInstruction = hydratedPayload.instruction || "";
  project.lastMode = mode;
  project.workspaceSeedSignature = null;
  project.configSignature = configSignature;
  if (activeSessionId) {
    setRuntimeSession(project, runtimeBackend, activeSessionId);
  }

  if (!chat.length || existingProject?.configSignature !== configSignature) {
    chat.push(
      buildMessage(
        nextMessageId(chat),
        "system",
        "config",
        summarizeConfig({
          ...hydratedPayload,
          designName
        }),
        { promptBundle: result.promptBundle || null }
      )
    );
  }

  if (hydratedPayload.instruction) {
    chat.push(
      buildMessage(nextMessageId(chat), "user", "instruction", hydratedPayload.instruction, {
        sessionId: activeSessionId,
        runtimeBackend,
        createdAt: hydratedPayload.instructionCreatedAt || isoNow()
      })
    );
  }

  chat.push(
    buildMessage(
      nextMessageId(chat),
      "assistant",
      mode === "generate" ? "render" : "update",
      summarizeAssistantResult(hydratedPayload, result, mode),
      {
        sessionId: activeSessionId,
        runtimeBackend,
        blocks: assistantBlocks.length ? assistantBlocks : undefined,
        createdAt: hydratedPayload.assistantCreatedAt || isoNow()
      }
    )
  );

  await Promise.all([
    writeFile(designFile(rootDir, designId), html, "utf8"),
    writeJson(projectFile(rootDir, designId), project),
    writeJson(chatFile(rootDir, designId), chat),
    writeSelectedArtAssetManifest(cwd, hydratedPayload.selectedArtAssets)
  ]);

  const commitMessage =
    mode === "generate"
      ? `init: ${project.title}`
      : `edit: ${compactText(hydratedPayload.instruction, "update render").slice(0, 72)}`;

  const latestCommit = await commitWorkspace(cwd, commitMessage);
  const commits = await buildCommits(rootDir, designId);

  return {
    design: {
      ...decorateProject(project, cwd, runtimeBackend),
      latestCommit
    },
    chat,
    commits
  };
}

export async function syncDesignWorkspace(rootDir, payload) {
  await ensureStudioScaffold(rootDir);
  const hydratedPayload = await hydratePayloadWithAssets(rootDir, payload);
  const designId = hydratedPayload.designId;
  if (!designId) {
    throw new Error("Missing designId for workspace sync.");
  }

  const cwd = designDir(rootDir, designId);
  const project = await readJson(projectFile(rootDir, designId), null);
  if (!project) {
    throw new Error(`Unknown design session: ${designId}`);
  }

  const runtimeBackend = normalizeRuntimeBackend(
    hydratedPayload.runtimeBackend || project.runtimeBackend
  );
  const runtimeLabel = runtimeBackendLabel(runtimeBackend);
  const activeSessionId =
    hydratedPayload.sessionId ||
    activeRuntimeSession(project, runtimeBackend) ||
    null;
  const assistantBlocks = normalizeStoredConversationBlocks(hydratedPayload.assistantBlocks);

  const chat = await readJson(chatFile(rootDir, designId), []);
  const designFilePath = designFile(rootDir, designId);
  let rawHtml = existsSync(designFilePath)
    ? await readFile(designFilePath, "utf8")
    : "";

  const shouldRetrySeedCheck =
    hydratedPayload.mode === "generate" || hydratedPayload.mode === "edit";

  if (shouldRetrySeedCheck && project.workspaceSeedSignature) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const unchanged = rawHtml.trim() && hashText(rawHtml) === project.workspaceSeedSignature;
      if (rawHtml.trim() && !unchanged) {
        break;
      }

      await sleep(180);
      rawHtml = existsSync(designFilePath)
        ? await readFile(designFilePath, "utf8")
        : "";
    }
  }

  if (!rawHtml.trim()) {
    throw new Error(`${runtimeLabel} did not produce ${DESIGN_FILE} in workspace ${cwd}`);
  }

  const seedUnchanged =
    Boolean(project.workspaceSeedSignature) &&
    hashText(rawHtml) === project.workspaceSeedSignature;

  if ((hydratedPayload.mode === "generate" || hydratedPayload.mode === "edit") && seedUnchanged) {
    throw new Error(`${runtimeLabel} did not update ${DESIGN_FILE} in the workspace.`);
  }

  const htmlMeta =
    hydratedPayload.meta ||
    project.currentMeta ||
    buildMetaFromPayload(project);
  const html = sanitizeStoredDesignHtml(rawHtml);
  const now = isoNow();
  const mode = hydratedPayload.mode || "agent";
  const previousConfigSignature = project.configSignature || "";
  const nextConfigSignature =
    hydratedPayload.configSignature ||
    (
      hydratedPayload.styleId
        ? buildConfigSignature({
            ...hydratedPayload,
            designName: project.id
          })
        : previousConfigSignature
    );

  project.updatedAt = now;
  project.lastInstruction = hydratedPayload.instruction || project.lastInstruction || "";
  project.lastMode = mode;
  project.provider = runtimeBackend;
  project.runtimeBackend = runtimeBackend;
  project.currentMeta = htmlMeta;
  project.promptBundle = hydratedPayload.promptBundle || project.promptBundle || null;
  project.warnings = hydratedPayload.warnings || project.warnings || [];
  project.workspaceSeedSignature = null;
  if (hydratedPayload.styleId) {
    project.styleId = hydratedPayload.styleId;
    project.sizeId = hydratedPayload.sizeId;
    project.customSize = hydratedPayload.customSize || project.customSize || null;
    project.fields = hydratedPayload.fields || project.fields || {};
    project.fieldDefinitions = hydratedPayload.fieldDefinitions || project.fieldDefinitions || [];
    project.brief = hydratedPayload.brief || project.brief || "";
    project.directoryName = project.id;
    project.title = project.id;
    project.configSignature = nextConfigSignature;
  }
  if (Array.isArray(hydratedPayload.selectedAssetIds)) {
    project.selectedAssetIds = hydratedPayload.selectedAssetIds;
  }
  if (activeSessionId) {
    setRuntimeSession(project, runtimeBackend, activeSessionId);
  }

  const selectedArtAssets = await resolveArtAssets(rootDir, project.selectedAssetIds || []);

  if (!chat.length || (nextConfigSignature && nextConfigSignature !== previousConfigSignature)) {
    chat.push(
      buildMessage(
        nextMessageId(chat),
        "system",
        "config",
        summarizeConfig({
          designName: project.title,
          styleId: project.styleId,
          sizeId: project.sizeId,
          customSize: project.customSize || null,
          brief: project.brief,
          fields: project.fields,
          fieldDefinitions: project.fieldDefinitions || [],
          selectedArtAssets
        }),
        { promptBundle: project.promptBundle || null }
      )
    );
  }

  if (hydratedPayload.instruction) {
    chat.push(
      buildMessage(nextMessageId(chat), "user", "instruction", hydratedPayload.instruction, {
        sessionId: activeSessionId,
        runtimeBackend,
        createdAt: hydratedPayload.instructionCreatedAt || isoNow()
      })
    );
  }

  // 如果最后一条已是同次操作的 assistant 消息（由 persistDesignResult 先行写入），
  // 则合并 blocks 到该消息，而非追加重复的 assistant 消息。
  const lastChatMsg = chat[chat.length - 1];
  const shouldMergeBlocks =
    assistantBlocks.length &&
    lastChatMsg &&
    lastChatMsg.role === "assistant" &&
    !lastChatMsg.blocks?.length &&
    !hydratedPayload.instruction;

  if (shouldMergeBlocks) {
    lastChatMsg.blocks = assistantBlocks;
    if (hydratedPayload.assistantCreatedAt) {
      lastChatMsg.createdAt = hydratedPayload.assistantCreatedAt;
    }
  } else {
    chat.push(
      buildMessage(
        nextMessageId(chat),
        "assistant",
        mode === "generate" ? "render" : mode === "edit" ? "update" : "agent",
        hydratedPayload.summary ||
          summarizeAgentWorkspaceResult(
            mode === "generate"
              ? "Initial render completed via OpenCode."
              : mode === "edit"
                ? "Render updated successfully via OpenCode."
                : "OpenCode workspace updated."
          ),
        {
          sessionId: activeSessionId,
          runtimeBackend,
          blocks: assistantBlocks.length ? assistantBlocks : undefined,
          createdAt: hydratedPayload.assistantCreatedAt || isoNow()
        }
      )
    );
  }

  await Promise.all([
    writeFile(designFile(rootDir, designId), html, "utf8"),
    writeJson(projectFile(rootDir, designId), project),
    writeJson(chatFile(rootDir, designId), chat),
    writeSelectedArtAssetManifest(cwd, selectedArtAssets)
  ]);

  const latestCommit = await commitWorkspace(
    cwd,
    mode === "generate"
      ? `init: ${project.title}`
      : mode === "edit"
        ? `edit: ${compactText(hydratedPayload.instruction, "update render").slice(0, 72)}`
        : `agent: ${compactText(hydratedPayload.instruction, "workspace update").slice(0, 72)}`
  );
  const commits = await buildCommits(rootDir, designId);

  return {
    design: {
      ...decorateProject(project, cwd, runtimeBackend),
      latestCommit
    },
    html,
    meta: project.currentMeta,
    chat,
    commits,
    warnings: project.warnings || [],
    promptBundle: project.promptBundle || null
  };
}
