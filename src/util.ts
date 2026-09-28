import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

/** 每个 key 一个文件的磁盘缓存；并发安全、可随时删除重跑。 */
export class DiskCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(value, null, 2));
  }

  async wrap<T>(key: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const value = await compute();
    await this.set(key, value);
    return { value, hit: false };
  }
}

/** 以固定并发度处理数组，保持结果顺序。 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

export function log(...args: unknown[]): void {
  console.error(...args);
}
