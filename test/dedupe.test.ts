import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterDuplicates, route, type PairJudgment } from "../src/dedupe.ts";
import type { PreparedIssue } from "../src/types.ts";

const t = { duplicate: 0.7, distinct: 0.7 };

test("route by level probabilities", () => {
  assert.equal(route([0.05, 0.1, 0.85], t), "duplicate");
  assert.equal(route([0.9, 0.1, 0], t), "distinct");
  assert.equal(route([0.4, 0.3, 0.3], t), "review");
});

const j = (a: number, b: number, p2: number, aCoversB = 0.5, bCoversA = 0.5): PairJudgment => ({
  a, b, similarity: 0.5, model: "jev", relation: { score: p2 * 2, confidence: 1, probabilities: [1 - p2, 0, p2] },
  sameProblem: 1, sameArea: 1, aCoversB, bCoversA, inputTokens: 0, cached: false, verdict: route([1 - p2, 0, p2], t),
});
const issue = (iid: number, notes = 0): PreparedIssue => ({
  iid, webUrl: "", originalTitle: "", title: "", description: "", labels: [], translated: false,
  raw: { iid, projectId: 1, title: "", description: "", labels: [], state: "opened", issueType: "issue", author: "",
    createdAt: `2026-01-0${iid}`, updatedAt: "", webUrl: "", userNotesCount: notes, upvotes: 0, mergeRequestsCount: 0, milestone: null },
});

test("clusters duplicate edges transitively and picks the covering issue", () => {
  const issues = new Map([1, 2, 3, 4].map((i) => [i, issue(i)]));
  const groups = clusterDuplicates([j(1, 2, 0.9, 0.1, 0.95), j(2, 3, 0.8, 0.9, 0.2), j(3, 4, 0.1)], issues);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]!.members].sort(), [1, 2, 3]);
  assert.equal(groups[0]!.canonical, 2);
});

import { clusterRelated } from "../src/dedupe.ts";

test("clusterRelated groups related (non-duplicate) pairs around the most connected hub", () => {
  const rel = (a: number, b: number, p1: number): PairJudgment => ({
    ...j(a, b, 0), relation: { score: 1, confidence: 1, probabilities: [1 - p1, p1, 0] }, verdict: "review",
  });
  const groups = clusterRelated([rel(2, 12, 0.7), rel(2, 13, 0.8), rel(2, 17, 0.6), rel(5, 9, 0.2)], new Map());
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.hub, 2);
  assert.deepEqual(groups[0]!.members, [2, 12, 13, 17]);
});
