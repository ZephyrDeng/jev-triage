import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { analyzeGraph, executionBlockers, parseDeclared, type DepEdge } from "../src/deps.ts";
import { renderHtml, type HtmlInput } from "../src/html.ts";
import { renderOverview } from "../src/ascii.ts";
import type { PreparedIssue } from "../src/types.ts";

const issue = (iid: number, description = "", state = "opened"): PreparedIssue => ({
  iid, originalTitle: `Task ${iid}`, title: `Task ${iid}`, description, labels: [], translated: false,
  webUrl: `https://git.example.com/g/p/-/issues/${iid}`,
  raw: { iid, projectId: 1, title: `Task ${iid}`, description, labels: [], state, issueType: "issue", author: "",
    createdAt: "", updatedAt: "", webUrl: `https://git.example.com/g/p/-/issues/${iid}`, userNotesCount: 0,
    upvotes: 0, mergeRequestsCount: 0, milestone: null },
});
const e = (from: number, to: number): DepEdge => ({ from, to, source: "declared", probability: 1 });
const input = (issues: PreparedIssue[], edges: DepEdge[]): HtmlInput => ({
  project: "g/p", generatedAt: "2026-01-01T00:00:00Z", issues: new Map(issues.map((i) => [i.iid, i])),
  types: new Map(), groups: [], related: [], canonicalOf: new Map(), dupReview: [], depReview: [],
  graph: analyzeGraph(edges), declared: parseDeclared(issues.map((i) => i.raw)),
});
const node = (html: string, iid: number) => html.match(new RegExp(`<a class="node[^>]*data-iid="${iid}"[^>]*>`))?.[0] ?? "";

test("HTML ready state considers global, unresolved, cyclic and merged prerequisites", () => {
  const o = input([
    issue(100), issue(200),
    issue(1, "## Parent\n#100"), issue(2, "## Parent\n#100"),
    issue(3, "## Parent\n#200"), issue(4, "## Parent\n#200\n## Blocked by\n- #99"),
    issue(5), issue(6), issue(7, "## Blocked by\n- #98"),
  ], [e(1, 2), e(2, 3), e(3, 4), e(5, 6), e(6, 5)]);
  o.canonicalOf.set(7, 1);
  const blocked = executionBlockers(o.issues, o.graph, o.declared, o.canonicalOf);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(blocked.has(n), `#${n}`);
  const html = renderHtml(o);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.ok(node(html, n), `#${n} is visible`);
    assert.doesNotMatch(node(html, n), /class="node ready"/);
  }
  assert.match(html, /跨链路依赖/);
  assert.match(html, /前置 #99 不在本次范围/);
  assert.match(html, /前置 #98 不在本次范围/);
  assert.doesNotMatch(html, /可立即开始/);
  assert.doesNotMatch(renderOverview(o), /可立即开始/);
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!);
});

test("HTML retains parent dependency nodes, cross-only endpoints and safe links", () => {
  const o = input([issue(100), issue(1, "## Parent\n#100"), issue(2)], [e(100, 2), e(2, 1)]);
  const html = renderHtml(o);
  for (const n of [100, 1, 2]) assert.ok(node(html, n));
  assert.match(node(html, 100), /node ready/);
  assert.doesNotMatch(node(html, 1), /node ready/);
  o.issues.get(2)!.originalTitle = '<script>alert("x")</script>';
  o.issues.get(2)!.webUrl = "javascript:alert(1)";
  const safe = renderHtml(o);
  assert.doesNotMatch(safe, /<script>alert|href="javascript:/);
  assert.match(safe, /&#60;script&#62;/);
});

test("HTML handles empty scopes and closed prerequisites", () => {
  assert.match(renderHtml(input([], [])), /没有发现依赖关系/);
  const o = input([issue(1, "", "closed"), issue(2), issue(3)], [e(1, 2), e(2, 3)]);
  const html = renderHtml(o);
  assert.doesNotMatch(node(html, 1), /node ready/);
  assert.match(node(html, 2), /node ready/);
  assert.doesNotMatch(node(html, 3), /node ready/);
  assert.match(html, /范围内 issue/);
});

const withTypes = (o: HtmlInput, confs: [number, number][]) => {
  for (const [iid, confidence] of confs) {
    o.types.set(iid, {
      iid, type: "feature", confidence, inputTokens: 0, cached: false,
      probabilities: { bug: 0.1, feature: confidence, tech_debt: 0.4, tooling: 0, question: 0, other: 0 },
    });
  }
  return o;
};

test("low-confidence types get a review block in HTML and ASCII, threshold 0 disables it", () => {
  const o = withTypes(input([issue(1), issue(2), issue(3)], []), [[1, 0.3], [2, 0.5], [3, 0.9]]);
  const html = renderHtml(o);
  assert.match(html, /id="type-review"/);
  assert.equal((html.match(/类型待确认<\/div>/g) ?? []).length, 1);
  const ascii = renderOverview(o);
  assert.match(ascii, /■ 类型待确认（1，置信度 < 50%）/);
  assert.match(ascii, /候选：TECH 技术优化 40% \/ FEAT 需求 30%/);
  o.typeConfidence = 0.95;
  assert.match(renderOverview(o), /■ 类型待确认（3，/);
  o.typeConfidence = 0;
  assert.doesNotMatch(renderHtml(o), /id="type-review"/);
  assert.doesNotMatch(renderOverview(o), /类型待确认|\? = 类型置信度/);
});
