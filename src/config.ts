import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * 加载 .env（不覆盖已存在的变量）；若仍没有 TYPESAFE_API_KEY，
 * 再从 TYPESAFE_ENV_FILE（默认与 ego-jev 共用的 ~/.config/ego-jev/secrets.env）读取。
 */
export function loadEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
  if (!process.env.TYPESAFE_API_KEY) {
    const file = (process.env.TYPESAFE_ENV_FILE ?? "~/.config/ego-jev/secrets.env").replace(/^~(?=\/)/, homedir());
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 额外请求头（LLM_HEADERS，JSON）。 */
  headers: Record<string, string>;
  /** 合并进请求体的额外字段（LLM_EXTRA_BODY，JSON），如 {"thinking":{"type":"disabled"}}。 */
  extraBody: Record<string, unknown>;
}

function jsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} 不是合法 JSON: ${raw}`);
  }
}

export function llmConfig(): LlmConfig {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("缺少 LLM_API_KEY（翻译用的 LLM），请在 .env 中配置");
  const baseURL = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers = jsonEnv<Record<string, string>>("LLM_HEADERS", {});
  // opencode (zen / go) 要求每个会话带路由头
  if (new URL(baseURL).hostname.endsWith("opencode.ai") && !headers["x-opencode-session"]) {
    headers["x-opencode-session"] = `backlog-atlas-${randomUUID()}`;
  }
  return {
    baseURL,
    apiKey,
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    headers,
    extraBody: jsonEnv<Record<string, unknown>>("LLM_EXTRA_BODY", {}),
  };
}

/** 裸 owner/repo 或项目路径使用的默认主机；URL 中的主机优先。 */
export function defaultHost(): string {
  return process.env.FORGE_HOST ?? "github.com";
}
