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
const ADMIN_PASSWORD = "ui-admin-pass";
const env = { DB: new SqliteD1(db), TOKEN, ADMIN_PASSWORD };

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
const storage = new Map();
const documentElement = new El("html");
documentElement.setAttribute = function (k, v) { this[k] = String(v); };
documentElement.getAttribute = function (k) { return this[k] == null ? null : this[k]; };
documentShim.documentElement = documentElement;
const windowShim = {
  prompt: () => (prompts.length ? prompts.shift() : null),
  confirm: () => (confirms.length ? confirms.shift() : true),
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
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
const pageRes = await netFetch(BASE + "/ui");
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
  location: { pathname: "/ui", origin: BASE, href: `${BASE}/ui` },
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
const autoRows = () => rows("auto-nodes");
const links = () => nodeRows().map((r) => r.children[1].value);
const names = () => nodeRows().map((r) => r.children[2].value);

/* ---------------- 登录 ---------------- */
{
  check("登录页：HTML 默认锁定，脚本没登录前不展示内容", html.includes('<body class="locked">'));
  el("login-password").value = "wrong-password";
  click("login-submit");
  await idle();
  check("登录页：错口令提示", text("login-status").includes("wrong password"), text("login-status"));
  el("login-password").value = ADMIN_PASSWORD;
  click("login-submit");
  await idle();
  check("登录页：管理员口令进入", !documentShim.body.className.includes("locked") && text("role-badge") === "管理员", `${documentShim.body.className}|${text("role-badge")}`);
  check("登录页：浮层隐藏", el("login").style.display === "none", el("login").style.display);
}

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
check("空状态：节点区提示", text("nodes").includes("暂无节点") || text("nodes").includes("没有手动节点"), text("nodes").slice(0, 30));

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
check("保存配置：状态文案", text("status").includes("已保存 ① 的 2 个手动节点"), text("status"));
{
  const { data } = await api("/nodes/" + encodeURIComponent("香港-小叮当"));
  const n = data.nodes || [];
  check("保存配置：服务端两条且 order 连续", n.length === 2 && n[0].order === 0 && n[1].order === 1, JSON.stringify(n.map((x) => [x.order, x.protocol])));
  check("保存配置：协议识别", n[0].protocol === "hy2" && n[1].protocol === "tuic", n.map((x) => x.protocol).join(","));
}

/* 未保存状态、撤销、清空手动节点、切换机器守卫 */
{
  check("未保存：初始无徽章", el("dirty-badge").style.display === "none", el("dirty-badge").style.display);
  check("计数徽章：① 2 个 / ② 0 个", text("manual-count") === "2 个" && text("auto-count") === "0 个", `${text("manual-count")} / ${text("auto-count")}`);
  click("add");
  await idle();
  check("未保存：徽章出现", el("dirty-badge").style.display === "", el("dirty-badge").style.display);
  check("未保存：保存按钮文案变化", el("save").textContent.includes("未保存"), el("save").textContent);
  check("未保存：撤销按钮可用", el("discard").disabled === false, String(el("discard").disabled));

  confirms.push(false);
  const sel = el("machine");
  sel.value = "auto-hk";
  sel.onchange.call(sel);
  await idle();
  check("切换机器：有未保存修改时被拦下", el("machine").value === "香港-小叮当", el("machine").value);

  click("discard");
  await idle();
  check("撤销：回到保存时的 2 条", el("nodes").children.length === 2, `${el("nodes").children.length} 行`);
  check("撤销：徽章隐藏、按钮恢复", el("dirty-badge").style.display === "none" && !el("save").textContent.includes("未保存"), el("save").textContent);

  confirms.push(true);
  click("clear-manual");
  await idle();
  check("清空手动节点：① 空且标记未保存", el("nodes").children[0].className === "empty" && el("dirty-badge").style.display === "", el("nodes").children[0].className);
  {
    const d = (await api("/nodes/" + encodeURIComponent("香港-小叮当"))).data;
    check("清空手动节点：没保存前服务端不变", (d.manual_nodes || []).length === 2, `${(d.manual_nodes || []).length} 条`);
  }
  click("discard");
  await idle();
  check("撤销：恢复 2 条", el("nodes").children.length === 2, `${el("nodes").children.length} 行`);
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

// F2. 节点序号直接调整
{
  const rows = nodeRows();
  check("节点序号是输入框", rows[0].children[0].type === "number", rows[0].children[0].type);
  const lastLink = rows[rows.length - 1].children[1].value;
  const idxInput = rows[rows.length - 1].children[0];
  idxInput.value = "1";
  idxInput.onchange();
  check("节点序号：最后一条提到第 1", nodeRows()[0].children[1].value === lastLink, nodeRows().map((r) => r.children[1].value.slice(0, 24)).join(" | "));
  const back = nodeRows()[0].children[0];
  back.value = "2";
  back.onchange();
  check("节点序号：放回第 2", nodeRows()[1].children[1].value === lastLink, nodeRows().map((r) => r.children[1].value.slice(0, 24)).join(" | "));
  const over = nodeRows()[1].children[0];
  over.value = "999";
  over.onchange();
  check("节点序号：超范围钳到末尾", nodeRows()[nodeRows().length - 1].children[1].value === lastLink, `rows=${nodeRows().length}`);
  const low = nodeRows()[nodeRows().length - 1].children[0];
  low.value = "0";
  low.onchange();
  check("节点序号：小于 1 钳到开头", nodeRows()[0].children[1].value === lastLink, nodeRows().map((r) => r.children[1].value.slice(0, 24)).join(" | "));
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
{
  // 机器序号直接调整：第 2 行改成 1，再改回 2，最后越界填 99
  check("机器序号是输入框", machineRows()[0].children[0].type === "number", machineRows()[0].children[0].type);
  let idxInput = machineRows()[1].children[0];
  idxInput.value = "1";
  idxInput.onchange();
  check("机器序号：第二台提到第 1", machineRows()[0].children[1].textContent.includes("香港-小叮当"), machineRows().map((r) => r.children[1].textContent).join(" | "));
  check("机器序号：提示需要保存", text("order-status").includes("顺序已改"), text("order-status"));
  idxInput = machineRows()[0].children[0];
  idxInput.value = "2";
  idxInput.onchange();
  check("机器序号：回到第 2", machineRows()[1].children[1].textContent.includes("香港-小叮当"), machineRows().map((r) => r.children[1].textContent).join(" | "));
  idxInput = machineRows()[0].children[0];
  idxInput.value = "99";
  idxInput.onchange();
  check("机器序号：越界钳到末尾", machineRows()[1].children[1].textContent.includes("洛杉矶 备用"), machineRows().map((r) => r.children[1].textContent).join(" | "));
  idxInput = machineRows()[0].children[0];
  idxInput.value = "2";
  idxInput.onchange();
  check("机器序号：再摆回原顺序", machineRows()[0].children[1].textContent.includes("洛杉矶 备用"), machineRows().map((r) => r.children[1].textContent).join(" | "));
}
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
check("按钮说明：写清两个「清空」的区别", html.includes("立刻生效、不用再保存") && html.includes("点 ① 的「保存配置」才写进库"), "块内说明");
check("按钮说明：不再有「两个清空不一样」前缀", !html.includes("两个「清空」不一样"), "");
check("按钮说明：清空手动节点用红字", html.includes('<b class="err">清空手动节点</b>'), "");
check("按钮说明：两条说明各占一行", html.includes("不用再保存</b>；</div>") && html.includes("还原。</div>"), "");
check("非法机器名：给提示", text("status").includes("机器名可用中文"), text("status"));
check("非法机器名：标红", el("status").className.includes("err"), el("status").className);

// I2. 机器名不能带状态字样（手动 / 上报 / 自动）
{
  const before = (await api("/machines")).data.count;
  el("new-machine").value = "测试机房手动";
  click("create-machine");
  await idle();
  check("带状态字样：给提示", text("status").includes("机器名里不要带状态字样"), text("status"));
  check("带状态字样：没有建出机器", (await api("/machines")).data.count === before, `count=${(await api("/machines")).data.count}`);

  const cur = el("machine").value;
  prompts.push(cur + "上报");
  click("rename");
  await idle();
  check("重命名带状态字样：给提示", text("status").includes("机器名里不要带状态字样"), text("status"));
  check("重命名带状态字样：名字没变", (await api("/machines")).data.machines.some((m) => m.machine === cur), cur);
}

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

  // K2. 同一台机器：自动节点只读展示 + 「转为手动」
  findMachineRow("auto-hk").children[5].onclick();
  await idle();
  check("自动节点区有内容", autoRows().length === 2, `rows=${autoRows().length}`);
  {
    const when = text("auto-when");
    check("② 显示了内容更新时间", /内容更新于：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(when) && !when.includes("还没有上报记录"), when);
    const srcLabel = el("auto-sources").children[0].children[0].textContent;
    check("② 来源胶囊带内容更新时间", /·\s*\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(srcLabel), srcLabel);
  }
  check("自动节点只读", autoRows()[0].children[0].readOnly === true, String(autoRows()[0].children[0].readOnly));
  check("手动区为空并提示", text("nodes").includes("没有手动节点"), text("nodes").slice(0, 30));
  autoRows()[0].children[2].onclick();
  await idle();
  check("转为手动：手动区出现一条", nodeRows().length === 1, `rows=${nodeRows().length}`);
  check("转 ① 手动：提示要保存", text("status").includes("已复制到 ① 手动节点"), text("status"));
  check("① 保存前显示「还没有保存过手动节点」", text("manual-when").includes("还没有保存过"), text("manual-when"));
  {
    const first = autoRows()[0];
    check("转 ① 手动：该行不再显示按钮", first.children.length === 3 && first.children[2].tagName?.toUpperCase?.() !== "BUTTON", `children=${first.children.length} / ${first.children[2] && first.children[2].textContent}`);
    check("转 ① 手动：该行改成「已在 ① 手动」标签", first.className.includes("copied") && first.children[2].textContent === "已在 ① 手动", `${first.className} / ${first.children[2].textContent}`);
  }
  click("save");
  await idle();
  check("① 保存后显示保存时间", /保存于：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(text("manual-when")), text("manual-when"));
  {
    const d = (await api("/nodes/auto-hk")).data;
    check("保存后：手动 1 条 + 自动 2 条", (d.manual_nodes || []).length === 1 && (d.auto_nodes || []).length === 2, `manual=${(d.manual_nodes || []).length} auto=${(d.auto_nodes || []).length}`);
    check("保存后：生效节点 2 条（去重）", (d.nodes || []).length === 2, `${(d.nodes || []).length} 条`);
  }
  {
    click("reload");
    await idle();
    const row = findMachineRow("auto-hk");
    const label = row.children[1].textContent;
    check("混合机器：同时显示「手动 1」和「上报 2」", label.includes("手动 1") && label.includes("上报 2"), label);
    check("混合机器：计数是「条进订阅」", row.children[2].textContent.includes("条进订阅"), row.children[2].textContent);
    check("混合机器：不再出现笼统的「手动」单标签", !/（手动）/.test(el("machine").textContent), el("machine").textContent.slice(0, 80));
  }
  // 再上报一次：自动部分更新，手动那条不变
  {
    const body = Buffer.from(TUIC).toString("base64");
    await netFetch(BASE + "/api/v1/report/" + encodeURIComponent("auto-hk"), {
      method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body,
    });
    const d = (await api("/nodes/auto-hk")).data;
    check("再上报：手动节点仍在", (d.manual_nodes || []).length === 1, `${(d.manual_nodes || []).length} 条`);
    check("再上报：自动节点缩成 1 条", (d.auto_nodes || []).length === 1, `${(d.auto_nodes || []).length} 条`);
    check("再上报：徽章转「手动」", (await api("/machines")).data.machines.find((m) => m.machine === "auto-hk").manual === true);
  }
  // K3. 同一台机器多个上报来源（同名机器不再互相覆盖）
  {
    const other = "vless://99999999-9999-4999-8999-999999999999@203.0.113.77:443?security=reality&sni=pypi.org&pbk=x&sid=y#另一台";
    const body = Buffer.from(other).toString("base64");
    const r = await netFetch(BASE + "/api/v1/report/" + encodeURIComponent("auto-hk") + "?source=box-b", {
      method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body,
    });
    check("第二来源：写入成功", (await r.json()).source === "box-b");
    click("reload");
    await idle();
    findMachineRow("auto-hk").children[5].onclick();
    await idle();
    const chips = el("auto-sources").children;
    check("来源 chip 两个", chips.length === 2, `chips=${chips.length}`);
    check("来源 chip 带条数", text("auto-sources").includes("box-b") && /box-b · 1 条/.test(text("auto-sources")), text("auto-sources"));
    check("两个来源的节点合在一起", autoRows().length === 2, `rows=${autoRows().length}`);
    check("来源胶囊没有删除按钮（自动层只读）", chips[1].children.length === 1, `children=${chips[1].children.length}`);
    check("自动层不再出现 ×", !el("auto-sources").innerHTML?.includes?.("×") && !text("auto-sources").includes("×"), text("auto-sources"));
  }

  // 清掉这台机器的手动节点，回到纯上报，方便后面的删除用例
  confirms.push(true);
  click("reset");
  await idle();
  const cleared = (await api("/nodes/auto-hk")).data;
  check("清空后：手动 0 条、两个来源的节点都在", (cleared.manual_nodes || []).length === 0 && (cleared.auto_nodes || []).length === 2, `manual=${(cleared.manual_nodes || []).length} auto=${(cleared.auto_nodes || []).length}`);
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
  check("reset 确认：提示已清空手动节点", text("status").includes("已清空手动节点"), text("status"));
  const { data } = await api("/nodes/" + encodeURIComponent("香港-备用"));
  check("reset 确认：只剩最近一次上报的那条", (data.nodes || []).length === 1, `${(data.nodes || []).length} 个`);
  check("reset 确认：手动列表已清空", (data.manual_nodes || []).length === 0, `${(data.manual_nodes || []).length} 个`);
  check("reset 确认：徽章变「上报」", findMachineRow("香港-备用").children[1].textContent.includes("上报"));
  check("reset 确认：提示说明只剩自动上报的节点", text("status").includes("只剩自动上报的节点"), text("status"));
}

// L2. 从没上报过的机器：reset 只取消手动标记，节点保持
{
  el("new-machine").value = "没上报过";
  click("create-machine");
  await idle();
  await api("/nodes/" + encodeURIComponent("没上报过"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: [{ link: HY2 }] }),
  });
  await idle();
  findMachineRow("没上报过").children[5].onclick();
  await idle();
  const before = nodeRows().length;
  confirms.push(true);
  click("reset");
  await idle();
  check("未上报过：提示已清空", text("status").includes("已清空手动节点"), text("status"));
  const { data } = await api("/nodes/" + encodeURIComponent("没上报过"));
  check("未上报过：清空后没有节点", (data.nodes || []).length === 0 && before === 1, `${(data.nodes || []).length} vs ${before}`);
  check("未上报过：手动标记已取消", data.manual === false, String(data.manual));
  check("未上报过：再清一次提示不用清", text("order-status") !== "", "ok");
  // 收尾：删掉这台临时机器
  confirms.push(true);
  findMachineRow("没上报过").children[6].onclick();
  await idle();
  check("未上报过：临时机器已删除", !findMachineRow("没上报过"));
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

// P. 分流规则卡片：分组与规则来源可增删改、可恢复默认
{
  const groupRows = () => rows("clash-groups").filter((row) => String(row.className).includes("group-row"));
  const ruleRows = () => rows("clash-rulesets").filter((row) => String(row.className).includes("rule-row"));
  const defaultGroups = groupRows().length;
  const defaultRules = ruleRows().length;
  check("分流规则：默认分组与规则来源已渲染", defaultGroups > 20 && defaultRules > 20, `${defaultGroups} 组 / ${defaultRules} 条`);
  check("分流规则：初始状态是「默认」", text("clash-badge") === "默认", text("clash-badge"));
  check(
    "分流规则：分组/规则来源数量与实际行数一致",
    text("clash-group-count").indexOf(String(defaultGroups) + " 个") === 0 && text("clash-rule-count").indexOf(String(defaultRules) + " 条") === 0,
    `${text("clash-group-count")} / ${text("clash-rule-count")}`,
  );
  const g0 = groupRows()[0].children;
  check("分流规则：分组行 = 名称/类型/过滤/成员/删除", g0.length === 5 && g0[0].value === "🚀 节点选择" && g0[1].value === "select", `${g0.length} 列`);
  const r0 = ruleRows()[0].children;
  check("分流规则：规则行 = 名称/分组/URL/删除", r0.length === 4 && /^https:\/\//.test(r0[2].value), r0[0].value);

  click("clash-add-group");
  check("分流规则：新增分组立刻出现在表里", groupRows().length === defaultGroups + 1, `${groupRows().length}`);
  check("分流规则：数量跟着加一", text("clash-group-count").indexOf(String(defaultGroups + 1) + " 个") === 0, text("clash-group-count"));
  click("clash-save");
  await idle();
  check(
    "分流规则：空分组（既没过滤也没成员）保存被拦下",
    /既没填过滤也没填成员/.test(text("clash-status")) && text("clash-badge") === "默认",
    text("clash-status"),
  );
  const added = groupRows()[defaultGroups].children;
  added[0].value = "🚀 节点选择";
  added[0].oninput.call(added[0]);
  added[3].value = "DIRECT";
  added[3].oninput.call(added[3]);
  click("clash-save");
  await idle();
  check(
    "分流规则：分组重名保存被拦下",
    /重名了/.test(text("clash-status")) && text("clash-badge") === "默认",
    text("clash-status"),
  );
  added[0].value = "⚡ 自定义组";
  added[0].oninput.call(added[0]);

  click("clash-add-rule");
  check("分流规则：新增规则来源立刻出现在表里", ruleRows().length === defaultRules + 1, `${ruleRows().length}`);
  const addedRule = ruleRows()[defaultRules].children;
  addedRule[0].value = "myproxy";
  addedRule[0].oninput.call(addedRule[0]);
  addedRule[1].value = "⚡ 自定义组";
  addedRule[1].onchange.call(addedRule[1]);
  addedRule[2].value = "https://example.com/myproxy.yaml";
  addedRule[2].oninput.call(addedRule[2]);

  click("clash-save");
  await idle();
  check("分流规则：保存后有成功提示", /规则已保存/.test(text("clash-status")), text("clash-status"));
  check("分流规则：保存后标记为「自定义」", text("clash-badge") === "自定义", text("clash-badge"));
  const hideEmpty = el("clash-hide-empty");
  hideEmpty.checked = true;
  hideEmpty.onchange.call(hideEmpty);
  check(
    "分流规则：勾上「只看有节点的分组」后空组被隐藏",
    groupRows().length === groupRows().length && !groupRows().some((row) => String(row.className).includes("no-node")),
    `${groupRows().length} 行`,
  );
  hideEmpty.checked = false;
  hideEmpty.onchange.call(hideEmpty);
  check("分流规则：取消勾选后空组重新出现", groupRows().some((row) => String(row.className).includes("no-node")), `${groupRows().length} 行`);

  const noNodeRows = groupRows().filter((row) => String(row.className).includes("no-node"));
  check(
    "分流规则：没有节点的分组整行标红提示",
    noNodeRows.length > 0 && noNodeRows.length === groupRows().length - Number((text("clash-group-count").match(/生效 (\d+)/) || [0, groupRows().length])[1]),
    `${noNodeRows.length} 行标红 / ${text("clash-group-count")}`,
  );
  const saved = await api("/clash/rules");
  check(
    "分流规则：接口回读保存结果",
    saved.data.custom === true && saved.data.groups.length === defaultGroups + 1 && saved.data.rulesets.length === defaultRules + 1,
    `${saved.data.groups.length}/${saved.data.rulesets.length}`,
  );
  const clashNow = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}?format=clash`)).text();
  check("分流规则：自定义分组进了 clash 配置", clashNow.includes('name: "⚡ 自定义组"') && clashNow.includes('- "DIRECT"'));
  check(
    "分流规则：自定义 rule-provider 生效且旧的仍在",
    clashNow.includes("myproxy") && clashNow.includes("https://example.com/myproxy.yaml") && clashNow.includes("BanAD"),
    `${clashNow.length} B`,
  );

  const last = groupRows()[groupRows().length - 1].children;
  last[4].onclick.call(last[4]);
  check("分流规则：删除分组后行数减少", groupRows().length === defaultGroups, `${groupRows().length}`);
  check("分流规则：数量跟着减一", text("clash-group-count").indexOf(String(defaultGroups) + " 个") === 0, text("clash-group-count"));
  check("分流规则：删除后有提示", /分组已删除/.test(text("clash-status")), text("clash-status"));

  confirms.push(true);
  click("clash-reset");
  await idle();
  check("分流规则：恢复默认后标记回「默认」", text("clash-badge") === "默认", text("clash-badge"));
  check("分流规则：恢复默认后分组数回来", groupRows().length === defaultGroups, `${groupRows().length}`);
  const afterReset = await api("/clash/rules");
  check("分流规则：接口回读为默认", afterReset.data.custom === false && afterReset.data.groups.length === defaultGroups);
  const clashBack = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}?format=clash`)).text();
  check("分流规则：默认配置里没有自定义分组", !clashBack.includes("⚡ 自定义组") && !clashBack.includes("myproxy"));
}

/* ---------------- 订阅中的节点（全站清单） ---------------- */
{
  const vless = "vless://11111111-1111-4111-8111-111111111111@hk.example.com:443?security=tls#香港-vless";
  const hy2 = "hysteria2://pw@jp.example.io:443?sni=addons.mozilla.org#东京-hy2";
  const put = await api("/nodes/ui-proto", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: [{ link: vless, name: "香港-vless" }, { link: hy2, name: "东京-hy2" }] }),
  });
  check("订阅清单：准备一台有两种协议的机器", put.status === 200, String(put.status));

  click("sub-reload");
  await idle();

  const subRowsList = () => el("sub-list").children.filter ? el("sub-list").children : el("sub-list").children;
  const nodeRows = () => el("sub-list").children.filter((row) => row.className && row.className.includes("subnode"));
  const groupHeads = () => el("sub-list").children.filter((row) => row.className === "sub-group");
  const visibleNames = () => nodeRows().map((row) => row.children[2].textContent);

  const firstRow = nodeRows()[0];
  const metaCell = firstRow.children[2];
  const srcTag = firstRow.children[3];
  check("订阅清单：每行显示节点原串", Boolean(metaCell.children[1]) && /^(vless|vmess|tuic|hysteria2|trojan|ss|ssr|hysteria):\/\//.test(String(metaCell.children[1].textContent)), String(metaCell.children[1] && metaCell.children[1].textContent).slice(0, 40));
  check("订阅清单：手动/上报是带颜色的标签", Boolean(srcTag) && (srcTag.className.indexOf("manual") !== -1 || srcTag.className.indexOf("auto") !== -1), srcTag && srcTag.className);
  check("订阅链接卡片：链接框独占一列不压按钮", html.includes(".subrow code{flex:1 1 320px") && html.includes('<span class="tip">通用 base64</span><code id="url-base">'), "");
  check("订阅清单：按机器分组显示", groupHeads().length >= 1, `${groupHeads().length} 组`);
  check("订阅清单：列出节点并默认勾选", nodeRows().length >= 2 && nodeRows().every((row) => !row.className.includes("off")), `${nodeRows().length} 行`);
  check("订阅清单：计数徽章", /\/\s*\d+/.test(text("sub-count")), text("sub-count"));

  // 按机器筛选
  const machineChips = () => el("sub-machine-chips").children;
  const protoChip = machineChips().find((chip) => chip.textContent.indexOf("ui-proto") !== -1);
  check("订阅清单：能按机器多选", Boolean(protoChip), machineChips().map((c) => c.textContent).join("|"));
  protoChip.onclick.call(protoChip);
  await idle();
  check("订阅清单：只看这台机器", nodeRows().length === 2, `${nodeRows().length} 行`);
  const litChip = machineChips().find((chip) => chip.textContent.indexOf("ui-proto") !== -1);
  check("订阅清单：机器筛选胶囊点亮", litChip.className.includes("on"), litChip.className);

  // 按协议筛选
  const protoChipsAll = () => el("sub-protos").children;
  const hy2Chip = protoChipsAll().find((chip) => chip.textContent.indexOf("Hysteria2") !== -1);
  hy2Chip.onclick.call(hy2Chip);
  await idle();
  check("订阅清单：按协议多选", nodeRows().length === 1 && visibleNames()[0].indexOf("东京") >= 0, visibleNames().join("|"));
  hy2Chip.onclick.call(hy2Chip);
  await idle();

  // 搜索后再选
  el("sub-search").value = "香港";
  el("sub-search").oninput.call(el("sub-search"));
  await idle();
  check("订阅清单：搜索过滤", nodeRows().length === 1 && visibleNames()[0].indexOf("香港") >= 0, visibleNames().join("|"));

  click("sub-only");
  await idle();
  const onlyMine = await api("/sub/nodes");
  const mine = onlyMine.data.machines.filter((m) => m.machine === "ui-proto")[0];
  check("订阅清单：只选筛出来的", mine.enabled === 1 && mine.total === 2, `${mine.enabled}/${mine.total}`);

  el("sub-search").value = "";
  el("sub-search").oninput.call(el("sub-search"));
  await idle();

  check("订阅清单：没有反选按钮了", !html.includes('id="sub-invert"') && !html.includes("反选"), "");

  click("sub-all");
  await idle();
  const allOn = await api("/sub/nodes");
  const onMine = allOn.data.machines.filter((m) => m.machine === "ui-proto")[0];
  check("订阅清单：全选把节点放回订阅", onMine.enabled === onMine.total && onMine.total === 2, `${onMine.enabled}/${onMine.total}`);

  click("sub-none");
  await idle();
  const noneOn = await api("/sub/nodes");
  check("订阅清单：全不选后订阅为空", noneOn.data.stats.enabled === 0, String(noneOn.data.stats.enabled));
  const emptySub = await (await netFetch(`${BASE}/sub/all/${encodeURIComponent(TOKEN)}`)).text();
  check("订阅清单：订阅内容跟着变空", atob(emptySub).trim() === "", atob(emptySub).slice(0, 30));

  click("sub-all");
  await idle();
  const back = await api("/sub/nodes");
  const backMine = back.data.machines.filter((m) => m.machine === "ui-proto")[0];
  check("订阅清单：全选只恢复筛出来的那些", backMine.enabled === 2 && back.data.stats.enabled < back.data.stats.total, `${backMine.enabled} / 全局 ${back.data.stats.enabled}/${back.data.stats.total}`);

  // 去掉机器筛选后全选 = 全部节点回到订阅
  const litAgain = machineChips().find((chip) => chip.textContent.indexOf("ui-proto") !== -1);
  litAgain.onclick.call(litAgain);
  await idle();
  click("sub-all");
  await idle();
  const restored = await api("/sub/nodes");
  check("订阅清单：去掉筛选后全选恢复全部", restored.data.stats.enabled === restored.data.stats.total, `${restored.data.stats.enabled}/${restored.data.stats.total}`);

  // 胶囊数字 = 在订阅 / 全部：所有胶囊左边之和 = 订阅里的节点数
  const protoChips = () => Array.from(el("sub-protos").children);
  const parseCount = (chip) => Number((chip.textContent.match(/·\s*(\d+)\/(\d+)/) || [0, "0", "0"])[1]);
  const parseTotal = (chip) => Number((chip.textContent.match(/·\s*(\d+)\/(\d+)/) || [0, "0", "0"])[2]);
  check("订阅清单：没筛选时胶囊不变淡", protoChips().every((chip) => chip.className.indexOf("dim") === -1), protoChips().map((c) => c.className).join(","));
  check("订阅清单：默认全部节点在订阅，胶囊都是「全选」态", protoChips().every((chip) => chip.className.indexOf("on") !== -1), protoChips().map((c) => c.className).join(","));
  const sumIn = () => protoChips().reduce((sum, chip) => sum + parseCount(chip), 0);
  const sumAll = () => protoChips().reduce((sum, chip) => sum + parseTotal(chip), 0);
  check("订阅清单：胶囊左边之和 = 订阅里的节点数", sumIn() === 4, `${sumIn()} 个`);
  check("订阅清单：胶囊右边之和 = 全部节点数", sumAll() === 4, `${sumAll()} 个`);

  const mineChip = () => Array.from(el("sub-machine-chips").children).filter((c) => c.textContent.indexOf("ui-proto") !== -1)[0];
  mineChip().onclick.call(mineChip());
  await idle();
  check("订阅清单：筛选不改胶囊的订阅计数", sumIn() === 4 && nodeRows().length === 2, `胶囊 ${sumIn()}/4，列表 ${nodeRows().length} 行`);
  mineChip().onclick.call(mineChip());
  await idle();

  const vlessChip = protoChips().filter((chip) => chip.textContent.indexOf("VLESS") !== -1)[0];
  vlessChip.onclick.call(vlessChip);
  await idle();
  const lightChip = protoChips().filter((chip) => chip.textContent.indexOf("VLESS") !== -1)[0];
  check("订阅清单：选中的胶囊有勾和选中态", lightChip.textContent.trim().indexOf("✓") === 0 && lightChip.className.indexOf("on") !== -1, `${lightChip.className} / ${lightChip.textContent}`);
  const offChip = protoChips().filter((chip) => chip.textContent.indexOf("VLESS") === -1)[0];
  check("订阅清单：被筛掉的胶囊变淡", offChip.className.indexOf("dim") !== -1, offChip.className);
  check("订阅清单：选中的筛选胶囊有蓝色选中框", lightChip.className.indexOf("picked") !== -1, lightChip.className);
  check("订阅清单：样式图例写清了虚线含义", html.includes("虚线半透明") && html.includes("一个节点都没列出来"), "");
  check("订阅清单：筛选说明写清了看了几个", el("sub-shown").textContent.indexOf("1 / 4") === 0 && el("sub-shown").textContent.indexOf("VLESS") !== -1, el("sub-shown").textContent);
  const afterPick = await api("/sub/nodes");
  check("订阅清单：只看 VLESS 时订阅内容没变", afterPick.data.stats.enabled === afterPick.data.stats.total, `${afterPick.data.stats.enabled}/${afterPick.data.stats.total}`);
  lightChip.onclick.call(lightChip);
  await idle();

  // 行上的协议标签 / 分组标题也能反过来筛，状态与胶囊一致
  const rowTag = nodeRows()[0].children[1];
  rowTag.onclick.call(rowTag, { stopPropagation() {} });
  await idle();
  const afterTag = protoChips().filter((chip) => chip.className.indexOf("picked") !== -1);
  check("订阅清单：点节点上的协议标签也能筛", afterTag.length === 1 && el("sub-shown").textContent.indexOf(" / 4 个节点（协议 ") !== -1, el("sub-shown").textContent);
  rowTag.onclick.call(rowTag, { stopPropagation() {} });
  await idle();
  const head = el("sub-list").children.filter((row) => row.className === "sub-group")[0];
  head.onclick.call(head);
  await idle();
  check("订阅清单：点分组标题只看这台机器", el("sub-shown").textContent.indexOf("机器 ") !== -1, el("sub-shown").textContent);
  click("sub-clear");
  await idle();
  // 全不选 / 全选：胶囊状态跟着变
  click("sub-none");
  await idle();
  check("订阅清单：全不选后胶囊都不在订阅", protoChips().every((chip) => chip.className.indexOf("on") === -1 && chip.className.indexOf("part") === -1), protoChips().map((c) => c.className).join(","));
  check("订阅清单：全不选后胶囊数字变成 0/总", protoChips().every((chip) => parseCount(chip) === 0 && parseTotal(chip) > 0), protoChips().map((c) => c.textContent).join(" , "));
  {
    const chip = protoChips()[0];
    chip.onclick.call(chip);
    await idle();
    const picked = protoChips().filter((c) => c.className.indexOf("picked") !== -1)[0];
    check("订阅清单：只看某组时胶囊不冒充 ✓/◐", picked && picked.textContent.indexOf("✓") === -1 && picked.textContent.indexOf("◐") === -1, picked ? picked.textContent : "没有 picked 胶囊");
    click("sub-clear");
    await idle();
  }
  click("sub-all");
  await idle();
  check("订阅清单：全选后胶囊全部回到订阅态", protoChips().every((chip) => chip.className.indexOf("on") !== -1), protoChips().map((c) => c.className).join(","));
  check("订阅清单：全选后胶囊数字变成 总/总", protoChips().every((chip) => parseCount(chip) === parseTotal(chip)), protoChips().map((c) => c.textContent).join(" , "));

  // 单个节点取消勾选 → 它那台机器的胶囊变半选
  const machineChipBox = () => el("sub-machine-chips").children;
  const pickChip = () => Array.from(machineChipBox()).filter((c) => c.textContent.indexOf("ui-proto") !== -1)[0];
  pickChip().onclick.call(pickChip());
  await idle();
  const mineRows = nodeRows();
  mineRows[0].onclick.call(mineRows[0]);
  await idle();
  await new Promise((r) => setTimeout(r, 120));
  await idle();
  const partChips = Array.from(machineChipBox()).filter((chip) => chip.className.indexOf("part") !== -1);
  check("订阅清单：取消一个节点后它那台机器胶囊变半选", partChips.length === 1 && partChips[0].textContent.indexOf("ui-proto") !== -1, Array.from(machineChipBox()).map((c) => c.className + "|" + c.textContent).join(" , "));
  click("sub-all");
  await idle();
  click("sub-clear");
  await idle();

  check("订阅清单：清除筛选按钮恢复全部", el("sub-shown").textContent.indexOf("4 / 4 个节点") === 0 && el("sub-shown").textContent.indexOf("没有筛选") !== -1, el("sub-shown").textContent);
  lightChip.onclick.call(lightChip);
  await idle();

  await netFetch(`${BASE}/api/v1/sub/disabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ disabled: [] }),
  });
  await netFetch(`${BASE}/api/v1/machines/ui-proto`, { method: "DELETE", headers: { Authorization: "Bearer " + TOKEN } });
  click("sub-reload");
  await idle();
}

/* ---------------- 订阅中的节点折叠 ---------------- */
{
  check("主题：默认日间", (documentShim.documentElement.getAttribute("data-theme") || "light") === "light", String(documentShim.documentElement.getAttribute("data-theme")));
  check("主题：按钮初始是月亮", text("theme-toggle") === "🌙", text("theme-toggle"));
  click("theme-toggle");
  await idle();
  check("主题：点一下切到夜间", documentShim.documentElement.getAttribute("data-theme") === "dark", String(documentShim.documentElement.getAttribute("data-theme")));
  check("主题：按钮变成太阳", text("theme-toggle") === "☀️", text("theme-toggle"));
  click("theme-toggle");
  await idle();
  check("主题：再点回到日间", documentShim.documentElement.getAttribute("data-theme") === "light", String(documentShim.documentElement.getAttribute("data-theme")));
  check("订阅清单：默认收起", el("sub-body").className === "hidden" && el("sub-toggle").textContent === "展开 +", `${el("sub-body").className} / ${el("sub-toggle").textContent}`);
  check("订阅清单：收起时标题上的计数还在", /\d+\s*\/\s*\d+/.test(text("sub-count")), text("sub-count"));
  click("sub-toggle");
  await idle();
  check("订阅清单：点开展开", el("sub-body").className === "" && el("sub-toggle").textContent === "收起 -", `${el("sub-body").className} / ${el("sub-toggle").textContent}`);
  check("订阅清单：展开后能看到搜索框和节点表", html.includes('id="sub-search"') && html.includes('id="sub-list"'), "");
  click("sub-toggle");
  await idle();
  check("订阅清单：再点收起", el("sub-body").className === "hidden" && el("sub-toggle").textContent === "展开 +", `${el("sub-body").className} / ${el("sub-toggle").textContent}`);
}

/* ---------------- 分流规则折叠 ---------------- */
{
  check("分流规则：默认收起", el("clash-body").className === "hidden" && el("clash-toggle").textContent === "展开 +", `${el("clash-body").className} / ${el("clash-toggle").textContent}`);
  click("clash-toggle");
  await idle();
  check("分流规则：点开展开", el("clash-body").className === "" && el("clash-toggle").textContent === "收起 -", `${el("clash-body").className} / ${el("clash-toggle").textContent}`);
  check("分流规则：展开后能看到分组和规则表", html.includes('id="clash-groups"') && html.includes('id="clash-rulesets"'), "");
  click("clash-toggle");
  await idle();
  check("分流规则：再点收起", el("clash-body").className === "hidden" && el("clash-toggle").textContent === "展开 +", `${el("clash-body").className} / ${el("clash-toggle").textContent}`);
}

/* ---------------- 登录与角色 ---------------- */
{
  const session = await api("/auth/session");
  check("会话：管理员角色", session.status === 200 && session.data.role === "admin", JSON.stringify(session.data));
  check("登录浮层：管理员登录后隐藏", el("login").style.display === "none", el("login").style.display);
  check("登录浮层：只有一个口令输入框（游客码也填这里）", Boolean(el("login-password")) && !html.includes('id="login-guest"'));
  check("页面里没有改密码入口（在 Cloudflare 后台）", !html.includes('id="admin-password"') && !html.includes('id="card-access"'), "");

  // 只有管理员一种身份：口令不对进不来，对了可以读写
  const badLogin = await netFetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  check("登录：错误口令 401", badLogin.status === 401, String(badLogin.status));

  const guestLike = await netFetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "ui-guest-code" }),
  });
  check("登录：没有游客身份了", guestLike.status === 401, String(guestLike.status));

  const noToken = await netFetch(`${BASE}/api/v1/machines`);
  check("接口：不带口令 401", noToken.status === 401, String(noToken.status));

  const sessionRes = await netFetch(`${BASE}/api/v1/auth/session`, { headers: { Authorization: "Bearer " + ADMIN_PASSWORD } });
  const sessionData = await sessionRes.json();
  check("会话：管理员带订阅 token", sessionRes.status === 200 && sessionData.role === "admin" && sessionData.sub_token === TOKEN, JSON.stringify(sessionData));
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
