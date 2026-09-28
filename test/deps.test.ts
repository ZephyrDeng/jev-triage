import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, renderTree, truncate } from "../src/ascii.ts";
import { analyzeGraph, collapseEdges, extractMentions, linkEdges, routeDep, type DepEdge } from "../src/deps.ts";
import type { Issue } from "../src/types.ts";

const issue = (iid: number, description = "", extra: Partial<Issue> = {}): Issue => ({
  iid, projectId: 1, title: "", description, labels: [], state: "opened", issueType: "issue", author: "",
  createdAt: "", updatedAt: "", webUrl: `https://git.example.com/g/p/-/issues/${iid}`, userNotesCount: 0,
  upvotes: 0, mergeRequestsCount: 0, milestone: null, ...extra,
});
const e = (from: number, to: number): DepEdge => ({ from, to, source: "jev", probability: 0.9 });

test("extractMentions: #iid and same-project URLs, only known issues, not self / html entities", () => {
  const i = issue(5, "依赖 #3，见 https://git.example.com/g/p/-/issues/7 和 #99；&#39; #5 https://git.example.com/other/-/issues/8");
  assert.deepEqual(extractMentions(i, new Set([3, 5, 7, 8])).sort(), [3, 7]);
  const gh = issue(5, "see https://github.com/o/r/issues/7, o/r#8 and https://github.com/o/other/issues/9", { webUrl: "https://github.com/o/r/issues/5" });
  assert.deepEqual(extractMentions(gh, new Set([7, 8, 9])), [7]);
});

test("linkEdges maps blocks / is_blocked_by", () => {
  const edges = linkEdges([
    issue(1, "", { links: [{ iid: 2, projectId: 1, linkType: "blocks" }] }),
    issue(3, "", { links: [{ iid: 2, projectId: 1, linkType: "is_blocked_by" }, { iid: 1, projectId: 1, linkType: "relates_to" }] }),
    issue(2),
  ]);
  assert.deepEqual(edges.map((x) => `${x.from}->${x.to}`).sort(), ["1->2", "2->3"]);
});

test("routeDep", () => {
  const t = { edge: 0.6, review: 0.3 };
  assert.equal(routeDep(0.8, 0.1, t), "a_before_b");
  assert.equal(routeDep(0.1, 0.7, t), "b_before_a");
  assert.equal(routeDep(0.4, 0.2, t), "review");
  assert.equal(routeDep(0.1, 0.1, t), "none");
  // 方向概率过了 review 线，但模型首选是"无先后" → 不打扰人
  assert.equal(routeDep(0.43, 0.02, t, 0.53, 0.02), "none");
  assert.equal(routeDep(0.57, 0.02, t, 0.37, 0.04), "review");
});

test("analyzeGraph layers a DAG and reports cycles", () => {
  const g = analyzeGraph([e(1, 2), e(1, 3), e(2, 4), e(3, 4), e(5, 6), e(6, 5), e(6, 7)]);
  assert.deepEqual(g.cycles, [[5, 6]]);
  assert.deepEqual(g.layers, [[1, 5, 6], [2, 3, 7], [4]]);
});

test("collapseEdges re-targets merged issues and drops self loops", () => {
  const out = collapseEdges([e(1, 2), e(3, 2), e(3, 1)], new Map([[3, 1]]));
  assert.deepEqual(out.map((x) => `${x.from}->${x.to}`), ["1->2"]);
});

test("renderTree expands shared children once", () => {
  const lines = renderTree(analyzeGraph([e(1, 2), e(1, 3), e(2, 4), e(3, 4)]), (n) => `#${n}`);
  assert.deepEqual(lines, ["#1", "├─▶ #2", "│   └─▶ #4", "└─▶ #3", "    └─▶ #4  ↑ 见上"]);
});

test("truncate respects CJK display width", () => {
  assert.equal(displayWidth("ab中文"), 6);
  assert.equal(truncate("中文标题很长很长", 9), "中文标题…");
  // 保守模式：box-drawing 等 Ambiguous 字符按 2 列
  assert.equal(displayWidth("├── ab", true), 9);
  assert.equal(truncate("├── 中文标题很长", 12, true), "├── 中...");
});

import { detectForge, parseProjectRef } from "../src/forge.ts";

test("parseProjectRef accepts ids, paths and URLs", () => {
  const h = "gitlab.example.com";
  const gl = (host: string, project: string) => ({ forge: "gitlab", host, project });
  assert.deepEqual(parseProjectRef("45956", h), gl(h, "45956"));
  assert.deepEqual(parseProjectRef("a/b/c", h), gl(h, "a/b/c"));
  assert.deepEqual(parseProjectRef("https://git.example.com/a/b/c/-/issues", h), gl("git.example.com", "a/b/c"));
  assert.deepEqual(parseProjectRef("https://git.example.com/a/b/c/-/issues/12?x=1", h), gl("git.example.com", "a/b/c"));
  assert.deepEqual(parseProjectRef("https://git.example.com/a/b/c.git", h), gl("git.example.com", "a/b/c"));
  assert.deepEqual(parseProjectRef("git@git.example.com:a/b/c.git", h), gl("git.example.com", "a/b/c"));
  const gh = (host: string, project: string) => ({ forge: "github", host, project });
  assert.deepEqual(parseProjectRef("o/r", "github.com"), gh("github.com", "o/r"));
  assert.deepEqual(parseProjectRef("https://github.com/o/r/issues/12", h), gh("github.com", "o/r"));
  assert.deepEqual(parseProjectRef("git@github.com:o/r.git", h), gh("github.com", "o/r"));
  assert.deepEqual(parseProjectRef("o/r", "code.corp.example", "github"), gh("code.corp.example", "o/r"));
  assert.throws(() => parseProjectRef("o", "github.com"));
  assert.equal(detectForge("github.corp.example"), "github");
  assert.equal(detectForge("gitlab.com"), "gitlab");
  assert.throws(() => detectForge("x", "bitbucket"));
});

import { contradictsDeclared, isParentChild, parseDeclared } from "../src/deps.ts";

test("parseDeclared: Parent / Blocked by, None, sibling sequence numbers", () => {
  const d = parseDeclared([
    issue(10, "## What\nx"),
    issue(11, "## Parent\n\n#10 Spec\n\n## Blocked by\n\n- None — can start immediately", { title: "治理 01：a" }),
    issue(12, "## Parent\n#10\n## Blocked by\n- #11（治理 01）", { title: "治理 02：b" }),
    issue(13, "## Parent\n#10\n## Blocked by\n- 01, 02\n## Next\n#99", { title: "治理 03：c" }),
    issue(14, "## Parent\n#249\n## Blocked by\n- None。可与 #13 并行", { title: "T9: d" }),
  ]);
  assert.deepEqual([...d.parentOf], [[11, 10], [12, 10], [13, 10], [14, 249]]);
  assert.deepEqual([...d.blockedBy], [[11, []], [12, [11]], [13, [11, 12]], [14, []]]);
  assert.ok(isParentChild(d, 10, 12));
  assert.ok(contradictsDeclared(d, 10, 11)); // 11 声明无前置 → 模型推的 10→11 丢弃
  assert.ok(!contradictsDeclared(d, 11, 10)); // 10 没声明 → 保留
});

test("analyzeGraph.reduced drops transitive edges but preserves reachability through cycles", () => {
  const g = analyzeGraph([e(1, 2), e(2, 3), e(1, 3), e(1, 4)]);
  assert.deepEqual(g.reduced.map((x) => `${x.from}->${x.to}`).sort(), ["1->2", "1->4", "2->3"]);
  const cyclic = analyzeGraph([e(1, 2), e(2, 1), e(1, 3), e(2, 3)]);
  assert.equal(cyclic.reduced.filter((e) => e.to === 3).length, 2);
  assert.deepEqual(analyzeGraph([e(1, 1)]).cycles, [[1]]);
  // All directed graphs on three nodes, including self-loops.
  const possible = [1, 2, 3].flatMap((a) => [1, 2, 3].map((b) => e(a, b)));
  const reachable = (edges: DepEdge[], start: number) => {
    const seen = new Set<number>();
    const todo = edges.filter((e) => e.from === start).map((e) => e.to);
    while (todo.length) {
      const n = todo.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(...edges.filter((e) => e.from === n).map((e) => e.to));
    }
    return [...seen].sort();
  };
  for (let mask = 0; mask < 512; mask++) {
    const graph = analyzeGraph(possible.filter((_, i) => mask & (1 << i)));
    for (const n of [1, 2, 3]) assert.deepEqual(reachable(graph.reduced, n), reachable(graph.edges, n));
  }
});

test("parseDeclared keeps out-of-scope, mixed, empty and ambiguous prerequisites unresolved", () => {
  const d = parseDeclared([
    issue(1, "## Parent\n#100\n## Blocked by\n- #9\n- 02, 03\n- #2"),
    issue(2, "## Parent\n#100", { title: "治理 02：b" }),
    issue(3, "## Parent\n#100", { title: "治理 02：duplicate sequence" }),
    issue(4, "## Blocked by\n- https://git.example.com/other/-/issues/2"),
    issue(5, "## Blocked by\n"),
    issue(6, "## Blocked by\n- 无法确定"),
    issue(7, "", { links: [{ projectId: 99, iid: 2, linkType: "is_blocked_by" }] }),
    issue(8, "## Blocked by\n- None — can start immediately"),
    issue(10, "## Blocked by\n- #10"),
    issue(11, "## Blocked by\n- https://github.com/o/other/issues/3", { webUrl: "https://github.com/o/r/issues/11" }),
    issue(12, "", { links: [{ projectId: "o/other", iid: 2, linkType: "is_blocked_by" }], projectId: "o/r" }),
  ]);
  assert.deepEqual(d.blockedBy.get(1), [2]);
  assert.deepEqual([...d.unresolved.keys()].sort((a, b) => a - b), [1, 4, 5, 6, 7, 10, 11, 12]);
  assert.deepEqual(d.unresolved.get(10), ["自依赖待拆解"]);
  assert.match(d.unresolved.get(1)!.join(" "), /#9/);
  assert.match(d.unresolved.get(1)!.join(" "), /02.*03/);
  assert.equal(contradictsDeclared(d, 3, 1), false); // incomplete declaration is not a negative fact
});
