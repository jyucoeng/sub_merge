import fs from "node:fs";

const source = fs.readFileSync("src/index.js", "utf8");
const banner = `// sub_merge single-file build
// 直接粘贴到 Cloudflare Dashboard -> Workers & Pages -> 你的 Worker -> Edit code。
// 变量模式：在 Settings -> Variables and Secrets 设置一个 TOKEN（Secret）。
// 对外域名由请求 Origin 自动决定，无需配置。
// 存储：Cloudflare D1。绑定变量名必须是 DB（D1 database binding）。
// 建表：部署后调用一次 POST /api/v1/admin/schema（Bearer TOKEN），或在 Dashboard 的 D1 控制台执行 scripts/schema.sql。

`;
fs.writeFileSync("worker.single.js", banner + source);
console.log("worker.single.js generated");
