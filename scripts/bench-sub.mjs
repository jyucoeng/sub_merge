/**
 * 订阅生成性能基准：node:sqlite 当后端，直接调真实 Worker 的 fetch。
 * 输出「冷启动 / 内容变化后 / 命中缓存」三种情况，用来核对 README 里的常数。
 *
 * 运行：pnpm run bench:sub        （可加 --nodes=1040 --machines=26）
 */
import { DatabaseSync } from "node:sqlite";

import worker, { SCHEMA_STATEMENTS } from "../src/index.js";

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const MACHINES = argOf("machines", 13);
const PER = argOf("nodes", 40);

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async first() { const row = this.db.prepare(this.sql).get(...this.args); return row === undefined ? null : row; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true, meta: { changes: 0 } }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes || 0) } }; }
}
class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
}

const db = new DatabaseSync(":memory:");
for (const sql of SCHEMA_STATEMENTS) db.prepare(sql).run();
const TOKEN = "bench-token";
const env = { DB: new SqliteD1(db), TOKEN };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (method, path, body) =>
  worker.fetch(new Request("http://bench" + path, { method, headers: { authorization: "Bearer " + TOKEN }, body }), env, ctx);

/* 占位节点：地址用 TEST-NET，凭据是假的，别当成能连的节点 */
const REGIONS = ["香港-HK", "洛杉矶-US", "东京-JP", "新加坡-SG", "法兰克福-DE", "首尔-KR", "伦敦-UK", "阿姆斯特丹-NL"];
const linksFor = (m, salt = "") => {
  const out = [];
  for (let i = 0; i < PER; i++) {
    const region = REGIONS[i % REGIONS.length];
    out.push(`vless://${m}0000000-1111-4111-8111-${String(i).padStart(12, "0")}@h${m}-${i}.example.com:443?security=reality&sni=pypi.org&pbk=deadbeef&sid=dead#${region}-${m}-${i}${salt}`);
  }
  return out;
};
const report = (m, salt = "") => call("POST", `/api/v1/report/m${m}`, Buffer.from(linksFor(m, salt).join("\n")).toString("base64"));

for (let m = 0; m < MACHINES; m++) {
  const res = await report(m);
  if (res.status !== 200) throw new Error(`report m${m} failed: ${await res.text()}`);
}
const total = MACHINES * PER;

const measure = async (path) => {
  const t = performance.now();
  const res = await call("GET", path);
  const body = await res.text();
  return { ms: performance.now() - t, cache: res.headers.get("x-sub-cache"), bytes: body.length };
};

console.log(`机型：${MACHINES} 台 × ${PER} 节点 = ${total} 节点\n`);
console.log("格式      首次生成   内容变化后(5 次)              同一内容重拉 p50   字节");
for (const format of ["clash", "proxies", "singbox", "base64"]) {
  const path = `/sub/all/${TOKEN}?format=${format}`;
  const first = await measure(path);
  const warm = [];
  for (let i = 0; i < 15; i++) warm.push((await measure(path)).ms);
  warm.sort((a, b) => a - b);
  const dirty = [];
  for (let k = 0; k < 5; k++) {
    await report(k, `-v${k}`);
    dirty.push((await measure(path)).ms);
  }
  const warmP50 = warm[Math.floor(warm.length / 2)];
  console.log(
    `${format.padEnd(9)} ${first.ms.toFixed(1).padStart(6)}ms   ` +
      `${dirty.map((x) => x.toFixed(1)).join(" / ").padEnd(28)}   ` +
      `${warmP50.toFixed(2).padStart(6)}ms (${first.cache === "hit" ? "hit" : "miss"})   ${(first.bytes / 1024).toFixed(1)} KB`,
  );
}
console.log(`\n单机订阅（${PER} 节点）：`);
const one = await measure(`/sub/m0/${TOKEN}?format=clash`);
const oneWarm = await measure(`/sub/m0/${TOKEN}?format=clash`);
console.log(`  首次 ${one.ms.toFixed(2)}ms / 命中 ${oneWarm.ms.toFixed(2)}ms（${oneWarm.cache}）`);
