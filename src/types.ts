/** issue 中我们关心的字段（从 GitHub / GitLab REST API 映射而来）。 */
export interface Issue {
  iid: number;
  /** GitLab 为项目 id，GitHub 为 owner/repo。 */
  projectId: number | string;
  title: string;
  description: string;
  labels: string[];
  state: string;
  issueType: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  userNotesCount: number;
  upvotes: number;
  mergeRequestsCount: number;
  milestone: string | null;
  /** 仅在 --with-notes 时填充：非系统评论正文。 */
  notes?: string[];
  /** 仅在需要时填充：平台上显式建立的 issue 关联。 */
  links?: IssueLink[];
}

export interface IssueLink {
  iid: number;
  projectId: number | string;
  /** relates_to | blocks | is_blocked_by */
  linkType: string;
}

/** 清洗 + 翻译后交给 Jev 的 issue 视图。 */
export interface PreparedIssue {
  iid: number;
  webUrl: string;
  /** 原始标题（报告里展示用）。 */
  originalTitle: string;
  /** 英文标题 / 正文 / 标签（Jev 与候选召回使用）。 */
  title: string;
  description: string;
  labels: string[];
  translated: boolean;
  raw: Issue;
}
