export function byId(collection = [], id) {
  return collection.find((item) => item.id === id) || collection[0] || null;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeHex(value, fallback = "#000000") {
  const source = value || fallback;
  return /^#[0-9a-f]{6}$/i.test(source) ? source : fallback;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export function cloneSnapshot(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Vue reactive proxies are not cloneable via structuredClone.
    }
  }

  return JSON.parse(JSON.stringify(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeMeta(meta) {
  if (!meta) {
    return null;
  }

  return {
    ...meta,
    fields: { ...(meta.fields || {}) },
    fieldDefinitions: Array.isArray(meta.fieldDefinitions) ? [...meta.fieldDefinitions] : [],
    customSize: meta.customSize ? { ...meta.customSize } : null,
    overrides: { ...(meta.overrides || {}) }
  };
}

export function readCssVariable(html, variableName) {
  const match = String(html || "").match(new RegExp(`${escapeRegExp(variableName)}:\\s*([^;]+);`));
  return match ? match[1].trim() : "";
}

export function patchCssVariable(html, variableName, value) {
  return String(html || "").replace(
    new RegExp(`${escapeRegExp(variableName)}:\\s*[^;]+;`),
    `${variableName}: ${value};`
  );
}

export function layerEntriesFromHtml(html) {
  if (!html) {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("[data-layer]")].slice(0, 18).map((layer, index) => ({
    id: `${index}-${layer.getAttribute("data-layer") || "Layer"}`,
    name: layer.getAttribute("data-layer") || "Layer",
    text: (layer.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) || "Decorative layer"
  }));
}

function normalizeEditableText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function selectorPathForElement(element) {
  const parts = [];
  let current = element;

  while (current?.tagName && current.tagName.toLowerCase() !== "body") {
    const tagName = current.tagName.toLowerCase();
    let index = 1;
    let sibling = current.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === current.tagName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }

    parts.unshift(`${tagName}:nth-of-type(${index})`);
    current = current.parentElement;
  }

  return parts.length ? `body > ${parts.join(" > ")}` : "";
}

function normalizeEditableFieldId(value) {
  const fieldId = String(value || "").trim();
  if (!fieldId) {
    return "";
  }

  const normalized = fieldId.toLowerCase();
  if (["true", "1", "yes", "editable"].includes(normalized)) {
    return "";
  }

  return fieldId;
}

function inferEditableLabel(element, index, source = "editable") {
  const explicit =
    normalizeEditableFieldId(element.getAttribute("data-editable")) ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("data-layer");

  if (explicit) {
    return explicit;
  }

  const tagName = element.tagName?.toLowerCase() || "text";
  const humanTag =
    tagName === "h1" || tagName === "h2" || tagName === "h3" || tagName === "h4" || tagName === "h5" || tagName === "h6"
      ? `标题 ${tagName.toUpperCase()}`
      : tagName === "p"
        ? "正文"
        : tagName === "button"
          ? "按钮"
          : tagName === "a"
            ? "链接"
            : tagName === "li"
              ? "列表项"
              : tagName === "figcaption"
                ? "图注"
                : `文本 ${index + 1}`;

  return source === "fallback" ? `${humanTag} ${index + 1}` : humanTag;
}

function isFallbackEditableElement(element) {
  const tagName = element.tagName?.toLowerCase() || "";
  if (!tagName) {
    return false;
  }

  if (
    [
      "script",
      "style",
      "noscript",
      "template",
      "svg",
      "path",
      "g",
      "defs",
      "clipPath",
      "mask"
    ].includes(tagName)
  ) {
    return false;
  }

  if (element.hasAttribute("data-editable")) {
    return false;
  }

  if (element.children.length) {
    return false;
  }

  return Boolean(normalizeEditableText(element.textContent || ""));
}

function serializeHtmlDocument(doc, originalHtml = "") {
  const hasDoctype = /^\s*<!doctype/i.test(String(originalHtml || ""));
  return `${hasDoctype ? "<!DOCTYPE html>\n" : ""}${doc.documentElement.outerHTML}`;
}

export function editableTextEntriesFromHtml(html) {
  if (!html) {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const explicit = [...doc.querySelectorAll("[data-editable]")];
  const source = explicit.length ? "editable" : "fallback";
  const elements = explicit.length
    ? explicit
    : [...doc.body.querySelectorAll("*")]
      .filter(isFallbackEditableElement)
      .slice(0, 80);

  return elements.map((element, index) => {
    const path = selectorPathForElement(element);
    const fieldId = normalizeEditableFieldId(element.getAttribute("data-editable"));
    const value = normalizeEditableText(element.textContent || "");
    const tagName = element.tagName?.toLowerCase() || "div";
    const stableTargetId = path || `${tagName}-${index}`;

    return {
      id: `${source}:${fieldId || tagName}:${stableTargetId}`,
      path,
      fieldId,
      label: inferEditableLabel(element, index, source),
      tagName,
      source,
      value,
      preview: value.length > 120 ? `${value.slice(0, 117)}...` : value
    };
  });
}

export function patchEditableTextInHtml(html, entry, value) {
  if (!html || !entry?.path) {
    return html;
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const target = doc.querySelector(entry.path);
  if (!target) {
    return html;
  }

  applyEditableTextValue(target, value);
  return serializeHtmlDocument(doc, html);
}

// 把新文本写回目标元素时，尽量保留它内部的结构性子元素（如 <br>、<span>）。
// 先把每个文本节点拆成 [leading, core, trailing]，仅在 core 组成的“可见串”
// 里做前缀/后缀 diff，再把新文字塞进对应节点的 core——这样 HTML 源码里的
// 格式化空白不会影响 diff，span 内的文字也不会被吞掉。
export function applyEditableTextValue(target, value) {
  const next = String(value ?? "");
  if (!target) {
    return;
  }

  const textNodes = collectTextNodes(target);
  if (!textNodes.length || !target.children.length) {
    target.textContent = next;
    return;
  }

  const segments = textNodes.map((node) => {
    const raw = node.nodeValue || "";
    const leading = (raw.match(/^\s*/) || [""])[0];
    const remaining = raw.slice(leading.length);
    const trailing = (remaining.match(/\s*$/) || [""])[0];
    const core = trailing.length ? remaining.slice(0, remaining.length - trailing.length) : remaining;
    return { node, leading, core, trailing };
  });

  const original = segments.map((segment) => segment.core).join("");
  if (original === next) {
    return;
  }

  const origLen = original.length;
  const nextLen = next.length;

  let prefixLen = 0;
  const maxPrefix = Math.min(origLen, nextLen);
  while (prefixLen < maxPrefix && original.charAt(prefixLen) === next.charAt(prefixLen)) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(origLen - prefixLen, nextLen - prefixLen);
  while (
    suffixLen < maxSuffix
    && original.charAt(origLen - 1 - suffixLen) === next.charAt(nextLen - 1 - suffixLen)
  ) {
    suffixLen += 1;
  }

  const changeStart = prefixLen;
  const changeEnd = origLen - suffixLen;
  const insertion = next.slice(prefixLen, nextLen - suffixLen);

  let offset = 0;
  let placed = false;
  for (const segment of segments) {
    const len = segment.core.length;
    const segStart = offset;
    const segEnd = offset + len;
    offset = segEnd;

    if (segEnd < changeStart || segStart > changeEnd) {
      continue;
    }

    const localStart = Math.max(0, changeStart - segStart);
    const localEnd = Math.min(len, changeEnd - segStart);
    const before = segment.core.slice(0, localStart);
    const after = segment.core.slice(localEnd);

    if (!placed) {
      segment.core = before + insertion + after;
      placed = true;
    } else {
      segment.core = before + after;
    }
  }

  if (!placed && insertion) {
    let fallback = null;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].core) {
        fallback = segments[i];
        break;
      }
    }
    if (!fallback) {
      fallback = segments[segments.length - 1];
    }
    fallback.core += insertion;
  }

  for (const segment of segments) {
    segment.node.nodeValue = segment.leading + segment.core + segment.trailing;
  }
}

function collectTextNodes(root) {
  const doc = root.ownerDocument;
  if (!doc) {
    return [];
  }

  const nodes = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function normalizeAssetPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function relativePathBetween(fromDir, targetPath) {
  const from = normalizeAssetPath(fromDir).split("/").filter(Boolean);
  const target = normalizeAssetPath(targetPath).split("/").filter(Boolean);

  if (!from.length || !target.length) {
    return "";
  }

  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) {
    common += 1;
  }

  const up = new Array(Math.max(from.length - common, 0)).fill("..");
  const down = target.slice(common);
  return [...up, ...down].join("/");
}

function assetPathCandidates(asset, workspaceDir = "") {
  const absolutePath = normalizeAssetPath(asset.absolutePath || "");
  const relativePath = normalizeAssetPath(asset.relativePath || "");
  const fileName = normalizeAssetPath(asset.fileName || "");
  const workspaceRelative = workspaceDir && absolutePath
    ? relativePathBetween(workspaceDir, absolutePath)
    : "";
  const manifestRelative = relativePath.startsWith(".")
    ? relativePath.replace(/^\.\//, "")
    : relativePath;
  const suffixes = [
    absolutePath,
    relativePath,
    manifestRelative,
    workspaceRelative,
    fileName && asset.id ? `${asset.id}/${fileName}` : "",
    fileName && asset.id ? `/assets/files/${asset.id}/${fileName}` : "",
    fileName && asset.id ? `assets/files/${asset.id}/${fileName}` : "",
    fileName && asset.id ? `.designcode-studio/assets/files/${asset.id}/${fileName}` : "",
    fileName && asset.id ? `/.designcode-studio/assets/files/${asset.id}/${fileName}` : ""
  ].filter(Boolean);

  return [...new Set(suffixes)];
}

export function materializeArtAssetUrls(html, assets = [], previewUrls = {}, workspaceDir = "") {
  let output = String(html || "");
  if (!output || !Array.isArray(assets) || !assets.length) {
    return output;
  }

  assets.forEach((asset) => {
    const previewUrl = previewUrls?.[asset.id];
    if (!previewUrl) {
      return;
    }

    assetPathCandidates(asset, workspaceDir).forEach((candidate) => {
      if (!candidate) {
        return;
      }
      output = output.split(candidate).join(previewUrl);
    });
  });

  return output;
}

export function extractDesignSize(html) {
  if (!html) {
    return null;
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.documentElement;
  const width = Number(root?.getAttribute("data-design-width") || 0);
  const height = Number(root?.getAttribute("data-design-height") || 0);

  if (width > 0 && height > 0) {
    return {
      width,
      height
    };
  }

  return null;
}

export function formatClock(value = new Date()) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function inferAgentText(payload) {
  if (!payload) {
    return "";
  }

  if (Array.isArray(payload)) {
    return payload.map(inferAgentText).filter(Boolean).join("\n\n");
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    return payload.parts
      .map((part) => part.text || part.content || JSON.stringify(part))
      .join("\n");
  }

  if (payload.messages && Array.isArray(payload.messages)) {
    return payload.messages.map(inferAgentText).filter(Boolean).join("\n\n");
  }

  if (payload.items && Array.isArray(payload.items)) {
    return payload.items.map(inferAgentText).filter(Boolean).join("\n\n");
  }

  return JSON.stringify(payload, null, 2);
}
