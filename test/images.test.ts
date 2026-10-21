import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { apiPathFor, extractIssueImages, imageKeys, imageRefs, toJevImage } from "../src/images.ts";
import type { PreparedIssue } from "../src/types.ts";

const gitlabOpts = { forge: "gitlab", host: "git.example.com", project: "group/sub/proj" } as never;
const githubOpts = { forge: "github", host: "github.com", project: "o/r" } as never;

test("extractIssueImages rewrites markdown and html images to refN, dedupes, caps at 4", () => {
  const urls = [1, 2, 3, 4, 5].map((i) => `https://cdn.example.com/${i}.png`);
  const { description, notes, urls: got } = extractIssueImages({
    description:
      `首屏坏掉 ![截图](${urls[0]}) 同一张 ![again](${urls[0]})\n` +
      `<img src="https://cdn.example.com/2.png" width="100">\n` +
      `相对路径 ![r](${"/uploads/abc/image.png"}) 非图片 ![x](relative.md) 引用 ![y](https://a.b/c)`,
    notes: [`评论里 ![n](${urls[3]}) 与 ![m](${urls[4]})`],
  });
  // 正文 4 个不同 URL 占满 ref1..ref4，重复 URL 复用 ref1，评论里的新 URL 超出上限降级为 [image]
  assert.equal(got.length, 4);
  assert.match(description, /!\[issue image]\(ref1\).+!\[issue image]\(ref1\)/);
  assert.match(description, /<img|ref4/), "<img> 被改写";
  assert.match(description, /非图片 \[image: x]/); // 非 http 链接按原样降级
  assert.match(description, /相对路径 !\[issue image]\(ref2\)/); // /uploads/ 相对路径可下载
});

const issueWithImages = (over: Partial<PreparedIssue>): PreparedIssue =>
  ({
    iid: 1, webUrl: "", originalTitle: "", title: "", description: "", labels: [], translated: false,
    raw: { iid: 1, projectId: 1, title: "", description: "", labels: [], state: "opened", issueType: "issue", author: "",
      createdAt: "", updatedAt: "", webUrl: "", userNotesCount: 0, upvotes: 0, mergeRequestsCount: 0, milestone: null },
    ...over,
  }) as PreparedIssue;

test("imageRefs falls back to text for missing downloads; imageKeys is deterministic", async () => {
  const p = issueWithImages({ imageUrls: ["https://a/1.png", "https://a/2.png"], images: [await toJevImage(await png(300, 300))] });
  const refs = imageRefs(p)!;
  assert.equal(Object.keys(refs).join(","), "ref1,ref2");
  assert.equal(String(refs.ref2), "[image: unavailable]");
  assert.deepEqual(imageKeys(p), { ref1: "https://a/1.png", ref2: "https://a/2.png" });
  assert.equal(imageRefs(issueWithImages({})), undefined);
  assert.equal(imageKeys(issueWithImages({})), undefined);
});

test("apiPathFor maps platform URLs to gh/glab api paths and rejects foreign hosts", () => {
  assert.equal(apiPathFor("https://github.com/user-attachments/assets/abc-123", githubOpts), "user-attachments/assets/abc-123");
  assert.equal(apiPathFor("https://cdn.example.com/x.png", githubOpts), null);
  assert.equal(apiPathFor("/uploads/abc/image.png", gitlabOpts), "projects/group%2Fsub%2Fproj/uploads/abc/image.png");
  assert.equal(apiPathFor("https://git.example.com/group/sub/proj/-/issues/1", gitlabOpts), "group/sub/proj/-/issues/1");
  assert.equal(apiPathFor("https://other.example.com/uploads/abc/image.png", gitlabOpts), null);
  assert.equal(apiPathFor("/uploads/x/image.png", { ...gitlabOpts, project: "42" }), "projects/42/uploads/x/image.png");
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();

test("toJevImage upscales small and downscales large images into Jev's pixel limits", async () => {
  const small = await toJevImage(await png(100, 80));
  const s = await sharp(small.data as Uint8Array).metadata();
  assert.ok(s.width! >= 280 && s.height! >= 280);
  assert.equal(s.format, "jpeg");

  const large = await toJevImage(await png(4000, 3000));
  const l = await sharp(large.data as Uint8Array).metadata();
  assert.ok(l.width! <= 1568 && l.height! <= 1568 && l.width! * l.height! <= 2_458_624);

  // GIF 也接受（sharp 转码）
  const gif = await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .gif()
    .toBuffer();
  const g = await sharp((await toJevImage(gif)).data as Uint8Array).metadata();
  assert.equal(g.format, "jpeg");
});
