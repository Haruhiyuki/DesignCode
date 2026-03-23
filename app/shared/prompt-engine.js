import {
  createCustomSize,
  findSizePreset,
  getStyle
} from "./catalog.js";

function formatList(items, prefix = "- ") {
  return items.map((item) => `${prefix}${item}`).join("\n");
}

function formatObjectEntries(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function formatGuideBlock(title, items = []) {
  if (!Array.isArray(items) || !items.length) {
    return "";
  }

  return [title, formatList(items)].join("\n");
}

function resolveConfiguredStyle(styleId) {
  if (!styleId) {
    return null;
  }

  const style = getStyle(styleId);
  return style?.id === styleId ? style : null;
}

function resolveConfiguredSize(sizeId, customSize) {
  if (sizeId === "custom" && customSize) {
    return createCustomSize(customSize);
  }
  return findSizePreset(sizeId, customSize);
}

function resolveFieldDefinitions(fieldDefinitions = [], fields = {}) {
  if (Array.isArray(fieldDefinitions) && fieldDefinitions.length) {
    return fieldDefinitions;
  }

  return Object.keys(fields || {})
    .map((key) => ({
      id: key,
      label: key,
      required: false,
      placeholder: ""
    }));
}

function formatSlots(fields, fieldDefinitions = []) {
  return resolveFieldDefinitions(fieldDefinitions, fields)
    .map((slot) => {
      const value = fields[slot.id];
      return `- ${slot.label}${slot.required ? "（必填）" : ""}：${value || "未提供"}`;
    })
    .join("\n");
}

function summarizeSelectedArtAssets(assets) {
  if (!assets.length) {
    return "未选择用户素材。";
  }

  return assets
    .map((asset) =>
      [
        `- ${asset.name}`,
        `  path: ${asset.absolutePath}`,
        asset.note ? `  note: ${asset.note}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
}

function buildGenericSystemPrompt(mode, options = {}) {
  const sections = [
    "你是一位专业的平面设计师，由于你的审美能力很强、擅长写出美观的前端代码，所以你使用前端语言 HTML/CSS/SVG 进行设计，设计的却并非网页，而是海报、封面、杂志排版、艺术画等各式各样的传统平面设计内容。",
    "你只关心布局、样式的美观性，关心它们在视觉上是否融洽，而不会在意网站架构或交互等前端细节，也不会去写动态的内容。",
    "你创新式地使用前端语言来完成平面设计工作，而不受传统代码规则的约束。",
    "你的输出必须是一个可直接渲染的完整 HTML 文件。",
    "",
    "[通用规则]",
    formatList([
      "你的编辑应该在 ./design.html 中完成，必须保证该文件是完整 HTML 文档，包含 <!DOCTYPE html>。",
      "html 和 body 必须设置固定画布尺寸与 overflow:hidden。",
      "如果用户在指令中指定了具体的画布尺寸，则按该尺寸进行设计。如果没有指定，你可以自行决定适合的尺寸，只要能取得好的设计效果就可以。design.html 中已有的尺寸不是你必须遵循的。",
      "仅使用原生 HTML/CSS/SVG，不使用外部 JS 框架。",
      "所有文本需保持可编辑，不能转成位图。",
      "正文最小字号 14px，文本与背景对比度建议大于 4.5:1。",
      "视觉层级控制在 4 层以内。",
      "如果用户提交了美术资产，你应该读取并理解如何合适地使用它，考虑设计如何与其配合，风格、色调、布局构图应与其融洽。"
    ]),
    "",
    "[通用约束]",
    formatList([
      "必须在 <html> 元素上保留 data-design-width 和 data-design-height，值为最终采用的画布像素尺寸；如果尺寸由你自行决定，也要写入你最终决定的像素值。",
      "需要在 HTML 元素上标注 data-layer 以便图层面板使用。",
      "关键文本元素建议标注 data-editable。",
      "禁止脚本、事件处理器、外部接口请求。",
      "不要修改 project.json 或 chat.json。",
      "除非用户明确要求查看源码，否则不要在回复消息中粘贴完整 HTML、CSS、SVG 或大段代码。",
      "完成写入后最多做一次必要的快速检查，你的设计仅为视觉考虑，所以可能出问题的地方不多，不要为了确认而反复读取整份 design.html 或回显大段文件内容。",
      "用户主要是看你的设计，所以写入文件后最终回复简短一些。"
    ])
  ];

  if (mode === "edit") {
    sections.push(
      "",
      "[增量编辑规则]",
      formatList([
        "当前设计已存在于工作区的 ./design.html 中，必要时请自行读取。",
        "请根据用户修改要求做最小范围的修改。",
        "不要改动用户未提及的内容，不要丢失原有信息。"
      ])
    );
  }

  return sections.join("\n");
}

function buildSupplementContext({
  style,
  size,
  fields,
  fieldDefinitions = [],
  brief,
  uploadedAssets = [],
  selectedArtAssets = []
}) {
  const sections = [];
  const resolvedFields = resolveFieldDefinitions(fieldDefinitions, fields);
  const hasFieldDefinitions = resolvedFields.length > 0;
  const hasFieldValues = Object.values(fields || {}).some((value) => String(value || "").trim());
  const hasFieldContent = hasFieldDefinitions || hasFieldValues || brief;

  if (style) {
    sections.push(
      `[风格补充] ${style.name}`,
      `风格氛围：${style.mood}`,
      style.summary ? `风格摘要：${style.summary}` : "",
      style.keywords?.length ? `风格关键词：${style.keywords.join(" / ")}` : "",
      "CSS 变量：",
      formatObjectEntries(style.tokens),
      "字体范围：",
      [
        `display: ${style.fonts.display.join(", ")}`,
        `body: ${style.fonts.body.join(", ")}`,
        `accent: ${style.fonts.accent.join(", ")}`
      ].join("\n"),
      formatGuideBlock("构图指引：", style.guide?.composition),
      formatGuideBlock("字体与层级：", style.guide?.typography),
      formatGuideBlock("配色策略：", style.guide?.color),
      formatGuideBlock("材质与装饰：", style.guide?.texture),
      formatGuideBlock("避免事项：", style.guide?.avoid),
      "风格规则：",
      formatList(style.rules)
    );
  }

  if (size) {
    sections.push(
      "[尺寸补充]",
      `目标尺寸：${size.label}`,
      `画布像素尺寸：${size.width} × ${size.height}px${size.physical ? `（${size.physical}）` : ""}`
    );
  }

  if (hasFieldContent) {
    sections.push("[内容补充]");
    if (hasFieldDefinitions || hasFieldValues) {
      sections.push("内容要求：", formatSlots(fields, fieldDefinitions));
    }
    if (brief) {
      sections.push(`设计意图补充：${brief}`);
    }
  }

  if (uploadedAssets.length || selectedArtAssets.length) {
    sections.push(
      "[素材补充]",
      uploadedAssets.length ? `已上传素材：${uploadedAssets.join(" / ")}` : "",
      selectedArtAssets.length ? "本次可使用的用户素材：" : "",
      selectedArtAssets.length ? summarizeSelectedArtAssets(selectedArtAssets) : "",
      selectedArtAssets.length
        ? "仅使用以上文件；如需读取素材清单，可查看 ./art-assets.json。"
        : ""
    );
  }

  if (!sections.length) {
    return "";
  }

  return [
    "[以下内容是工作台根据用户当前配置补充的上下文，请作为对用户主体请求的补充说明]",
    "",
    ...sections
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGenerationPrompt({
  styleId,
  sizeId,
  customSize,
  fields,
  fieldDefinitions = [],
  brief,
  instruction = "",
  uploadedAssets = [],
  selectedArtAssets = []
}) {
  const style = resolveConfiguredStyle(styleId);
  const size = resolveConfiguredSize(sizeId, customSize);
  const supplementContext = buildSupplementContext({
    style,
    size,
    fields,
    fieldDefinitions,
    brief,
    uploadedAssets,
    selectedArtAssets
  });

  const systemPrompt = buildGenericSystemPrompt("generate", {
    hasExplicitSize: Boolean(size)
  });

  const mainInstruction = instruction || "请根据用户需求完成这次设计。";

  const userMessage = [
    "[用户主体请求]",
    mainInstruction,
    supplementContext ? `\n${supplementContext}` : ""
  ].join("\n");

  return {
    style,
    size,
    systemPrompt,
    userMessage
  };
}

export function buildEditPrompt({
  styleId,
  sizeId,
  customSize,
  fields,
  fieldDefinitions = [],
  brief,
  selectedArtAssets = [],
  instruction
}) {
  const generation = buildGenerationPrompt({
    styleId,
    sizeId,
    customSize,
    fields,
    fieldDefinitions,
    brief,
    selectedArtAssets
  });

  const systemPrompt = buildGenericSystemPrompt("edit", {
    hasExplicitSize: Boolean(generation.size)
  });
  const supplementContext = buildSupplementContext({
    style: generation.style,
    size: generation.size,
    fields,
    fieldDefinitions,
    brief,
    selectedArtAssets
  });

  return {
    ...generation,
    systemPrompt,
    userMessage: [
      "[用户主体请求]",
      instruction,
      supplementContext ? `\n${supplementContext}` : ""
    ].join("\n")
  };
}

export function sanitizeHtml(input) {
  if (!input) {
    return "";
  }

  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/\s(href|src)=["']javascript:[^"']*["']/gi, "")
    .replace(/\b(fetch|XMLHttpRequest|WebSocket)\b/gi, "blocked")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "");
}
