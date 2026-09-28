import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanMarkdown } from "../src/clean.ts";

test("drops metadata <details>, html comments, empty sections; truncates code", () => {
  const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const md = `<!-- design-frontmatter:begin -->
<details>
<summary>机器可读元数据（frontmatter）</summary>

\`\`\`yaml
jira: JY-1
\`\`\`
</details>
<!-- design-frontmatter:end -->
## 问题描述
导出按钮点击无反应 ![截图](https://x/y.png) 见 [文档](https://a.b/c)

## 环境

## 错误信息
\`\`\`text
${code}
\`\`\`
`;
  const out = cleanMarkdown(md);
  assert.ok(!out.includes("jira: JY-1"));
  assert.ok(!out.includes("<!--"));
  assert.ok(!out.includes("## 环境"));
  assert.ok(out.includes("[image: 截图]"));
  assert.ok(out.includes("见 文档"));
  assert.ok(out.includes("(18 more lines)"));
});

test("keeps non-metadata details content", () => {
  const out = cleanMarkdown("<details><summary>日志</summary>\nstack trace here\n</details>");
  assert.match(out, /日志\s+stack trace here/);
});
