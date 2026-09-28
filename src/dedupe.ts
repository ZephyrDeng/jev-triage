import { noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { CandidatePair } from "./candidates.js";
import type { PreparedIssue } from "./types.js";
import { DiskCache, sha256 } from "./util.js";

/**
 * 一次请求 = 一个候选对 + 5 个并行问题。
 * - relation：三档 Score，直接对应「保持独立 / 人工确认 / 合并」三条出路
 * - 4 个 Noul：给人工确认提供线索，并用于在重复组里挑选保留哪一个
 * 问题 id 不会发给模型，所以每个问题都要自带完整含义。
 */
export const DEDUPE_QUESTIONS = {
  relation: score(
    "How do the two work items `issue_a` and `issue_b` from the same project relate to each other?",
    [
      "Different: they describe different problems or different requested changes. Resolving one would leave the other fully open, even if both touch the same product area, page, or module.",
      "Related but possibly not the same: they overlap in feature, area, or symptoms, but it is unclear whether resolving one would resolve the other, or one covers only part of the other.",
      "Duplicate: they describe the same problem or the same requested change, so they should be tracked as a single issue.",
    ],
  ),
  same_problem: noul(
    "Do `issue_a` and `issue_b` report the same observed behavior, error, or requested change?",
    {
      true: "The same concrete bug, error, or requested change is described in both, possibly in different words.",
      false: "The concrete bug, error, or requested change differs, even if the area is the same.",
    },
  ),
  same_area: noul("Do `issue_a` and `issue_b` concern the same product area, module, page, or component?"),
  a_covers_b: noul(
    "If the work described in `issue_a` were fully completed, would everything that `issue_b` asks for also be done?",
  ),
  b_covers_a: noul(
    "If the work described in `issue_b` were fully completed, would everything that `issue_a` asks for also be done?",
  ),
} as const;

export type Verdict = "duplicate" | "review" | "distinct";

export interface PairJudgment {
  a: number;
  b: number;
  similarity: number;
  model: string;
  relation: { score: number; confidence: number; probabilities: [number, number, number] };
  sameProblem: number;
  sameArea: number;
  aCoversB: number;
  bCoversA: number;
  inputTokens: number;
  cached: boolean;
  verdict: Verdict;
}

export interface Thresholds {
  /** P(duplicate 档) ≥ 该值 → duplicate。 */
  duplicate: number;
  /** P(different 档) ≥ 该值 → distinct。其余进入人工确认。 */
  distinct: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { duplicate: 0.7, distinct: 0.7 };

export function issueState(issue: PreparedIssue) {
  return { title: issue.title, labels: issue.labels, description: issue.description };
}

export function route(p: [number, number, number], t: Thresholds): Verdict {
  if (p[2] >= t.duplicate) return "duplicate";
  if (p[0] >= t.distinct) return "distinct";
  return "review";
}

interface CachedAnswer {
  model: string;
  answers: {
    relation: { score: number; confidence: number; probabilities: Record<string, number> };
    same_problem: { noul: number };
    same_area: { noul: number };
    a_covers_b: { noul: number };
    b_covers_a: { noul: number };
  };
  inputTokens: number;
}

export class DedupeJudge {
  private readonly cache: DiskCache;

  constructor(
    private readonly client: TypeSafeClient,
    private readonly model: string,
    cacheDir: string,
    private readonly thresholds: Thresholds = DEFAULT_THRESHOLDS,
  ) {
    this.cache = new DiskCache(cacheDir);
  }

  async judge(pair: CandidatePair, a: PreparedIssue, b: PreparedIssue): Promise<PairJudgment> {
    const state = { issue_a: issueState(a), issue_b: issueState(b) };
    const key = sha256({ v: 1, model: this.model, state, questions: DEDUPE_QUESTIONS });
    const { value, hit } = await this.cache.wrap<CachedAnswer>(key, async () => {
      const res = await this.client.systemOne({ model: this.model, state, questions: DEDUPE_QUESTIONS });
      return {
        model: res.model,
        answers: {
          relation: {
            score: res.answers.relation.score,
            confidence: res.answers.relation.confidence,
            probabilities: { ...res.answers.relation.probabilities },
          },
          same_problem: { noul: res.answers.same_problem.noul },
          same_area: { noul: res.answers.same_area.noul },
          a_covers_b: { noul: res.answers.a_covers_b.noul },
          b_covers_a: { noul: res.answers.b_covers_a.noul },
        },
        inputTokens: res.usage.input_tokens,
      };
    });
    const pr = value.answers.relation.probabilities;
    const probs: [number, number, number] = [pr["0"] ?? 0, pr["1"] ?? 0, pr["2"] ?? 0];
    return {
      a: a.iid,
      b: b.iid,
      similarity: pair.similarity,
      model: value.model,
      relation: { score: value.answers.relation.score, confidence: value.answers.relation.confidence, probabilities: probs },
      sameProblem: value.answers.same_problem.noul,
      sameArea: value.answers.same_area.noul,
      aCoversB: value.answers.a_covers_b.noul,
      bCoversA: value.answers.b_covers_a.noul,
      inputTokens: value.inputTokens,
      cached: hit,
      verdict: route(probs, this.thresholds),
    };
  }
}

export interface DuplicateGroup {
  canonical: number;
  members: number[];
  edges: PairJudgment[];
}

/** 把 duplicate 边做连通分量聚类，并在代码里选出每组保留的 issue。 */
export function clusterDuplicates(judgments: PairJudgment[], issues: Map<number, PreparedIssue>): DuplicateGroup[] {
  const edges = judgments.filter((j) => j.verdict === "duplicate");
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) as number;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    parent.set(find(e.a), find(e.b));
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }

  return [...groups.values()].map((members) => {
    const set = new Set(members);
    const groupEdges = edges.filter((e) => set.has(e.a));
    // 覆盖别人越多越适合作为保留项；再按讨论热度、创建时间兜底
    const coverage = new Map<number, number>(members.map((m) => [m, 0]));
    for (const e of groupEdges) {
      coverage.set(e.a, (coverage.get(e.a) ?? 0) + e.aCoversB);
      coverage.set(e.b, (coverage.get(e.b) ?? 0) + e.bCoversA);
    }
    const activity = (id: number) => {
      const r = issues.get(id)?.raw;
      return r ? r.userNotesCount + r.upvotes * 2 + r.mergeRequestsCount * 3 : 0;
    };
    const created = (id: number) => issues.get(id)?.raw.createdAt ?? "";
    const sorted = [...members].sort(
      (x, y) =>
        (coverage.get(y) ?? 0) - (coverage.get(x) ?? 0) ||
        activity(y) - activity(x) ||
        created(x).localeCompare(created(y)),
    );
    return { canonical: sorted[0] as number, members: sorted, edges: groupEdges };
  });
}

export interface RelatedGroup {
  /** 与组内其他 issue 关联最多的一个，作为主题中心。 */
  hub: number;
  members: number[];
  edges: PairJudgment[];
}

/**
 * 功能性合并候选：Jev 判为"相关但不重复"的对，按连通分量聚成主题。
 * 被合并（重复）的 issue 先折叠为保留项。
 */
export function clusterRelated(
  judgments: PairJudgment[],
  canonicalOf: Map<number, number>,
  minRelated = 0.5,
): RelatedGroup[] {
  const c = (n: number) => canonicalOf.get(n) ?? n;
  const edges = judgments.filter(
    (j) => j.verdict !== "duplicate" && j.relation.probabilities[1] >= minRelated && c(j.a) !== c(j.b),
  );
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const e of edges) {
    for (const n of [c(e.a), c(e.b)]) if (!parent.has(n)) parent.set(n, n);
    parent.set(find(c(e.a)), find(c(e.b)));
  }
  const groups = new Map<number, number[]>();
  for (const n of parent.keys()) groups.set(find(n), [...(groups.get(find(n)) ?? []), n]);

  return [...groups.values()]
    .map((members) => {
      const set = new Set(members);
      const gEdges = edges.filter((e) => set.has(c(e.a)));
      const degree = new Map<number, number>();
      for (const e of gEdges) {
        for (const n of [c(e.a), c(e.b)]) degree.set(n, (degree.get(n) ?? 0) + e.relation.probabilities[1]);
      }
      const hub = [...members].sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || x - y)[0]!;
      return { hub, members: members.sort((x, y) => x - y), edges: gEdges };
    })
    .sort((x, y) => y.members.length - x.members.length);
}
