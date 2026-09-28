import { TYPE_NAME, TYPE_TAG, type IssueClassification, type IssueType } from "./classify.js";
import type { DuplicateGroup, PairJudgment, RelatedGroup } from "./dedupe.js";
import { executionBlockers, type DeclaredStructure, type DepGraph, type DepJudgment } from "./deps.js";
import type { PreparedIssue } from "./types.js";

export interface OverviewInput {
  project: string;
  issues: Map<number, PreparedIssue>;
  types: Map<number, IssueClassification>;
  groups: DuplicateGroup[];
  /** 被合并的 issue → 保留的 issue。 */
  canonicalOf: Map<number, number>;
  /** 依赖图（节点已折叠为保留的 issue）。 */
  graph: DepGraph;
  declared: DeclaredStructure;
  /** 相关主题（功能性合并候选）。 */
  related: RelatedGroup[];
  dupReview: PairJudgment[];
  depReview: DepJudgment[];
  /** 待确认里"可能重复"的最低 P(重复)。 */
  maybeDup?: number;
  /** 标注"包含"关系的最低概率。 */
  covers?: number;
  /** 类型置信度低于该值时标记 "?"。 */
  typeConfidence?: number;
  titleWidth?: number;
  /** 终端输出时的最大行宽（按保守宽度截断每一行）；不传则不截断。 */
  maxWidth?: number;
  /** 待确认最多展示多少条，其余见明细报告。 */
  maxReview?: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;
/** East Asian Ambiguous：部分终端（CJK 字体/设置）按 2 列渲染，如 … — ─ ├ └ │ ▶ ⇢ ■ 等。 */
const AMBIGUOUS = /[\u00a7\u00b7\u2010-\u2027\u2030-\u203e\u2190-\u21ff\u2460-\u24ff\u2500-\u257f\u2580-\u25ff\u2600-\u27bf]/;

/**
 * 终端显示宽度：中日韩及全角字符占 2 列。
 * conservative=true 时把 Ambiguous 符号也按 2 列算，保证在任何终端都不折行。
 */
export function displayWidth(s: string, conservative = false): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) || (conservative && AMBIGUOUS.test(ch)) ? 2 : 1;
  return w;
}

export function truncate(s: string, width: number, conservative = false): string {
  if (displayWidth(s, conservative) <= width) return s;
  const ell = conservative ? "..." : "…";
  const budget = width - displayWidth(ell, conservative);
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch, conservative);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ell;
}

export function renderOverview(o: OverviewInput): string {
  const titleWidth = o.titleWidth ?? 56;
  const maybeDup = o.maybeDup ?? 0.3;
  const coversMin = o.covers ?? 0.6;
  const dupReview = o.dupReview.filter((j) => j.relation.probabilities[2] >= maybeDup);
  const lowConf = o.typeConfidence ?? 0.5;
  const mergedInto = new Map<number, number[]>();
  for (const g of o.groups) mergedInto.set(g.canonical, g.members.filter((m) => m !== g.canonical));

  const tag = (iid: number) => {
    const t = o.types.get(iid);
    if (!t) return "[?]";
    return `[${TYPE_TAG[t.type]}${t.confidence < lowConf ? "?" : ""}]`;
  };
  const title = (iid: number) => truncate(o.issues.get(iid)?.originalTitle ?? "", titleWidth);
  const label = (iid: number, withMerged = true) => {
    const extra = withMerged && mergedInto.get(iid)?.length ? `  (+合并 ${mergedInto.get(iid)!.map((m) => `#${m}`).join(" ")})` : "";
    return `#${iid} ${tag(iid)} ${title(iid)}${extra}`;
  };

  const L: string[] = [];
  const typeCounts = new Map<IssueType, number>();
  for (const t of o.types.values()) typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + 1);

  L.push(`══ Issue 总览：${o.project} ══`);
  L.push(
    `${o.issues.size} 条 · 可合并 ${o.groups.length} 组（${o.groups.reduce((s, g) => s + g.members.length - 1, 0)} 条可关闭）· 依赖 ${o.graph.edges.length} 条`,
  );
  L.push(`相关主题 ${o.related.length} · 循环 ${o.graph.cycles.length} · 待确认 ${dupReview.length + o.depReview.length}`);
  const present = (Object.keys(TYPE_TAG) as IssueType[]).filter((t) => typeCounts.get(t));
  L.push("类型：" + present.map((t) => `${TYPE_TAG[t]} ${typeCounts.get(t)}`).join(" · "));
  L.push("图例：" + present.map((t) => `${TYPE_TAG[t]}=${TYPE_NAME[t]}`).join(" "));
  L.push(`      ? = 类型置信度 < ${pct(lowConf)}`);
  L.push("");

  // 1. 合并
  L.push(`■ 可合并（${o.groups.length} 组）`);
  if (!o.groups.length) L.push("  （无）");
  for (const g of o.groups) {
    L.push(`  ${label(g.canonical, false)}   ← 保留`);
    const others = g.members.filter((m) => m !== g.canonical);
    others.forEach((m, i) => {
      const e = g.edges.find((x) => (x.a === m || x.b === m) && (x.a === g.canonical || x.b === g.canonical)) ?? g.edges.find((x) => x.a === m || x.b === m);
      L.push(`  ${i === others.length - 1 ? "└" : "├"}─⇢ ${label(m, false)}   重复 ${e ? pct(e.relation.probabilities[2]) : "-"}`);
    });
    L.push("");
  }
  if (!o.groups.length) L.push("");

  // 2. 相关主题
  L.push(`■ 相关主题（不重复，但可合并为同一需求/迭代处理，${o.related.length} 组）`);
  if (!o.related.length) L.push("  （无）");
  const c = (n: number) => o.canonicalOf.get(n) ?? n;
  o.related.forEach((g, gi) => {
    L.push(`  主题 ${gi + 1}：${label(g.hub)}`);
    const others = g.members.filter((m) => m !== g.hub);
    others.forEach((m, i) => {
      // 优先展示与中心的关系，否则展示最强的一条
      const mine = g.edges.filter((e) => c(e.a) === m || c(e.b) === m);
      const e =
        mine.find((x) => c(x.a) === g.hub || c(x.b) === g.hub) ??
        mine.sort((x, y) => y.relation.probabilities[1] - x.relation.probabilities[1])[0];
      let note = "";
      if (e) {
        const peer = c(e.a) === m ? c(e.b) : c(e.a);
        const [mCoversPeer, peerCoversM] = c(e.a) === m ? [e.aCoversB, e.bCoversA] : [e.bCoversA, e.aCoversB];
        note = `   相关 ${pct(e.relation.probabilities[1])}${peer !== g.hub ? `（与 #${peer}）` : ""}`;
        if (peerCoversM >= coversMin) note += ` · #${peer} 包含 #${m}`;
        else if (mCoversPeer >= coversMin) note += ` · #${m} 包含 #${peer}`;
      }
      L.push(`  ${i === others.length - 1 ? "└" : "├"}── ${label(m)}${note}`);
    });
    L.push("");
  });
  if (!o.related.length) L.push("");

  // 3. 依赖树
  L.push("■ 依赖关系（A ─▶ B：A 需先完成）");
  if (!o.graph.edges.length) L.push("  （无）", "");
  else L.push(...renderTree(o.graph, (iid) => label(iid)).map((l) => (l ? `  ${l}` : "")), "");

  // 4. 执行顺序
  if (o.graph.layers.length) {
    L.push("■ 依赖分层（环需拆解；范围外前置状态未核实）");
    const blockers = executionBlockers(o.issues, o.graph, o.declared, o.canonicalOf);
    o.graph.layers.forEach((layer, i) => {
      L.push(`  第 ${i + 1} 层：${layer.map((n) => `#${n}${tag(n)}${!blockers.has(n) && o.issues.get(n)?.raw.state === "opened" ? "[未发现前置阻塞]" : ""}`).join("  ")}`);
    });
    L.push("");
  }
  if (o.graph.cycles.length) {
    L.push("■ ⚠ 循环依赖（需要人工拆解）");
    for (const c of o.graph.cycles) L.push(`  ${c.map((n) => `#${n}`).join(" ⇄ ")}`);
    L.push("");
  }

  if (o.declared.unresolved.size) {
    L.push("■ 前置状态待确认（范围外或未解析）");
    for (const [n, reasons] of o.declared.unresolved) L.push(`  #${n}：${reasons.join("；")}`);
    L.push("");
  }

  // 5. 待确认
  if (dupReview.length || o.depReview.length) {
    L.push("■ 待人工确认");
    const items: string[][] = [
      ...dupReview.map((j) => [
        `  ? 可能重复  重复 ${pct(j.relation.probabilities[2])} / 相关 ${pct(j.relation.probabilities[1])}`,
        `      ${label(j.a)}`,
        `    ↔ ${label(j.b)}`,
      ]),
      ...o.depReview.map((j) => {
        const [from, to, p] = j.pAB >= j.pBA ? [j.a, j.b, j.pAB] : [j.b, j.a, j.pBA];
        return [
          `  ? 可能依赖  先后 ${pct(p)} / 无先后 ${pct(j.pNoOrder)} / 无关 ${pct(j.pUnrelated)}`,
          `      ${label(from)}`,
          `    ─▶ ${label(to)}`,
        ];
      }),
    ];
    const maxReview = o.maxReview ?? 10;
    for (const it of items.slice(0, maxReview)) L.push(...it);
    if (items.length > maxReview) L.push(`  …… 其余 ${items.length - maxReview} 条见 deps / dedupe 明细报告`);
    L.push("");
  }

  // 6. 其余独立 issue
  const shown = new Set<number>([
    ...o.graph.edges.flatMap((e) => [e.from, e.to]),
    ...o.groups.flatMap((g) => g.members),
    ...o.related.flatMap((g) => g.members),
  ]);
  const rest = [...o.issues.keys()].filter((iid) => !shown.has(iid) && !o.canonicalOf.has(iid));
  L.push(`■ 其余独立 issue（${rest.length}，无重复、无依赖、无相关主题）`);
  const byType = new Map<string, number[]>();
  for (const iid of rest) {
    const t = o.types.get(iid)?.type ?? "other";
    byType.set(t, [...(byType.get(t) ?? []), iid]);
  }
  for (const t of Object.keys(TYPE_TAG) as IssueType[]) {
    const ids = byType.get(t);
    if (!ids?.length) continue;
    L.push(`  ${TYPE_TAG[t]} ${TYPE_NAME[t]}（${ids.length}）`);
    ids.sort((x, y) => y - x).forEach((iid, i) => L.push(`  ${i === ids.length - 1 ? "└" : "├"}── ${label(iid)}`));
  }
  return (o.maxWidth ? L.map((l) => truncate(l, o.maxWidth!, true)) : L).join("\n");
}

/** 把 DAG 画成树：多父节点只在第一次出现时展开，之后标 "↑ 见上"；回边标循环。 */
export function renderTree(graph: DepGraph, label: (iid: number) => string): string[] {
  const children = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  for (const e of graph.reduced) {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    if (!indeg.has(e.from)) indeg.set(e.from, 0);
  }
  for (const c of children.values()) c.sort((x, y) => x - y);
  const nodes = [...indeg.keys()].sort((x, y) => x - y);
  const roots = nodes.filter((n) => indeg.get(n) === 0);

  const out: string[] = [];
  const visited = new Set<number>();
  const walk = (n: number, prefix: string, last: boolean, root: boolean, path: Set<number>) => {
    const head = root ? "" : `${prefix}${last ? "└─▶ " : "├─▶ "}`;
    if (path.has(n)) return void out.push(`${head}#${n}  ⚠ 循环`);
    if (visited.has(n)) return void out.push(`${head}#${n}  ↑ 见上`);
    out.push(head + label(n));
    visited.add(n);
    const kids = children.get(n) ?? [];
    const nextPrefix = root ? "" : prefix + (last ? "    " : "│   ");
    path.add(n);
    kids.forEach((k, i) => walk(k, nextPrefix, i === kids.length - 1, false, path));
    path.delete(n);
  };
  for (const r of roots) {
    walk(r, "", true, true, new Set());
    out.push("");
  }
  // 只由环构成、没有入度为 0 起点的部分
  for (const n of nodes) {
    if (!visited.has(n)) {
      walk(n, "", true, true, new Set());
      out.push("");
    }
  }
  while (out.at(-1) === "") out.pop();
  return out;
}
