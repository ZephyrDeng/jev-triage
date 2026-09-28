---
name: backlog-atlas
description: 使用 backlog-atlas CLI 分析 GitHub / GitLab issue 的重复、主题、类型和依赖，生成本地 HTML 流程图及 JSON/Markdown 报告。用于整理项目 backlog、查重复工单、核对执行顺序或输出 issue 总览；不负责代码审查或修改远端 issue。
compatibility: Node.js >=20.12, gh (GitHub) or glab (GitLab) authenticated to the target host; TypeSafe API credentials for model analysis.
---

# Backlog atlas

## 入口与范围

CLI 随此 skill 一起分发。优先运行 `backlog-atlas --help`；若不在 PATH，使用 `node "<此 skill 目录>/../../dist/cli.js" --help`，后续命令同样替换入口。若 dist 不存在，按包根目录的 [README](../../README.md) 构建。

在用户选择的工作目录运行，`.env`、`.cache/` 和默认 `out/` 都相对该目录。CLI 对 GitHub / GitLab 只读，不会关闭、合并或重标记 issue。报告包含项目标题、链接及部分前置原文，按源数据的访问范围保存；发布或上传报告需要另外授权。

## 工作流

1. **确认目标。** 优先使用用户提供的项目/issue URL、GitHub owner/repo、GitLab 项目 ID 或 namespace/path；缺失时从当前仓库 remote 判断平台、主机与项目。多个候选时确认具体目标。主机名不含 github 的 GitHub Enterprise 加 `--forge github`。查看 `--help` 并用 `gh auth status` 或 `glab auth status` 核对目标主机登录，完成标准是得到唯一项目和可用的只读访问。
2. **先看规模。** `backlog-atlas analyze --project "<ref>" --dry-run`。默认只分析 opened；显式传递用户要求的 state、label、limit、with-notes。查最新情况时加 `--refresh`；沿用缓存时记录 CLI 输出的拉取时间。此步不加 `--translate`，因此不调用模型。
3. **分析。** 已获准把 issue 内容发送至配置的模型服务并承担费用时，执行 `backlog-atlas analyze --project "<ref>" --format json`，保留相同筛选范围。否则先交付 dry-run 结果并确认。只查重复时改用 `dedupe`。API key 放在环境变量或受控 env 文件，配置方式见 [README](../../README.md)；只核对是否存在，避免打印密钥。默认无需翻译，`--translate` 会额外发送内容至 LLM 服务。
4. **核对结果。** 根据 stderr 报告路径读取 HTML 和 JSON；确认 issue 数、依赖边数、循环、`unresolved`、重复组和待确认判断。复跑缓存不会证明数据是最新的；候选召回未命中也不证明绝无重复或依赖。
5. **交付。** 返回 HTML 路径、关键发现、验证范围和待确认项。只有查看真实渲染和交互后才声称浏览器验收通过。提交仓库时排除 `.env`、缓存、报告和真实项目截图。

## 结果口径

- Parent 表示拆分关系，本身不是前置或重复关系。正文 Blocked by、GitLab blocks 关联与 GitHub issue dependencies 是显式证据，Jev 是概率推断。
- HTML 按链路独立分层；列号不是全局开工顺序。绿点仅表示当前证据未发现前置阻塞，需结合跨链路前置、范围外/无法解析的前置、闭环状态和循环检查。
- 范围外 issue 可能已关闭、被筛掉或属于其他项目，状态未查明前归入 `unresolved`，不能直接当作已完成。
- `graph.edges` 保留全部识别边，`graph.reduced` 仅用于简化展示；约简不删除原始证据。
- `?` 表示类型低置信度。重复/相关、包含和依赖是不同判断；关闭或合并建议需人工确认，依赖分层也不是业务优先级排序。
