import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assetsRoot as studioAssetsRoot,
  ensureStudioScaffold
} from "./storage-layout.js";

const FILES_DIR = "files";
const LIBRARY_FILE = "library.json";
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
const MIME_TYPES_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};

function isoNow() {
  return new Date().toISOString();
}

function compactText(value, fallback = "") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function slugify(value, fallback = "asset") {
  const slug = compactText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = (slug || fallback).replace(/[. ]+$/g, "") || fallback;
  return WINDOWS_RESERVED_NAMES.has(safe) ? `${safe}-asset` : safe;
}

function sanitizeFileName(fileName) {
  const ext = path.extname(fileName || "").slice(0, 12);
  const base = path.basename(fileName || "asset", ext);
  const safeBase = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  const normalizedBase = (safeBase || "asset").replace(/[. ]+$/g, "") || "asset";
  const finalBase = WINDOWS_RESERVED_NAMES.has(normalizedBase.toLowerCase())
    ? `${normalizedBase}-file`
    : normalizedBase;
  return `${finalBase}${ext}`;
}

function assetsRoot(rootDir) {
  return studioAssetsRoot(rootDir);
}

function assetFilesRoot(rootDir) {
  return path.join(assetsRoot(rootDir), FILES_DIR);
}

function assetLibraryFile(rootDir) {
  return path.join(assetsRoot(rootDir), LIBRARY_FILE);
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function ensureAssetStore(rootDir) {
  await ensureStudioScaffold(rootDir);
  await ensureDir(assetFilesRoot(rootDir));
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

function normalizeRecord(rootDir, record) {
  if (!record) {
    return null;
  }

  const absolutePath =
    record.absolutePath ||
    path.join(assetFilesRoot(rootDir), record.id, record.fileName);

  return {
    id: record.id,
    name: record.name,
    fileName: record.fileName,
    mimeType: record.mimeType || "application/octet-stream",
    note: compactText(record.note),
    importedAt: record.importedAt || isoNow(),
    updatedAt: record.updatedAt || record.importedAt || isoNow(),
    size: Number(record.size || 0),
    absolutePath,
    relativePath: path.relative(rootDir, absolutePath)
  };
}

async function loadLibrary(rootDir) {
  await ensureAssetStore(rootDir);
  const payload = await readJson(assetLibraryFile(rootDir), { items: [] });
  const items = Array.isArray(payload.items) ? payload.items : [];

  return items
    .map((item) => normalizeRecord(rootDir, item))
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function saveLibrary(rootDir, items) {
  await ensureAssetStore(rootDir);
  await writeJson(assetLibraryFile(rootDir), {
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      fileName: item.fileName,
      mimeType: item.mimeType,
      note: item.note || "",
      importedAt: item.importedAt,
      updatedAt: item.updatedAt,
      size: item.size || 0
    }))
  });
}

function mimeTypeFromFileName(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[extension] || "application/octet-stream";
}

async function importArtAssetBuffer(rootDir, payload, buffer) {
  await ensureAssetStore(rootDir);

  const originalName = sanitizeFileName(payload.name || "asset");
  const assetId = `${slugify(originalName, "asset")}-${Date.now().toString(36)}`;
  const assetDir = path.join(assetFilesRoot(rootDir), assetId);
  const absolutePath = path.join(assetDir, originalName);
  const now = isoNow();

  if (!buffer?.length) {
    throw new Error("Missing asset file content.");
  }

  await ensureDir(assetDir);
  await writeFile(absolutePath, buffer);

  const size = (await stat(absolutePath)).size;
  const library = await loadLibrary(rootDir);
  const record = normalizeRecord(rootDir, {
    id: assetId,
    name: compactText(payload.displayName || path.parse(originalName).name, path.parse(originalName).name),
    fileName: originalName,
    mimeType: payload.mimeType || mimeTypeFromFileName(originalName),
    note: compactText(payload.note),
    importedAt: now,
    updatedAt: now,
    size,
    absolutePath
  });

  library.unshift(record);
  await saveLibrary(rootDir, library);
  return record;
}

export async function listArtAssets(rootDir) {
  return loadLibrary(rootDir);
}

export async function importArtAsset(rootDir, payload) {
  const buffer = Buffer.from(String(payload.contentBase64 || ""), "base64");
  return importArtAssetBuffer(rootDir, payload, buffer);
}

export async function importArtAssetsFromPaths(rootDir, payload) {
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  const note = compactText(payload?.note);
  const imported = [];

  for (const filePath of paths) {
    const absoluteSourcePath = path.resolve(String(filePath || ""));
    if (!absoluteSourcePath) {
      continue;
    }

    const sourceStat = await stat(absoluteSourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      continue;
    }

    const fileName = path.basename(absoluteSourcePath);
    const displayName = fileName.replace(/\.[^.]+$/, "");
    const buffer = await readFile(absoluteSourcePath);
    const record = await importArtAssetBuffer(
      rootDir,
      {
        name: fileName,
        displayName,
        mimeType: mimeTypeFromFileName(fileName),
        note
      },
      buffer
    );
    imported.push(record);
  }

  return imported;
}

export async function updateArtAsset(rootDir, payload) {
  const assetId = compactText(payload.assetId);
  if (!assetId) {
    throw new Error("Missing assetId.");
  }

  const library = await loadLibrary(rootDir);
  const index = library.findIndex((item) => item.id === assetId);
  if (index < 0) {
    throw new Error(`Unknown art asset: ${assetId}`);
  }

  const current = library[index];
  library[index] = normalizeRecord(rootDir, {
    ...current,
    name: compactText(payload.name, current.name),
    note: compactText(payload.note, current.note),
    updatedAt: isoNow(),
    absolutePath: current.absolutePath
  });
  await saveLibrary(rootDir, library);
  return library[index];
}

export async function deleteArtAsset(rootDir, payload) {
  const assetId = compactText(payload.assetId);
  if (!assetId) {
    throw new Error("Missing assetId.");
  }

  const library = await loadLibrary(rootDir);
  const index = library.findIndex((item) => item.id === assetId);
  if (index < 0) {
    throw new Error(`Unknown art asset: ${assetId}`);
  }

  const [removed] = library.splice(index, 1);
  await saveLibrary(rootDir, library);
  await rm(path.join(assetFilesRoot(rootDir), assetId), { recursive: true, force: true });
  return removed;
}

export async function readArtAssetPreview(rootDir, payload) {
  const assetId = compactText(payload.assetId);
  if (!assetId) {
    throw new Error("Missing assetId.");
  }

  const library = await loadLibrary(rootDir);
  const asset = library.find((item) => item.id === assetId);
  if (!asset) {
    throw new Error(`Unknown art asset: ${assetId}`);
  }

  const mimeType = asset.mimeType || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    return {
      assetId,
      mimeType,
      dataUrl: null
    };
  }

  const buffer = await readFile(asset.absolutePath);
  return {
    assetId,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
  };
}

export async function resolveArtAssets(rootDir, selectedIds = []) {
  if (!Array.isArray(selectedIds) || !selectedIds.length) {
    return [];
  }

  const wanted = new Set(selectedIds.map((item) => String(item)));
  const library = await loadLibrary(rootDir);
  return library.filter((item) => wanted.has(item.id));
}

export async function writeSelectedArtAssetManifest(workspaceDir, assets) {
  const manifestPath = path.join(workspaceDir, "art-assets.json");
  const payload = {
    generatedAt: isoNow(),
    items: (assets || []).map((item) => ({
      id: item.id,
      name: item.name,
      fileName: item.fileName,
      mimeType: item.mimeType,
      note: item.note,
      absolutePath: item.absolutePath,
      relativePath: item.relativePath,
      size: item.size
    }))
  };
  await writeJson(manifestPath, payload);
  return manifestPath;
}
