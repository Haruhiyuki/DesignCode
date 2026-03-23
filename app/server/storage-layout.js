import { mkdir } from "node:fs/promises";
import path from "node:path";

const LEGACY_STUDIO_DIR = ".designcode-studio";
const DESIGNS_DIR = "designs";
const ASSETS_DIR = "assets";
const EXPORTS_DIR = "exports";
const LOGS_DIR = "logs";
const CACHE_DIR = "cache";
const RUNTIME_DIR = "runtime";
const STUDIO_ROOT_ENV = "DESIGNCODE_STUDIO_ROOT";

function resolveOverrideRoot() {
  const override = String(process.env[STUDIO_ROOT_ENV] || "").trim();
  return override ? path.resolve(override) : "";
}

export function studioRoot(rootDir) {
  const override = resolveOverrideRoot();
  return override || path.join(rootDir, LEGACY_STUDIO_DIR);
}

export function designsRoot(rootDir) {
  return path.join(studioRoot(rootDir), DESIGNS_DIR);
}

export function assetsRoot(rootDir) {
  return path.join(studioRoot(rootDir), ASSETS_DIR);
}

export function exportsRoot(rootDir) {
  return path.join(studioRoot(rootDir), EXPORTS_DIR);
}

export function logsRoot(rootDir) {
  return path.join(studioRoot(rootDir), LOGS_DIR);
}

export function cacheRoot(rootDir) {
  return path.join(studioRoot(rootDir), CACHE_DIR);
}

export function runtimeRoot(rootDir) {
  return path.join(studioRoot(rootDir), RUNTIME_DIR);
}

export async function ensureStudioScaffold(rootDir) {
  const roots = [
    studioRoot(rootDir),
    designsRoot(rootDir),
    assetsRoot(rootDir),
    exportsRoot(rootDir),
    logsRoot(rootDir),
    cacheRoot(rootDir),
    runtimeRoot(rootDir)
  ];

  await Promise.all(roots.map((dir) => mkdir(dir, { recursive: true })));
}

export function studioLayoutSnapshot(rootDir) {
  return {
    root: studioRoot(rootDir),
    designs: designsRoot(rootDir),
    assets: assetsRoot(rootDir),
    exports: exportsRoot(rootDir),
    logs: logsRoot(rootDir),
    cache: cacheRoot(rootDir),
    runtime: runtimeRoot(rootDir)
  };
}

