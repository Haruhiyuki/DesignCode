// 设计导出 — HTML/SVG/PNG/PDF/PSD 多格式导出，iframe 截图渲染。
import { nextTick } from "vue";
import { toBlob as renderNodeToBlob } from "html-to-image";
import { PDFDocument } from "pdf-lib";
import { exportDocumentAsPsd } from "../lib/psd-export.js";
import {
  downloadBlob,
  materializeArtAssetUrls,
} from "../lib/studio-utils.js";
import { t } from "../i18n/index.js";
import { useWorkspaceState } from "./useWorkspaceState.js";
import { useSetupConfig } from "./useSetupConfig.js";
import { useArtAssets } from "./useArtAssets.js";
import { useCanvasViewport } from "./useCanvasViewport.js";

// ---------------------------------------------------------------------------
// 模块级单例 — 从其他 composable 获取依赖
// ---------------------------------------------------------------------------

const {
  state,
  setStatus,
} = useWorkspaceState();

const {
  renderedCanvas,
  currentExportQuality,
  artAssetLibrary,
  projectTitle,
} = useSetupConfig();

const {
  syncArtAssetPreviews,
} = useArtAssets();

const {
  closeExportMenu,
} = useCanvasViewport();

// ---------------------------------------------------------------------------
// 渲染管线
// ---------------------------------------------------------------------------

function buildMaterializedExportHtml() {
  return materializeArtAssetUrls(
    state.currentHtml,
    artAssetLibrary.value,
    state.assets.previewUrls,
    state.design.workspaceDir || ""
  );
}

function buildSvgSnapshot(doc, width = renderedCanvas.value?.width, height = renderedCanvas.value?.height) {
  if (!doc || !width || !height) {
    throw new Error("No exportable design available.");
  }

  const serialized = new XMLSerializer().serializeToString(doc.documentElement);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject width="100%" height="100%">${serialized}</foreignObject>
</svg>`;
}

async function waitForExportReadiness(doc) {
  const fontPromise =
    typeof doc.fonts?.ready?.then === "function"
      ? doc.fonts.ready.catch(() => undefined)
      : Promise.resolve();

  const imagePromises = [...doc.images].map((image) => {
    if (typeof image.decode === "function") {
      return image.decode().catch(() => undefined);
    }

    if (image.complete) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  });

  await Promise.all([fontPromise, ...imagePromises]);
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

  try {
    for (const source of sources) {
      try {
        const image = await new Promise((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () => reject(new Error("Bitmap render failed."));
          nextImage.decoding = "async";
          nextImage.src = source;
        });

        if (typeof image.decode === "function") {
          await image.decode().catch(() => undefined);
        }

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d", { alpha: true });
        if (!context) {
          throw new Error("Bitmap canvas context unavailable.");
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Bitmap render failed.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function renderSvgStringToBlob(svg, width, height, scale = 1, type = "image/png") {
  const canvas = await renderSvgStringToCanvas(svg, width, height, scale);
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, type);
  });

  if (!blob) {
    throw new Error("Bitmap encoding failed.");
  }

  return blob;
}

async function warmUpExportSnapshot(svg, width, height) {
  await renderSvgStringToCanvas(svg, width, height, 1);
}

// ---------------------------------------------------------------------------
// 导出框架
// ---------------------------------------------------------------------------

async function primeExportFrame(doc) {
  const view = doc.defaultView || window;
  const nextFrame = () =>
    new Promise((resolve) => {
      view.requestAnimationFrame(() => resolve());
    });

  await waitForExportReadiness(doc);
  await nextFrame();
  await nextFrame();
}

async function createExportFrameContext() {
  if (!renderedCanvas.value || !state.currentHtml) {
    throw new Error("No exportable design available.");
  }

  await syncArtAssetPreviews(artAssetLibrary.value);
  await nextTick();
  const html = buildMaterializedExportHtml();
  if (!html) {
    throw new Error("No exportable design available.");
  }

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.position = "fixed";
  iframe.style.left = "-100000px";
  iframe.style.top = "0";
  iframe.style.width = `${renderedCanvas.value.width}px`;
  iframe.style.height = `${renderedCanvas.value.height}px`;
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  document.body.append(iframe);

  await new Promise((resolve, reject) => {
    iframe.addEventListener("load", resolve, { once: true });
    iframe.addEventListener("error", () => reject(new Error("Export preview load failed.")), { once: true });
    iframe.srcdoc = html;
  });

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error("Export preview unavailable.");
  }

  await primeExportFrame(doc);
  return {
    doc,
    dispose() {
      iframe.remove();
    }
  };
}

async function renderPreviewBlob(scale = 1) {
  const context = await createExportFrameContext();
  try {
    const width = renderedCanvas.value.width;
    const height = renderedCanvas.value.height;
    const svg = buildSvgSnapshot(context.doc, width, height);

    try {
      await warmUpExportSnapshot(svg, width, height);
      return await renderSvgStringToBlob(svg, width, height, scale);
    } catch {
      const exportNode = context.doc.body;
      const blob = await renderNodeToBlob(exportNode, {
        cacheBust: false,
        pixelRatio: scale,
        skipAutoScale: true,
        width,
        height,
        canvasWidth: Math.round(width * scale),
        canvasHeight: Math.round(height * scale)
      });

      if (!blob) {
        throw new Error("Export render failed.");
      }

      return blob;
    }
  } finally {
    context.dispose();
  }
}

// ---------------------------------------------------------------------------
// 各格式导出
// ---------------------------------------------------------------------------

async function exportHtmlAsync() {
  try {
    await syncArtAssetPreviews(artAssetLibrary.value);
    await nextTick();
    const html = buildMaterializedExportHtml();
    if (!html) {
      return;
    }

    downloadBlob("designcode-export.html", new Blob([html], { type: "text/html" }));
    setStatus(t("status.htmlExported"), "success", "export");
  } catch (error) {
    state.warnings = [t("export.htmlExportFailed", { error: error instanceof Error ? error.message : String(error) })];
    setStatus(t("status.htmlExportFailed"), "error", "export");
  }
}

function exportHtml() {
  void exportHtmlAsync();
}

async function exportSvg() {
  let context = null;
  try {
    context = await createExportFrameContext();
    const svg = buildSvgSnapshot(context.doc, renderedCanvas.value.width, renderedCanvas.value.height);
    downloadBlob("designcode-export.svg", new Blob([svg], { type: "image/svg+xml" }));
    setStatus(t("status.svgExported"), "success", "export");
  } catch (error) {
    state.warnings = [error instanceof Error ? error.message : String(error)];
    setStatus(t("status.svgExportFailed"), "error", "export");
  } finally {
    context?.dispose?.();
  }
}

async function exportPng() {
  try {
    const blob = await renderPreviewBlob(currentExportQuality.value.scale);
    downloadBlob("designcode-export.png", blob);
    setStatus(t("status.pngExported", { quality: currentExportQuality.value.label }), "success");
  } catch (error) {
    state.warnings = [t("export.pngExportFailed", { error: error instanceof Error ? error.message : String(error) })];
    setStatus(t("status.pngExportFailed"), "error", "export");
  }
}

async function exportPdf() {
  try {
    if (!renderedCanvas.value) {
      throw new Error("No exportable design available.");
    }

    const pngBlob = await renderPreviewBlob(currentExportQuality.value.scale);
    const pdf = await PDFDocument.create();
    const imageBytes = await pngBlob.arrayBuffer();
    const embeddedImage = await pdf.embedPng(imageBytes);
    const pageWidth = renderedCanvas.value.width * 0.75;
    const pageHeight = renderedCanvas.value.height * 0.75;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight
    });

    const bytes = await pdf.save();
    downloadBlob("designcode-export.pdf", new Blob([bytes], { type: "application/pdf" }));
    setStatus(t("status.pdfExported", { quality: currentExportQuality.value.label }), "success");
  } catch (error) {
    state.warnings = [t("export.pdfExportFailed", { error: error instanceof Error ? error.message : String(error) })];
    setStatus(t("status.pdfExportFailed"), "error", "export");
  }
}

async function exportPsd() {
  let context = null;
  try {
    const width = renderedCanvas.value?.width;
    const height = renderedCanvas.value?.height;
    if (!width || !height) {
      throw new Error("No exportable design available.");
    }

    setStatus(t("status.psdExporting"), "running", "export");
    context = await createExportFrameContext();
    const result = await exportDocumentAsPsd({
      doc: context.doc,
      width,
      height,
      baseName: projectTitle.value
    });
    result.stats = {
      ...result.stats,
      route: "browser"
    };

    downloadBlob(result.filename, result.blob);

    const routeLabelMap = {
      browser: "browser"
    };
    const routeLabel = routeLabelMap[result.stats.route] || result.stats.route || "unknown";

    if (result.stats.mode === "composite-only") {
      state.warnings = [
        t("status.psdCompositeOnlyWarning")
      ];
      setStatus(t("status.psdExportedComposite", { route: routeLabel }), "success");
      return;
    }

    setStatus(t("status.psdExported", { detail: `${result.stats.layerCount} layers · ${routeLabel}` }), "success", "export");
  } catch (error) {
    state.warnings = [t("export.psdExportFailed", { error: error instanceof Error ? error.message : String(error) })];
    setStatus(t("status.psdExportFailed"), "error", "export");
  } finally {
    context?.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// 导出入口
// ---------------------------------------------------------------------------

function runExportAction(type) {
  closeExportMenu();

  if (type === "png") {
    void exportPng();
    return;
  }

  if (type === "svg") {
    void exportSvg();
    return;
  }

  if (type === "print") {
    void exportPdf();
    return;
  }

  if (type === "psd") {
    void exportPsd();
    return;
  }

  exportHtml();
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

export function useDesignExport() {
  return {
    // 导出入口
    runExportAction,

    // 各格式导出
    exportHtml,
    exportSvg,
    exportPng,
    exportPdf,
    exportPsd,

    // 渲染管线
    buildSvgSnapshot,
    buildMaterializedExportHtml,
    renderSvgStringToCanvas,
    renderSvgStringToBlob,
    warmUpExportSnapshot,
    renderPreviewBlob,

    // 导出框架
    createExportFrameContext,
    primeExportFrame,
    waitForExportReadiness,
  };
}
