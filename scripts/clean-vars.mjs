// 把 Cloudflare 上多余的运行时变量/密钥删掉，只留代码真正用到的三个。
// 用法：pnpm run vars:clean            （只看，不改）
//       pnpm run vars:clean -- --write  （真删）
// 依赖已登录的 wrangler OAuth Token（~/.wrangler 或 ~/Library/Preferences/.wrangler）。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEEP = ["ADMIN_PASSWORD", "TOKEN", "DB"];
const write = process.argv.includes("--write");
const toml = readFileSync("wrangler.toml", "utf8");
const name = toml.match(/^name\s*=\s*"([^"]+)"/m)[1];
const dbId = toml.match(/^database_id\s*=\s*"([^"]+)"/m)[1];
const adminPassword = process.env.ADMIN_PASSWORD || process.env.SUB_ADMIN_PASSWORD || "";
const token = process.env.TOKEN || process.env.SUB_TOKEN || "";

function oauthToken() {
  const candidates = [
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    join(homedir(), ".wrangler/config/default.toml"),
    join(homedir(), ".config/.wrangler/config/default.toml"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const m = readFileSync(file, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  throw new Error("找不到 wrangler 的 OAuth token，先跑一次 `pnpm exec wrangler whoami`");
}

const auth = oauthToken();
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${auth}`, ...(init.headers || {}) },
  });
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors));
  return data.result;
};

const accountId = (await api("/accounts"))[0].id;
const base = `/accounts/${accountId}/workers/scripts/${name}`;
const { bindings = [] } = await api(`${base}/settings`);

console.log(`${name} 现有绑定：`);
for (const b of bindings) console.log(`  ${b.type.padEnd(12)} ${b.name}`);
const extra = bindings.filter((b) => !KEEP.includes(b.name));
console.log(extra.length ? `\n多余（会被删掉）：${extra.map((b) => b.name).join("、")}` : "\n没有多余绑定。");
if (!extra.length) process.exit(0);
if (!write) {
  console.log("\n只是预览。真删：pnpm run vars:clean -- --write");
  process.exit(0);
}

const next = bindings.filter((b) => KEEP.includes(b.name)).map((b) => {
  if (b.type === "d1") return { name: b.name, id: b.id || dbId, type: "d1" };
  if (b.type === "plain_text") return { name: b.name, text: b.text, type: "plain_text" };
  if (b.type === "secret_text") return { name: b.name, type: "secret_text" };
  return b;
});
for (const b of next) if (b.type === "plain_text" && !b.text) {
  if (b.name === "ADMIN_PASSWORD") b.text = adminPassword;
  if (b.name === "TOKEN") b.text = token;
}
if (next.some((b) => b.type === "plain_text" && !b.text)) {
  throw new Error("保留的变量少了值，先设置 ADMIN_PASSWORD / TOKEN 环境变量再执行");
}

const form = new FormData();
form.set("settings", new Blob([JSON.stringify({ bindings: next })], { type: "application/json" }));
await api(`${base}/settings`, { method: "PATCH", body: form });
console.log("\n已删除：" + extra.map((b) => b.name).join("、"));
