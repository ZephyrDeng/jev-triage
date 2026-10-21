import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Image } from "@typesafe-ai/sdk";
import sharp from "sharp";
import type { FetchOptions } from "./forge.js";
import type { PreparedIssue } from "./types.js";
import { DiskCache, log, sha256 } from "./util.js";

const exec = promisify(execFile);

/** 每条 issue 最多发送的图片数（超出的只保留 `[image]` 占位）。 */
export const MAX_IMAGES = 4;
/** Jev 的图片限制：每条边 280–1568 px，总像素 ≤ 1568²（约 245.8 万）。 */
const MIN_SIDE = 280;
const MAX_SIDE = 1568;
const MAX_PIXELS = 2_458_624;

export interface ExtractedImages {
  /** 图片引用已改写为 `![issue image](refN)` 的正文与评论（占位符编号全局唯一）。 */
  description: string;
  notes: string[];
  /** 与 refN（从 1 开始）一一对应的 URL。 */
  urls: string[];
}

/**
 * 把原始 Markdown 里的 `![alt](url)` 与 `<img src="url">` 改写成占位符，并收集 URL。
 * 同一 URL 复用同一占位符；data: 等非 http/相对以外的链接保留。
 */
export function extractIssueImages(issue: { description: string; notes?: string[] }): ExtractedImages {
  const urls: string[] = [];
  const refFor = (url: string): string => {
    let i = urls.indexOf(url);
    if (i === -1 && urls.length < MAX_IMAGES) {
      urls.push(url);
      i = urls.length - 1;
    }
    return i === -1 ? "[image]" : `![issue image](ref${i + 1})`;
  };
  const rewrite = (md: string | null | undefined): string =>
    (md ?? "")
      .replace(/!\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) =>
        /^https?:\/\//.test(url) || url.startsWith("/") ? refFor(url) : `[image: ${alt}]`,
      )
      .replace(/<img[^>]*?\ssrc="([^"]+)"[^>]*>/gi, (_m, url: string) =>
        /^https?:\/\//.test(url) || url.startsWith("/") ? refFor(url) : "[image]",
      );
  return { description: rewrite(issue.description), notes: (issue.notes ?? []).map(rewrite), urls };
}

/** URL → `gh/glab api` 的路径参数；返回 null 表示不走平台登录态下载。 */
export function apiPathFor(url: string, opts: FetchOptions): string | null {
  if (opts.forge === "github") {
    const m = /^https:\/\/github\.com\/(user-attachments\/assets\/[\w-]+)/.exec(url);
    return m ? m[1]! : null;
  }
  // GitLab：/uploads/ 存放于项目内，补 `projects/{project}` 前缀即可经 glab 带登录态访问。
  const rel = /^(\/uploads\/[^?#]+)/.exec(url);
  if (rel) {
    const project = /^\d+$/.test(opts.project) ? opts.project : encodeURIComponent(opts.project);
    return `projects/${project}${rel[1]!}`;
  }
  const abs = new RegExp(`^https?://${opts.host.replace(/\./g, "\\.")}(/[\\w/%.-]*)`).exec(url);
  return abs ? abs[1]!.replace(/^\//, "") : null;
}

async function download(opts: FetchOptions, url: string): Promise<Uint8Array> {
  const apiPath = apiPathFor(url, opts);
  if (apiPath) {
    const bin = opts.forge === "github" ? "gh" : "glab";
    try {
      const { stdout } = await exec(bin, ["api", "--hostname", opts.host, apiPath], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout as unknown as Uint8Array;
    } catch (err) {
      const e = err as { stderr?: Uint8Array; message?: string };
      const detail = (e.stderr ? Buffer.from(e.stderr).toString() : (e.message ?? String(err)))
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 160);
      throw new Error(`${bin} api: ${detail}`);
    }
  }
  // 外链（如 CDN / CDN 后跳的邮箱附件）：不带登录态直连，不跟随到未知主机。
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 交给 Jev 的占位符 → 图片映射；失败的位置保留 `[image]` 文字表示。无图时返回 undefined。 */
export function imageRefs(p: PreparedIssue): Record<string, Image | string> | undefined {
  if (!p.imageUrls?.length) return undefined;
  const refs: Record<string, Image | string> = {};
  p.imageUrls.forEach((_url, i) => {
    refs[`ref${i + 1}`] = p.images?.[i] ?? "[image: unavailable]";
  });
  return refs;
}

/** 缓存键用的占位符 → URL 映射（Image 实例每次运行引用名不同，不能入键）。 */
export function imageKeys(p: PreparedIssue): Record<string, string> | undefined {
  if (!p.imageUrls?.length) return undefined;
  return Object.fromEntries(p.imageUrls.map((url, i) => [`ref${i + 1}`, url]));
}

/**
 * 转成 Jev 接受的形状：按 EXIF 旋转、缩放到 280–1568px 且总像素不超限、统一 JPEG 控制 token。
 * GIF / WebP / 大图都走这里；实在变不出来的（损坏、16 MiB 以上等）由上层跳过。
 */
export async function toJevImage(buf: Uint8Array): Promise<Image> {
  const img = sharp(Buffer.from(buf), { limitInputPixels: 30_000_000 }).rotate();
  const meta = await img.metadata();
  let width = meta.width ?? 0;
  let height = meta.height ?? 0;
  if (!width || !height) throw new Error("无法读取图片尺寸");
  // EXIF 90/270° 交换宽高
  if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
  const up = Math.max(MIN_SIDE / width, MIN_SIDE / height, 1);
  let w = Math.round(width * up);
  let h = Math.round(height * up);
  const down = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
  w = Math.max(MIN_SIDE, Math.round(w * down));
  h = Math.max(MIN_SIDE, Math.round(h * down));
  const jpeg = await img.resize(w, h, { fit: "fill" }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
  return new Image(jpeg);
}

/** 下载 → 形状转换 → base64 磁盘缓存，按原顺序返回成功的 Image（失败的跳过并打印提示）。 */
export async function loadIssueImages(opts: FetchOptions, urls: string[], cacheDir: string): Promise<Image[]> {
  if (urls.length === 0) return [];
  const cache = new DiskCache(cacheDir);
  const out: Image[] = [];
  for (const url of urls) {
    try {
      const { value } = await cache.wrap<string>(sha256({ v: 1, url }), async () => {
        const img = await toJevImage(await download(opts, url));
        return Buffer.from(img.data as Uint8Array).toString("base64");
      });
      out.push(Image.fromBase64(value));
    } catch (err) {
      log(`  图片跳过（${url.slice(0, 80)}）：${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}
