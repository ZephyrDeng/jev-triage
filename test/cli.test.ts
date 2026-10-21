import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { sha256 } from "../src/util.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const entry = resolve("src/cli.ts");
const loader = import.meta.resolve("tsx");
const runEnv = (cwd: string, extraEnv: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ["--import", loader, entry, ...args], {
  cwd, encoding: "utf8", timeout: 15_000,
  env: { ...process.env, TYPESAFE_API_KEY: "offline-test", TYPESAFE_ENV_FILE: "/not-used", TYPESAFE_BASE_URL: "", TYPESAFE_DEFAULT_MODEL: "", ...extraEnv },
});
const run = (cwd: string, ...args: string[]) => runEnv(cwd, {}, ...args);

test("--show-config reports the effective Jev endpoint and masks the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-triage-config-"));
  try {
    const dflt = run(dir, "--show-config");
    assert.equal(dflt.status, 0, dflt.stderr);
    assert.match(dflt.stdout, /https:\/\/api\.typesafe\.ai/);
    assert.match(dflt.stdout, /jev-latest/);
    assert.match(dflt.stdout, /\*{4}test/);
    assert.doesNotMatch(dflt.stdout, /offline-test/); // key 不回显
    const zen = runEnv(dir, { TYPESAFE_BASE_URL: "https://zenmux.ai/api/", TYPESAFE_DEFAULT_MODEL: "typesafe/jev-1.14" }, "--show-config");
    assert.equal(zen.status, 0, zen.stderr);
    assert.match(zen.stdout, /https:\/\/zenmux\.ai\/api\/v1\/systemone/); // 尾斜杠归一化
    assert.match(zen.stdout, /typesafe\/jev-1\.14/);
    assert.match(zen.stdout, /非 TypeSafe 官方端点/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI metadata and bundled skill work outside the repo without loading .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-triage-cli-"));
  try {
    writeFileSync(join(dir, ".env"), "TYPESAFE_API_KEY=not-used\n");
    const help = run(dir, "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--format/);
    const version = run(dir, "--version");
    assert.equal(version.stdout.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
    const path = run(dir, "skill", "--path");
    assert.equal(path.status, 0, path.stderr);
    const skill = run(dir, "skill");
    assert.equal(skill.status, 0, skill.stderr);
    assert.equal(skill.stdout.trim(), readFileSync(path.stdout.trim(), "utf8").trim());
    assert.match(skill.stdout, /name: jev-triage/);
    const options = { forge: "gitlab", host: "git.example.com", project: "demo", state: "opened", withNotes: false, withLinks: true };
    const key = sha256(options).slice(0, 16);
    mkdirSync(join(dir, ".cache/issues"), { recursive: true });
    writeFileSync(join(dir, ".cache/issues", `${key}.json`), JSON.stringify({ fetchedAt: "2026-01-01", issues: [] }));
    const base = ["analyze", "--project", "demo", "--host", "git.example.com"];
    const html = run(dir, ...base);
    assert.equal(html.status, 0, html.stderr);
    assert.equal(realpathSync(html.stdout.trim()), realpathSync(join(dir, "out/overview-demo.html")));
    assert.match(readFileSync(html.stdout.trim(), "utf8"), /<!doctype html>/);
    const json = run(dir, ...base, "--format", "json");
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).issues, []);
    const ascii = run(dir, ...base, "--format", "ascii");
    assert.equal(ascii.status, 0, ascii.stderr);
    assert.match(ascii.stdout, /Issue 总览/);
    for (const args of [
      ["analyze", "--project", "1", "--concurrency", "NaN"],
      ["analyze", "--project", "1", "--limit", "0"],
      ["analyze", "--project", "1", "--dep-threshold", "2"],
      ["analyze", "--project", "1", "--type-min-conf", "1.5"],
      ["analyze", "--project", "1", "--type-min-conf", ""],
      ["analyze", "--project", "1", "--format", "xml"],
      ["analyze", "--project", "1", "extra"],
      ["analyze", "--project", "1", "--forge", "bitbucket"],
      ["analyze", "--project", "owner-only", "--host", "github.com"],
      ["unknown"],
    ]) {
      const r = run(dir, ...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.doesNotMatch(r.stderr, /(gh|glab) api/); // rejected before any network access
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
