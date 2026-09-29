import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TYPE_MIN_CONF, needsTypeReview, topCandidates, type IssueClassification } from "../src/classify.ts";

const cls = (confidence: number, probabilities: Partial<IssueClassification["probabilities"]> = {}): IssueClassification => ({
  iid: 1, type: "feature", confidence, inputTokens: 0, cached: false,
  probabilities: { bug: 0, feature: 0, tech_debt: 0, tooling: 0, question: 0, other: 0, ...probabilities },
});

test("needsTypeReview flags only confidence strictly below the threshold", () => {
  assert.equal(needsTypeReview(cls(0.5), 0.5), false);
  assert.equal(needsTypeReview(cls(0.499), 0.5), true);
  assert.equal(needsTypeReview(cls(0.501), 0.5), false);
});

test("needsTypeReview with threshold 0 never flags", () => {
  assert.equal(needsTypeReview(cls(0), 0), false);
  assert.equal(needsTypeReview(cls(0.01), 0), false);
});

test("default threshold matches the previous rendering behaviour", () => {
  assert.equal(DEFAULT_TYPE_MIN_CONF, 0.5);
});

test("topCandidates returns the two most probable types in order", () => {
  const top = topCandidates(cls(0.4, { feature: 0.4, tech_debt: 0.35, bug: 0.25 }));
  assert.deepEqual(top.map((t) => t.type), ["feature", "tech_debt"]);
  assert.deepEqual(top.map((t) => t.probability), [0.4, 0.35]);
});

test("topCandidates breaks ties by declared type order and honours n", () => {
  const c = cls(0.3, { tooling: 0.3, tech_debt: 0.3, other: 0.4 });
  assert.deepEqual(topCandidates(c).map((t) => t.type), ["other", "tech_debt"]);
  assert.equal(topCandidates(c, 3).length, 3);
});
