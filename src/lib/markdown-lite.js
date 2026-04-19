// 轻量 Markdown 渲染 —— 仅覆盖 AI 会话里常见的那几种记号，先 escape HTML 再做替换，
// 输出的 HTML 适合直接塞 v-html，不拉外部依赖，也不解析任意 HTML。

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// 行内替换：code 用占位符换走避免被 bold/italic 吃掉
function renderInline(text) {
  const codeTokens = [];
  let html = text.replace(/`([^`\n]+?)`/g, (_match, inner) => {
    codeTokens.push(`<code>${inner}</code>`);
    return `\u0000${codeTokens.length - 1}\u0000`;
  });

  // 链接 [text](url) —— 只接受 http(s)
  html = html.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  // 粗体 **text** / __text__
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");

  // 斜体 *text* / _text_（排除单独的 * 和连续 **）
  html = html.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");

  // 还原 code 占位符
  html = html.replace(/\u0000(\d+)\u0000/g, (_m, idx) => codeTokens[Number(idx)] || "");

  return html;
}

export function renderMarkdownLite(raw) {
  const source = String(raw ?? "");
  if (!source.trim()) {
    return "";
  }

  const escaped = escapeHtml(source);
  const lines = escaped.split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const text = paragraph.join("\n");
    out.push(`<p>${renderInline(text).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // 空行 → 分段
    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    // 代码块 ``` ... ```
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1] || "";
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      const langAttr = lang ? ` data-lang="${lang}"` : "";
      out.push(`<pre class="md-pre"${langAttr}><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // 标题 # / ## / ### 最多到 h4（AI 用得少）
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level} class="md-h${level}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用 > text —— escape 之后 ">" 被转成 "&gt;"，匹配需用转义形式
    if (/^&gt;\s?/.test(line)) {
      flushParagraph();
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^&gt;\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(buf.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }

    // 无序列表 - item / * item
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      const items = buf.map((item) => `<li>${renderInline(item)}</li>`).join("");
      out.push(`<ul class="md-ul">${items}</ul>`);
      continue;
    }

    // 有序列表 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      const items = buf.map((item) => `<li>${renderInline(item)}</li>`).join("");
      out.push(`<ol class="md-ol">${items}</ol>`);
      continue;
    }

    // 普通段落
    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return out.join("");
}
