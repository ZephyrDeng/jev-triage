import { TYPE_NAME, TYPE_TAG, type IssueType } from "./classify.js";
import type { OverviewInput } from "./ascii.js";
import { analyzeGraph, executionBlockers, type DeclaredStructure, type DepEdge } from "./deps.js";

export interface HtmlInput extends OverviewInput {
  declared: DeclaredStructure;
  /** 项目 issue 列表地址（GitLab …/-/issues，GitHub …/issues）。 */
  issuesUrl?: string;
  generatedAt: string;
  model?: string | null;
}

const TYPES = Object.keys(TYPE_TAG) as IssueType[];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeUrl = (s: string) => /^https?:\/\//i.test(s) ? esc(s) : "#";

interface Epic {
  key: string;
  name: string;
  parent?: number;
  parentInScope: boolean;
  layers: number[][];
  edges: DepEdge[];
  prefix: string;
}

/** 字符串公共前缀，回退到最后一个空白/冒号之后，避免把 "T" 之类切成半截。 */
function commonPrefix(titles: string[]): string {
  if (titles.length < 3) return "";
  let p = titles[0]!;
  for (const t of titles) while (!t.startsWith(p)) p = p.slice(0, -1);
  const cut = Math.max(p.lastIndexOf(" "), p.lastIndexOf("："), p.lastIndexOf(":"));
  p = cut >= 0 ? p.slice(0, cut + 1) : "";
  return p.trim().length >= 2 ? p : "";
}

/** "T3: 流量行" → { seq: "T3", rest: "流量行" }；"[T03] design…" 同理。 */
function splitSeq(title: string): { seq?: string; rest: string } {
  const m = title.match(/^\[?(T?\d{1,3})\]?(?:\s*[：:]\s*|\s+)(.+)$/);
  return m ? { seq: m[1], rest: m[2]! } : { rest: title };
}

/**
 * 分组：声明了同一个父 issue 的子票为一条链路；其余参与依赖的 issue 按弱连通分量成组。
 * 每组内部单独分层，同层内按前驱位置的重心排序以减少连线交叉。
 */
function buildEpics(o: HtmlInput): { epics: Epic[]; crossEdges: DepEdge[]; placed: Set<number> } {
  const c = (n: number) => o.canonicalOf.get(n) ?? n;
  const alive = (n: number) => o.issues.has(n) && !o.canonicalOf.has(n);
  const groupOf = new Map<number, string>();
  const parents = new Set<number>();
  for (const [child, parent] of o.declared.parentOf) {
    if (!alive(child)) continue;
    groupOf.set(child, `p${parent}`);
    parents.add(parent);
  }
  const edges = o.graph.reduced.map((e) => ({ ...e, from: c(e.from), to: c(e.to) }));
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  // 有真实前置/阻塞关系的父 issue 仍须作为节点保留。
  for (const p of parents) if (!connected.has(p)) groupOf.delete(p);

  // 没有父 issue 的依赖节点：并查集按连通分量成组
  const uf = new Map<number, number>();
  const find = (x: number): number => (uf.get(x) === x ? x : find(uf.get(x)!));
  for (const e of edges) {
    for (const n of [e.from, e.to]) if (!groupOf.has(n) && !uf.has(n)) uf.set(n, n);
    if (!groupOf.has(e.from) && !groupOf.has(e.to)) uf.set(find(e.from), find(e.to));
  }
  for (const n of uf.keys()) groupOf.set(n, `c${find(n)}`);

  const members = new Map<string, number[]>();
  for (const [n, g] of groupOf) members.set(g, [...(members.get(g) ?? []), n]);

  const crossEdges = edges.filter((e) => groupOf.get(e.from) !== groupOf.get(e.to));
  const epics: Epic[] = [];
  for (const [key, ids] of members) {
    const inner = edges.filter((e) => groupOf.get(e.from) === key && groupOf.get(e.to) === key);
    const g = analyzeGraph(inner);
    const inGraph = new Set(g.layers.flat());
    const layers = g.layers.map((l) => [...l]);
    const loose = ids.filter((n) => !inGraph.has(n)).sort((x, y) => x - y);
    if (loose.length) (layers[0] ??= []).push(...loose);

    // 重心排序：按前驱在上一列的平均位置
    const preds = new Map<number, number[]>();
    for (const e of inner) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
    const pos = new Map<number, number>();
    layers[0]!.forEach((n, i) => pos.set(n, i));
    for (let li = 1; li < layers.length; li++) {
      const bary = (n: number) => {
        const ps = (preds.get(n) ?? []).map((p) => pos.get(p)).filter((x) => x !== undefined);
        return ps.length ? ps.reduce((s, x) => s + x, 0) / ps.length : Number.POSITIVE_INFINITY;
      };
      layers[li]!.sort((x, y) => bary(x) - bary(y) || x - y);
      layers[li]!.forEach((n, i) => pos.set(n, i));
    }

    const parent = key.startsWith("p") ? Number(key.slice(1)) : undefined;
    // 父 issue 不在范围内、组内也没有依赖：成不了链路，留给"独立 issue"
    if (!ids.some((n) => connected.has(n)) && !(parent !== undefined && o.issues.has(parent))) {
      for (const n of ids) groupOf.delete(n);
      continue;
    }
    const titles = ids.map((n) => o.issues.get(n)!.originalTitle);
    const prefix = commonPrefix(titles);
    const root = layers[0]![0]!;
    const name =
      parent !== undefined && o.issues.has(parent)
        ? o.issues.get(parent)!.originalTitle.replace(/^spec[:：]\s*/i, "")
        : prefix.replace(/[\s:：]+$/, "") || o.issues.get(root)!.originalTitle;
    epics.push({ key, name, parent, parentInScope: parent !== undefined && o.issues.has(parent), layers, edges: inner, prefix });
  }
  epics.sort((a, b) => b.layers.flat().length - a.layers.flat().length);
  return { epics, crossEdges, placed: new Set(groupOf.keys()) };
}

export function renderHtml(o: HtmlInput): string {
  const lowConf = o.typeConfidence ?? 0.5;
  const maybeDup = o.maybeDup ?? 0.3;
  const coversMin = o.covers ?? 0.6;
  const c = (n: number) => o.canonicalOf.get(n) ?? n;
  const { epics, crossEdges, placed } = buildEpics(o);
  const url = (n: number) => o.issues.get(n)?.webUrl ?? `${o.issuesUrl ?? ""}/${n}`;
  const title = (n: number) => o.issues.get(n)?.originalTitle ?? `#${n}`;
  const typeOf = (n: number): IssueType => o.types.get(n)?.type ?? "other";

  const typeChip = (n: number) => {
    const t = o.types.get(n);
    const unsure = t && t.confidence < lowConf;
    return `<span class="type" data-t="${typeOf(n)}" title="${esc(TYPE_NAME[typeOf(n)])}${t ? ` · 置信度 ${pct(t.confidence)}` : ""}">${TYPE_TAG[typeOf(n)]}${unsure ? `<i>?</i>` : ""}</span>`;
  };
  const ref = (n: number) =>
    `<a class="ref" href="${safeUrl(url(n))}" target="_blank" rel="noopener" data-iid="${n}"><span class="iid">#${n}</span>${typeChip(n)}<span class="ref-title">${esc(title(n))}</span></a>`;
  const search = (n: number) => esc(`#${n} ${title(n)} ${TYPE_TAG[typeOf(n)]}`.toLowerCase());

  // ---- 执行计划 ----
  const allEdges = epics.flatMap((e) => e.edges);
  const downstream = new Set(o.graph.edges.map((e) => e.from));
  const blockers = executionBlockers(o.issues, o.graph, o.declared, o.canonicalOf);
  const ready = (n: number) => o.issues.get(n)?.raw.state === "opened" && !blockers.has(n);
  const readyNow = [...placed].filter((n) => downstream.has(n) && ready(n));
  const pending = new Map<number, string[]>();
  for (const [n, reasons] of o.declared.unresolved) pending.set(c(n), [...(pending.get(c(n)) ?? []), ...reasons]);
  const pendingHtml = [...pending].map(([n, reasons]) => `<li>${ref(n)}<span>${esc(reasons.join("；"))}</span></li>`).join("");

  const epicHtml = epics
    .map((ep) => {
      const count = ep.layers.flat().length;
      const cols = ep.layers
        .map(
          (layer, li) => `
        <div class="col">
          <div class="col-head">链路第 ${li + 1} 层</div>
          ${layer
            .map((n) => {
              const shown = ep.prefix && title(n).startsWith(ep.prefix) ? title(n).slice(ep.prefix.length) : title(n);
              const { seq, rest } = splitSeq(shown);
              const status = blockers.get(n)?.join("；") ?? (ready(n) ? "当前证据未发现前置阻塞" : "已关闭");
              return `<a class="node${ready(n) ? " ready" : ""}" href="${safeUrl(url(n))}" target="_blank" rel="noopener" data-iid="${n}" data-t="${typeOf(n)}" data-q="${search(n)}" title="${esc(`${title(n)} · ${status}`)}">
            <span class="node-head"><span class="iid">#${n}</span>${seq ? `<span class="seq">${esc(seq)}</span>` : ""}${typeChip(n)}</span>
            <span class="node-title">${esc(rest)}</span>
            <span class="node-status">${esc(status)}</span>
          </a>`;
            })
            .join("")}
        </div>`,
        )
        .join("");
      const parentLink =
        ep.parent !== undefined
          ? `<a class="epic-parent" href="${safeUrl(url(ep.parent))}" target="_blank" rel="noopener"><span class="iid">#${ep.parent}</span>${ep.parentInScope ? "" : " 父 issue 未在范围内"}</a>`
          : "";
      return `
      <section class="epic" data-epic="${ep.key}">
        <header class="epic-head">
          <h3>${esc(ep.name)}</h3>
          <div class="epic-meta">${parentLink}<span>${count} 项</span><span>${ep.layers.length} 步</span><span>${ep.edges.length} 条依赖</span></div>
        </header>
        <div class="flow-scroll"><div class="flow">${cols}<svg class="wires" aria-hidden="true"></svg></div></div>
      </section>`;
    })
    .join("");

  // ---- 待确认 ----
  const dupReview = o.dupReview.filter((j) => j.relation.probabilities[2] >= maybeDup);
  const bar = (segs: [string, number, string][]) =>
    `<div class="bar" role="img" aria-label="${segs.map(([l, p]) => `${l} ${pct(p)}`).join("，")}">${segs
      .map(([l, p, k]) => `<span class="seg" data-k="${k}" style="flex:${Math.max(p, 0.0001)}" title="${l} ${pct(p)}"></span>`)
      .join("")}</div><div class="bar-legend">${segs.map(([l, p, k]) => `<span data-k="${k}"><b>${pct(p)}</b> ${l}</span>`).join("")}</div>`;
  const reviewRows = [
    ...dupReview.map(
      (j) => `<li class="review" data-q="${search(j.a)} ${search(j.b)}">
      <div class="review-kind">可能重复</div>
      <div class="review-pair">${ref(j.a)}<span class="rel">↔</span>${ref(j.b)}</div>
      <div class="review-p">${bar([["重复", j.relation.probabilities[2], "hi"], ["相关", j.relation.probabilities[1], "mid"], ["不同", j.relation.probabilities[0], "lo"]])}</div>
    </li>`,
    ),
    ...o.depReview.map((j) => {
      const [from, to, p] = j.pAB >= j.pBA ? [j.a, j.b, j.pAB] : [j.b, j.a, j.pBA];
      return `<li class="review" data-q="${search(from)} ${search(to)}">
      <div class="review-kind">可能依赖</div>
      <div class="review-pair">${ref(from)}<span class="rel">先于</span>${ref(to)}</div>
      <div class="review-p">${bar([["此方向", p, "hi"], ["反方向", Math.min(j.pAB, j.pBA), "mid"], ["可并行", j.pNoOrder, "mid"], ["无关", j.pUnrelated, "lo"]])}</div>
    </li>`;
    }),
  ];

  // ---- 可合并 / 相关主题 ----
  const mergeHtml = o.groups
    .map((g) => {
      const others = g.members.filter((m) => m !== g.canonical);
      return `<div class="cluster"><div class="cluster-hub">${ref(g.canonical)}<span class="note keep">保留</span></div><ul>${others
        .map((m) => {
          const e = g.edges.find((x) => [x.a, x.b].includes(m) && [x.a, x.b].includes(g.canonical)) ?? g.edges.find((x) => x.a === m || x.b === m);
          return `<li>${ref(m)}<span class="note">重复 ${e ? pct(e.relation.probabilities[2]) : "–"}</span></li>`;
        })
        .join("")}</ul></div>`;
    })
    .join("");
  // 整组都在同一条链路里的相关主题，执行计划已经表达了，不再重复
  const epicOf = new Map(epics.flatMap((ep) => ep.layers.flat().map((n) => [n, ep.key] as const)));
  const related = o.related.filter((g) => new Set(g.members.map((m) => epicOf.get(m) ?? `x${m}`)).size > 1);
  const relatedHtml = related
    .map((g) => {
      const others = g.members.filter((m) => m !== g.hub);
      return `<div class="cluster"><div class="cluster-hub">${ref(g.hub)}</div><ul>${others
        .map((m) => {
          const mine = g.edges.filter((e) => c(e.a) === m || c(e.b) === m);
          const e = mine.find((x) => c(x.a) === g.hub || c(x.b) === g.hub) ?? [...mine].sort((x, y) => y.relation.probabilities[1] - x.relation.probabilities[1])[0];
          let note = "";
          if (e) {
            const peer = c(e.a) === m ? c(e.b) : c(e.a);
            const [mCovers, peerCovers] = c(e.a) === m ? [e.aCoversB, e.bCoversA] : [e.bCoversA, e.aCoversB];
            note = `相关 ${pct(e.relation.probabilities[1])}${peer !== g.hub ? ` · 与 #${peer}` : ""}`;
            if (peerCovers >= coversMin) note += ` · 被 #${peer} 包含`;
            else if (mCovers >= coversMin) note += ` · 包含 #${peer}`;
          }
          return `<li>${ref(m)}<span class="note">${note}</span></li>`;
        })
        .join("")}</ul></div>`;
    })
    .join("");

  // ---- 独立 issue ----
  const inCluster = new Set([...o.groups.flatMap((g) => g.members), ...related.flatMap((g) => g.members)]);
  // 父 issue（spec）在执行计划里作为链路标题出现，这里不再重复
  const asParent = new Set(epics.map((e) => e.parent));
  const restIds = [...o.issues.keys()].filter((n) => !placed.has(n) && !inCluster.has(n) && !o.canonicalOf.has(n) && !asParent.has(n));
  const restHtml = TYPES.map((t) => {
    const ids = restIds.filter((n) => typeOf(n) === t).sort((x, y) => y - x);
    if (!ids.length) return "";
    return `<tbody data-t="${t}"><tr class="group"><th colspan="3"><span class="type" data-t="${t}">${TYPE_TAG[t]}</span>${TYPE_NAME[t]}<span class="count">${ids.length}</span></th></tr>${ids
      .map((n) => {
        const raw = o.issues.get(n)!.raw;
        return `<tr data-q="${search(n)}" data-t="${t}"><td class="iid"><a href="${safeUrl(url(n))}" target="_blank" rel="noopener">#${n}</a></td><td><a class="row-title" href="${safeUrl(url(n))}" target="_blank" rel="noopener">${esc(title(n))}</a>${
          o.types.get(n) && o.types.get(n)!.confidence < lowConf ? `<span class="unsure" title="类型置信度 ${pct(o.types.get(n)!.confidence)}">类型待定</span>` : ""
        }</td><td class="date">${esc((raw.updatedAt || "").slice(0, 10))}</td></tr>`;
      })
      .join("")}</tbody>`;
  }).join("");

  // ---- 概况 ----
  const typeCounts = TYPES.map((t) => [t, [...o.types.values()].filter((x) => x.type === t).length] as const).filter(([, n]) => n);
  const total = typeCounts.reduce((s, [, n]) => s + n, 0) || 1;
  const typeBar = `<div class="mix">${typeCounts
    .map(([t, n]) => `<span class="mix-seg" data-t="${t}" style="flex:${n}" title="${TYPE_NAME[t]} ${n}"></span>`)
    .join("")}</div><div class="mix-legend">${typeCounts
    .map(([t, n]) => `<button class="filter" data-t="${t}" aria-pressed="false"><span class="dot" data-t="${t}"></span>${TYPE_NAME[t]}<b>${n}</b><span class="share">${Math.round((n / total) * 100)}%</span></button>`)
    .join("")}</div>`;

  const nav = [
    ["plan", "执行计划", epics.length],
    ["review", "待确认", reviewRows.length],
    ["merge", "可合并", o.groups.length],
    ["related", "相关主题", related.length],
    ["rest", "独立 issue", restIds.length],
  ] as const;
  // 空区块不单独占位，合并成一行说明；导航里也不出现
  const empties = nav.filter(([id, , n]) => ["review", "merge", "related"].includes(id) && !n);

  const graphData = JSON.stringify({
    edges: allEdges.map((e) => ({ from: e.from, to: e.to, source: e.source, p: e.probability })),
  }).replace(/</g, "\\u003c");

  const date = new Date(o.generatedAt).toLocaleString("zh-CN", { hour12: false, dateStyle: "short", timeStyle: "short" });
  const [ns, name] = (() => {
    const i = o.project.lastIndexOf("/");
    return i < 0 ? ["", o.project] : [o.project.slice(0, i + 1), o.project.slice(i + 1)];
  })();

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · Issue 总览</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div class="title">
      <div class="crumb">${esc(ns)}</div>
      <h1>${o.issuesUrl ? `<a href="${safeUrl(o.issuesUrl)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name)}<span class="sub">Issue 总览</span></h1>
    </div>
    <label class="search"><span class="sr">搜索</span><input id="q" type="search" placeholder="搜索标题或 #编号" autocomplete="off"><kbd>/</kbd></label>
  </div>
  <nav class="tabs">${nav.filter((x) => !empties.includes(x)).map(([id, label, n]) => `<a href="#${id}">${label}<span>${n}</span></a>`).join("")}</nav>
</header>

<main>
  <section class="summary">
    <p class="lede"><b>${o.issues.size}</b> 个范围内 issue，其中 <b>${placed.size}</b> 个落在 <b>${epics.length}</b> 条交付链路里，<b>${readyNow.length}</b> 个未发现前置阻塞且有后续工作；${reviewRows.length ? `<b>${reviewRows.length}</b> 项模型判断需要人工确认。` : "模型判断无待确认项。"}${pending.size ? `另有 <b>${pending.size}</b> 个 issue 的前置状态待确认。` : ""}</p>
    ${typeBar}
    <p class="meta">生成于 ${esc(date)}${o.model ? ` · 判定模型 ${esc(o.model)}` : ""} · 实线为 issue 正文声明或平台关联，虚线为模型推断</p>
  </section>

  <section id="plan" class="block">
    <div class="block-head"><h2>执行计划</h2><p>各链路独立分层，不代表全局开工时间。绿点表示未发现前置阻塞；跨链路、范围外前置和环须另行确认。</p></div>
    ${epicHtml || `<p class="empty">没有发现依赖关系或拆分链路。</p>`}
    ${pendingHtml ? `<div class="cross warn"><h4>前置状态待确认（范围外或未解析）</h4><ul>${pendingHtml}</ul></div>` : ""}
    ${crossEdges.length ? `<div class="cross"><h4>跨链路依赖</h4><ul>${crossEdges.map((e) => `<li>${ref(e.from)}<span class="rel">先于</span>${ref(e.to)}</li>`).join("")}</ul></div>` : ""}
    ${o.graph.cycles.length ? `<div class="cross warn"><h4>循环依赖，需要人工拆解</h4><ul>${o.graph.cycles.map((cy) => `<li>${cy.map((n) => ref(n)).join('<span class="rel">⇄</span>')}</li>`).join("")}</ul></div>` : ""}
  </section>

  ${reviewRows.length ? `<section id="review" class="block">
    <div class="block-head"><h2>待确认</h2><p>模型拿不准的判断。条形图展示各结论的概率分布。</p></div>
    <ul class="reviews">${reviewRows.join("")}</ul>
  </section>` : ""}
  ${mergeHtml || relatedHtml ? `<div class="pair-blocks">
    ${mergeHtml ? `<section id="merge" class="block">
      <div class="block-head"><h2>可合并</h2><p>内容重复，保留一条，其余可关闭。</p></div>
      ${mergeHtml}
    </section>` : ""}
    ${relatedHtml ? `<section id="related" class="block">
      <div class="block-head"><h2>相关主题</h2><p>不重复，但适合放进同一个迭代处理。</p></div>
      ${relatedHtml}
    </section>` : ""}
  </div>` : ""}
  ${empties.length ? `<p class="quiet">${empties.map(([, label]) => label).join("、")}：没有单独展示的模型判断；同链路主题已在执行计划中体现。</p>` : ""}

  <section id="rest" class="block">
    <div class="block-head"><h2>独立 issue</h2><p>与其他 issue 没有重复、依赖或主题关联，按类型排列。</p></div>
    <table class="rest"><colgroup><col style="width:5.5rem"><col><col style="width:7rem"></colgroup>${restHtml}</table>
  </section>
  <p class="no-match" hidden>没有匹配的 issue。</p>
</main>
<script type="application/json" id="graph">${graphData}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{
  --bg:oklch(0.982 0.004 85);--panel:oklch(0.996 0.002 85);--sunk:oklch(0.962 0.005 85);
  --ink:oklch(0.25 0.012 265);--ink-2:oklch(0.44 0.012 265);--ink-3:oklch(0.6 0.01 265);
  --line:oklch(0.9 0.006 85);--line-2:oklch(0.84 0.008 85);
  --accent:oklch(0.5 0.14 262);--ready:oklch(0.56 0.12 155);
  --t-bug:oklch(0.56 0.16 28);--t-feature:oklch(0.52 0.12 255);--t-tech_debt:oklch(0.5 0.11 305);
  --t-tooling:oklch(0.6 0.12 70);--t-question:oklch(0.55 0.09 195);--t-other:oklch(0.6 0.012 265);
  --wire:oklch(0.72 0.01 265);
  --r:8px;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --bg:oklch(0.19 0.008 265);--panel:oklch(0.225 0.009 265);--sunk:oklch(0.205 0.008 265);
  --ink:oklch(0.93 0.006 85);--ink-2:oklch(0.76 0.008 85);--ink-3:oklch(0.6 0.008 265);
  --line:oklch(0.3 0.01 265);--line-2:oklch(0.36 0.012 265);
  --accent:oklch(0.72 0.12 262);--ready:oklch(0.74 0.13 155);
  --t-bug:oklch(0.7 0.15 28);--t-feature:oklch(0.72 0.11 255);--t-tech_debt:oklch(0.72 0.1 305);
  --t-tooling:oklch(0.78 0.12 75);--t-question:oklch(0.74 0.09 195);--t-other:oklch(0.68 0.01 265);
  --wire:oklch(0.45 0.012 265);
}}
*{box-sizing:border-box}
html{scroll-padding-top:7.5rem}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
b{font-weight:600}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
[data-t="bug"]{--t:var(--t-bug)}[data-t="feature"]{--t:var(--t-feature)}[data-t="tech_debt"]{--t:var(--t-tech_debt)}
[data-t="tooling"]{--t:var(--t-tooling)}[data-t="question"]{--t:var(--t-question)}[data-t="other"]{--t:var(--t-other)}

.top{position:sticky;top:0;z-index:10;background:color-mix(in oklch,var(--bg) 92%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.top-inner,.tabs,main{max-width:1320px;margin:0 auto;padding:0 32px}
.top-inner{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-top:18px}
.crumb{font-size:12px;color:var(--ink-3);font-family:var(--mono)}
h1{margin:2px 0 0;font-size:22px;line-height:1.2;font-weight:650;letter-spacing:-0.01em}
h1 a:hover{color:var(--accent)}
h1 .sub{font-weight:400;color:var(--ink-3);margin-left:10px;font-size:15px}
.search{position:relative;display:flex;align-items:center}
.search input{width:280px;height:34px;padding:0 34px 0 12px;border:1px solid var(--line-2);border-radius:var(--r);background:var(--panel);color:var(--ink);font:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklch,var(--accent) 18%,transparent)}
.search kbd{position:absolute;right:9px;font:11px var(--mono);color:var(--ink-3);border:1px solid var(--line-2);border-radius:4px;padding:0 5px}
.tabs{display:flex;gap:4px;margin-top:10px}
.tabs a{padding:8px 10px 10px;color:var(--ink-2);font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a span{margin-left:6px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);border-bottom-color:var(--ink)}

main{padding-bottom:96px}
.summary{padding:32px 0 8px}
.lede{font-size:17px;line-height:1.6;max-width:76ch;margin:0 0 20px;color:var(--ink-2)}
.lede b{color:var(--ink);font-variant-numeric:tabular-nums}
.mix{display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;max-width:720px}
.mix-seg{background:var(--t)}
.mix-legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.filter{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink-2);font:inherit;font-size:13px;cursor:pointer;transition:border-color .15s,background .15s}
.filter b{color:var(--ink);font-variant-numeric:tabular-nums}
.filter .share{color:var(--ink-3);font-size:12px}
.filter:hover{border-color:var(--line-2)}
.filter[aria-pressed="true"]{border-color:var(--t);background:color-mix(in oklch,var(--t) 9%,var(--panel));color:var(--ink)}
.filter:focus-visible,.node:focus-visible,.ref:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--t)}
.meta{margin:18px 0 0;font-size:12px;color:var(--ink-3)}

.block{padding-top:48px}
.block-head{display:flex;align-items:baseline;gap:16px;margin-bottom:16px;flex-wrap:wrap}
h2{margin:0;font-size:17px;font-weight:650;letter-spacing:-0.005em}
.block-head p{margin:0;color:var(--ink-3);font-size:13px}
.empty{color:var(--ink-3);margin:0;padding:18px 0}

.type{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;font:600 10.5px/1 var(--mono);letter-spacing:.03em;color:var(--t);background:color-mix(in oklch,var(--t) 11%,transparent)}
.type i{font-style:normal;opacity:.75;margin-left:1px}
.iid{font:12px var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums}

.epic{margin-top:14px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
.epic-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:14px 20px 0;flex-wrap:wrap}
.epic-head h3{margin:0;font-size:15px;font-weight:600}
.epic-meta{display:flex;gap:14px;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.epic-parent:hover,.epic-parent:hover .iid{color:var(--accent)}
.flow-scroll{overflow-x:auto;padding:4px 0 18px;border-radius:0 0 12px 12px}
.flow-scroll.more-r{mask-image:linear-gradient(to right,#000 calc(100% - 56px),transparent)}
.flow-scroll.more-l{mask-image:linear-gradient(to right,transparent,#000 56px)}
.flow-scroll.more-l.more-r{mask-image:linear-gradient(to right,transparent,#000 56px,#000 calc(100% - 56px),transparent)}
.flow{position:relative;display:flex;gap:48px;padding:0 20px;width:max-content;min-width:100%}
.col{position:relative;z-index:1;display:flex;flex-direction:column;gap:10px;width:212px}
.col-head{font-size:11.5px;color:var(--ink-3);padding:10px 0 2px;letter-spacing:.02em}
.node-status{font-size:11px;color:var(--ink-3);overflow-wrap:anywhere}
.node.ready .node-status{color:var(--ready)}
.node{display:flex;flex-direction:column;gap:6px;padding:10px 12px 11px;border:1px solid var(--line);border-radius:var(--r);background:var(--panel);transition:border-color .15s,box-shadow .15s,opacity .2s}
.node:hover{border-color:var(--line-2);box-shadow:0 1px 2px oklch(0.2 0.01 265/.06),0 4px 14px oklch(0.2 0.01 265/.06)}
.node-head{display:flex;align-items:center;gap:6px}
.node-head .type{margin-left:auto}
.seq{font:600 11px var(--mono);color:var(--ink-2);background:var(--sunk);border-radius:4px;padding:1px 5px}
.node-title{font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.node.ready{border-color:color-mix(in oklch,var(--ready) 45%,var(--line))}
.node.ready .iid::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ready);margin-right:6px;vertical-align:1px}
.wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0}
.wires path{fill:none;stroke:var(--wire);stroke-width:1.25;transition:stroke .2s,opacity .2s}
.wires path.guess{stroke-dasharray:4 4}
.wires .head{fill:var(--wire);stroke:none;transition:fill .2s,opacity .2s}
.flow.focus .node{opacity:.28}
.flow.focus .node.lit{opacity:1}
.flow.focus .node.self{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
.flow.focus .wires path,.flow.focus .wires .head{opacity:.15}
.flow.focus .wires .lit{opacity:1;stroke:var(--accent)}
.flow.focus .wires .head.lit{fill:var(--accent)}

.cross{margin-top:14px;padding:14px 20px;border:1px dashed var(--line-2);border-radius:12px}
.cross h4{margin:0 0 8px;font-size:13px;font-weight:600}
.cross.warn h4{color:var(--t-bug)}
.cross ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.cross li{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

.ref{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;border-radius:6px}
.ref .ref-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ref:hover .ref-title{color:var(--accent)}
.rel{font-size:12px;color:var(--ink-3);white-space:nowrap}

.reviews{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.review{display:grid;grid-template-columns:5.5rem minmax(0,1fr) 260px;gap:20px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}
.review-kind{font-size:12px;color:var(--ink-2)}
.review-pair{display:grid;grid-template-columns:minmax(0,1fr);gap:4px}
.review-pair .rel{padding-left:2px}
.bar{display:flex;height:6px;border-radius:3px;overflow:hidden;gap:2px;background:var(--sunk)}
.seg[data-k="hi"]{background:var(--accent)}
.seg[data-k="mid"]{background:color-mix(in oklch,var(--accent) 40%,var(--line-2))}
.seg[data-k="lo"]{background:var(--line-2)}
.bar-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:12px;color:var(--ink-3)}
.bar-legend b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}

.pair-blocks{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:0 48px}
.quiet{margin:40px 0 0;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--ink-3);font-size:13px}
.cluster{padding:14px 0;border-top:1px solid var(--line)}
.cluster:last-child{border-bottom:1px solid var(--line)}
.cluster-hub{display:flex;align-items:center;gap:10px;font-weight:500}
.cluster ul{list-style:none;margin:8px 0 0;padding:0 0 0 16px;border-left:1px solid var(--line-2);display:grid;gap:6px}
.cluster li{display:flex;align-items:center;gap:10px;min-width:0}
.cluster li .ref{flex:1 1 auto}
.note{flex:none;font-size:12px;color:var(--ink-3);white-space:nowrap}
.note.keep{color:var(--ready)}

.rest{width:100%;border-collapse:collapse}
.rest th,.rest td{text-align:left;padding:9px 0;border-bottom:1px solid var(--line);vertical-align:baseline}
.rest tr.group th{padding-top:22px;font-weight:600;font-size:13px;display:table-cell}
.rest tr.group .type{margin-right:8px}
.rest tr.group .count{margin-left:8px;color:var(--ink-3);font-weight:400;font-variant-numeric:tabular-nums}
.rest td.iid a:hover,.row-title:hover{color:var(--accent)}
.rest td.date{font:12px var(--mono);color:var(--ink-3);text-align:right}
.unsure{margin-left:10px;font-size:11.5px;color:var(--ink-3);border:1px solid var(--line-2);border-radius:4px;padding:0 5px}
.no-match{color:var(--ink-3);text-align:center;padding:48px 0}
.hide{display:none!important}

@media (max-width:900px){
  .top-inner,.tabs,main{padding-left:16px;padding-right:16px}
  .top-inner{align-items:stretch;flex-direction:column;gap:12px}
  .title,.epic,.pair-blocks>section{min-width:0;overflow-wrap:anywhere}
  .search input{width:100%}
  .search{width:100%}
  .rest{table-layout:fixed;overflow-wrap:anywhere}
  .cluster li,.cross li{align-items:flex-start;flex-direction:column}
  .ref .ref-title{white-space:normal;overflow-wrap:anywhere}
  .note{white-space:normal}
  .review{grid-template-columns:1fr;gap:8px}
  .pair-blocks{grid-template-columns:1fr}
  .tabs{overflow-x:auto}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const JS = `
(() => {
  const { edges } = JSON.parse(document.getElementById("graph").textContent);
  const out = new Map(), inn = new Map();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e.to);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)).push(e.from);
  }
  const walk = (start, adj) => {
    const seen = new Set(), stack = [start];
    while (stack.length) for (const n of adj.get(stack.pop()) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return seen;
  };
  const NS = "http://www.w3.org/2000/svg";

  function draw(flow) {
    const svg = flow.querySelector(".wires");
    svg.replaceChildren();
    const box = flow.getBoundingClientRect();
    const at = new Map([...flow.querySelectorAll(".node")].map((n) => [Number(n.dataset.iid), n]));
    for (const e of edges) {
      const a = at.get(e.from), b = at.get(e.to);
      if (!a || !b || a.offsetParent === null || b.offsetParent === null) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - box.left, y1 = ra.top + ra.height / 2 - box.top;
      const x2 = rb.left - box.left - 6, y2 = rb.top + rb.height / 2 - box.top;
      const dx = Math.max(24, (x2 - x1) / 2);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", \`M\${x1} \${y1} C\${x1 + dx} \${y1} \${x2 - dx} \${y2} \${x2} \${y2}\`);
      if (e.source === "jev") p.classList.add("guess");
      p.dataset.from = e.from; p.dataset.to = e.to;
      const t = document.createElementNS(NS, "title");
      t.textContent = \`#\${e.from} 先于 #\${e.to} · \${e.source === "jev" ? "模型推断 " + Math.round(e.p * 100) + "%" : e.source === "declared" ? "issue 正文声明" : "平台关联"}\`;
      p.append(t);
      const h = document.createElementNS(NS, "path");
      h.setAttribute("d", \`M\${x2} \${y2 - 3.5} L\${x2 + 6} \${y2} L\${x2} \${y2 + 3.5} Z\`);
      h.classList.add("head"); h.dataset.from = e.from; h.dataset.to = e.to;
      svg.append(p, h);
    }
  }
  const flows = [...document.querySelectorAll(".flow")];
  const edgeHint = (sc) => {
    sc.classList.toggle("more-l", sc.scrollLeft > 2);
    sc.classList.toggle("more-r", sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 2);
  };
  document.querySelectorAll(".flow-scroll").forEach((sc) => sc.addEventListener("scroll", () => edgeHint(sc), { passive: true }));
  const redraw = () => { flows.forEach(draw); document.querySelectorAll(".flow-scroll").forEach(edgeHint); };
  redraw();
  document.fonts?.ready.then(redraw);
  new ResizeObserver(redraw).observe(document.body);

  function focus(node) {
    const flow = node.closest(".flow");
    const id = Number(node.dataset.iid);
    const up = walk(id, inn), down = walk(id, out);
    const lit = new Set([id, ...up, ...down]);
    flow.classList.add("focus");
    flow.querySelectorAll(".node").forEach((n) => {
      n.classList.toggle("lit", lit.has(Number(n.dataset.iid)));
      n.classList.toggle("self", Number(n.dataset.iid) === id);
    });
    flow.querySelectorAll(".wires [data-from]").forEach((p) => {
      const f = Number(p.dataset.from), t = Number(p.dataset.to);
      const onUp = (f === id || up.has(f)) && (t === id || up.has(t));
      const onDown = (f === id || down.has(f)) && (t === id || down.has(t));
      p.classList.toggle("lit", onUp || onDown);
    });
  }
  function blur(node) { node.closest(".flow").classList.remove("focus"); }
  document.querySelectorAll(".node").forEach((n) => {
    n.addEventListener("mouseenter", () => focus(n));
    n.addEventListener("mouseleave", () => blur(n));
    n.addEventListener("focus", () => focus(n));
    n.addEventListener("blur", () => blur(n));
  });

  // 搜索 + 类型筛选
  const q = document.getElementById("q");
  const active = new Set();
  const noMatch = document.querySelector(".no-match");
  function apply() {
    const s = q.value.trim().toLowerCase();
    const ok = (el) => (!s || (el.dataset.q ?? "").includes(s)) && (!active.size || active.has(el.dataset.t));
    let any = false;
    document.querySelectorAll(".node, .rest tr[data-q]").forEach((el) => { const v = ok(el); el.classList.toggle("hide", !v); any ||= v; });
    document.querySelectorAll(".rest tbody").forEach((tb) => tb.classList.toggle("hide", !tb.querySelector("tr[data-q]:not(.hide)")));
    document.querySelectorAll(".epic").forEach((ep) => ep.classList.toggle("hide", !ep.querySelector(".node:not(.hide)")));
    document.querySelectorAll(".review").forEach((el) => { const v = !s || el.dataset.q.includes(s); el.classList.toggle("hide", !v); any ||= v; });
    noMatch.hidden = any;
    redraw();
  }
  q.addEventListener("input", apply);
  document.querySelectorAll(".filter").forEach((b) => b.addEventListener("click", () => {
    const t = b.dataset.t;
    active.has(t) ? active.delete(t) : active.add(t);
    b.setAttribute("aria-pressed", String(active.has(t)));
    apply();
  }));
  addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === "Escape" && document.activeElement === q) { q.value = ""; apply(); q.blur(); }
  });

  // 顶部导航高亮当前区块
  const tabs = [...document.querySelectorAll(".tabs a")];
  const io = new IntersectionObserver((es) => es.forEach((en) => {
    if (en.isIntersecting) tabs.forEach((t) => t.classList.toggle("on", t.getAttribute("href") === "#" + en.target.id));
  }), { rootMargin: "-40% 0px -55% 0px" });
  document.querySelectorAll("main section[id]").forEach((s) => io.observe(s));
})();
`;
