/**
 * UI 流程自测：把 /ui/<token> 页面里的真实脚本放进 node:vm，配一个最小 DOM 壳，
 * 用真实的 Worker + node:sqlite 当后端，像用户一样点按钮/粘链接/改名/排序/删除，
 * 最后用 API 核对结果。目标是「按钮真的连上了」，不是「接口能用」。
 *
 * 运行：pnpm run test:ui
 */
import http from "node:http";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

import worker, { SCHEMA_STATEMENTS } from "../src/index.js";

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true, meta: { changes: 0 } }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes || 0) } }; }
}
class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }
}

const db = new DatabaseSync(":memory:");
for (const s of SCHEMA_STATEMENTS) db.prepare(s).run();

const TOKEN = "ui-test-token";
const env = { DB: new SqliteD1(db), TOKEN };

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://127.0.0.1:${server.address().port}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const resp = await worker.fetch(request, env);
    const out = Buffer.from(await resp.arrayBuffer());
    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    res.end(out);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`handler crash: ${err.stack}`);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* 测试用节点（凭据与地址都是占位，别当成能连的节点） */
const HY2 = "hysteria2://00000000-0000-0000-0000-000000000000@203.0.113.10:31004/?sni=www.apple.com&insecure=1&pinSHA256=deadbeef&alpn=h3&obfs=none#%E5%B0%8F%E5%8F%AE%E5%BD%93-%E6%B4%9B%E6%9D%89%E7%9F%B6-cloudnium-hy2-localhost";
const TUIC = "tuic://00000000-0000-0000-0000-000000000000:11111111-1111-1111-1111-111111111111@203.0.113.10:31005?sni=www.apple.com&congestion_control=bbr&security=tls&udp_relay_mode=native&alpn=h3&allow_insecure=1#%E5%B0%8F%E5%8F%AE%E5%BD%93-%E6%B4%9B%E6%9D%89%E7%9F%B6-cloudnium-tuic-localhost";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? `  ·  ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- DOM 壳 ---------------- */
class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this._text = "";
    this._html = "";
    this.className = "";
    this.value = "";
    this.type = "";
    this.title = "";
    this.placeholder = "";
    this.disabled = false;
    this.attrs = {};
    this.style = {};
    this._listeners = {};
  }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  set innerHTML(v) { this._html = String(v || ""); if (!v) this.children = []; }
  get innerHTML() { return this._html; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  focus() {}
  select() {}
}

const elements = {};
const docListeners = {};
const documentShim = {
  getElementById(id) {
    if (!elements[id]) { const e = new El("div"); e.id = id; elements[id] = e; }
    return elements[id];
  },
  createElement(tag) { return new El(tag); },
  createTextNode(t) { return { textContent: String(t), children: [] }; },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  body: new El("body"),
};

const prompts = [];
const confirms = [];
const clipboard = [];
const windowShim = {
  prompt: () => (prompts.length ? prompts.shift() : null),
  confirm: () => (confirms.length ? confirms.shift() : true),
};
const navigatorShim = { clipboard: { writeText: async (t) => { clipboard.push(t); } } };

/* ---------------- 网络 ---------------- */
let inflight = 0;
const netFetch = (url, init) => fetch(url, init);
async function shimFetch(input, init) {
  const url = String(input).startsWith("http") ? String(input) : BASE + String(input);
  inflight++;
  try { return await netFetch(url, init); } finally { inflight--; }
}
async function idle(timeout = 25000) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < timeout) {
    await sleep(40);
    if (inflight === 0) { if (++quiet >= 3) return; } else quiet = 0;
  }
}

async function api(path, opts = {}) {
  const headers = Object.assign({ Authorization: "Bearer " + TOKEN }, opts.headers || {});
  const r = await netFetch(BASE + "/api/v1" + path, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: r.status, data };
}

/* ---------------- 载入真实页面脚本 ---------------- */
const pageRes = await netFetch(BASE + "/ui/" + encodeURIComponent(TOKEN));
const html = await pageRes.text();
check("GET /ui/<token> 200", pageRes.status === 200, `${html.length} B`);
const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
check("页面含内联脚本", Boolean(code), `${code ? code.length : 0} B`);

const sandbox = {
  document: documentShim,
  window: windowShim,
  navigator: navigatorShim,
  confirm: () => (confirms.length ? confirms.shift() : true),
  prompt: (msg, def) => (prompts.length ? prompts.shift() : def),
  location: { pathname: `/ui/${TOKEN}`, origin: BASE, href: `${BASE}/ui/${TOKEN}` },
  fetch: shimFetch,
  setTimeout, clearTimeout, console,
  atob, btoa, escape, unescape,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: "ui-inline.js" });
  check("脚本可执行（vm 编译+运行）", true);
} catch (e) {
  check("脚本可执行（vm 编译+运行）", false, e.message);
  console.log(e);
  process.exit(1);
}
await idle();

/* ---------------- 元素助手 ---------------- */
const el = (id) => documentShim.getElementById(id);
const text = (id) => el(id).textContent;
const rows = (id) => el(id).children;
const click = (id) => { const e = el(id); if (typeof e.onclick !== "function") throw new Error(`#${id} 没有绑定点击`); e.onclick.call(e); };
const machineRows = () => rows("machine-list");
const findMachineRow = (name) => machineRows().find((r) => (r.children[1] || {}).textContent?.includes(name));
const nodeRows = () => rows("nodes");
const links = () => nodeRows().map((r) => r.children[1].value);
const names = () => nodeRows().map((r) => r.children[2].value);

/* ---------------- 清场 ---------------- */
{
  const { data } = await api("/machines");
  for (const m of data.machines || []) await api("/machines/" + encodeURIComponent(m.machine), { method: "DELETE" });
  await api("/machines/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machines: [] }) });
  click("reload");
  await idle();
}

/* ---------------- 流程 ---------------- */
// A. 空状态
check("空状态：机器列表提示", text("machine-list").includes("暂无机器上报"), text("machine-list").slice(0, 20));
check("空状态：下拉提示", (machineRows()[0], el("machine").children[0].textContent.includes("暂无机器，先用下面「新建机器」")));
check("空状态：节点区提示", text("nodes").includes("暂无节点"));

// B. 新建中文名机器 + 批量粘贴两条节点
el("new-machine").value = "香港-小叮当";
el("bulk").value = `${HY2}\n\n${TUIC}`;
click("create-machine");
await idle();
check("新建机器：状态文案", text("status").includes("已创建 香港-小叮当，带入 2 个节点"), text("status"));
check("新建机器：列表出现且标手动", text("machine-list").includes("香港-小叮当") && text("machine-list").includes("手动"));
check("新建机器：节点区两行", nodeRows().length === 2, `rows=${nodeRows().length}`);
check("新建机器：#片段自动成名字", names()[0] === "小叮当-洛杉矶-cloudnium-hy2-localhost", names()[0]);
check("新建机器：第二个名字", names()[1] === "小叮当-洛杉矶-cloudnium-tuic-localhost", names()[1]);

// C. 保存配置
click("save");
await idle();
check("保存配置：状态文案", text("status").includes("保存成功：2 个节点"), text("status"));
{
  const { data } = await api("/nodes/" + encodeURIComponent("香港-小叮当"));
  const n = data.nodes || [];
  check("保存配置：服务端两条且 order 连续", n.length === 2 && n[0].order === 0 && n[1].order === 1, JSON.stringify(n.map((x) => [x.order, x.protocol])));
  check("保存配置：协议识别", n[0].protocol === "hy2" && n[1].protocol === "tuic", n.map((x) => x.protocol).join(","));
}

// D. 单条添加 + 失焦自动命名 + 删行
click("add");
check("添加一行：节点区三行", nodeRows().length === 3);
{
  const row = nodeRows()[2];
  const link = row.children[1];
  link.value = HY2.replace(/#.*$/, "#%E6%B5%8B%E8%AF%95-hy2");
  link.oninput();
  link.onblur();
  check("失焦自动命名（URL 解码片段）", row.children[2].value === "测试-hy2", row.children[2].value);
  row.children[5].onclick();
  check("删行：回到两行", nodeRows().length === 2);
}

// E. 批量区重复去重
el("bulk").value = `${HY2}\n${TUIC}`;
click("bulk-add");
await idle();
check("批量重复：全部跳过", text("bulk-status").includes("跳过 2 个重复"), text("bulk-status"));
check("批量重复：输入框清空", el("bulk").value === "");

// F. 行内粘贴展开多行
click("add");
{
  const row = nodeRows()[2];
  const link = row.children[1];
  link.value = "";
  let prevented = false;
  link.onpaste({ clipboardData: { getData: () => `${HY2}&probe=1 ${TUIC}&probe=2` }, preventDefault: () => { prevented = true; } });
  await idle();
  check("行内粘贴：拦截默认行为", prevented);
  check("行内粘贴：一次加两条", nodeRows().length === 4, `rows=${nodeRows().length}`);
  check("行内粘贴：提示已添加", text("bulk-status").includes("已添加 2 个节点"), text("bulk-status"));
}

// G. 第二台机器（名字带空格）+ 排序 + 保存顺序
el("new-machine").value = "洛杉矶 备用";
el("bulk").value = TUIC;
click("create-machine");
await idle();
check("第二台机器创建", text("status").includes("已创建 洛杉矶 备用"), text("status"));
check("机器列表两行", machineRows().length === 2, `rows=${machineRows().length}`);
const orderBefore = machineRows().map((r) => r.children[1].textContent);
check("创建顺序符合预期", orderBefore[0].includes("香港-小叮当") && orderBefore[1].includes("洛杉矶 备用"), orderBefore.join(" | "));
machineRows()[0].children[4].onclick(); // ↓
check("下移：UI 顺序交换", machineRows()[0].children[1].textContent.includes("洛杉矶 备用"), machineRows().map((r) => r.children[1].textContent).join(" | "));
click("save-machine-order");
await idle();
check("保存排序：提示", text("order-status").includes("机器顺序已保存"), text("order-status"));
{
  const { data } = await api("/machines");
  check("保存排序：服务端顺序一致", (data.machines || []).map((m) => m.machine).join(",") === "洛杉矶 备用,香港-小叮当", JSON.stringify((data.machines || []).map((m) => m.machine)));
}

// H. 重命名（保留节点与排序位）
{
  const row = findMachineRow("香港-小叮当");
  row.children[5].onclick(); // 编辑节点
  await idle();
  check("编辑节点：载入已保存的 2 条", nodeRows().length === 2, `rows=${nodeRows().length}`);
  prompts.push("香港-备用");
  click("rename");
  await idle();
  check("重命名：提示", text("status").includes("已重命名 香港-小叮当 → 香港-备用"), text("status"));
  const { data } = await api("/machines");
  const list = (data.machines || []).map((m) => m.machine);
  check("重命名：机器名已换", list.includes("香港-备用") && !list.includes("香港-小叮当"), list.join(","));
  check("重命名：排序位保留", list[1] === "香港-备用", list.join(","));
  const nodes = (await api("/nodes/" + encodeURIComponent("香港-备用"))).data.nodes || [];
  check("重命名：节点跟着走", nodes.length === 2, `${nodes.length} 个`);
}

// I. 非法机器名
el("new-machine").value = "bad/name";
click("create-machine");
await idle();
check("非法机器名：给提示", text("status").includes("机器名可用中文"), text("status"));
check("非法机器名：标红", el("status").className.includes("err"), el("status").className);

// J. 同名接管
el("new-machine").value = "香港-备用";
click("create-machine");
await idle();
check("同名：不新建而是切换并说明", text("status").includes("机器已存在，已切换到 香港-备用"), text("status"));

// K. 上报机器出现在 UI（徽章区分来源）
{
  const body = Buffer.from(TUIC + "\n" + HY2).toString("base64");
  const r = await netFetch(BASE + "/api/v1/report/" + encodeURIComponent("auto-hk"), {
    method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body,
  });
  const rd = await r.json();
  check("上报接口：写入成功", rd.ok === true && rd.changed === true, JSON.stringify(rd).slice(0, 90));
  click("reload");
  await idle();
  check("上报机器出现在列表", text("machine-list").includes("auto-hk"));
  check("上报机器标「上报」", findMachineRow("auto-hk").children[1].textContent.includes("上报"), findMachineRow("auto-hk").children[1].textContent);
  check("手动机器标「手动」", findMachineRow("香港-备用").children[1].textContent.includes("手动"), findMachineRow("香港-备用").children[1].textContent);
}

// L. reset 的 confirm 守卫 + 恢复自动上报
{
  findMachineRow("香港-备用").children[5].onclick();
  await idle();
  const before = nodeRows().length;
  // 手动机器继续上报：只更新 content，节点仍保留手动版本
  {
    const body = Buffer.from(TUIC).toString("base64");
    const r = await netFetch(BASE + "/api/v1/report/" + encodeURIComponent("香港-备用"), {
      method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body,
    });
    const rd = await r.json();
    check("手动机器上报：仍标手动", rd.manual === true && rd.changed === true, JSON.stringify(rd).slice(0, 70));
    const still = (await api("/nodes/" + encodeURIComponent("香港-备用"))).data.nodes || [];
    check("手动机器上报：节点不被覆盖", still.length === before, `${still.length} vs ${before}`);
  }
  confirms.push(false);
  click("reset");
  await idle();
  check("reset 取消：节点不变", nodeRows().length === before, `${nodeRows().length} vs ${before}`);
  confirms.push(true);
  click("reset");
  await idle();
  check("reset 确认：提示已恢复", text("status").includes("已恢复自动上报"), text("status"));
  const { data } = await api("/nodes/" + encodeURIComponent("香港-备用"));
  check("reset 确认：节点改用最近一次上报的内容", (data.nodes || []).length === 1, `${(data.nodes || []).length} 个`);
  check("reset 确认：徽章变「上报」", findMachineRow("香港-备用").children[1].textContent.includes("上报"));
}

// M. 删除机器（confirm 守卫）
{
  const row = findMachineRow("auto-hk");
  confirms.push(false);
  row.children[6].onclick();
  await idle();
  check("删除取消：机器还在", Boolean(findMachineRow("auto-hk")));
  confirms.push(true);
  findMachineRow("auto-hk").children[6].onclick();
  await idle();
  check("删除确认：机器消失", !findMachineRow("auto-hk"), text("machine-list").slice(0, 40));
  const { data } = await api("/machines");
  check("删除确认：服务端也没了", !(data.machines || []).some((m) => m.machine === "auto-hk"));
}

// N. 复制按钮（data-copy）
{
  check("订阅链接展示", text("url-base") === `${BASE}/sub/all/${encodeURIComponent(TOKEN)}`, text("url-base"));
  const btn = { textContent: "复制", getAttribute: (k) => (k === "data-copy" ? "url-base" : null) };
  docListeners.click[0]({ target: btn });
  await idle(500);
  check("复制：写入剪贴板", clipboard[0] === text("url-base"), clipboard[0]);
  check("复制：按钮反馈", btn.textContent === "已复制" || btn.textContent === "复制", btn.textContent);
}

// O. 合并订阅输出（顺序、格式）
{
  const subRes = await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}`);
  const subText = await subRes.text();
  const decoded = Buffer.from(subText, "base64").toString("utf8").split("\n").filter(Boolean);
  const { data } = await api("/machines");
  const expected = (data.machines || []).reduce((a, m) => a + (m.nodes || 0), 0);
  check("合并订阅：条数等于各机器之和", decoded.length === expected, `${decoded.length} vs ${expected}`);
  check("合并订阅：可解码且首条是 hysteria2/tuic", /^(hysteria2|tuic):\/\//.test(decoded[0]), decoded[0].slice(0, 24));
  const clash = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}?format=clash`)).text();
  check(
    "clash 完整配置：分组 + 规则 + 节点都在",
    clash.includes("proxy-groups:") && clash.includes("rule-providers:") && clash.includes("rules:") && /type: (hysteria2|tuic|vless)/.test(clash),
    `${clash.length} B`,
  );
  check("clash 规则以 rule-providers 下发，不内联", /^  "BanAD":$/m.test(clash) && !/^  - DOMAIN,/.test(clash));
  check("clash 规则最后是 MATCH 且 GEOIP,CN 在", /MATCH,🐟 漏网之鱼/.test(clash) && /GEOIP,CN/.test(clash));
  const frag = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}?format=proxies`)).text();
  check("clash 片段模式只有 proxies:", frag.startsWith("proxies:") && !frag.includes("proxy-groups:"), `${frag.length} B`);
  const uiHtml = await (await netFetch(`${BASE}/ui/${encodeURIComponent(TOKEN)}`)).text();
  check("UI 给出片段链接", uiHtml.includes("url-proxies") && uiHtml.includes("?format=proxies"));
  const singbox = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}?format=singbox`)).text();
  let sb = null;
  try { sb = JSON.parse(singbox); } catch {}
  check("singbox 输出：合法 JSON 且含 outbounds", Boolean(sb) && Array.isArray(sb.outbounds), sb ? `${sb.outbounds.length} outbounds` : "parse fail");
  const one = await netFetch(`${BASE}/sub/${encodeURIComponent("香港-备用")}/${encodeURIComponent(TOKEN)}`);
  const oneBody = await one.text();
  check("单机订阅：x-machine 已编码", decodeURIComponent(one.headers.get("x-machine") || "") === "香港-备用", one.headers.get("x-machine"));
  check("单机订阅：内容非空", oneBody.length > 20, `${oneBody.length} B`);
}

/* ---------------- 清场 + 汇总 ---------------- */
{
  const { data } = await api("/machines");
  for (const m of data.machines || []) await api("/machines/" + encodeURIComponent(m.machine), { method: "DELETE" });
  await api("/machines/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machines: [] }) });
  const after = (await api("/machines")).data.machines || [];
  check("清场完成", after.length === 0, `${after.length} 台残留`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
server.close();
db.close();
if (pass !== results.length) {
  console.log("失败项：" + results.filter((r) => !r.ok).map((r) => r.name).join(" | "));
  process.exit(1);
}
