# jev-triage

[中文说明在下方] Map a GitHub or GitLab backlog into one HTML report: duplicate groups, related topics, issue types and dependency order. Deterministic code fetches, cleans, recalls candidates and builds the graph; [TypeSafe Jev](https://docs.typesafe.ai) answers only narrow typed questions (duplicate? which comes first? what type?). Works through `gh` (GitHub / GitHub Enterprise) or `glab` (GitLab), read-only.

```bash
npm install -g @zephyrdeng/jev-triage
jev-triage analyze --project owner/repo --dry-run        # recall only, no model calls
jev-triage analyze --project https://gitlab.com/group/proj # full analysis → out/overview-*.html
```

Requires Node.js ≥ 20.12, `gh` or `glab` logged in to the target host, and `TYPESAFE_API_KEY` for model analysis. CLI output and reports are currently in Chinese.

Independent community project, not affiliated with or endorsed by TypeSafe. "Jev" refers to TypeSafe's model, which this tool calls through the official SDK.

---

基于 GitHub / GitLab issue 列表 + 内容，用 [TypeSafe Jev](https://docs.typesafe.ai) 做去重合并、相关主题（功能性合并）、类型分类和依赖分析，输出交互式 HTML 总览，同时保留 ASCII、JSON 和 Markdown 报告（后续：业务优先级排序）。

**分工原则**：代码负责流程与确定性工作（拉取、清洗、召回、聚类、选保留项），Jev 只做窄而明确的判断。默认直接把原文交给 Jev；`--translate` 可选先用 LLM 翻译成英文。

## 流程（MVP：去重）

```
gh / glab 拉取 ──► 确定性清洗 ──►（可选）LLM 翻译 ──► TF-IDF 候选召回 ──► Jev 判重 ──► 聚类 & 报告
 (缓存)            (去元数据/截断)   (缓存)              (top-k 邻居)       (缓存)      (out/*.md|json)
```

每个候选对只发一次 Jev 请求，里面并行问 5 个问题：

| id | 类型 | 用途 |
|---|---|---|
| `relation` | Score 3 档：不同 / 相关待定 / 重复 | 直接对应三条出路：保持独立 / 人工确认 / 合并 |
| `same_problem` | Noul | 给人工确认的线索 |
| `same_area` | Noul | 给人工确认的线索 |
| `a_covers_b` / `b_covers_a` | Noul | 在重复组里挑选保留哪一个 |

判定：`P(重复档) ≥ 0.7` → 重复；`P(不同档) ≥ 0.7` → 不同；其余 → 待人工确认。阈值需用历史数据标定。

## analyze：HTML 总览（附 ASCII 版）

主报告是 `out/overview-*.html`（单文件、无外部依赖）：按交付链路画依赖流程图（左到右为链路内部依赖分层），另有前置状态待确认、可能重复/依赖、可合并、相关主题和按类型排列的其他 issue。支持节点高亮、搜索和类型筛选。

链路各自分层，列号不代表全局开工顺序。绿点表示当前证据未发现前置阻塞，判断包含跨链路前置、环、范围外和未解析前置；不是对“可以开工”的保证。闭合环须先拆解，范围外 issue 的状态不自动假定为已完成。JSON 保留全部边 `graph.edges` 和展示约简边 `graph.reduced`。

默认标准输出为 HTML 的绝对路径；`--format ascii` 输出终端总览，`--format json` 输出完整结构化总览。进度写入 stderr，三种文件始终生成：

```
■ 可合并        重复组（Score + Noul），标出保留项
■ 相关主题      不重复但适合一起做（Score 的"相关"档聚类），标注包含关系
■ 依赖关系      依赖树 A ─▶ B（已做传递约简）：正文声明 + 平台关联（GitLab blocks / GitHub issue dependencies）+ Jev 推断（Choice，正反各问一次取平均）
■ 执行顺序      分层拓扑排序，同层可并行；检测循环依赖
■ 待人工确认    可能重复 / 可能依赖
■ 其余独立      按类型（Choice：BUG / FEAT / TECH / TOOL / ASK / OTHER）
```

候选对：两两组合数 ≤ 200 时全量判断；更多时用 TF-IDF 召回（去重严格、依赖宽松），并强制纳入正文 `#iid` 互相引用和平台关联的对。

正文声明优先于模型：解析 issue 模板里的 `## Parent` 与 `## Blocked by`（支持 `#iid`、URL 和同一父 issue 下的序号如 `- 04, 09`）。父子关系是拆分，不参与判重与依赖判断；完整解析了 Blocked by 的 issue，其前置以声明为准，模型推断的其他前置会丢弃。空段、无法唯一定位的序号、范围外或跨项目的前置保留为 `unresolved`，不当成“无依赖”。

## 平台与项目

| 平台 | 访问方式 | `--project` 示例 | 显式关联 |
|---|---|---|---|
| GitHub / GHES | `gh api` | `owner/repo`、`https://github.com/owner/repo/issues` | issue dependencies（blocked by / blocking），未开启时视为无 |
| GitLab | `glab api` | 项目 id、`group/sub/proj`、`https://gitlab.com/group/proj/-/issues` | issue links（blocks / is_blocked_by / relates_to） |

URL 与 `git@host:…` 中的主机优先；裸路径使用 `--host`（默认 `$FORGE_HOST` 或 `github.com`）。平台按 `--forge`、`$FORGE`、主机名是否含 `github` 的顺序判断，主机名不含 github 的 GitHub Enterprise 需加 `--forge github`。GitHub 的 issue 列表接口会返回 PR，CLI 只保留 issue；机器人评论不计入 `--with-notes`。

## 安装 CLI 与内置 skill

要求 Node.js ≥20.12，以及已登录目标主机的 `gh`（GitHub）或 `glab`（GitLab）。

```bash
npm install -g @zephyrdeng/jev-triage
jev-triage --version
jev-triage --help

# 在任意工作目录调用 CLI，缓存和报告写到该工作目录
jev-triage analyze --project owner/repo --dry-run
jev-triage analyze --project https://gitlab.com/group/proj --format json > overview.json

# 内置 skill 可直接读取；--path 输出安装后的绝对路径
jev-triage skill
jev-triage skill --path
```

[内置 skill](skills/jev-triage/SKILL.md) 是标准 Agent Skills 目录；技能提供流程与边界，CLI 执行取数、判定和生成报告，不需要常驻服务或 MCP。

Pi 用户可以从全局 npm 安装位置加载整个包（包内已声明 `pi.skills`），或仅本次会话加载 skill：

```bash
pi install "$(npm root -g)/@zephyrdeng/jev-triage"
# 或：不修改持久配置，只加载一次
pi --skill "$(jev-triage skill --path)"
```

其他宿主可加载/链接该 `SKILL.md` 所在目录。若复制 skill，需要保留 README/CLI 的相对布局，或使用已在 PATH 的 `jev-triage` 并修正 README 链接。不会在安装时自动写入任何 agent 配置。

## 使用（源码开发）

```bash
npm install
cp .env.example .env   # TYPESAFE_API_KEY；LLM_* 仅 --translate 需要
gh auth status         # 或 glab auth status，确认已登录目标主机

# 只做清洗/召回，看候选对，不调 Jev
npm run dev -- dedupe --project owner/repo --state all --dry-run

# 去重 + 相关主题 + 类型 + 依赖，输出 out/overview-*.html（及 .txt）
npm run dev -- analyze --project https://gitlab.com/group/proj

# 只做去重，忽略某类标签
npm run dev -- dedupe --project owner/repo --ignore-label '^release:'
```

`npm run dev -- --help` 查看全部参数。所有中间结果缓存在工作目录的 `.cache/`，重跑仅对未命中的模型输入计费；查看最新 issue 时加 `--refresh`。只读 `fetch` 和不带 `--translate` 的 dry-run 不调用模型；正式分析会把清洗后的 issue 内容发送至 TypeSafe，翻译另需 LLM 配置与费用。

API key 使用环境变量或工作目录 `.env`；`TYPESAFE_ENV_FILE` 可指定备用 env 文件（默认 `~/.config/ego-jev/secrets.env`）。报告和缓存包含项目数据，私有项目的报告不要公开上传。

CLI 只读，不会自动关闭、合并或修改 issue。模型分类置信度与阈值仍需校准，依赖分层不是业务优先级排序。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE)
