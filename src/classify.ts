import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { issueState } from "./dedupe.js";
import type { PreparedIssue } from "./types.js";
import { DiskCache, sha256 } from "./util.js";

/** issue 类型：互斥、无序 → Choice。键名即报告里的类型标签。 */
export const TYPE_CRITERIA = {
  bug: "Something in the product that is supposed to work is broken or behaves incorrectly (errors, wrong data, crashes, regressions).",
  feature:
    "A new product capability, or a change to how the product behaves for merchants or end users, requested by users or product managers.",
  tech_debt:
    "An internal engineering change to the product code that does not change product behavior: refactoring, performance, architecture, migration, stability, monitoring, or cleanup.",
  tooling:
    "A problem or request about developer tooling rather than the product itself: coding agents, skills, scripts, CI, local environment, credentials, permissions, or internal automation.",
  question: "A usage question, consultation, or request for information, not a request to change anything.",
  other: "None of the other types fits.",
} as const;

export type IssueType = keyof typeof TYPE_CRITERIA;

export const TYPE_TAG: Record<IssueType, string> = {
  bug: "BUG",
  feature: "FEAT",
  tech_debt: "TECH",
  tooling: "TOOL",
  question: "ASK",
  other: "OTHER",
};

export const TYPE_NAME: Record<IssueType, string> = {
  bug: "缺陷",
  feature: "需求",
  tech_debt: "技术优化",
  tooling: "工具/环境",
  question: "咨询",
  other: "其他",
};

const QUESTIONS = {
  type: choice("What kind of work item is the issue in `issue`?", TYPE_CRITERIA),
} as const;

export interface IssueClassification {
  iid: number;
  type: IssueType;
  confidence: number;
  probabilities: Record<IssueType, number>;
  inputTokens: number;
  cached: boolean;
}

interface Cached {
  type: IssueType;
  confidence: number;
  probabilities: Record<IssueType, number>;
  inputTokens: number;
}

export class IssueClassifier {
  private readonly cache: DiskCache;

  constructor(
    private readonly client: TypeSafeClient,
    private readonly model: string,
    cacheDir: string,
  ) {
    this.cache = new DiskCache(cacheDir);
  }

  async classify(issue: PreparedIssue): Promise<IssueClassification> {
    const state = { issue: issueState(issue) };
    const key = sha256({ v: 1, model: this.model, state, questions: QUESTIONS });
    const { value, hit } = await this.cache.wrap<Cached>(key, async () => {
      const res = await this.client.systemOne({ model: this.model, state, questions: QUESTIONS });
      return {
        type: res.answers.type.choice,
        confidence: res.answers.type.confidence,
        probabilities: { ...res.answers.type.probabilities },
        inputTokens: res.usage.input_tokens,
      };
    });
    return { iid: issue.iid, ...value, cached: hit };
  }
}
