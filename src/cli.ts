#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { renderOverview } from "./ascii.js";
import { renderHtml } from "./html.js";
import { allPairs, recallCandidates, type CandidatePair, type Doc } from "./candidates.js";
import { IssueClassifier, type IssueClassification } from "./classify.js";
import { defaultHost, loadEnv } from "./config.js";
import { clusterDuplicates, clusterRelated, DedupeJudge, type DuplicateGroup, type PairJudgment } from "./dedupe.js";
import {
  analyzeGraph,
  collapseEdges,
  contradictsDeclared,
  declaredEdges,
  DependencyJudge,
  extractMentions,
  isParentChild,
  linkEdges,
  parseDeclared,
  type DepEdge,
  type DepJudgment,
  type PairSource,
} from "./deps.js";
import { parseProjectRef, projectUrlOf } from "./forge.js";
import { CACHE_DIR, loadIssues, prepareIssues } from "./pipeline.js";
import { renderDepsMarkdown, renderMarkdown, type DedupeReport, type DepsReport } from "./report.js";
import type { Issue, PreparedIssue } from "./types.js";
import { log, mapPool } from "./util.js";

const HELP = `jev-triage — GitHub / GitLab issue 分析（TypeSafe Jev）

用法:
  jev-triage fetch   --project <ref> [选项]   拉取并缓存 issue
  jev-triage dedupe  --project <ref> [选项]   只做去重
  jev-triage analyze --project <ref> [选项]   去重 + 类型 + 依赖，输出 HTML / ASCII / JSON 总览
  jev-triage skill [--path]                 输出内置 skill 正文或文件路径
  jev-triage --version                      输出版本

通用选项:
  --project <ref>         GitHub owner/repo、GitLab 项目 id / path，或直接粘贴项目/issue 列表的 URL（必填）
  --host <host>           裸路径使用的主机（默认 $FORGE_HOST 或 github.com），URL 中的主机优先
  --forge <github|gitlab> 平台（默认 $FORGE；未设置时主机名含 github 为 GitHub，其余为 GitLab）
                         GitHub 通过 gh、GitLab 通过 glab 只读访问，需先登录对应主机
  --state <s>             opened | closed | all（默认 opened）
  --label <name>          只拉取带该标签的 issue，可重复
  --limit <n>             最多处理 n 条（按更新时间倒序）
  --with-notes            把非系统评论也作为内容
  --refresh               忽略本地缓存，重新拉取 issue

分析选项:
  --all-pairs-max <n>     两两组合数 ≤ n 时不做召回，直接全量判断（默认 200）
  --top-k <n>             每个 issue 召回的相似邻居数（默认 5）
  --min-sim <x>           候选召回的最低 TF-IDF 余弦相似度（默认 0.12）
  --max-chars <n>         清洗后正文最大字符数（默认 4000）
  --ignore-label <regex>  不发送给模型的标签（如 '^修复版本:'），可重复
  --dup-threshold <p>     P(重复) ≥ p 判为重复（默认 0.7）
  --distinct-threshold <p> P(不同) ≥ p 判为不同（默认 0.7），其余待人工确认
  --related-threshold <p> P(相关) ≥ p 归入相关主题（默认 0.5）
  --dep-top-k <n>         依赖候选：每个 issue 召回的邻居数（默认 5）
  --dep-min-sim <x>       依赖候选：最低相似度（默认 0.05，比去重宽松）
  --dep-threshold <p>     P(方向) ≥ p 判为依赖（默认 0.6）
  --dep-review <p>        P(方向) ≥ p 但未达阈值时待确认（默认 0.3）
  --concurrency <n>       并发请求数（默认 6）
  --translate             先用 LLM 把 issue 翻译成英文再交给 Jev（默认直接用原文）
  --dry-run               只做清洗/候选召回（及翻译），不调用 Jev
  --out <dir>             报告输出目录（默认 out）
  --format <format>       analyze 标准输出：html（默认，输出路径）| ascii | json
                         三种报告文件始终生成，进度写入 stderr
`;

type Values = ReturnType<typeof parse>["values"];

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      host: { type: "string" },
      forge: { type: "string" },
      state: { type: "string", default: "opened" },
      label: { type: "string", multiple: true },
      limit: { type: "string" },
      "with-notes": { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      "all-pairs-max": { type: "string", default: "200" },
      "top-k": { type: "string", default: "5" },
      "min-sim": { type: "string", default: "0.12" },
      "max-chars": { type: "string", default: "4000" },
      "ignore-label": { type: "string", multiple: true },
      "dup-threshold": { type: "string", default: "0.7" },
      "distinct-threshold": { type: "string", default: "0.7" },
      "related-threshold": { type: "string", default: "0.5" },
      "dep-top-k": { type: "string", default: "5" },
      "dep-min-sim": { type: "string", default: "0.05" },
      "dep-threshold": { type: "string", default: "0.6" },
      "dep-review": { type: "string", default: "0.3" },
      concurrency: { type: "string", default: "6" },
      translate: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string", default: "out" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      path: { type: "boolean", default: false },
      format: { type: "string", default: "html" },
    },
  });
}

interface Prepared {
  project: string;
  issues: Issue[];
  byId: Map<number, PreparedIssue>;
  pairs: CandidatePair[];
  docs: Doc[];
  /** 是否为全量两两比较（小集合）。 */
  exhaustive: boolean;
}

async function prepare(values: Values, withLinks: boolean): Promise<Prepared> {
  const { forge, host, project } = projectRef(values);
  const state = values.state as "opened" | "closed" | "all";
  if (!["opened", "closed", "all"].includes(state)) throw new Error(`--state 取值无效: ${state}`);
  const issues = await loadIssues({
    forge,
    host,
    project,
    state,
    labels: values.label,
    limit: values.limit ? Number(values.limit) : undefined,
    withNotes: values["with-notes"],
    withLinks,
    refresh: values.refresh,
  });
  const prepared = await prepareIssues(issues, {
    maxChars: Number(values["max-chars"]),
    ignoreLabels: (values["ignore-label"] ?? []).map((r) => new RegExp(r)),
    concurrency: Number(values.concurrency),
    translate: values.translate,
  });
  const byId = new Map<number, PreparedIssue>(prepared.map((p) => [p.iid, p]));
  const docs: Doc[] = prepared.map((p) => ({ id: p.iid, title: p.title, body: `${p.labels.join(" ")}\n${p.description}` }));
  const exhaustive = (docs.length * (docs.length - 1)) / 2 <= Number(values["all-pairs-max"]);
  const pairs = exhaustive
    ? allPairs(docs)
    : recallCandidates(docs, { topK: Number(values["top-k"]), minSimilarity: Number(values["min-sim"]) });
  return { project, issues, byId, pairs, docs, exhaustive };
}

function projectRef(values: Values) {
  return parseProjectRef(values.project!, values.host ?? defaultHost(), values.forge ?? process.env.FORGE);
}

function outBase(values: Values, kind: string): string {
  const { project } = projectRef(values);
  return join(values.out, `${kind}-${project.replace(/[^\w.-]+/g, "_")}`);
}

function jevModel(): string {
  return process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
}

async function runDedupe(values: Values, p: Prepared, client: TypeSafeClient) {
  const judge = new DedupeJudge(client, jevModel(), join(CACHE_DIR, "jev", "dedupe"), {
    duplicate: Number(values["dup-threshold"]),
    distinct: Number(values["distinct-threshold"]),
  });
  let n = 0;
  // 父 issue 天然"包含"子 issue，属于拆分关系，不参与判重
  const declared = parseDeclared(p.issues);
  const pairs = p.pairs.filter((x) => !isParentChild(declared, x.a, x.b));
  const judgments: PairJudgment[] = await mapPool(pairs, Number(values.concurrency), async (pair) => {
    const j = await judge.judge(pair, p.byId.get(pair.a)!, p.byId.get(pair.b)!);
    if (++n % 20 === 0) log(`  去重 ${n}/${pairs.length}`);
    return j;
  });
  const groups = clusterDuplicates(judgments, p.byId);
  const review = judgments
    .filter((j) => j.verdict === "review")
    .sort((x, y) => y.relation.probabilities[2] - x.relation.probabilities[2]);
  return { judgments, groups, review };
}

async function main() {
  const { positionals, values } = parse();
  const cmd = positionals[0];
  if (values.version) {
    console.log(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
    return;
  }
  if (values.help || !cmd) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (positionals.length !== 1) throw new Error("只接受一个子命令");
  if (cmd === "skill") {
    const path = fileURLToPath(new URL("../skills/jev-triage/SKILL.md", import.meta.url));
    console.log(values.path ? path : await readFile(path, "utf8"));
    return;
  }
  if (!["fetch", "dedupe", "analyze"].includes(cmd)) throw new Error(`未知子命令：${cmd}`);
  if (values.path) throw new Error("--path 仅用于 skill");
  if (!values.project?.trim()) throw new Error("缺少 --project");
  if (!["html", "ascii", "json"].includes(values.format)) throw new Error("--format 应为 html、ascii 或 json");
  for (const key of ["limit", "concurrency", "max-chars", "top-k", "dep-top-k", "all-pairs-max"] as const) {
    const raw = values[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < (key === "all-pairs-max" ? 0 : 1)) throw new Error(`--${key} 必须为${key === "all-pairs-max" ? "非负" : "正"}整数`);
  }
  for (const key of ["min-sim", "dep-min-sim", "dup-threshold", "distinct-threshold", "related-threshold", "dep-threshold", "dep-review"] as const) {
    const n = Number(values[key]);
    if (!values[key].trim() || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`--${key} 必须在 0–1 之间`);
  }
  loadEnv();

  if (cmd === "fetch") {
    const p = await prepare({ ...values, translate: false }, false);
    for (const i of p.issues) console.log(`#${i.iid}\t${i.title}`);
    return;
  }

  const p = await prepare(values, cmd === "analyze");
  log(
    p.exhaustive
      ? `候选对 ${p.pairs.length} 个（issue 较少，全量两两比较）`
      : `候选对 ${p.pairs.length} 个（${p.issues.length} 条 issue，全量两两比较为 ${(p.issues.length * (p.issues.length - 1)) / 2}，已召回缩减）`,
  );
  if (values["dry-run"]) {
    for (const pair of p.pairs.slice(0, 50)) {
      console.log(`${pair.similarity.toFixed(3)}\t#${pair.a} ${p.byId.get(pair.a)?.title}\n\t#${pair.b} ${p.byId.get(pair.b)?.title}`);
    }
    if (p.pairs.length > 50) console.log(`... 其余 ${p.pairs.length - 50} 个`);
    return;
  }

  const client = new TypeSafeClient({ timeout: 30_000 });
  await mkdir(values.out, { recursive: true });

  // ---- 去重 ----
  const dd = await runDedupe(values, p, client);
  const dedupeReport: DedupeReport = {
    project: p.project,
    generatedAt: new Date().toISOString(),
    model: dd.judgments[0]?.model ?? null,
    issueCount: p.issues.length,
    candidatePairs: dd.judgments.length,
    stats: {
      duplicate: dd.judgments.filter((j) => j.verdict === "duplicate").length,
      review: dd.review.length,
      distinct: dd.judgments.filter((j) => j.verdict === "distinct").length,
      inputTokens: dd.judgments.filter((j) => !j.cached).reduce((s, j) => s + j.inputTokens, 0),
      apiCalls: dd.judgments.filter((j) => !j.cached).length,
    },
    groups: dd.groups,
    review: dd.review,
    judgments: dd.judgments,
  };
  const dBase = outBase(values, "dedupe");
  await writeFile(`${dBase}.json`, JSON.stringify(dedupeReport, null, 2));
  await writeFile(`${dBase}.md`, renderMarkdown(dedupeReport, p.byId));
  log(`去重：重复组 ${dd.groups.length}，待确认 ${dd.review.length}  → ${dBase}.md`);
  if (cmd === "dedupe") return;

  // ---- 类型 ----
  const classifier = new IssueClassifier(client, jevModel(), join(CACHE_DIR, "jev", "classify"));
  const classes: IssueClassification[] = await mapPool([...p.byId.values()], Number(values.concurrency), (i) =>
    classifier.classify(i),
  );
  const types = new Map(classes.map((c) => [c.iid, c]));
  log(`类型：已分类 ${classes.length} 条`);

  // ---- 依赖 ----
  const canonicalOf = new Map<number, number>();
  for (const g of dd.groups) for (const m of g.members) if (m !== g.canonical) canonicalOf.set(m, g.canonical);
  const declared = parseDeclared(p.issues);
  const factEdges = [...linkEdges(p.issues), ...declaredEdges(declared)];
  const factPairs = new Set(factEdges.map((e) => `${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}`));
  const merged = (a: number, b: number) => (canonicalOf.get(a) ?? a) === (canonicalOf.get(b) ?? b);

  const depPairs = new Map<string, { a: number; b: number; sources: Set<PairSource> }>();
  const addPair = (x: number, y: number, s: PairSource) => {
    const a = Math.min(x, y);
    const b = Math.max(x, y);
    const k = `${a}-${b}`;
    // 父子是拆分不是依赖；双方都声明了 Blocked by 时两个方向都已有定论
    if (a === b || merged(a, b) || factPairs.has(k) || isParentChild(declared, a, b)) return;
    if (contradictsDeclared(declared, a, b) && contradictsDeclared(declared, b, a)) return;
    const e = depPairs.get(k) ?? { a, b, sources: new Set<PairSource>() };
    e.sources.add(s);
    depPairs.set(k, e);
  };
  const known = new Set(p.issues.map((i) => i.iid));
  const depRecall = p.exhaustive
    ? p.pairs
    : recallCandidates(p.docs, { topK: Number(values["dep-top-k"]), minSimilarity: Number(values["dep-min-sim"]) });
  for (const pair of depRecall) addPair(pair.a, pair.b, "similar");
  for (const i of p.issues) {
    for (const m of extractMentions(i, known)) addPair(i.iid, m, "mention");
    for (const l of i.links ?? []) if (l.linkType === "relates_to" && known.has(l.iid)) addPair(i.iid, l.iid, "link");
  }
  log(`依赖：正文声明 ${factEdges.length} 条前置关系、${declared.parentOf.size} 条父子关系`);
  log(`依赖：候选对 ${depPairs.size} 个（每对正反各问一次）`);

  const depJudge = new DependencyJudge(client, jevModel(), join(CACHE_DIR, "jev", "deps"), {
    edge: Number(values["dep-threshold"]),
    review: Number(values["dep-review"]),
  });
  const depJudgments: DepJudgment[] = await mapPool([...depPairs.values()], Number(values.concurrency), (x) =>
    depJudge.judge(p.byId.get(x.a)!, p.byId.get(x.b)!, [...x.sources]),
  );
  const jevEdges: DepEdge[] = depJudgments.flatMap((j): DepEdge[] =>
    j.verdict === "a_before_b"
      ? [{ from: j.a, to: j.b, source: "jev", probability: j.pAB }]
      : j.verdict === "b_before_a"
        ? [{ from: j.b, to: j.a, source: "jev", probability: j.pBA }]
        : [],
  ).filter((e) => !contradictsDeclared(declared, e.from, e.to));
  const graph = analyzeGraph(collapseEdges([...factEdges, ...jevEdges], canonicalOf));
  const depReview = depJudgments
    .filter((j) => j.verdict === "review")
    .filter((j) => (j.pAB >= j.pBA ? !contradictsDeclared(declared, j.a, j.b) : !contradictsDeclared(declared, j.b, j.a)))
    .sort((x, y) => Math.max(y.pAB, y.pBA) - Math.max(x.pAB, x.pBA));

  const depsReport: DepsReport = {
    project: p.project,
    generatedAt: new Date().toISOString(),
    model: depJudgments[0]?.model ?? null,
    issueCount: p.issues.length,
    candidatePairs: depPairs.size,
    stats: {
      edges: graph.edges.length,
      review: depReview.length,
      cycles: graph.cycles.length,
      inputTokens: depJudgments.reduce((s, j) => s + j.inputTokens, 0),
      apiCalls: depJudgments.reduce((s, j) => s + j.apiCalls, 0),
    },
    graph,
    review: depReview,
    judgments: depJudgments,
  };
  const depBase = outBase(values, "deps");
  await writeFile(`${depBase}.json`, JSON.stringify(depsReport, null, 2));
  await writeFile(`${depBase}.md`, renderDepsMarkdown(depsReport, p.byId));

  // ---- 总览 ----
  const overviewInput = {
    project: p.project,
    issues: p.byId,
    types,
    groups: dd.groups as DuplicateGroup[],
    canonicalOf,
    graph,
    declared,
    related: clusterRelated(dd.judgments, canonicalOf, Number(values["related-threshold"])),
    dupReview: dd.review,
    depReview,
  };
  // 文件：完整宽度、展示全部待确认；终端：按窗口宽度截断，避免折行错位
  const asciiFile = renderOverview({ ...overviewInput, titleWidth: 80, maxReview: Number.POSITIVE_INFINITY });
  const cols = process.stdout.isTTY ? process.stdout.columns : undefined;
  const ascii = renderOverview({
    ...overviewInput,
    maxWidth: cols ? cols - 1 : undefined,
    titleWidth: cols ? Math.max(24, Math.min(80, cols - 46)) : 56,
  });
  const aBase = outBase(values, "overview");
  await writeFile(`${aBase}.txt`, asciiFile + "\n");
  const webUrl = p.issues[0]?.webUrl;
  const projectUrl = webUrl && projectUrlOf(webUrl);
  await writeFile(
    `${aBase}.html`,
    renderHtml({
      ...overviewInput,
      project: projectUrl ? new URL(projectUrl).pathname.slice(1) : p.project,
      issuesUrl: webUrl?.replace(/\/\d+$/, ""),
      declared,
      generatedAt: new Date().toISOString(),
      model: dedupeReport.model ?? depsReport.model,
    }),
  );
  const overviewJson = JSON.stringify({
    project: p.project, generatedAt: new Date().toISOString(),
    issues: [...p.byId.values()].map((i) => ({ iid: i.iid, title: i.originalTitle, webUrl: i.webUrl, state: i.raw.state })),
    types: classes, groups: dd.groups, graph, related: overviewInput.related,
    dupReview: dd.review, depReview,
    parentOf: Object.fromEntries(declared.parentOf), blockedBy: Object.fromEntries(declared.blockedBy),
    unresolved: Object.fromEntries(declared.unresolved),
  }, null, 2);
  await writeFile(`${aBase}.json`, overviewJson);
  const tokens =
    dedupeReport.stats.inputTokens +
    classes.filter((c) => !c.cached).reduce((s, c) => s + c.inputTokens, 0) +
    depsReport.stats.inputTokens;
  log(`Jev 本次新消耗输入 ${tokens} tokens（约 $${((tokens / 1e6) * 0.042).toFixed(4)}）`);
  log(`报告：${aBase}.html | ${aBase}.txt | ${depBase}.md | ${dBase}.md\n`);
  console.log(values.format === "ascii" ? ascii : values.format === "json" ? overviewJson : resolve(`${aBase}.html`));
}

main().catch((err) => {
  console.error(err instanceof Error ? (process.env.DEBUG ? err.stack : err.message) : err);
  process.exit(1);
});
