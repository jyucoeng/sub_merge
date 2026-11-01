import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

import worker, { SCHEMA_STATEMENTS } from "../src/index.js";

/* ---------------- 测试用 D1 后端 ----------------
 * 默认：纯 JS 内存实现，只覆盖 Worker 实际发出的 SQL（无需依赖、任何 Node 版本可跑）。
 * SUB_WORKER_TEST_D1=sqlite：用 node:sqlite 跑真实 SQLite，验证 DDL 与 SQL 语法。
 */
const sqlite = process.env.SUB_WORKER_TEST_D1 === "sqlite" ? await import("node:sqlite") : null;

class MockD1 {
  constructor() {
    this.machines = new Map();
    this.settings = new Map();
  }
  prepare(sql) {
    return new MockStatement(this, sql);
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

function mockRow(args) {
  return {
    machine: args[0],
    content: args[1],
    hash: args[2],
    bytes: args[3],
    updated_at: args[4],
    nodes_json: args[5],
    manual: args[6],
  };
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql).replace(/\s+/g, " ").trim();
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    if (/^SELECT .+ FROM machines WHERE machine = \?1$/i.test(this.sql)) return this.db.machines.get(this.args[0]) || null;
    if (/^SELECT value FROM settings WHERE key = \?1$/i.test(this.sql)) {
      const value = this.db.settings.get(this.args[0]);
      return value === undefined ? null : { value };
    }
    throw new Error(`MockD1: unsupported first() -> ${this.sql}`);
  }
  async all() {
    if (/^SELECT .+ FROM machines$/i.test(this.sql)) {
      return { results: [...this.db.machines.values()], success: true, meta: { changes: 0 } };
    }
    throw new Error(`MockD1: unsupported all() -> ${this.sql}`);
  }
  async run() {
    const args = this.args;
    if (/^INSERT INTO machines .+ ON CONFLICT\(machine\) DO UPDATE/i.test(this.sql)) {
      this.db.machines.set(args[0], mockRow(args));
      return { success: true, meta: { changes: 1 } };
    }
    if (/^INSERT INTO machines .+ ON CONFLICT\(machine\) DO NOTHING/i.test(this.sql)) {
      if (this.db.machines.has(args[0])) return { success: true, meta: { changes: 0 } };
      this.db.machines.set(args[0], mockRow(args));
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM machines WHERE machine = \?1$/i.test(this.sql)) {
      return { success: true, meta: { changes: this.db.machines.delete(args[0]) ? 1 : 0 } };
    }
    if (/^INSERT INTO settings .+ ON CONFLICT\(key\) DO UPDATE/i.test(this.sql)) {
      this.db.settings.set(args[0], args[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(this.sql)) return { success: true, meta: { changes: 0 } };
    throw new Error(`MockD1: unsupported run() -> ${this.sql}`);
  }
}

class SqliteD1 {
  constructor({ withSchema = true } = {}) {
    this.sqlite = new sqlite.DatabaseSync(":memory:");
    if (withSchema) this.sqlite.exec(SCHEMA_STATEMENTS.map((s) => `${s};`).join("\n"));
  }
  prepare(sql) {
    return new SqliteStatement(this.sqlite, sql);
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

class SqliteStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args), success: true, meta: { changes: 0 } };
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }
}

const TOKEN = "test-token";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

function makeDb(options = {}) {
  return sqlite ? new SqliteD1(options) : new MockD1();
}

function makeEnv(extra = {}) {
  return { DB: makeDb(), TOKEN, ...extra };
}

function call(env, method, path, body, headers = {}) {
  return worker.fetch(
    new Request(`https://sub.example.workers.dev${path}`, {
      method,
      body,
      headers,
    }),
    env,
  );
}

test("health", async () => {
  const res = await call(makeEnv(), "GET", "/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test("report requires auth and validates base64", async () => {
  const env = makeEnv();
  let res = await call(env, "POST", "/api/v1/report/sgw", b64("vless://x"));
  assert.equal(res.status, 401);

  res = await call(env, "POST", "/api/v1/report/sgw", "not base64!", {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 400);
});

test("report, dedupe, read and list", async () => {
  const env = makeEnv();
  const body = b64("vless://one\nanytls://two");
  let res = await call(env, "POST", "/api/v1/report/sgw", body, {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.changed, true);

  res = await call(env, "POST", "/api/v1/report/sgw", body, {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.changed, false);

  res = await call(env, "GET", `/sub/sgw/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(unb64(await res.text()), "anytls://two\nvless://one");

  res = await call(env, "GET", `/sub/sgw/wrong`);
  assert.equal(res.status, 401);

  res = await call(env, "GET", `/api/v1/machines`, null, {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].machine, "sgw");
});

test("missing variables return config error", async () => {
  const env = {};
  let res = await call(env, "POST", "/api/v1/report/cfg", b64("vless://x"), {
    authorization: "Bearer anything",
  });
  assert.equal(res.status, 500);
  res = await call(env, "GET", "/sub/cfg/anything");
  assert.equal(res.status, 500);

  // TOKEN 有、D1 绑定缺失
  res = await call({ TOKEN }, "POST", "/api/v1/report/cfg", b64("vless://x"), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.match(data.error, /DB/);
});

test("special characters in TOKEN work when URL-encoded", async () => {
  const env = makeEnv({ TOKEN: "a+b=c" });
  const body = b64("vless://special");
  let res = await call(env, "POST", "/api/v1/report/special", body, {
    authorization: "Bearer a+b=c",
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", "/sub/special/a%2Bb%3Dc");
  assert.equal(res.status, 200);
  assert.equal(unb64(await res.text()), "vless://special");
});

test("all merges machines and delete works", async () => {
  const env = makeEnv();
  for (const [machine, text] of [
    ["sgw", "vless://a"],
    ["sjc", "vless://b"],
  ]) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64(text), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.match(merged, /vless:\/\/a/);
  assert.match(merged, /vless:\/\/b/);

  res = await call(env, "GET", `/sub/${TOKEN}`);
  const shortMerged = unb64(await res.text());
  assert.match(shortMerged, /vless:\/\/a/);
  assert.match(shortMerged, /vless:\/\/b/);

  res = await call(env, "DELETE", "/api/v1/machines/sgw", null, {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/sgw/${TOKEN}`);
  assert.equal(res.status, 404);
});

const SAMPLE_LINKS = [
  "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&sni=pypi.org&pbk=abc123&sid=deadbeef&fp=chrome&flow=xtls-rprx-vision&type=tcp#Reality-Node",
  "anytls://secret@example.org:8443?sni=rubygems.org&insecure=1#AnyTLS-Node",
  "tuic://22222222-2222-4222-8222-222222222222:pass@example.net:443?sni=deb.debian.org&allow_insecure=1#TUIC-Node",
  "hysteria2://hysecret@example.io:443?sni=addons.mozilla.org&insecure=1#HY2-Node",
];

test("webui is served with token auth", async () => {
  const env = makeEnv();
  let res = await call(env, "GET", `/ui/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
  const page = await res.text();
  assert.match(page, /节点管理/);
  assert.match(page, /机器排序/);
  assert.match(page, /background:#ffffff/);

  res = await call(env, "GET", "/ui/wrong");
  assert.equal(res.status, 401);
});

test("machine order controls merged subscription order", async () => {
  const env = makeEnv();
  for (const [machine, text] of [
    ["machine-a", "vless://a"],
    ["machine-b", "tuic://b"],
    ["machine-c", "anytls://c"],
  ]) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64(text), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["machine-c", "machine-a", "machine-b"] }), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);

  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const data = await res.json();
  assert.deepEqual(data.machines.map((m) => m.machine), ["machine-c", "machine-a", "machine-b"]);

  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text()).split("\n");
  assert.deepEqual(merged, ["anytls://c", "vless://a", "tuic://b"]);
});

test("default machine order follows region proximity and default node order follows protocol", async () => {
  const env = makeEnv();
  const machines = ["au-aws", "ca-oracle-nat", "de-dandan", "hk-opt", "in-amd", "my-dandan", "jp-dandan-tky", "kr-dandan", "nl-ams", "sg-dandan", "us-sje"];
  for (const machine of machines) {
    const res = await call(env, "POST", `/api/v1/report/${machine}`, b64("vless://one"), {
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(res.status, 200);
  }
  let res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const data = await res.json();
  assert.deepEqual(data.machines.map((m) => m.machine), ["hk-opt", "kr-dandan", "jp-dandan-tky", "sg-dandan", "in-amd", "my-dandan", "us-sje", "de-dandan", "nl-ams", "ca-oracle-nat", "au-aws"]);

  const links = [
    "tuic://22222222-2222-4222-8222-222222222222:pass@example.net:443?sni=deb.debian.org#TUIC",
    "hysteria2://hysecret@example.io:443?sni=addons.mozilla.org#HY2",
    "socks5://user:pass@example.org:1080#SOCKS5",
    "vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&sni=pypi.org&pbk=abc&sid=dead&type=tcp#Reality",
    "vless://33333333-3333-4333-8333-333333333333@example.com:443?security=tls&type=ws&host=node.trycloudflare.com&path=%2Fargo&sni=node.trycloudflare.com#Node-Argo",
    "vless://44444444-4444-4444-8444-444444444444@example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fcdn&sni=cdn.example.com#Node-CDN",
    "anytls://secret@example.org:8443?sni=rubygems.org#AnyTLS",
  ];
  res = await call(env, "POST", "/api/v1/report/order-proto", b64(links.join("\n")), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", "/api/v1/nodes/order-proto", null, { authorization: `Bearer ${TOKEN}` });
  const nodeData = await res.json();
  assert.deepEqual(nodeData.nodes.map((n) => n.name), ["Reality", "AnyTLS", "Node-Argo", "Node-CDN", "HY2", "TUIC", "SOCKS5"]);
});

test("subscription formats adapt from query and user-agent", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/fmt", b64(SAMPLE_LINKS.join("\n")), {
    authorization: `Bearer ${TOKEN}`,
  });

  let res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=clash`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /yaml/);
  const clash = await res.text();
  assert.match(clash, /^proxies:/);
  assert.match(clash, /type: vless/);
  assert.match(clash, /type: anytls/);
  assert.match(clash, /type: tuic/);
  assert.match(clash, /type: hysteria2/);

  res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=singbox`);
  assert.equal(res.status, 200);
  const singbox = JSON.parse(await res.text());
  assert.equal(singbox.outbounds.length, 4);
  assert.equal(singbox.outbounds[0].type, "vless");
  assert.equal(singbox.outbounds[1].type, "anytls");
  assert.equal(singbox.outbounds[2].type, "hysteria2");
  assert.equal(singbox.outbounds[3].type, "tuic");

  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "clash-meta/1.0" });
  assert.match(await res.text(), /^proxies:/);
  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "sing-box/1.13" });
  assert.equal(JSON.parse(await res.text()).outbounds.length, 4);
});

test("webui can edit links/order and reports do not overwrite manual config", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/edit", b64("vless://original@example.com:443?sni=pypi.org#Original"), {
    authorization: `Bearer ${TOKEN}`,
  });

  const body = JSON.stringify({
    nodes: [
      { link: SAMPLE_LINKS[1], name: "第二" },
      { link: SAMPLE_LINKS[0], name: "第一" },
    ],
  });
  let res = await call(env, "PUT", "/api/v1/nodes/edit", body, {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.manual, true);
  assert.equal(data.nodes[0].name, "第二");

  res = await call(env, "GET", "/api/v1/nodes/edit", null, { authorization: `Bearer ${TOKEN}` });
  data = await res.json();
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].link, SAMPLE_LINKS[1]);

  // 新的自动上报不应覆盖手动配置
  res = await call(env, "POST", "/api/v1/report/edit", b64("vless://new@example.com:443?sni=deb.debian.org#New"), {
    authorization: `Bearer ${TOKEN}`,
  });
  data = await res.json();
  assert.equal(data.manual, true);
  res = await call(env, "GET", "/api/v1/nodes/edit", null, { authorization: `Bearer ${TOKEN}` });
  data = await res.json();
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].link, SAMPLE_LINKS[1]);

  // 合并订阅按保存顺序返回
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.ok(merged.indexOf(SAMPLE_LINKS[1]) < merged.indexOf(SAMPLE_LINKS[0]));

  // reset 后恢复自动上报内容
  res = await call(env, "POST", "/api/v1/machines/edit/reset", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.manual, false);
  assert.equal(data.nodes.length, 1);
});

test("link fragments become node names, duplicates and blanks are dropped", async () => {
  const env = makeEnv();
  const hy2 = "hysteria2://0631a7f3-09f8-4144-acf2-a4f5bd9ed281@192.255.175.105:31004/?sni=www.apple.com&insecure=1&alpn=h3&obfs=none#%E5%B0%8F%E5%8F%AE%E5%BD%93-%E6%B4%9B%E6%9D%89%E7%9F%B6-cloudnium-hy2-localhost";
  const tuic = "tuic://0631a7f3-09f8-4144-acf2-a4f5bd9ed281:0631a7f3-09f8-4144-acf2-a4f5bd9ed281@192.255.175.105:31005?sni=www.apple.com&congestion_control=bbr&security=tls&udp_relay_mode=native&alpn=h3&allow_insecure=1#%E5%B0%8F%E5%8F%AE%E5%BD%93-%E6%B4%9B%E6%9D%89%E7%9F%B6-cloudnium-tuic-localhost";
  const reality = "vless://0631a7f3-09f8-4144-acf2-a4f5bd9ed281@192.255.175.105:31003?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=EIMEMs9sFeUPYOqNYjZgv9Vx6H8V-s2X-EM_4ycXA3Q&sid=169a2c42&type=tcp&headerType=none#%E5%B0%8F%E5%8F%AE%E5%BD%93-%E6%B4%9B%E6%9D%89%E7%9F%B6-cloudnium-vless-reality-localhost";

  // 名字留空 + 重复链接 + 空行，模拟前端整段粘贴
  const body = JSON.stringify({
    nodes: [{ link: hy2 }, { link: tuic }, { link: reality }, { link: hy2 }, { link: "  " }],
  });
  let res = await call(env, "PUT", "/api/v1/nodes/paste", body, {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.nodes.length, 3);
  assert.deepEqual(data.nodes.map((n) => n.protocol), ["hy2", "tuic", "vless"]);
  assert.deepEqual(data.nodes.map((n) => n.name), [
    "小叮当-洛杉矶-cloudnium-hy2-localhost",
    "小叮当-洛杉矶-cloudnium-tuic-localhost",
    "小叮当-洛杉矶-cloudnium-vless-reality-localhost",
  ]);
  assert.deepEqual(data.nodes.map((n) => n.order), [0, 1, 2]);

  // 订阅内容按粘贴顺序输出，且去重后只有 3 条
  res = await call(env, "GET", `/sub/paste/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.equal(merged.split("\n").length, 3);
  assert.ok(merged.indexOf(hy2) < merged.indexOf(tuic));
  assert.ok(merged.indexOf(tuic) < merged.indexOf(reality));
});

test("webui can create an empty machine and rejects invalid machine names", async () => {
  const env = makeEnv();

  // 没有机器上报时，UI 通过 PUT 空节点列表建一台
  let res = await call(env, "PUT", "/api/v1/nodes/hk-node-1", JSON.stringify({ nodes: [] }), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.machine, "hk-node-1");
  assert.equal(data.manual, true);
  assert.equal(data.nodes.length, 0);

  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.machines[0].machine, "hk-node-1");
  assert.equal(data.machines[0].nodes, 0);

  // 建完之后照常粘贴节点
  res = await call(env, "PUT", "/api/v1/nodes/hk-node-1", JSON.stringify({ nodes: [{ link: SAMPLE_LINKS[0] }] }), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.nodes.length, 1);

  // 机器名规则：允许中文/字母/数字/空格/_ . -，首字符必须是字母或数字，不能有路径分隔符
  for (const bad of ["-lead", " lead", "a".repeat(65), "bad/name", "bad?x", "bad#x", "😀"]) {
    res = await call(env, "PUT", `/api/v1/nodes/${encodeURIComponent(bad)}`, JSON.stringify({ nodes: [] }), {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
  }
});

test("manual machines and reporting machines share one merged subscription", async () => {
  const env = makeEnv();

  // 一台机器自动上报
  let res = await call(env, "POST", "/api/v1/report/auto-hk", b64(SAMPLE_LINKS[0]), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);

  // 一台纯手动机器，一次带两个节点
  res = await call(env, "PUT", "/api/v1/nodes/manual-jp", JSON.stringify({
    nodes: [{ link: SAMPLE_LINKS[1] }, { link: SAMPLE_LINKS[2] }],
  }), { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).nodes.length, 2);

  // 两台都在列表里，来源可区分
  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const list = await res.json();
  assert.equal(list.count, 2);
  const byName = new Map(list.machines.map((m) => [m.machine, m]));
  assert.equal(byName.get("auto-hk").manual, false);
  assert.equal(byName.get("manual-jp").manual, true);
  assert.equal(byName.get("manual-jp").nodes, 2);

  // 合并订阅里两种来源的节点都在
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  const lines = merged.split("\n");
  assert.equal(lines.length, 3);
  for (const link of SAMPLE_LINKS.slice(0, 3)) assert.ok(lines.includes(link), link);

  // 手动机器继续被上报时，节点保持手动版本
  res = await call(env, "POST", "/api/v1/report/manual-jp", b64("vless://other@example.com:443?sni=pypi.org#Other"), {
    authorization: `Bearer ${TOKEN}`,
  });
  const reported = await res.json();
  assert.equal(reported.manual, true);
  assert.equal(reported.nodes, 2);
  res = await call(env, "GET", "/api/v1/nodes/manual-jp", null, { authorization: `Bearer ${TOKEN}` });
  const pinned = await res.json();
  assert.deepEqual(pinned.nodes.map((n) => n.link), [SAMPLE_LINKS[1], SAMPLE_LINKS[2]]);

  // 排序把手动机器放前面，合并订阅跟着变
  res = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["manual-jp", "auto-hk"] }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const ordered = unb64(await res.text());
  assert.ok(ordered.indexOf(SAMPLE_LINKS[1]) < ordered.indexOf(SAMPLE_LINKS[0]));
});

test("rename moves a machine, its nodes and its order slot", async () => {
  const env = makeEnv();

  await call(env, "POST", "/api/v1/report/report-hk", b64(SAMPLE_LINKS[0]), { authorization: `Bearer ${TOKEN}` });
  await call(env, "PUT", "/api/v1/nodes/manual-jp", JSON.stringify({
    nodes: [{ link: SAMPLE_LINKS[1] }, { link: SAMPLE_LINKS[2] }],
  }), { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
  await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["manual-jp", "report-hk"] }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });

  // 重命名手动机器：节点、manual 标记、排序位置一起搬过去
  let res = await call(env, "POST", "/api/v1/machines/manual-jp/rename", JSON.stringify({ to: "tokyo-box" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  const renamed = await res.json();
  assert.equal(renamed.renamed, true);
  assert.equal(renamed.machine, "tokyo-box");
  assert.equal(renamed.nodes, 2);
  assert.equal(renamed.manual, true);

  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const list = await res.json();
  assert.equal(list.count, 2);
  assert.deepEqual(list.machines.map((m) => m.machine).sort(), ["report-hk", "tokyo-box"]);
  res = await call(env, "GET", "/api/v1/nodes/manual-jp", null, { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual((await res.json()).nodes, []); // 旧名字已不存在（GET 对未知机器返回空列表）
  res = await call(env, "GET", "/api/v1/nodes/tokyo-box", null, { authorization: `Bearer ${TOKEN}` });
  const moved = await res.json();
  assert.deepEqual(moved.nodes.map((n) => n.link), [SAMPLE_LINKS[1], SAMPLE_LINKS[2]]);
  res = await call(env, "GET", "/api/v1/machines/order", null, { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual((await res.json()).machine_order, ["tokyo-box", "report-hk"]);
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  assert.ok((await res.text()).length > 0);

  // 冲突与非法输入
  res = await call(env, "POST", "/api/v1/machines/tokyo-box/rename", JSON.stringify({ to: "report-hk" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 409);
  res = await call(env, "POST", "/api/v1/machines/tokyo-box/rename", JSON.stringify({ to: "bad/name" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 400);
  res = await call(env, "POST", "/api/v1/machines/nope/rename", JSON.stringify({ to: "other" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 404);
  res = await call(env, "POST", "/api/v1/machines/tokyo-box/rename", JSON.stringify({ to: "tokyo-box" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).renamed, false);
});

test("machine names can be Chinese, and Chinese regions drive default order", async () => {
  const env = makeEnv();
  const hk = "香港-小叮当";
  const la = "洛杉矶-小叮当";
  const de = "德国-法兰克福";

  // 上报接口接受中文名（路径需要 encodeURIComponent）
  let res = await call(env, "POST", `/api/v1/report/${encodeURIComponent(hk)}`, b64(SAMPLE_LINKS[0]), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).machine, hk);

  // 中文名也能当手动机器，一次带多个节点
  for (const name of [la, de]) {
    res = await call(env, "PUT", `/api/v1/nodes/${encodeURIComponent(name)}`, JSON.stringify({
      nodes: [{ link: SAMPLE_LINKS[1] }, { link: SAMPLE_LINKS[2] }],
    }), { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).machine, name);
  }

  // 列表里三台都在，且名字原样保留
  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  const list = await res.json();
  assert.equal(list.count, 3);
  const names = list.machines.map((m) => m.machine);
  for (const name of [hk, la, de]) assert.ok(names.includes(name), name);

  // 默认排序按中文地区词识别国家：香港(10) → 洛杉矶(60) → 德国(70)
  assert.deepEqual(names, [hk, la, de]);

  // 响应头里的中文名必须 percent-encode
  res = await call(env, "GET", `/sub/${encodeURIComponent(hk)}/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-machine"), encodeURIComponent(hk));
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-machine-order"), ""); // 还没手动排序时为空

  // 排序与重命名对中文名一样可用
  res = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: [de, la, hk] }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  assert.equal(unb64(await res.text()).split("\n").length, 5);
  assert.equal(res.headers.get("x-machine-order"), [de, la, hk].map(encodeURIComponent).join(","));
  res = await call(env, "POST", `/api/v1/machines/${encodeURIComponent(hk)}/rename`, JSON.stringify({ to: "香港-备用" }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).machine, "香港-备用");
  res = await call(env, "GET", "/api/v1/machines/order", null, { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual((await res.json()).machine_order, [de, la, "香港-备用"]);
});

test("the WebUI script is syntactically valid JavaScript", async () => {
  const env = makeEnv();
  const res = await call(env, "GET", `/ui/${TOKEN}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "inline script must be present");

  // UI 写在模板字符串里，正则中的 \r \n \s \/ 必须在源码里写成 \\ 才会原样输出；
  // 少写一个反斜杠，浏览器就会报 Uncaught SyntaxError: Unexpected token '?'。
  assert.doesNotThrow(() => new vm.Script(m[1]), "inline script must parse");
  assert.ok(m[1].includes("split(/\\r?\\n"), "line splitting regex must survive templating");
  assert.ok(m[1].includes("[\\p{L}\\p{N}]"), "machine name regex must survive templating");
});

test("root reports d1 storage and advertises admin endpoints", async () => {
  const res = await call(makeEnv(), "GET", "/");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.storage, "d1");
  assert.ok(data.endpoints.includes("POST /api/v1/admin/schema"));
  assert.ok(!data.endpoints.some((e) => /migrate|kv/i.test(e)));
});

test("admin schema endpoint is idempotent and unblocks a fresh database", async () => {
  const env = { TOKEN, DB: makeDb({ withSchema: false }) };
  const headers = { authorization: `Bearer ${TOKEN}` };

  let res = await call(env, "POST", "/api/v1/admin/schema", null, headers);
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.storage, "d1");
  assert.equal(data.statements, SCHEMA_STATEMENTS.length);

  // 幂等：再跑一次不报错
  res = await call(env, "POST", "/api/v1/admin/schema", null, headers);
  assert.equal(res.status, 200);

  // 建表后即可正常上报 / 读取
  res = await call(env, "POST", "/api/v1/report/after-init", b64("vless://a"), headers);
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/after-init/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(unb64(await res.text()), "vless://a");

  // 未认证不能建表
  res = await call(env, "POST", "/api/v1/admin/schema");
  assert.equal(res.status, 401);
});

test("legacy KV and migration routes are gone", async () => {
  const env = makeEnv();
  const headers = { authorization: `Bearer ${TOKEN}` };
  for (const [method, path] of [
    ["POST", "/api/v1/migrate/kv"],
    ["POST", "/api/v1/migrate"],
    ["GET", "/api/v1/migrate/kv"],
  ]) {
    const res = await call(env, method, path, null, headers);
    assert.equal(res.status, 404, `${method} ${path} 应当 404`);
  }
});

test("delete removes the row and its machine order entry", async () => {
  const env = makeEnv();
  const headers = { authorization: `Bearer ${TOKEN}` };
  for (const machine of ["del-a", "del-b"]) {
    await call(env, "POST", `/api/v1/report/${machine}`, b64(`vless://${machine}`), headers);
  }
  await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["del-b", "del-a"] }), {
    ...headers,
    "content-type": "application/json",
  });
  let res = await call(env, "DELETE", "/api/v1/machines/del-b", null, headers);
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/del-b/${TOKEN}`);
  assert.equal(res.status, 404);
  res = await call(env, "GET", "/api/v1/machines", null, headers);
  const data = await res.json();
  assert.deepEqual(data.machines.map((m) => m.machine), ["del-a"]);
  assert.deepEqual(data.machine_order, ["del-a"]);
});

test("scripts/schema.sql matches SCHEMA_STATEMENTS", () => {
  const raw = fs.readFileSync(new URL("../scripts/schema.sql", import.meta.url), "utf8").replace(/^--.*$/gm, "");
  const norm = (text) => text.replace(/\s+/g, " ").trim();
  const sql = norm(raw);
  for (const statement of SCHEMA_STATEMENTS) {
    assert.ok(sql.includes(`${norm(statement)};`), `schema.sql 缺少语句: ${statement.split("\n")[0]}`);
  }
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 2);
  assert.ok(sql.includes("manual INTEGER NOT NULL DEFAULT 0"));
});
