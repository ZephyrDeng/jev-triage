import assert from "node:assert/strict";
import { test } from "node:test";
import { recallCandidates, tokenize } from "../src/candidates.ts";

test("tokenize handles english words and CJK bigrams", () => {
  assert.deepEqual(tokenize("Export button 导出按钮"), ["export", "button", "导出", "出按", "按钮"]);
});

test("recalls the most similar pair first", () => {
  const pairs = recallCandidates(
    [
      { id: 1, title: "Export to PDF crashes in Safari", body: "clicking export pdf crashes the settings page" },
      { id: 2, title: "Safari crash when exporting PDF", body: "settings page crashes on pdf export" },
      { id: 3, title: "Add dark mode", body: "support a dark theme for the dashboard" },
    ],
    { topK: 2, minSimilarity: 0.05 },
  );
  assert.deepEqual([pairs[0]?.a, pairs[0]?.b], [1, 2]);
  assert.ok(!pairs.some((p) => p.a === 1 && p.b === 3 && p.similarity > pairs[0]!.similarity));
});
