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
    this.reports = new Map();
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
    auto_content: args[7] == null ? null : args[7],
    manual_nodes_json: args[8] == null ? "[]" : args[8],
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
    if (/^SELECT key, value FROM settings WHERE key LIKE 'login-fail:%'$/i.test(this.sql)) {
      const value = this.db.settings.get(this.args[0]);
      return value === undefined ? null : { value };
    }
    if (/^SELECT value FROM settings WHERE key = \?1$/i.test(this.sql)) {
      const value = this.db.settings.get(this.args[0]);
      return value === undefined ? null : { value };
    }
    throw new Error(`MockD1: unsupported first() -> ${this.sql}`);
  }
  async all() {
    if (/^SELECT key, value FROM settings WHERE key LIKE '(protocols|disabled):%'$/i.test(this.sql)) {
      const prefix = this.sql.match(/'(protocols|disabled):%/)[1] + ":";
      const rows = [...this.db.settings.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    if (/^SELECT key, value FROM settings WHERE key LIKE 'login-fail:%'$/i.test(this.sql)) {
      const rows = [...this.db.settings.entries()]
        .filter(([key]) => key.startsWith("login-fail:"))
        .map(([key, value]) => ({ key, value }));
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    if (/^SELECT .+ FROM machines$/i.test(this.sql)) {
      return { results: [...this.db.machines.values()], success: true, meta: { changes: 0 } };
    }
    if (/^SELECT .+ FROM machines WHERE manual = 1$/i.test(this.sql)) {
      const rows = [...this.db.machines.values()].filter((row) => Number(row.manual) === 1);
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    if (/^SELECT machine, source, content, hash, bytes, updated_at, nodes_json FROM reports WHERE machine = \?1$/i.test(this.sql)) {
      const rows = [...this.db.reports.values()].filter((row) => row.machine === this.args[0]);
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    if (/^SELECT machine, source FROM reports$/i.test(this.sql)) {
      return { results: [...this.db.reports.values()].map((row) => ({ machine: row.machine, source: row.source })), success: true, meta: { changes: 0 } };
    }
    if (/^SELECT machine, content, hash, bytes, updated_at, nodes_json FROM machines$/i.test(this.sql)) {
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
    if (/^INSERT INTO reports .+ ON CONFLICT\(machine, source\) DO UPDATE/i.test(this.sql)) {
      const [machine, source, content, hash, bytes, updated_at, nodes_json] = args;
      this.db.reports.set(`${machine}\u0000${source}`, { machine, source, content, hash, bytes, updated_at, nodes_json });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM reports WHERE machine = \?1 AND source = \?2$/i.test(this.sql)) {
      return { success: true, meta: { changes: this.db.reports.delete(`${args[0]}\u0000${args[1]}`) ? 1 : 0 } };
    }
    if (/^DELETE FROM reports WHERE machine = \?1$/i.test(this.sql)) {
      let changes = 0;
      for (const key of [...this.db.reports.keys()]) if (key.startsWith(`${args[0]}\u0000`)) { this.db.reports.delete(key); changes += 1; }
      return { success: true, meta: { changes } };
    }
    if (/^DELETE FROM settings WHERE key = \?1$/i.test(this.sql)) {
      return { success: true, meta: { changes: this.db.settings.delete(args[0]) ? 1 : 0 } };
    }
    if (/^DELETE FROM machines WHERE machine = \?1$/i.test(this.sql)) {
      return { success: true, meta: { changes: this.db.machines.delete(args[0]) ? 1 : 0 } };
    }
    if (/^INSERT INTO settings .+ ON CONFLICT\(key\) DO UPDATE/i.test(this.sql)) {
      this.db.settings.set(args[0], args[1]);
      return { success: true, meta: { changes: 1 } };
    }
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(this.sql)) return { success: true, meta: { changes: 0 } };
    if (/^ALTER TABLE machines ADD COLUMN (auto_content|manual_nodes_json)/i.test(this.sql)) {
      const column = /auto_content/i.test(this.sql) ? "hasAutoContent" : "hasManualNodes";
      if (this.db[column]) throw new Error("duplicate column name");
      this.db[column] = true;
      return { success: true, meta: { changes: 0 } };
    }
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

test("webui is a login page, credentials never ride in the URL", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "Sh94ghdf@", GUEST_CODE: "guest-code-123" });
  let res = await call(env, "GET", "/ui");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
  const page = await res.text();
  assert.match(page, /节点管理/);
  assert.match(page, /机器排序/);
  assert.match(page, /background:#ffffff/);
  assert.ok(page.includes('id="login-password"'));
  assert.ok(!page.includes("以游客身份浏览"), "游客码也要手输，不给一键匿名入口");

  // 带任何口令的 /ui/<x> 也只是同一张登录页：URL 里不放凭据
  for (const path of [`/ui/${TOKEN}`, "/ui/wrong", `/ui/${encodeURIComponent("Sh94ghdf@")}`]) {
    res = await call(env, "GET", path);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('id="login-password"'));
  }
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
  assert.match(clash, /^# sub-worker/);
  assert.match(clash, /^mixed-port: 7890$/m);
  assert.match(clash, /^proxies:$/m);
  assert.match(clash, /^proxy-groups:$/m);
  assert.match(clash, /^rule-providers:$/m);
  assert.match(clash, /^rules:$/m);
  assert.match(clash, /type: vless/);
  assert.match(clash, /type: anytls/);
  assert.match(clash, /type: tuic/);
  assert.match(clash, /type: hysteria2/);

  // 片段模式：只有 proxies:，给 proxy-provider 用
  res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=proxies`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /yaml/);
  const fragment = await res.text();
  assert.match(fragment, /^proxies:/);
  assert.ok(!fragment.includes("proxy-groups:"));
  assert.ok(!fragment.includes("rules:"));

  res = await call(env, "GET", `/sub/fmt/${TOKEN}?format=singbox`);
  assert.equal(res.status, 200);
  const singbox = JSON.parse(await res.text());
  assert.equal(singbox.outbounds.length, 4);
  assert.equal(singbox.outbounds[0].type, "vless");
  assert.equal(singbox.outbounds[1].type, "anytls");
  assert.equal(singbox.outbounds[2].type, "hysteria2");
  assert.equal(singbox.outbounds[3].type, "tuic");

  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "clash-meta/1.0" });
  assert.match(await res.text(), /^rule-providers:$/m);
  res = await call(env, "GET", `/sub/fmt/${TOKEN}`, null, { "user-agent": "sing-box/1.13" });
  assert.equal(JSON.parse(await res.text()).outbounds.length, 4);
});

test("manual nodes sit next to reported nodes and reports never touch them", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const hand = "tuic://33333333-3333-4333-8333-333333333333:pw@example.dev:443?sni=deb.debian.org&allow_insecure=1#手写节点";

  await call(env, "POST", "/api/v1/report/edit", b64(`${SAMPLE_LINKS[0]}\n${SAMPLE_LINKS[1]}`), auth);

  let res = await call(env, "PUT", "/api/v1/nodes/edit", JSON.stringify({ nodes: [{ link: hand, name: "手写节点" }] }), {
    ...auth,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.manual, true);
  assert.equal(data.manual_nodes.length, 1);
  assert.equal(data.auto_nodes.length, 2);
  assert.equal(data.nodes.length, 3);
  assert.equal(data.nodes[0].link, hand, "手动节点排在这台机器最前面");

  // 再上报一次：自动部分整体换新，手动部分一个字都不动
  res = await call(env, "POST", "/api/v1/report/edit", b64("vless://new@example.com:443?sni=deb.debian.org#New"), auth);
  data = await res.json();
  assert.equal(data.manual, true);
  assert.equal(data.auto_nodes, 1);
  assert.equal(data.manual_nodes, 1);

  res = await call(env, "GET", "/api/v1/nodes/edit", null, auth);
  data = await res.json();
  assert.equal(data.manual_nodes.length, 1);
  assert.equal(data.manual_nodes[0].link, hand);
  assert.equal(data.auto_nodes.length, 1);
  assert.match(data.auto_nodes[0].link, /#New$/);
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].link, hand);

  // 合并订阅里两种来源都在，手动在前
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const merged = unb64(await res.text());
  assert.ok(merged.includes(hand));
  assert.ok(merged.indexOf(hand) < merged.indexOf("vless://new@example.com:443?sni=deb.debian.org#New"));

  // 清空手动节点 -> 只剩自动上报的那条
  res = await call(env, "POST", "/api/v1/machines/edit/reset", null, auth);
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.cleared, true);
  assert.equal(data.manual, false);
  assert.equal(data.nodes.length, 1);
  assert.match(data.nodes[0].link, /#New$/);
});

test("clearing manual nodes on a never-reported machine leaves it empty", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const link = "vless://dddddddd-1111-4111-8111-444444444444@203.0.113.9:443?security=reality&sni=pypi.org&pbk=x&sid=y#手写节点";
  let res = await call(env, "PUT", "/api/v1/nodes/never-reported", JSON.stringify({ nodes: [{ link }] }), { ...auth, "content-type": "application/json" });
  assert.equal(res.status, 200);

  res = await call(env, "POST", "/api/v1/machines/never-reported/reset", null, auth);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.manual, false);
  assert.equal(data.cleared, true);
  assert.equal(data.nodes.length, 0, "没有上报也没有手动节点，就是空的");

  // 再清一次：没有可清的了
  res = await call(env, "POST", "/api/v1/machines/never-reported/reset", null, auth);
  assert.equal((await res.json()).cleared, false);
});

test("a later report becomes the new restore point for a manual machine", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const first = "vless://eeeeeeee-1111-4111-8111-555555555555@203.0.113.11:443?security=reality&sni=pypi.org&pbk=x&sid=y#上报一";
  const second = "vless://ffffffff-1111-4111-8111-666666666666@203.0.113.12:443?security=reality&sni=pypi.org&pbk=x&sid=y#上报二";
  await call(env, "POST", "/api/v1/report/restore-pt", b64(first), auth);
  await call(env, "POST", "/api/v1/report/restore-pt", b64(second), auth);
  const hand = "vless://99999999-1111-4111-8111-777777777777@203.0.113.13:443?security=reality&sni=pypi.org&pbk=x&sid=y#手改";
  await call(env, "PUT", "/api/v1/nodes/restore-pt", JSON.stringify({ nodes: [{ link: hand }] }), { ...auth, "content-type": "application/json" });

  let res = await call(env, "POST", "/api/v1/machines/restore-pt/reset", null, auth);
  let data = await res.json();
  assert.equal(data.restored, true);
  assert.match(data.nodes[0].link, /#上报二$/);

  // 恢复之后再改手动、再上报，恢复点跟着最新上报走
  await call(env, "PUT", "/api/v1/nodes/restore-pt", JSON.stringify({ nodes: [{ link: hand }] }), { ...auth, "content-type": "application/json" });
  const third = "vless://12345678-1111-4111-8111-888888888888@203.0.113.14:443?security=reality&sni=pypi.org&pbk=x&sid=y#上报三";
  await call(env, "POST", "/api/v1/report/restore-pt", b64(third), auth);
  res = await call(env, "POST", "/api/v1/machines/restore-pt/reset", null, auth);
  data = await res.json();
  assert.match(data.nodes[0].link, /#上报三$/);
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
  assert.equal(data.manual, false, "没有手动节点时 manual 为 false");
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
  assert.equal(reported.manual_nodes, 2);
  assert.equal(reported.auto_nodes, 1);
  assert.equal(reported.nodes, 3, "手动 2 条 + 自动 1 条共存");
  res = await call(env, "GET", "/api/v1/nodes/manual-jp", null, { authorization: `Bearer ${TOKEN}` });
  const pinned = await res.json();
  assert.deepEqual(
    pinned.nodes.map((n) => n.link),
    [SAMPLE_LINKS[1], SAMPLE_LINKS[2], "vless://other@example.com:443?sni=pypi.org#Other"],
    "手动两条在前，自动那条跟在后面",
  );

  // 排序把手动机器放前面，合并订阅跟着变
  res = await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["manual-jp", "auto-hk"] }), {
    authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  const ordered = unb64(await res.text());
  assert.ok(ordered.indexOf(SAMPLE_LINKS[1]) < ordered.indexOf(SAMPLE_LINKS[0]));
});

test("a node pinned by hand wins over the same node in a later report", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const base = "vless://11111111-2222-4333-8444-555555555555@203.0.113.7:443?security=reality&sni=pypi.org&pbk=deadbeef&sid=dead#";
  const reported = (name) => base + name;

  // 上报 -> 转为手动（同一条节点，只换显示名）
  await call(env, "POST", "/api/v1/report/pin", b64(reported("上报的名字")), auth);
  let res = await call(env, "PUT", "/api/v1/nodes/pin", JSON.stringify({ nodes: [{ link: reported("我起的名字") }] }), { ...auth, "content-type": "application/json" });
  let data = await res.json();
  assert.equal(data.manual_nodes.length, 1);
  assert.equal(data.auto_nodes.length, 1);
  assert.equal(data.nodes.length, 1, "同一条节点只出一条: " + JSON.stringify(data.nodes.map((n)=>[n.name, n.link.slice(0, 30)])));
  assert.equal(data.nodes[0].name, "我起的名字");

  // 再用另一个名字上报同一条节点：仍然只出一条，名字还是手动的
  res = await call(env, "POST", "/api/v1/report/pin", b64(reported("第三次改名")), auth);
  data = await res.json();
  assert.equal(data.changed, true);
  assert.equal(data.nodes, 1);
  res = await call(env, "GET", "/api/v1/nodes/pin", null, auth);
  data = await res.json();
  assert.equal(data.auto_nodes.length, 1);
  assert.equal(data.auto_nodes[0].name, "第三次改名", "上报那份自己也在更新");
  assert.equal(data.nodes.length, 1);
  assert.equal(data.nodes[0].name, "我起的名字", "订阅里用手动的名字");

  // 上报换了端口 = 另一条节点：手动那条留在原位，新的自动节点排后面
  res = await call(env, "POST", "/api/v1/report/pin", b64(reported("换端口").replace(":443?", ":8443?")), auth);
  res = await call(env, "GET", "/api/v1/nodes/pin", null, auth);
  data = await res.json();
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0].name, "我起的名字");

  // 合并订阅里也只有两条
  res = await call(env, "GET", `/sub/all/${TOKEN}`);
  assert.equal(unb64(await res.text()).split("\n").length, 2);
});

test("two boxes reporting under one machine name no longer overwrite each other", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const a1 = SAMPLE_LINKS[0];
  const a2 = SAMPLE_LINKS[1];
  const b1 = SAMPLE_LINKS[2];

  // 两块机器都叫 vps：靠 ?source= 区分
  let res = await call(env, "POST", "/api/v1/report/vps?source=box-a", b64(`${a1}\n${a2}`), auth);
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.source, "box-a");
  assert.equal(data.auto_nodes, 2);

  res = await call(env, "POST", "/api/v1/report/vps?source=box-b", b64(b1), auth);
  data = await res.json();
  assert.equal(data.source, "box-b");
  assert.equal(data.auto_nodes, 3, "两个源合并，谁也没被覆盖");
  assert.deepEqual(data.sources.map((x) => x.source), ["box-a", "box-b"]);

  res = await call(env, "GET", "/api/v1/nodes/vps", null, auth);
  data = await res.json();
  assert.equal(data.auto_nodes.length, 3);
  assert.equal(data.sources.find((x) => x.source === "box-b").nodes, 1);

  // box-a 重新上报（内容变了）：只换 box-a 的那份，box-b 原样
  res = await call(env, "POST", "/api/v1/report/vps?source=box-a", b64(a1), auth);
  data = await res.json();
  assert.equal(data.auto_nodes, 2);
  const links = (await (await call(env, "GET", "/api/v1/nodes/vps", null, auth)).json()).auto_nodes.map((n) => n.link);
  assert.deepEqual(links.sort(), [b1, a1].sort());

  // 同一个源内容没变：changed:false，且不动别的源
  res = await call(env, "POST", "/api/v1/report/vps?source=box-a", b64(a1), auth);
  data = await res.json();
  assert.equal(data.changed, false);
  assert.equal(data.auto_nodes, 2);

  // X-Source 头等价于 ?source=
  res = await call(env, "POST", "/api/v1/report/vps", b64(a2), { ...auth, "x-source": "box-c" });
  data = await res.json();
  assert.equal(data.source, "box-c");
  assert.equal(data.auto_nodes, 3);

  // 非法 source 名 400
  res = await call(env, "POST", "/api/v1/report/vps?source=bad%2Fname", b64(a1), auth);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid source name");

  // 删掉一个来源：只删它自己的节点
  res = await call(env, "DELETE", "/api/v1/machines/vps/sources/box-b", null, auth);
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.auto_nodes, 2);
  assert.deepEqual(data.sources.map((x) => x.source).sort(), ["box-a", "box-c"]);

  res = await call(env, "DELETE", "/api/v1/machines/vps/sources/nope", null, auth);
  assert.equal(res.status, 404);

  // 删除机器时来源一起清掉
  res = await call(env, "DELETE", "/api/v1/machines/vps", null, auth);
  assert.equal(res.status, 200);
  res = await call(env, "POST", "/api/v1/report/vps?source=box-a", b64(a1), auth);
  const after = await res.json();
  assert.equal(after.auto_nodes, 1, `重新上报只有新源自己的节点: ${JSON.stringify(after).slice(0,200)}`);
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

test("only /ui serves the WebUI, /api reports d1 storage and advertises endpoints", async () => {
  const root = await call(makeEnv(), "GET", "/");
  assert.equal(root.status, 404, "the root must not advertise anything");
  assert.ok(!(await root.text()).includes("login-password"), "root must not leak the login form");

  const ui = await call(makeEnv(), "GET", "/ui");
  assert.equal(ui.status, 200);
  assert.ok((await ui.text()).includes('id="login-password"'));

  const res = await call(makeEnv(), "GET", "/api");
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
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
  assert.ok(sql.includes("manual INTEGER NOT NULL DEFAULT 0"));
});

test("clash config carries ACL4SSR groups and rule-providers that resolve", async () => {
  const env = makeEnv();
  const links = [
    "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=reality&sni=pypi.org&pbk=abc&sid=dead#香港-HK-01",
    "vless://22222222-2222-4222-8222-222222222222@la.example.com:443?security=tls&sni=pypi.org#洛杉矶-US-01",
    "vless://33333333-3333-4333-8333-333333333333@de.example.com:443?security=tls&sni=pypi.org#德国-法兰克福-01",
    "hysteria2://pw@jp.example.io:443?sni=addons.mozilla.org#东京-JP-01",
    "tuic://44444444-4444-4444-8444-444444444444:pw@sg.example.net:443?sni=deb.debian.org&congestion_control=bbr#狮城-SG-01",
  ];
  let res = await call(env, "POST", "/api/v1/report/asia", b64(links.join("\n")), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);
  // 另一台机器放一条同名但不同链路的节点，验证 clash 名称唯一
  res = await call(env, "POST", "/api/v1/report/eu", b64("vless://55555555-5555-4555-8555-555555555555@hk2.example.com:443?security=tls&sni=pypi.org#香港-HK-01"), {
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(res.status, 200);

  res = await call(env, "GET", `/sub/all/${TOKEN}?format=clash`);
  assert.equal(res.status, 200);
  const yaml = await res.text();

  const names = [...yaml.matchAll(/^  - name: "(.+)"$/gm)].map((m) => m[1]);
  const groupNames = names.filter((n) => /^[\p{Emoji}\u2600-\u27bf]/u.test(n) || n.includes("节点选择"));
  // 代理名唯一
  const proxyNames = names.slice(0, names.length - groupNames.length);
  assert.equal(new Set(proxyNames).size, proxyNames.length);
  assert.ok(proxyNames.includes("香港-HK-01"));
  assert.ok(proxyNames.includes("香港-HK-01 2"), "same name from two machines must be uniqued");

  // 国家分组按名字命中，空分组不输出
  const hkGroup = yaml.split('  - name: "🇭🇰 香港节点"')[1] || "";
  assert.match(hkGroup.slice(0, 400), /香港-HK-01/);
  assert.ok(!yaml.includes('  - name: "🇲🇴 澳门节点"'), "empty country groups are dropped");
  assert.match(yaml, /"🇺🇸 美国节点"/);
  assert.match(yaml, /"🇩🇪 德国节点"/);
  assert.match(yaml, /"🇯🇵 日本节点"/);
  assert.match(yaml, /"🇸🇬 狮城节点"/);
  // short codes are word-bounded: something like "Node" must not be treated as DE
  assert.ok(!/"德国节点"\n    type: "select"\n    proxies:\n      - "洛杉矶/.test(yaml));

  // 每个 RULE-SET 都有对应 provider，且目标分组真实存在
  const providers = [...yaml.matchAll(/^  "([A-Za-z0-9_-]+)":$/gm)].map((m) => m[1]);
  assert.equal(new Set(providers).size, providers.length);
  assert.ok(providers.includes("BanAD"));
  assert.ok(providers.includes("YouTube"));
  const rules = [...yaml.matchAll(/^  - "RULE-SET,([^,]+),(.+)"$/gm)].map((m) => [m[1], m[2]]);
  assert.ok(rules.length >= 25);
  for (const [provider, group] of rules) {
    assert.ok(providers.includes(provider), `missing provider ${provider}`);
    assert.ok(yaml.includes(`  - name: "${group}"`), `missing group ${group}`);
  }
  const ruleLines = [...yaml.matchAll(/^  - "(.+)"$/gm)].map((m) => m[1]).filter((r) => /RULE-SET|GEOIP|MATCH/.test(r));
  assert.equal(ruleLines[ruleLines.length - 1], "MATCH,🐟 漏网之鱼");
  assert.ok(ruleLines.includes("GEOIP,CN,🎯 全球直连"));

  // 分组里不能出现空 proxies:
  assert.ok(!/proxies:\n\n/.test(yaml));
});

test("subscription output is cached until the content changes", async () => {
  const env = makeEnv();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const link = (name, port = 443) => `vless://11111111-2222-4333-8444-555555555555@203.0.113.7:${port}?security=reality&sni=pypi.org&pbk=deadbeef&sid=dead#${name}`;

  let res = await call(env, "PUT", "/api/v1/nodes/cache-a", JSON.stringify({ nodes: [{ link: link("缓存-A1") }, { link: link("缓存-A2", 8443) }] }), { ...auth, "content-type": "application/json" });
  assert.equal(res.status, 200);

  const clashUrl = `/sub/cache-a/${TOKEN}?format=clash`;
  res = await call(env, "GET", clashUrl);
  const first = await res.text();
  assert.equal(res.headers.get("x-sub-cache"), "miss");
  assert.equal(res.headers.get("x-nodes"), "2");
  assert.match(first, /缓存-A1/);

  // 同一份内容再拉：命中缓存，正文与计数完全一致
  res = await call(env, "GET", clashUrl);
  assert.equal(res.headers.get("x-sub-cache"), "hit");
  assert.equal(res.headers.get("x-nodes"), "2");
  assert.equal(await res.text(), first);

  // 不同格式是不同条目
  res = await call(env, "GET", `/sub/cache-a/${TOKEN}?format=base64`);
  assert.equal(res.headers.get("x-sub-cache"), "miss");
  assert.notEqual(await res.text(), first);

  // 改了节点 -> key 变了 -> 必须重新生成
  res = await call(env, "PUT", "/api/v1/nodes/cache-a", JSON.stringify({ nodes: [{ link: link("缓存-A3") }] }), { ...auth, "content-type": "application/json" });
  assert.equal(res.status, 200);
  res = await call(env, "GET", clashUrl);
  assert.equal(res.headers.get("x-sub-cache"), "miss");
  const after = await res.text();
  assert.match(after, /缓存-A3/);
  assert.ok(!after.includes("缓存-A1"), "stale content must not be served");

  // 合并订阅：机器顺序进 key，改顺序就要重新生成
  await call(env, "POST", "/api/v1/report/cache-b", b64(link("缓存-B1")), auth);
  const allUrl = `/sub/all/${TOKEN}?format=clash`;
  let all = await (await call(env, "GET", allUrl)).text();
  assert.ok(all.indexOf("缓存-A3") < all.indexOf("缓存-B1"));
  await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["cache-b", "cache-a"] }), { ...auth, "content-type": "application/json" });
  res = await call(env, "GET", allUrl);
  assert.equal(res.headers.get("x-sub-cache"), "miss");
  all = await res.text();
  assert.ok(all.indexOf("缓存-B1") < all.indexOf("缓存-A3"), "order change must invalidate the cached body");
  const allAgain = await call(env, "GET", allUrl);
  assert.equal(allAgain.headers.get("x-sub-cache"), "hit");
  assert.equal(await allAgain.text(), all);
});

test("a filter of .* is a real regexp, so the manual/auto groups keep every node", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/box", b64("vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls&sni=pypi.org#香港-HK-01"), {
    authorization: `Bearer ${TOKEN}`,
  });
  const yaml = await (await call(env, "GET", `/sub/all/${TOKEN}?format=clash`)).text();
  const block = yaml.slice(yaml.indexOf('  - name: "☑️ 手动切换"'));
  assert.ok(yaml.includes('  - name: "☑️ 手动切换"'), "the catch-all manual group must survive");
  assert.ok(block.slice(0, 200).includes('- "香港-HK-01"'), "it must contain the node");
  assert.ok(yaml.includes('  - name: "♻️ 自动选择"'), "the catch-all auto group must survive");
  const auto = yaml.slice(yaml.indexOf('  - name: "♻️ 自动选择"')).slice(0, 300);
  assert.ok(auto.includes('type: "url-test"') && auto.includes('- "香港-HK-01"'));
});

test("empty clash groups are dropped instead of turning into DIRECT", async () => {
  const env = makeEnv();
  // 只有一个美国节点：香港组匹配不到，引用它的组也要跟着收敛，规则不能悬空
  await call(env, "POST", "/api/v1/report/box", b64("vless://11111111-1111-4111-8111-111111111111@us.example.com:443?security=tls&sni=pypi.org#美国-LAX-01"), {
    authorization: `Bearer ${TOKEN}`,
  });
  const custom = {
    groups: [
      { name: "🚀 主组", type: "select", members: ["🇭🇰 香港节点", "DIRECT"] },
      { name: "🇭🇰 香港节点", type: "select", filter: "(?i)香港|HK" },
      { name: "👻 幽灵组", type: "select", members: ["根本不存在的分组"] },
      { name: "🪢 只挂幽灵组", type: "select", members: ["👻 幽灵组"] },
    ],
    rulesets: [
      { name: "hkonly", group: "🇭🇰 香港节点", url: "https://example.com/hk.list" },
      { name: "ghost", group: "👻 幽灵组", url: "https://example.com/ghost.list" },
      { name: "main", group: "🚀 主组", url: "https://example.com/main.list" },
    ],
  };
  const res = await call(env, "PUT", "/api/v1/clash/rules", JSON.stringify(custom), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200, await res.clone().text());

  const yaml = await (await call(env, "GET", `/sub/all/${TOKEN}?format=clash`)).text();
  assert.ok(yaml.includes('"🚀 主组"'), "the group that still has a member survives");
  assert.ok(yaml.includes('      - "DIRECT"'), "its DIRECT member is kept");
  for (const name of ["🇭🇰 香港节点", "👻 幽灵组", "🪢 只挂幽灵组"]) {
    assert.ok(!yaml.includes(`"${name}"`), `${name} must not appear with an empty proxies list`);
  }
  assert.ok(!yaml.includes("RULE-SET,hkonly"), "rules pointing at dropped groups are skipped");
  assert.ok(!yaml.includes("RULE-SET,ghost"));
  assert.ok(yaml.includes("RULE-SET,main,🚀 主组"));
  assert.ok(/MATCH,🚀 主组/.test(yaml), "MATCH falls back to the first surviving group");
});

test("clash groups and rule-providers are editable and fall back to defaults", async () => {
  const env = makeEnv();
  await call(env, "POST", "/api/v1/report/box", b64("vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls&sni=pypi.org#香港-HK-01"), {
    authorization: `Bearer ${TOKEN}`,
  });

  let res = await call(env, "GET", "/api/v1/clash/rules", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  let doc = await res.json();
  assert.equal(doc.custom, false);
  assert.ok(doc.groups.length > 20, "defaults carry the ACL4SSR groups");
  assert.ok(doc.rulesets.length > 20, "defaults carry the ACL4SSR rulesets");

  const custom = {
    groups: [
      { name: "🚀 节点选择", type: "select", members: ["🇭🇰 香港", "DIRECT"] },
      { name: "🇭🇰 香港", type: "select", filter: "香港|HK" },
      { name: "🐟 漏网之鱼", type: "select", members: ["🚀 节点选择", "DIRECT"] },
    ],
    rulesets: [
      { name: "banad", group: "🚀 节点选择", url: "https://example.com/BanAD.list" },
      { group: "🐟 漏网之鱼", url: "https://example.com/ProxyLite.list" },
    ],
  };
  res = await call(env, "PUT", "/api/v1/clash/rules", JSON.stringify(custom), {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.equal(res.status, 200);
  doc = await res.json();
  assert.equal(doc.custom, true);

  // 订阅立刻跟着变（缓存 key 带规则版本）
  res = await call(env, "GET", `/sub/all/${TOKEN}?format=clash`);
  let yaml = await res.text();
  assert.ok(yaml.includes('"🇭🇰 香港"'));
  assert.ok(yaml.includes("RULE-SET,banad,🚀 节点选择"));
  assert.ok(yaml.includes("RULE-SET,ProxyLite,🐟 漏网之鱼"), "unnamed ruleset derives its name from the file");
  assert.ok(!yaml.includes("RULE-SET,BanAD,🛑 全球拦截"), "default rulesets are replaced");
  assert.ok(yaml.includes("MATCH,🐟 漏网之鱼"));

  // 非法输入逐条拒绝
  const bad = [
    [{ groups: [{ name: "a", type: "select", filter: "(" }], rulesets: [] }, /not a valid regexp/],
    [{ groups: [{ name: "a", type: "select" }], rulesets: [] }, /needs either filter or members/],
    [{ groups: [{ name: "a", type: "select", filter: "x", members: ["DIRECT"] }], rulesets: [] }, /both filter and members/],
    [{ groups: [{ name: "a", type: "select", filter: "x" }, { name: "a", type: "select", filter: "y" }], rulesets: [] }, /duplicate group name/],
    [{ groups: [{ name: "a", type: "nope", filter: "x" }], rulesets: [] }, /type must be one of/],
    [{ groups: [{ name: "a", type: "select", filter: "x" }], rulesets: [{ group: "b", url: "https://example.com/x.list" }] }, /is not a defined group/],
    [{ groups: [{ name: "a", type: "select", filter: "x" }], rulesets: [{ group: "a", url: "ftp://example.com/x.list" }] }, /url must be http/],
    [{ groups: [{ name: "a", type: "select", filter: "x" }], rulesets: [{ name: "bad name", group: "a", url: "https://example.com/x.list" }] }, /must match/],
  ];
  for (const [body, pattern] of bad) {
    const response = await call(env, "PUT", "/api/v1/clash/rules", JSON.stringify(body), {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match((await response.json()).error, pattern);
  }

  // 恢复默认
  res = await call(env, "POST", "/api/v1/clash/rules/reset", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  doc = await res.json();
  assert.equal(doc.custom, false);
  res = await call(env, "GET", `/sub/all/${TOKEN}?format=clash`);
  yaml = await res.text();
  assert.ok(yaml.includes("RULE-SET,BanAD"), "reset brings the ACL4SSR rulesets back");
});

test("clash rules endpoints require the token", async () => {
  const env = makeEnv();
  for (const [method, path] of [["GET", "/api/v1/clash/rules"], ["PUT", "/api/v1/clash/rules"], ["POST", "/api/v1/clash/rules/reset"]]) {
    const res = await call(env, method, path, method === "PUT" ? "{}" : null);
    assert.equal(res.status, 401, `${method} ${path} must need a token`);
  }
});

test("only admins can log in, and the password comes from the environment", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "Sh94ghdf@" });
  const admin = { authorization: `Bearer ${TOKEN}` };
  await call(env, "POST", "/api/v1/report/box", b64("vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-01"), admin);

  // 环境变量里的口令
  let res = await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: "Sh94ghdf@" }), { "content-type": "application/json" });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.role, "admin");
  assert.match(data.token, /^sk1\.\d+\.([a-f0-9]{64})$/, "login must hand out a signed session token, not the password");
  assert.ok(data.expires_in > 0);
  const session = { authorization: `Bearer ${data.token}` };
  let me = await call(env, "GET", "/api/v1/auth/session", null, session);
  assert.equal((await me.json()).role, "admin", "the session token must work like a bearer token");

  // 订阅 token 不再能当登录口令（订阅链接泄露不等于后台泄露），但仍是合法的 API bearer
  res = await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: TOKEN }), { "content-type": "application/json" });
  assert.equal(res.status, 401, "TOKEN must not log into the UI");
  res = await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200, "TOKEN still authenticates API calls");

  res = await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: "nope-nope" }), { "content-type": "application/json" });
  assert.equal(res.status, 401);

  // 没有游客这条身份了：GUEST_CODE 也进不去，老的 /auth/guest 接口不存在
  const env2 = makeEnv({ ADMIN_PASSWORD: "Sh94ghdf@", GUEST_CODE: "guest-code-123" });
  res = await call(env2, "POST", "/api/v1/auth/login", JSON.stringify({ password: "guest-code-123" }), { "content-type": "application/json" });
  assert.equal(res.status, 401);
  res = await call(env, "GET", "/api/v1/auth/guest", null, admin);
  assert.equal(res.status, 404);
  res = await call(env, "POST", "/api/v1/auth/password", JSON.stringify({ password: "whatever-123" }), { ...admin, "content-type": "application/json" });
  assert.equal(res.status, 404);

  // 会话带订阅 token；节点照常带 link（没有游客了就不需要抹掉）
  res = await call(env, "GET", "/api/v1/auth/session", null, admin);
  data = await res.json();
  assert.equal(data.role, "admin");
  assert.equal(data.sub_token, TOKEN);
  res = await call(env, "GET", "/api/v1/nodes/box", null, admin);
  data = await res.json();
  assert.equal(data.role, undefined);
  assert.ok(String(data.nodes[0].link).startsWith("vless://"));
});

test("login failure says so when no admin password is configured", async () => {
  const res = await call(makeEnv({ ADMIN_PASSWORD: "pw-123456" }), "POST", "/api/v1/auth/login", JSON.stringify({ password: "pw-123456" }), { "content-type": "application/json" });
  assert.equal(res.status, 200);
  const bare = makeEnv({});
  bare.TOKEN = "";
  const res2 = await call(bare, "POST", "/api/v1/auth/login", JSON.stringify({ password: "x" }), { "content-type": "application/json" });
  assert.equal(res2.status, 500);
  assert.equal((await res2.json()).error, "ADMIN_PASSWORD is not configured");
});

test("unknown paths get a 404 page, /api still answers JSON", async () => {
  const env = makeEnv();
  const page = await call(env, "GET", "/nope/whatever");
  assert.equal(page.status, 404, "unknown paths must 404, scanners get nothing");
  const nav = await call(env, "GET", "/nope/whatever", null, { accept: "text/html" });
  assert.equal(nav.status, 404, "browser navigation must 404 too, only /ui is the entry");
  const body = await page.text();
  assert.ok(body.includes("404"), "404 page must show the code");
  assert.ok(!body.includes("<script>"), "404 page must not run scripts");
  assert.ok(!/<a\s/i.test(body), "404 page must not link anywhere");
  assert.ok(!body.includes("/nope/whatever"), "404 page must not echo the path");

  const api = await call(env, "GET", "/api/v1/nope", null, { authorization: `Bearer ${TOKEN}` });
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error, "not found");
});

test("admin env report lists known variables and flags leftovers", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "pw", SUB_TOKEN: "sub-token-abc", GUEST_CODE: "leftover" });
  const res = await call(env, "GET", "/api/v1/admin/env", null, { authorization: "Bearer sub-token-abc" });
  assert.equal(res.status, 200);
  const data = await res.json();
  const names = data.used.map((item) => item.name);
  assert.deepEqual(names.sort(), ["ADMIN_PASSWORD", "DB", "REPORT_TOKEN", "SUB_TOKEN"]);
  assert.ok(data.used.filter((item) => item.name !== "REPORT_TOKEN").every((item) => item.set), "known variables are set in the test env");
  assert.deepEqual(data.unused.sort(), ["GUEST_CODE", "TOKEN"], "leftover variables must be reported");

  const anon = await call(env, "GET", "/api/v1/admin/env");
  assert.equal(anon.status, 401);
});

test("login is rate limited per IP after repeated failures", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "right-pass" });
  const headers = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" };
  const attempt = (password, ip = "203.0.113.9") =>
    call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password }), { ...headers, "cf-connecting-ip": ip });

  for (let i = 1; i <= 9; i += 1) {
    const res = await attempt("wrong-" + i);
    assert.equal(res.status, 401, `attempt ${i} must stay 401`);
  }
  const tenth = await attempt("wrong-10");
  assert.equal(tenth.status, 429, "the 10th failure locks the IP");
  const blocked = await attempt("right-pass");
  assert.equal(blocked.status, 429, "even the right password is refused while locked");
  assert.ok(Number(blocked.headers.get("retry-after")) >= 86000, "lock lasts 24 hours");

  const other = await attempt("right-pass", "198.51.100.7");
  assert.equal(other.status, 200, "a different IP is not affected");

  // 换一个 IP 把次数用对：成功登录会清掉自己的计数
  const ip = "198.51.100.8";
  await attempt("nope", ip);
  const ok = await attempt("right-pass", ip);
  assert.equal(ok.status, 200);
  const res = await call(env, "GET", "/api/v1/machines", null, { authorization: "Bearer right-pass" });
  assert.equal(res.status, 200);
});

test("UI_PATH moves the entry and hides /ui", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "pw", UI_PATH: "/x7q" });
  assert.equal((await call(env, "GET", "/ui")).status, 404, "default path must stop working");
  const moved = await call(env, "GET", "/x7q");
  assert.equal(moved.status, 200);
  assert.ok((await moved.text()).includes('id="login-password"'));
  assert.equal((await call(env, "GET", "/x7q/")).status, 200);
  assert.equal((await call(env, "GET", "/x7q/whatever")).status, 200, "sub paths belong to the UI too");
  assert.equal((await call(env, "GET", "/")).status, 404);

  const normal = makeEnv({ ADMIN_PASSWORD: "pw" });
  assert.equal((await call(normal, "GET", "/ui")).status, 200, "without UI_PATH the default keeps working");
});

test("admin can see who is failing to log in, and plain http is bounced", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "pw-abcdef" });
  const headers = { "content-type": "application/json" };
  for (let i = 0; i < 3; i += 1) {
    await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: "nope" }), { ...headers, "cf-connecting-ip": "192.0.2.5" });
  }
  const res = await call(env, "GET", "/api/v1/admin/logins", null, { authorization: "Bearer pw-abcdef" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.attempts[0].ip, "192.0.2.5");
  assert.equal(data.attempts[0].fails, 3);
  assert.equal(data.attempts[0].locked, false);

  const anon = await call(env, "GET", "/api/v1/admin/logins");
  assert.equal(anon.status, 401);

  const insecure = await call(env, "GET", "/health", null, { "x-forwarded-proto": "http" });
  assert.equal(insecure.status, 308);
  assert.match(insecure.headers.get("location"), /^https:\/\//);
});

test("session tokens expire and die when the password changes", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "pw-1" });
  const res = await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: "pw-1" }), { "content-type": "application/json" });
  const { token } = await res.json();
  assert.equal((await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${token}` })).status, 200);

  const tampered = token.replace(/\.[a-f0-9]{8}/, ".00000000");
  assert.equal((await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${tampered}` })).status, 401, "signature must matter");
  const expired = token.replace(/^sk1\.\d+\./, "sk1.1000000000000.");
  assert.equal((await call(env, "GET", "/api/v1/machines", null, { authorization: `Bearer ${expired}` })).status, 401, "expired tokens must fail");

  const changed = { ...env, ADMIN_PASSWORD: "pw-2" };
  assert.equal((await call(changed, "GET", "/api/v1/machines", null, { authorization: `Bearer ${token}` })).status, 401, "rotating the password kills old sessions");
});

test("optional ADMIN_USERNAME must match together with the password", async () => {
  const env = makeEnv({ ADMIN_PASSWORD: "pw-xyz-9", ADMIN_USERNAME: "yg-9f3k" });
  const attempt = (body) => call(env, "POST", "/api/v1/auth/login", JSON.stringify(body), { "content-type": "application/json" });

  assert.equal((await attempt({ password: "pw-xyz-9" })).status, 401, "username is required once configured");
  assert.equal((await attempt({ username: "admin", password: "pw-xyz-9" })).status, 401, "wrong username must fail");
  const ok = await attempt({ username: "yg-9f3k", password: "pw-xyz-9" });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).token, /^sk1\./);

  const mode = await call(env, "GET", "/api/v1/auth/mode");
  assert.deepEqual((await mode.json()).username_required, true);

  const plain = makeEnv({ ADMIN_PASSWORD: "pw-xyz-9" });
  const loose = await call(plain, "POST", "/api/v1/auth/login", JSON.stringify({ password: "pw-xyz-9" }), { "content-type": "application/json" });
  assert.equal(loose.status, 200, "without ADMIN_USERNAME the username field is ignored");
  assert.equal((await (await call(plain, "GET", "/api/v1/auth/mode")).json()).username_required, false);
});

test("REPORT_TOKEN becomes the only credential machines may report with", async () => {
  const env = makeEnv({ REPORT_TOKEN: "report-only-token-abc", ADMIN_PASSWORD: "pw-report" });
  const body = b64("vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-01");

  const withToken = await call(env, "POST", "/api/v1/report/box-rt", body, { authorization: `Bearer ${TOKEN}` });
  assert.equal(withToken.status, 401, "subscription TOKEN must stop working once REPORT_TOKEN is set");

  const withReport = await call(env, "POST", "/api/v1/report/box-rt", body, { authorization: "Bearer report-only-token-abc" });
  assert.equal(withReport.status, 200);
  assert.equal((await withReport.json()).nodes, 1);

  // 上报凭证不能当管理员口令，也不能读管理接口
  const login = await call(env, "POST", "/api/v1/auth/login", JSON.stringify({ password: "report-only-token-abc" }), { "content-type": "application/json" });
  assert.equal(login.status, 401);
  const read = await call(env, "GET", "/api/v1/machines", null, { authorization: "Bearer report-only-token-abc" });
  assert.equal(read.status, 401);

  // 没配 REPORT_TOKEN 的老部署继续用 TOKEN 上报
  const legacy = makeEnv({});
  const old = await call(legacy, "POST", "/api/v1/report/box-legacy", body, { authorization: `Bearer ${TOKEN}` });
  assert.equal(old.status, 200);
});

test("SUB_TOKEN is the new name and TOKEN still works as a fallback", async () => {
  const renamed = makeEnv({ ADMIN_PASSWORD: "pw" });
  renamed.SUB_TOKEN = renamed.TOKEN;
  delete renamed.TOKEN;
  assert.equal((await call(renamed, "GET", "/sub/all/" + renamed.SUB_TOKEN)).status, 200, "SUB_TOKEN must drive subscriptions");
  assert.equal((await call(renamed, "GET", "/api/v1/machines", null, { authorization: `Bearer ${renamed.SUB_TOKEN}` })).status, 200);

  const both = makeEnv({ ADMIN_PASSWORD: "pw", SUB_TOKEN: "new-token-value", TOKEN: "old-token-value" });
  assert.equal((await call(both, "GET", "/sub/all/new-token-value")).status, 200, "SUB_TOKEN wins when both exist");
  assert.equal((await call(both, "GET", "/sub/all/old-token-value")).status, 401, "the old token stops working once SUB_TOKEN is set");
});

test("protocol filter decides which protocols reach the subscription", async () => {
  const env = makeEnv();
  const vless = "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-vless";
  const hy2 = "hysteria2://pw@jp.example.io:443?sni=addons.mozilla.org#东京-hy2";
  const trojan = "trojan://pw@sg.example.io:443?security=tls#新加坡-trojan";

  const saved = await call(env, "PUT", "/api/v1/nodes/box-pf", JSON.stringify({ nodes: [{ link: vless }, { link: hy2 }, { link: trojan }] }), { "content-type": "application/json", authorization: `Bearer ${TOKEN}` });
  assert.equal(saved.status, 200);

  const config = await (await call(env, "GET", "/api/v1/nodes/box-pf", null, { authorization: `Bearer ${TOKEN}` })).json();
  assert.deepEqual(config.protocols, [], "默认不筛选");
  assert.deepEqual(config.protocol_stats.map((item) => [item.kind, item.count]).sort(), [["hy2", 1], ["trojan", 1], ["vless", 1]]);
  assert.equal(config.stats_ok, undefined);

  assert.equal(unb64(await (await call(env, "GET", `/sub/box-pf/${TOKEN}`)).text()).split("\n").filter(Boolean).length, 3);

  const picked = await call(env, "PUT", "/api/v1/nodes/box-pf/protocols", JSON.stringify({ protocols: ["vless"] }), { "content-type": "application/json", authorization: `Bearer ${TOKEN}` });
  assert.equal(picked.status, 200);
  const pickedBody = await picked.json();
  assert.deepEqual(pickedBody.protocols, ["vless"]);
  assert.equal(pickedBody.nodes, 1);
  assert.equal(pickedBody.every, 3);

  const single = unb64(await (await call(env, "GET", `/sub/box-pf/${TOKEN}`)).text()).split("\n").filter(Boolean);
  assert.equal(single.length, 1);
  assert.match(single[0], /^vless:\/\//);
  assert.equal((await call(env, "GET", `/sub/all/${TOKEN}`)).headers.get("x-nodes"), "1", "合并订阅也跟着筛");

  const both = await call(env, "PUT", "/api/v1/nodes/box-pf/protocols", JSON.stringify({ protocols: ["vless", "hy2"] }), { "content-type": "application/json", authorization: `Bearer ${TOKEN}` });
  assert.equal((await both.json()).nodes, 2);

  const bad = await call(env, "PUT", "/api/v1/nodes/box-pf/protocols", JSON.stringify({ protocols: ["V-LE SS"] }), { "content-type": "application/json", authorization: `Bearer ${TOKEN}` });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid protocol/);

  const cleared = await call(env, "PUT", "/api/v1/nodes/box-pf/protocols", JSON.stringify({ protocols: [] }), { "content-type": "application/json", authorization: `Bearer ${TOKEN}` });
  assert.equal((await cleared.json()).nodes, 3, "清空 = 全部显示");
  assert.equal((await (await call(env, "GET", "/api/v1/nodes/box-pf", null, { authorization: `Bearer ${TOKEN}` })).json()).protocols.length, 0);
});

test("single nodes can be excluded from the subscription", async () => {
  const env = makeEnv();
  const a = "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-A";
  const b = "hysteria2://pw@jp.example.io:443?sni=addons.mozilla.org#东京-B";
  const c = "trojan://pw@sg.example.io:443?security=tls#新加坡-C";
  const auth = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };

  await call(env, "PUT", "/api/v1/nodes/box-ex", JSON.stringify({ nodes: [{ link: a }, { link: b }, { link: c }] }), auth);
  const start = await (await call(env, "GET", "/api/v1/nodes/box-ex", null, { authorization: `Bearer ${TOKEN}` })).json();
  assert.equal(start.all_nodes.length, 3);
  assert.ok(start.all_nodes.every((item) => item.enabled), "默认全部勾选");
  assert.deepEqual(start.all_nodes.map((item) => item.label), ["VLESS", "Hysteria2", "Trojan"]);

  const idB = start.all_nodes[1].id;
  const off = await call(env, "PUT", "/api/v1/nodes/box-ex/disabled", JSON.stringify({ disabled: [idB] }), auth);
  const offBody = await off.json();
  assert.equal(offBody.nodes, 2);
  assert.equal(offBody.every, 3);
  assert.equal(offBody.all_nodes[1].enabled, false);

  const sub = unb64(await (await call(env, "GET", `/sub/box-ex/${TOKEN}`)).text()).split("\n").filter(Boolean);
  assert.equal(sub.length, 2);
  assert.ok(!sub.some((line) => line.startsWith("hysteria2://")));

  // 和协议筛选叠加：排除 B 之后只留 vless，就只剩 1 个
  await call(env, "PUT", "/api/v1/nodes/box-ex/protocols", JSON.stringify({ protocols: ["vless"] }), auth);
  assert.equal((await (await call(env, "GET", `/sub/box-ex/${TOKEN}`)).text()).trim().split("\n").filter(Boolean).length, 1);

  const restore = await call(env, "PUT", "/api/v1/nodes/box-ex/disabled", JSON.stringify({ disabled: [] }), auth);
  assert.equal((await restore.json()).every, 3);
  const bad = await call(env, "PUT", "/api/v1/nodes/box-ex/disabled", JSON.stringify({ disabled: "nope" }), auth);
  assert.equal(bad.status, 400);

  // 上报节点也能被排除：新上报的节点默认可见
  await call(env, "PUT", "/api/v1/nodes/box-ex/protocols", JSON.stringify({ protocols: [] }), auth);
  const d = "tuic://11111111-1111-4111-8111-111111111111:pw@us.example.io:443?sni=x#美国-D";
  await call(env, "POST", "/api/v1/report/box-ex", b64(d), { authorization: "Bearer " + TOKEN });
  const afterReport = await (await call(env, "GET", "/api/v1/nodes/box-ex", null, { authorization: `Bearer ${TOKEN}` })).json();
  assert.ok(afterReport.all_nodes.some((item) => item.source === "auto" && item.enabled), "上报节点默认可见");
});

test("subscription node list spans every machine in machine order and toggles globally", async () => {
  const env = makeEnv();
  const auth = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const a = "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-A";
  const b = "hysteria2://pw@jp.example.io:443?sni=addons.mozilla.org#东京-B";
  const c = "trojan://pw@sg.example.io:443?security=tls#新加坡-C";

  await call(env, "PUT", "/api/v1/nodes/mach-a", JSON.stringify({ nodes: [{ link: a }, { link: b }] }), auth);
  await call(env, "PUT", "/api/v1/nodes/mach-b", JSON.stringify({ nodes: [{ link: c }] }), auth);
  await call(env, "PUT", "/api/v1/machines/order", JSON.stringify({ machines: ["mach-b", "mach-a"] }), auth);

  const view = await (await call(env, "GET", "/api/v1/sub/nodes", null, { authorization: `Bearer ${TOKEN}` })).json();
  assert.deepEqual(view.machines.map((m) => m.machine), ["mach-b", "mach-a"], "machine order comes from the order setting");
  assert.equal(view.stats.total, 3);
  assert.equal(view.stats.enabled, 3, "默认全部在订阅里");
  assert.deepEqual(view.machines[1].nodes.map((n) => n.in_sub), [true, true]);
  assert.deepEqual(view.stats.protocols.map((p) => p.kind).sort(), ["hy2", "trojan", "vless"]);

  const cut = view.machines[1].nodes[1].id;
  const put = await call(env, "PUT", "/api/v1/sub/disabled", JSON.stringify({ disabled: [cut] }), auth);
  const afterBody = await put.json();
  assert.equal(afterBody.stats.enabled, 2);
  assert.equal(afterBody.stats.disabled, 1);

  const afterView = await (await call(env, "GET", "/api/v1/sub/nodes", null, { authorization: `Bearer ${TOKEN}` })).json();
  assert.deepEqual(afterView.machines[1].nodes.map((n) => n.in_sub), [true, false]);
  assert.equal(unb64(await (await call(env, "GET", `/sub/mach-a/${TOKEN}`)).text()).split("\n").filter(Boolean).length, 1);
  assert.equal((await call(env, "GET", `/sub/all/${TOKEN}`)).headers.get("x-nodes"), "2");

  const restore = await call(env, "PUT", "/api/v1/sub/disabled", JSON.stringify({ disabled: [] }), auth);
  assert.equal((await restore.json()).stats.enabled, 3);
  assert.equal((await call(env, "PUT", "/api/v1/sub/disabled", JSON.stringify({ disabled: "x" }), auth)).status, 400);
});
