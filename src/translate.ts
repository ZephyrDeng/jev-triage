import type { LlmConfig } from "./config.js";
import { CJK_RE, DiskCache, sha256 } from "./util.js";

export interface TranslationInput {
  title: string;
  description: string;
  labels: string[];
}

export type TranslationOutput = TranslationInput;

const SYSTEM_PROMPT = `You translate issue tracker issues into English for downstream machine classification.
Rules:
- Translate faithfully and completely. Do not summarize, explain, add, or omit information.
- Keep code, identifiers, file paths, URLs, issue references (#123), version strings, and Markdown structure unchanged.
- Translate person names to pinyin only if they are written in Chinese characters.
- "labels" are human-readable tags: translate any non-English words in them too (keep English parts and separators such as ":" as they are). The output must have exactly the same number of items, in the same order, as the input.
- Output only a JSON object: {"title": string, "description": string, "labels": string[]}.`;

export function needsTranslation(input: TranslationInput): boolean {
  return CJK_RE.test(input.title) || CJK_RE.test(input.description) || input.labels.some((l) => CJK_RE.test(l));
}

export class Translator {
  private readonly cache: DiskCache;

  constructor(
    private readonly cfg: LlmConfig,
    cacheDir: string,
  ) {
    this.cache = new DiskCache(cacheDir);
  }

  async translate(input: TranslationInput): Promise<{ value: TranslationOutput; translated: boolean; cached: boolean }> {
    if (!needsTranslation(input)) return { value: input, translated: false, cached: false };
    const key = sha256({ v: 1, model: this.cfg.model, prompt: SYSTEM_PROMPT, input });
    const { value, hit } = await this.cache.wrap(key, () => this.call(input));
    return { value, translated: true, cached: hit };
  }

  private async call(input: TranslationInput, attempt = 0): Promise<TranslationOutput> {
    const res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}`, ...this.cfg.headers },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        ...this.cfg.extraBody,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return this.call(input, attempt + 1);
      }
      throw new Error(`LLM 翻译失败 HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    try {
      return parseTranslation(content, input);
    } catch (err) {
      if (attempt < 2) return this.call(input, attempt + 1);
      throw err;
    }
  }
}

export function parseTranslation(content: string, input: TranslationInput): TranslationOutput {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`LLM 返回的不是 JSON: ${content.slice(0, 200)}`);
  const obj = JSON.parse(content.slice(start, end + 1)) as Partial<TranslationOutput>;
  if (typeof obj.title !== "string" || typeof obj.description !== "string") {
    throw new Error(`LLM 返回缺少 title/description: ${content.slice(0, 200)}`);
  }
  const labels =
    Array.isArray(obj.labels) && obj.labels.length === input.labels.length ? obj.labels.map(String) : input.labels;
  return { title: obj.title, description: obj.description, labels };
}
