import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { issueState } from "./dedupe.js";
import { ISSUE_PATH_RE, projectUrlOf } from "./forge.js";
import type { Issue, PreparedIssue } from "./types.js";
import { DiskCache, sha256 } from "./util.js";

/**
 * 依赖方向是无序的几种互斥情况 → Choice。
 * 另附一个 Noul：是否有一方明确写了依赖/阻塞（给人工确认的证据）。
 */
export const DEPS_QUESTIONS = {
  order: choice(
    "Between the work described in `issue_a` and the work described in `issue_b`, which ordering constraint holds?",
    {
      a_before_b:
        "`issue_b` cannot be finished until the work in `issue_a` is done, because `issue_b` needs something that `issue_a` delivers (for example an API, data field, config, fix, tool, or capability).",
      b_before_a:
        "`issue_a` cannot be finished until the work in `issue_b` is done, because `issue_a` needs something that `issue_b` delivers (for example an API, data field, config, fix, tool, or capability).",
      no_order:
        "They are connected (same feature, same area, or a shared change), but either one can be done first or both can be done in parallel.",
      unrelated: "They are not meaningfully connected.",
    },
  ),
  explicit: noul(
    "Does `issue_a` or `issue_b` explicitly say that it depends on, waits for, or is blocked by the work of the other issue?",
  ),
} as const;

export type PairSource = "similar" | "mention" | "link";
export type DepVerdict = "a_before_b" | "b_before_a" | "review" | "none";

export interface DepJudgment {
  a: number;
  b: number;
  sources: PairSource[];
  model: string;
  /** 正反两种顺序提问后平均的概率。 */
  pAB: number;
  pBA: number;
  pNoOrder: number;
  pUnrelated: number;
  explicit: number;
  inputTokens: number;
  apiCalls: number;
  verdict: DepVerdict;
}

export interface DepThresholds {
  /** P(方向) ≥ 该值 → 确认依赖边。 */
  edge: number;
  /** max P(方向) ≥ 该值（且未达 edge）→ 待人工确认。 */
  review: number;
}

export const DEFAULT_DEP_THRESHOLDS: DepThresholds = { edge: 0.6, review: 0.3 };

/**
 * 达到 edge 阈值 → 确认依赖；
 * 否则只有当"有先后"仍是模型的首选（方向概率高于"无先后"和"无关"）时才进待确认，
 * 避免把模型本来就更倾向"无先后"的对推给人。
 */
export function routeDep(pAB: number, pBA: number, t: DepThresholds, pNoOrder = 0, pUnrelated = 0): DepVerdict {
  if (pAB >= t.edge && pAB > pBA) return "a_before_b";
  if (pBA >= t.edge && pBA > pAB) return "b_before_a";
  const dir = Math.max(pAB, pBA);
  if (dir >= t.review && dir > pNoOrder && dir > pUnrelated) return "review";
  return "none";
}

interface CachedOrder {
  model: string;
  order: Record<string, number>;
  explicit: number;
  inputTokens: number;
}

export class DependencyJudge {
  private readonly cache: DiskCache;

  constructor(
    private readonly client: TypeSafeClient,
    private readonly model: string,
    cacheDir: string,
    private readonly thresholds: DepThresholds = DEFAULT_DEP_THRESHOLDS,
  ) {
    this.cache = new DiskCache(cacheDir);
  }

  private async ask(first: PreparedIssue, second: PreparedIssue): Promise<{ value: CachedOrder; hit: boolean }> {
    const state = { issue_a: issueState(first), issue_b: issueState(second) };
    const key = sha256({ v: 1, model: this.model, state, questions: DEPS_QUESTIONS });
    return this.cache.wrap<CachedOrder>(key, async () => {
      const res = await this.client.systemOne({ model: this.model, state, questions: DEPS_QUESTIONS });
      return {
        model: res.model,
        order: { ...res.answers.order.probabilities },
        explicit: res.answers.explicit.noul,
        inputTokens: res.usage.input_tokens,
      };
    });
  }

  /** 正反两种顺序各问一次再平均，抵消位置偏好；两次不一致时概率自然被拉低进入待确认。 */
  async judge(a: PreparedIssue, b: PreparedIssue, sources: PairSource[]): Promise<DepJudgment> {
    const [fwd, rev] = await Promise.all([this.ask(a, b), this.ask(b, a)]);
    const f = fwd.value.order;
    const r = rev.value.order;
    const avg = (x = 0, y = 0) => (x + y) / 2;
    const pAB = avg(f.a_before_b, r.b_before_a);
    const pBA = avg(f.b_before_a, r.a_before_b);
    const pNoOrder = avg(f.no_order, r.no_order);
    const pUnrelated = avg(f.unrelated, r.unrelated);
    return {
      a: a.iid,
      b: b.iid,
      sources,
      model: fwd.value.model,
      pAB,
      pBA,
      pNoOrder,
      pUnrelated,
      explicit: avg(fwd.value.explicit, rev.value.explicit),
      inputTokens: (fwd.hit ? 0 : fwd.value.inputTokens) + (rev.hit ? 0 : rev.value.inputTokens),
      apiCalls: (fwd.hit ? 0 : 1) + (rev.hit ? 0 : 1),
      verdict: routeDep(pAB, pBA, this.thresholds, pNoOrder, pUnrelated),
    };
  }
}

// ---------------------------------------------------------------------------
// 确定性部分：显式引用、事实边、图分析
// ---------------------------------------------------------------------------

/** 从正文/评论中提取同项目内对其他 issue 的引用（#123 或完整 URL），只保留在本次集合里的。 */
export function extractMentions(issue: Issue, known: Set<number>): number[] {
  const prefix = projectUrlOf(issue.webUrl);
  const text = [issue.description, ...(issue.notes ?? [])].join("\n");
  const found = new Set<number>();
  for (const m of text.matchAll(/(?<![\w/&])#(\d+)\b/g)) found.add(Number(m[1]));
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of text.matchAll(new RegExp(`${esc}${ISSUE_PATH_RE}`, "g"))) found.add(Number(m[1]));
  found.delete(issue.iid);
  return [...found].filter((iid) => known.has(iid));
}

export interface DepEdge {
  /** from 必须先完成，to 才能完成。 */
  from: number;
  to: number;
  source: "link" | "declared" | "jev";
  probability: number;
}

export interface DeclaredStructure {
  /** 子 issue → 正文 `## Parent` 里声明的父 issue（父可能不在本次集合里）。 */
  parentOf: Map<number, number>;
  /** 正文写了 `## Blocked by` 的 issue → 声明的前置 issue（只含本次集合内的；None 为空数组）。 */
  blockedBy: Map<number, number[]>;
  /** 范围外或无法唯一解析的前置，不能当作“无依赖”。 */
  unresolved: Map<number, string[]>;
}

/** 按 Markdown 标题切分正文，返回 标题 → 内容。 */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.split(/^#{1,4}[ \t]+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!.trim().toLowerCase(), parts[i + 1] ?? "");
  return out;
}

const findSection = (s: Map<string, string>, re: RegExp) => [...s].find(([h]) => re.test(h))?.[1];

function refs(text: string, prefix: string): number[] {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: number[] = [];
  for (const m of text.matchAll(new RegExp(`${esc}${ISSUE_PATH_RE}|(?<![\\w/&])#(\\d+)\\b`, "g"))) found.push(Number(m[1] ?? m[2]));
  return [...new Set(found)];
}

/** 标题里的序号："检索质量治理 06：…" → 6，"入库质量 T4: …" → 4。 */
const titleSeq = (title: string) => {
  const m = title.match(/(?:^|[\sT])(\d{1,3})\s*[：:]/);
  return m ? Number(m[1]) : undefined;
};

/**
 * 解析 issue 模板里的 `## Parent` 与 `## Blocked by`（拆票工具生成的标准段落）。
 * Blocked by 里只写序号（"- 04, 09"）时，按同一父 issue 下子票标题里的序号解析。
 */
export function parseDeclared(issues: Issue[]): DeclaredStructure {
  const known = new Set(issues.map((i) => i.iid));
  const parentOf = new Map<number, number>();
  const secs = new Map(issues.map((i) => [i.iid, sections(i.description)]));
  const prefixOf = (i: Issue) => projectUrlOf(i.webUrl);
  for (const i of issues) {
    const s = findSection(secs.get(i.iid)!, /^(parent|父)/);
    const p = s ? refs(s, prefixOf(i)).find((n) => n !== i.iid) : undefined;
    if (p !== undefined) parentOf.set(i.iid, p);
  }
  const blockedBy = new Map<number, number[]>();
  const unresolved = new Map<number, string[]>();
  const unknown = (iid: number, note: string) => unresolved.set(iid, [...(unresolved.get(iid) ?? []), note]);
  for (const i of issues) {
    // 平台关联可能指向过滤范围外或其他项目，不能直接丢掉。
    for (const l of i.links ?? []) {
      if (l.linkType === "is_blocked_by" && (l.projectId !== i.projectId || !known.has(l.iid))) {
        unknown(i.iid, `关联前置 ${l.projectId}#${l.iid} 不在本次范围，状态未核实`);
      }
    }
    const s = findSection(secs.get(i.iid)!, /^(blocked by|前置|依赖于|被阻塞)/);
    if (s === undefined) continue;
    const found: number[] = [];
    const lines = s.split("\n").map((l) => l.replace(/^\s*[-*+]\s*/, "").trim()).filter(Boolean);
    if (!lines.length) unknown(i.iid, "Blocked by 为空，前置待确认");
    for (const line of lines) {
      if (/^(none|n\/a|无)(?=$|[\s。.,，;；—-])/i.test(line)) continue;
      const ids = refs(line, prefixOf(i));
      if (ids.length) found.push(...ids);
      else if (/^T?\d{1,3}(?:\s*[,，、]\s*T?\d{1,3})*$/i.test(line) && parentOf.has(i.iid)) {
        for (const seq of line.match(/\d+/g)!) {
          const matches = issues.filter((o) => parentOf.get(o.iid) === parentOf.get(i.iid) && titleSeq(o.title) === Number(seq));
          if (matches.length === 1) found.push(matches[0]!.iid);
          else unknown(i.iid, `同父任务序号 ${seq} 无法唯一解析`);
        }
      } else unknown(i.iid, `前置待确认：${line}`);
      // 同一行中同时出现本项目与外项目 URL 时，保留外部前置的不确定性。
      for (const u of line.matchAll(/https?:\/\/[^\s)<>]+?(?:\/-)?\/issues\/\d+/g)) {
        if (projectUrlOf(u[0]) !== prefixOf(i)) unknown(i.iid, `外项目前置：${u[0]}`);
      }
    }
    for (const n of new Set(found)) {
      if (n === i.iid) unknown(i.iid, "自依赖待拆解");
      if (!known.has(n)) unknown(i.iid, `前置 #${n} 不在本次范围，状态未核实`);
    }
    blockedBy.set(i.iid, [...new Set(found)].filter((n) => known.has(n)));
  }
  return { parentOf, blockedBy, unresolved };
}

export function declaredEdges(d: DeclaredStructure): DepEdge[] {
  return [...d.blockedBy].flatMap(([to, froms]) => froms.map((from): DepEdge => ({ from, to, source: "declared", probability: 1 })));
}

/** 父子关系是拆分，不是依赖：这类对不交给 Jev 判断。 */
export const isParentChild = (d: DeclaredStructure, a: number, b: number) => d.parentOf.get(a) === b || d.parentOf.get(b) === a;

/**
 * issue 自己声明了 Blocked by 时，它的前置以声明为准：
 * 模型推出的"X 先于它"一律丢弃（声明里有的已经是事实边）。
 */
export const contradictsDeclared = (d: DeclaredStructure, from: number, to: number) => d.blockedBy.has(to) && !d.unresolved.has(to) && !d.blockedBy.get(to)!.includes(from);

/** 全局证据口径：跨链路前置、环、范围外前置、合并项都参与就绪判断。 */
export function executionBlockers(issues: Map<number, PreparedIssue>, graph: DepGraph, declared: DeclaredStructure, canonicalOf: Map<number, number>): Map<number, string[]> {
  const c = (n: number) => canonicalOf.get(n) ?? n;
  const blocked = new Map<number, string[]>();
  const add = (n: number, reason: string) => blocked.set(c(n), [...(blocked.get(c(n)) ?? []), reason]);
  for (const [n, reasons] of declared.unresolved) for (const reason of reasons) add(n, reason);
  for (const e of graph.edges) {
    if (issues.get(e.from)?.raw.state !== "closed") add(e.to, `等待前置 #${e.from}`);
  }
  for (const cycle of graph.cycles) for (const n of cycle) add(n, "循环依赖待拆解");
  for (const [to, froms] of declared.blockedBy) if (froms.includes(to)) add(to, "自依赖待拆解");
  return blocked;
}

/** GitLab issue links / GitHub issue dependencies 的 blocks / is_blocked_by 直接作为事实边。 */
export function linkEdges(issues: Issue[]): DepEdge[] {
  const known = new Set(issues.map((i) => i.iid));
  const edges: DepEdge[] = [];
  for (const i of issues) {
    for (const l of i.links ?? []) {
      if (l.projectId !== i.projectId || !known.has(l.iid)) continue;
      if (l.linkType === "blocks") edges.push({ from: i.iid, to: l.iid, source: "link", probability: 1 });
      if (l.linkType === "is_blocked_by") edges.push({ from: l.iid, to: i.iid, source: "link", probability: 1 });
    }
  }
  return dedupeEdges(edges);
}

function dedupeEdges(edges: DepEdge[]): DepEdge[] {
  const m = new Map<string, DepEdge>();
  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    const prev = m.get(k);
    if (!prev || (prev.source !== "link" && e.source === "link")) m.set(k, e);
  }
  return [...m.values()];
}

export interface DepGraph {
  edges: DepEdge[];
  /** 传递约简后的边（A→B→C 时去掉 A→C），用于展示；环内的边保留。 */
  reduced: DepEdge[];
  /** 强连通分量中的循环依赖，包含单节点自环。 */
  cycles: number[][];
  /** 分层执行顺序：第 0 层无前置依赖；环被视为一个整体放在同一层。 */
  layers: number[][];
}

export function analyzeGraph(edgesIn: DepEdge[]): DepGraph {
  const edges = dedupeEdges(edgesIn);
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort((x, y) => x - y);
  const adj = new Map<number, number[]>(nodes.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from)!.push(e.to);

  // Tarjan SCC
  let index = 0;
  const idx = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];
  const strong = (v: number) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)!) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp.sort((x, y) => x - y));
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);

  // 在缩点后的 DAG 上做 Kahn 分层
  const compOf = new Map<number, number>();
  sccs.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));
  const indeg = new Array<number>(sccs.length).fill(0);
  const cadj = sccs.map(() => new Set<number>());
  for (const e of edges) {
    const a = compOf.get(e.from)!;
    const b = compOf.get(e.to)!;
    if (a !== b && !cadj[a]!.has(b)) {
      cadj[a]!.add(b);
      indeg[b]!++;
    }
  }
  const layers: number[][] = [];
  let frontier = sccs.map((_, i) => i).filter((i) => indeg[i] === 0);
  while (frontier.length) {
    layers.push(frontier.flatMap((i) => sccs[i]!).sort((x, y) => x - y));
    const next: number[] = [];
    for (const i of frontier) {
      for (const j of cadj[i]!) if (--indeg[j]! === 0) next.push(j);
    }
    frontier = next;
  }

  // 传递约简：u→v 若存在另一条长度 ≥ 2 的路径则多余（只在缩点 DAG 上判断，环内边不动）
  const reachesAvoiding = (u: number, v: number) => {
    const seen = new Set<number>();
    const stack = [...cadj[u]!].filter((w) => w !== v);
    while (stack.length) {
      const x = stack.pop()!;
      if (x === v) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...cadj[x]!);
    }
    return false;
  };
  const reduced = edges.filter((e) => {
    const a = compOf.get(e.from)!;
    const b = compOf.get(e.to)!;
    return a === b || !reachesAvoiding(a, b);
  });

  return { edges, reduced, cycles: sccs.filter((c) => c.length > 1 || edges.some((e) => e.from === c[0] && e.to === c[0])), layers };
}

/** 把被合并 issue 的边改挂到保留的 issue 上，并去掉自环。 */
export function collapseEdges(edges: DepEdge[], canonicalOf: Map<number, number>): DepEdge[] {
  const c = (n: number) => canonicalOf.get(n) ?? n;
  const mapped = edges
    .map((e) => ({ ...e, from: c(e.from), to: c(e.to) }))
    .filter((e) => e.from !== e.to);
  // 同一对保留概率最高的
  const best = new Map<string, DepEdge>();
  for (const e of mapped) {
    const k = `${e.from}->${e.to}`;
    const prev = best.get(k);
    if (!prev || e.probability > prev.probability) best.set(k, e);
  }
  return [...best.values()];
}
