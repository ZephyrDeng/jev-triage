import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanMarkdown, truncateByParagraph } from "./clean.js";
import { llmConfig } from "./config.js";
import { fetchIssues, type FetchOptions } from "./forge.js";
import { needsTranslation, Translator } from "./translate.js";
import type { Issue, PreparedIssue } from "./types.js";
import { log, mapPool, sha256 } from "./util.js";

export const CACHE_DIR = ".cache";

export async function loadIssues(opts: FetchOptions & { refresh?: boolean }): Promise<Issue[]> {
  const file = join(CACHE_DIR, "issues", `${sha256({ ...opts, refresh: undefined }).slice(0, 16)}.json`);
  if (!opts.refresh) {
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as { fetchedAt: string; issues: Issue[] };
      log(`使用缓存的 issue 列表（${cached.issues.length} 条，拉取于 ${cached.fetchedAt}），--refresh 可重新拉取`);
      return cached.issues;
    } catch {
      /* no cache */
    }
  }
  log(`通过 ${opts.forge === "github" ? "gh" : "glab"} 拉取 ${opts.host} / ${opts.project} 的 issue ...`);
  const issues = await fetchIssues(opts);
  await mkdir(join(CACHE_DIR, "issues"), { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), options: opts, issues }, null, 2));
  log(`拉取完成：${issues.length} 条`);
  return issues;
}

export interface PrepareOptions {
  maxChars: number;
  ignoreLabels: RegExp[];
  concurrency: number;
  translate: boolean;
}

/** 确定性清洗 → LLM 翻译成英文。 */
export async function prepareIssues(issues: Issue[], opts: PrepareOptions): Promise<PreparedIssue[]> {
  const inputs = issues.map((issue) => {
    let body = cleanMarkdown(issue.description, { maxChars: opts.maxChars });
    if (issue.notes?.length) {
      const notes = issue.notes.map((n) => `- ${cleanMarkdown(n, { maxChars: 600 })}`).join("\n");
      body = truncateByParagraph(`${body}\n\n## Comments\n${notes}`, opts.maxChars + 1500);
    }
    const labels = issue.labels.filter((l) => !opts.ignoreLabels.some((re) => re.test(l)));
    return { issue, input: { title: issue.title, description: body, labels } };
  });

  const toTranslate = opts.translate ? inputs.filter((x) => needsTranslation(x.input)).length : 0;
  const translator = toTranslate > 0 ? new Translator(llmConfig(), join(CACHE_DIR, "translations")) : undefined;
  if (translator) log(`翻译 ${toTranslate} 条含中日韩文字的 issue（已缓存的会跳过）...`);

  let done = 0;
  return mapPool(inputs, opts.concurrency, async ({ issue, input }) => {
    const t = translator
      ? await translator.translate(input)
      : { value: input, translated: false, cached: false };
    if (t.translated && ++done % 10 === 0) log(`  已翻译 ${done}/${toTranslate}`);
    return {
      iid: issue.iid,
      webUrl: issue.webUrl,
      originalTitle: issue.title,
      title: t.value.title,
      description: t.value.description,
      labels: t.value.labels,
      translated: t.translated,
      raw: issue,
    };
  });
}
