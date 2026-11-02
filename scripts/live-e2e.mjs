
import { spawn } from "node:child_process";
import fs from "node:fs";
// 跑之前先起服务，并给出账号：
//   BASE_URL=http://127.0.0.1:8788 ADMIN_PASSWORD=xxx SUB_TOKEN=yyy [REPORT_TOKEN=zzz] node scripts/live-e2e.mjs
const B = process.env.BASE_URL || "http://127.0.0.1:8788";
const PW = process.env.ADMIN_PASSWORD || process.env.PW || "";
const TOKEN = process.env.SUB_TOKEN || "";
const RTOKEN = process.env.REPORT_TOKEN || TOKEN;
if (!PW || !TOKEN) {
  console.error("缺少环境变量：ADMIN_PASSWORD 与 SUB_TOKEN 必填（REPORT_TOKEN 可选，默认同 SUB_TOKEN）");
  process.exit(1);
}
const LINKS = [
  "hysteria2://11111111-2222-3333-4444-555555555555@203.0.113.10:31004?security=tls&alpn=h3&insecure=1&allowInsecure=1&sni=www.microsoft.com#测试-美国北卡莱罗纳-hy2-T1",
  "tuic://11111111-2222-3333-4444-555555555555:11111111-2222-3333-4444-555555555555@203.0.113.10:31005?sni=www.microsoft.com&congestion_control=bbr&security=tls&udp_relay_mode=native&alpn=h3&allow_insecure=1#测试-美国北卡莱罗纳-tuic-T1",
  "vless://11111111-2222-3333-4444-555555555555@203.0.113.10:31003?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=169a2c42&type=tcp&headerType=none#测试-美国北卡莱罗纳-vless-reality-T1",
  "trojan://11111111-2222-3333-4444-555555555555@cdn.example.com:8443?security=tls&type=ws&host=node.example.com&path=%2F11111111-2222-3333-4444-555555555555-tr&sni=node.example.com&fp=chrome#测试-美国北卡莱罗纳-trojan-ws-tls-argo-T1-8443",
];
const LINKS_B = [
  "hysteria2://11111111-2222-3333-4444-555555555555@203.0.113.10:31014?security=tls&alpn=h3&insecure=1&sni=www.microsoft.com#测试-手动机器-手hy2-T1",
  "trojan://11111111-2222-3333-4444-555555555555@cdn.example.com:8444?security=tls&type=ws&host=node.example.com&path=%2F11111111-2222-3333-4444-555555555555-tr2&sni=node.example.com&fp=chrome#测试-手动机器-手trojan-argo-T1",
];
const MA = "测试-美国北卡莱罗纳";
const MB = "测试-手动机器";
const MB2 = MB + "-改名";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const results = [];
let current = "启动";
const check = (name, ok, detail) => { results.push({ step: current, name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : " | " + String(detail === undefined ? "" : detail).slice(0,120))); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n) => { current = n; console.log("--->", n); };

const port = 9500 + Math.floor(Math.random() * 60);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars","--proxy-server=http://127.0.0.1:10808","--remote-debugging-port="+port,"--user-data-dir=/tmp/cdp-e2e-"+port,"--window-size=1440,1200","about:blank"], { stdio: "ignore" });
for (let i = 0; i < 60; i++) { try { await (await fetch("http://127.0.0.1:"+port+"/json/version")).json(); break; } catch { await wait(250); } }
const ws = new WebSocket((await (await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((res, rej) => { const i = ++id; const timer = setTimeout(() => { pend.delete(i); rej(new Error("cdp timeout: " + method)); }, 30000); pend.set(i, (m) => { clearTimeout(timer); res(m); }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.confirm=function(){return true};window.alert=function(){};" });
async function ev(body) {
  const r = await send("Runtime.evaluate", { expression: "(async () => { " + body + " })()", awaitPromise: true, returnByValue: true });
  const ex = r.result && r.result.exceptionDetails;
  if (ex) throw new Error("page ex: " + JSON.stringify((ex.exception && ex.exception.description) || ex).slice(0, 260));
  return r.result.result.value;
}
async function shot(f) { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); fs.writeFileSync(f, Buffer.from(r.result.data, "base64")); }
const HELPERS = `
window.__t = {
  q: (x) => document.getElementById(x),
  btn: (t, root) => [].slice.call((root || document).querySelectorAll("button")).filter((b) => b.textContent.trim() === t)[0],
  rows: (id, cls) => [].slice.call(document.getElementById(id).children).filter((c) => !cls || String(c.className).indexOf(cls) >= 0),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  type: (id, v) => { const el = document.getElementById(id); el.value = v; if (el.oninput) el.oninput.call(el); if (el.onchange) el.onchange.call(el); },
  sel: (id, v) => { const el = document.getElementById(id); el.value = v; if (el.onchange) el.onchange.call(el); return el.value; },
  api: async (p, opt) => { const r = await fetch(p, Object.assign({ headers: { authorization: "Bearer ${TOKEN}" } }, opt || {})); let d = null; try { d = await r.json(); } catch (e) {} return { status: r.status, d: d }; },
  sub: async (u) => { const r = await fetch(u, { headers: { "user-agent": "clash-verge/1.0" } }); return { status: r.status, text: await r.text() }; },
  until: async (fn, ms) => { const end = Date.now() + (ms || 9000); while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, 250)); } return false; },
  stable: async (ms) => { const end = Date.now() + (ms || 9000); let last = "", same = 0; while (Date.now() < end) { const fp = document.getElementById("nodes").children.length + "|" + document.getElementById("machine").value + "|" + document.getElementById("sub-count").textContent; if (fp === last) { same++; if (same >= 3) return true; } else { same = 0; last = fp; } await new Promise((r) => setTimeout(r, 250)); } return false; },
};
`;
await send("Page.navigate", { url: B + "/ui" }); await wait(2600); await ev(HELPERS);

// 1 登录
step("登录与会话");
try {
  check("未登录只显示登录卡片", await ev('return !!document.getElementById("login") && document.body.className.indexOf("locked") >= 0;'));
  await ev('__t.q("login-password").value = "wrong-pass"; __t.q("login-submit").click(); return 1;');
  await wait(1800);
  const ls = await ev('return document.getElementById("login-status").textContent;');
  check("错误口令给出提示且不进入", ls.length > 0 && (await ev('return document.body.className.indexOf("locked") >= 0;')), ls);
  await ev('__t.q("login-password").value = ' + JSON.stringify(PW) + '; __t.q("login-submit").click(); return 1;');
  await wait(4500);
  check("正确口令进入界面", await ev('return document.body.className.indexOf("locked") < 0;'));
  check("顶栏显示版本号", await ev('var v = document.getElementById("version"); return !!v && v.textContent.indexOf("v1.") === 0;'), await ev('var v = document.getElementById("version"); return v ? v.textContent : "无";'));
  check("界面显示管理员身份", await ev('return document.getElementById("role-badge").textContent.length > 0;'), await ev('return document.getElementById("role-badge").textContent;'));
} catch (e) { check("登录流程未抛错", false, e.message); }

// 2 主题
step("深浅主题");
try {
  const before = await ev('return document.documentElement.getAttribute("data-theme") || "light";');
  await ev('document.getElementById("theme-toggle").click(); return 1;'); await wait(600);
  const after = await ev('return document.documentElement.getAttribute("data-theme") || "light";');
  check("主题按钮切换深浅", before !== after, before + " -> " + after);
  await send("Page.navigate", { url: B + "/ui" }); await wait(3000); await ev(HELPERS);
  check("刷新后主题被记住", (await ev('return document.documentElement.getAttribute("data-theme") || "light";')) === after);
  await ev('document.getElementById("theme-toggle").click(); return 1;'); await wait(400);
} catch (e) { check("主题流程未抛错", false, e.message); }

// 3 上报
step("自动上报");
try {
  const r = await ev('const r = await fetch("/api/v1/report/" + encodeURIComponent(' + JSON.stringify(MA) + ') + "?source=default", { method: "POST", headers: { authorization: "Bearer ' + RTOKEN + '" }, body: ' + JSON.stringify(b64(LINKS.join("\n"))) + ' }); return { s: r.status, t: await r.text() };');
  check("上报接口 200 并返回 4 条", r.s === 200 && r.t.indexOf('"nodes":4') >= 0, String(r.t).slice(0, 140));
  await ev('__t.q("reload").click(); await __t.until(function () { return __t.rows("machine-list","machine").length > 0; }, 9000); await __t.sel("machine", ' + JSON.stringify(MA) + '); await __t.stable(9000); return 1;');
  check("机器列表出现上报的机器", await ev('return __t.rows("machine-list","machine").some(function (x) { return x.textContent.indexOf(' + JSON.stringify(MA) + ') >= 0; });'));
  check("自动层显示 4 条节点", await ev('return __t.until(function () { return document.getElementById("auto-count").textContent.indexOf("4") === 0; }, 12000);'), await ev('return document.getElementById("auto-count").textContent;'));
  check("自动层显示内容更新时间", (await ev('return document.getElementById("auto-when").textContent;')).indexOf("内容更新于") >= 0, await ev('return document.getElementById("auto-when").textContent;'));
  check("自动层列出 4 条只读节点", (await ev('return __t.rows("auto-nodes","auto-row").length || document.querySelectorAll("#auto-nodes .auto-row").length;')) === 4, String(await ev('return document.querySelectorAll("#auto-nodes .auto-row").length;')));
  check("订阅接口统计到 4 条节点", (await ev('var r = await __t.api("/api/v1/sub/nodes"); return r.d.stats.total;')) === 4, "stats.total");
} catch (e) { check("上报流程未抛错", false, e.message); }

// 4 新建机器 + 手动节点
step("机器管理与手动节点");
try {
  await ev('__t.type("new-machine", ' + JSON.stringify(MB) + '); __t.q("create-machine").click(); return 1;');
  check("新建空机器成功", await ev('return __t.until(function () { return __t.rows("machine-list","machine").some(function (x) { return x.textContent.indexOf(' + JSON.stringify(MB) + ') >= 0; }); }, 9000);'));
  await ev('await __t.until(function () { return [].slice.call(document.getElementById("machine").options).some(function (o) { return o.value === ' + JSON.stringify(MB) + '; }); }, 12000); var sel = __t.q("machine"); sel.value = ' + JSON.stringify(MB) + '; if (sel.onchange) sel.onchange.call(sel); await __t.sleep(3200); return 1;');
  check("切到新机器：手动层为空", (await ev('return __t.rows("nodes","node").length;')) === 0, String(await ev('return __t.rows("nodes","node").length;')));
  await ev('var b = __t.q("bulk"); b.value = ' + JSON.stringify(LINKS_B.join("\n")) + '; if (b.oninput) b.oninput.call(b); __t.q("bulk-add").click(); return 1;');
  check("批量粘贴解析出 2 条", await ev('return __t.until(function () { return __t.rows("nodes","node").length === 2; }, 6000);'), String(await ev('return __t.rows("nodes","node").length;')));
  check("提示「已添加 2 个节点」", (await ev('return document.getElementById("bulk-status").textContent;')).indexOf("2") >= 0, await ev('return document.getElementById("bulk-status").textContent;'));
  check("出现未保存徽章", await ev('return document.getElementById("dirty-badge").style.display !== "none";'), await ev('return document.getElementById("dirty-badge").textContent;'));
  check("节点行把两条链接都放进了输入框", await ev('return __t.rows("nodes","node").every(function (r) { return r.children[1].value.indexOf("://") > 0; }) && __t.rows("nodes","node").length === 2;'), String(await ev('return __t.rows("nodes","node").length;')));
  await ev('__t.q("save").click(); return 1;');
  check("保存配置成功", await ev('return __t.until(function () { return document.getElementById("status").textContent.indexOf("已保存") >= 0; }, 8000);'), await ev('return document.getElementById("status").textContent;'));
  await ev('await __t.stable(6000); return 1;');
  check("手动节点计数 2", await ev('return __t.until(function () { return document.getElementById("manual-count").textContent.indexOf("2") === 0; }, 12000);'), await ev('var m = await __t.api("/api/v1/machines"); return document.getElementById("manual-count").textContent + " | api " + JSON.stringify(m.d.machines.map(function (x) { return [x.machine.slice(0,6), x.manual_nodes, x.auto_nodes]; }));'));
  check("机器行出现「手动」徽章", await ev('var r = __t.rows("machine-list","machine").filter(function (x) { return x.textContent.indexOf(' + JSON.stringify(MB) + ') >= 0; })[0]; return !!r && r.textContent.indexOf("手动") >= 0;'));
  check("订阅总数变成 6 条", await ev('return __t.until(function () { return document.getElementById("sub-count").textContent.indexOf("6") === 0; }, 12000);'), await ev('return document.getElementById("sub-count").textContent;'));
} catch (e) { check("机器管理流程未抛错", false, e.message); }

// 5 节点行编辑
step("节点行编辑");
try {
  await ev('await __t.until(function () { return __t.rows("nodes","node").length === 2; }, 10000); return 1;');
  const before = await ev('return __t.rows("nodes","node").map(function (r) { return r.children[1].value.slice(0, 12); });');
  await ev('var n = __t.rows("nodes","node"); var inp = n[0].children[0]; inp.value = "2"; inp.dispatchEvent(new Event("change")); return 1;');
  await wait(1000);
  const after = await ev('return __t.rows("nodes","node").map(function (r) { return r.children[1].value.slice(0, 12); });');
  check("节点序号改 2 后两行交换", before[0] !== after[0], before.join(" / ") + " -> " + after.join(" / "));
  const n0 = await ev('return __t.rows("nodes","node").length;');
  await ev('var n = __t.rows("nodes","node"); n[1].children[5].click(); return 1;');
  await wait(900);
  check("点 × 删除一行", (await ev('return __t.rows("nodes","node").length;')) === n0 - 1, n0 + " -> " + await ev('return __t.rows("nodes","node").length;'));
  await ev('__t.q("discard").click(); return 1;');
  check("撤销修改回到 2 条", await ev('return __t.until(function () { return __t.rows("nodes","node").length === 2; }, 6000);'));
} catch (e) { check("节点行编辑未抛错", false, e.message); }

// 6 排序 / 重命名
step("机器排序与重命名");
try {
  const order0 = await ev('return __t.rows("machine-list","machine").map(function (r) { return r.children[1].textContent.slice(0, 8); });');
  await ev('var r = __t.rows("machine-list","machine"); r[1].children[3].click(); return 1;');
  await wait(900);
  const order1 = await ev('return __t.rows("machine-list","machine").map(function (r) { return r.children[1].textContent.slice(0, 8); });');
  const optFirst = await ev('return document.getElementById("machine").options[0].value;');
  check("机器序号调整后顺序变化", JSON.stringify(order0) !== JSON.stringify(order1) || optFirst.indexOf("手动机器") === 0, order0.join(" / ") + " -> " + order1.join(" / ") + " | 下拉首项 " + optFirst);
  await ev('document.getElementById("save-machine-order").click(); return 1;');
  check("保存机器顺序有反馈", await ev('return __t.until(function () { return document.getElementById("order-status").textContent.length > 0; }, 6000);'), await ev('return document.getElementById("order-status").textContent;'));
  await ev('window.prompt = function () { return ' + JSON.stringify(MB2) + '; }; __t.q("rename").click(); return 1;');
  check("机器重命名生效", await ev('return __t.until(function () { return __t.rows("machine-list","machine").some(function (x) { return x.textContent.indexOf(' + JSON.stringify(MB2) + ') >= 0; }); }, 9000);'), await ev('return __t.rows("machine-list","machine").map(function (x) { return x.textContent.slice(0, 16); }).join(" | ");'));
  check("下拉框同步新名字", await ev('return [].slice.call(document.getElementById("machine").options).some(function (o) { return o.value === ' + JSON.stringify(MB2) + '; });'));
} catch (e) { check("机器排序/重命名未抛错", false, e.message); }

// 7 订阅勾选
step("订阅勾选");
try {
  await ev('document.getElementById("sub-toggle").click(); return 1;');
  await wait(1400);
  check("展开后列出 6 条节点", (await ev('return __t.rows("sub-list","subnode").length;')) === 6, String(await ev('return __t.rows("sub-list","subnode").length;')));
  const chips = await ev('return __t.rows("sub-protos","").map(function (c) { return c.textContent; });');
  const realChips = chips.filter(function (t) { return String(t).trim().length > 0; });
  check("协议胶囊按协议分组（含计数）", realChips.length >= 4 && realChips.every(function (t) { return t.indexOf("/") > 0; }), realChips.join(" | "));
  await ev('var c = __t.rows("sub-protos","").filter(function (x) { return x.textContent.indexOf("Hysteria2") >= 0; })[0]; c.click(); return 1;');
  await wait(800);
  check("按协议筛选只剩 hy2 两条", (await ev('return __t.rows("sub-list","subnode").length;')) === 2, String(await ev('return __t.rows("sub-list","subnode").length;')));
  await ev('document.getElementById("sub-only").click(); return 1;'); await wait(600);
  await ev('document.getElementById("sub-save").click(); return 1;'); await wait(2600);
  const st1 = await ev('var r = await __t.api("/api/v1/sub/nodes"); return r.d.stats.enabled;');
  check("只选筛出来的 + 保存后订阅剩 2 条", st1 === 2, String(st1));
  await ev('document.getElementById("sub-clear").click(); document.getElementById("sub-all").click(); return 1;'); await wait(800);
  await ev('document.getElementById("sub-save").click(); return 1;'); await wait(2600);
  const st2 = await ev('var r = await __t.api("/api/v1/sub/nodes"); return r.d.stats.enabled;');
  check("全选并保存后 6 条全进订阅", st2 === 6, String(st2));
  check("保存后未保存徽章消失", await ev('return document.getElementById("sub-dirty").style.display === "none";'));
  const sb = await ev('var r = await __t.sub(document.getElementById("url-base").textContent); return { s: r.status, n: atob(r.text.trim()).split("\\n").filter(Boolean).length };');
  check("主订阅 base64 = 6 条节点", sb.s === 200 && sb.n === 6, JSON.stringify(sb));
} catch (e) { check("订阅勾选未抛错", false, e.message); }

// 8 订阅链接
step("订阅链接");
try {
  const urls = await ev('return { base: document.getElementById("url-base").textContent, clash: document.getElementById("url-clash").textContent, prox: document.getElementById("url-proxies").textContent, sing: document.getElementById("url-singbox").textContent };');
  check("四条订阅链接都已生成", Object.keys(urls).every(function (k) { return urls[k].indexOf("http") === 0; }), urls.base);
  check("链接按格式带 query", urls.clash.indexOf("format=clash") > 0 && urls.sing.indexOf("format=singbox") > 0);
  const c = await ev('var r = await __t.sub(' + JSON.stringify(urls.clash) + '); var t = r.text; var nl = String.fromCharCode(10); return { s: r.status, proxies: (t.split(nl + "proxy-groups:")[0].split(nl + "  - name:").length - 1), rules: t.indexOf("rules:") >= 0, prov: t.indexOf("rule-providers:") >= 0, groups: (t.split("type: \\"select\\"").length - 1) };');
  check("clash 完整配置：6 节点 + 分组 + 规则 + rule-providers", c.s === 200 && c.proxies === 6 && c.rules && c.prov && c.groups > 5, JSON.stringify(c));
  const p = await ev('var r = await __t.sub(' + JSON.stringify(urls.prox) + '); var nl = String.fromCharCode(10); return { s: r.status, n: (r.text.split(nl + "  - name:").length - 1), head: r.text.slice(0, 12) };');
  check("clash 节点片段只输出 proxies", p.s === 200 && p.n === 6 && p.head.indexOf("proxies:") === 0, JSON.stringify(p));
  const s = await ev('var r = await __t.sub(' + JSON.stringify(urls.sing) + '); var j = JSON.parse(r.text); return { s: r.status, out: j.outbounds.length, tags: j.outbounds.map(function (o) { return o.tag; }) };');
  const uniq = s.tags && new Set(s.tags).size === s.tags.length;
  check("sing-box 合法 JSON，outbound 覆盖 6 条节点", s.s === 200 && s.out >= 6 && uniq, JSON.stringify(s));
  const cp = await ev('var btn = document.querySelector("[data-copy=\\"url-base\\"]"); btn.click(); await __t.sleep(300); return { text: btn.textContent, cls: btn.className };');
  check("复制按钮就地反馈「已复制」", cp.text.indexOf("已复制") >= 0 && cp.cls.indexOf("copied") >= 0, JSON.stringify(cp));
} catch (e) { check("订阅链接未抛错", false, e.message); }

// 9 订阅档案
step("订阅档案");
try {
  await ev('document.getElementById("preset-new").click(); return 1;'); await wait(800);
  check("新建面板打开并说明跟已有档案无关", await ev('return document.getElementById("preset-editor").className.indexOf("pe-new") >= 0 && document.getElementById("pe-mode-hint").textContent.indexOf("主订阅的全部节点") >= 0;'));
  await ev('__t.type("pe-label", "手机专用"); __t.type("pe-name", "phone"); return 1;'); await wait(900);
  await ev('var c = __t.rows("pe-proto-chips","").filter(function (x) { return x.textContent.indexOf("Hysteria2") >= 0; })[0]; c.click(); return 1;'); await wait(1000);
  await ev('document.getElementById("pe-all").click(); return 1;'); await wait(1000);
  check("筛 hy2 后全选 = 勾 2 条", (await ev('return document.getElementById("pe-shown").textContent;')).indexOf("已勾选 2 条") >= 0, await ev('return document.getElementById("pe-shown").textContent;'));
  await ev('document.getElementById("pe-save").click(); return 1;');
  check("保存档案成功", await ev('return __t.until(function () { return /已保存 phone/.test(document.getElementById("pe-status").textContent); }, 8000);'), await ev('return document.getElementById("pe-status").textContent;'));
  check("列表出现刚建的档案", await ev('return __t.until(function () { return __t.rows("presets","preset").length === 1 && __t.rows("presets","preset")[0].children[0].textContent.indexOf("手机专用") >= 0; }, 8000);'), String(await ev('return __t.rows("presets","preset").length;')));
  check("5 秒后面板自动收起", await ev('return __t.until(function () { return document.getElementById("preset-editor").className.indexOf("hidden") >= 0; }, 9000);'));
  // 编辑档案：改显示名 + 减一条节点
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("编辑", r).click(); return 1;');
  check("编辑面板打开", await ev('return __t.until(function () { return document.getElementById("pe-title").textContent.indexOf("编辑档案") >= 0; }, 8000);'), await ev('return document.getElementById("pe-title").textContent;'));
  check("正在编辑的按钮变「编辑中」", await ev('return __t.btn("编辑中", __t.rows("presets","preset")[0]) !== undefined;'));
  const preChecked = await ev('return __t.until(function () { return __t.rows("pe-list","pe-node").filter(function (x) { return x.children[0].checked; }).length === 2; }, 12000);');
  check("编辑面板列出并预勾 2 条", preChecked, String(await ev('return __t.rows("pe-list","pe-node").filter(function (x) { return x.children[0].checked; }).length;')));
  await ev('__t.type("pe-label", "手机专用-改名"); var box = __t.rows("pe-list","pe-node").filter(function (x) { return x.children[0].checked; })[0].children[0]; box.checked = false; box.onchange.call(box); document.getElementById("pe-save").click(); return 1;');
  check("改显示名并去掉一条后保存成功", await ev('return __t.until(function () { return document.getElementById("pe-status").textContent.indexOf("已保存") >= 0; }, 8000);'), await ev('return document.getElementById("pe-status").textContent;'));
  await wait(5600);
  check("档案只剩 1 条节点且显示名已改", await ev('var p = await __t.api("/api/v1/presets"); return p.d.presets[0].label === "手机专用-改名" && p.d.presets[0].members.length === 1;'), await ev('var p = await __t.api("/api/v1/presets"); return JSON.stringify({ l: p.d.presets[0].label, n: p.d.presets[0].members.length });'));

  const purl = await ev('var p = await __t.api("/api/v1/presets"); return p.d.presets[0].url;');
  const pb = await ev('var r = await __t.sub(' + JSON.stringify(purl) + '); var names = []; try { var u8 = new Uint8Array(atob(r.text.trim()).split("").map(function (c) { return c.charCodeAt(0); })); names = new TextDecoder().decode(u8).split(String.fromCharCode(10)).filter(Boolean).map(function (l) { return decodeURIComponent(l.split("#")[1] || ""); }); } catch (e) {} return { s: r.status, names: names };');
  check("删掉一条后档案链接只剩 1 条 hy2", pb.s === 200 && pb.names.length === 1 && pb.names[0].indexOf("hy2") >= 0, JSON.stringify(pb));
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("短链", r).click(); return 1;');
  await wait(2200);
  const sh = await ev('var r = __t.rows("presets","preset")[0]; var b = __t.btn("短链", r); return { url: r.children[1].textContent, disp: b ? b.style.display : "gone" };');
  check("生成短链后显示 /s/、短链按钮收起", sh.url.indexOf("/s/") > 0 && sh.disp === "none", JSON.stringify(sh));
  const shb = await ev('var r = await __t.sub(' + JSON.stringify(sh.url) + '); return { s: r.status, len: r.text.length };');
  check("短链不带 token 也能拉到内容", shb.s === 200 && shb.len > 20, JSON.stringify(shb));
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("换长链", r).click(); return 1;'); await wait(700);
  check("换长链后显示 /sub/p/", (await ev('return __t.rows("presets","preset")[0].children[1].textContent;')).indexOf("/sub/p/phone/") >= 0, await ev('return __t.rows("presets","preset")[0].children[1].textContent;'));
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("换短链", r).click(); return 1;'); await wait(700);
  check("换回短链", (await ev('return __t.rows("presets","preset")[0].children[1].textContent;')).indexOf("/s/") > 0);
  await ev('document.getElementById("preset-new").click(); __t.type("pe-name", "phone"); __t.type("pe-label", "撞名"); document.getElementById("pe-all").click(); document.getElementById("pe-save").click(); return 1;');
  await wait(1500);
  check("新建撞已有标识被拦下", (await ev('return document.getElementById("pe-status").textContent;')).indexOf("已经被别的档案用了") >= 0, await ev('return document.getElementById("pe-status").textContent;'));
  check("撞名后档案数不变", (await ev('return __t.rows("presets","preset").length;')) === 1);
  await ev('document.getElementById("pe-cancel").click(); return 1;'); await wait(600);
  const oldUrl = await ev('return __t.rows("presets","preset")[0].children[1].textContent;');
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("发独立 token", r).click(); return 1;');
  await wait(2200);
  const tok = await ev('var p = await __t.api("/api/v1/presets"); return { has: !!p.d.presets[0].token, old: ' + JSON.stringify(oldUrl) + ' };');
  check("换独立 token 后档案有自己的 token", tok.has, JSON.stringify(tok));
  await ev('__t.type("preset-search", "phone"); return 1;'); await wait(600);
  check("按标识搜索能命中", (await ev('return __t.rows("presets","preset").length;')) === 1);
  await ev('__t.type("preset-search", "zzz"); return 1;'); await wait(600);
  check("搜不到显示空态", await ev('return document.getElementById("presets").children[0].className === "empty";'));
  await ev('__t.type("preset-search", ""); return 1;'); await wait(500);
} catch (e) { check("订阅档案未抛错", false, e.message); }

// 10 分流规则
step("分流规则");
try {
  await ev('document.getElementById("clash-toggle").click(); return 1;'); await wait(1200);
  const g = await ev('return { g: __t.rows("clash-groups","clash-row").length, r: __t.rows("clash-rulesets","clash-row").length, gc: document.getElementById("clash-group-count").textContent, rc: document.getElementById("clash-rule-count").textContent };');
  check("默认分组与规则来源都渲染", g.g >= 20 && g.r >= 10, JSON.stringify(g));
  await ev('document.getElementById("clash-reset").click(); return 1;'); await wait(1800);
  check("恢复默认设置可用", await ev('return __t.until(function () { return document.getElementById("clash-badge").textContent.indexOf("默认") >= 0; }, 8000);'), await ev('return document.getElementById("clash-badge").textContent;'));
  // 新增一个分组并保存，验证订阅输出
  const added = await ev('document.getElementById("clash-add-group").click(); await __t.sleep(400); var rows = __t.rows("clash-groups","clash-row"); var row = rows[rows.length - 1]; var nameInput = row.children[0]; nameInput.value = "🧪 测试分组"; if (nameInput.oninput) nameInput.oninput.call(nameInput); var f = row.children[2]; f.value = "hy2"; if (f.oninput) f.oninput.call(f); return rows.length;');
  await ev('document.getElementById("clash-save").click(); return 1;'); await wait(2200);
  check("新增分组保存成功", await ev('return __t.until(function () { return document.getElementById("clash-badge").textContent.indexOf("自定义") >= 0; }, 8000);'), await ev('return document.getElementById("clash-status").textContent + " | " + document.getElementById("clash-badge").textContent;'));
  const cg = await ev('var r = await __t.sub(document.getElementById("url-clash").textContent); return { s: r.status, has: r.text.indexOf("🧪 测试分组") >= 0 };');
  check("订阅输出里出现新分组", cg.has, JSON.stringify(cg));
  await ev('document.getElementById("clash-reset").click(); return 1;'); await wait(2000);
  check("再恢复默认后自定义消失", await ev('return __t.until(function () { return document.getElementById("clash-badge").textContent.indexOf("默认") >= 0; }, 8000);'));
} catch (e) { check("分流规则未抛错", false, e.message); }

// 11 删除与清理
step("删除与清理");
try {
  await ev('var r = __t.rows("presets","preset")[0]; __t.btn("删除", r).click(); return 1;');
  check("删除档案后列表为空", await ev('return __t.until(function () { return __t.rows("presets","preset").length === 0; }, 8000);'), String(await ev('return __t.rows("presets","preset").length;')));
  await ev('window.confirm = function () { return true; }; var rows = __t.rows("machine-list","machine"); var r = rows.filter(function (x) { return x.textContent.indexOf(' + JSON.stringify(MB2) + ') >= 0; })[0] || rows[0]; var d = [].slice.call(r.children).filter(function (c) { return c.className === "danger"; })[0]; d.click(); return 1;');
  check("删掉手动机器后只剩一台", await ev('return __t.until(function () { return __t.rows("machine-list","machine").length === 1; }, 9000);'), await ev('return __t.rows("machine-list","machine").map(function (x) { return x.textContent.slice(0, 14); }).join(" | ");'));
  const left = await ev('var r = await __t.api("/api/v1/machines"); return r.d.machines.length;');
  check("服务端机器数同步为 1", left === 1, String(left));
  await shot("/tmp/e2e/shot-final.png");
} catch (e) { check("删除流程未抛错", false, e.message); }

// 12 其它入口
step("其它入口");
try {
  await send("Page.navigate", { url: B + "/no-such-path" }); await wait(1600);
  const t = await ev('return document.body.innerText;');
  check("未知路径回极简 404", t.indexOf("404") >= 0 && t.length < 80, JSON.stringify(t.slice(0, 60)));
  const h = await ev('var r = await fetch("/health"); return await r.json();');
  check("/health 返回版本号", !!h.version, JSON.stringify(h));
  const a = await ev('var r = await fetch("/api"); var t = await r.text(); return { s: r.status, has: t.indexOf("endpoints") >= 0 };');
  check("/api 返回接口索引", a.s === 200 && a.has, JSON.stringify(a));
} catch (e) { check("其它入口未抛错", false, e.message); }

fs.writeFileSync("/tmp/e2e/results.json", JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log("== total", results.length, "pass", results.length - bad.length, "fail", bad.length);
for (const b of bad) console.log("FAIL:", b.step, "|", b.name, "|", b.detail);
ws.close(); chrome.kill();
