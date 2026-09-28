import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue, IssueLink } from "./types.js";
import { mapPool } from "./util.js";

const exec = promisify(execFile);

export type Forge = "github" | "gitlab";

export interface FetchOptions {
  forge: Forge;
  host: string;
  /** GitHub：owner/repo；GitLab：项目 id 或 path_with_namespace。 */
  project: string;
  state?: "opened" | "closed" | "all";
  labels?: string[];
  /** 最多拉取多少条（按更新时间倒序）。 */
  limit?: number;
  withNotes?: boolean;
  maxNotes?: number;
  /** 拉取显式 issue 关联（GitLab issue links / GitHub issue dependencies，每条 issue 一至两次 API 调用）。 */
  withLinks?: boolean;
}

/** issue 网页地址中的路径：GitLab 为 `/-/issues/N`，GitHub 为 `/issues/N`。 */
export const ISSUE_PATH_RE = String.raw`(?:/-)?/issues/(\d+)`;
/** 从 issue 网页地址得到项目地址。 */
export const projectUrlOf = (webUrl: string) => webUrl.replace(/(?:\/-)?\/issues\/\d+$/, "");

/** `--forge` 优先；否则主机名含 github 视为 GitHub，其余视为 GitLab。 */
export function detectForge(host: string, explicit?: string): Forge {
  if (explicit) {
    if (explicit !== "github" && explicit !== "gitlab") throw new Error(`--forge 应为 github 或 gitlab：${explicit}`);
    return explicit;
  }
  return /(^|\.)github\b/i.test(host) ? "github" : "gitlab";
}

/**
 * 解析 --project：支持 owner/repo、GitLab 项目 id / path_with_namespace，或直接粘贴浏览器地址
 * （如 https://github.com/o/r/issues、https://host/group/proj/-/issues、git@host:group/proj.git）。
 * URL 中的主机优先于默认主机。
 */
export function parseProjectRef(
  input: string,
  defaultHost: string,
  forgeFlag?: string,
): { forge: Forge; host: string; project: string } {
  const s = input.trim();
  let host = defaultHost;
  let path: string;
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) [host, path] = [ssh[1]!, ssh[2]!];
  else if (/^https?:\/\//.test(s)) {
    const url = new URL(s);
    host = url.host;
    path = decodeURIComponent(url.pathname).replace(/\.git$/, "");
  } else path = s;
  const forge = detectForge(host, forgeFlag);
  path = path.replace(/\/-\/.*$/, "").replace(/^\/+|\/+$/g, "");
  // GitHub 仓库固定为 owner/repo，其后的 /issues、/pulls 等都是页面路径
  if (forge === "github") path = path.split("/").slice(0, 2).join("/");
  if (!path || (forge === "github" && !path.includes("/"))) throw new Error(`无法解析项目：${input}`);
  return { forge, host, project: path };
}

async function api<T>(forge: Forge, host: string, path: string): Promise<T> {
  const bin = forge === "github" ? "gh" : "glab";
  try {
    const { stdout } = await exec(bin, ["api", "--hostname", host, path], { maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).trim();
    throw new Error(`${bin} api 调用失败（${host} ${path.split("?")[0]}）：${detail}`);
  }
}

export async function fetchIssues(opts: FetchOptions): Promise<Issue[]> {
  return opts.forge === "github" ? fetchGithub(opts) : fetchGitlab(opts);
}

// ---------------------------------------------------------------------------
// GitLab（glab）
// ---------------------------------------------------------------------------

function projectRef(project: string): string {
  return /^\d+$/.test(project) ? project : encodeURIComponent(project);
}

interface RawGitlabIssue {
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  labels: string[];
  state: string;
  issue_type?: string;
  type?: string;
  author?: { username?: string };
  created_at: string;
  updated_at: string;
  web_url: string;
  user_notes_count: number;
  upvotes: number;
  merge_requests_count?: number;
  milestone?: { title?: string } | null;
}

async function fetchGitlab(opts: FetchOptions): Promise<Issue[]> {
  const gl = <T>(path: string) => api<T>("gitlab", opts.host, `projects/${projectRef(opts.project)}/${path}`);
  const perPage = 100;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const out: Issue[] = [];
  for (let page = 1; out.length < limit; page++) {
    const q = new URLSearchParams({
      state: opts.state ?? "opened",
      per_page: String(perPage),
      page: String(page),
      order_by: "updated_at",
      sort: "desc",
    });
    if (opts.labels?.length) q.set("labels", opts.labels.join(","));
    const batch = await gl<RawGitlabIssue[]>(`issues?${q}`);
    for (const r of batch) {
      out.push({
        iid: r.iid,
        projectId: r.project_id,
        title: r.title,
        description: r.description ?? "",
        labels: r.labels ?? [],
        state: r.state,
        issueType: r.issue_type ?? r.type ?? "issue",
        author: r.author?.username ?? "",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        webUrl: r.web_url,
        userNotesCount: r.user_notes_count ?? 0,
        upvotes: r.upvotes ?? 0,
        mergeRequestsCount: r.merge_requests_count ?? 0,
        milestone: r.milestone?.title ?? null,
      });
    }
    if (batch.length < perPage) break;
  }
  const issues = out.slice(0, limit);

  if (opts.withLinks) {
    await mapPool(issues, 6, async (issue) => {
      const links = await gl<{ iid: number; project_id: number; link_type: string }[]>(`issues/${issue.iid}/links`);
      issue.links = links.map((l): IssueLink => ({ iid: l.iid, projectId: l.project_id, linkType: l.link_type }));
    });
  }

  if (opts.withNotes) {
    for (const issue of issues) {
      if (issue.userNotesCount === 0) continue;
      const notes = await gl<{ body: string; system: boolean }[]>(
        `issues/${issue.iid}/notes?per_page=100&sort=asc&order_by=created_at`,
      );
      issue.notes = notes
        .filter((n) => !n.system && n.body.trim())
        .slice(0, opts.maxNotes ?? 10)
        .map((n) => n.body);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// GitHub（gh）
// ---------------------------------------------------------------------------

interface RawGithubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: ({ name?: string } | string)[];
  state: string;
  type?: { name?: string } | null;
  user?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  repository_url: string;
  comments: number;
  reactions?: { "+1"?: number };
  milestone?: { title?: string } | null;
  pull_request?: unknown;
  issue_dependencies_summary?: { total_blocked_by?: number; total_blocking?: number };
}

/** repository_url（…/repos/owner/repo）→ owner/repo，作为 GitHub 的项目标识。 */
const repoOf = (repositoryUrl: string) => repositoryUrl.replace(/^.*\/repos\//, "");

async function fetchGithub(opts: FetchOptions): Promise<Issue[]> {
  const gh = <T>(path: string) => api<T>("github", opts.host, `repos/${opts.project}/${path}`);
  const perPage = 100;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const out: Issue[] = [];
  /** 列表自带依赖计数时，用它跳过没有依赖的 issue；字段缺失（旧版 GHES）则逐条查询。 */
  const depCount = new Map<number, number>();
  for (let page = 1; out.length < limit; page++) {
    const state = opts.state === "all" ? "all" : opts.state === "closed" ? "closed" : "open";
    const q = new URLSearchParams({ state, per_page: String(perPage), page: String(page), sort: "updated", direction: "desc" });
    if (opts.labels?.length) q.set("labels", opts.labels.join(","));
    const batch = await gh<RawGithubIssue[]>(`issues?${q}`);
    // 这个接口同时返回 PR，只保留 issue
    for (const r of batch) {
      if (r.pull_request) continue;
      const d = r.issue_dependencies_summary;
      if (d) depCount.set(r.number, (d.total_blocked_by ?? 0) + (d.total_blocking ?? 0));
      out.push({
        iid: r.number,
        projectId: repoOf(r.repository_url),
        title: r.title,
        description: r.body ?? "",
        labels: r.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        // 与 GitLab 口径统一，下游只认 opened / closed
        state: r.state === "open" ? "opened" : r.state,
        issueType: r.type?.name ?? "issue",
        author: r.user?.login ?? "",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        webUrl: r.html_url,
        userNotesCount: r.comments ?? 0,
        upvotes: r.reactions?.["+1"] ?? 0,
        mergeRequestsCount: 0,
        milestone: r.milestone?.title ?? null,
      });
    }
    if (batch.length < perPage) break;
  }
  const issues = out.slice(0, limit);

  if (opts.withLinks) {
    // Issue dependencies 在旧版 GHES 或未开启时返回 404/410，此时视为没有显式关联
    const deps = async (n: number, kind: "blocked_by" | "blocking") => {
      try {
        return await gh<{ number: number; repository_url: string }[]>(`issues/${n}/dependencies/${kind}?per_page=100`);
      } catch (err) {
        if (/HTTP 40[4]|HTTP 410/.test(String(err))) return [];
        throw err;
      }
    };
    await mapPool(issues, 6, async (issue) => {
      if (depCount.get(issue.iid) === 0) return void (issue.links = []);
      const [blockedBy, blocking] = await Promise.all([deps(issue.iid, "blocked_by"), deps(issue.iid, "blocking")]);
      const link = (linkType: string) => (d: { number: number; repository_url: string }): IssueLink => ({
        iid: d.number,
        projectId: repoOf(d.repository_url),
        linkType,
      });
      issue.links = [...blockedBy.map(link("is_blocked_by")), ...blocking.map(link("blocks"))];
    });
  }

  if (opts.withNotes) {
    for (const issue of issues) {
      if (issue.userNotesCount === 0) continue;
      const comments = await gh<{ body: string | null; user?: { type?: string } | null }[]>(
        `issues/${issue.iid}/comments?per_page=100`,
      );
      issue.notes = comments
        .filter((c) => c.user?.type !== "Bot" && c.body?.trim())
        .slice(0, opts.maxNotes ?? 10)
        .map((c) => c.body!);
    }
  }
  return issues;
}
