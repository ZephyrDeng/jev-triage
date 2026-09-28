import type { DepGraph, DepJudgment } from "./deps.js";
import type { DuplicateGroup, PairJudgment } from "./dedupe.js";
import type { PreparedIssue } from "./types.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface DedupeReport {
  project: string;
  generatedAt: string;
  model: string | null;
  issueCount: number;
  candidatePairs: number;
  stats: { duplicate: number; review: number; distinct: number; inputTokens: number; apiCalls: number };
  groups: DuplicateGroup[];
  review: PairJudgment[];
  judgments: PairJudgment[];
}

export function renderMarkdown(r: DedupeReport, issues: Map<number, PreparedIssue>): string {
  const link = (iid: number) => {
    const i = issues.get(iid);
    return i ? `[#${iid}](${i.webUrl}) ${i.originalTitle}` : `#${iid}`;
  };
  const lines: string[] = [];
  lines.push(`# Issue 去重报告：${r.project}`, "");
  lines.push(`- 生成时间：${r.generatedAt}`);
  lines.push(`- 模型：${r.model ?? "-"}`);
  lines.push(
    `- issue 数：${r.issueCount}，候选对：${r.candidatePairs}，Jev 调用：${r.stats.apiCalls}（输入 ${r.stats.inputTokens} tokens）`,
  );
  lines.push(`- 判定：重复 ${r.stats.duplicate} / 待确认 ${r.stats.review} / 不同 ${r.stats.distinct}`, "");

  lines.push(`## 重复组（${r.groups.length}）`, "");
  if (!r.groups.length) lines.push("_无_", "");
  for (const [i, g] of r.groups.entries()) {
    lines.push(`### 组 ${i + 1}：建议保留 #${g.canonical}`, "");
    for (const m of g.members) lines.push(`- ${m === g.canonical ? "⭐ " : ""}${link(m)}`);
    lines.push("", "| pair | P(重复) | 同一问题 | 同一模块 | A⊇B | B⊇A |", "|---|---|---|---|---|---|");
    for (const e of g.edges) {
      lines.push(
        `| #${e.a} ↔ #${e.b} | ${pct(e.relation.probabilities[2])} | ${pct(e.sameProblem)} | ${pct(e.sameArea)} | ${pct(e.aCoversB)} | ${pct(e.bCoversA)} |`,
      );
    }
    lines.push("");
  }

  lines.push(`## 待人工确认（${r.review.length}）`, "");
  if (!r.review.length) lines.push("_无_", "");
  for (const j of r.review) {
    const [p0, p1, p2] = j.relation.probabilities;
    lines.push(`- ${link(j.a)}`, `  ↔ ${link(j.b)}`);
    lines.push(
      `  - 不同 ${pct(p0)} / 相关 ${pct(p1)} / 重复 ${pct(p2)}；同一问题 ${pct(j.sameProblem)}，同一模块 ${pct(j.sameArea)}，A⊇B ${pct(j.aCoversB)}，B⊇A ${pct(j.bCoversA)}，文本相似度 ${j.similarity.toFixed(2)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 依赖分析报告
// ---------------------------------------------------------------------------


export interface DepsReport {
  project: string;
  generatedAt: string;
  model: string | null;
  issueCount: number;
  candidatePairs: number;
  stats: { edges: number; review: number; cycles: number; inputTokens: number; apiCalls: number };
  graph: DepGraph;
  review: DepJudgment[];
  judgments: DepJudgment[];
}

const SOURCE_LABEL = { similar: "相似", mention: "引用", link: "平台关联" } as const;

export function renderDepsMarkdown(r: DepsReport, issues: Map<number, PreparedIssue>): string {
  const link = (iid: number) => {
    const i = issues.get(iid);
    return i ? `[#${iid}](${i.webUrl}) ${i.originalTitle}` : `#${iid}`;
  };
  const judged = new Map(r.judgments.map((j) => [`${j.a}-${j.b}`, j]));
  const lines: string[] = [];
  lines.push(`# Issue 依赖分析：${r.project}`, "");
  lines.push(`- 生成时间：${r.generatedAt}`);
  lines.push(`- 模型：${r.model ?? "-"}`);
  lines.push(
    `- issue 数：${r.issueCount}，候选对：${r.candidatePairs}，Jev 调用：${r.stats.apiCalls}（输入 ${r.stats.inputTokens} tokens）`,
  );
  lines.push(`- 依赖边 ${r.stats.edges}，待确认 ${r.stats.review}，循环 ${r.stats.cycles}`, "");

  lines.push(`## 执行顺序（${r.graph.layers.length} 层）`, "");
  lines.push("_按范围内依赖分层，不代表实际开工时间。环须先拆解，范围外或未解析的前置见总览；未出现不等于已确认无依赖。_", "");
  if (!r.graph.layers.length) lines.push("_无_", "");
  r.graph.layers.forEach((layer, i) => {
    lines.push(`**第 ${i + 1} 层**`, "");
    for (const iid of layer) lines.push(`- ${link(iid)}`);
    lines.push("");
  });

  if (r.graph.cycles.length) {
    lines.push(`## ⚠️ 循环依赖（${r.graph.cycles.length}）`, "");
    for (const c of r.graph.cycles) lines.push(`- ${c.map((n) => `#${n}`).join(" ⇄ ")}`);
    lines.push("");
  }

  lines.push(`## 依赖边（${r.graph.edges.length}）`, "", "| 先完成 | → 后完成 | 概率 | 来源 | 明确声明 |", "|---|---|---|---|---|");
  for (const e of r.graph.edges) {
    const j = judged.get(`${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}`);
    const src = e.source === "link" ? "平台关联" : e.source === "declared" ? "正文声明" : (j?.sources.map((s) => SOURCE_LABEL[s]).join("+") ?? "Jev");
    lines.push(`| ${link(e.from)} | ${link(e.to)} | ${pct(e.probability)} | ${src} | ${j ? pct(j.explicit) : "-"} |`);
  }
  lines.push("");

  lines.push(`## 待人工确认（${r.review.length}）`, "");
  if (!r.review.length) lines.push("_无_", "");
  for (const j of r.review) {
    lines.push(`- ${link(j.a)}`, `  ↔ ${link(j.b)}`);
    lines.push(
      `  - #${j.a} 先 ${pct(j.pAB)} / #${j.b} 先 ${pct(j.pBA)} / 无先后 ${pct(j.pNoOrder)} / 无关 ${pct(j.pUnrelated)}；明确声明 ${pct(j.explicit)}；来源 ${j.sources.map((s) => SOURCE_LABEL[s]).join("+")}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
