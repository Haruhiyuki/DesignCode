import { toCanvas as renderNodeToCanvas } from "html-to-image";
import { writePsd } from "ag-psd";

const MAX_LAYER_CANDIDATES = 320;
const TEXT_PARENT_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
const SVG_NON_RENDER_TAGS = new Set([
  "defs",
  "desc",
  "title",
  "metadata",
  "clipPath",
  "mask",
  "filter",
  "linearGradient",
  "radialGradient",
  "pattern",
  "marker",
  "symbol"
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstClassToken(element) {
  const className = String(element?.getAttribute?.("class") || "").trim();
  if (!className) {
    return "";
  }
  return className.split(/\s+/).find(Boolean) || "";
}

function isTextBearingElement(element) {
  const tagName = (element?.tagName || "").toLowerCase();
  if (element?.hasAttribute?.("data-psd-export-text")) {
    return true;
  }
  return ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "a", "small", "strong", "em", "b", "i", "button"].includes(tagName);
}

function sanitizeFileName(name) {
  return String(name || "designcode-export")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "designcode-export";
}

function visibleRectForElement(element) {
  if (!element?.getBoundingClientRect) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }

  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (!style) {
    return rect;
  }

  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0) {
    return null;
  }

  return rect;
}

function layerNameForElement(element, index) {
  const tagName = (element?.tagName || "").toLowerCase();
  const normalizedText = normalizeText(element?.textContent || "");
  const classToken = firstClassToken(element);
  const id = String(element?.getAttribute?.("id") || "").trim();
  const isTextLike = isTextBearingElement(element) || element?.children?.length === 0;

  return (
    element.getAttribute("data-layer") ||
    element.getAttribute("data-editable") ||
    (isTextLike ? element.getAttribute("aria-label") : "") ||
    (isTextLike ? element.getAttribute("title") : "") ||
    id ||
    classToken ||
    (!isTextLike ? element.getAttribute("aria-label") : "") ||
    (!isTextLike ? element.getAttribute("title") : "") ||
    (isTextLike ? normalizedText.slice(0, 40) : "") ||
    (tagName ? `${tagName}-${index + 1}` : "") ||
    `${element.tagName?.toLowerCase() || "layer"}-${index + 1}`
  );
}

function isMediaElement(element) {
  return element?.matches?.("img, svg, canvas, picture, video") || false;
}

function hasVisualBox(element) {
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (!style) {
    return false;
  }

  const backgroundColor = style.backgroundColor || "";
  const hasBackgroundColor = backgroundColor !== "rgba(0, 0, 0, 0)" && backgroundColor !== "transparent";
  const hasBackgroundImage = style.backgroundImage && style.backgroundImage !== "none";
  const hasBorder =
    ["Top", "Right", "Bottom", "Left"].some((side) => {
      const width = Number.parseFloat(style[`border${side}Width`] || "0");
      const color = style[`border${side}Color`] || "";
      return width > 0 && color !== "rgba(0, 0, 0, 0)" && color !== "transparent";
    });
  const hasOutline =
    Number.parseFloat(style.outlineWidth || "0") > 0 &&
    style.outlineStyle !== "none" &&
    style.outlineColor !== "rgba(0, 0, 0, 0)";
  const hasShadow = style.boxShadow && style.boxShadow !== "none";
  const hasEffects =
    (style.filter && style.filter !== "none") ||
    (style.backdropFilter && style.backdropFilter !== "none") ||
    (style.mixBlendMode && style.mixBlendMode !== "normal") ||
    (style.clipPath && style.clipPath !== "none") ||
    (style.maskImage && style.maskImage !== "none");

  return Boolean(hasBackgroundColor || hasBackgroundImage || hasBorder || hasOutline || hasShadow || hasEffects);
}

function getVisualProfile(element, pseudo) {
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element, pseudo);
  if (!style) {
    return {
      hasBackgroundColor: false,
      hasBackgroundImage: false,
      hasBorder: false,
      borderSides: 0,
      hasOutline: false,
      hasShadow: false,
      hasEffects: false,
      hasVisualContent: false
    };
  }

  const backgroundColor = style.backgroundColor || "";
  const hasBackgroundColor = backgroundColor !== "rgba(0, 0, 0, 0)" && backgroundColor !== "transparent";
  const hasBackgroundImage = Boolean(style.backgroundImage && style.backgroundImage !== "none");
  const borderSides = ["Top", "Right", "Bottom", "Left"].reduce((count, side) => {
    const width = Number.parseFloat(style[`border${side}Width`] || "0");
    const color = style[`border${side}Color`] || "";
    if (width > 0 && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
      return count + 1;
    }
    return count;
  }, 0);
  const hasOutline =
    Number.parseFloat(style.outlineWidth || "0") > 0 &&
    style.outlineStyle !== "none" &&
    style.outlineColor !== "rgba(0, 0, 0, 0)";
  const hasShadow = Boolean(style.boxShadow && style.boxShadow !== "none");
  const hasEffects = Boolean(
    (style.filter && style.filter !== "none") ||
    (style.backdropFilter && style.backdropFilter !== "none") ||
    (style.mixBlendMode && style.mixBlendMode !== "normal") ||
    (style.clipPath && style.clipPath !== "none") ||
    (style.maskImage && style.maskImage !== "none")
  );

  return {
    hasBackgroundColor,
    hasBackgroundImage,
    hasBorder: borderSides > 0,
    borderSides,
    hasOutline,
    hasShadow,
    hasEffects,
    hasVisualContent: Boolean(hasBackgroundColor || hasBackgroundImage || borderSides > 0 || hasOutline || hasShadow || hasEffects)
  };
}

function hasPseudoVisuals(element) {
  return ["::before", "::after"].some((pseudo) => {
    const content = String(element.ownerDocument?.defaultView?.getComputedStyle?.(element, pseudo)?.content || "").trim();
    if (content === "none" || content === "normal") {
      return false;
    }
    return getVisualProfile(element, pseudo).hasVisualContent;
  });
}

function hasDirectTextNode(element) {
  return [...(element?.childNodes || [])].some((node) => node.nodeType === Node.TEXT_NODE && normalizeText(node.nodeValue || ""));
}

function shouldCaptureTextContainerAsSubtree(element) {
  if (!element || !hasDirectTextNode(element)) {
    return false;
  }

  const profile = getVisualProfile(element);
  const display = String(element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.display || "");

  return Boolean(
    hasPseudoVisuals(element) ||
    profile.hasBorder ||
    profile.hasOutline ||
    profile.hasShadow ||
    display.includes("flex") ||
    firstClassToken(element) === "route-foot" ||
    firstClassToken(element) === "footer"
  );
}

function isRedundantTextContainer(element) {
  const profile = getVisualProfile(element);
  if (!profile.hasVisualContent || profile.hasBackgroundColor || profile.hasBackgroundImage || profile.hasShadow || profile.hasOutline || profile.hasEffects) {
    return false;
  }

  const text = normalizeText(element.textContent || "");
  if (!text || text.length < 12) {
    return false;
  }

  const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && normalizeText(node.nodeValue || ""));
  const hasTextBlocks = Boolean(
    element.querySelector("p, h1, h2, h3, h4, h5, h6, li, [data-editable], .index, .route-label, .route-value, .panel-title, .panel-code")
  );

  return profile.borderSides > 0 && (ownText || hasTextBlocks);
}

function shouldCaptureDataLayerContainer(element) {
  const layerName = String(element.getAttribute("data-layer") || "").toLowerCase();
  if (!layerName || layerName === "background") {
    return false;
  }
  return hasPseudoVisuals(element);
}

function isTextLikeElement(element) {
  const tagName = (element.tagName || "").toLowerCase();
  return element.hasAttribute("data-editable") || ["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "a", "small", "strong", "em", "b", "i"].includes(tagName);
}

function shouldSkipTextLikeBoxLayer(element) {
  if (!isTextLikeElement(element)) {
    return false;
  }

  const profile = getVisualProfile(element);
  return !profile.hasBackgroundColor && !profile.hasBackgroundImage && !profile.hasShadow && !profile.hasEffects;
}

function isRedundantCompositeContainer(element) {
  const doc = element.ownerDocument;
  const bodyRect = visibleRectForElement(doc.body);
  const rect = visibleRectForElement(element);
  if (!bodyRect || !rect) {
    return false;
  }

  const profile = getVisualProfile(element);
  if (!profile.hasBackgroundImage && !profile.hasBackgroundColor) {
    return false;
  }
  if (profile.hasBorder || profile.hasOutline || profile.hasShadow || profile.hasEffects) {
    return false;
  }
  if (hasPseudoVisuals(element)) {
    return false;
  }

  const coversMostCanvas = rect.width >= bodyRect.width * 0.85 && rect.height >= bodyRect.height * 0.85;
  if (!coversMostCanvas) {
    return false;
  }

  const hasMediaDescendants = Boolean(element.querySelector("img, svg, canvas, picture, video"));
  const richTextDescendants = element.querySelectorAll("[data-editable], p, h1, h2, h3, h4, h5, h6, li, .index, .route-label, .route-value").length;
  return hasMediaDescendants && richTextDescendants >= 4;
}

function shouldGroupSvgAsSingleLayer(rootSvg, fragments) {
  if (!rootSvg || !fragments.length || rootSvg.getAttribute("aria-hidden") !== "true") {
    return false;
  }
  if (rootSvg.querySelector("text, tspan, foreignObject, image, use")) {
    return false;
  }

  const allowed = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
  return fragments.length > 1 && fragments.length <= 24 && fragments.every((fragment) => allowed.has((fragment.tagName || "").toLowerCase()));
}

function wrapTextNodes(doc) {
  const wrappers = [];
  const candidates = [];
  const textNodes = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      if (shouldCaptureTextContainerAsSubtree(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.namespaceURI === "http://www.w3.org/2000/svg" || parent.closest?.("svg")) {
        return NodeFilter.FILTER_REJECT;
      }
      const tagName = (parent.tagName || "").toLowerCase();
      if (TEXT_PARENT_TAGS.has(tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!normalizeText(node.nodeValue || "")) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!visibleRectForElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }

  textNodes.forEach((textNode, index) => {
    if (!textNode?.parentNode) {
      return;
    }
    const wrapper = doc.createElement("span");
    wrapper.setAttribute("data-psd-export-text", `text-${index + 1}`);
    wrapper.style.whiteSpace = "pre-wrap";
    wrapper.style.display = "inline";
    wrapper.style.margin = "0";
    wrapper.style.padding = "0";
    wrapper.style.border = "0";
    textNode.parentNode.insertBefore(wrapper, textNode);
    wrapper.append(textNode);
    wrappers.push(wrapper);
    if (candidates.length < MAX_LAYER_CANDIDATES) {
      candidates.push({
        id: `text-${index + 1}`,
        name: normalizeText(wrapper.textContent || "").slice(0, 48) || `text-${index + 1}`,
        element: wrapper,
        mode: "subtree"
      });
    }
  });

  return {
    candidates,
    cleanup() {
      wrappers.forEach((wrapper) => {
        if (!wrapper.parentNode) {
          return;
        }
        while (wrapper.firstChild) {
          wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
        }
        wrapper.remove();
      });
    }
  };
}

function collectSvgFragmentCandidates(doc) {
  const candidates = [];
  let index = 0;

  for (const rootSvg of [...doc.body.querySelectorAll("svg")]) {
    if (candidates.length >= MAX_LAYER_CANDIDATES) {
      break;
    }
    if (!visibleRectForElement(rootSvg)) {
      continue;
    }

    const fragments = [...rootSvg.querySelectorAll("*")].filter((child) => {
      const tagName = (child.tagName || "").toLowerCase();
      if (SVG_NON_RENDER_TAGS.has(tagName)) {
        return false;
      }
      if (tagName === "svg" || tagName === "g") {
        return false;
      }
      return Boolean(visibleRectForElement(child));
    });

    if (shouldGroupSvgAsSingleLayer(rootSvg, fragments)) {
      candidates.push({
        id: `svg-${index + 1}`,
        name: layerNameForElement(rootSvg, index),
        element: rootSvg,
        mode: "svg-root"
      });
      index += 1;
      continue;
    }

    for (const fragment of fragments) {
      if (candidates.length >= MAX_LAYER_CANDIDATES) {
        break;
      }
      candidates.push({
        id: `svg-${index + 1}`,
        name: layerNameForElement(fragment, index),
        element: fragment,
        mode: "svg-fragment"
      });
      index += 1;
    }
  }

  return candidates;
}

function collectElementCandidates(doc) {
  const candidates = [];
  let index = 0;

  for (const element of [...doc.body.querySelectorAll("*")]) {
    if (candidates.length >= MAX_LAYER_CANDIDATES) {
      break;
    }
    if (!visibleRectForElement(element)) {
      continue;
    }
    if (element.hasAttribute("data-psd-export-text")) {
      continue;
    }

    const tagName = (element.tagName || "").toLowerCase();
    if (TEXT_PARENT_TAGS.has(tagName)) {
      continue;
    }
    if (element.closest("svg")) {
      continue;
    }
    if (String(element.getAttribute("data-layer") || "").toLowerCase() === "background") {
      continue;
    }
    if (shouldCaptureTextContainerAsSubtree(element)) {
      candidates.push({
        id: `element-${index + 1}`,
        name: layerNameForElement(element, index),
        element,
        mode: "subtree"
      });
      index += 1;
      continue;
    }

    if (shouldSkipTextLikeBoxLayer(element)) {
      continue;
    }
    if (isRedundantCompositeContainer(element)) {
      continue;
    }

    if (isRedundantTextContainer(element)) {
      continue;
    }

    if (isMediaElement(element)) {
      candidates.push({
        id: `element-${index + 1}`,
        name: layerNameForElement(element, index),
        element,
        mode: "subtree"
      });
      index += 1;
      continue;
    }

    if (hasVisualBox(element) || hasPseudoVisuals(element) || shouldCaptureDataLayerContainer(element)) {
      candidates.push({
        id: `element-${index + 1}`,
        name: layerNameForElement(element, index),
        element,
        mode: "box"
      });
      index += 1;
    }
  }

  return candidates;
}

function prepareLayerCandidates(doc) {
  const textLayers = wrapTextNodes(doc);
  const svgLayers = collectSvgFragmentCandidates(doc);
  const elementLayers = collectElementCandidates(doc);
  const merged = [...textLayers.candidates];
  const seen = new Set(merged.map((candidate) => candidate.element));

  for (const candidate of [...svgLayers, ...elementLayers]) {
    if (merged.length >= MAX_LAYER_CANDIDATES) {
      break;
    }
    if (seen.has(candidate.element)) {
      continue;
    }
    merged.push(candidate);
    seen.add(candidate.element);
  }

  return {
    candidates: merged,
    cleanup: textLayers.cleanup
  };
}

function parseZIndex(style) {
  const raw = String(style?.zIndex || "auto");
  if (raw === "auto") {
    return { value: 0, explicit: false };
  }
  const value = Number.parseInt(raw, 10);
  return { value: Number.isFinite(value) ? value : 0, explicit: true };
}

function createsStackingContext(element, style) {
  if (!element || !style) {
    return false;
  }

  if (element === element.ownerDocument?.documentElement) {
    return true;
  }

  const position = style.position || "static";
  const { explicit: hasExplicitZIndex } = parseZIndex(style);
  const opacity = Number.parseFloat(style.opacity || "1");
  const contain = String(style.contain || "");
  const willChange = String(style.willChange || "");

  if ((position === "absolute" || position === "relative") && hasExplicitZIndex) {
    return true;
  }
  if (position === "fixed" || position === "sticky") {
    return true;
  }
  if (opacity < 1) {
    return true;
  }
  if (style.transform && style.transform !== "none") {
    return true;
  }
  if (style.perspective && style.perspective !== "none") {
    return true;
  }
  if (style.filter && style.filter !== "none") {
    return true;
  }
  if (style.backdropFilter && style.backdropFilter !== "none") {
    return true;
  }
  if (style.mixBlendMode && style.mixBlendMode !== "normal") {
    return true;
  }
  if (style.isolation === "isolate") {
    return true;
  }
  if (style.clipPath && style.clipPath !== "none") {
    return true;
  }
  if (style.maskImage && style.maskImage !== "none") {
    return true;
  }
  if (contain.includes("paint") || contain.includes("layout") || contain === "strict" || contain === "content") {
    return true;
  }
  if (/(transform|opacity|filter|perspective|clip-path|mask|contents)/.test(willChange)) {
    return true;
  }

  return false;
}

function isInlineLikeDisplay(display = "") {
  return /^(inline|inline-block|inline-flex|inline-grid|inline-table|ruby|contents)/.test(display);
}

function computePaintPhase(meta) {
  if (meta.positioned || meta.createsContext) {
    if (meta.zIndex < 0) return 1;
    if (meta.zIndex > 0) return 6;
    return 5;
  }
  if (meta.floatValue !== "none") return 3;
  if (meta.inlineLike) return 4;
  return 2;
}

function buildPaintMetadata(doc) {
  const root = doc.documentElement;
  const elements = [root, ...doc.body.querySelectorAll("*")];
  const metadata = new Map();

  elements.forEach((element, index) => {
    const style = doc.defaultView?.getComputedStyle?.(element);
    const zIndex = parseZIndex(style);
    metadata.set(element, {
      element,
      domOrder: index,
      style,
      positioned: Boolean(style && style.position && style.position !== "static"),
      zIndex: zIndex.value,
      createsContext: createsStackingContext(element, style),
      inlineLike: isInlineLikeDisplay(style?.display || ""),
      floatValue: style?.float || "none"
    });
  });

  const findParentContext = (element) => {
    let current = element.parentElement;
    while (current) {
      const meta = metadata.get(current);
      if (meta?.createsContext || current === root) {
        return current;
      }
      current = current.parentElement;
    }
    return root;
  };

  metadata.forEach((meta, element) => {
    meta.contextParent = element === root ? null : findParentContext(element);
    meta.paintPhase = computePaintPhase(meta);
  });

  return metadata;
}

function buildPaintPath(candidate, metadata) {
  const path = [];
  let current = candidate.element;
  const root = candidate.element.ownerDocument?.documentElement;

  while (current && current !== root) {
    const meta = metadata.get(current);
    if (!meta) break;
    path.unshift({
      phase: meta.paintPhase,
      zIndex: meta.zIndex,
      domOrder: meta.domOrder
    });
    current = meta.contextParent;
  }

  return path;
}

function comparePaintPath(left, right) {
  const leftPath = left.paintPath || [];
  const rightPath = right.paintPath || [];
  const length = Math.min(leftPath.length, rightPath.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPath[index];
    const rightPart = rightPath[index];

    if (leftPart.phase !== rightPart.phase) {
      return leftPart.phase - rightPart.phase;
    }

    if (leftPart.phase === 1 || leftPart.phase === 5 || leftPart.phase === 6) {
      if (leftPart.zIndex !== rightPart.zIndex) {
        return leftPart.zIndex - rightPart.zIndex;
      }
    }

    if (leftPart.domOrder !== rightPart.domOrder) {
      return leftPart.domOrder - rightPart.domOrder;
    }
  }

  if (leftPath.length !== rightPath.length) {
    return leftPath.length - rightPath.length;
  }

  return (left.domOrder || 0) - (right.domOrder || 0);
}

function samplePointsForRect(rect, width, height) {
  const insetX = Math.min(Math.max(rect.width * 0.18, 2), rect.width / 2);
  const insetY = Math.min(Math.max(rect.height * 0.18, 2), rect.height / 2);
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + insetX, rect.top + insetY],
    [rect.right - insetX, rect.top + insetY],
    [rect.left + insetX, rect.bottom - insetY],
    [rect.right - insetX, rect.bottom - insetY],
    [rect.left + rect.width / 2, rect.top + insetY],
    [rect.left + rect.width / 2, rect.bottom - insetY],
    [rect.left + insetX, rect.top + rect.height / 2],
    [rect.right - insetX, rect.top + rect.height / 2]
  ];

  return points
    .map(([x, y]) => ({
      x: Math.min(Math.max(Math.round(x), 0), Math.max(width - 1, 0)),
      y: Math.min(Math.max(Math.round(y), 0), Math.max(height - 1, 0))
    }))
    .filter((point, index, list) => {
      return list.findIndex((candidate) => candidate.x === point.x && candidate.y === point.y) === index;
    });
}

function resolveCandidateOwner(element, candidateMap, doc) {
  let current = element;
  while (current && current !== doc.body && current !== doc.documentElement) {
    const candidate = candidateMap.get(current);
    if (candidate) {
      return candidate;
    }
    current = current.parentElement;
  }
  return null;
}

function stackCandidatesAtPoint(doc, candidateMap, x, y) {
  if (typeof doc.elementsFromPoint !== "function") {
    return [];
  }

  const stack = [];
  for (const element of doc.elementsFromPoint(x, y)) {
    const owner = resolveCandidateOwner(element, candidateMap, doc);
    if (!owner) continue;
    if (stack.some((candidate) => candidate.id === owner.id)) continue;
    stack.push(owner);
  }

  return stack;
}

function orderLayerCandidates(doc, candidates, width, height) {
  if (!candidates.length) {
    return [];
  }

  const paintMetadata = buildPaintMetadata(doc);
  const orderedByPaint = [...candidates]
    .map((candidate) => ({
      ...candidate,
      paintPath: buildPaintPath(candidate, paintMetadata)
    }))
    .sort(comparePaintPath);

  const topOrder = [...orderedByPaint].reverse();
  const candidateMap = new Map(candidates.map((candidate) => [candidate.element, candidate]));
  const precedence = new Map();

  const addRelation = (topLayer, bottomLayer) => {
    if (!topLayer || !bottomLayer || topLayer.id === bottomLayer.id) {
      return;
    }
    const key = `${topLayer.id}>${bottomLayer.id}`;
    precedence.set(key, (precedence.get(key) || 0) + 1);
  };

  for (const candidate of candidates) {
    const rect = visibleRectForElement(candidate.element);
    if (!rect) continue;

    const stackSamples = samplePointsForRect(rect, width, height);
    for (const point of stackSamples) {
      const stack = stackCandidatesAtPoint(doc, candidateMap, point.x, point.y);
      for (let index = 0; index < stack.length; index += 1) {
        for (let nextIndex = index + 1; nextIndex < stack.length; nextIndex += 1) {
          addRelation(stack[index], stack[nextIndex]);
        }
      }
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < candidates.length; nextIndex += 1) {
      const left = candidates[index];
      const right = candidates[nextIndex];
      if (left.element === right.element) {
        continue;
      }

      if (left.mode === "box" && left.element.contains(right.element)) {
        addRelation(right, left);
      }

      if (right.mode === "box" && right.element.contains(left.element)) {
        addRelation(left, right);
      }
    }
  }

  return topOrder.sort((left, right) => {
    const leftWins = precedence.get(`${left.id}>${right.id}`) || 0;
    const rightWins = precedence.get(`${right.id}>${left.id}`) || 0;
    if (leftWins !== rightWins) {
      return rightWins - leftWins;
    }
    return 0;
  });
}

function ensureCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function trimCanvas(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    return null;
  }

  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (!alpha) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) {
    return null;
  }

  const trimmedWidth = right - left + 1;
  const trimmedHeight = bottom - top + 1;
  const trimmed = ensureCanvas(trimmedWidth, trimmedHeight);
  const trimmedCtx = trimmed.getContext("2d", { alpha: true });
  if (!trimmedCtx) {
    return null;
  }
  trimmedCtx.drawImage(canvas, left, top, trimmedWidth, trimmedHeight, 0, 0, trimmedWidth, trimmedHeight);

  return {
    canvas: trimmed,
    left,
    top,
    right: right + 1,
    bottom: bottom + 1
  };
}

function hasVisiblePixels(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    return false;
  }

  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) {
      return true;
    }
  }

  return false;
}

function createIsolationStyle(doc, cssText) {
  const style = doc.createElement("style");
  style.setAttribute("data-psd-export-style", "true");
  style.textContent = cssText;
  doc.head.append(style);
  return style;
}

async function renderSvgStringToCanvas(svg, width, height, scale = 1) {
  const normalizedSvg = String(svg || "").replace(/^\s*<\?xml[^>]*>\s*/i, "");
  const blob = new Blob([normalizedSvg], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalizedSvg)}`;
  const base64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(normalizedSvg))) : "";
  const base64Url = base64 ? `data:image/svg+xml;base64,${base64}` : "";
  const sources = [objectUrl, dataUrl, base64Url].filter(Boolean);
  let lastError = null;
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);

  try {
    for (const source of sources) {
      try {
        const image = await new Promise((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () => reject(new Error("PSD 图层渲染失败。"));
          nextImage.decoding = "async";
          nextImage.src = source;
        });

        if (typeof image.decode === "function") {
          await image.decode().catch(() => undefined);
        }

        const canvas = ensureCanvas(scaledWidth, scaledHeight);
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) {
          throw new Error("PSD 画布上下文不可用。");
        }
        context.drawImage(image, 0, 0, scaledWidth, scaledHeight);
        return canvas;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("PSD 图层渲染失败。");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function renderBodyCanvas(doc, width, height, scale = 1) {
  return renderNodeToCanvas(doc.body, {
    cacheBust: false,
    skipAutoScale: true,
    pixelRatio: scale,
    width,
    height,
    canvasWidth: width,
    canvasHeight: height
  });
}

async function captureBackgroundLayer(doc, width, height, scale = 1) {
  const style = createIsolationStyle(
    doc,
    `
      body > * { visibility: hidden !important; }
    `
  );

  try {
    return await renderBodyCanvas(doc, width, height, scale);
  } finally {
    style.remove();
  }
}

function buildChildIndexPath(root, target) {
  const path = [];
  let current = target;

  while (current && current !== root) {
    const parent = current.parentElement;
    if (!parent) {
      return null;
    }
    path.unshift([...parent.children].indexOf(current));
    current = parent;
  }

  return current === root ? path : null;
}

function resolveChildIndexPath(root, path) {
  let current = root;
  for (const index of path) {
    current = current?.children?.[index];
    if (!current) {
      return null;
    }
  }
  return current;
}

function collectDocumentStyleText(doc) {
  return [...doc.querySelectorAll("style")]
    .map((style) => style.textContent || "")
    .filter(Boolean)
    .join("\n");
}

async function captureIsolatedSvgLayer(doc, target, width, height, scale = 1) {
  const rootSvg = target.closest("svg");
  if (!rootSvg) {
    throw new Error("SVG 图层目标无效。");
  }

  const rootRect = visibleRectForElement(rootSvg);
  if (!rootRect) {
    throw new Error("SVG 图层不可见。");
  }

  const childPath = buildChildIndexPath(rootSvg, target);
  if (!childPath) {
    throw new Error("SVG 图层路径解析失败。");
  }

  const clone = rootSvg.cloneNode(true);
  const cloneTarget = resolveChildIndexPath(clone, childPath);
  if (!cloneTarget) {
    throw new Error("SVG 图层克隆失败。");
  }

  const styleText = collectDocumentStyleText(doc);
  if (styleText) {
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = styleText;
    clone.insertBefore(style, clone.firstChild);
  }

  for (const element of clone.querySelectorAll("*")) {
    if (element.closest("defs")) {
      continue;
    }
    element.setAttribute("visibility", "hidden");
    element.setAttribute("opacity", "0");
  }

  let current = cloneTarget;
  while (current && current !== clone) {
    current.setAttribute("visibility", "visible");
    current.setAttribute("opacity", "1");
    current = current.parentElement;
  }

  cloneTarget.setAttribute("visibility", "visible");
  cloneTarget.setAttribute("opacity", "1");
  for (const element of cloneTarget.querySelectorAll("*")) {
    element.setAttribute("visibility", "visible");
    element.setAttribute("opacity", "1");
  }

  const outerSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  outerSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  outerSvg.setAttribute("width", String(width));
  outerSvg.setAttribute("height", String(height));
  outerSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  clone.setAttribute("x", String(rootRect.left));
  clone.setAttribute("y", String(rootRect.top));
  clone.setAttribute("width", String(rootRect.width));
  clone.setAttribute("height", String(rootRect.height));
  outerSvg.appendChild(clone);

  const svgText = new XMLSerializer().serializeToString(outerSvg);
  return renderSvgStringToCanvas(svgText, width, height, scale);
}

async function captureIsolatedElementLayer(doc, target, width, height, mode = "subtree", scale = 1) {
  if (mode === "svg-fragment" || mode === "svg-root") {
    return captureIsolatedSvgLayer(doc, target, width, height, scale);
  }

  const path = [];
  let current = target;

  while (current && current !== doc.body && current !== doc.documentElement) {
    path.push(current);
    current = current.parentElement;
  }

  target.setAttribute("data-psd-target", "true");
  path.forEach((element) => element.setAttribute("data-psd-path", "true"));

  const style = createIsolationStyle(
    doc,
    `
      html, body {
        background: transparent !important;
        background-image: none !important;
      }
      html::before,
      html::after,
      body::before,
      body::after {
        content: none !important;
        opacity: 0 !important;
        background: transparent !important;
        background-image: none !important;
        box-shadow: none !important;
        border-color: transparent !important;
      }
      body * {
        visibility: hidden !important;
      }
      [data-psd-path],
      [data-psd-target] {
        visibility: visible !important;
      }
      [data-psd-path]:not([data-psd-target]) {
        background: transparent !important;
        background-image: none !important;
        border-color: transparent !important;
        outline: none !important;
        box-shadow: none !important;
        filter: none !important;
        backdrop-filter: none !important;
        mix-blend-mode: normal !important;
      }
      [data-psd-path]:not([data-psd-target])::before,
      [data-psd-path]:not([data-psd-target])::after {
        content: none !important;
        opacity: 0 !important;
        background: transparent !important;
        background-image: none !important;
        box-shadow: none !important;
        border-color: transparent !important;
      }
      ${mode === "subtree" ? "[data-psd-target] *" : "[data-psd-target] > *"} {
        visibility: ${mode === "subtree" ? "visible" : "hidden"} !important;
      }
      [data-psd-path] > * {
        visibility: hidden !important;
      }
      [data-psd-path] > [data-psd-path],
      [data-psd-path] > [data-psd-target] {
        visibility: visible !important;
      }
    `
  );

  try {
    return await renderBodyCanvas(doc, width, height, scale);
  } finally {
    style.remove();
    target.removeAttribute("data-psd-target");
    path.forEach((element) => element.removeAttribute("data-psd-path"));
  }
}

function composeLayers(width, height, backgroundLayer, layers) {
  const canvas = ensureCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    return canvas;
  }

  if (backgroundLayer?.canvas) {
    ctx.drawImage(backgroundLayer.canvas, backgroundLayer.left, backgroundLayer.top);
  }

  for (const layer of layers) {
    if (!layer?.canvas) continue;
    ctx.drawImage(layer.canvas, layer.left, layer.top);
  }

  return canvas;
}

function composePsdPreviewCanvas(width, height, psdLayers) {
  const canvas = ensureCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    return canvas;
  }

  for (const layer of psdLayers) {
    if (!layer?.canvas) continue;
    ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
  }

  return canvas;
}

function diffRatio(baseCanvas, candidateCanvas) {
  const width = baseCanvas.width;
  const height = baseCanvas.height;
  const baseCtx = baseCanvas.getContext("2d", { alpha: true });
  const candidateCtx = candidateCanvas.getContext("2d", { alpha: true });
  if (!baseCtx || !candidateCtx) {
    return 1;
  }

  const base = baseCtx.getImageData(0, 0, width, height).data;
  const candidate = candidateCtx.getImageData(0, 0, width, height).data;
  let total = 0;

  for (let index = 0; index < base.length; index += 4) {
    total += Math.abs(base[index] - candidate[index]);
    total += Math.abs(base[index + 1] - candidate[index + 1]);
    total += Math.abs(base[index + 2] - candidate[index + 2]);
    total += Math.abs(base[index + 3] - candidate[index + 3]);
  }

  return total / (width * height * 4 * 255);
}

function layerToPsd(layer) {
  return {
    name: layer.name,
    top: layer.top,
    left: layer.left,
    bottom: layer.bottom,
    right: layer.right,
    blendMode: "normal",
    opacity: 1,
    canvas: layer.canvas
  };
}

function sortOutputLayersBottomToTop(layers) {
  return [...layers].sort((left, right) => {
    if (left === right) {
      return 0;
    }

    const leftElement = left?.element;
    const rightElement = right?.element;
    if (leftElement && rightElement && leftElement !== rightElement) {
      if (left.mode === "box" && leftElement.contains(rightElement)) {
        return -1;
      }
      if (right.mode === "box" && rightElement.contains(leftElement)) {
        return 1;
      }
    }

    return 0;
  });
}

function getVisibleBox(layer) {
  const bounds = layer?.visibleBounds;
  if (!bounds) {
    return null;
  }
  return {
    width: Math.max(0, bounds.right - bounds.left),
    height: Math.max(0, bounds.bottom - bounds.top),
    area: Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top)
  };
}

function overlapRatio(startA, endA, startB, endB) {
  const overlap = Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
  const base = Math.max(1, Math.min(endA - startA, endB - startB));
  return overlap / base;
}

function shouldDropDuplicateDecorativeLayer(layer, allLayers) {
  if (!layer || layer.mode !== "box" || !layer.visibleBounds) {
    return false;
  }

  const box = getVisibleBox(layer);
  if (!box) {
    return false;
  }

  const isThinRule = (box.height > 0 && box.height <= 4 && box.width >= 120) || (box.width > 0 && box.width <= 4 && box.height >= 120);
  if (!isThinRule) {
    return false;
  }

  return allLayers.some((candidate) => {
    if (!candidate || candidate.id === layer.id || candidate.name !== layer.name) {
      return false;
    }
    const candidateBox = getVisibleBox(candidate);
    if (!candidateBox) {
      return false;
    }
    if (candidate.mode === "box" && candidateBox.height <= 10) {
      return false;
    }

    const horizontalOverlap = overlapRatio(layer.visibleBounds.left, layer.visibleBounds.right, candidate.visibleBounds.left, candidate.visibleBounds.right);
    const verticalGap = Math.abs(layer.visibleBounds.top - candidate.visibleBounds.top);

    return candidateBox.height >= 14 && horizontalOverlap >= 0.5 && verticalGap <= 60;
  });
}

export async function exportDocumentAsPsd({
  doc,
  width,
  height,
  baseName = "designcode-export",
  scale = 1
}) {
  if (!doc || !width || !height) {
    throw new Error("当前没有可导出的 PSD 画布。");
  }

  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);

  const baseCanvas = await renderBodyCanvas(doc, width, height, scale);
  const baseTrimmed = {
    canvas: baseCanvas,
    left: 0,
    top: 0,
    right: sw,
    bottom: sh,
    name: "Composite"
  };

  const backgroundCanvas = await captureBackgroundLayer(doc, width, height, scale);
  const backgroundLayer = hasVisiblePixels(backgroundCanvas)
    ? {
        canvas: backgroundCanvas,
        left: 0,
        top: 0,
        right: sw,
        bottom: sh,
        name: "Canvas background"
      }
    : null;

  const { candidates, cleanup } = prepareLayerCandidates(doc);
  const isolatedLayers = [];
  let orderedCandidates = candidates;

  try {
    for (const candidate of candidates) {
      try {
        const fullCanvas = await captureIsolatedElementLayer(doc, candidate.element, width, height, candidate.mode, scale);
        if (!hasVisiblePixels(fullCanvas)) continue;
        const trimmed = trimCanvas(fullCanvas);
        isolatedLayers.push({
          id: candidate.id,
          canvas: trimmed?.canvas || fullCanvas,
          left: trimmed?.left ?? 0,
          top: trimmed?.top ?? 0,
          right: trimmed?.right ?? sw,
          bottom: trimmed?.bottom ?? sh,
          name: candidate.name,
          mode: candidate.mode,
          visibleBounds: trimmed,
          element: candidate.element
        });
      } catch {
        // Ignore a single candidate and keep exporting the rest.
      }
    }
    orderedCandidates = orderLayerCandidates(doc, candidates, width, height);
  } finally {
    cleanup();
  }

  const orderedIsolatedLayers = orderedCandidates
    .map((candidate) => isolatedLayers.find((layer) => layer.id === candidate.id))
    .filter(Boolean)
    .filter((layer, _index, allLayers) => !shouldDropDuplicateDecorativeLayer(layer, allLayers));

  const psdLayers = [];
  let exportMode = "layered";

  if (orderedIsolatedLayers.length) {
    const outputLayers = sortOutputLayersBottomToTop([...orderedIsolatedLayers].reverse());
    if (backgroundLayer?.canvas) {
      psdLayers.push(layerToPsd(backgroundLayer));
    }
    psdLayers.push(...outputLayers.map(layerToPsd));
  } else {
    exportMode = "composite-only";
    psdLayers.push(layerToPsd(baseTrimmed));
  }

  if (!psdLayers.length) {
    psdLayers.push(layerToPsd(baseTrimmed));
    exportMode = "composite-only";
  }

  const finalCanvas =
    psdLayers.length
      ? composePsdPreviewCanvas(sw, sh, psdLayers)
      : baseCanvas;
  const ratio = diffRatio(baseCanvas, finalCanvas);

  const buffer = writePsd(
    {
      width: sw,
      height: sh,
      canvas: finalCanvas,
      children: psdLayers
    },
    {
      noBackground: true,
      generateThumbnail: true
    }
  );

  return {
    filename: `${sanitizeFileName(baseName)}.psd`,
    blob: new Blob([buffer], { type: "image/vnd.adobe.photoshop" }),
    stats: {
      mode: exportMode,
      layerCount: psdLayers.length,
      candidateCount: candidates.length,
      validationRatio: ratio
    }
  };
}
