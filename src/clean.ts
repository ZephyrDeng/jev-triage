/**
 * 确定性的正文清洗：在翻译 / 调用 Jev 之前去掉明显与语义无关的噪音，
 * 控制长度（Jev 的 state + 最长问题上限为 32k token，且大段无关内容会降低准确率）。
 */
export interface CleanOptions {
  /** 清洗后正文最大字符数（按段落截断）。 */
  maxChars?: number;
  /** 代码块保留的最大行数。 */
  maxCodeLines?: number;
  /** summary 命中这些模式的 <details> 块整体删除（机器元数据等）。 */
  dropDetailsSummary?: RegExp;
}

const DEFAULTS: Required<CleanOptions> = {
  maxChars: 4000,
  maxCodeLines: 12,
  dropDetailsSummary: /frontmatter|metadata|元数据|机器可读/i,
};

export function cleanMarkdown(input: string, options: CleanOptions = {}): string {
  const o = { ...DEFAULTS, ...options };
  let t = input.replace(/\r\n?/g, "\n");

  // <details> 机器元数据块
  t = t.replace(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (m, summary: string, body: string) =>
    o.dropDetailsSummary.test(summary) ? "" : `${summary.trim()}\n${body}`,
  );
  // HTML 注释
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  // 截断长代码块
  t = t.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const lines = code.replace(/\n$/, "").split("\n");
    if (lines.length <= o.maxCodeLines) return "```" + lang + "\n" + lines.join("\n") + "\n```";
    const kept = lines.slice(0, o.maxCodeLines).join("\n");
    return "```" + lang + "\n" + kept + `\n... (${lines.length - o.maxCodeLines} more lines)\n` + "```";
  });
  // 图片 / 链接：保留文字
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? `[image: ${alt}]` : "[image]"));
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  // 裸 URL：截短
  t = t.replace(/https?:\/\/[^\s)>\]]+/g, (url) => (url.length > 80 ? url.slice(0, 77) + "..." : url));
  // 残留的 HTML 标签
  t = t.replace(/<\/?(?:br|p|div|span|summary|details|sup|sub|b|i|strong|em)\b[^>]*>/gi, "");
  // 空的模板小节：标题后面紧跟另一个同级或更高级标题 / 结尾
  t = removeEmptySections(t);
  // 空白
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return truncateByParagraph(t, o.maxChars);
}

function removeEmptySections(t: string): string {
  const lines = t.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = /^(#{1,6})\s+\S/.exec(line);
    if (h) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] as string).trim()) j++;
      const nextH = j < lines.length ? /^(#{1,6})\s+\S/.exec(lines[j] as string) : null;
      const empty = j >= lines.length || (nextH && (nextH[1] as string).length <= (h[1] as string).length);
      if (empty) continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function truncateByParagraph(t: string, maxChars: number): string {
  if (t.length <= maxChars) return t;
  const cut = t.lastIndexOf("\n\n", maxChars);
  const end = cut > maxChars * 0.5 ? cut : maxChars;
  return t.slice(0, end).trimEnd() + "\n\n... (truncated)";
}
