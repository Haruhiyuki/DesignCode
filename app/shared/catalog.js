const mmToPx = (mm) => Math.round((mm / 25.4) * 96);

const slugify = (label, fallback) => {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
};

const pxSize = (width, height, label) => ({
  id: slugify(label, `${width}x${height}`),
  name: label,
  width,
  height,
  unit: "px",
  label: `${width} × ${height}px`
});

const mmSize = (widthMm, heightMm, label) => ({
  id: slugify(label, `${widthMm}x${heightMm}mm`),
  name: label,
  width: mmToPx(widthMm),
  height: mmToPx(heightMm),
  unit: "mm",
  physical: `${widthMm} × ${heightMm}mm`,
  label: `${label} · ${widthMm} × ${heightMm}mm`
});

export function createCustomSize({
  width,
  height,
  unit = "px",
  name = "自定义尺寸"
}) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  if (unit === "mm") {
    return {
      id: "custom",
      name,
      width: mmToPx(safeWidth),
      height: mmToPx(safeHeight),
      unit: "mm",
      physical: `${safeWidth} × ${safeHeight}mm`,
      custom: true,
      sourceWidth: safeWidth,
      sourceHeight: safeHeight,
      label: `${name} · ${safeWidth} × ${safeHeight}mm`
    };
  }

  return {
    id: "custom",
    name,
    width: safeWidth,
    height: safeHeight,
    unit: "px",
    custom: true,
    sourceWidth: safeWidth,
    sourceHeight: safeHeight,
    label: `${name} · ${safeWidth} × ${safeHeight}px`
  };
}

export const defaultSizePresets = [
  mmSize(90, 54, "名片"),
  mmSize(148, 100, "明信片横版"),
  mmSize(100, 148, "明信片竖版"),
  mmSize(148, 210, "A5"),
  mmSize(210, 297, "A4"),
  mmSize(297, 420, "A3"),
  mmSize(420, 594, "A2"),
  pxSize(1080, 1080, "方图 1:1"),
  pxSize(1080, 1350, "竖图 4:5"),
  pxSize(1080, 1920, "竖版 9:16"),
  pxSize(1920, 1080, "横版 16:9"),
  pxSize(1440, 900, "桌面横版"),
  pxSize(840, 1260, "封面 2:3"),
  pxSize(1050, 600, "横版名片"),
  pxSize(600, 1050, "竖版名片"),
  pxSize(1240, 1754, "竖版菜单")
];

const createStylePreset = ({
  id,
  name,
  mood,
  summary,
  keywords = [],
  preview,
  tokens,
  fonts,
  rules = [],
  guide = {},
  previewExample = {}
}) => ({
  id,
  name,
  mood,
  summary,
  keywords,
  preview,
  tokens,
  fonts,
  rules,
  guide: {
    composition: guide.composition || [],
    typography: guide.typography || [],
    color: guide.color || [],
    texture: guide.texture || [],
    avoid: guide.avoid || []
  },
  previewExample: {
    kicker: previewExample.kicker || name,
    title: previewExample.title || name,
    body: previewExample.body || summary || mood
  }
});


export const stylePresets = [

  // ═══════════════════════════════════════════════════
  //  ★ 主推风格
  // ═══════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════
  //  理性秩序系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "swiss-rational",
    name: "瑞士理性",
    mood: "冷白 + 黑体网格 + 信号红",
    summary: "国际主义排版的当代演绎：严格网格、超大字号差、大面积留白与一个精确信号色。",
    keywords: ["网格对齐", "信号色", "字号梯度", "编号系统"],
    preview: "linear-gradient(135deg, #f4f3f0, #d5d0c7)",
    tokens: {
      "--bg-primary": "#f6f5f1",
      "--bg-secondary": "#e6e3dc",
      "--text-primary": "#0e0e0f",
      "--text-secondary": "#3e3e40",
      "--text-muted": "#6d6d70",
      "--accent": "#d42b1e",
      "--accent-secondary": "#111111",
      "--border": "#1a1a1a"
    },
    fonts: {
      display: ["Helvetica Neue", "Avenir Next", "Segoe UI"],
      body: ["Helvetica Neue", "Avenir Next", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "所有元素必须沿网格对齐，标题与正文字号比至少 4:1",
      "信号色面积不超过画面 8%，用于编号、线条或单个焦点块",
      "留白本身是设计元素，任何区域不应无意义填充"
    ],
    guide: {
      composition: [
        "标题贴齐版面左侧或顶部基线，形成明确的列或行结构。",
        "信息块用硬边分割而非阴影过渡，行间距精确统一。"
      ],
      typography: [
        "标题用超大粗体无衬线，辅助信息切换到小号等宽或中黑。",
        "层级只靠字号、字重和留白三个变量控制。"
      ],
      color: [
        "画面以黑白灰为基底，仅允许 1 个高纯度信号色。",
        "信号色应像交通标志一样精确出现在编号或锚点位置。"
      ],
      texture: [
        "禁止明显纹理，最多可用极淡纸面噪点。",
        "唯一允许的装饰是分割线、坐标标记和编号。"
      ],
      avoid: [
        "禁止柔和渐变、多色混搭和装饰性插图。",
        "禁止圆角卡片、阴影浮层和任何可爱元素。"
      ]
    },
    previewExample: {
      kicker: "POSTER SYSTEM — 001",
      title: "Signal Grid",
      body: "Rigid alignment, deliberate whitespace, one red anchor."
    }
  }),

  createStylePreset({
    id: "corporate-trust",
    name: "企业蓝",
    mood: "冷白蓝 + 深蓝灰 + 稳健",
    summary: "大型企业品牌系统的视觉基底：高可信度的蓝灰色阶、清晰信息分区和中性排版。",
    keywords: ["可信度", "蓝灰秩序", "信息分区", "数据可视化"],
    preview: "linear-gradient(135deg, #eef2f7, #c5d1de)",
    tokens: {
      "--bg-primary": "#f2f5f9",
      "--bg-secondary": "#dce4ed",
      "--text-primary": "#152338",
      "--text-secondary": "#3f546c",
      "--text-muted": "#728da6",
      "--accent": "#0055b8",
      "--accent-secondary": "#17809c",
      "--border": "#adbccc"
    },
    fonts: {
      display: ["Avenir Next", "Helvetica Neue", "Segoe UI"],
      body: ["IBM Plex Sans", "Helvetica Neue", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "版式保持稳健分栏，信息密度适中，留白充分",
      "强调色只承担功能性角色——按钮、链接、关键指标",
      "视觉语言像品牌手册而非 Dashboard UI"
    ],
    guide: {
      composition: [
        "封面用大标题 + 摘要信息块，内页用两到三栏网格。",
        "图表和数字区块需有明确边界，不与正文混排。"
      ],
      typography: [
        "标题使用无衬线中黑或粗体，正文保持 Regular 可读性优先。",
        "参数、编号和章节号使用等宽体加强机构感。"
      ],
      color: [
        "蓝、灰、白三色阶贯穿全稿，强调色只用在最关键的 1-2 个位置。",
        "禁止出现情绪化暖色和荧光色。"
      ],
      texture: [
        "材质极轻，只用最淡的网格或分割线作为背景支撑。",
        "数据区块可用浅灰底色区分，但对比度不可过高。"
      ],
      avoid: [
        "禁止夜店霓虹、手写体和复古做旧纹理。",
        "禁止让整个版面看起来像电商落地页。"
      ]
    },
    previewExample: {
      kicker: "ANNUAL REPORT / 2026",
      title: "System Brief",
      body: "Blue-gray hierarchy, institutional trust, precise data regions."
    }
  }),

  createStylePreset({
    id: "de-stijl",
    name: "风格派",
    mood: "纯白 + 黑线骨架 + 红黄蓝色块",
    summary: "蒙德里安式的极端秩序：粗细黑线划分版面，红黄蓝色块作为结构性构图元素。",
    keywords: ["黑线网格", "原色块", "新造型主义", "绝对水平垂直"],
    preview: "linear-gradient(135deg, #faf8f2, #e5dfd5)",
    tokens: {
      "--bg-primary": "#faf8f1",
      "--bg-secondary": "#e6e0d3",
      "--text-primary": "#111111",
      "--text-secondary": "#3e3b36",
      "--text-muted": "#706b62",
      "--accent": "#d62c20",
      "--accent-secondary": "#1750c9",
      "--border": "#141414"
    },
    fonts: {
      display: ["Futura", "Avenir Next", "Helvetica Neue"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Futura", "DIN Alternate", "Avenir Next"]
    },
    rules: [
      "只允许水平线和垂直线，绝对禁止对角线和曲线",
      "色块是结构元素而非装饰——它们参与重心平衡",
      "黑线粗细必须有两到三个明确等级"
    ],
    guide: {
      composition: [
        "版面由不同粗细的黑线分割为不对称矩形模块。",
        "色块面积遵循黄金比例或三分法，不可平均分配。"
      ],
      typography: [
        "字体必须几何化、现代化，禁止复古手感和衬线体。",
        "文字严格沿网格对齐，不做旋转和倾斜。"
      ],
      color: [
        "白底占画面 60% 以上，红黄蓝总面积不超过 25%。",
        "同一画面最多使用两种原色加黑白。"
      ],
      texture: [
        "绝对平面，零纹理、零质感噪声、零阴影。",
        "如果需要视觉层次，只用色块明度差实现。"
      ],
      avoid: [
        "禁止渐变、圆角、阴影和任何柔软气质。",
        "禁止色块数量超过 5 个——破坏秩序就破坏了一切。"
      ]
    },
    previewExample: {
      kicker: "GRID / COLOR / AXIS",
      title: "Primary Order",
      body: "Black framework, white field, red-blue compositional tension."
    }
  }),

  createStylePreset({
    id: "bauhaus-form",
    name: "包豪斯构成",
    mood: "几何原色 + 功能秩序 + 教学感",
    summary: "圆方三角与红黄蓝的功能主义对话，几何形体主动参与布局而非仅做背景。",
    keywords: ["原色几何", "功能主义", "圆方三角", "构成实验"],
    preview: "linear-gradient(135deg, #f3f0e8, #dbd4c6)",
    tokens: {
      "--bg-primary": "#f3f0e8",
      "--bg-secondary": "#ddd7c9",
      "--text-primary": "#121212",
      "--text-secondary": "#3f3a33",
      "--text-muted": "#6e675c",
      "--accent": "#d82e1e",
      "--accent-secondary": "#0c5ad4",
      "--border": "#161310"
    },
    fonts: {
      display: ["Futura", "Avenir Next", "Helvetica Neue"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Futura", "DIN Alternate", "Avenir Next"]
    },
    rules: [
      "几何形体与文字必须形成对位关系——穿插、包围或切割",
      "红黄蓝三原色必须有明确主次，不可平均分配",
      "信息像构成单元一样整齐排列，禁止自由散落"
    ],
    guide: {
      composition: [
        "几何形体（圆、方、三角）主动参与布局，承载或切割文字区域。",
        "适合不对称平衡：大圆配小字块，粗线配细体文本。"
      ],
      typography: [
        "只用几何无衬线体，字号跨度可以很大但必须形成节奏。",
        "信息条目像标签一样依附在几何形体旁边。"
      ],
      color: [
        "红黄蓝加黑白灰构成全部色彩空间，禁止其他色相。",
        "建议一个主色占大面积，另外两色作为点缀。"
      ],
      texture: [
        "平面印刷感，可有极轻微的纸面颗粒。",
        "装饰图形必须是几何逻辑（等分、旋转、平移）。"
      ],
      avoid: [
        "禁止浪漫曲线、花纹和写实纹理。",
        "禁止让三个原色面积相等——那是调色盘不是设计。"
      ]
    },
    previewExample: {
      kicker: "FORM / COLOR / FUNCTION",
      title: "Signal Study",
      body: "Primary geometry, disciplined asymmetry, poster logic."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  编辑出版系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "editorial-luxe",
    name: "杂志风尚",
    mood: "中性白底 + 高对比衬线 + 钴蓝点缀",
    summary: "高端杂志的排版系统：跨栏大标题、期刊编号、多栏正文和一个精确的强调色。",
    keywords: ["跨栏标题", "高对比衬线", "栏目编号", "大片留白"],
    preview: "linear-gradient(135deg, #faf9f7, #e4ded4)",
    tokens: {
      "--bg-primary": "#faf9f6",
      "--bg-secondary": "#ece7de",
      "--text-primary": "#151413",
      "--text-secondary": "#35322e",
      "--text-muted": "#6c6760",
      "--accent": "#1054c9",
      "--accent-secondary": "#e88a20",
      "--border": "#1c1b18"
    },
    fonts: {
      display: ["Didot", "Bodoni 72", "Times New Roman"],
      body: ["Georgia", "Iowan Old Style", "Times New Roman"],
      accent: ["Avenir Next", "Helvetica Neue", "Segoe UI"]
    },
    rules: [
      "标题必须使用高对比衬线体，字号至少为正文的 5 倍",
      "适合数字编号、栏目标签、跨栏标题和编辑注释",
      "强调色只承担导航或标签功能，不做情绪渲染"
    ],
    guide: {
      composition: [
        "标题可跨 2-3 列，正文严格收进网格。期号和编号放在边角。",
        "大面积留白与密集排版区形成节奏对比。"
      ],
      typography: [
        "标题用高反差衬线（Didot/Bodoni），正文用温和书报字体（Georgia）。",
        "栏目名和标签切换到理性无衬线，形成第三层级。"
      ],
      color: [
        "底色极浅，文本近黑，整体像高端铜版纸杂志的黑白基调。",
        "蓝色只出现在栏目标签或首字母大写处。"
      ],
      texture: [
        "材质偏精致纸张和干净分割线，不用粗糙肌理。",
        "图形元素限于编号框、细线和栏目块。"
      ],
      avoid: [
        "禁止低幼圆角和高饱和大色块。",
        "禁止让版面看起来像电商促销页或 PPT。"
      ]
    },
    previewExample: {
      kicker: "ISSUE 07 / FEATURE",
      title: "Quiet Geometry",
      body: "Layered hierarchy, fine columns, editorial blue accent."
    }
  }),

  createStylePreset({
    id: "letterpress-quiet",
    name: "活字文艺",
    mood: "米纸底 + 墨黑 + 靛蓝",
    summary: "活版印刷的安静气质：纸张压印感、文艺衬线和沉静色调。",
    keywords: ["活版压印", "文艺衬线", "安静出版", "油墨质感"],
    preview: "linear-gradient(135deg, #f4efe4, #d6cdbf)",
    tokens: {
      "--bg-primary": "#f4efe4",
      "--bg-secondary": "#ddd6c8",
      "--text-primary": "#1d1a17",
      "--text-secondary": "#454139",
      "--text-muted": "#706a5f",
      "--accent": "#2a4260",
      "--accent-secondary": "#8a5830",
      "--border": "#9a9184"
    },
    fonts: {
      display: ["Cormorant Garamond", "Iowan Old Style", "Times New Roman"],
      body: ["Georgia", "Iowan Old Style", "Times New Roman"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "整体语气安静、克制，像精装小册子或文学刊物",
      "层级只靠字重、字号和大量留白建立",
      "颜色要像油墨印在纸上的效果，不要数码发亮"
    ],
    guide: {
      composition: [
        "大留白搭配居中标题，或上下分栏的文艺封面结构。",
        "信息密度低，排版气质优先于信息量。"
      ],
      typography: [
        "标题用古典衬线体（Cormorant/Garamond），正文用温暖易读的 Georgia。",
        "可用小号等宽体做日期、编号和注脚，增添排印趣味。"
      ],
      color: [
        "底色偏燕麦色、纸白，主色限于墨黑和深靛蓝。",
        "强调色只需少量铜棕——像老书脊上的烫金。"
      ],
      texture: [
        "适合纸纤维感、微弱的压印凹凸和印刷边缘晕染。",
        "纹理必须极细，不能变成做旧海报。"
      ],
      avoid: [
        "禁止荧光强调色和硬科技边框。",
        "禁止文本块像网页信息卡一样有圆角和阴影。"
      ]
    },
    previewExample: {
      kicker: "PRINTED NOTE / NO. 12",
      title: "Quiet Press",
      body: "Soft paper grain, literary serif, ink-on-paper elegance."
    }
  }),

  createStylePreset({
    id: "new-wave-type",
    name: "新浪潮排版",
    mood: "实验版式 + 冷暖撞色 + 标签碎片",
    summary: "断裂网格、极端字号跨度和编辑标注式标签并存。",
    keywords: ["断裂网格", "实验排版", "标注系统", "前卫编辑"],
    preview: "linear-gradient(135deg, #f5f2f4, #d5ced6)",
    tokens: {
      "--bg-primary": "#f5f2f3",
      "--bg-secondary": "#ddd5db",
      "--text-primary": "#17141a",
      "--text-secondary": "#3c363f",
      "--text-muted": "#706973",
      "--accent": "#ee4528",
      "--accent-secondary": "#4a46d8",
      "--border": "#1b181d"
    },
    fonts: {
      display: ["Helvetica Neue", "Arial Black", "Avenir Next"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "允许打破常规网格，但必须形成有意图的阅读路径",
      "标题、编号、注释之间形成实验性但可读的张力",
      "画面像前卫出版物，而不是随机错位的事故"
    ],
    guide: {
      composition: [
        "主标题可切分成多段，分布在不同块面或边缘位置。",
        "辅助标签、编号、引语像编辑标注一样穿插在主体周围。"
      ],
      typography: [
        "字号跨度极大——240px 标题旁边放 10px 脚注是允许的。",
        "断行、旋转和拉伸必须服务于阅读引导，不做纯装饰。"
      ],
      color: [
        "底色中性，朱红和靛紫两个强调色可并存但面积悬殊。",
        "冷暖撞色应在视觉上制造张力而非混乱。"
      ],
      texture: [
        "可加入小字号脚注、编号框、裁切线和抽样标记。",
        "纹理应极轻，重点是排版本身的张力。"
      ],
      avoid: [
        "禁止所有文本都倾斜或跳出网格——那是混乱不是实验。",
        "禁止粗暴促销语气和电商式卖点标签。"
      ]
    },
    previewExample: {
      kicker: "TYPE / FRAGMENT / INDEX",
      title: "Offset Voices",
      body: "Broken grids, editorial notes, controlled experimental tension."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  暗色高级系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "noir-velvet",
    name: "夜幕丝绒",
    mood: "纯黑底 + 酒红缎面 + 象牙高光",
    summary: "深夜的高级质感：黑底上用酒红和象牙白勾勒出缎面光泽与克制的奢华。",
    keywords: ["纯黑底", "酒红缎面", "象牙白", "柔光高级感"],
    preview: "linear-gradient(135deg, #1a1518, #3a2830)",
    tokens: {
      "--bg-primary": "#121015",
      "--bg-secondary": "#2a1f28",
      "--text-primary": "#f3ede5",
      "--text-secondary": "#c9baae",
      "--text-muted": "#907a70",
      "--accent": "#982e45",
      "--accent-secondary": "#dcc5ac",
      "--border": "#553e4a"
    },
    fonts: {
      display: ["Cormorant Garamond", "Didot", "Times New Roman"],
      body: ["Optima", "Avenir Next", "Helvetica Neue"],
      accent: ["Cormorant Garamond", "Georgia", "Times New Roman"]
    },
    rules: [
      "底色必须足够深，重点在酒红和象牙白的柔和闪现",
      "标题优雅克制——奢华来自留白和材质暗示，不来自堆砌",
      "局部材质感强于整体复杂度"
    ],
    guide: {
      composition: [
        "主体信息悬浮于深色中央或下三分之一，形成稳重的重力感。",
        "边角用细致线框或小型标识增强高级感，但不超过 3 处。"
      ],
      typography: [
        "标题用纤细高衬线体，字距略微拉开让画面呼吸。",
        "正文用优雅人文无衬线，保持纤细和克制。"
      ],
      color: [
        "底色纯黑偏暖（不是冷蓝黑），高光偏象牙而非纯白。",
        "酒红只闪现在关键位置——像丝绒上的一道折光。"
      ],
      texture: [
        "适合缎面高光、柔雾反射、金属边线和若隐若现的暗纹。",
        "渐变必须极缓极柔，像深夜光线缓缓扩散。"
      ],
      avoid: [
        "禁止所有元素都做成亮面或金属感——那是廉价不是高级。",
        "禁止电商卖点标签和粗暴大字促销语气。"
      ]
    },
    previewExample: {
      kicker: "AFTER DARK",
      title: "Noir Velvet",
      body: "Burgundy gleam, satin black, ivory restraint."
    }
  }),

  createStylePreset({
    id: "deco-gala",
    name: "装饰艺术",
    mood: "漆黑 + 金属几何 + 对称晚宴",
    summary: "Art Deco 的黑金仪式感：轴对称构图、阶梯几何和金属线条在深底上营造舞台灯光般的庄严。",
    keywords: ["黑金对称", "阶梯几何", "金属细线", "舞台仪式"],
    preview: "linear-gradient(135deg, #1f1a16, #3e2f26)",
    tokens: {
      "--bg-primary": "#19150f",
      "--bg-secondary": "#372a20",
      "--text-primary": "#f4eee4",
      "--text-secondary": "#cdbfa8",
      "--text-muted": "#a5907a",
      "--accent": "#c8a04e",
      "--accent-secondary": "#edd9a6",
      "--border": "#7a6238"
    },
    fonts: {
      display: ["Bodoni 72", "Didot", "Times New Roman"],
      body: ["Optima", "Avenir Next", "Helvetica Neue"],
      accent: ["Cormorant Garamond", "Georgia", "Times New Roman"]
    },
    rules: [
      "构图必须围绕中轴展开，上下对称或左右镜像",
      "金色是金属烫印的质感，不是荧光色也不是闪粉",
      "装饰线条精细有节制，像建筑浮雕不像珠宝堆砌"
    ],
    guide: {
      composition: [
        "典型结构：上端徽章或放射形框架，中央主标题，底部信息对齐。",
        "可加入阶梯线条和角花，但对称轴必须清晰。"
      ],
      typography: [
        "标题用高对比细衬线体（Bodoni），副标题用优雅人文无衬线。",
        "字距可略微拉开，营造铭牌感。"
      ],
      color: [
        "主色只有黑、深棕、古金和象牙白四色。",
        "金色应偏黄铜而非亮金——更像老剧院而非首饰店。"
      ],
      texture: [
        "适合金箔细线、放射光和镜面弧形，像舞台帷幕的隐约光泽。",
        "装饰线条可以精细密集，但面积必须小。"
      ],
      avoid: [
        "禁止廉价闪粉和彩虹光泽。",
        "禁止所有地方都做成金色——金色的价值在于稀缺。"
      ]
    },
    previewExample: {
      kicker: "GRAND OPENING",
      title: "Golden Hall",
      body: "Axial symmetry, lacquer black, metallic linework."
    }
  }),

  createStylePreset({
    id: "cyber-pulse",
    name: "赛博脉冲",
    mood: "墨蓝深底 + 荧光青 + 品红脉冲",
    summary: "赛博朋克的高张力界面：深色底上的霓虹描边、HUD 信息块和数字噪点。",
    keywords: ["霓虹描边", "暗底 HUD", "数字噪点", "发光焦点"],
    preview: "linear-gradient(135deg, #0a0d1c, #141e3a)",
    tokens: {
      "--bg-primary": "#080b17",
      "--bg-secondary": "#0f1630",
      "--text-primary": "#f0f6ff",
      "--text-secondary": "#b4d2f8",
      "--text-muted": "#6a9ec5",
      "--accent": "#00e8f0",
      "--accent-secondary": "#ff2a88",
      "--border": "#1e4870"
    },
    fonts: {
      display: ["Menlo", "SFMono-Regular", "Monaco"],
      body: ["Avenir Next", "Segoe UI", "Helvetica Neue"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "高对比但有焦点——不能所有元素都发光",
      "主标题配荧光描边，正文保持清晰不发光",
      "HUD 元素可增加界面包围感，但内容仍优先于装饰"
    ],
    guide: {
      composition: [
        "中心主标题被四周 HUD 信息块包围，形成界面包围感。",
        "可加入透视线、边框扫描线和矩形浮层。"
      ],
      typography: [
        "标题用等宽体或几何无衬线，辅助信息用窄字重堆叠。",
        "大字号可配荧光描边但正文绝对不要加发光效果。"
      ],
      color: [
        "背景深蓝黑，强调色只用青色和品红中的 1-2 种。",
        "青色做主导信号，品红做稀有爆点。"
      ],
      texture: [
        "适合细网格、数码噪点、扫描线和发光分割线。",
        "图形偏直线、矩形、坐标标尺和界面提示。"
      ],
      avoid: [
        "禁止温暖纸张纹理和古典衬线体。",
        "禁止所有元素都发光——那会让主体失焦。"
      ]
    },
    previewExample: {
      kicker: "NIGHT GRID — 2049",
      title: "Pulse Launch",
      body: "Electric cyan, magenta burst, interface tension."
    }
  }),

  createStylePreset({
    id: "midnight-jazz",
    name: "午夜爵士",
    mood: "深海蓝底 + 琥珀暖光 + 铜管质感",
    summary: "深夜酒吧的暖调幽光：深蓝底色上琥珀和象牙白勾勒出爵士俱乐部的亲密感与温度。",
    keywords: ["深蓝夜色", "琥珀灯光", "铜管暖调", "亲密感"],
    preview: "linear-gradient(135deg, #111a28, #1f2d42)",
    tokens: {
      "--bg-primary": "#0e1724",
      "--bg-secondary": "#1a2a3e",
      "--text-primary": "#f2ead8",
      "--text-secondary": "#c8b898",
      "--text-muted": "#8d7e68",
      "--accent": "#d4943a",
      "--accent-secondary": "#e8c87a",
      "--border": "#3d5068"
    },
    fonts: {
      display: ["Iowan Old Style", "Palatino Linotype", "Times New Roman"],
      body: ["Georgia", "Iowan Old Style", "Times New Roman"],
      accent: ["Snell Roundhand", "Zapfino", "Georgia"]
    },
    rules: [
      "暗底上的暖光应像酒吧射灯——集中而非均匀铺满",
      "标题用衬线体保持温度，等宽体用于时间地点等事实信息",
      "琥珀色是主角，蓝色是空气——两者必须有明确的亮暗主次"
    ],
    guide: {
      composition: [
        "适合上部大标题、中部主体信息、底部场次和地点的经典海报结构。",
        "允许一侧留大面积深色负空间，模拟舞台侧幕。"
      ],
      typography: [
        "标题用温暖衬线体，可稍加宽字距营造招牌感。",
        "时间、地点用等宽体做信息条。"
      ],
      color: [
        "底色深蓝而非纯黑——夜色有温度。",
        "琥珀光只打在标题和关键信息上，其余信息用灰暖色。"
      ],
      texture: [
        "可用极淡的纸张纤维感和柔化光晕。",
        "适合细横线分隔、音符元素和招牌式装饰框。"
      ],
      avoid: [
        "禁止日光下的明亮清新感和荧光色。",
        "禁止科技感界面元素——这是模拟世界的声音。"
      ]
    },
    previewExample: {
      kicker: "LATE SESSION — 23:00",
      title: "Blue Note",
      body: "Amber spotlight, deep blue haze, warm brass tones."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  温暖复古系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "vintage-press",
    name: "复古印刷",
    mood: "暖纸底 + 深红墨 + 旧铜",
    summary: "旧海报的油墨温度：暖黄纸底上衬线标题和做旧印痕并存。",
    keywords: ["旧纸底", "油墨红", "衬线招牌", "印刷瑕疵"],
    preview: "linear-gradient(135deg, #f2ece0, #d4c4ae)",
    tokens: {
      "--bg-primary": "#f2ece0",
      "--bg-secondary": "#e3d6c2",
      "--text-primary": "#2a2420",
      "--text-secondary": "#574d42",
      "--text-muted": "#877a6a",
      "--accent": "#b82820",
      "--accent-secondary": "#b2935e",
      "--border": "#c0ad8e"
    },
    fonts: {
      display: ["Iowan Old Style", "Palatino Linotype", "Times New Roman"],
      body: ["Georgia", "Iowan Old Style", "Times New Roman"],
      accent: ["Snell Roundhand", "Zapfino", "Georgia"]
    },
    rules: [
      "允许纸张纹理、装饰边框和细线角标",
      "标题应像老海报招牌——衬线体加宽字距",
      "色彩不超过 4 种，全部偏暖偏旧"
    ],
    guide: {
      composition: [
        "经典印刷海报结构：大标题 + 中央主体 + 底部附注。",
        "可在边缘设置票券边、圆角框或章印式装饰。"
      ],
      typography: [
        "标题用高对比衬线体，字距拉大形成招牌感。",
        "副标题和正文用更稳重的书报字体。"
      ],
      color: [
        "底色暖纸黄，主色限于红棕、铜金和墨黑。",
        "所有颜色应该像旧油墨——低饱和、有温度。"
      ],
      texture: [
        "适合纸张纤维、做旧磨损和压印边框。",
        "可用细线花饰、徽章和邮戳增强年代感。"
      ],
      avoid: [
        "禁止荧光色和现代科技感图形。",
        "禁止纹理和装饰铺满全画面——正文必须可读。"
      ]
    },
    previewExample: {
      kicker: "LATE SESSION",
      title: "Jazz Night",
      body: "Warm stage light, aged paper, brass and tobacco red."
    }
  }),

  createStylePreset({
    id: "midcentury-warm",
    name: "中世纪暖调",
    mood: "奶油底 + 焦糖橙 + 橄榄绿",
    summary: "几何插画与温暖低饱和色的中世纪现代风：纸片拼贴感、友好的几何和乐观的复古气质。",
    keywords: ["低饱和暖色", "几何插画", "纸片拼贴", "友好现代感"],
    preview: "linear-gradient(135deg, #f5ecd9, #deceaf)",
    tokens: {
      "--bg-primary": "#f5ecda",
      "--bg-secondary": "#e0cfb8",
      "--text-primary": "#2b241d",
      "--text-secondary": "#5b5044",
      "--text-muted": "#827568",
      "--accent": "#c56a30",
      "--accent-secondary": "#697e4a",
      "--border": "#a38d72"
    },
    fonts: {
      display: ["Futura", "Gill Sans", "Avenir Next"],
      body: ["Gill Sans", "Helvetica Neue", "Segoe UI"],
      accent: ["Futura", "DIN Alternate", "Avenir Next"]
    },
    rules: [
      "配色偏温暖复古但保持轻松理性的现代气息",
      "允许抽象几何和纸片拼贴块面参与构图",
      "标题与图形之间要轻快而非压迫"
    ],
    guide: {
      composition: [
        "适合块面错位、圆角有机形和悬浮文本框的组合。",
        "插画和文字可互相嵌套，形成海报感。"
      ],
      typography: [
        "标题用几何无衬线或复古人文无衬线（Futura/Gill Sans）。",
        "正文温和易读，避免过度工业化。"
      ],
      color: [
        "奶油白、陶土橙、橄榄绿、棕褐——像印刷拼贴色而非数码渐变。",
        "所有颜色的饱和度控制在 40-60% 之间。"
      ],
      texture: [
        "适合纸片边缘、丝网颗粒和轻微错版。",
        "几何插画应简化为基本形，不走写实路线。"
      ],
      avoid: [
        "禁止荧光高纯度色和深色科技感背景。",
        "禁止堆满元素——保留呼吸感是这个风格的核心。"
      ]
    },
    previewExample: {
      kicker: "CITY SERIES / VOL. 3",
      title: "Warm Geometry",
      body: "Cut-paper shapes, olive accents, gentle retro optimism."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  东方美学系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "ink-wash",
    name: "水墨丹青",
    mood: "宣纸底 + 浓墨 + 朱砂 + 石青",
    summary: "中国传统水墨的数字演绎：宣纸质感底色上用墨色层次和朱砂落印营造文人气韵。",
    keywords: ["墨色层次", "宣纸质感", "朱砂印章", "文人留白"],
    preview: "linear-gradient(135deg, #f5efe0, #d8ccb4)",
    tokens: {
      "--bg-primary": "#f5efe0",
      "--bg-secondary": "#e2d8c5",
      "--text-primary": "#1a1812",
      "--text-secondary": "#4a4538",
      "--text-muted": "#7d7566",
      "--accent": "#b83a2a",
      "--accent-secondary": "#2e5c4a",
      "--border": "#a39780"
    },
    fonts: {
      display: ["Songti SC", "STSong", "SimSun"],
      body: ["Songti SC", "STSong", "SimSun"],
      accent: ["Kaiti SC", "STKaiti", "KaiTi"]
    },
    rules: [
      "墨色至少要有浓、中、淡三个层次",
      "留白面积不低于 40%——空白即是意境",
      "朱砂只用于印章或一个视觉焦点"
    ],
    guide: {
      composition: [
        "适合大面积留白配一侧墨色主体的「偏构图」。",
        "印章元素放在右下或左上角落，像落款一样自然。"
      ],
      typography: [
        "标题用宋体营造刻本感，局部可用楷体作为题签。",
        "行距和段距比常规拉大 30%，让气息松弛。"
      ],
      color: [
        "底色宣纸暖白，墨色由浓到淡形成焦、浓、重、淡、清五墨。",
        "朱砂只做印章，石青石绿只做极小面积点缀。"
      ],
      texture: [
        "适合宣纸纤维感、墨晕扩散和水迹渐变。",
        "纹理应柔和自然，像真实纸面而非滤镜效果。"
      ],
      avoid: [
        "禁止高饱和霓虹色和硬边几何图案。",
        "禁止用西文无衬线体破坏东方气韵。"
      ]
    },
    previewExample: {
      kicker: "丹 / 青 / 墨 / 韵",
      title: "Ink Garden",
      body: "Rice paper breath, vermilion seal, five shades of ink."
    }
  }),

  createStylePreset({
    id: "wabi-sabi",
    name: "侘寂",
    mood: "灰暖底 + 焦茶 + 枯色 + 极致留白",
    summary: "日式侘寂的不完美之美：灰暖底色上用焦茶和枯叶色营造安静、克制、接近自然的氛围。",
    keywords: ["灰暖底", "焦茶墨", "枯色点缀", "不完美之美"],
    preview: "linear-gradient(135deg, #eee9df, #d1c8b8)",
    tokens: {
      "--bg-primary": "#ece7dd",
      "--bg-secondary": "#d8d0c2",
      "--text-primary": "#1e1b16",
      "--text-secondary": "#534d42",
      "--text-muted": "#7f7668",
      "--accent": "#a3572e",
      "--accent-secondary": "#3a5c52",
      "--border": "#968b78"
    },
    fonts: {
      display: ["Hiragino Mincho ProN", "Songti SC", "Times New Roman"],
      body: ["Hiragino Sans GB", "PingFang SC", "Segoe UI"],
      accent: ["Kaiti SC", "Songti SC", "Georgia"]
    },
    rules: [
      "留白面积至少占画面 50%——空白是最重要的元素",
      "装饰克制到几乎没有，只留最必要的信息",
      "所有颜色都像从自然中提取——泥土、枯叶、石苔"
    ],
    guide: {
      composition: [
        "主体沿单轴展开，可用一侧竖标题加另一侧正文的平衡结构。",
        "空白区域本身就是构图元素，绝不填充。"
      ],
      typography: [
        "标题优先明朝体或宋体，行距极大让气息松弛。",
        "正文清朗、克制，字重偏轻。"
      ],
      color: [
        "底色灰暖如旧墙面，文字色偏焦茶而非纯黑。",
        "强调色只用一种自然色——赤陶、苔绿或枯黄。"
      ],
      texture: [
        "适合纤维纸、微弱的水洗渐变和和纸边缘。",
        "纹理应像时间留下的痕迹，不像人工添加的效果。"
      ],
      avoid: [
        "禁止明亮高饱和色和密集几何图案。",
        "禁止任何看起来精心打磨过的装饰——侘寂在于不刻意。"
      ]
    },
    previewExample: {
      kicker: "静 / 谧 / 余 / 白",
      title: "Quiet Stone",
      body: "Breathing space, earth tone, the beauty of restraint."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  活力表达系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "pop-burst",
    name: "波普炸裂",
    mood: "高饱和撞色 + 几何色块 + 夸张标题",
    summary: "跳跃、大胆、充满能量的视觉冲击：高饱和色块拼贴、夸张字号和贴纸感装饰。",
    keywords: ["高饱和撞色", "几何色块", "贴纸感", "夸张标题"],
    preview: "linear-gradient(135deg, #fff3d0, #ffd5be)",
    tokens: {
      "--bg-primary": "#fff4d2",
      "--bg-secondary": "#ffd6c0",
      "--text-primary": "#141214",
      "--text-secondary": "#3b3440",
      "--text-muted": "#6d6078",
      "--accent": "#ff5f28",
      "--accent-secondary": "#0070ff",
      "--border": "#131018"
    },
    fonts: {
      display: ["Gill Sans", "Arial Rounded MT Bold", "Avenir Next"],
      body: ["Avenir Next", "Trebuchet MS", "Segoe UI"],
      accent: ["Marker Felt", "Avenir Next", "Trebuchet MS"]
    },
    rules: [
      "允许 2-4 种高纯度颜色同时出现，但必须有明确主次",
      "标题字号至少为正文的 6 倍——大胆是这个风格的核心",
      "装饰可以密集但整体重心必须稳定"
    ],
    guide: {
      composition: [
        "内容块可以错位、层叠和穿插，但版心重心必须稳定。",
        "主标题足够大胆，辅助信息像贴纸一样散布在周边。"
      ],
      typography: [
        "标题用圆润粗体无衬线或手写感字体，允许适度倾斜。",
        "正文保持简洁——色块太多时文字必须更安静。"
      ],
      color: [
        "背景偏暖浅色（浅黄、浅粉），给彩色贴片提供呼吸空间。",
        "橙红做主色、蓝做辅色、黄做背景——像经典波普三色。"
      ],
      texture: [
        "适合圆角贴纸、漫画框、涂鸦箭头和几何碎片。",
        "边界可以硬朗，但材质不要写实。"
      ],
      avoid: [
        "禁止沉重深色背景和复杂写实纹理。",
        "禁止同时使用超过 3 种字体风格。"
      ]
    },
    previewExample: {
      kicker: "HEY / LOOK HERE",
      title: "Color Burst",
      body: "Punchy blocks, sticker energy, cheerful high contrast."
    }
  }),

  createStylePreset({
    id: "memphis-pattern",
    name: "孟菲斯图案",
    mood: "浅粉底 + 跳色几何 + 波点锯齿",
    summary: "八十年代后现代的高辨识度风格：波点、锯齿和跳跃色块形成图案化系统。",
    keywords: ["后现代图案", "波点锯齿", "跳色几何", "八十年代"],
    preview: "linear-gradient(135deg, #fff5ed, #ffe0ef)",
    tokens: {
      "--bg-primary": "#fff5ec",
      "--bg-secondary": "#ffe1ee",
      "--text-primary": "#161018",
      "--text-secondary": "#403848",
      "--text-muted": "#706278",
      "--accent": "#ff5030",
      "--accent-secondary": "#0085ff",
      "--border": "#161018"
    },
    fonts: {
      display: ["Arial Black", "Avenir Next", "Gill Sans"],
      body: ["Avenir Next", "Trebuchet MS", "Segoe UI"],
      accent: ["Marker Felt", "Gill Sans", "Avenir Next"]
    },
    rules: [
      "图案（波点、折线、斜纹）必须与文字形成系统——不是随机贴花",
      "主信息仍需清晰可读，图案不能抢走标题",
      "构图可以轻微反秩序但版心要稳定"
    ],
    guide: {
      composition: [
        "标题与图案交错，小标签和圆点带穿插其中。",
        "局部错位是风格特征，但不能失去阅读方向。"
      ],
      typography: [
        "标题用夸张粗黑体，辅助文字用简单无衬线平衡图案复杂度。",
        "正文不能太长——图案会压住阅读。"
      ],
      color: [
        "珊瑚橙、天蓝、亮黄、紫粉可以共存但要明确主次。",
        "背景保持浅色（浅粉、浅黄），给图案留呼吸。"
      ],
      texture: [
        "波点、折线、斜纹和彩色碎片是核心语汇。",
        "留出干净区域承载正文——不是每个角落都要有图案。"
      ],
      avoid: [
        "禁止沉重深色底和高端奢华语气。",
        "禁止图案复杂到主标题不可读。"
      ]
    },
    previewExample: {
      kicker: "POSTMODERN PLAY",
      title: "Shape Party",
      body: "Dots, zigzags, playful asymmetry, loud but legible."
    }
  }),

  createStylePreset({
    id: "psychedelic-flow",
    name: "迷幻流动",
    mood: "暖橙底 + 高饱和幻彩 + 液态曲线",
    summary: "六七十年代演出海报的流动曲线与强烈幻彩：沉浸式视觉冲击和音乐感。",
    keywords: ["迷幻流线", "高饱和彩云", "液态曲线", "演出海报"],
    preview: "linear-gradient(135deg, #ffedd0, #ffd0ee)",
    tokens: {
      "--bg-primary": "#fff0d5",
      "--bg-secondary": "#ffd4f0",
      "--text-primary": "#22141c",
      "--text-secondary": "#4c3040",
      "--text-muted": "#7a5566",
      "--accent": "#ff6800",
      "--accent-secondary": "#8c30f0",
      "--border": "#261520"
    },
    fonts: {
      display: ["Cooper Black", "Gill Sans", "Avenir Next"],
      body: ["Gill Sans", "Helvetica Neue", "Segoe UI"],
      accent: ["Georgia", "Times New Roman", "Cooper Black"]
    },
    rules: [
      "主标题要有膨胀感和流动感——像正在融化的字",
      "允许高饱和渐变和曲线装饰，但正文必须清楚可读",
      "整体氛围是演出海报的沉浸感，不是普通商业设计"
    ],
    guide: {
      composition: [
        "中央主标题被流动纹样包裹，信息沿曲线分布。",
        "主体图形和标题关系紧密交织，不是分层摆放。"
      ],
      typography: [
        "标题用圆润、膨胀、波浪感强的字体（Cooper Black 是首选）。",
        "正文必须回归朴素字体——为高强度视觉背景提供锚点。"
      ],
      color: [
        "橙、紫、洋红、酸绿可以组合但要形成色带而非斑点。",
        "大面积幻彩需配合浅底或深块作节奏中和。"
      ],
      texture: [
        "光晕、旋涡、液态曲线、色散和手工印刷边缘。",
        "装饰要强化沉浸感——像站在舞台灯光前。"
      ],
      avoid: [
        "禁止严肃企业视觉和理性网格。",
        "禁止所有信息都卷进迷幻纹样——演出细节必须可读。"
      ]
    },
    previewExample: {
      kicker: "LIVE AT MIDNIGHT",
      title: "Cosmic Echo",
      body: "Liquid lettering, saturated glow, hallucinatory energy."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  力量冲击系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "brutal-slab",
    name: "粗野混凝",
    mood: "混凝土灰底 + 粗黑标题 + 信号橙",
    summary: "建筑粗野主义的视觉对应：粗黑标题、硬边框和模块化信息板。像系统看板而非精致排版。",
    keywords: ["粗黑标题", "模块切割", "混凝土灰", "系统看板"],
    preview: "linear-gradient(135deg, #eeeae3, #d2ccc2)",
    tokens: {
      "--bg-primary": "#edeae3",
      "--bg-secondary": "#d5cfc4",
      "--text-primary": "#101010",
      "--text-secondary": "#353331",
      "--text-muted": "#67635c",
      "--accent": "#111111",
      "--accent-secondary": "#eb5525",
      "--border": "#161412"
    },
    fonts: {
      display: ["Arial Black", "Helvetica Neue", "Avenir Next"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "标题用极粗黑体或强硬无衬线，像浇在墙上的字",
      "信息区块像系统看板一样被粗边框切分管理",
      "装饰服务于力量感而非精致感"
    ],
    guide: {
      composition: [
        "以矩形网格粗线切分版面，形成主区块与辅助区块。",
        "标题可以覆盖多个模块边界——制造压迫感。"
      ],
      typography: [
        "标题极粗黑体大写，正文回归干净标准字。",
        "允许编号和警示字样强化工业语气。"
      ],
      color: [
        "黑、灰、混凝土白为主，橙红只做警示焦点。",
        "强调色像安全标记——不是氛围色。"
      ],
      texture: [
        "粗分割线、裁切标、坐标号和条码感元素。",
        "材质保持冷硬平面感，极少纹理。"
      ],
      avoid: [
        "禁止温柔阴影、圆润可爱和花哨渐变。",
        "禁止每个区块风格不同——必须像同一系统。"
      ]
    },
    previewExample: {
      kicker: "PUBLIC SYSTEM / 03",
      title: "Raw Module",
      body: "Heavy type, brutal grid, no decorative softness."
    }
  }),

  createStylePreset({
    id: "agitprop-red",
    name: "构成主义海报",
    mood: "牛皮纸底 + 信号红 + 黑色斜切",
    summary: "斜向切割、对角线动势和宣传标语的冲击力。红与黑在牛皮纸底上形成推进感。",
    keywords: ["斜切构图", "宣传标语", "对角动势", "红黑对比"],
    preview: "linear-gradient(135deg, #f1ebe2, #d8cfc0)",
    tokens: {
      "--bg-primary": "#f1ebe2",
      "--bg-secondary": "#dbd3c3",
      "--text-primary": "#0f0f0f",
      "--text-secondary": "#37332e",
      "--text-muted": "#6d665a",
      "--accent": "#cf2b20",
      "--accent-secondary": "#1a1a1a",
      "--border": "#15120f"
    },
    fonts: {
      display: ["Helvetica Neue", "Arial Black", "Avenir Next"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "对角线是核心构图工具——标题沿对角线推进",
      "红色承担最强烈的动势焦点，黑色做骨架",
      "信息要像宣传口号一样明确有压迫力"
    ],
    guide: {
      composition: [
        "用斜向大块面切开版面，制造视觉动势和紧迫感。",
        "副信息堆叠成口号条、编号条或标记带。"
      ],
      typography: [
        "标题用粗重无衬线大写，允许压缩和切边处理。",
        "正文不宜松散——应像公告一样紧凑有力。"
      ],
      color: [
        "牛皮纸底 + 黑色 + 红色构成全部色彩空间。",
        "红色面积应集中在一个区域形成爆发点。"
      ],
      texture: [
        "粗纸感、丝网印刷颗粒和印刷错位。",
        "图形偏切割、箭头、光束和扇形构成语言。"
      ],
      avoid: [
        "禁止柔和阴影和优雅装饰细节。",
        "禁止构图太温吞或完全对称——需要不安定的推进感。"
      ]
    },
    previewExample: {
      kicker: "OPEN CALL / PUBLIC PROGRAM",
      title: "Forward Motion",
      body: "Diagonal force, rallying headline, red signal block."
    }
  }),

  createStylePreset({
    id: "xerox-manifesto",
    name: "复印宣言",
    mood: "黑白复印 + 手工拼贴 + 批注红",
    summary: "粗粒度复印、手写批注和撕贴边缘的地下刊物气质。DIY 的粗糙本身就是态度。",
    keywords: ["复印噪点", "手工拼贴", "批注感", "地下态度"],
    preview: "linear-gradient(135deg, #f0ece6, #d4cfc6)",
    tokens: {
      "--bg-primary": "#f0ece6",
      "--bg-secondary": "#d5d0c8",
      "--text-primary": "#0e0e0e",
      "--text-secondary": "#323232",
      "--text-muted": "#64605c",
      "--accent": "#0f0f0f",
      "--accent-secondary": "#c52e22",
      "--border": "#121212"
    },
    fonts: {
      display: ["Arial Black", "Impact", "Helvetica Neue"],
      body: ["Arial", "Helvetica Neue", "Segoe UI"],
      accent: ["Marker Felt", "Menlo", "SFMono-Regular"]
    },
    rules: [
      "画面以黑白为绝对主导，红色只做手写标记",
      "允许粗颗粒、撕贴边缘和复印扭曲感",
      "版式应像真实地下小志——粗糙但有态度"
    ],
    guide: {
      composition: [
        "撕裂块、错位图片和手写便签叠加成层。",
        "重心集中，避免所有元素四散无序。"
      ],
      typography: [
        "标题用极粗黑体，配手写批注和打字机感小字。",
        "正文像标语、清单和声明——短而有力。"
      ],
      color: [
        "黑白灰占 90% 以上，红色只用于圆圈、下划线和批注。",
        "绝不做成彩色贴纸风——这是反体制的粗糙感。"
      ],
      texture: [
        "复印颗粒、脏边、胶带和订书钉痕迹。",
        "纹理可以粗但主体内容必须可读。"
      ],
      avoid: [
        "禁止高端精致排版和光滑数码表面。",
        "禁止柔和渐变和圆角卡片。"
      ]
    },
    previewExample: {
      kicker: "DIY ISSUE / COPY 09",
      title: "Noise Sheet",
      body: "Xerox grain, taped notes, manifesto energy."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  自然柔和系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "botanical-romance",
    name: "植物浪漫",
    mood: "奶油白底 + 鼠尾草绿 + 玫瑰粉",
    summary: "植物环绕的柔和浪漫：奶油底色上枝叶与花朵为文字做框景，纤细排印和轻柔色调。",
    keywords: ["花叶框景", "奶油底色", "纤细排印", "轻柔浪漫"],
    preview: "linear-gradient(135deg, #f9f4ec, #dde5d5)",
    tokens: {
      "--bg-primary": "#f9f4ec",
      "--bg-secondary": "#dce4d4",
      "--text-primary": "#222e26",
      "--text-secondary": "#4a5a4e",
      "--text-muted": "#748378",
      "--accent": "#ba6b78",
      "--accent-secondary": "#789a74",
      "--border": "#b3bfac"
    },
    fonts: {
      display: ["Cormorant Garamond", "Iowan Old Style", "Times New Roman"],
      body: ["Optima", "Avenir Next", "Helvetica Neue"],
      accent: ["Snell Roundhand", "Kaiti SC", "Georgia"]
    },
    rules: [
      "画面要轻、透、柔和——浪漫感来自呼吸而非拥挤",
      "植物元素围绕内容做框景，不盖住文字",
      "标题和正文保持优雅纤细的比例关系"
    ],
    guide: {
      composition: [
        "适合中央正文配四角枝叶环绕，或对角植物框景。",
        "内容区保持开阔——留白比装饰更重要。"
      ],
      typography: [
        "标题用高雅衬线体，正文用清爽人文无衬线。",
        "行距和边距比常规略松 20%，营造轻柔感。"
      ],
      color: [
        "底色奶油白，强调色偏玫瑰豆沙或鼠尾草绿。",
        "整体饱和度控制在 30-45% 之间——轻柔不刺眼。"
      ],
      texture: [
        "植物压纹、淡水彩花叶、纸边阴影和纱感渐变。",
        "线条宜细、阴影宜柔、边缘宜模糊。"
      ],
      avoid: [
        "禁止硬朗工业边框和荧光色。",
        "禁止花叶元素挤压正文阅读空间。"
      ]
    },
    previewExample: {
      kicker: "BOTANICAL LETTER",
      title: "Soft Meadow",
      body: "Cream paper, rose tint, leaves framing the margins."
    }
  }),

  createStylePreset({
    id: "nordic-calm",
    name: "北欧宁静",
    mood: "冷灰白底 + 雾蓝 + 松木暖",
    summary: "斯堪的纳维亚设计的克制与温度：冷灰白底色上用雾蓝和松木色营造安静理性又不失温暖的氛围。",
    keywords: ["冷灰白底", "雾蓝点缀", "松木暖调", "功能美学"],
    preview: "linear-gradient(135deg, #f0f2f4, #d4dce2)",
    tokens: {
      "--bg-primary": "#f0f2f4",
      "--bg-secondary": "#d8dfe5",
      "--text-primary": "#1a2028",
      "--text-secondary": "#454e58",
      "--text-muted": "#76818c",
      "--accent": "#5a8a9a",
      "--accent-secondary": "#b8946a",
      "--border": "#aeb8c2"
    },
    fonts: {
      display: ["Avenir Next", "Gill Sans", "Segoe UI"],
      body: ["Avenir Next", "Helvetica Neue", "Segoe UI"],
      accent: ["Georgia", "Iowan Old Style", "Times New Roman"]
    },
    rules: [
      "克制是核心——每个元素都必须证明自己存在的必要性",
      "冷色基调上用一点松木暖作为人性化平衡",
      "功能优先于装饰，但功能本身应该是美的"
    ],
    guide: {
      composition: [
        "大量留白配精确对齐的少量信息块。",
        "适合居中单列或两栏，边距极宽。"
      ],
      typography: [
        "标题用中等字重的人文无衬线，不要太粗也不要太细。",
        "局部可用一款衬线体做温暖的反差。"
      ],
      color: [
        "冷灰白为底，雾蓝做功能性强调，松木色做温暖点缀。",
        "整个画面的色彩纯度极低——一切都像被雾气笼罩。"
      ],
      texture: [
        "材质极轻，可有木纹或织物的微弱暗示。",
        "纹理应是触觉联想而非视觉噪音。"
      ],
      avoid: [
        "禁止高饱和色、粗重装饰和密集图案。",
        "禁止让画面看起来冰冷无温度——北欧不等于冷酷。"
      ]
    },
    previewExample: {
      kicker: "HOME / SPACE / LIGHT",
      title: "Pine & Fog",
      body: "Muted cool tones, warm wood accent, functional beauty."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  科技未来系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "glass-tech",
    name: "毛玻璃科技",
    mood: "冷白蓝底 + 半透明分层 + 电蓝焦点",
    summary: "未来产品界面的科技感：毛玻璃面板、半透明分层和精确参数排版。干净克制而非赛博喧闹。",
    keywords: ["毛玻璃", "半透明分层", "产品界面", "精确参数"],
    preview: "linear-gradient(135deg, #eef3fa, #d0dcea)",
    tokens: {
      "--bg-primary": "#eff4fb",
      "--bg-secondary": "#d5e0ed",
      "--text-primary": "#112030",
      "--text-secondary": "#385266",
      "--text-muted": "#6f869c",
      "--accent": "#2878ff",
      "--accent-secondary": "#70c2ff",
      "--border": "#a2b6ca"
    },
    fonts: {
      display: ["Avenir Next", "Helvetica Neue", "Segoe UI"],
      body: ["IBM Plex Sans", "Avenir Next", "Segoe UI"],
      accent: ["SFMono-Regular", "Menlo", "Monaco"]
    },
    rules: [
      "分层感来自半透明面板和细边框，而非粗暴阴影",
      "信息布局像产品界面——模块化、留白充分、清晰可读",
      "高级科技感 ≠ 喧闹霓虹"
    ],
    guide: {
      composition: [
        "主信息区配 1-2 个辅助数据面板，像产品发布页。",
        "面板之间保持整齐边界和充足间距。"
      ],
      typography: [
        "标题简洁现代，正文使用稳定可读的系统无衬线。",
        "数字和参数用等宽体强调技术感。"
      ],
      color: [
        "蓝白灰体系，强调色只用在按钮或指示标签。",
        "整体对比保持清爽——不过暗不过亮。"
      ],
      texture: [
        "毛玻璃效果、细边线、模糊光晕和轻薄投影。",
        "纹理必须极轻——重点是分层感而非图案。"
      ],
      avoid: [
        "禁止赛博朋克式夸张发光和彩色噪点。",
        "禁止做成普通企业 PPT 或 Dashboard UI。"
      ]
    },
    previewExample: {
      kicker: "DEVICE PREVIEW / 2026",
      title: "Ambient Panel",
      body: "Frosted layers, blue-white restraint, system-font precision."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  特殊氛围系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "terracotta-earth",
    name: "陶土大地",
    mood: "赤陶底 + 奶油文字 + 深棕骨架",
    summary: "地中海陶土的温暖质感：赤陶色底上用奶油白文字和深棕线条勾勒自然、手工和大地的厚重。",
    keywords: ["赤陶底色", "大地色系", "手工质感", "自然厚重"],
    preview: "linear-gradient(135deg, #d4a07a, #b5805c)",
    tokens: {
      "--bg-primary": "#c8936a",
      "--bg-secondary": "#b07e58",
      "--text-primary": "#faf2e8",
      "--text-secondary": "#e8d5c0",
      "--text-muted": "#c0a88e",
      "--accent": "#f5e6d0",
      "--accent-secondary": "#4a3020",
      "--border": "#8a6040"
    },
    fonts: {
      display: ["Gill Sans", "Avenir Next", "Helvetica Neue"],
      body: ["Avenir Next", "Helvetica Neue", "Segoe UI"],
      accent: ["Georgia", "Iowan Old Style", "Times New Roman"]
    },
    rules: [
      "底色就是陶土色——整个画面建立在中等明度的暖色之上",
      "文字用奶油白而非纯白，骨架用深棕而非纯黑",
      "所有颜色都像从泥土和矿物中提取"
    ],
    guide: {
      composition: [
        "适合居中的大标题配底部信息条。",
        "版面不要太复杂——大地的美在于简单和厚重。"
      ],
      typography: [
        "标题用人文无衬线（Gill Sans），正文同系。",
        "局部可用衬线体做温暖的文艺反差。"
      ],
      color: [
        "赤陶色底占主体，奶油白和深棕构成文字色系。",
        "禁止冷色——这个风格只有暖色。"
      ],
      texture: [
        "适合陶土颗粒感、手工压痕和粗纸纤维。",
        "纹理应像真实材料表面而非数码滤镜。"
      ],
      avoid: [
        "禁止冷蓝色、科技感和硬边几何。",
        "禁止过多装饰——大地感来自色彩和材质，不来自堆砌。"
      ]
    },
    previewExample: {
      kicker: "EARTH / CRAFT / FIRE",
      title: "Red Clay",
      body: "Terracotta ground, cream text, honest mineral warmth."
    }
  }),

  createStylePreset({
    id: "lavender-dusk",
    name: "薰衣草黄昏",
    mood: "灰紫底 + 暖金 + 柔光",
    summary: "黄昏天空的灰紫与温暖金光并存：柔和的灰紫底色上用暖金色做点睛。",
    keywords: ["灰紫底色", "暖金点缀", "柔光质感", "黄昏氛围"],
    preview: "linear-gradient(135deg, #e6dce8, #d0c4d8)",
    tokens: {
      "--bg-primary": "#e8dee9",
      "--bg-secondary": "#d5c8da",
      "--text-primary": "#2a2232",
      "--text-secondary": "#504560",
      "--text-muted": "#7e7290",
      "--accent": "#c09850",
      "--accent-secondary": "#7e6ab0",
      "--border": "#b8a8c5"
    },
    fonts: {
      display: ["Cormorant Garamond", "Didot", "Times New Roman"],
      body: ["Optima", "Avenir Next", "Helvetica Neue"],
      accent: ["Snell Roundhand", "Georgia", "Times New Roman"]
    },
    rules: [
      "底色是灰紫而非纯紫——像黄昏天空不像糖果",
      "暖金色只做最关键的 1-2 处点缀",
      "整体气质优雅安静，不可太甜太嗲"
    ],
    guide: {
      composition: [
        "适合居中对称或上下三分的静谧构图。",
        "信息量克制——这个风格不适合高密度排版。"
      ],
      typography: [
        "标题用纤细高衬线体，正文用轻量人文无衬线。",
        "可在题签或装饰位置使用一小段手写体。"
      ],
      color: [
        "灰紫底色占大面积，暖金只用在标题装饰线或小图标。",
        "文字色偏深紫而非纯黑，保持整体色温统一。"
      ],
      texture: [
        "柔光渐变、轻雾效果和若隐若现的丝绸纹理。",
        "装饰元素应是光的暗示而非具象图案。"
      ],
      avoid: [
        "禁止粗重工业元素和冷硬黑灰。",
        "禁止太多糖果色——灰紫的优雅在于克制。"
      ]
    },
    previewExample: {
      kicker: "SCENT / LIGHT / CALM",
      title: "Dusk Gold",
      body: "Muted lavender field, warm gold trace, quiet luxury."
    }
  }),

  // ═══════════════════════════════════════════════════
  //  动画风格系
  // ═══════════════════════════════════════════════════

  createStylePreset({
    id: "anime-sky",
    name: "青空物语",
    mood: "天蓝渐变底 + 樱粉 + 逆光留白",
    summary: "新海诚式的清透天空：逆光边缘、轻盈留白和青春群像感。",
    keywords: ["清透天空", "逆光边缘", "青春群像", "日系清新"],
    preview: "linear-gradient(135deg, #f2f9ff, #d8edff)",
    tokens: {
      "--bg-primary": "#f2f9ff",
      "--bg-secondary": "#dcedff",
      "--text-primary": "#1e2e48",
      "--text-secondary": "#4d6480",
      "--text-muted": "#7b90a8",
      "--accent": "#ff78a5",
      "--accent-secondary": "#68b5ff",
      "--border": "#b4c8e0"
    },
    fonts: {
      display: ["Avenir Next", "Hiragino Sans GB", "PingFang SC"],
      body: ["Hiragino Sans GB", "PingFang SC", "Segoe UI"],
      accent: ["Kaiti SC", "Georgia", "Avenir Next"]
    },
    rules: [
      "画面清透轻盈——标题和信息不要压住主视觉",
      "允许天空、云层、光晕和花瓣等青春动画语汇",
      "氛围柔和明亮，绝非厚重写实"
    ],
    guide: {
      composition: [
        "角色立于大面积天空或留白前景，标题轻柔漂浮在边缘。",
        "可用对角线风、光线或花瓣轨迹带动情绪。"
      ],
      typography: [
        "标题用圆润现代无衬线，副文案和角色名轻巧清晰。",
        "信息精简——像番宣 KV 而非说明书。"
      ],
      color: [
        "天空蓝、白、樱粉、淡金和浅灰蓝构成色彩空间。",
        "高亮色偏柔和——不要变成荧光糖果色。"
      ],
      texture: [
        "薄雾、逆光、柔焦、云层渐层和轻微胶片颗粒。",
        "装饰是情绪氛围而非图案。"
      ],
      avoid: [
        "禁止工业硬边、粗重黑框和过深底色。",
        "禁止信息密集排布——这不是企业海报。"
      ]
    },
    previewExample: {
      kicker: "SUMMER STORY / EP. 01",
      title: "Blue Horizon",
      body: "Sky light, soft breeze, youthful distance and quiet emotion."
    }
  }),

  createStylePreset({
    id: "anime-impact",
    name: "热血冲击",
    mood: "暖白底 + 赤红爆发 + 电黄速度线",
    summary: "少年漫画的高能视觉：速度线、爆发框和夸张标题构成冲击力。",
    keywords: ["速度线", "爆发冲击", "热血标语", "漫画分镜感"],
    preview: "linear-gradient(135deg, #fff5ec, #ffe0c5)",
    tokens: {
      "--bg-primary": "#fff5ec",
      "--bg-secondary": "#ffe0c5",
      "--text-primary": "#151010",
      "--text-secondary": "#453535",
      "--text-muted": "#786562",
      "--accent": "#e53820",
      "--accent-secondary": "#eec018",
      "--border": "#161010"
    },
    fonts: {
      display: ["Arial Black", "Helvetica Neue", "Avenir Next"],
      body: ["Helvetica Neue", "Arial", "Segoe UI"],
      accent: ["Impact", "Arial Black", "Menlo"]
    },
    rules: [
      "标题和标语必须有爆发力——大字号、强对比",
      "速度线和冲击框辅助动势，但主体信息必须稳定可读",
      "画面像漫画封面页而非日常企业海报"
    ],
    guide: {
      composition: [
        "用对角动势、放射构图和冲击框推动视线。",
        "信息像分镜字幕一样贴在关键位置。"
      ],
      typography: [
        "标题极粗黑体大写，允许手绘漫画感字形。",
        "正文回归标准字体——爆点的力量在于对比。"
      ],
      color: [
        "黑白灰做骨架，赤红和电黄承担热血爆发点。",
        "辅助色宜少——让冲击色更集中。"
      ],
      texture: [
        "速度线、喷墨、爆裂框、颗粒和高反差斜纹。",
        "不要每个区块都做成爆点——高潮需要铺垫。"
      ],
      avoid: [
        "禁止柔和奶油系和低对比纤细纹理。",
        "禁止版面杂乱无章——冲击力来自聚焦不是散射。"
      ]
    },
    previewExample: {
      kicker: "NEXT MATCH / ROUND 07",
      title: "Burst Mode",
      body: "Impact lines, loud contrast, one-step-before-breakthrough."
    }
  }),

  createStylePreset({
    id: "anime-kawaii",
    name: "偶像甜彩",
    mood: "糖果粉底 + 薄荷蓝 + 星光闪片",
    summary: "轻甜偶像的舞台视觉：糖果配色、闪亮贴纸和节奏化标题。",
    keywords: ["糖果色", "星光贴纸", "偶像舞台", "可爱节奏"],
    preview: "linear-gradient(135deg, #fff3fa, #e0f4ff)",
    tokens: {
      "--bg-primary": "#fff3f9",
      "--bg-secondary": "#e2f5ff",
      "--text-primary": "#382550",
      "--text-secondary": "#684a7a",
      "--text-muted": "#8e709e",
      "--accent": "#ff60aa",
      "--accent-secondary": "#50c4f0",
      "--border": "#d4bee2"
    },
    fonts: {
      display: ["Arial Rounded MT Bold", "Avenir Next", "Hiragino Sans GB"],
      body: ["Avenir Next", "PingFang SC", "Segoe UI"],
      accent: ["Marker Felt", "Kaiti SC", "Arial Rounded MT Bold"]
    },
    rules: [
      "画面轻快闪亮但不能因装饰过多失去主体",
      "标题和角色名应有舞台感和应援感",
      "星星、心形和贴纸块要有主次，不可均匀铺满"
    ],
    guide: {
      composition: [
        "中央活动名或角色名，四周围绕应援贴纸和信息标签。",
        "标题和日期可做成贴片式层叠结构。"
      ],
      typography: [
        "标题用圆润粗体或手写感可爱字体。",
        "辅助信息整洁——不能全部做成花字。"
      ],
      color: [
        "粉、蓝、奶白、淡黄构成轻甜但不刺眼的组合。",
        "高亮色控制在 2 种以内——不是杂色拼盘。"
      ],
      texture: [
        "亮片星点、糖纸反光和气泡形贴纸。",
        "装饰应像舞台应援道具而非幼儿海报。"
      ],
      avoid: [
        "禁止深黑重金属配色和工业硬边。",
        "禁止所有元素同等可爱——主标题必须最有识别度。"
      ]
    },
    previewExample: {
      kicker: "LIVE TOUR / FAN DAY",
      title: "Star Candy",
      body: "Sweet pastel, sticker rhythm, cheerful idol stage energy."
    }
  }),

  createStylePreset({
    id: "mecha-briefing",
    name: "机甲简报",
    mood: "钢灰底 + 信号橙 + 荧光青 + 编号系统",
    summary: "机库设定稿的冷硬秩序：参数标签、编号系统和战术界面图层。",
    keywords: ["机甲设定", "参数标签", "战术界面", "冷硬编号"],
    preview: "linear-gradient(135deg, #e8edf2, #c2ced8)",
    tokens: {
      "--bg-primary": "#e9eef3",
      "--bg-secondary": "#c6d0da",
      "--text-primary": "#141e28",
      "--text-secondary": "#3e5260",
      "--text-muted": "#6e808e",
      "--accent": "#ff8825",
      "--accent-secondary": "#28c5ff",
      "--border": "#7c92a5"
    },
    fonts: {
      display: ["DIN Alternate", "Avenir Next", "Helvetica Neue"],
      body: ["IBM Plex Sans", "Helvetica Neue", "Segoe UI"],
      accent: ["Menlo", "SFMono-Regular", "Monaco"]
    },
    rules: [
      "强调编号、参数和战术信息的系统感",
      "允许局部界面化元素，但主体仍是平面海报而非软件界面",
      "色彩偏军规工业——不做夜店霓虹化"
    ],
    guide: {
      composition: [
        "中央主体配周围技术标注、侧栏参数和任务编码。",
        "模块关系像设定稿——不是普通广告页。"
      ],
      typography: [
        "标题用窄体无衬线或编号感字体（DIN），参数用等宽体。",
        "正文像任务说明——干净利落的短句。"
      ],
      color: [
        "钢灰、军蓝为底，信号橙和青蓝做警示焦点。",
        "色彩偏技术工业——不甜不华丽。"
      ],
      texture: [
        "编号贴纸、磨损金属暗示、扫描线和边框角标。",
        "纹理服务于工业设定感——不是脏乱旧化。"
      ],
      avoid: [
        "禁止大面积暖纸旧海报质感。",
        "禁止所有区块都做成 HUD——仍需有海报主次。"
      ]
    },
    previewExample: {
      kicker: "UNIT 07 / OPERATION FILE",
      title: "TACTICAL FRAME",
      body: "Spec labels, hard numbering, cold deployment atmosphere."
    }
  })
];

export const assetLibrary = {
  fonts: [
    "Avenir Next",
    "Iowan Old Style",
    "Georgia",
    "Menlo",
    "Didot",
    "Bodoni 72",
    "Cormorant Garamond",
    "Optima",
    "Futura",
    "DIN Alternate",
    "IBM Plex Sans",
    "Songti SC",
    "Hiragino Sans GB",
    "Gill Sans"
  ],
  decorations: [
    { id: "corner-ornament-art-deco", label: "Art Deco 角花", type: "svg" },
    { id: "divider-wave", label: "波浪形分隔线", type: "svg" },
    { id: "border-double-line", label: "双线装饰边框", type: "css" },
    { id: "seal-stamp", label: "印章圆环", type: "svg" },
    { id: "grid-crosshair", label: "网格十字标", type: "svg" }
  ],
  textures: [
    { id: "texture-noise-grain", label: "纸张噪点纹理", type: "css" },
    { id: "texture-soft-grid", label: "柔和网格", type: "css" },
    { id: "texture-radial-glow", label: "霓虹光晕", type: "css" },
    { id: "texture-ink-wash", label: "墨迹渐变", type: "css" }
  ],
  icons: [
    { id: "icon-calendar", label: "日历", type: "svg" },
    { id: "icon-location", label: "定位", type: "svg" },
    { id: "icon-ticket", label: "票券", type: "svg" },
    { id: "icon-star", label: "星标", type: "svg" },
    { id: "icon-arrow", label: "箭头", type: "svg" }
  ]
};

export const promptGuidelines = [
  "输出必须是完整 HTML 文档，包含 <!DOCTYPE html>。",
  "html 和 body 必须设置固定画布尺寸与 overflow:hidden。",
  "仅使用原生 HTML/CSS/SVG，不使用外部 JS 框架。",
  "所有文本需保持可编辑，不能转成位图。",
  "正文最小字号 14px，文本与背景对比度建议大于 4.5:1。",
  "视觉层级控制在 4 层以内。"
];

export const defaultProject = {
  styleId: ""
};

export function getStyle(styleId) {
  return stylePresets.find((style) => style.id === styleId) ?? stylePresets[0];
}

export function findSizePreset(sizeId, customSize = null) {
  if (sizeId === "custom" && customSize) {
    return createCustomSize(customSize);
  }
  if (!sizeId) {
    return null;
  }
  return defaultSizePresets.find((size) => size.id === sizeId) || null;
}

export function getCatalogSnapshot() {
  return {
    styles: stylePresets,
    assets: assetLibrary,
    defaults: defaultProject
  };
}
