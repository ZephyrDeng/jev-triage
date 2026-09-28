/**
 * 候选对召回：用 TF-IDF + 余弦相似度（英文文本）为每个 issue 找最相近的 top-k 邻居，
 * 避免对 n² 个 pair 全部调用 Jev。召回宁可宽松，精判交给 Jev。
 */
export interface Doc {
  id: number;
  title: string;
  body: string;
}

export interface CandidatePair {
  a: number;
  b: number;
  similarity: number;
}

const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto over under as is are was were be been being " +
    "it its this that these those there here we you they he she i me my our your their not no do does did done can could " +
    "should would will shall may might must has have had so such than too very just also only via per etc when while where " +
    "which who whom what why how all any each both few more most other some same own up down out off again further once " +
    "issue issues problem please need needs use used using add added"
  ).split(" "),
);

const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;

/** 英文按词切分；未翻译的中日韩文字按字二元组切分（兜底，保证 --no-translate 时也能召回）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower
    .replace(CJK_RUN, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d{1,2}$/.test(t));
  const cjk: string[] = [];
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) cjk.push(run);
    for (let i = 0; i + 1 < run.length; i++) cjk.push(run.slice(i, i + 2));
  }
  return [...words, ...cjk];
}

type Vec = Map<string, number>;

function termFreq(doc: Doc, titleWeight: number): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (tokens: string[], w: number) => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + w);
    // 相邻二元组，强化短语匹配
    for (let i = 0; i + 1 < tokens.length; i++) {
      const bg = `${tokens[i]}_${tokens[i + 1]}`;
      tf.set(bg, (tf.get(bg) ?? 0) + w);
    }
  };
  add(tokenize(doc.title), titleWeight);
  add(tokenize(doc.body), 1);
  return tf;
}

export function buildVectors(docs: Doc[], titleWeight = 3): Vec[] {
  const tfs = docs.map((d) => termFreq(d, titleWeight));
  const df = new Map<string, number>();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return tfs.map((tf) => {
    const v: Vec = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * Math.log(1 + n / (df.get(t) ?? 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

function cosine(a: Vec, b: Vec): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o !== undefined) s += w * o;
  }
  return s;
}

export function recallCandidates(docs: Doc[], opts: { topK?: number; minSimilarity?: number } = {}): CandidatePair[] {
  const topK = opts.topK ?? 5;
  const minSim = opts.minSimilarity ?? 0.12;
  const vecs = buildVectors(docs);
  const pairs = new Map<string, CandidatePair>();
  for (let i = 0; i < docs.length; i++) {
    const scored: { j: number; s: number }[] = [];
    for (let j = 0; j < docs.length; j++) {
      if (i === j) continue;
      const s = cosine(vecs[i] as Vec, vecs[j] as Vec);
      if (s >= minSim) scored.push({ j, s });
    }
    scored.sort((x, y) => y.s - x.s);
    for (const { j, s } of scored.slice(0, topK)) {
      const a = Math.min((docs[i] as Doc).id, (docs[j] as Doc).id);
      const b = Math.max((docs[i] as Doc).id, (docs[j] as Doc).id);
      const key = `${a}-${b}`;
      if (!pairs.has(key)) pairs.set(key, { a, b, similarity: s });
    }
  }
  return [...pairs.values()].sort((x, y) => y.similarity - x.similarity);
}

/** 所有两两组合（小集合时直接全量判断，比召回更可靠）。 */
export function allPairs(docs: Doc[]): CandidatePair[] {
  const vecs = buildVectors(docs);
  const out: CandidatePair[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = Math.min(docs[i]!.id, docs[j]!.id);
      const b = Math.max(docs[i]!.id, docs[j]!.id);
      out.push({ a, b, similarity: cosine(vecs[i]!, vecs[j]!) });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}
